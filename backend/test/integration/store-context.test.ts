import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fixtureId, legacyUser } from '../helpers/legacy-fixtures.ts';
import { canonicalJson, etagOf } from '../../src/shared/http/etag.ts';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { createStoreContextRepository } from '../../src/modules/store-context/store-context.repository.ts';
import { memoryRateLimiter } from '../helpers/activity.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { startStoreWorld } from '../helpers/store-keys.ts';
import type { ActivatedKey, StoreWorld } from '../helpers/store-keys.ts';

// Fake values planted in the stored documents, to find them (or their absence) in the responses, logs and activity events.
const LEGACY_KEY = 'LEGACY-GROUP-KEY-SENTINEL'; // gitleaks:allow (fake test value)
const YELLGO_KEY = 'YELLGO-KEY-SENTINEL'; // gitleaks:allow (fake test value)
const DOJO_KEY = 'DOJO-KEY-SENTINEL'; // gitleaks:allow (fake test value)
const STRIPE_KEY = 'STRIPE-KEY-SENTINEL'; // gitleaks:allow (fake test value)
const DEVICE_USER = 'DEVICE-USER-SENTINEL'; // gitleaks:allow (fake test value)
const DEVICE_PASSWORD = 'DEVICE-PASSWORD-SENTINEL'; // gitleaks:allow (fake test value)
const NEVER = ['DB-HOST-SENTINEL', 'FILES-HOST-SENTINEL', 'UNKNOWN-GROUP-FIELD-SENTINEL', 'UNKNOWN-PLACE-FIELD-SENTINEL', 'UNKNOWN-COMPANY-FIELD-SENTINEL', 'PUBLIC-API-SENTINEL']; // gitleaks:allow (fake test values)

let ctx: TestDatabases;
let world: StoreWorld;
const limiter = memoryRateLimiter();
const common = () => ctx.databases.common();
const groupDb = (index = 0) => ctx.databases.group(world.group(index).groupId, 'cluster0');
const hex = (id: ObjectId) => id.toHexString();
const own = () => world.group(0).ownPlaceId;
const other = () => world.group(0).otherPlaceId;
const companyOf = async (placeId: ObjectId): Promise<ObjectId> => (await common().collection('places').findOne({ _id: placeId }))!['companyId'] as ObjectId;
const psaGet = (path: string) => world.as.call(world.office.cluster.psa, 'GET', path);
const g = (index = 0) => hex(world.group(index).groupId);
let store: ActivatedKey;
let ownCompany: ObjectId;

/** Plants the credentials and the forbidden values in the stored documents of the first group. */
async function plant(): Promise<void> {
  await common().collection('groups').updateOne(
    { _id: world.group(0).groupId },
    {
      $set: {
        apiKey: LEGACY_KEY,
        databaseHost: 'DB-HOST-SENTINEL',
        filesHost: 'FILES-HOST-SENTINEL',
        unknownGroupField: 'UNKNOWN-GROUP-FIELD-SENTINEL',
        'settings.integrations': { yellgo: { status: true, apiKey: YELLGO_KEY } },
        publicApi: { enabled: true, defaultRateLimitPerMinute: 17, note: 'PUBLIC-API-SENTINEL' },
      },
    },
  );
  await groupDb().collection('places').updateOne(
    { _id: own() },
    {
      $set: {
        unknownPlaceField: 'UNKNOWN-PLACE-FIELD-SENTINEL',
        integrations: { dojo: { status: true, apiKey: DOJO_KEY }, floodPay: { stripe: { privateKey: STRIPE_KEY } } },
        devices: [
          { id: 'd1', type: 'desk', name: 'Cassa', automaticCashUsername: DEVICE_USER, automaticCashPassword: DEVICE_PASSWORD, info: { appVersion: '1' } },
          { id: 'd2', type: 'handheld', name: 'Palmare' },
        ],
      },
    },
  );
  await groupDb().collection('companies').updateOne({ _id: await companyOf(own()) }, { $set: { unknownCompanyField: 'UNKNOWN-COMPANY-FIELD-SENTINEL' } });
}

before(async () => {
  ctx = await openTestDatabases();
  world = await startStoreWorld(ctx, { rateLimiter: limiter });
  ownCompany = await companyOf(own());
});
after(async () => {
  await world.office.close();
  await ctx.cleanup();
});
beforeEach(async () => {
  await common().collection('storeKeys').deleteMany({});
  await common().collection('storeActivationCodes').deleteMany({});
  await common().collection('places').updateMany({}, { $set: { status: true, trash: false, expirationDate: null } });
  await common().collection('companies').updateMany({}, { $set: { trash: false } });
  await common().collection('groups').updateMany({}, { $set: { status: true, trash: false } });
  limiter.reset();
  await common().collection('places').updateOne({ _id: own() }, { $set: { companyId: ownCompany } });
  await groupDb().collection('places').updateOne({ _id: own() }, { $set: { companyId: ownCompany } });
  await plant();
  store = await world.activate(own());
});

type Tree = Record<string, unknown>;
const isTree = (value: unknown): value is Tree => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Walks the representation of the backoffice and the one of the store together: every `<key>Set` flag of the first must be the key itself in the second (`<key>`, with its text or `null`, and no flag),
 * and everything else must be identical. Returns the paths of the credentials found.
 */
function compareCredentials(backoffice: unknown, clear: unknown, path = ''): string[] {
  if (Array.isArray(backoffice)) {
    assert.ok(Array.isArray(clear) && clear.length === backoffice.length, `${path}: same list`);
    return backoffice.flatMap((item, index) => compareCredentials(item, clear[index], `${path}[${String(index)}]`));
  }
  if (!isTree(backoffice)) {
    assert.deepEqual(clear, backoffice, path);
    return [];
  }
  assert.ok(isTree(clear), `${path}: an object`);
  const found: string[] = [];
  const credentialKeys = Object.keys(backoffice).filter((key) => key.endsWith('Set') && typeof backoffice[key] === 'boolean');
  const bases = credentialKeys.map((key) => key.slice(0, -3));
  assert.deepEqual(
    Object.keys(clear).sort(),
    Object.keys(backoffice)
      .filter((key) => !credentialKeys.includes(key))
      .concat(bases.filter((base) => !(base in backoffice)))
      .sort(),
    `${path}: same keys, the flags replaced by their keys`,
  );
  for (const key of credentialKeys) {
    const base = key.slice(0, -3);
    assert.ok(!(key in clear), `${path}.${key}: no flag`);
    assert.ok(clear[base] === null || typeof clear[base] === 'string', `${path}.${base}: text or null`);
    assert.equal(clear[base] !== null, backoffice[key], `${path}.${base}: set exactly when the flag is`);
    found.push(`${path}.${base}`);
  }
  for (const key of Object.keys(backoffice).filter((name) => !credentialKeys.includes(name))) {
    found.push(...compareCredentials(backoffice[key], clear[key], `${path}.${key}`));
  }
  return found;
}

