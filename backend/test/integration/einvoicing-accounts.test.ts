import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { startBackoffice } from '../helpers/backoffice.ts';
import type { Backoffice } from '../helpers/backoffice.ts';
import { startKeysWorld } from '../helpers/api-keys.ts';
import type { KeysWorld } from '../helpers/api-keys.ts';
import { fixtureId } from '../helpers/legacy-fixtures.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { testConfig } from '../helpers/app.ts';
import { actors } from '../helpers/users.ts';
import { minimalCompany, toNewDocument } from '../../src/modules/dealers/dealer.mapper.ts';
import { createEInvoicingAccountsRoutes } from '../../src/modules/einvoicing-accounts/einvoicing-accounts.routes.ts';
import { createRateLimitRules } from '../../src/shared/security/rate-limit/rules.ts';
import type { StoredCredential } from '../../src/shared/security/credential-cipher.ts';

/** The key pair of the worker, made for this run: the backend gets the public half only. */
const RECIPIENT = generateKeyPairSync('x25519');
const PUBLIC_PEM = RECIPIENT.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const PASSWORD = `Pw-${randomBytes(6).toString('hex')}-ù`;

let ctx: TestDatabases;
let world: KeysWorld;
let office: Backoffice;
let as: KeysWorld['as'];
const call = (...args: Parameters<typeof as.call>) => as.call(...args);
const failure = (reply: Awaited<ReturnType<typeof call>>) => as.failure(reply);
const common = () => ctx.databases.common();
const psa = () => office.cluster.psa;
const dealerA = () => office.cluster.dealerA;
const dealerB = () => office.cluster.dealerB;
const urlOf = (dealer: ObjectId) => `/dealers/${dealer.toHexString()}/integrations/aruba`;
const PLATFORM = '/settings/integrations/aruba';
const strongTag = /^"[A-Za-z0-9_-]{43}"$/;
const account = (overrides: Record<string, unknown> = {}) => ({ enabled: true, username: 'aruba.user', password: PASSWORD, maxPerHour: 55, maxPerYear: 10_000, ...overrides });
const without = (body: Record<string, unknown>, key: string) => Object.fromEntries(Object.entries(body).filter(([name]) => name !== key));
const etagOf = (reply: Awaited<ReturnType<typeof call>>) => reply.headers.get('etag')!;
const put = async (actor: ObjectId, url: string, body: unknown, etag?: string) => call(actor, 'PUT', url, body, { 'if-match': etag ?? etagOf(await call(actor, 'GET', url)) });
const storedOf = async (dealer: ObjectId) => (await common().collection('dealers').findOne({ _id: dealer }))!['integrations']?.aruba;
const platformStored = async () => (await common().collection('settings').findOne({ key: 'INTEGRATIONS' }))?.['value']?.aruba;

function decrypt(stored: StoredCredential, context: string, privateKey: KeyObject = RECIPIENT.privateKey): string {
  const ephemeral = createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: stored.epk }, format: 'jwk' });
  const shared = diffieHellman({ privateKey, publicKey: ephemeral });
  const recipientRaw = Buffer.from(createPublicKey(privateKey).export({ format: 'jwk' }).x!, 'base64url');
  const key = Buffer.from(hkdfSync('sha256', shared, Buffer.concat([Buffer.from(stored.epk, 'base64url'), recipientRaw]), `flood-cloud:credential:v2:${context}`, 32));
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(stored.iv, 'base64url'), { authTagLength: 16 });
  decipher.setAAD(Buffer.from(context, 'utf8'));
  decipher.setAuthTag(Buffer.from(stored.tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(stored.data, 'base64url')), decipher.final()]).toString('utf8');
}

before(async () => {
  ctx = await openTestDatabases();
  world = await startKeysWorld(ctx, { env: { CREDENTIALS_PUBLIC_KEY: PUBLIC_PEM, CREDENTIALS_PUBLIC_KEY_ID: 'k-test' } });
  office = world.office;
  as = world.as;
});
after(async () => {
  await office.close();
  await ctx.cleanup();
});
beforeEach(async () => {
  await common().collection('settings').deleteMany({});
  await common().collection('dealers').deleteMany({});
  await common().collection('dealers').insertMany([
    toNewDocument(dealerA(), minimalCompany('Rivenditore Alfa'), 'manual', null, new Date()),
    toNewDocument(dealerB(), minimalCompany('Beta Distribuzione'), 'manual', null, new Date()),
  ]);
  office.activity.entries.length = 0;
});

