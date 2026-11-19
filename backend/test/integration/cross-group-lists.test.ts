import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MongoServerError } from 'mongodb';
import type { Db, ObjectId } from 'mongodb';
import type { Databases } from '../../src/db/databases.ts';
import { memoryRateLimiter } from '../helpers/activity.ts';
import { startKeysWorld } from '../helpers/api-keys.ts';
import type { KeysWorld } from '../helpers/api-keys.ts';
import { fixtureId, legacyCompany, legacyPlace } from '../helpers/legacy-fixtures.ts';
import { insertCopies } from '../helpers/mirror.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';

let ctx: TestDatabases;
let world: KeysWorld;
const limiter = memoryRateLimiter();
/** While `true`, every read of `common.groups` exceeds its time limit, as a slow database would. */
let groupsExpire = false;
const expired = new MongoServerError({ message: 'operation exceeded time limit', code: 50, codeName: 'MaxTimeMSExpired' });
/** The common database with a `groups` collection that can be made to time out: the other collections and every other call are the real ones. */
const slowGroups = (db: Db): Db =>
  new Proxy(db, {
    get(target, property) {
      if (property === 'collection') {
        return (name: string) => {
          const collection = target.collection(name);
          return name === 'groups' ? new Proxy(collection, { get: (inner, key) => (key === 'find' && groupsExpire ? () => ({ toArray: () => Promise.reject(expired) }) : bind(inner, key)) }) : collection;
        };
      }
      return bind(target, property);
    },
  });
const bind = (target: object, key: string | symbol): unknown => {
  const value: unknown = Reflect.get(target, key, target);
  return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
};
const call = (...args: Parameters<KeysWorld['as']['call']>) => world.as.call(...args);
const common = () => ctx.databases.common();
const hex = (id: ObjectId) => id.toHexString();
const g = (index: number) => world.group(index);
const psa = () => world.office.cluster.psa;
const dealerA = () => world.office.cluster.dealerA;
const dealerB = () => world.office.cluster.dealerB;
const C = (n: number) => fixtureId('company', n);
const P = (n: number) => fixtureId('place', n);
const ORPHAN_GROUP = fixtureId('group', 777);
const SECRETS = ['fixture-secret', 'fixture-integration-secret', 'fattura_elettronica', 'integrations', 'banks', 'Via Fixture', 'example.test', 'password', 'apiKey'];

const names = (reply: { body: { data: Array<{ name: string }> } }) => reply.body.data.map((item) => item.name);

/** Every page of a list, walked with the cursor: the names in order. */
async function walk(actor: ObjectId, path: string, limit: number): Promise<string[]> {
  const walked: string[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 20; guard += 1) {
    const reply: Awaited<ReturnType<typeof call>> = await call(actor, 'GET', `${path}${path.includes('?') ? '&' : '?'}limit=${String(limit)}${cursor === null ? '' : `&cursor=${cursor}`}`);
    assert.equal(reply.status, 200);
    assert.ok(reply.body.data.length <= limit);
    walked.push(...names(reply));
    cursor = reply.body.page.next;
    if (cursor === null) {
      return walked;
    }
  }
  throw new Error('the list never ended');
}

