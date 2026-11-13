import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Double, ObjectId } from 'mongodb';
import type { Db, Document } from 'mongodb';
import type { Databases } from '../../src/db/databases.ts';
import { companiesPlacesWriter, MAX_GROUP_PLACES } from '../../src/shared/legacy-write/companies-places.writer.ts';
import type { CompaniesPlacesWriter, EntityKind, WriteOutcome } from '../../src/shared/legacy-write/companies-places.writer.ts';
import { CrossClusterWriteError, InvalidWriteInputError } from '../../src/shared/legacy-write/errors.ts';
import { versionOf } from '../../src/shared/legacy-write/version.ts';
import type { GroupAccess } from '../../src/shared/security/scope/group-access.ts';
import { EXACT_TYPES, expectedCopy, sameDocument } from '../../src/shared/legacy-write/copy-rule.ts';
import { DEFAULT_BLOCK_LIMITS } from '../../src/tools/sync-copies/reconcile.ts';
import { syncCopies } from '../../src/tools/sync-copies/sync.ts';
import type { SyncOptions } from '../../src/tools/sync-copies/sync.ts';
import { accessFor } from '../helpers/group-access.ts';
import { fixtureId, legacyCompany, legacyGroup, legacyPlace } from '../helpers/legacy-fixtures.ts';
import { differences, missingId, snapshotOf, withHooks } from '../helpers/legacy-write.ts';
import { openTestClusters, openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { principalOf } from '../helpers/principal.ts';

const G1 = fixtureId('group', 1);
const G2 = fixtureId('group', 2);
const C = (n: number): ObjectId => fixtureId('company', n);
const P = (n: number): ObjectId => fixtureId('place', n);
const boom = async (): Promise<never> => {
  throw new Error('boom');
};

const RWG = {
  status: true,
  category: 'restaurant',
  name: 'Fixture RWG',
  telephone: '+39000',
  url: 'https://example.test',
  geo: { latitude: 41.9, longitude: 12.5, address: { streetAddress: 'Via 1', locality: 'Roma', postalCode: '00100', country: 'IT' } },
};

let ctx: TestDatabases;
let tick = 0;
const clock = (): Date => new Date(Date.UTC(2026, 10, 13, 10, 0, tick++));
const principal = principalOf('PSA');
let access: GroupAccess;

const common = (): Db => ctx.databases.common();
const groupDb = (n = 1): Db => ctx.databases.group(n === 1 ? G1 : G2, 'cluster0');
const writerOn = (databases: Databases = ctx.databases): CompaniesPlacesWriter => companiesPlacesWriter(principal, access, databases, { now: clock });
const names = (): string[] => [`${ctx.prefix}development_common`, `${ctx.prefix}development_${G1.toHexString()}`, `${ctx.prefix}development_${G2.toHexString()}`];
const snapshot = (): Promise<Record<string, Document[]>> => snapshotOf(ctx.client, names());

const original = async (kind: EntityKind, id: ObjectId, group = 1): Promise<Document | null> => groupDb(group).collection(kind).findOne({ _id: id }, { ...EXACT_TYPES });
const copyOf = async (kind: EntityKind, id: ObjectId): Promise<Document | null> => common().collection(kind).findOne({ _id: id }, { ...EXACT_TYPES });
const must = (document: Document | null): Document => {
  assert.ok(document !== null, 'document expected');
  return document;
};
const written = (outcome: WriteOutcome): { id: ObjectId; version: string } => {
  assert.equal(outcome.outcome, 'written');
  return outcome as { id: ObjectId; version: string; outcome: 'written' };
};

/** The copy is exactly the original with the group id: same BSON bytes. */
async function assertMirrored(kind: EntityKind, id: ObjectId, group = G1): Promise<void> {
  const source = must(await original(kind, id, group.equals(G1) ? 1 : 2));
  assert.ok(sameDocument(expectedCopy(source, group), must(await copyOf(kind, id))), `copy of ${kind} ${id.toHexString()} is not identical`);
}

/** `groups.places` of the group is the full list `[{ _id, insertDate }]` of the places of its database, trashed included. */
async function assertGroupPlaces(): Promise<void> {
  const expected = await groupDb().collection('places').find({}, { projection: { insertDate: 1 } }).sort({ _id: 1 }).toArray();
  const group = must(await common().collection('groups').findOne({ _id: G1 }, { ...EXACT_TYPES }));
  assert.ok(sameDocument({ places: group['places'] }, { places: expected }), 'groups.places is not the list of the places');
  assert.ok(expected.every((entry) => Object.keys(entry).join() === '_id,insertDate'));
}

const feed = (group: ObjectId, placeId: ObjectId): Promise<Document | null> => common().collection('reserve_with_google').findOne({ groupId: group, placeId });
const SENTINEL = [{ _id: new ObjectId(), insertDate: new Date('2020-01-01T00:00:00.000Z') }];
const setSentinel = (): Promise<unknown> => common().collection('groups').updateOne({ _id: G1 }, { $set: { places: SENTINEL } });
const groupPlaces = async (): Promise<unknown> => (await common().collection('groups').findOne({ _id: G1 }))?.['places'];

function options(): SyncOptions {
  return { apply: true, groupId: null, runId: new ObjectId(), now: () => new Date(), limits: DEFAULT_BLOCK_LIMITS, logger: { error: () => undefined }, onGroupError: (_hex, error) => { throw error; } };
}

/** Group 1: an active company, a trashed one, a rich place and a place trashed by the legacy (null registry data). Group 2: one company and one place. */
async function seed(): Promise<void> {
  await common().collection('groups').insertMany([legacyGroup(1), legacyGroup(2)]);
  await groupDb().collection('companies').insertMany([
    legacyCompany(1, G1, { futureKey: { nested: [1, 2] }, settings: { global: { discountLines: true } } }),
    legacyCompany(2, G1, { trash: true }),
  ]);
  await groupDb().collection('places').insertMany([
    legacyPlace(1, G1, C(1), {
      devices: [
        { type: 'cash', name: 'Cassa 1', info: { os: 'x', battery: new Double(80) } },
        { type: 'printer', name: 'Stampante', info: null },
      ],
      rooms: [{ id: 'r1', name: 'Sala', tables: [{ id: 't1', name: '1' }, { id: 't2', name: '2' }] }],
      storages: [{ id: fixtureId('place', 701), name: 'Deposito 1', cash: true, ecommerce: false }],
      roomsSettings: { reservation: { status: true, suspendedToday: true } },
      integrations: { reserveWithGoogle: RWG, dojo: { status: true, apiKey: 'fixture-integration-secret' } },
      general: { logs: true, chargeDocumentQt: new Double(2) },
      server: { ip: '10.0.0.1', port: new Double(8080) },
      futureBlock: { nested: [1, { a: 1 }] },
    }),
    legacyPlace(2, G1, C(1), { trash: true, address: null, postcode: null, city: null, contact: null, email: null, telephone: null }),
  ]);
  await groupDb(2).collection('companies').insertOne(legacyCompany(3, G2));
  await groupDb(2).collection('places').insertOne(legacyPlace(3, G2, C(3)));
  // The initial load of the copies, as the real system does it.
  await syncCopies(ctx.databases, options());
  // The feed: the record of place 1, and a record of another group that has the same place id.
  await common().collection('reserve_with_google').insertMany([
    { groupId: G1, companyId: C(1), placeId: P(1), category: 'restaurant', name: 'stale', telephone: null, url: null, geo: { latitude: 1, longitude: 1, address: { streetAddress: 'a', locality: 'b', postalCode: 'c', country: 'd' } } },
    { groupId: G2, companyId: C(3), placeId: P(1), category: 'bar', name: 'other group', telephone: null, url: null, geo: { latitude: 1, longitude: 1, address: { streetAddress: 'a', locality: 'b', postalCode: 'c', country: 'd' } } },
  ]);
  await common().collection('groups').updateOne({ _id: G1 }, { $set: { places: [] } });
}

beforeEach(async () => {
  tick = 0;
  ctx = await openTestDatabases();
  await seed();
  access = (await accessFor(principal, G1))!;
});

afterEach(async () => {
  await ctx.cleanup();
});

describe('companies and places writer: creation', () => {
  it('creates a company in the legacy format, with its identical copy, and leaves groups.places alone', async () => {
    await setSentinel();
    const outcome = written(await writerOn().createCompany({ name: 'New Co', code: 'IT01234567890', countryCode: 'IT' }));
    const stored = must(await original('companies', outcome.id));
    assert.deepEqual([stored['groupId'], stored['name'], stored['code'], stored['trash'], stored['status'], stored['invoicesPSValues']], [G1, 'New Co', 'IT01234567890', false, true, []]);
    assert.ok(stored['settings'] !== null && typeof stored['settings'] === 'object' && 'global' in stored['settings']);
    assert.ok(stored['updateDate'] instanceof Date && (stored['insertDate'] as Date).getTime() === (stored['updateDate'] as Date).getTime());
    assert.equal(outcome.version, versionOf('companies', stored));
    assert.equal(await writerOn().currentVersion('companies', outcome.id), outcome.version);
    await assertMirrored('companies', outcome.id);
    assert.deepEqual(await groupPlaces(), SENTINEL);
    assert.equal(await common().collection('companies').countDocuments({ groupId: G1 }), 3);
  });

  it('creates a place with the complete template, one cash storage, the copy, and recalculates groups.places with the trashed ones', async () => {
    const outcome = written(await writerOn().createPlace({ name: 'New Shop', companyId: C(1), timezone: 'Europe/Rome', storageName: 'Magazzino' }));
    const stored = must(await original('places', outcome.id));
    assert.deepEqual([stored['groupId'], stored['companyId'], stored['trash'], stored['status'], stored['timezone']], [G1, C(1), false, true, 'Europe/Rome']);
    const storages = stored['storages'] as Array<Document>;
    assert.equal(storages.length, 1);
    assert.ok(storages[0]!['id'] instanceof ObjectId);
    assert.deepEqual([storages[0]!['name'], storages[0]!['cash'], storages[0]!['ecommerce']], ['Magazzino', true, false]);
    assert.equal(Object.keys((stored['openingTime'] as { weekGeneric: object }).weekGeneric).length, 7);
    assert.equal(outcome.version, versionOf('places', stored));
    await assertMirrored('places', outcome.id);
    await assertGroupPlaces();
    assert.equal(((await groupPlaces()) as unknown[]).length, 3);
    assert.ok(((await groupPlaces()) as Array<{ _id: ObjectId }>).some((entry) => entry._id.equals(P(2))), 'the trashed place stays in the list');
  });

  it('does not touch the feed when it creates a place', async () => {
    const before = await common().collection('reserve_with_google').find({}).sort({ _id: 1 }).toArray();
    written(await writerOn().createPlace({ name: 'New Shop', companyId: C(1) }));
    assert.deepEqual(await common().collection('reserve_with_google').find({}).sort({ _id: 1 }).toArray(), before);
  });

  it('refuses a place whose company does not exist, is in another group or is in the trash, and writes nothing', async () => {
    const before = await snapshot();
    for (const companyId of [missingId(), C(3), C(2)]) {
      assert.deepEqual(await writerOn().createPlace({ name: 'x', companyId }), { outcome: 'companyNotFound' });
    }
    assert.deepEqual(await snapshot(), before);
  });

  it('takes the group from the access, never from the input, and refuses unknown fields before writing anything', async () => {
    const before = await snapshot();
    await assert.rejects(() => writerOn().createCompany({ name: 'x', groupId: G2 } as never), InvalidWriteInputError);
    await assert.rejects(() => writerOn().createPlace({ name: 'x', companyId: C(1), integrations: {} } as never), InvalidWriteInputError);
    await assert.rejects(() => writerOn().createPlace({ name: 'x' } as never), InvalidWriteInputError);
    assert.deepEqual(await snapshot(), before);
  });

  it('uses the system clock when no clock is given', async () => {
    const before = Date.now();
    const outcome = written(await companiesPlacesWriter(principal, access, ctx.databases).createCompany({ name: 'Clock' }));
    const stored = must(await original('companies', outcome.id));
    assert.ok((stored['updateDate'] as Date).getTime() >= before - 1000 && (stored['updateDate'] as Date).getTime() <= Date.now() + 1000);
  });
});

describe('companies and places writer: update', () => {
  it('sets only the changed fields and updateDate of a company, writes the copy and leaves groups.places alone', async () => {
    await setSentinel();
    const before = must(await original('companies', C(1)));
    const version = (await writerOn().currentVersion('companies', C(1)))!;
    const outcome = written(await writerOn().updateCompany(C(1), version, { code: 'NEWCODE', email: null }));
    const after = must(await original('companies', C(1)));
    assert.deepEqual(differences(before, after, ['code', 'email', 'updateDate']).sort(), ['code', 'email', 'updateDate']);
    assert.equal(after['code'], 'NEWCODE');
    assert.equal(outcome.version, versionOf('companies', after));
    await assertMirrored('companies', C(1));
    assert.deepEqual(await groupPlaces(), SENTINEL);
  });

  it('sets only the changed fields of a place, writes the copy and recalculates groups.places', async () => {
    const before = must(await original('places', P(1)));
    const version = (await writerOn().currentVersion('places', P(1)))!;
    const outcome = written(await writerOn().updatePlace(P(1), version, { name: 'Renamed', timezone: 'Europe/London', expirationDate: new Date('2031-01-01T00:00:00.000Z'), companyId: C(1) }));
    const after = must(await original('places', P(1)));
    differences(before, after, ['name', 'timezone', 'expirationDate', 'updateDate']);
    assert.equal(after['name'], 'Renamed');
    assert.equal(outcome.version, versionOf('places', after));
    await assertMirrored('places', P(1));
    await assertGroupPlaces();
  });

  it('checks the company of a place that changes company: it must exist in the group and not be in the trash', async () => {
    const version = (await writerOn().currentVersion('places', P(1)))!;
    const before = await snapshot();
    for (const companyId of [missingId(), C(3), C(2)]) {
      assert.deepEqual(await writerOn().updatePlace(P(1), version, { companyId }), { outcome: 'companyNotFound' });
    }
    assert.deepEqual(await snapshot(), before);
  });

  it('tolerates the null registry data the legacy leaves on a place it trashed', async () => {
    const before = must(await original('places', P(2)));
    assert.equal(before['address'], null);
    const version = (await writerOn().currentVersion('places', P(2)))!;
    written(await writerOn().updatePlace(P(2), version, { name: 'Still fine' }));
    const after = must(await original('places', P(2)));
    differences(before, after, ['name', 'updateDate']);
    assert.deepEqual([after['address'], after['telephone'], after['contact']], [null, null, null]);
    await assertMirrored('places', P(2));
  });

  it('refuses empty or foreign changes before touching the database', async () => {
    const before = await snapshot();
    const version = (await writerOn().currentVersion('places', P(1)))!;
    await assert.rejects(() => writerOn().updatePlace(P(1), version, {}), InvalidWriteInputError);
    await assert.rejects(() => writerOn().updatePlace(P(1), version, { devices: [] } as never), InvalidWriteInputError);
    await assert.rejects(() => writerOn().updatePlace(P(1), version, { trash: true } as never), InvalidWriteInputError);
    await assert.rejects(() => writerOn().updateCompany(C(1), version, { settings: {} } as never), InvalidWriteInputError);
    assert.deepEqual(await snapshot(), before);
  });
});

describe('companies and places writer: trash, restore, delete', () => {
  it('trashes a place: trash, copy, feed record removed (only of this group), groups.places recalculated', async () => {
    const before = must(await original('places', P(1)));
    const version = (await writerOn().currentVersion('places', P(1)))!;
    written(await writerOn().trash('places', P(1), version));
    const after = must(await original('places', P(1)));
    differences(before, after, ['trash', 'updateDate']);
    assert.equal(after['trash'], true);
    await assertMirrored('places', P(1));
    assert.equal(await feed(G1, P(1)), null);
    assert.equal((await feed(G2, P(1)))?.['name'], 'other group');
    await assertGroupPlaces();
  });

  it('restores a place: feed record written in the legacy shape when the integration is active and complete', async () => {
    let version = (await writerOn().currentVersion('places', P(1)))!;
    written(await writerOn().trash('places', P(1), version));
    version = (await writerOn().currentVersion('places', P(1)))!;
    const before = must(await original('places', P(1)));
    written(await writerOn().restore('places', P(1), version));
    const after = must(await original('places', P(1)));
    differences(before, after, ['trash', 'updateDate']);
    assert.equal(after['trash'], false);
    await assertMirrored('places', P(1));
    await assertGroupPlaces();
    assert.deepEqual(await feed(G1, P(1)), {
      _id: (await feed(G1, P(1)))!['_id'],
      groupId: G1,
      companyId: C(1),
      placeId: P(1),
      category: 'restaurant',
      name: 'Fixture RWG',
      telephone: '+39000',
      url: 'https://example.test',
      geo: { latitude: 41.9, longitude: 12.5, address: { streetAddress: 'Via 1', locality: 'Roma', postalCode: '00100', country: 'IT' } },
    });
    assert.equal(await common().collection('reserve_with_google').countDocuments({ placeId: P(1) }), 2);
  });

  it('does not put a restored place in the feed when its integration is inactive or incomplete', async () => {
    let version = (await writerOn().currentVersion('places', P(2)))!;
    written(await writerOn().restore('places', P(2), version));
    assert.equal(await feed(G1, P(2)), null);
    await groupDb().collection('places').updateOne({ _id: P(1) }, { $set: { 'integrations.reserveWithGoogle.geo.address.country': null } });
    version = (await writerOn().currentVersion('places', P(1)))!;
    written(await writerOn().trash('places', P(1), version));
    version = (await writerOn().currentVersion('places', P(1)))!;
    written(await writerOn().restore('places', P(1), version));
    assert.equal(await feed(G1, P(1)), null);
  });

  it('deletes a trashed place: original, copy and feed record, and groups.places no longer lists it', async () => {
    const version = (await writerOn().currentVersion('places', P(2)))!;
    await feedFor(P(2));
    assert.deepEqual(await writerOn().deleteTrashed('places', P(2), version), { outcome: 'deleted', id: P(2) });
    assert.equal(await original('places', P(2)), null);
    assert.equal(await copyOf('places', P(2)), null);
    assert.equal(await feed(G1, P(2)), null);
    await assertGroupPlaces();
    assert.equal(((await groupPlaces()) as unknown[]).length, 1);
  });

  it('refuses to delete a document that is not in the trash', async () => {
    const before = await snapshot();
    for (const [kind, id] of [['places', P(1)], ['companies', C(1)]] as const) {
      const version = (await writerOn().currentVersion(kind, id))!;
      assert.deepEqual(await writerOn().deleteTrashed(kind, id, version), { outcome: 'notTrashed' });
    }
    assert.deepEqual(await snapshot(), before);
  });

  it('trashes, restores and deletes a company with its copy, without touching groups.places or the feed', async () => {
    await setSentinel();
    const feedBefore = await common().collection('reserve_with_google').find({}).sort({ _id: 1 }).toArray();
    const before = must(await original('companies', C(1)));
    let version = (await writerOn().currentVersion('companies', C(1)))!;
    written(await writerOn().trash('companies', C(1), version));
    differences(before, must(await original('companies', C(1))), ['trash', 'updateDate']);
    assert.equal((await original('companies', C(1)))!['trash'], true);
    await assertMirrored('companies', C(1));
    version = (await writerOn().currentVersion('companies', C(1)))!;
    written(await writerOn().restore('companies', C(1), version));
    assert.equal((await original('companies', C(1)))!['trash'], false);
    await assertMirrored('companies', C(1));
    version = (await writerOn().currentVersion('companies', C(2)))!;
    assert.deepEqual(await writerOn().deleteTrashed('companies', C(2), version), { outcome: 'deleted', id: C(2) });
    assert.equal(await original('companies', C(2)), null);
    assert.equal(await copyOf('companies', C(2)), null);
    assert.deepEqual(await groupPlaces(), SENTINEL);
    assert.deepEqual(await common().collection('reserve_with_google').find({}).sort({ _id: 1 }).toArray(), feedBefore);
  });

  it('does not cascade: a trashed company keeps its places untouched', async () => {
    const place = must(await original('places', P(1)));
    const version = (await writerOn().currentVersion('companies', C(1)))!;
    written(await writerOn().trash('companies', C(1), version));
    assert.deepEqual(must(await original('places', P(1))), place);
  });

  async function feedFor(placeId: ObjectId): Promise<void> {
    await common().collection('reserve_with_google').insertOne({ groupId: G1, companyId: C(1), placeId, category: 'restaurant', name: 'orphan' });
    assert.notEqual(await feed(G1, placeId), null);
  }
});

describe('companies and places writer: what the legacy and the POS own survives every write', () => {
  const OWNED_BY_OTHERS = ['devices', 'rooms', 'storages', 'roomsSettings', 'integrations', 'general', 'server', 'futureBlock', 'printStations', 'openingTime', 'plan', 'groupId', 'insertDate'];

  it('keeps devices[i].info, rooms[].tables, storages[].id, suspendedToday, integrations, unknown keys and the exact types of a place through every operation', async () => {
    const start = must(await original('places', P(1)));
    const steps: Array<[string, (version: string) => Promise<WriteOutcome>, string[]]> = [
      ['update', (v) => writerOn().updatePlace(P(1), v, { name: 'A', address: 'Via Nuova', status: false }), ['name', 'address', 'status', 'updateDate']],
      ['trash', (v) => writerOn().trash('places', P(1), v), ['trash', 'updateDate']],
      ['restore', (v) => writerOn().restore('places', P(1), v), ['trash', 'updateDate']],
      ['move', (v) => writerOn().updatePlace(P(1), v, { companyId: C(1), listId: 'list-1', ecommerceListId: null, invoicePS: true }), ['companyId', 'listId', 'ecommerceListId', 'invoicePS', 'updateDate']],
    ];
    for (const [step, run, changed] of steps) {
      const before = must(await original('places', P(1)));
      written(await run((await writerOn().currentVersion('places', P(1)))!));
      const after = must(await original('places', P(1)));
      differences(before, after, changed);
      for (const key of OWNED_BY_OTHERS) {
        assert.ok(sameDocument({ v: start[key] }, { v: after[key] }), `${key} changed at ${step}`);
      }
      await assertMirrored('places', P(1));
    }
    const final = must(await original('places', P(1)));
    assert.deepEqual(((final['devices'] as Document[])[0]!['info'] as Document)['os'], 'x');
    assert.ok(((final['devices'] as Document[])[0]!['info'] as Document)['battery'] instanceof Double);
    assert.deepEqual(((final['rooms'] as Document[])[0]!['tables'] as Document[]).map((table) => table['id']), ['t1', 't2']);
    assert.ok((final['storages'] as Document[])[0]!['id'].equals(fixtureId('place', 701)));
    assert.equal(((final['roomsSettings'] as Document)['reservation'] as Document)['suspendedToday'], true);
    assert.equal(((final['integrations'] as Document)['dojo'] as Document)['apiKey'], 'fixture-integration-secret');
    assert.ok((final['general'] as Document)['chargeDocumentQt'] instanceof Double);
    assert.ok((final['server'] as Document)['port'] instanceof Double);
  });

  it('keeps the blocks and the unknown keys of a company through every operation', async () => {
    const start = must(await original('companies', C(1)));
    for (const run of [
      (v: string) => writerOn().updateCompany(C(1), v, { name: 'B', currencyCode: 'USD', status: false }),
      (v: string) => writerOn().trash('companies', C(1), v),
      (v: string) => writerOn().restore('companies', C(1), v),
    ]) {
      written(await run((await writerOn().currentVersion('companies', C(1)))!));
      const after = must(await original('companies', C(1)));
      for (const key of ['settings', 'fattura_elettronica', 'invoicesPS', 'invoicesPSValues', 'banks', 'ticketsSuppliers', 'medias', 'futureKey', 'groupId', 'insertDate']) {
        assert.ok(sameDocument({ v: start[key] }, { v: after[key] }), key);
      }
      await assertMirrored('companies', C(1));
    }
  });

  it('writes the copy of a document whose legacy groupId is wrong with the group of the access', async () => {
    await groupDb().collection('places').updateOne({ _id: P(1) }, { $set: { groupId: G2 } });
    const version = (await writerOn().currentVersion('places', P(1)))!;
    written(await writerOn().updatePlace(P(1), version, { name: 'Wrong group id' }));
    assert.deepEqual((await original('places', P(1)))!['groupId'], G2);
    assert.deepEqual((await copyOf('places', P(1)))!['groupId'], G1);
    await assertMirrored('places', P(1));
  });
});

describe('companies and places writer: optimistic concurrency', () => {
  it('answers conflict, and writes nothing, when the version is wrong', async () => {
    const before = await snapshot();
    assert.deepEqual(await writerOn().updatePlace(P(1), 'wrong', { name: 'x' }), { outcome: 'conflict' });
    assert.deepEqual(await writerOn().updateCompany(C(1), 'wrong', { name: 'x' }), { outcome: 'conflict' });
    assert.deepEqual(await writerOn().trash('places', P(1), 'wrong'), { outcome: 'conflict' });
    assert.deepEqual(await writerOn().restore('companies', C(2), 'wrong'), { outcome: 'conflict' });
    assert.deepEqual(await writerOn().deleteTrashed('places', P(2), 'wrong'), { outcome: 'conflict' });
    assert.deepEqual(await snapshot(), before);
  });

  it('does not conflict on a POS write on devices or rooms done after the version was read, and still writes only its own fields', async () => {
    const version = (await writerOn().currentVersion('places', P(1)))!;
    await groupDb().collection('places').updateOne({ _id: P(1) }, { $set: { 'devices.0.info.os': 'changed by the POS', 'rooms.0.name': 'Sala 2', 'roomsSettings.reservation.suspendedToday': false, updateDate: new Date() } });
    assert.equal(await writerOn().currentVersion('places', P(1)), version);
    written(await writerOn().updatePlace(P(1), version, { name: 'not late' }));
    const stored = must(await original('places', P(1)));
    assert.deepEqual([stored['name'], ((stored['devices'] as Document[])[0]!['info'] as Document)['os'], (stored['rooms'] as Document[])[0]!['name']], ['not late', 'changed by the POS', 'Sala 2']);
    await assertMirrored('places', P(1));
  });

  it('detects a legacy change to an owned field done after the version was read', async () => {
    const version = (await writerOn().currentVersion('places', P(1)))!;
    await groupDb().collection('places').updateOne({ _id: P(1) }, { $set: { name: 'changed by the legacy' } });
    const before = await snapshot();
    assert.deepEqual(await writerOn().updatePlace(P(1), version, { name: 'late' }), { outcome: 'conflict' });
    assert.deepEqual(await snapshot(), before);
    assert.notEqual(await writerOn().currentVersion('places', P(1)), version);
  });

  it('detects a change of the owned fields that is a removal, a type or a trash flag, not only a value', async () => {
    const version = (await writerOn().currentVersion('companies', C(1)))!;
    await groupDb().collection('companies').updateOne({ _id: C(1) }, { $unset: { code2: '' } });
    assert.deepEqual(await writerOn().updateCompany(C(1), version, { name: 'x' }), { outcome: 'conflict' });
  });

  it('detects a legacy write that lands between the read and the write inside the transaction', async () => {
    const version = (await writerOn().currentVersion('places', P(1)))!;
    let fired = false;
    const databases = withHooks(ctx.databases, {
      group: {
        places: {
          findOne: async (call) => {
            const result = await call();
            if (!fired) {
              fired = true;
              await groupDb().collection('places').updateOne({ _id: P(1) }, { $set: { address: 'written by the legacy' } });
            }
            return result;
          },
        },
      },
    });
    assert.deepEqual(await writerOn(databases).updatePlace(P(1), version, { name: 'raced' }), { outcome: 'conflict' });
    assert.equal(fired, true);
    const stored = must(await original('places', P(1)));
    assert.deepEqual([stored['address'], stored['name']], ['written by the legacy', 'place-001']);
    // The copy was not touched either: the legacy block is what brings it up to date.
    assert.equal((await copyOf('places', P(1)))!['address'], 'Via Fixture 2');
  });

  it('accepts the version a write returned and refuses the previous one', async () => {
    const first = (await writerOn().currentVersion('companies', C(1)))!;
    const outcome = written(await writerOn().updateCompany(C(1), first, { name: 'v2' }));
    assert.notEqual(outcome.version, first);
    assert.deepEqual(await writerOn().updateCompany(C(1), first, { name: 'v3' }), { outcome: 'conflict' });
    written(await writerOn().updateCompany(C(1), outcome.version, { name: 'v3' }));
    assert.equal((await original('companies', C(1)))!['name'], 'v3');
  });

  it('answers notFound for a document that does not exist and has no version', async () => {
    const id = missingId();
    assert.equal(await writerOn().currentVersion('places', id), null);
    assert.equal(await writerOn().currentVersion('companies', id), null);
    for (const outcome of [
      await writerOn().updatePlace(id, 'v', { name: 'x' }),
      await writerOn().updateCompany(id, 'v', { name: 'x' }),
      await writerOn().trash('places', id, 'v'),
      await writerOn().restore('companies', id, 'v'),
      await writerOn().deleteTrashed('places', id, 'v'),
    ]) {
      assert.deepEqual(outcome, { outcome: 'notFound' });
    }
  });
});

describe('companies and places writer: all or nothing', () => {
  async function assertRolledBack(work: () => Promise<unknown>, expected: RegExp): Promise<void> {
    const before = await snapshot();
    await assert.rejects(work, expected);
    assert.deepEqual(await snapshot(), before);
  }

  it('rolls back the original when the copy cannot be written', async () => {
    const databases = withHooks(ctx.databases, { common: { places: { replaceOne: boom } } });
    const version = (await writerOn().currentVersion('places', P(1)))!;
    await assertRolledBack(() => writerOn(databases).updatePlace(P(1), version, { name: 'x' }), /boom/);
    await assertRolledBack(() => writerOn(databases).createPlace({ name: 'x', companyId: C(1) }), /boom/);
  });

  it('rolls back the original and the copy when groups.places cannot be written', async () => {
    const databases = withHooks(ctx.databases, { common: { groups: { updateOne: boom } } });
    const version = (await writerOn().currentVersion('places', P(1)))!;
    await assertRolledBack(() => writerOn(databases).createPlace({ name: 'x', companyId: C(1) }), /boom/);
    await assertRolledBack(() => writerOn(databases).updatePlace(P(1), version, { name: 'x' }), /boom/);
  });

  it('rolls back when the feed cannot be written', async () => {
    const trashing = withHooks(ctx.databases, { common: { reserve_with_google: { deleteOne: boom } } });
    const version = (await writerOn().currentVersion('places', P(1)))!;
    await assertRolledBack(() => writerOn(trashing).trash('places', P(1), version), /boom/);
    const trashed = written(await writerOn().trash('places', P(1), version));
    const restoring = withHooks(ctx.databases, { common: { reserve_with_google: { updateOne: boom } } });
    await assertRolledBack(() => writerOn(restoring).restore('places', P(1), trashed.version), /boom/);
  });

  it('rolls back the deletion of the original when the copy cannot be deleted', async () => {
    const databases = withHooks(ctx.databases, { common: { places: { deleteOne: boom } } });
    const version = (await writerOn().currentVersion('places', P(2)))!;
    await assertRolledBack(() => writerOn(databases).deleteTrashed('places', P(2), version), /boom/);
  });

  it('fails and rolls back if the document just written cannot be read back', async () => {
    let calls = 0;
    const databases = withHooks(ctx.databases, {
      group: { places: { findOne: async (call) => (++calls === 2 ? null : call()) } },
    });
    const version = (await writerOn().currentVersion('places', P(1)))!;
    await assertRolledBack(() => writerOn(databases).updatePlace(P(1), version, { name: 'x' }), /cannot be read back/);
  });

  it('fails and rolls back if the group document does not exist', async () => {
    await common().collection('groups').deleteOne({ _id: G1 });
    await assertRolledBack(() => writerOn().createPlace({ name: 'x', companyId: C(1) }), /group document does not exist/);
  });

  it('fails and rolls back above the largest list of places it recalculates', async () => {
    assert.equal(MAX_GROUP_PLACES, 10_000);
    await assertRolledBack(() => companiesPlacesWriter(principal, access, ctx.databases, { now: clock, maxGroupPlaces: 2 }).createPlace({ name: 'x', companyId: C(1) }), /Too many places/);
    written(await companiesPlacesWriter(principal, access, ctx.databases, { now: clock, maxGroupPlaces: 3 }).createPlace({ name: 'x', companyId: C(1) }));
  });
});

describe('companies and places writer: guards', () => {
  it('rejects an id that is not an ObjectId and a collection it does not write, before writing', async () => {
    const before = await snapshot();
    await assert.rejects(() => writerOn().currentVersion('places', P(1).toHexString() as never), InvalidWriteInputError);
    await assert.rejects(() => writerOn().updateCompany('x' as never, 'v', { name: 'a' }), InvalidWriteInputError);
    await assert.rejects(() => writerOn().trash('places', null as never, 'v'), InvalidWriteInputError);
    await assert.rejects(() => writerOn().deleteTrashed('companies', {} as never, 'v'), InvalidWriteInputError);
    await assert.rejects(() => writerOn().trash('users' as never, P(1), 'v'), InvalidWriteInputError);
    await assert.rejects(() => writerOn().currentVersion('groups' as never, P(1)), InvalidWriteInputError);
    assert.deepEqual(await snapshot(), before);
  });

  it('is opened only with a verified access of the same principal', async () => {
    assert.throws(() => companiesPlacesWriter(principal, { ...access }, ctx.databases), /verified group access/);
    assert.throws(() => companiesPlacesWriter(principalOf('SA', { groupId: G2 }), access, ctx.databases), /verified group access/);
  });

  it('does not see, change, trash or delete the documents of another group, and refuses its companies', async () => {
    const before = await snapshot();
    assert.equal(await writerOn().currentVersion('places', P(3)), null);
    assert.equal(await writerOn().currentVersion('companies', C(3)), null);
    const foreign = versionOf('places', must(await original('places', P(3), 2)));
    assert.deepEqual(await writerOn().updatePlace(P(3), foreign, { name: 'x' }), { outcome: 'notFound' });
    assert.deepEqual(await writerOn().trash('places', P(3), foreign), { outcome: 'notFound' });
    assert.deepEqual(await writerOn().restore('places', P(3), foreign), { outcome: 'notFound' });
    assert.deepEqual(await writerOn().deleteTrashed('places', P(3), foreign), { outcome: 'notFound' });
    assert.deepEqual(await writerOn().updateCompany(C(3), foreign, { name: 'x' }), { outcome: 'notFound' });
    assert.deepEqual(await writerOn().createPlace({ name: 'x', companyId: C(3) }), { outcome: 'companyNotFound' });
    assert.deepEqual(await snapshot(), before);
  });

  it('only touches its own group in the common database', async () => {
    const version = (await writerOn().currentVersion('places', P(1)))!;
    written(await writerOn().updatePlace(P(1), version, { name: 'mine' }));
    written(await writerOn().createPlace({ name: 'mine too', companyId: C(1) }));
    assert.equal((await copyOf('places', P(3)))!['name'], 'place-003');
    assert.deepEqual((await common().collection('groups').findOne({ _id: G2 }))?.['places'], []);
  });
});

describe('companies and places writer: reconciliation', () => {
  it('leaves nothing for sync:copies to repair after a sequence of operations of every kind', async () => {
    const writer = writerOn();
    const company = written(await writer.createCompany({ name: 'Seq Co' }));
    const place = written(await writer.createPlace({ name: 'Seq Shop', companyId: company.id }));
    written(await writer.updatePlace(place.id, place.version, { name: 'Seq Shop 2' }));
    let version = (await writer.currentVersion('places', P(1)))!;
    written(await writer.trash('places', P(1), version));
    version = (await writer.currentVersion('places', P(1)))!;
    written(await writer.restore('places', P(1), version));
    version = (await writer.currentVersion('places', P(2)))!;
    await writer.deleteTrashed('places', P(2), version);
    version = (await writer.currentVersion('companies', C(2)))!;
    await writer.deleteTrashed('companies', C(2), version);
    version = (await writer.currentVersion('companies', C(1)))!;
    written(await writer.updateCompany(C(1), version, { name: 'Renamed Co' }));
    const result = await syncCopies(ctx.databases, { ...options(), apply: false });
    assert.equal(result.errors, 0);
    assert.deepEqual(Object.values(result.issues.totals()).filter((count) => count !== 0), []);
    for (const summary of result.summaries.values()) {
      for (const stats of [summary.companies, summary.places]) {
        assert.deepEqual([stats.missing, stats.different, stats.extra], [0, 0, 0]);
      }
    }
    assert.equal(result.summaries.get(G1.toHexString())!.places.originals, 2);
    await assertGroupPlaces();
  });
});

describe('companies and places writer: groups on another cluster', () => {
  it('refuses every operation with a typed error and writes nothing', async () => {
    const clusters = await openTestClusters();
    try {
      const remote = (await accessFor(principal, G1, 'cluster1'))!;
      const writer = companiesPlacesWriter(principal, remote, clusters.databases, { now: clock });
      const checks: Array<() => Promise<unknown>> = [
        () => writer.createCompany({ name: 'x' }),
        () => writer.createPlace({ name: 'x', companyId: C(1) }),
        () => writer.updateCompany(C(1), 'v', { name: 'x' }),
        () => writer.updatePlace(P(1), 'v', { name: 'x' }),
        () => writer.trash('places', P(1), 'v'),
        () => writer.restore('places', P(1), 'v'),
        () => writer.deleteTrashed('companies', C(1), 'v'),
      ];
      for (const check of checks) {
        await assert.rejects(check, (error: unknown) => error instanceof CrossClusterWriteError && error.groupId === G1.toHexString() && error.groupCluster === 'cluster1' && error.commonCluster === 'cluster0');
      }
      const { databases } = await clusters.registry.clusters.get('cluster0')!.main.db().admin().listDatabases({ nameOnly: true });
      assert.deepEqual(databases.filter((entry) => entry.name.startsWith(clusters.prefix)), []);
    } finally {
      await clusters.cleanup();
    }
  });
});