describe('GET /v1/store-context/place', () => {
  it('gives the place of the store with the credentials of its integrations and devices in clear, and the rest as the backoffice sees it', async () => {
    const reply = await world.asStore(store.key, 'GET', '/store-context/place');
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const place = reply.body.data;
    assert.equal(place.id, hex(own()));
    assert.equal(place.integrations.dojo.apiKey, DOJO_KEY);
    assert.equal(place.integrations.floodPay.stripe.privateKey, STRIPE_KEY);
    assert.equal(place.integrations.yellgo.apiKey, null);
    assert.equal(place.devices.items[0].automaticCashUsername, DEVICE_USER);
    assert.equal(place.devices.items[0].automaticCashPassword, DEVICE_PASSWORD);
    assert.equal(place.devices.items[1].automaticCashPassword, null);
    assert.ok(place.dealerSettings !== undefined, 'the dealer settings are part of the configuration of the store');
    const found = compareCredentials((await psaGet(`/groups/${g()}/places/${hex(own())}`)).body.data, place);
    assert.ok(found.includes('.integrations.dojo.apiKey') && found.includes('.devices.items[0].automaticCashPassword'), found.join(', '));
    assert.ok(found.length >= 15, `every credential of the integrations and of the devices is there (${String(found.length)})`);
    const text = JSON.stringify(reply.body);
    for (const secret of NEVER) {
      assert.ok(!text.includes(secret), secret);
    }
  });

  it('reads a place with no integrations, no devices or junk in their place as nulls and empty lists, never an error', async () => {
    await groupDb().collection('places').updateOne({ _id: own() }, { $unset: { integrations: '', devices: '' } });
    const none = await world.asStore(store.key, 'GET', '/store-context/place');
    assert.equal(none.status, 200);
    assert.equal(none.body.data.integrations.dojo.apiKey, null);
    assert.deepEqual(none.body.data.devices.items, []);
    await groupDb()
      .collection('places')
      .updateOne(
        { _id: own() },
        { $set: { integrations: { dojo: { apiKey: 7 }, floodPay: 'x', satispay: { keyId: ['k'], activationCode: '' } }, devices: [{ id: 'd1', automaticCashPassword: { x: 1 }, automaticCashUsername: 5 }, 'junk'] } },
      );
    const junk = await world.asStore(store.key, 'GET', '/store-context/place');
    assert.equal(junk.status, 200);
    assert.deepEqual([junk.body.data.integrations.dojo.apiKey, junk.body.data.integrations.satispay.keyId, junk.body.data.integrations.satispay.activationCode], [null, null, null]);
    assert.equal(junk.body.data.devices.items[0].automaticCashPassword, null);
    assert.equal(junk.body.data.devices.items[0].automaticCashUsername, null);
    assert.equal(junk.body.data.devices.items.length, 1);
  });

  it('is the place of the key and no other, whatever the other stores have', async () => {
    await groupDb().collection('places').updateOne({ _id: other() }, { $set: { 'integrations.dojo.apiKey': 'OTHER-PLACE-KEY-SENTINEL' } }); // gitleaks:allow (fake test value)
    const second = await world.activate(other());
    const mine = await world.asStore(store.key, 'GET', '/store-context/place');
    const theirs = await world.asStore(second.key, 'GET', '/store-context/place');
    assert.equal(mine.body.data.id, hex(own()));
    assert.equal(theirs.body.data.id, hex(other()));
    assert.ok(!JSON.stringify(mine.body).includes('OTHER-PLACE-KEY-SENTINEL'));
    assert.equal(theirs.body.data.integrations.dojo.apiKey, 'OTHER-PLACE-KEY-SENTINEL');
    assert.ok(!JSON.stringify(theirs.body).includes(DEVICE_PASSWORD));
    const otherGroup = await world.activate(world.group(1).ownPlaceId, 1);
    const far = await world.asStore(otherGroup.key, 'GET', '/store-context/place');
    assert.equal(far.body.data.groupId, g(1));
    assert.ok(!JSON.stringify(far.body).includes(DOJO_KEY));
  });
});

describe('GET /v1/store-context/company', () => {
  it('gives the company the place belongs to now, as the backoffice sees it, and follows a place that changes company', async () => {
    const companyId = await companyOf(own());
    const reply = await world.asStore(store.key, 'GET', '/store-context/company');
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(reply.body.data.id, hex(companyId));
    const detail = (await psaGet(`/groups/${g()}/companies/${hex(companyId)}`)).body.data;
    assert.deepEqual(reply.body.data, detail);
    assert.equal(compareCredentials(detail, reply.body.data).length, 0, 'the company has no credential');
    assert.ok(!JSON.stringify(reply.body).includes('UNKNOWN-COMPANY-FIELD-SENTINEL'));
    const moved = (await common().collection('companies').findOne({ _id: { $ne: companyId }, groupId: world.group(0).groupId }))!['_id'] as ObjectId;
    await common().collection('places').updateOne({ _id: own() }, { $set: { companyId: moved } });
    await groupDb().collection('places').updateOne({ _id: own() }, { $set: { companyId: moved } });
    assert.equal((await world.asStore(store.key, 'GET', '/store-context/company')).body.data.id, hex(moved));
  });
});