describe('the Aruba account of a dealer', () => {
  it('is not configured at first, with a version', async () => {
    const read = await call(psa(), 'GET', urlOf(dealerA()));
    assert.deepEqual([read.status, read.body], [200, { data: { hub: `aruba__${dealerA().toHexString()}`, configured: false } }]);
    assert.match(etagOf(read), strongTag);
  });

  it('is created with the password encrypted for that dealer and shown without it', async () => {
    const created = await put(psa(), urlOf(dealerA()), account());
    assert.equal(created.status, 200);
    assert.deepEqual(created.body.data, { hub: `aruba__${dealerA().toHexString()}`, configured: true, enabled: true, username: 'aruba.user', passwordSet: true, maxPerHour: 55, maxPerYear: 10_000, updatedAt: created.body.data.updatedAt });
    assert.ok(!Number.isNaN(Date.parse(created.body.data.updatedAt)));
    assert.match(etagOf(created), strongTag);
    assert.notEqual(etagOf(created), etagOf(await call(psa(), 'GET', urlOf(dealerB()))));
    const stored = await storedOf(dealerA());
    assert.deepEqual([stored.password.v, stored.password.kid, stored.updatedBy], [2, 'k-test', psa()]);
    assert.equal(decrypt(stored.password, `einvoicing:aruba:dealer:${dealerA().toHexString()}:password`), PASSWORD);
    // Bound to the dealer: it does not open under another dealer's context nor the platform's.
    assert.throws(() => decrypt(stored.password, `einvoicing:aruba:dealer:${dealerB().toHexString()}:password`));
    assert.throws(() => decrypt(stored.password, 'einvoicing:aruba:platform:password'));
    // The company data of the dealer is untouched, and nothing leaks to a reader.
    assert.equal((await common().collection('dealers').findOne({ _id: dealerA() }))!['businessName'], 'Rivenditore Alfa');
    const again = await call(psa(), 'GET', urlOf(dealerA()));
    assert.deepEqual(again.body, created.body);
    assert.equal(etagOf(again), etagOf(created));
    for (const text of [JSON.stringify(created.body), JSON.stringify(again.body), JSON.stringify(office.activity.entries), JSON.stringify(office.logEvents)]) {
      assert.ok(!text.includes(PASSWORD) && !text.includes(stored.password.data) && !text.includes(stored.password.tag) && !text.includes(stored.password.epk));
    }
  });

  it('keeps the other integrations of the dealer and a stored password when none is sent', async () => {
    await common().collection('dealers').updateOne({ _id: dealerA() }, { $set: { 'integrations.other': { status: true } } });
    const created = await put(psa(), urlOf(dealerA()), account());
    const before = await storedOf(dealerA());
    const changed = await put(psa(), urlOf(dealerA()), without(account({ username: 'renamed', enabled: false, maxPerHour: 10, maxPerYear: null }), 'password'), etagOf(created));
    assert.deepEqual(changed.body.data, { hub: `aruba__${dealerA().toHexString()}`, configured: true, enabled: false, username: 'renamed', passwordSet: true, maxPerHour: 10, maxPerYear: null, updatedAt: changed.body.data.updatedAt });
    const after = await storedOf(dealerA());
    assert.deepEqual(after.password, before.password);
    assert.notEqual(etagOf(changed), etagOf(created));
    assert.deepEqual((await common().collection('dealers').findOne({ _id: dealerA() }))!['integrations'].other, { status: true });
    assert.deepEqual(office.activity.entries.map((entry) => [entry.action, entry.metadata]), [
      ['dealer.eInvoicingAccountSaved', { fields: 'enabled,username,maxPerHour,maxPerYear', passwordChanged: true }],
      ['dealer.eInvoicingAccountSaved', { fields: 'enabled,username,maxPerHour,maxPerYear', passwordChanged: false }],
    ]);
    assert.deepEqual(office.activity.entries.map((entry) => [entry.category, entry.outcome, entry.resource]), Array(2).fill(['data', 'success', { type: 'dealer', id: dealerA().toHexString() }]));
  });

  it('re-encrypts with a new IV when the password changes and changes the version, and writes nothing for an identical save', async () => {
    const created = await put(psa(), urlOf(dealerA()), account());
    const first = await storedOf(dealerA());
    assert.equal((await put(psa(), urlOf(dealerA()), without(account(), 'password'), etagOf(created))).headers.get('etag'), etagOf(created));
    assert.equal(office.activity.entries.length, 1);
    const changed = await put(psa(), urlOf(dealerA()), account({ password: 'another-password' }), etagOf(created));
    const second = await storedOf(dealerA());
    assert.notEqual(second.password.iv, first.password.iv);
    assert.notEqual(second.password.epk, first.password.epk);
    assert.equal(decrypt(second.password, `einvoicing:aruba:dealer:${dealerA().toHexString()}:password`), 'another-password');
    assert.notEqual(etagOf(changed), etagOf(created));
    assert.deepEqual(office.activity.entries.at(-1)!.metadata, { fields: '', passwordChanged: true });
  });

  it('requires the password while the account does not exist, and the version of the last read', async () => {
    const url = urlOf(dealerA());
    const etag = etagOf(await call(psa(), 'GET', url));
    assert.deepEqual(failure(await put(psa(), url, without(account(), 'password'), etag)), { status: 422, code: 'VALIDATION_ERROR', details: [{ field: 'password', issue: 'required' }] });
    assert.equal(await storedOf(dealerA()), undefined);
    assert.equal((await call(psa(), 'PUT', url, account())).status, 422);
    assert.equal((await call(psa(), 'PUT', url, account(), { 'if-match': 'W/"x"' })).status, 422);
    assert.equal(failure(await call(psa(), 'PUT', url, account(), { 'if-match': `"${'A'.repeat(43)}"` })).status, 412);
    await put(psa(), url, account(), etag);
    assert.equal(failure(await put(psa(), url, account({ maxPerHour: 1 }), etag)).status, 412);
  });

  it('lets one of two saves at once win', async () => {
    const url = urlOf(dealerA());
    const etag = etagOf(await call(psa(), 'GET', url));
    const replies = await Promise.all([put(psa(), url, account(), etag), put(psa(), url, account({ username: 'second' }), etag)]);
    assert.deepEqual(replies.map((reply) => reply.status).sort(), [200, 412]);
  });

  it('refuses a body that is not the allowlist, with the fields', async () => {
    const url = urlOf(dealerA());
    const etag = etagOf(await call(psa(), 'GET', url));
    const fields = async (body: unknown) => (failure(await call(psa(), 'PUT', url, body, { 'if-match': etag })).details as Array<{ field: string; issue: string }>).map((detail) => `${detail.field}:${detail.issue}`);
    assert.deepEqual(await fields({ ...account(), extra: 1 }), ['extra:unknown']);
    assert.deepEqual(await fields({ ...account(), $where: 'x' }), ['(key):forbiddenKey']);
    assert.deepEqual(await fields(without(account(), 'enabled')), ['enabled:required']);
    assert.deepEqual(await fields(without(account(), 'maxPerYear')), ['maxPerYear:required']);
    assert.deepEqual(await fields(account({ enabled: 'yes' })), ['enabled:type']);
    for (const username of ['', 'has space', 'tab\t', 'caffè', 'x'.repeat(101)]) {
      assert.equal((await fields(account({ username }))).length, 1, username);
    }
    for (const password of ['', 'a\nb', 'nul\u0000', 'del\u007f', 'x'.repeat(257), 12]) {
      assert.equal((await fields(account({ password }))).length, 1, String(password));
    }
    for (const maxPerHour of [0, 1001, 1.5, '55']) {
      assert.deepEqual(await fields(account({ maxPerHour })).then((list) => list.map((item) => item.split(':')[0])), ['maxPerHour'], String(maxPerHour));
    }
    for (const maxPerYear of [0, 100_000_001, 2.5, '1']) {
      assert.deepEqual(await fields(account({ maxPerYear })).then((list) => list.map((item) => item.split(':')[0])), ['maxPerYear'], String(maxPerYear));
    }
    assert.equal((await call(psa(), 'PUT', url, undefined, { 'if-match': etag })).status, 422);
    assert.equal(await storedOf(dealerA()), undefined);
    assert.equal((await put(psa(), url, account({ username: 'x'.repeat(100), password: 'p'.repeat(256), maxPerHour: 1000, maxPerYear: 100_000_000 }), etag)).status, 200);
  });

  it('refuses an Aruba user name that another account already has, and lets an account keep its own', async () => {
    const created = await put(psa(), urlOf(dealerA()), account());
    assert.deepEqual(failure(await put(psa(), urlOf(dealerB()), account())), { status: 409, code: 'CONFLICT', details: [{ field: 'username', issue: 'taken' }] });
    assert.equal(await storedOf(dealerB()), undefined);
    // The comparison ignores the case: another account cannot take `Aruba.User`, and the name is stored as typed.
    assert.deepEqual(failure(await put(psa(), urlOf(dealerB()), account({ username: 'Aruba.User' }))), { status: 409, code: 'CONFLICT', details: [{ field: 'username', issue: 'taken' }] });
    assert.deepEqual(failure(await put(psa(), urlOf(dealerB()), account({ username: 'ARUBA.USER' }))).status, 409);
    assert.equal((await put(psa(), urlOf(dealerB()), account({ username: 'Beta.User' }))).status, 200);
    assert.equal((await storedOf(dealerB())).username, 'Beta.User');
    assert.equal(failure(await put(psa(), urlOf(dealerB()), account({ username: 'aruba.USER' }))).status, 409);
    assert.equal((await put(psa(), urlOf(dealerB()), account({ username: 'beta.user' }))).status, 200);
    assert.equal((await storedOf(dealerB())).username, 'beta.user');
    assert.equal((await put(psa(), urlOf(dealerA()), account({ maxPerHour: 20 }), etagOf(created))).status, 200);
    // The platform's account and the dealers' share the same namespace, whichever is saved first.
    assert.equal(failure(await put(psa(), PLATFORM, account())).status, 409);
    assert.equal((await put(psa(), PLATFORM, account({ username: 'platform.user' }))).status, 200);
    assert.equal(failure(await put(psa(), urlOf(dealerB()), account({ username: 'platform.user' }))).status, 409);
    assert.equal(failure(await put(psa(), PLATFORM, account({ username: 'Aruba.User' }))).status, 409);
    assert.equal(failure(await put(psa(), urlOf(dealerB()), account({ username: 'PLATFORM.User' }))).status, 409);
    assert.equal((await put(psa(), PLATFORM, account({ username: 'Platform.User', enabled: false }))).status, 200);
  });

  it('is removed with the version, once', async () => {
    const url = urlOf(dealerA());
    assert.equal(failure(await call(psa(), 'DELETE', url, undefined, { 'if-match': etagOf(await call(psa(), 'GET', url)) })).status, 404);
    await common().collection('dealers').updateOne({ _id: dealerA() }, { $set: { 'integrations.other': { status: true } } });
    const created = await put(psa(), url, account());
    assert.equal(failure(await call(psa(), 'DELETE', url, undefined, { 'if-match': `"${'A'.repeat(43)}"` })).status, 412);
    assert.equal((await call(psa(), 'DELETE', url)).status, 422);
    const removed = await call(psa(), 'DELETE', url, undefined, { 'if-match': etagOf(created) });
    assert.deepEqual([removed.status, removed.body], [204, undefined]);
    assert.equal(await storedOf(dealerA()), undefined);
    assert.deepEqual((await common().collection('dealers').findOne({ _id: dealerA() }))!['integrations'], { other: { status: true } });
    assert.deepEqual((await call(psa(), 'GET', url)).body.data.configured, false);
    assert.equal(failure(await call(psa(), 'DELETE', url, undefined, { 'if-match': etagOf(created) })).status, 404);
    assert.deepEqual(office.activity.entries.map((entry) => [entry.action, entry.metadata]), [['dealer.eInvoicingAccountSaved', { fields: 'enabled,username,maxPerHour,maxPerYear', passwordChanged: true }], ['dealer.eInvoicingAccountRemoved', undefined]]);
  });

  it('does not exist for a dealer that does not exist, on any route', async () => {
    const missing = urlOf(fixtureId('user', 7777));
    assert.equal(failure(await call(psa(), 'GET', missing)).status, 404);
    assert.equal(failure(await call(psa(), 'PUT', missing, account(), { 'if-match': `"${'A'.repeat(43)}"` })).status, 404);
    assert.equal(failure(await call(psa(), 'DELETE', missing, undefined, { 'if-match': `"${'A'.repeat(43)}"` })).status, 404);
    assert.equal((await call(psa(), 'GET', '/dealers/zz/integrations/aruba')).status, 422);
  });
});

