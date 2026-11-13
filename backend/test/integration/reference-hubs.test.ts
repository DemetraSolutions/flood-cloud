import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startCompaniesWorld } from '../helpers/companies.ts';
import type { CompaniesWorld } from '../helpers/companies.ts';
import { legacyCountry } from '../helpers/legacy-fixtures.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { send } from '../helpers/users.ts';

let ctx: TestDatabases;
let world: CompaniesWorld;
const call = (...args: Parameters<CompaniesWorld['as']['call']>) => world.as.call(...args);
const failure = (reply: Awaited<ReturnType<typeof call>>) => world.as.failure(reply);
const hex = (id: { toHexString(): string }) => id.toHexString();
const psa = () => world.office.cluster.psa;
const dealerA = () => world.office.cluster.dealerA;
const dealerB = () => world.office.cluster.dealerB;

before(async () => {
  ctx = await openTestDatabases();
  world = await startCompaniesWorld(ctx);
});
after(async () => {
  await world.office.close();
  await ctx.cleanup();
});

describe('GET /v1/countries', () => {
  it('gives the countries sorted by name with their areas, to every authenticated user, leaving out what is not a country', async () => {
    await ctx.databases.common().collection('countries').insertMany([
      legacyCountry(10, { code: 'ES', name: 'Spagna', areas: [{ code: 'M' }, { name: 'no code' }, 5, { code: '', name: 'empty' }, { code: 'B', name: 'Barcellona' }] }),
      legacyCountry(11, { code: 'xx', name: '', areas: null }),
      legacyCountry(12, { code: 'TOOLONG', name: 'Invalid' }),
      legacyCountry(13, { code: undefined, name: 'No code' }),
      legacyCountry(14, { code: 'DB', name: 'Dup' }),
      legacyCountry(15, { code: 'DA', name: 'Dup' }),
    ]);
    for (const actor of [psa(), dealerA(), world.group(0).sa, world.group(0).ca, world.group(0).pa]) {
      const reply = await call(actor, 'GET', '/countries');
      assert.equal(reply.status, 200);
      assert.deepEqual(
        reply.body.data.map((country: { code: string }) => country.code),
        ['DA', 'DB', 'FR', 'DE', 'IT', 'ES', 'XX'],
      );
      assert.deepEqual(reply.body.page, { limit: 7, next: null });
    }
    const { data } = (await call(psa(), 'GET', '/countries')).body;
    assert.deepEqual(data[4], { code: 'IT', name: 'Italia', areas: [{ code: 'MI', name: 'Milano' }, { code: 'RM', name: 'Roma' }] });
    assert.deepEqual(data[3], { code: 'DE', name: 'Germania', areas: [] });
    assert.deepEqual(data[2], { code: 'FR', name: 'Francia', areas: [] }, 'areas that are not a list read as none');
    assert.deepEqual(data[5], { code: 'ES', name: 'Spagna', areas: [{ code: 'M', name: 'M' }, { code: 'B', name: 'Barcellona' }] });
    assert.deepEqual(data[6], { code: 'XX', name: 'XX', areas: [] }, 'the name falls back to the code');
  });

  it('revalidates with its ETag, and needs a login', async () => {
    const first = await call(psa(), 'GET', '/countries');
    const etag = first.headers.get('etag')!;
    assert.match(etag, /^W\//);
    assert.equal((await call(psa(), 'GET', '/countries', undefined, { 'if-none-match': etag })).status, 304);
    assert.equal((await send(world.office, 'GET', '/countries', undefined)).status, 401);
    assert.equal(first.headers.get('cache-control'), 'no-store');
  });
});

describe('GET /v1/groups/{groupId}/companies/e-invoicing-hubs', () => {
  const path = (index = 0) => world.path(index, '/e-invoicing-hubs');
  const users = () => ctx.databases.common().collection('users');

  it('gives each role the hubs it may set, labelled with the business name of the dealer or his name', async () => {
    const now = new Date();
    await ctx.databases.common().collection('dealers').insertOne({
      _id: dealerA(), businessName: 'Alpha Dealer Srl', vatNumber: null, fiscalCode: null, address: null, pec: null, sdiCode: null, email: null, phone: null, createdAt: now, updatedAt: now, createdBy: null, source: 'migration',
    });
    const userB = (await users().findOne({ _id: dealerB() }))!;
    const nameB = `${userB['name'] as string} ${userB['surname'] as string}`;
    const everything = [
      { value: 'aruba', label: 'Aruba' },
      { value: `aruba__${hex(dealerA())}`, label: 'Alpha Dealer Srl' },
      { value: `aruba__${hex(dealerB())}`, label: nameB },
    ];
    const asPsa = await call(psa(), 'GET', path());
    assert.equal(asPsa.status, 200);
    assert.deepEqual(asPsa.body.data, everything, 'the trashed and the disabled dealers are not listed');
    assert.deepEqual((await call(dealerA(), 'GET', path())).body.data, [everything[0], everything[1]]);
    assert.deepEqual((await call(world.group(0).sa, 'GET', path())).body.data, []);
    assert.deepEqual((await call(world.group(0).ca, 'GET', path())).body.data, []);
  });

  it('is exactly what the write allows: every listed value is accepted for that caller, the others are refused', async () => {
    const id = await world.seed(0, 910, { code: 'HUB-1', countryCode: 'DE', countryAreaCode: '' });
    const hubOf = async (actor: typeof psa extends () => infer R ? R : never, value: string) => {
      const etag = (await call(psa(), 'GET', world.path(0, `/${hex(id)}`))).headers.get('etag')!;
      return call(actor, 'PATCH', world.path(0, `/${hex(id)}`), { eInvoicing: { hub: value } }, { 'if-match': etag });
    };
    for (const actor of [psa(), dealerA()]) {
      for (const option of (await call(actor, 'GET', path())).body.data as Array<{ value: string }>) {
        assert.equal((await hubOf(actor, option.value)).status, 200, option.value);
      }
    }
    assert.equal(failure(await hubOf(dealerA(), `aruba__${hex(dealerB())}`)).status, 403, 'a hub the dealer does not list');
    assert.equal(failure(await hubOf(world.group(0).sa, 'aruba')).status, 403);
  });

  it('is reachable before the routes of one company, needs the permission and the group', async () => {
    assert.equal(failure(await call(world.group(0).pa, 'GET', path())).status, 403);
    assert.equal(failure(await call(dealerB(), 'GET', path())).status, 404, 'a group of another dealer');
    assert.equal(failure(await call(world.group(2).sa, 'GET', path())).status, 404);
    assert.equal((await send(world.office, 'GET', path(), undefined)).status, 401);
  });

  it('labels a dealer who has neither a business name nor a name with his id', async () => {
    const { legacyUser } = await import('../helpers/legacy-fixtures.ts');
    const nameless = legacyUser(950, { role: 'D', name: '', surname: undefined });
    await users().insertMany([nameless, legacyUser(951, { role: 'D', name: 'Twin', surname: 'Dealer' }), legacyUser(952, { role: 'D', name: 'Twin', surname: 'Dealer' })]);
    const listed = (await call(psa(), 'GET', path())).body.data as Array<{ value: string; label: string }>;
    assert.deepEqual(listed.find((option) => option.value === `aruba__${hex(nameless['_id'])}`), { value: `aruba__${hex(nameless['_id'])}`, label: hex(nameless['_id']) });
    const twins = listed.filter((option) => option.label === 'Twin Dealer').map((option) => option.value);
    assert.deepEqual(twins, [...twins].sort(), 'two dealers with the same label come in the order of their ids');
    assert.equal(twins.length, 2);
  });
});