describe('GET /v1/store-context/group', () => {
  it('gives the group with the keys of its integrations in clear, the temporary legacy key and every catalog, and nothing of the public API, the dealer or the infrastructure', async () => {
    const created = await world.as.call(world.office.cluster.psa, 'POST', `/groups/${g()}/product-favorites`, { name: 'Preferiti' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const reply = await world.asStore(store.key, 'GET', '/store-context/group');
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const group = reply.body.data;
    assert.equal(group.id, g());
    assert.equal(group.legacyApiKey, LEGACY_KEY);
    assert.deepEqual(group.integrations.yellgo, { enabled: true, apiKey: YELLGO_KEY });
    assert.deepEqual(group.integrations.qodeup, { enabled: false, apiKey: null });
    for (const catalog of ['priceLists', 'taxes', 'currencies', 'measureUnits', 'warehouseRules', 'fidelityCardRules', 'cardTypes', 'pointsCollections', 'prizeCatalogues', 'productFavorites', 'promotions']) {
      assert.ok(Array.isArray(group[catalog]), catalog);
    }
    assert.deepEqual(
      group.productFavorites.map((favorite: Document) => favorite['name']),
      ['Preferiti'],
    );
    for (const absent of ['dealerId', 'publicApi', 'dataCluster', 'apiKey', 'databaseHost', 'filesHost', 'unknownGroupField']) {
      assert.ok(!(absent in group), absent);
    }
    const detail = (await psaGet(`/groups/${g()}`)).body.data;
    const { dealerId: _dealer, publicApi: _public, dataCluster: _cluster, integrations: _flags, ...shared } = detail;
    assert.deepEqual(Object.fromEntries(Object.keys(shared).map((key) => [key, group[key]])), shared);
    assert.deepEqual(Object.keys(group).sort(), [...Object.keys(shared), 'integrations', 'legacyApiKey', 'cardTypes', 'pointsCollections', 'prizeCatalogues', 'productFavorites', 'promotions'].sort());
    assert.ok(compareCredentials({ integrations: detail.integrations }, { integrations: group.integrations }).length >= 7, 'every integration key of the detail flag has its key');
    const text = JSON.stringify(reply.body);
    for (const secret of [...NEVER, store.key]) {
      assert.ok(!text.includes(secret), secret);
    }
  });

  it('has a null legacy key and null keys when the document has none or junk', async () => {
    await common().collection('groups').updateOne({ _id: world.group(0).groupId }, { $set: { apiKey: 12, 'settings.integrations': 'junk' } });
    const reply = await world.asStore(store.key, 'GET', '/store-context/group');
    assert.equal(reply.status, 200);
    assert.equal(reply.body.data.legacyApiKey, null);
    assert.equal(reply.body.data.integrations.yellgo.apiKey, null);
    await common().collection('groups').updateOne({ _id: world.group(0).groupId }, { $unset: { apiKey: '' } });
    assert.equal((await world.asStore(store.key, 'GET', '/store-context/group')).body.data.legacyApiKey, null);
  });

  it('is the group of the key and no other', async () => {
    const otherGroup = await world.activate(world.group(1).ownPlaceId, 1);
    const reply = await world.asStore(otherGroup.key, 'GET', '/store-context/group');
    assert.equal(reply.body.data.id, g(1));
    assert.ok(!JSON.stringify(reply.body).includes(LEGACY_KEY));
  });
});

describe('what the backoffice keeps receiving', () => {
  it('has no key, only flags, in the group, the company and the place a user reads, and the legacy key never', async () => {
    const companyId = await companyOf(own());
    for (const actor of [world.office.cluster.psa, world.group(0).sa]) {
      const group = await world.as.call(actor, 'GET', `/groups/${g()}`);
      const company = await world.as.call(actor, 'GET', `/groups/${g()}/companies/${hex(companyId)}`);
      const place = await world.as.call(actor, 'GET', `/groups/${g()}/places/${hex(own())}`);
      assert.deepEqual([group.status, company.status, place.status], [200, 200, 200]);
      const text = JSON.stringify([group.body, company.body, place.body]);
      for (const secret of [LEGACY_KEY, YELLGO_KEY, DOJO_KEY, STRIPE_KEY, DEVICE_USER, DEVICE_PASSWORD, ...NEVER.filter((value) => !value.startsWith('PUBLIC'))]) {
        assert.ok(!text.includes(secret), secret);
      }
      assert.deepEqual(group.body.data.integrations.yellgo, { enabled: true, apiKeySet: true });
      assert.equal(place.body.data.integrations.dojo.apiKeySet, true);
      assert.equal(place.body.data.integrations.dojo.apiKey, undefined);
      assert.equal(place.body.data.devices.items[0].automaticCashPasswordSet, true);
      assert.equal(place.body.data.devices.items[0].automaticCashPassword, undefined);
      assert.equal(group.body.data.legacyApiKey, undefined);
      assert.equal(group.body.data.apiKey, undefined);
    }
  });
});

describe('the refusals', () => {
  const paths = ['/store-context/group', '/store-context/company', '/store-context/place'];

  it('is 401 without a key, with a forged key and with a revoked key, and the same body each time', async () => {
    const bodies = new Set<string>();
    const forged = `${store.key.slice(0, -1)}${store.key.endsWith('A') ? 'B' : 'A'}`;
    await world.as.call(world.office.cluster.psa, 'DELETE', world.keyPath(0, own()));
    for (const path of paths) {
      for (const key of [undefined, forged, store.key]) {
        const reply = await world.asStore(key, 'GET', path, undefined, { 'if-none-match': '*' });
        assert.equal(reply.status, 401, `${path} ${String(key)}`);
        bodies.add(JSON.stringify(reply.body));
      }
    }
    assert.equal(bodies.size, 1);
  });

  it('is 403 to a user, whatever the role', async () => {
    for (const actor of [world.office.cluster.psa, world.group(0).sa, world.group(0).pa]) {
      for (const path of paths) {
        const reply = await world.as.call(actor, 'GET', path);
        assert.deepEqual([reply.status, reply.body.error.code], [403, 'FORBIDDEN'], path);
      }
    }
  });

  it('is 403 STORE_DISABLED while the store is not operational, and answers again when it is', async () => {
    for (const change of [{ status: false }, { expirationDate: new Date(world.office.clock.now() - 1000) }]) {
      await common().collection('places').updateOne({ _id: own() }, { $set: change });
      for (const path of paths) {
        const reply = await world.asStore(store.key, 'GET', path);
        assert.deepEqual([reply.status, reply.body.error.code], [403, 'STORE_DISABLED'], path);
      }
      await common().collection('places').updateOne({ _id: own() }, { $set: { status: true, expirationDate: null } });
    }
    assert.equal((await world.asStore(store.key, 'GET', '/store-context/place')).status, 200);
    await common().collection('companies').updateOne({ _id: await companyOf(own()) }, { $set: { trash: true } });
    assert.equal((await world.asStore(store.key, 'GET', '/store-context/company')).body.error.code, 'STORE_DISABLED');
    await common().collection('companies').updateOne({ _id: await companyOf(own()) }, { $set: { trash: false } });
    await common().collection('groups').updateOne({ _id: world.group(0).groupId }, { $set: { status: false } });
    assert.equal((await world.asStore(store.key, 'GET', '/store-context/group')).body.error.code, 'STORE_DISABLED');
  });

  it('is 404 when the document of the place or the company is gone from the group database', async () => {
    const place = (await groupDb().collection('places').findOne({ _id: own() }))!;
    const company = (await groupDb().collection('companies').findOne({ _id: ownCompany }))!;
    try {
      await groupDb().collection('places').deleteOne({ _id: own() });
      assert.equal((await world.asStore(store.key, 'GET', '/store-context/place')).status, 404);
      await groupDb().collection('companies').deleteOne({ _id: ownCompany });
      assert.equal((await world.asStore(store.key, 'GET', '/store-context/company')).status, 404);
    } finally {
      await groupDb().collection('places').replaceOne({ _id: own() }, place, { upsert: true });
      await groupDb().collection('companies').replaceOne({ _id: ownCompany }, company, { upsert: true });
    }
  });

  it('is 429 over the limit of the key, before anything is read', async () => {
    const small = await openTestDatabases();
    const office = await startStoreWorld(small, { env: { RATE_LIMIT_API_PER_STORE: '2' }, rateLimiter: memoryRateLimiter() });
    try {
      const key = await office.activate(office.group(0).ownPlaceId);
      const statuses: number[] = [];
      for (const path of paths) {
        statuses.push((await office.asStore(key.key, 'GET', path)).status);
      }
      assert.deepEqual(statuses, [200, 200, 429]);
    } finally {
      await office.office.close();
      await small.cleanup();
    }
  });
});

describe('the revalidation', () => {
  it('sends the strong version of the stored document for the place and the company, and a 304 on a match, until the document changes', async () => {
    for (const path of ['/store-context/place', '/store-context/company']) {
      const first = await world.asStore(store.key, 'GET', path);
      const tag = first.headers.get('etag') ?? '';
      assert.match(tag, /^"[A-Za-z0-9_-]{43}"$/, path);
      assert.equal(first.headers.get('cache-control'), 'no-store');
      const again = await world.asStore(store.key, 'GET', path, undefined, { 'if-none-match': tag });
      assert.deepEqual([again.status, again.body], [304, undefined], path);
      assert.equal((await world.asStore(store.key, 'GET', path, undefined, { 'if-none-match': '"other"' })).status, 200);
    }
    const tag = (await world.asStore(store.key, 'GET', '/store-context/place')).headers.get('etag')!;
    await groupDb().collection('places').updateOne({ _id: own() }, { $set: { 'integrations.dojo.apiKey': 'CHANGED-KEY-SENTINEL' } }); // gitleaks:allow (fake test value)
    const changed = await world.asStore(store.key, 'GET', '/store-context/place', undefined, { 'if-none-match': tag });
    assert.equal(changed.status, 200);
    assert.notEqual(changed.headers.get('etag'), tag);
    assert.equal(changed.body.data.integrations.dojo.apiKey, 'CHANGED-KEY-SENTINEL');
  });

  it('sends a keyed tag for the group (not a plain hash of a body that holds credentials), and a 304 on a match, until the group changes', async () => {
    const first = await world.asStore(store.key, 'GET', '/store-context/group');
    const tag = first.headers.get('etag') ?? '';
    assert.match(tag, /^"[A-Za-z0-9_-]{43}"$/);
    assert.notEqual(tag, etagOf(first.body.data), 'not the plain content tag');
    assert.notEqual(tag, `"${createHash('sha256').update(canonicalJson(first.body.data)).digest('base64url')}"`, 'not a plain SHA-256 of the body: it cannot be recomputed from the body alone');
    assert.equal((await world.asStore(store.key, 'GET', '/store-context/group', undefined, { 'if-none-match': tag })).status, 304);
    await common().collection('groups').updateOne({ _id: world.group(0).groupId }, { $set: { 'settings.integrations.yellgo.apiKey': 'CHANGED-KEY-SENTINEL' } }); // gitleaks:allow (fake test value)
    const changed = await world.asStore(store.key, 'GET', '/store-context/group', undefined, { 'if-none-match': tag });
    assert.deepEqual([changed.status, changed.body.data.integrations.yellgo.apiKey], [200, 'CHANGED-KEY-SENTINEL']);
    assert.notEqual(changed.headers.get('etag'), tag);
  });

  it('never answers 304 to a store that is refused, and puts no ETag on an error', async () => {
    const tags = new Map<string, string>();
    for (const path of ['/store-context/group', '/store-context/company', '/store-context/place']) {
      tags.set(path, (await world.asStore(store.key, 'GET', path)).headers.get('etag')!);
    }
    const place = (await groupDb().collection('places').findOne({ _id: own() }))!;
    await common().collection('places').updateOne({ _id: own() }, { $set: { status: false } });
    for (const [path, tag] of tags) {
      const reply = await world.asStore(store.key, 'GET', path, undefined, { 'if-none-match': tag });
      assert.deepEqual([reply.status, reply.headers.get('etag')], [403, null], path);
    }
    await common().collection('places').updateOne({ _id: own() }, { $set: { status: true } });
    await groupDb().collection('places').deleteOne({ _id: own() });
    const gone = await world.asStore(store.key, 'GET', '/store-context/place', undefined, { 'if-none-match': tags.get('/store-context/place')! });
    assert.deepEqual([gone.status, gone.headers.get('etag')], [404, null]);
    await groupDb().collection('places').insertOne(place);
  });
});

describe('the secrets stay out of everything but the response', () => {
  it('are not compressed, not in the logs, not in the activity events, and the store key is not echoed', async () => {
    for (const path of ['/store-context/group', '/store-context/company', '/store-context/place']) {
      const reply = await world.asStore(store.key, 'GET', path, undefined, { 'accept-encoding': 'gzip' });
      assert.equal(reply.status, 200);
      assert.equal(reply.headers.get('content-encoding'), null, path);
    }
    const text = JSON.stringify([world.office.activity.entries, world.office.logEvents]);
    for (const secret of [LEGACY_KEY, YELLGO_KEY, DOJO_KEY, STRIPE_KEY, DEVICE_USER, DEVICE_PASSWORD, store.key]) {
      assert.ok(!text.includes(secret), secret);
    }
  });
});

describe('the repository of the store context', () => {
  it('reads the credentials of a group, and nothing for a group that does not exist', async () => {
    const repository = createStoreContextRepository(ctx.databases);
    assert.equal((await repository.groupCredentials(world.group(0).groupId))!.legacyApiKey, LEGACY_KEY);
    assert.equal(await repository.groupCredentials(new ObjectId()), null);
  });
});

describe('what a store cannot choose or do', () => {
  const paths = ['/store-context/group', '/store-context/company', '/store-context/place'];

  it('has no use for a query: the group, company or place of another tenant, and an operator, change nothing', async () => {
    const other0 = world.group(1);
    const query = `groupId=${g(1)}&placeId=${hex(other0.ownPlaceId)}&companyId=${hex(await companyOf(other0.ownPlaceId))}&groupId[$ne]=x&placeId[$gt]=`;
    for (const path of paths) {
      const plain = await world.asStore(store.key, 'GET', path);
      const queried = await world.asStore(store.key, 'GET', `${path}?${query}`);
      assert.equal(queried.status, 200, path);
      assert.deepEqual(queried.body, plain.body, path);
    }
  });

  it('answers 405 to a write and 404 to a path with an id, never touching anything', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const path of paths) {
        const reply = await world.asStore(store.key, method, path, method === 'DELETE' ? undefined : {});
        assert.equal(reply.status, 405, `${method} ${path}`);
      }
    }
    for (const path of ['/store-context/place', '/store-context/company', '/store-context/group']) {
      assert.equal((await world.asStore(store.key, 'GET', `${path}/${hex(other())}`)).status, 404, path);
    }
    assert.equal((await groupDb().collection('places').findOne({ _id: own() }))!['integrations'].dojo.apiKey, DOJO_KEY);
  });

  it('ends the key when the place goes to the trash: 401 on every route, now and after', async () => {
    await common().collection('places').updateOne({ _id: own() }, { $set: { trash: true } });
    for (const path of [...paths, ...paths]) {
      assert.equal((await world.asStore(store.key, 'GET', path)).status, 401, path);
    }
    assert.equal((await world.activeKey(own())), null);
  });

  it('keeps every secret out of the logs and the events after a 404, a 429 and a 5xx', async () => {
    const place = (await groupDb().collection('places').findOne({ _id: own() }))!;
    await groupDb().collection('places').deleteOne({ _id: own() });
    assert.equal((await world.asStore(store.key, 'GET', '/store-context/place')).status, 404);
    await groupDb().collection('places').insertOne(place);
    const cluster = (await common().collection('groups').findOne({ _id: world.group(0).groupId }))!['dataCluster'];
    await common().collection('groups').updateOne({ _id: world.group(0).groupId }, { $set: { dataCluster: 'no-such-cluster' } });
    const failed = await world.asStore(store.key, 'GET', '/store-context/place');
    await common().collection('groups').updateOne({ _id: world.group(0).groupId }, cluster === undefined ? { $unset: { dataCluster: '' } } : { $set: { dataCluster: cluster } });
    assert.ok(failed.status >= 500, `the failure is a 5xx (${String(failed.status)})`);
    const small = await openTestDatabases();
    const office = await startStoreWorld(small, { env: { RATE_LIMIT_API_PER_STORE: '2' }, rateLimiter: memoryRateLimiter() });
    try {
      const key = await office.activate(office.group(0).ownPlaceId);
      await small.databases.common().collection('groups').updateOne({ _id: office.group(0).groupId }, { $set: { apiKey: LEGACY_KEY } });
      const tag = (await office.asStore(key.key, 'GET', '/store-context/group')).headers.get('etag')!;
      await office.asStore(key.key, 'GET', '/store-context/group');
      const limited = await office.asStore(key.key, 'GET', '/store-context/group', undefined, { 'if-none-match': tag });
      assert.deepEqual([limited.status, limited.headers.get('etag')], [429, null]);
      const smallText = JSON.stringify([office.office.activity.entries, office.office.logEvents]);
      for (const secret of [LEGACY_KEY, key.key]) {
        assert.ok(!smallText.includes(secret), secret);
      }
    } finally {
      await office.office.close();
      await small.cleanup();
    }
    const text = JSON.stringify([world.office.activity.entries, world.office.logEvents]);
    for (const secret of [LEGACY_KEY, YELLGO_KEY, DOJO_KEY, STRIPE_KEY, DEVICE_USER, DEVICE_PASSWORD, store.key]) {
      assert.ok(!text.includes(secret), secret);
    }
  });
});