describe('the Aruba account of the platform', () => {
  it('is saved in the integrations setting, bound to the platform, and removed', async () => {
    const read = await call(psa(), 'GET', PLATFORM);
    assert.deepEqual(read.body.data, { hub: 'aruba', configured: false });
    assert.equal(failure(await call(psa(), 'DELETE', PLATFORM, undefined, { 'if-match': etagOf(read) })).status, 404);
    const created = await put(psa(), PLATFORM, account({ username: 'flood.platform' }), etagOf(read));
    assert.deepEqual(created.body.data, { hub: 'aruba', configured: true, enabled: true, username: 'flood.platform', passwordSet: true, maxPerHour: 55, maxPerYear: 10_000, updatedAt: created.body.data.updatedAt });
    const document = (await common().collection('settings').findOne({ key: 'INTEGRATIONS' }))!;
    assert.deepEqual([document['updatedBy'], document['value'].aruba.updatedBy, document['value'].aruba.password.kid], [psa(), psa(), 'k-test']);
    assert.equal(decrypt(document['value'].aruba.password, 'einvoicing:aruba:platform:password'), PASSWORD);
    assert.throws(() => decrypt(document['value'].aruba.password, `einvoicing:aruba:dealer:${dealerA().toHexString()}:password`));
    // Another setting is never touched.
    await common().collection('settings').insertOne({ key: 'PRICE_LIST', value: { plans: {} } });
    const changed = await put(psa(), PLATFORM, without(account({ username: 'flood.platform', maxPerYear: null }), 'password'), etagOf(created));
    assert.equal(changed.body.data.maxPerYear, null);
    assert.deepEqual(await common().collection('settings').countDocuments({}), 2);
    assert.equal((await call(psa(), 'DELETE', PLATFORM, undefined, { 'if-match': etagOf(changed) })).status, 204);
    assert.equal(await platformStored(), undefined);
    assert.ok(await common().collection('settings').findOne({ key: 'INTEGRATIONS' }));
    // The document is still there, empty: a new account is saved into it.
    const again = await put(psa(), PLATFORM, account({ username: 'flood.platform' }));
    assert.equal(again.status, 200);
    assert.deepEqual(office.activity.entries.map((entry) => [entry.action, entry.resource]), [
      ['platform.eInvoicingAccountSaved', { type: 'integrations', id: 'INTEGRATIONS' }],
      ['platform.eInvoicingAccountSaved', { type: 'integrations', id: 'INTEGRATIONS' }],
      ['platform.eInvoicingAccountRemoved', { type: 'integrations', id: 'INTEGRATIONS' }],
      ['platform.eInvoicingAccountSaved', { type: 'integrations', id: 'INTEGRATIONS' }],
    ]);
    assert.ok(!JSON.stringify(office.activity.entries).includes(PASSWORD));
  });

  it('lets one of two first saves at once win and refuses a stale version', async () => {
    const etag = etagOf(await call(psa(), 'GET', PLATFORM));
    const replies = await Promise.all([put(psa(), PLATFORM, account({ username: 'one' }), etag), put(psa(), PLATFORM, account({ username: 'two' }), etag)]);
    assert.deepEqual(replies.map((reply) => reply.status).sort(), [200, 412]);
    assert.equal(failure(await put(psa(), PLATFORM, account({ username: 'three' }), etag)).status, 412);
    assert.equal(failure(await call(psa(), 'PUT', PLATFORM, account(), { 'if-match': 'x' })).status, 422);
  });

  it('removes a stored value that is damaged (shown as not configured) and still answers 404 when nothing is stored', async () => {
    await common().collection('settings').insertOne({ key: 'INTEGRATIONS', other: 1, value: { aruba: { enabled: 'yes' }, keep: true } });
    const read = await call(psa(), 'GET', PLATFORM);
    assert.equal(read.body.data.configured, false);
    assert.equal(failure(await call(psa(), 'DELETE', PLATFORM, undefined, { 'if-match': `"${'A'.repeat(43)}"` })).status, 412);
    assert.equal((await call(psa(), 'DELETE', PLATFORM, undefined, { 'if-match': etagOf(read) })).status, 204);
    assert.equal(await platformStored(), undefined);
    assert.equal((await common().collection('settings').findOne({ key: 'INTEGRATIONS' }))!['value'].keep, true);
    assert.equal(failure(await call(psa(), 'DELETE', PLATFORM, undefined, { 'if-match': etagOf(read) })).status, 404);
    await common().collection('dealers').updateOne({ _id: dealerA() }, { $set: { 'integrations.aruba': { password: 'plain' } } });
    const dealerRead = await call(psa(), 'GET', urlOf(dealerA()));
    assert.equal((await call(psa(), 'DELETE', urlOf(dealerA()), undefined, { 'if-match': etagOf(dealerRead) })).status, 204);
    assert.equal(await storedOf(dealerA()), undefined);
  });

  it('treats a stored value that is not an account as no account', async () => {
    await common().collection('settings').insertOne({ key: 'INTEGRATIONS', value: { aruba: { enabled: 'yes' } } });
    assert.equal((await call(psa(), 'GET', PLATFORM)).body.data.configured, false);
    assert.equal(failure(await put(psa(), PLATFORM, without(account(), 'password'))).status, 422);
    assert.equal((await put(psa(), PLATFORM, account())).status, 200);
  });
});

