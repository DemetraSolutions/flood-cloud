import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { Document } from 'mongodb';
import { TEST_PASSWORD, addUser, startBackoffice } from '../helpers/backoffice.ts';
import type { Backoffice } from '../helpers/backoffice.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { actors } from '../helpers/users.ts';

let ctx: TestDatabases;
let office: Backoffice;
let as: ReturnType<typeof actors>;

const users = () => ctx.databases.common().collection('users');
const g0 = () => office.cluster.groups[0]!;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(16)]);
const dataUrl = `data:image/png;base64,${PNG.toString('base64')}`;
const invalid = (...details: Array<[string, string]>) => ({ status: 422, code: 'VALIDATION_ERROR', details: details.map(([field, issue]) => ({ field, issue })) });

before(async () => {
  ctx = await openTestDatabases();
  office = await startBackoffice(ctx);
  as = actors(office);
  await ctx.databases.common().collection('groups').updateOne({ _id: g0().groupId }, { $set: { productsFavorites: [{ id: 'fav-1', name: 'Bar', favorites: [] }] } });
});
after(async () => {
  await office.close();
  await ctx.cleanup();
});

describe('PATCH /v1/me: the picture and the POS preferences', () => {
  it('lets the user change his picture and his preferences, nothing of the permissions', async () => {
    const mark = office.activity.entries.length;
    const reply = await as.call(g0().pa, 'PATCH', '/me', { avatar: dataUrl, pos: { options: { darkMode: true, side: 'sx', favoritesId: 'fav-1', quickDiscount: 10 } } });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.deepEqual([reply.body.data.avatar, reply.body.data.hasAvatar, reply.body.data.pos.options.darkMode, reply.body.data.pos.options.favoritesId], [dataUrl, true, true, 'fav-1']);
    const document = (await users().findOne({ _id: g0().pa }))!;
    const cash = ((document['permissions'] as Document)['apps'] as Document)['cash'] as { options: Document; sub: Document };
    assert.deepEqual([document['avatar'], cash.options['darkMode'], cash.options['side'], cash.options['favoritesId'], cash.options['quickDiscount']], [dataUrl, true, 'sx', 'fav-1', 10]);
    const logged = JSON.stringify(office.activity.entries.slice(mark));
    assert.ok(!logged.includes(dataUrl) && logged.includes('avatarHash'));
    assert.equal((await as.call(g0().pa, 'PATCH', '/me', { avatar: null })).body.data.hasAvatar, false);
    assert.equal((await users().findOne({ _id: g0().pa }))!['avatar'], null);
    assert.equal((await as.call(g0().pa, 'PATCH', '/me', { pos: { options: { favoritesId: null } } })).status, 200);
  });

  it('refuses what is not his to change, a bad picture and lists that are not the group\'s', async () => {
    const failure = async (body: Document) => as.failure(await as.call(g0().pa, 'PATCH', '/me', body));
    assert.deepEqual(await failure({ pos: { enabled: true } }), invalid(['pos.enabled', 'unknown']));
    assert.deepEqual(await failure({ pos: { grants: { discount: true } } }), invalid(['pos.grants', 'unknown']));
    assert.deepEqual(await failure({ pos: { options: { priceLists: [] } } }), invalid(['pos.options.priceLists', 'unknown']));
    assert.deepEqual(await failure({ pos: { options: { defaultPriceListId: 'x' } } }), invalid(['pos.options.defaultPriceListId', 'unknown']));
    assert.deepEqual(await failure({ avatar: 'data:image/svg+xml;base64,PHN2Zy8+' }), invalid(['avatar', 'format']));
    assert.deepEqual(await failure({ pos: { options: { favoritesId: 'nope' } } }), invalid(['pos.options.favoritesId', 'incorrect']));
    assert.deepEqual(await failure({ pin: '1234' }), invalid(['pin', 'unknown']));
    const big = await fetch(`${office.app.baseUrl}/v1/me`, { method: 'PATCH', headers: { authorization: `Bearer ${await as.tokenOf(g0().pa)}`, 'content-type': 'application/json' }, body: JSON.stringify({ firstName: 'x'.repeat(600_000) }) });
    assert.equal(big.status, 413);
  });

  it('leaves a user without a group with no lists to refer to', async () => {
    assert.equal((await as.call(office.cluster.psa, 'PATCH', '/me', { pos: { options: { darkMode: true } } })).status, 200);
    assert.deepEqual(as.failure(await as.call(office.cluster.psa, 'PATCH', '/me', { pos: { options: { favoritesId: 'fav-1' } } })), invalid(['pos.options.favoritesId', 'incorrect']));
  });
});

describe('PUT /v1/me/pin', () => {
  const put = (actor: Parameters<typeof as.call>[0], body: Document) => as.call(actor, 'PUT', '/me/pin', body);

  it('sets, changes and removes the PIN with the current password, without ending any session or showing the PIN', async () => {
    const { id } = await addUser(ctx, office, { pin: null });
    const token = await as.tokenOf(id);
    const mark = office.activity.entries.length;
    assert.equal((await put(id, { currentPassword: TEST_PASSWORD, pin: '2468' })).status, 204);
    assert.equal((await users().findOne({ _id: id }))!['pin'], '2468');
    const me = await as.call(id, 'GET', '/me');
    assert.deepEqual([me.body.data.pinSet, JSON.stringify(me.body).includes('2468')], [true, false]);
    const entries = office.activity.entries.slice(mark);
    assert.ok(!JSON.stringify(entries).includes('2468'));
    assert.deepEqual(entries.map((entry) => entry.action), ['user.updated']);
    assert.deepEqual(entries[0]!.changes!.map((change) => [change.field, change.before, change.after]), [['pinSet', false, true], ['pinChange', undefined, 'set']]);
    assert.equal((await office.call('GET', '/me', token)).status, 200, 'the session goes on');
    assert.equal((await put(id, { currentPassword: TEST_PASSWORD, pin: null })).status, 204);
    assert.equal((await users().findOne({ _id: id }))!['pin'], null);
    assert.equal(office.activity.entries.at(-1)!.changes!.find((change) => change.field === 'pinChange')?.after, 'removed');
  });

  it('refuses a wrong password and says so in the log, and a PIN that is not 3 to 6 digits', async () => {
    const { id } = await addUser(ctx, office);
    await as.tokenOf(id);
    const mark = office.activity.entries.length;
    assert.deepEqual(as.failure(await put(id, { currentPassword: 'not the password at all', pin: '2468' })), invalid(['currentPassword', 'incorrect']));
    assert.deepEqual(office.activity.entries.slice(mark).map((entry) => [entry.action, entry.outcome]), [['auth.passwordCheckFailed', 'failure']]);
    assert.equal((await users().findOne({ _id: id }))!['pin'], '1234', 'unchanged');
    for (const pin of ['12', '1234567', 'abc', 12, undefined]) {
      assert.equal((await put(id, { currentPassword: TEST_PASSWORD, ...(pin === undefined ? {} : { pin }) })).status, 422, String(pin));
    }
    assert.deepEqual(as.failure(await put(id, { currentPassword: TEST_PASSWORD, pin: '1234', extra: 1 })), invalid(['extra', 'unknown']));
  });
});
