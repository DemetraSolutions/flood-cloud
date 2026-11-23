import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