describe('who reaches the Aruba accounts', () => {
  it('is the PSA alone: every other role, on every route, is refused before anything is read or written', async () => {
    const group = office.cluster.groups[0]!;
    for (const actor of [dealerA(), group.sa, group.ca, group.pa]) {
      for (const url of [urlOf(dealerA()), PLATFORM]) {
        for (const method of ['GET', 'PUT', 'DELETE']) {
          const reply = await call(actor, method, url, method === 'PUT' ? account() : undefined, { 'if-match': `"${'A'.repeat(43)}"` });
          assert.deepEqual(failure(reply), { status: 403, code: 'FORBIDDEN', details: undefined }, `${method} ${url}`);
        }
      }
    }
    assert.equal(await storedOf(dealerA()), undefined);
    assert.equal(await platformStored(), undefined);
    assert.equal((await office.call('GET', PLATFORM, undefined)).status, 401);
    assert.equal(office.activity.entries.filter((entry) => entry.action.includes('eInvoicingAccount')).length, 0);
  });

  it('declares six user routes with the permission and no store opt-in, which the route builder refuses to a store key and to the public surface', () => {
    const stub = new Proxy({}, { get: () => ({ get: () => undefined, put: () => undefined, delete: () => undefined }) }) as never;
    const routes = createEInvoicingAccountsRoutes(stub, createRateLimitRules(testConfig()));
    assert.deepEqual(routes.map((route) => `${route.method} ${route.path}`).sort(), [
      'DELETE /dealers/:dealerId/integrations/aruba',
      'DELETE /settings/integrations/aruba',
      'GET /dealers/:dealerId/integrations/aruba',
      'GET /settings/integrations/aruba',
      'PUT /dealers/:dealerId/integrations/aruba',
      'PUT /settings/integrations/aruba',
    ]);
    for (const route of routes) {
      assert.deepEqual(route.auth, { kind: 'user', permission: 'eInvoicingAccounts:manage' }, route.path);
    }
    assert.deepEqual(routes.filter((route) => route.bodyLimit === '4kb').map((route) => route.method), ['PUT', 'PUT']);
  });
});