describe('GET /v1/store-context/countries', () => {
  it('gives the same list as the backoffice, with a weak content tag and a 304 on a match, and ignores the query exactly as the user route does', async () => {
    const reply = await world.asStore(store.key, 'GET', '/store-context/countries');
    const asUser = await psaGet('/countries');
    assert.deepEqual([reply.status, asUser.status], [200, 200]);
    assert.ok(reply.body.data.length > 0 && Array.isArray(reply.body.data[0].areas));
    assert.deepEqual(reply.body, asUser.body);
    const tag = reply.headers.get('etag') ?? '';
    assert.match(tag, /^W\/"[A-Za-z0-9_-]+"$/);
    assert.equal(tag, asUser.headers.get('etag'));
    assert.equal(reply.headers.get('cache-control'), 'no-store');
    assert.deepEqual((await world.asStore(store.key, 'GET', '/store-context/countries', undefined, { 'if-none-match': tag })).status, 304);
    assert.deepEqual((await world.asStore(store.key, 'GET', '/store-context/countries?limit=1&cursor=x&groupId=1')).body, reply.body);
  });

  it('is refused like the other routes of the store: 401, 403 to a user, STORE_DISABLED, 405 to a write, and nothing is recorded', async () => {
    const mark = world.office.activity.entries.length;
    const path = '/store-context/countries';
    assert.equal((await world.asStore(undefined, 'GET', path)).status, 401);
    assert.equal((await world.asStore('fc_sk_nothing', 'GET', path)).status, 401);
    assert.equal((await world.as.call(world.office.cluster.psa, 'GET', path)).body.error.code, 'FORBIDDEN');
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal((await world.asStore(store.key, method, path, method === 'DELETE' ? undefined : {})).status, 405, method);
    }
    await common().collection('places').updateOne({ _id: own() }, { $set: { status: false } });
    assert.equal((await world.asStore(store.key, 'GET', path)).body.error.code, 'STORE_DISABLED');
    await common().collection('places').updateOne({ _id: own() }, { $set: { status: true } });
    assert.equal((await world.asStore(store.key, 'GET', path)).status, 200);
    assert.deepEqual(world.office.activity.entries.slice(mark), []);
  });

  it('is the only thing of the countries a store reads: the list of the backoffice, the detail and the writes are 403', async () => {
    for (const [method, path, body] of [
      ['GET', '/countries'],
      ['GET', '/countries/IT'],
      ['POST', '/countries', { code: 'ZZ', name: 'Zed' }],
      ['PATCH', '/countries/IT', { name: 'x' }],
      ['DELETE', '/countries/IT'],
      ['POST', '/countries/IT/areas', { code: 'ZZ', name: 'Zed' }],
      ['PATCH', '/countries/IT/areas/MI', { name: 'x' }],
      ['DELETE', '/countries/IT/areas/MI'],
    ] as Array<[string, string, unknown?]>) {
      const reply = await world.asStore(store.key, method, path, body);
      assert.deepEqual([reply.status, reply.body.error.code], [403, 'FORBIDDEN'], `${method} ${path}`);
    }
    assert.equal(await common().collection('countries').countDocuments({ code: 'ZZ' }), 0);
  });

  it('is 429 over the limit of the key', async () => {
    const small = await openTestDatabases();
    const office = await startStoreWorld(small, { env: { RATE_LIMIT_API_PER_STORE: '1' }, rateLimiter: memoryRateLimiter() });
    try {
      const key = await office.activate(office.group(0).ownPlaceId);
      assert.equal((await office.asStore(key.key, 'GET', '/store-context/countries')).status, 200);
      assert.equal((await office.asStore(key.key, 'GET', '/store-context/countries')).status, 429);
    } finally {
      await office.office.close();
      await small.cleanup();
    }
  });
});