before(async () => {
  ctx = await openTestDatabases();
  const slow = { ...ctx, databases: { ...ctx.databases, common: () => slowGroups(ctx.databases.common()) } as unknown as Databases };
  world = await startKeysWorld(slow, { rateLimiter: limiter, env: { RATE_LIMIT_API_PER_USER: '40' } });
  // The isolation cluster: groups 0 and 1 of dealer A, 2 and 3 of dealer B. The data of this file replace the copies the cluster seeded.
  await common().collection('companies').deleteMany({});
  await common().collection('places').deleteMany({});
  await common().collection('groups').updateOne({ _id: g(3).groupId }, { $set: { demo: true } });
  await common().collection('groups').updateOne({ _id: g(2).groupId }, { $unset: { name: '' } });
  await insertCopies(ctx.databases, 'companies', [
    legacyCompany(1, g(0).groupId, { name: 'Alpha', code: 'IT-ALPHA' }),
    legacyCompany(2, g(0).groupId, { name: 'Delta', status: false, countryCode: 'DE', countryAreaCode: '', city: 'Berlin' }),
    legacyCompany(3, g(0).groupId, { name: 'Gamma Trashed', trash: true, trashDate: new Date('2026-02-01T00:00:00.000Z') }),
    legacyCompany(4, g(1).groupId, { name: 'Bravo', countryAreaCode: 'MI' }),
    legacyCompany(5, g(1).groupId, { name: 'Echo' }),
    legacyCompany(6, g(2).groupId, { name: 'Charlie' }),
    legacyCompany(7, g(2).groupId, { name: 'Foxtrot', status: false }),
    legacyCompany(8, g(3).groupId, { name: 'Hotel' }),
    legacyCompany(9, ORPHAN_GROUP, { name: 'Orphan' }),
    legacyCompany(10, g(0).groupId, { name: 'Array group', groupId: [g(0).groupId, g(2).groupId] }),
    legacyCompany(11, g(0).groupId, { name: 'String group', groupId: hex(g(0).groupId) }),
    legacyCompany(12, g(0).groupId, { name: 'No group', groupId: undefined }),
  ]);
  await insertCopies(ctx.databases, 'places', [
    legacyPlace(1, g(0).groupId, C(1), { name: 'Pa' }),
    legacyPlace(2, g(0).groupId, C(2), { name: 'Pd', plan: 'advanced', status: false, expirationDate: new Date('2026-06-01T00:00:00.000Z'), city: 'Berlin', countryCode: 'DE', countryAreaCode: '' }),
    legacyPlace(3, g(0).groupId, C(1), { name: 'Pt', trash: true }),
    legacyPlace(4, g(1).groupId, C(4), { name: 'Pb', expirationDate: new Date('2026-01-01T00:00:00.000Z'), countryAreaCode: 'MI' }),
    legacyPlace(5, g(2).groupId, C(6), { name: 'Pc', plan: 'advanced' }),
    legacyPlace(6, g(3).groupId, C(8), { name: 'Ph' }),
    legacyPlace(7, ORPHAN_GROUP, C(9), { name: 'Po' }),
    legacyPlace(8, g(0).groupId, C(1), { name: 'Parray', groupId: [g(0).groupId, g(2).groupId] }),
  ]);
});
beforeEach(() => limiter.reset());
after(async () => {
  await world.office.close();
  await ctx.cleanup();
});