describe('what is refused to everyone but the PSA, over HTTP', () => {
  const routes = (): Array<[string, string]> => [urlOf(dealerA()), PLATFORM].flatMap((path): Array<[string, string]> => [['GET', path], ['PUT', path], ['DELETE', path]]);
  const stale = { 'if-match': `"${'A'.repeat(43)}"` };

  it('refuses a valid store key with 403 on all six routes, and nothing is written', async () => {
    const store = await world.activate(world.group(0).ownPlaceId);
    for (const [method, path] of routes()) {
      const reply = await world.asStore(store.key, method, path, method === 'PUT' ? account() : undefined, stale);
      assert.deepEqual([reply.status, reply.body.error.code], [403, 'FORBIDDEN'], `${method} ${path}`);
    }
    assert.equal(await storedOf(dealerA()), undefined);
    assert.equal(await platformStored(), undefined);
  });

  it('has no such route on the public surface: a valid public key gets 404 on the same six paths', async () => {
    const key = await world.makeKey();
    for (const [method, path] of routes()) {
      const reply = await world.asKey(key.secret, path, stale, method, method === 'PUT' ? account() : undefined);
      assert.equal(reply.status, 404, `${method} ${path}`);
    }
    assert.equal(await storedOf(dealerA()), undefined);
  });

  it('refuses a write without If-Match (422, the version header the API uses everywhere), and a body over 4 kB with 413', async () => {
    for (const path of [urlOf(dealerA()), PLATFORM]) {
      assert.deepEqual(failure(await call(psa(), 'PUT', path, account())).details, [{ field: 'If-Match', issue: 'required' }]);
      assert.deepEqual(failure(await call(psa(), 'DELETE', path)).details, [{ field: 'If-Match', issue: 'required' }]);
      const big = await call(psa(), 'PUT', path, account({ password: 'x'.repeat(5000) }), stale);
      assert.deepEqual([big.status, big.body.error.code], [413, 'PAYLOAD_TOO_LARGE']);
    }
    assert.equal(await storedOf(dealerA()), undefined);
  });

  it('never logs the password nor the stored ciphertext, on success and on failure', async () => {
    office.logEvents.length = 0;
    const created = await put(psa(), urlOf(dealerA()), account());
    await put(psa(), urlOf(dealerA()), account({ username: 'x y' }), etagOf(created));
    await call(psa(), 'PUT', urlOf(dealerA()), account({ password: 'p'.repeat(5000) }), { 'if-match': etagOf(created) });
    await put(psa(), urlOf(dealerB()), account({ maxPerHour: 0 }));
    const stored = await storedOf(dealerA());
    const logged = JSON.stringify(office.logEvents) + office.app.lines.join('\n');
    assert.ok(office.logEvents.length > 0);
    for (const secret of [PASSWORD, 'p'.repeat(100), stored.password.data, stored.password.tag, stored.password.epk, stored.password.iv]) {
      assert.ok(!logged.includes(secret), secret.slice(0, 12));
    }
  });
});