describe('GET /v1/store-context/users', () => {
  const PIN = '73914'; // gitleaks:allow (fake test value)
  const PASSWORD = 'USER-PASSWORD-SENTINEL'; // gitleaks:allow (fake test value)
  const base = (n: number, role: string, extra: Document = {}): Document =>
    legacyUser(n, { groupId: world.group(0).groupId, role, dealerId: world.group(0).dealerId, pin: PIN, password: PASSWORD, tokens: ['TOKEN-USER-SENTINEL'], userName: `store-user-${String(n)}`, ...extra }); // gitleaks:allow (fake test value)
  const id = (n: number): ObjectId => fixtureId('user', n);
  const other0 = () => world.group(0).otherPlaceId;
  let otherCompany: ObjectId;
  /** The users planted: who is returned and who is not. */
  const planted = (): Document[] => [
    base(900, 'E', { placeId: own(), placesId: [own()] }),
    base(901, 'PA', { placeId: other0(), placesId: [other0(), own()] }),
    base(902, 'PA', { placeId: other0(), placesId: [other0()] }),
    base(903, 'E', { placeId: other0(), placesId: [other0()] }),
    base(904, 'CA', { companyId: ownCompany, placeId: null, placesId: [] }),
    base(905, 'CA', { companyId: otherCompany, placeId: null, placesId: [] }),
    base(906, 'SA'),
    base(907, 'E', { placeId: own(), placesId: [own()], status: false }),
    base(908, 'PA', { placeId: own(), placesId: [own()], trash: true }),
    base(909, 'PSA', { groupId: null, placeId: own(), placesId: [own()] }),
    base(910, 'D', { groupId: null, placeId: own(), placesId: [own()] }),
    base(911, 'E', { groupId: world.group(1).groupId, placeId: own(), placesId: [own()] }),
    base(912, 'E', { role: null, placeId: own(), placesId: [own()] }),
    base(913, 'E', { placeId: own(), placesId: [own()], pin: null }),
    base(914, 'E', { placeId: own(), placesId: [own()], pin: 5 }),
    base(915, 'weird', { placeId: own(), placesId: [own()] }),
    base(916, 'SA', { groupId: world.group(1).groupId }),
    base(917, 'PA', { placeId: null, placesId: 'single' }),
  ];
  const seeded = () => [world.group(0).sa, world.group(0).ca, world.group(0).pa];
  const expectedIds = (): string[] => [...seeded(), id(900), id(901), id(904), id(906), id(907), id(912), id(913), id(914)].map(hex).sort();
  const idsOf = (reply: { body: { data: Array<{ id: string }> } }): string[] => reply.body.data.map((user) => user.id);

  beforeEach(async () => {
    otherCompany = (await common().collection('companies').findOne({ _id: { $ne: ownCompany }, groupId: world.group(0).groupId }))!['_id'] as ObjectId;
    await common().collection('users').deleteMany({ _id: { $in: planted().map((user) => user['_id'] as ObjectId) } });
    await common().collection('users').insertMany(planted());
  });

  it('gives exactly the users involved in the place: its E and PA, the CA of its company, the SA of the group; disabled ones too, never a PSA, a D, a trashed one, another group or another place', async () => {
    const reply = await world.asStore(store.key, 'GET', '/store-context/users?limit=200');
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.deepEqual(idsOf(reply).sort(), expectedIds());
    assert.deepEqual(reply.body.page, { limit: 200, next: null });
    const byId = new Map<string, Document>(reply.body.data.map((user: Document) => [user['id'], user]));
    assert.equal(byId.get(hex(id(907)))!['status'], 'disabled');
    assert.equal(byId.get(hex(id(912)))!['role'], 'E');
  });

  it('has the PIN in clear when it is set and null when it is missing or junk, and nothing of the credentials anywhere', async () => {
    const reply = await world.asStore(store.key, 'GET', '/store-context/users?limit=200');
    const byId = new Map<string, Document>(reply.body.data.map((user: Document) => [user['id'], user]));
    assert.equal(byId.get(hex(id(900)))!['pin'], PIN);
    assert.equal(byId.get(hex(id(913)))!['pin'], null);
    assert.equal(byId.get(hex(id(914)))!['pin'], null);
    for (const user of reply.body.data) {
      assert.ok(!('pinSet' in user) && !('password' in user) && !('avatar' in user) && !('dealerId' in user), user.id);
    }
    const text = JSON.stringify(reply.body);
    for (const secret of [PASSWORD, 'TOKEN-USER-SENTINEL', store.key]) {
      assert.ok(!text.includes(secret), secret);
    }
  });

  it('is the representation of the backoffice detail, but for the PIN, the picture and the dealer', async () => {
    const detail = (await psaGet(`/groups/${g()}/users/${hex(id(900))}`)).body.data;
    const { pinSet, avatar: _avatar, dealerId: _dealer, ...shared } = detail;
    assert.equal(pinSet, true);
    const mine = (await world.asStore(store.key, 'GET', '/store-context/users?limit=200')).body.data.find((user: Document) => user['id'] === hex(id(900)));
    const { pin, ...rest } = mine;
    assert.equal(pin, PIN);
    assert.deepEqual(rest, shared);
  });

  it('follows the company of the place: when the place moves, the CA of the old company goes out and the one of the new comes in', async () => {
    await common().collection('places').updateOne({ _id: own() }, { $set: { companyId: otherCompany } });
    await groupDb().collection('places').updateOne({ _id: own() }, { $set: { companyId: otherCompany } });
    const ids = idsOf(await world.asStore(store.key, 'GET', '/store-context/users?limit=200'));
    assert.ok(ids.includes(hex(id(905))) && !ids.includes(hex(id(904))));
    const event = world.office.activity.entries.filter((entry) => entry.action === 'store.configurationRead' && entry.metadata?.['resource'] === 'users').at(-1)!;
    assert.equal(event.metadata?.['companyId'], hex(otherCompany), 'the audit names the company the filter used, not the one of the principal');
  });

  it('is only the users of the key: two stores of the same group, and of two groups, never see each other', async () => {
    const second = await world.activate(other());
    const theirs = idsOf(await world.asStore(second.key, 'GET', '/store-context/users?limit=200'));
    assert.ok(theirs.includes(hex(id(902))) && theirs.includes(hex(id(903))) && !theirs.includes(hex(id(900))));
    const far = await world.activate(world.group(1).ownPlaceId, 1);
    const farIds = idsOf(await world.asStore(far.key, 'GET', '/store-context/users?limit=200'));
    assert.ok(farIds.includes(hex(id(916))) && !farIds.includes(hex(id(900))) && !farIds.includes(hex(world.group(0).sa)));
  });

  it('pages by cursor in a stable order, and refuses a bad cursor and any other parameter', async () => {
    const all = idsOf(await world.asStore(store.key, 'GET', '/store-context/users?limit=200'));
    const collected: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const reply = await world.asStore(store.key, 'GET', `/store-context/users?limit=3${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`);
      assert.equal(reply.status, 200);
      assert.ok(reply.body.data.length <= 3 && reply.body.page.limit === 3);
      collected.push(...idsOf(reply));
      cursor = reply.body.page.next;
      pages += 1;
    } while (cursor !== null);
    assert.ok(pages >= 3);
    assert.deepEqual(collected, all);
    assert.equal((await world.asStore(store.key, 'GET', '/store-context/users')).body.page.limit, 50);
    for (const query of ['cursor=not-a-cursor', 'limit=0', 'limit=201', 'limit=x', 'sort=-username', 'q=a', 'role=SA', 'status=active', 'groupId=1']) {
      const reply = await world.asStore(store.key, 'GET', `/store-context/users?${query}`);
      assert.equal(reply.status, 422, query);
    }
  });

  it('has a keyed strong tag per page, not derivable from the body, a 304 on a match and a new tag when a PIN changes', async () => {
    const first = await world.asStore(store.key, 'GET', '/store-context/users?limit=200');
    const tag = first.headers.get('etag') ?? '';
    assert.match(tag, /^"[A-Za-z0-9_-]{43}"$/);
    const body = { data: first.body.data, page: first.body.page };
    assert.notEqual(tag, etagOf(body));
    assert.notEqual(tag, `"${createHash('sha256').update(canonicalJson(body)).digest('base64url')}"`);
    assert.equal(first.headers.get('cache-control'), 'no-store');
    assert.equal(first.headers.get('content-encoding'), null);
    assert.equal((await world.asStore(store.key, 'GET', '/store-context/users?limit=200', undefined, { 'if-none-match': tag })).status, 304);
    const otherPage = await world.asStore(store.key, 'GET', '/store-context/users?limit=2');
    assert.notEqual(otherPage.headers.get('etag'), tag);
    await common().collection('users').updateOne({ _id: id(900) }, { $set: { pin: '11111' } }); // gitleaks:allow (fake test value)
    const changed = await world.asStore(store.key, 'GET', '/store-context/users?limit=200', undefined, { 'if-none-match': tag });
    assert.deepEqual([changed.status, changed.headers.get('etag') !== tag], [200, true]);
  });

  it('is refused like every route of the store, and never answers a 304 to a refusal', async () => {
    const path = '/store-context/users';
    const tag = (await world.asStore(store.key, 'GET', path)).headers.get('etag')!;
    assert.equal((await world.asStore(undefined, 'GET', path)).status, 401);
    assert.equal((await world.as.call(world.office.cluster.psa, 'GET', path)).body.error.code, 'FORBIDDEN');
    assert.equal((await world.as.call(world.group(0).sa, 'GET', path)).body.error.code, 'FORBIDDEN');
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal((await world.asStore(store.key, method, path, method === 'DELETE' ? undefined : {})).status, 405, method);
    }
    await common().collection('places').updateOne({ _id: own() }, { $set: { status: false } });
    const disabled = await world.asStore(store.key, 'GET', path, undefined, { 'if-none-match': tag });
    assert.deepEqual([disabled.status, disabled.body.error.code, disabled.headers.get('etag')], [403, 'STORE_DISABLED', null]);
    await common().collection('places').updateOne({ _id: own() }, { $set: { status: true } });
    await world.as.call(world.office.cluster.psa, 'DELETE', world.keyPath(0, own()));
    assert.equal((await world.asStore(store.key, 'GET', path, undefined, { 'if-none-match': tag })).status, 401);
  });

  it('never returns a user outside the lawful set, whatever the cursor: forged ones are 422 or a subset, operator-shaped parameters are 422, other credentials are 401', async () => {
    const lawful = new Set(expectedIds());
    const real = (await world.asStore(store.key, 'GET', '/store-context/users?limit=1')).body.page.next as string;
    const decoded = JSON.parse(Buffer.from(real, 'base64url').toString('utf8')) as Record<string, unknown>;
    const forge = (changes: Record<string, unknown>): string => Buffer.from(JSON.stringify({ ...decoded, ...changes }), 'utf8').toString('base64url');
    const forged = [forge({ id: hex(new ObjectId()) }), forge({ id: hex(id(909)), value: 'aaa' }), forge({ id: hex(id(910)), value: null }), forge({ v: 99 }), forge({ id: 'x' }), forge({ value: { $ne: 1 } }), Buffer.from('{"v":1,"s":"createdAt","value":1,"id":"010000000000000000000001"}').toString('base64url')];
    for (const cursor of forged) {
      const reply = await world.asStore(store.key, 'GET', `/store-context/users?limit=200&cursor=${cursor}`);
      assert.ok([200, 422].includes(reply.status), `${String(reply.status)} ${cursor}`);
      if (reply.status === 200) {
        assert.ok(idsOf(reply).every((userId) => lawful.has(userId)), 'only lawful users');
      }
    }
    for (const query of ['cursor[$ne]=1', 'limit[$gt]=0', 'limit[]=1', 'cursor[]=a&cursor[]=b']) {
      assert.equal((await world.asStore(store.key, 'GET', `/store-context/users?${query}`)).status, 422, query);
    }
    for (const credential of [`fc_pk_${'a'.repeat(43)}`, `fc_sk_${'a'.repeat(43)}`]) {
      assert.equal((await world.asStore(credential, 'GET', '/store-context/users')).status, 401);
    }
  });

  it('classifies the odd documents: a group id or a company id stored as text grants nothing, a lone scalar placeId does', async () => {
    const odd = [
      base(920, 'E', { groupId: hex(world.group(0).groupId), placeId: own(), placesId: [own()] }),
      base(921, 'CA', { companyId: hex(ownCompany), placeId: null, placesId: [] }),
      base(922, 'E', { placeId: own(), placesId: undefined }),
    ];
    await common().collection('users').deleteMany({ _id: { $in: odd.map((user) => user['_id'] as ObjectId) } });
    await common().collection('users').insertMany(odd);
    try {
      const ids = idsOf(await world.asStore(store.key, 'GET', '/store-context/users?limit=200'));
      assert.ok(!ids.includes(hex(id(920))), 'a group id stored as text: excluded');
      assert.ok(!ids.includes(hex(id(921))), 'a company id stored as text: excluded');
      assert.ok(ids.includes(hex(id(922))), 'only the scalar placeId: included');
    } finally {
      await common().collection('users').deleteMany({ _id: { $in: odd.map((user) => user['_id'] as ObjectId) } });
    }
  });

  it('is STORE_DISABLED while the group is suspended', async () => {
    await common().collection('groups').updateOne({ _id: world.group(0).groupId }, { $set: { status: false } });
    assert.equal((await world.asStore(store.key, 'GET', '/store-context/users')).body.error.code, 'STORE_DISABLED');
  });

  it('is 429 over the limit of the key', async () => {
    const small = await openTestDatabases();
    const office = await startStoreWorld(small, { env: { RATE_LIMIT_API_PER_STORE: '1' }, rateLimiter: memoryRateLimiter() });
    try {
      const key = await office.activate(office.group(0).ownPlaceId);
      assert.equal((await office.asStore(key.key, 'GET', '/store-context/users')).status, 200);
      assert.equal((await office.asStore(key.key, 'GET', '/store-context/users')).status, 429);
    } finally {
      await office.office.close();
      await small.cleanup();
    }
  });

  it('is 404 when the place is gone, and has no use for another place or company in the query', async () => {
    const plain = await world.asStore(store.key, 'GET', '/store-context/users?limit=200');
    const place = (await groupDb().collection('places').findOne({ _id: own() }))!;
    try {
      await groupDb().collection('places').deleteOne({ _id: own() });
      assert.equal((await world.asStore(store.key, 'GET', '/store-context/users')).status, 404);
      await groupDb().collection('places').updateOne({ _id: own() }, { $set: { companyId: 'x' } }, { upsert: true });
      assert.equal((await world.asStore(store.key, 'GET', '/store-context/users')).status, 404);
    } finally {
      await groupDb().collection('places').replaceOne({ _id: own() }, place, { upsert: true });
    }
    assert.deepEqual((await world.asStore(store.key, 'GET', '/store-context/users?limit=200')).body, plain.body);
  });

  it('is never a PIN in the backoffice: the lists and the details of the users show only whether it is set', async () => {
    for (const path of [`/groups/${g()}/users?limit=200`, `/groups/${g()}/users/${hex(id(900))}`, `/users/${hex(id(900))}`]) {
      const reply = await psaGet(path);
      assert.equal(reply.status === 200 || reply.status === 404, true, path);
      const text = JSON.stringify(reply.body);
      assert.ok(!text.includes(PIN) && !text.includes('"pin"') && !text.includes(PASSWORD), path);
    }
    assert.equal((await psaGet(`/groups/${g()}/users/${hex(id(900))}`)).body.data.pinSet, true);
  });

  it('writes the audit event once an hour for `users`, apart from the group and the place, and never on a 304 or an error, nor a PIN anywhere', async () => {
    const events = () => world.office.activity.entries.filter((entry) => entry.action === 'store.configurationRead');
    const before = events().length;
    const first = await world.asStore(store.key, 'GET', '/store-context/users');
    await world.asStore(store.key, 'GET', '/store-context/users?limit=2');
    assert.equal(events().length - before, 1);
    assert.deepEqual(events()[before]!.metadata, { resource: 'users', companyId: hex(ownCompany), placeId: hex(own()) });
    await world.asStore(store.key, 'GET', '/store-context/group');
    await world.asStore(store.key, 'GET', '/store-context/place');
    assert.equal(events().length - before, 3, 'the group and the place are apart');
    limiter.reset();
    await world.asStore(store.key, 'GET', '/store-context/users', undefined, { 'if-none-match': first.headers.get('etag')! });
    await world.asStore(store.key, 'GET', '/store-context/users?cursor=bad');
    await world.asStore(undefined, 'GET', '/store-context/users');
    assert.equal(events().length - before, 3, 'a 304, a 422 and a 401 write nothing');
    await world.asStore(store.key, 'GET', '/store-context/users');
    assert.equal(events().length - before, 4, 'a new hour, a new event');
    const text = JSON.stringify([world.office.activity.entries, world.office.logEvents]);
    for (const secret of [PIN, PASSWORD, 'TOKEN-USER-SENTINEL', store.key]) {
      assert.ok(!text.includes(secret), secret);
    }
  });
});