describe('GET /v1/companies', () => {
  it('gives the PSA the companies of every group (trashed ones apart, demo and orphan groups included) with the group and its name, and nothing of the credentials', async () => {
    const reply = await call(psa(), 'GET', '/companies');
    assert.equal(reply.status, 200);
    assert.deepEqual(names(reply), ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Hotel', 'Orphan']);
    assert.deepEqual(reply.body.data[0], {
      id: hex(C(1)),
      name: 'Alpha',
      vatNumber: 'IT-ALPHA',
      city: 'Fixtureville',
      province: 'RM',
      country: 'IT',
      status: 'active',
      trashed: false,
      trashedAt: null,
      groupId: hex(g(0).groupId),
      groupName: 'group-001',
    });
    // A group without a name has an empty one; a group that does not exist has none.
    assert.equal(reply.body.data.find((item: { name: string }) => item.name === 'Charlie').groupName, '');
    assert.equal(reply.body.data.find((item: { name: string }) => item.name === 'Orphan').groupName, null);
    assert.deepEqual(reply.body.page, { limit: 50, next: null });
    const text = JSON.stringify(reply.body);
    for (const secret of SECRETS) {
      assert.ok(!text.includes(secret), secret);
    }
    const etag = reply.headers.get('etag')!;
    assert.match(etag, /^W\/"/);
    assert.equal((await world.office.call('GET', '/companies', await world.as.tokenOf(psa()), undefined, { 'if-none-match': etag })).status, 304);
  });

  it('never returns a copy whose group is missing, a text or a list', async () => {
    const all = names(await call(psa(), 'GET', '/companies?q=group'));
    assert.deepEqual(all, []);
    assert.deepEqual(names(await call(psa(), 'GET', `/companies?groupId=${hex(g(2).groupId)}&q=array`)), []);
  });

  it('gives a dealer only the groups of his own, whatever he asks', async () => {
    assert.deepEqual(names(await call(dealerA(), 'GET', '/companies')), ['Alpha', 'Bravo', 'Delta', 'Echo']);
    assert.deepEqual(names(await call(dealerB(), 'GET', '/companies')), ['Charlie', 'Foxtrot', 'Hotel']);
    assert.deepEqual(names(await call(dealerA(), 'GET', `/companies?groupId=${hex(g(1).groupId)}`)), ['Bravo', 'Echo']);
    for (const query of [`groupId=${hex(g(2).groupId)}`, `groupId=${hex(g(3).groupId)}`, `groupId=${hex(ORPHAN_GROUP)}`, 'q=charlie', 'q=hotel', 'q=orphan', `groupId=${hex(g(0).groupId)}&q=charlie`]) {
      const reply = await call(dealerA(), 'GET', `/companies?${query}`);
      assert.deepEqual([reply.status, reply.body], [200, { data: [], page: { limit: 50, next: null } }], query);
    }
  });

  it('does not let the cursor of another scope widen the one of a dealer', async () => {
    const first = await call(psa(), 'GET', '/companies?limit=1');
    assert.deepEqual(names(first), ['Alpha']);
    // The cursor of the PSA after `Alpha`: a dealer continues inside his own groups only.
    const dealer = await call(dealerB(), 'GET', `/companies?cursor=${first.body.page.next}`);
    assert.deepEqual(names(dealer), ['Charlie', 'Foxtrot', 'Hotel']);
    const other = await call(dealerA(), 'GET', `/companies?limit=1&cursor=${(await call(dealerB(), 'GET', '/companies?limit=1')).body.page.next}`);
    assert.deepEqual(names(other), ['Delta']);
  });

  it('narrows the PSA view by group and by dealer, and gives nothing for a dealer without groups or a group that does not match', async () => {
    assert.deepEqual(names(await call(psa(), 'GET', `/companies?groupId=${hex(g(0).groupId)}`)), ['Alpha', 'Delta']);
    assert.deepEqual(names(await call(psa(), 'GET', `/companies?dealerId=${hex(dealerA())}`)), ['Alpha', 'Bravo', 'Delta', 'Echo']);
    assert.deepEqual(names(await call(psa(), 'GET', `/companies?dealerId=${hex(dealerB())}`)), ['Charlie', 'Foxtrot', 'Hotel']);
    assert.deepEqual(names(await call(psa(), 'GET', `/companies?dealerId=${hex(dealerB())}&groupId=${hex(g(2).groupId)}`)), ['Charlie', 'Foxtrot']);
    assert.deepEqual(names(await call(psa(), 'GET', `/companies?dealerId=${hex(dealerB())}&groupId=${hex(g(0).groupId)}`)), []);
    assert.deepEqual(names(await call(psa(), 'GET', `/companies?dealerId=${hex(C(1))}`)), []);
    assert.deepEqual(names(await call(psa(), 'GET', `/companies?groupId=${hex(ORPHAN_GROUP)}`)), ['Orphan']);
    assert.deepEqual(names(await call(psa(), 'GET', `/companies?groupId=${hex(C(1))}`)), []);
  });

  it('includes the groups in the trash for the PSA and leaves them out for a dealer', async () => {
    await common().collection('groups').updateOne({ _id: g(1).groupId }, { $set: { trash: true } });
    try {
      assert.deepEqual(names(await call(psa(), 'GET', '/companies')), ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Hotel', 'Orphan']);
      assert.deepEqual(names(await call(psa(), 'GET', `/companies?dealerId=${hex(dealerA())}`)), ['Alpha', 'Bravo', 'Delta', 'Echo']);
      assert.deepEqual(names(await call(dealerA(), 'GET', '/companies')), ['Alpha', 'Delta']);
      assert.deepEqual(names(await call(dealerA(), 'GET', `/companies?groupId=${hex(g(1).groupId)}`)), []);
    } finally {
      await common().collection('groups').updateOne({ _id: g(1).groupId }, { $set: { trash: false } });
    }
    // A dealer without any group has an empty list.
    await common().collection('groups').updateMany({ dealerId: dealerA() }, { $set: { trash: true } });
    try {
      assert.deepEqual((await call(dealerA(), 'GET', '/companies')).body, { data: [], page: { limit: 50, next: null } });
    } finally {
      await common().collection('groups').updateMany({ dealerId: dealerA() }, { $set: { trash: false } });
    }
  });

  it('filters by trash, status, country, province and text, and sorts', async () => {
    assert.deepEqual(names(await call(psa(), 'GET', '/companies?trashed=true')), ['Gamma Trashed']);
    assert.deepEqual((await call(psa(), 'GET', '/companies?trashed=true')).body.data[0].trashedAt, '2026-02-01T00:00:00.000Z');
    assert.deepEqual(names(await call(psa(), 'GET', '/companies?trashed=false&status=disabled')), ['Delta', 'Foxtrot']);
    assert.deepEqual(names(await call(psa(), 'GET', '/companies?status=active&country=IT&province=MI')), ['Bravo']);
    assert.deepEqual(names(await call(psa(), 'GET', '/companies?country=DE')), ['Delta']);
    assert.deepEqual(names(await call(psa(), 'GET', '/companies?q=it-alp')), ['Alpha']);
    assert.deepEqual(names(await call(psa(), 'GET', '/companies?q=ECHO&sort=name')), ['Echo']);
    assert.deepEqual(names(await call(psa(), 'GET', '/companies?q=.*')), []);
    assert.deepEqual(names(await call(psa(), 'GET', '/companies?sort=-name&limit=3')), ['Orphan', 'Hotel', 'Foxtrot']);
    assert.deepEqual(names(await call(dealerA(), 'GET', `/companies?status=disabled&groupId=${hex(g(0).groupId)}`)), ['Delta']);
  });

  it('pages across groups with the cursor, in both directions, until the end', async () => {
    assert.deepEqual(await walk(psa(), '/companies', 3), ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Hotel', 'Orphan']);
    assert.deepEqual(await walk(psa(), '/companies?sort=-name', 2), ['Orphan', 'Hotel', 'Foxtrot', 'Echo', 'Delta', 'Charlie', 'Bravo', 'Alpha']);
    assert.deepEqual(await walk(dealerA(), '/companies', 1), ['Alpha', 'Bravo', 'Delta', 'Echo']);
    assert.deepEqual(await walk(psa(), `/companies?dealerId=${hex(dealerB())}`, 2), ['Charlie', 'Foxtrot', 'Hotel']);
  });

  it('refuses every role but the PSA and the dealers, a store key and an anonymous caller', async () => {
    for (const actor of [g(0).sa, g(0).ca, g(0).pa]) {
      assert.deepEqual(world.as.failure(await call(actor, 'GET', '/companies')), { status: 403, code: 'FORBIDDEN', details: undefined });
    }
    assert.equal((await world.office.call('GET', '/companies', undefined)).status, 401);
    const key = await world.activate(g(0).ownPlaceId);
    const asStore = await world.asStore(key.key, 'GET', '/companies');
    assert.deepEqual([asStore.status, asStore.body.error.code], [403, 'FORBIDDEN']);
    // The `dealerId` filter is the PSA's alone.
    assert.deepEqual(world.as.failure(await call(dealerA(), 'GET', `/companies?dealerId=${hex(dealerA())}`)), { status: 403, code: 'FORBIDDEN', details: undefined });
    assert.equal((await call(psa(), 'GET', `/companies?dealerId=${hex(dealerA())}`)).status, 200);
  });

  it('rejects what the list does not accept with 422, a malformed cursor first among the rest but after the permission', async () => {
    for (const query of ['unknown=1', 'ids=' + hex(C(1)), 'limit=101', 'limit=0', 'groupId=x', 'dealerId=', 'sort=code', 'status=x', 'country=it', 'trashed=maybe', 'plan=basic', 'companyId=' + hex(C(1)), 'cursor=x', 'groupId=' + hex(g(0).groupId) + '&groupId=' + hex(g(1).groupId)]) {
      assert.equal((await call(psa(), 'GET', `/companies?${query}`)).status, 422, query);
    }
    assert.equal((await call(psa(), 'GET', `/companies?cursor=${Buffer.from('{}').toString('base64url')}`)).status, 422);
    // The permission comes before the cursor.
    assert.equal((await call(g(0).sa, 'GET', '/companies?cursor=x')).status, 403);
    assert.equal((await call(psa(), 'GET', '/companies?limit=100')).status, 200);
  });
});

describe('GET /v1/places', () => {
  it('gives the PSA the places of every group (trashed ones apart) with the group and its name, and nothing of the credentials', async () => {
    const reply = await call(psa(), 'GET', '/places');
    assert.equal(reply.status, 200);
    assert.deepEqual(names(reply), ['Pa', 'Pb', 'Pc', 'Pd', 'Ph', 'Po']);
    assert.deepEqual(reply.body.data[3], {
      id: hex(P(2)),
      name: 'Pd',
      companyId: hex(C(2)),
      trashed: false,
      trashedAt: null,
      plan: 'advanced',
      status: 'disabled',
      city: 'Berlin',
      province: '',
      country: 'DE',
      expirationDate: '2026-06-01T00:00:00.000Z',
      groupId: hex(g(0).groupId),
      groupName: 'group-001',
    });
    assert.equal(reply.body.data.find((item: { name: string }) => item.name === 'Po').groupName, null);
    const text = JSON.stringify(reply.body);
    for (const secret of [...SECRETS, '10.0.0.1', 'devices', 'server', 'storages']) {
      assert.ok(!text.includes(secret), secret);
    }
    const etag = reply.headers.get('etag')!;
    assert.equal((await world.office.call('GET', '/places', await world.as.tokenOf(psa()), undefined, { 'if-none-match': etag })).status, 304);
  });

  it('gives a dealer only the groups of his own, whatever he asks', async () => {
    assert.deepEqual(names(await call(dealerA(), 'GET', '/places')), ['Pa', 'Pb', 'Pd']);
    assert.deepEqual(names(await call(dealerB(), 'GET', '/places')), ['Pc', 'Ph']);
    assert.deepEqual(names(await call(dealerA(), 'GET', `/places?groupId=${hex(g(1).groupId)}`)), ['Pb']);
    for (const query of [`groupId=${hex(g(2).groupId)}`, `groupId=${hex(ORPHAN_GROUP)}`, 'q=ph', `companyId=${hex(C(6))}`, `companyId=${hex(C(8))}`, 'plan=advanced&q=pc', `groupId=${hex(g(0).groupId)}&companyId=${hex(C(6))}`]) {
      const reply = await call(dealerA(), 'GET', `/places?${query}`);
      assert.deepEqual([reply.status, reply.body], [200, { data: [], page: { limit: 50, next: null } }], query);
    }
    assert.deepEqual(names(await call(dealerA(), 'GET', `/places?companyId=${hex(C(1))}`)), ['Pa']);
  });

  it('narrows the PSA view by group and by dealer, and includes the groups in the trash and the demo ones', async () => {
    assert.deepEqual(names(await call(psa(), 'GET', `/places?groupId=${hex(g(3).groupId)}`)), ['Ph']);
    assert.deepEqual(names(await call(psa(), 'GET', `/places?dealerId=${hex(dealerA())}`)), ['Pa', 'Pb', 'Pd']);
    assert.deepEqual(names(await call(psa(), 'GET', `/places?dealerId=${hex(dealerB())}&groupId=${hex(g(0).groupId)}`)), []);
    await common().collection('groups').updateOne({ _id: g(1).groupId }, { $set: { trash: true } });
    try {
      assert.deepEqual(names(await call(psa(), 'GET', '/places')), ['Pa', 'Pb', 'Pc', 'Pd', 'Ph', 'Po']);
      assert.deepEqual(names(await call(dealerA(), 'GET', '/places')), ['Pa', 'Pd']);
    } finally {
      await common().collection('groups').updateOne({ _id: g(1).groupId }, { $set: { trash: false } });
    }
  });

  it('filters by trash, company, status, plan, country, province and text, and sorts by name and by expiration date', async () => {
    assert.deepEqual(names(await call(psa(), 'GET', '/places?trashed=true')), ['Pt']);
    assert.deepEqual(names(await call(psa(), 'GET', `/places?companyId=${hex(C(2))}`)), ['Pd']);
    assert.deepEqual(names(await call(psa(), 'GET', '/places?status=disabled')), ['Pd']);
    assert.deepEqual(names(await call(psa(), 'GET', '/places?status=active&plan=advanced')), ['Pc']);
    assert.deepEqual(names(await call(psa(), 'GET', '/places?country=DE&q=berlin')), ['Pd']);
    assert.deepEqual(names(await call(psa(), 'GET', '/places?province=MI')), ['Pb']);
    assert.deepEqual(names(await call(psa(), 'GET', '/places?q=.*')), []);
    assert.deepEqual(names(await call(psa(), 'GET', '/places?sort=-name&limit=2')), ['Po', 'Ph']);
    // A place without a date sorts first ascending and last descending.
    assert.deepEqual(names(await call(psa(), 'GET', '/places?sort=expirationDate')), ['Pa', 'Pc', 'Ph', 'Po', 'Pb', 'Pd']);
    assert.deepEqual(names(await call(psa(), 'GET', '/places?sort=-expirationDate')), ['Pd', 'Pb', 'Po', 'Ph', 'Pc', 'Pa']);
  });

  it('pages across groups with the cursor, by name and by expiration date', async () => {
    assert.deepEqual(await walk(psa(), '/places', 2), ['Pa', 'Pb', 'Pc', 'Pd', 'Ph', 'Po']);
    assert.deepEqual(await walk(psa(), '/places?sort=expirationDate', 4), ['Pa', 'Pc', 'Ph', 'Po', 'Pb', 'Pd']);
    assert.deepEqual(await walk(psa(), '/places?sort=-expirationDate', 1), ['Pd', 'Pb', 'Po', 'Ph', 'Pc', 'Pa']);
    assert.deepEqual(await walk(dealerA(), '/places', 1), ['Pa', 'Pb', 'Pd']);
  });

  it('does not let the cursor of another scope widen the one of a dealer', async () => {
    const first = await call(psa(), 'GET', '/places?limit=1');
    assert.deepEqual(names(await call(dealerB(), 'GET', `/places?cursor=${first.body.page.next}`)), ['Pc', 'Ph']);
    // A cursor made for another sort is not accepted.
    assert.equal((await call(dealerB(), 'GET', `/places?sort=expirationDate&cursor=${first.body.page.next}`)).status, 422);
  });

  it('refuses every role but the PSA and the dealers, a store key and an anonymous caller', async () => {
    for (const actor of [g(0).sa, g(0).ca, g(0).pa]) {
      assert.deepEqual(world.as.failure(await call(actor, 'GET', '/places')), { status: 403, code: 'FORBIDDEN', details: undefined });
    }
    assert.equal((await world.office.call('GET', '/places', undefined)).status, 401);
    const key = await world.activate(g(0).ownPlaceId);
    const asStore = await world.asStore(key.key, 'GET', '/places');
    assert.deepEqual([asStore.status, asStore.body.error.code], [403, 'FORBIDDEN']);
    assert.deepEqual(world.as.failure(await call(dealerA(), 'GET', `/places?dealerId=${hex(dealerA())}`)), { status: 403, code: 'FORBIDDEN', details: undefined });
    assert.equal((await call(psa(), 'GET', `/places?dealerId=${hex(dealerA())}`)).status, 200);
  });

  it('rejects what the list does not accept with 422', async () => {
    for (const query of ['unknown=1', 'ids=' + hex(P(1)), 'limit=101', 'groupId=x', 'dealerId=x', 'sort=city', 'plan=a%20b', 'companyId=x', 'country=ITA', 'cursor=x']) {
      assert.equal((await call(psa(), 'GET', `/places?${query}`)).status, 422, query);
    }
    assert.equal((await call(g(0).sa, 'GET', '/places?cursor=x')).status, 403);
  });
});

describe('the cross-group lists and the group lists', () => {
  it('leave the group lists as they were', async () => {
    const reply = await call(psa(), 'GET', `/groups/${hex(g(0).groupId)}/companies`);
    assert.deepEqual(names(reply), ['Alpha', 'Delta']);
    assert.ok(!('groupId' in reply.body.data[0]));
    assert.deepEqual(names(await call(psa(), 'GET', `/groups/${hex(g(0).groupId)}/places`)), ['Pa', 'Pd']);
  });
});

describe('what the cross-group lists refuse', () => {
  it('refuses a public API key on both routes, in either header', async () => {
    const key = await world.makeKey();
    for (const path of ['/companies', '/places']) {
      const asBearer = await world.office.call('GET', path, key.secret);
      assert.deepEqual([asBearer.status, (await asBearer.json()).error.code], [401, 'UNAUTHENTICATED'], path);
      const asHeader = await world.office.call('GET', path, undefined, undefined, { 'x-api-key': key.secret });
      assert.equal(asHeader.status, 401, path);
    }
  });

  it('answers 429 with Retry-After to a user over the limit of his requests, on both routes', async () => {
    for (const path of ['/companies?limit=1', '/places?limit=1']) {
      limiter.reset();
      let last = await call(psa(), 'GET', path);
      for (let sent = 1; sent < 41; sent += 1) {
        assert.equal(last.status, 200, `${path} ${String(sent)}`);
        last = await call(psa(), 'GET', path);
      }
      assert.deepEqual([last.status, last.body.error.code], [429, 'RATE_LIMITED'], path);
      assert.ok(Number(last.headers.get('retry-after')) >= 1);
    }
  });

  it('answers 503 when the groups cannot be read in time, never an empty list', async () => {
    groupsExpire = true;
    try {
      // The names of the groups of the page.
      for (const path of ['/companies', '/places']) {
        assert.deepEqual(world.as.failure(await call(psa(), 'GET', path)), { status: 503, code: 'SERVICE_UNAVAILABLE', details: undefined }, path);
      }
      // The groups of a dealer, for the filter of the PSA.
      for (const path of ['/companies', '/places']) {
        assert.equal((await call(psa(), 'GET', `${path}?dealerId=${hex(dealerA())}`)).status, 503, path);
      }
    } finally {
      groupsExpire = false;
    }
    assert.equal((await call(psa(), 'GET', '/companies')).status, 200);
  });
});