describe('the limits and the missing public key, over HTTP', () => {
  it('answers 429 with Retry-After to the saves beyond the limit of the routes that handle credentials', async () => {
    const limited = await openTestDatabases();
    const small = await startBackoffice(limited, { env: { CREDENTIALS_PUBLIC_KEY: PUBLIC_PEM, CREDENTIALS_PUBLIC_KEY_ID: 'k-test', RATE_LIMIT_USER_CREDENTIALS_PER_USER: '2' } });
    try {
      const other = actors(small);
      await limited.databases.common().collection('settings').deleteMany({});
      const statuses: number[] = [];
      let last: Awaited<ReturnType<typeof other.call>> | undefined;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        last = await other.call(small.cluster.psa, 'PUT', PLATFORM, account({ username: `limit-${String(attempt)}` }), { 'if-match': `"${'A'.repeat(43)}"` });
        statuses.push(last.status);
      }
      assert.deepEqual(statuses, [412, 412, 429]);
      assert.deepEqual(other.failure(last!).code, 'RATE_LIMITED');
      assert.ok(Number(last!.headers.get('retry-after')) > 0);
    } finally {
      await small.close();
      await limited.cleanup();
    }
  });

  it('answers 503 with the standard envelope to a save on an app without the public key, and still reads and removes', async () => {
    const bare = await openTestDatabases();
    const keyless = await startBackoffice(bare, {});
    try {
      const other = actors(keyless);
      const reply = await other.call(keyless.cluster.psa, 'PUT', PLATFORM, account(), { 'if-match': `"${'A'.repeat(43)}"` });
      assert.deepEqual(reply.body, { error: { code: 'SERVICE_UNAVAILABLE', message: 'Service unavailable' } });
      assert.equal(reply.status, 503);
      assert.equal((await other.call(keyless.cluster.psa, 'GET', PLATFORM)).status, 200);
      assert.equal(await bare.databases.common().collection('settings').countDocuments({ key: 'INTEGRATIONS' }), 0);
    } finally {
      await keyless.close();
      await bare.cleanup();
    }
  });
});