describe('the record of the reads that carry credentials', () => {
  const events = () => world.office.activity.entries.filter((entry) => entry.action === 'store.configurationRead');
  const read = (path: string, key = store.key, headers: Record<string, string> = {}) => world.asStore(key, 'GET', path, undefined, headers);

  it('writes one security event on the first 200 of the group and of the place, with the ids and the resource and no value', async () => {
    const before = events().length;
    const group = await read('/store-context/group');
    const place = await read('/store-context/place');
    assert.deepEqual([group.status, place.status], [200, 200]);
    const [first, second, ...rest] = events().slice(before);
    assert.equal(rest.length, 0);
    for (const [event, resource] of [[first!, 'group'], [second!, 'place']] as const) {
      assert.deepEqual([event.category, event.action, event.outcome], ['security', 'store.configurationRead', 'success']);
      assert.deepEqual(event.actor, { kind: 'store', id: new ObjectId(store.keyId) });
      assert.deepEqual(event.groupId, world.group(0).groupId);
      assert.deepEqual(event.resource, { type: 'storeKey', id: store.keyId });
      assert.deepEqual(event.metadata, { resource, companyId: hex(ownCompany), placeId: hex(own()) });
      assert.ok(typeof event.requestId === 'string' && event.requestId !== '');
      assert.ok(typeof event.ip === 'string');
      const text = JSON.stringify(event);
      for (const secret of [LEGACY_KEY, YELLGO_KEY, DOJO_KEY, STRIPE_KEY, DEVICE_USER, DEVICE_PASSWORD, store.key, group.headers.get('etag')!, place.headers.get('etag')!]) {
        assert.ok(!text.includes(secret), secret);
      }
    }
  });

  it('throttles to one an hour for a key and a resource: group and place apart, two keys apart, and a new one when the hour is over', async () => {
    const before = events().length;
    for (let i = 0; i < 3; i += 1) {
      await read('/store-context/group');
    }
    assert.equal(events().length - before, 1);
    await read('/store-context/place');
    assert.equal(events().length - before, 2, 'the place is another resource');
    await read('/store-context/place');
    assert.equal(events().length - before, 2);
    const second = await world.activate(other());
    await read('/store-context/group', second.key);
    assert.equal(events().length - before, 3, 'another key is another event');
    assert.equal(events().at(-1)!.actor.kind === 'store' && hex(events().at(-1)!.actor.id as ObjectId), second.keyId);
    limiter.reset();
    await read('/store-context/group');
    assert.equal(events().length - before, 4, 'the counter of the hour is gone: a new event');
    assert.ok(limiter.calls.filter((call) => call.bucket === 'storeConfigurationRead:key').every((call) => call.limit === 1));
  });

  it('writes nothing on a 304, on the company, on the context, or on any refusal', async () => {
    const tag = (await read('/store-context/group')).headers.get('etag')!;
    const placeTag = (await read('/store-context/place')).headers.get('etag')!;
    limiter.reset();
    const before = events().length;
    assert.equal((await read('/store-context/group', store.key, { 'if-none-match': tag })).status, 304);
    assert.equal((await read('/store-context/place', store.key, { 'if-none-match': placeTag })).status, 304);
    assert.equal((await read('/store-context/company')).status, 200);
    assert.equal((await read('/store-context')).status, 200);
    assert.equal((await read('/store-context/group', 'fc_sk_nothing')).status, 401);
    assert.equal((await world.as.call(world.office.cluster.psa, 'GET', '/store-context/place')).status, 403);
    await common().collection('places').updateOne({ _id: own() }, { $set: { status: false } });
    assert.equal((await read('/store-context/place')).status, 403);
    await common().collection('places').updateOne({ _id: own() }, { $set: { status: true } });
    const place = (await groupDb().collection('places').findOne({ _id: own() }))!;
    await groupDb().collection('places').deleteOne({ _id: own() });
    assert.equal((await read('/store-context/place')).status, 404);
    await groupDb().collection('places').insertOne(place);
    assert.equal(events().length - before, 0);
    const small = await openTestDatabases();
    const office = await startStoreWorld(small, { env: { RATE_LIMIT_API_PER_STORE: '1' }, rateLimiter: memoryRateLimiter() });
    try {
      const key = await office.activate(office.group(0).ownPlaceId);
      await office.asStore(key.key, 'GET', '/store-context');
      assert.equal((await office.asStore(key.key, 'GET', '/store-context/group')).status, 429);
      assert.equal(office.office.activity.entries.filter((entry) => entry.action === 'store.configurationRead').length, 0);
    } finally {
      await office.office.close();
      await small.cleanup();
    }
  });
});

// Last of the file: it moves the clock of the application past the life of an access token, and the tests above log in as the PSA.
describe('the credentials of the other surfaces', () => {
  it('is 401 for a public API key and for an access token that has expired', async () => {
    const paths = ['/store-context/group', '/store-context/company', '/store-context/place'];
    const token = await world.as.tokenOf(world.office.cluster.psa);
    world.office.clock.advance(24 * 60 * 60 * 1000);
    for (const credential of [`fc_pk_${'a'.repeat(43)}`, token]) {
      for (const path of paths) {
        const reply = await world.asStore(credential, 'GET', path);
        assert.equal(reply.status, 401, `${path} ${credential.slice(0, 6)}`);
      }
    }
  });
});
