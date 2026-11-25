import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { AppError } from '../../src/shared/http/errors.ts';
import { InvalidProviderDataError } from '../../src/shared/integrations/errors.ts';
import type { PlaceIntegrationTarget, PlaceIntegrationsPort } from '../../src/shared/integrations/ports.ts';
import { sameDocument } from '../../src/shared/legacy-write/copy-rule.ts';
import { companiesPlacesWriter } from '../../src/shared/legacy-write/companies-places.writer.ts';
import type { CompaniesPlacesWriter } from '../../src/shared/legacy-write/companies-places.writer.ts';
import { createGroupsRepository } from '../../src/shared/security/scope/groups.repository.ts';
import type { AuthPrincipal } from '../../src/shared/security/scope/principal.ts';
import { createPlaceIntegrationsPort } from '../../src/modules/places/place-integrations.port.ts';
import { fixtureId } from '../helpers/legacy-fixtures.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { principalOf } from '../helpers/principal.ts';
import { startPlacesWorld } from '../helpers/places.ts';
import type { PlacesWorld } from '../helpers/places.ts';
import { fullLegacyPlace } from '../helpers/place-fixtures.ts';
import { TEST_VERSION_KEY } from '../helpers/version-key.ts';

let ctx: TestDatabases;
let world: PlacesWorld;
const P = (n: number): ObjectId => fixtureId('place', n);
const hex = (id: ObjectId): string => id.toHexString();
const g0 = (): ObjectId => world.group(0).groupId;
const groupHex = (): string => hex(g0());

const principals = {
  psa: (): AuthPrincipal => principalOf('PSA'),
  dealer: (): AuthPrincipal => principalOf('D', { dealerGroupIds: [world.group(0).groupId, world.group(1).groupId] }),
  sa: (): AuthPrincipal => principalOf('SA', { groupId: g0() }),
  ca: (): AuthPrincipal => principalOf('CA', { groupId: g0(), companyIds: [fixtureId('company', 1)] }),
  pa: (): AuthPrincipal => principalOf('PA', { groupId: g0(), placeIds: [world.group(0).ownPlaceId] }),
};

/** The error a call rejects with, as `{ status, code, details }`; fails if it does not reject with an {@link AppError}. */
async function refusal(call: Promise<unknown>): Promise<{ code: string; details: unknown }> {
  try {
    await call;
  } catch (error) {
    assert.ok(error instanceof AppError, String(error));
    return { code: error.code, details: error.details };
  }
  return assert.fail('The call was not refused');
}
const unprocessable = (field: string, issue: string) => ({ code: 'VALIDATION_ERROR', details: [{ field, issue }] });

let log: Array<Record<string, unknown>>;
let port: PlaceIntegrationsPort;
/** A port over a writer that is changed by the test (a conflict, a place that vanished). */
let portWith: (change: (writer: CompaniesPlacesWriter) => CompaniesPlacesWriter) => PlaceIntegrationsPort;

before(async () => {
  ctx = await openTestDatabases();
  world = await startPlacesWorld(ctx);
  await world.seed(0, 20);
  const groups = createGroupsRepository(ctx.databases);
  log = [];
  const activityLog = { record: async (entry: Record<string, unknown>) => void log.push(entry) } as never;
  portWith = (change) => createPlaceIntegrationsPort({ groups, writerFor: (principal, access) => change(companiesPlacesWriter(principal, access, ctx.databases, { versionKey: TEST_VERSION_KEY })), activityLog });
  port = portWith((writer) => writer);
});
after(async () => {
  await world.office.close();
  await ctx.cleanup();
});

const on = (extra: Document = {}): Document => ({ status: true, ...extra });
/** Seeds a place of group 0 with the integrations of a test on top of the fixture's. */
async function seed(n: number, integrations: Document, overrides: Document = {}, companyN = 1): Promise<ObjectId> {
  // A test may seed the same place again with other integrations.
  await ctx.databases.group(g0(), 'cluster0').collection('places').deleteOne({ _id: P(n) });
  await ctx.databases.common().collection('places').deleteOne({ _id: P(n) });
  const base = fullLegacyPlace(n, g0(), fixtureId('company', companyN))['integrations'] as Document;
  return world.seedPlace(0, n, companyN, { integrations: { ...base, ...integrations }, ...overrides });
}
const target = (principal: AuthPrincipal, id: ObjectId, groupId = groupHex()): PlaceIntegrationTarget => ({ principal, groupId, placeId: hex(id) });
const stored = async (id: ObjectId): Promise<Document> => (await world.storedPlace(0, id))!;
const integrationsOf = async (id: ObjectId): Promise<Record<string, Document>> => (await stored(id))['integrations'] as Record<string, Document>;
const versionNow = async (id: ObjectId): Promise<string> => (await world.as.call(world.office.cluster.psa, 'GET', world.placePath(0, `/${hex(id)}`))).headers.get('etag')!.slice(1, -1);

describe('the place port of the integrations: what every method checks first', () => {
  const methods: ReadonlyArray<readonly [string, (to: PlaceIntegrationTarget) => Promise<unknown>]> = [
    ['dojoCredentials', (to) => port.dojoCredentials(to)],
    ['tshCredentials', (to) => port.tshCredentials(to)],
    ['checkSatispayActivation', (to) => port.checkSatispayActivation(to, 'v')],
    ['saveSatispayKeyId', (to) => port.saveSatispayKeyId(to, 'v', 'key-id-1')],
    ['saveTshCategories', (to) => port.saveTshCategories(to, 'v', [])],
    ['checkGeocoding', (to) => port.checkGeocoding(to)],
  ];

  it('refuses a group outside the perimeter, missing, malformed or not available to the caller, as a place that does not exist', async () => {
    const id = await seed(700, { dojo: on({ apiKey: 'fake-dojo-key-1' }) });
    await ctx.databases.common().collection('groups').updateOne({ _id: world.group(3).groupId }, { $set: { status: false } });
    for (const [name, call] of methods) {
      for (const groupId of [hex(world.group(1).groupId), hex(world.group(3).groupId), 'f'.repeat(24), 'not-an-id', '']) {
        assert.deepEqual(await refusal(call(target(principals.sa(), id, groupId))), { code: 'NOT_FOUND', details: undefined }, `${name} ${groupId}`);
      }
    }
    // The dealer of another group and the group of a platform caller too: the PSA reaches a suspended group (and finds no such place there).
    assert.equal((await refusal(port.dojoCredentials(target(principals.psa(), id, hex(world.group(3).groupId))))).code, 'NOT_FOUND');
    await ctx.databases.common().collection('groups').updateOne({ _id: world.group(3).groupId }, { $set: { status: true } });
  });

  it('refuses a caller without places:update before it looks for the place', async () => {
    const id = await seed(701, {});
    const reader = principalOf('SA', { groupId: g0(), permissions: new Set(['places:read']) });
    for (const [name, call] of methods) {
      assert.deepEqual(await refusal(call(target(reader, id))), { code: 'FORBIDDEN', details: undefined }, name);
      assert.deepEqual(await refusal(call(target(reader, P(799)))), { code: 'FORBIDDEN', details: undefined }, `${name} (a place that does not exist)`);
    }
  });

  it('treats a place that is missing, malformed, in the trash, of another group or outside the perimeter of the caller as one and the same 404', async () => {
    const trashed = await seed(702, { dojo: on({ apiKey: 'fake-dojo-key-1' }) }, { trash: true });
    const otherCompany = await seed(703, { dojo: on({ apiKey: 'fake-dojo-key-1' }) }, {}, 2);
    const own = await seed(704, { dojo: on({ apiKey: 'fake-dojo-key-1' }) });
    for (const [name, call] of methods) {
      for (const [who, principal, id] of [
        ['a missing place', principals.sa(), P(798)],
        ['a place in the trash', principals.sa(), trashed],
        ['a place in the trash, for the PSA', principals.psa(), trashed],
        ['a place of another company, for the company administrator', principals.ca(), otherCompany],
        ['a place that is not his, for the place administrator', principals.pa(), own],
      ] as const) {
        assert.deepEqual(await refusal(call(target(principal, id))), { code: 'NOT_FOUND', details: undefined }, `${name}: ${who}`);
      }
      assert.equal((await refusal(call({ principal: principals.sa(), groupId: groupHex(), placeId: 'not-an-id' }))).code, 'NOT_FOUND', name);
    }
    // A place of another group is not found through the group of the caller.
    const elsewhere = await world.seedPlace(1, 705, 1);
    assert.equal((await refusal(port.dojoCredentials(target(principals.sa(), elsewhere)))).code, 'NOT_FOUND');
  });
});

describe('the place port of the integrations: Dojo and TS Hospitality credentials', () => {
  it('gives the key of Dojo and nothing else of the place', async () => {
    const id = await seed(710, { dojo: on({ apiKey: 'fake-dojo-key-1' }) });
    for (const principal of [principals.psa(), principals.dealer(), principals.sa(), principals.ca()]) {
      assert.deepEqual(await port.dojoCredentials(target(principal, id)), { apiKey: 'fake-dojo-key-1' });
    }
    const own = world.group(0).ownPlaceId;
    await ctx.databases.group(g0(), 'cluster0').collection('places').updateOne({ _id: own }, { $set: { 'integrations.dojo': { status: true, apiKey: 'fake-dojo-key-2' } } });
    assert.deepEqual(await port.dojoCredentials(target(principals.pa(), own)), { apiKey: 'fake-dojo-key-2' });
  });

  it('refuses a switch that is off, and a key that is missing, empty or not a text, with the field of the problem', async () => {
    const off = await seed(711, { dojo: { status: false, apiKey: 'fake-dojo-key-1' } });
    assert.deepEqual(await refusal(port.dojoCredentials(target(principals.sa(), off))), unprocessable('integrations.dojo.status', 'incorrect'));
    for (const apiKey of [null, '', 5, undefined]) {
      const id = await seed(712, { dojo: on(apiKey === undefined ? {} : { apiKey }) });
      assert.deepEqual(await refusal(port.dojoCredentials(target(principals.sa(), id))), unprocessable('integrations.dojo.apiKey', 'required'), String(apiKey));
    }
    const without = await seed(713, { dojo: undefined });
    assert.deepEqual(await refusal(port.dojoCredentials(target(principals.sa(), without))), unprocessable('integrations.dojo.status', 'incorrect'));
  });

  it('gives the credentials of TS Hospitality with the test mode, and refuses the missing ones in the order id, secret, property', async () => {
    const complete = { id: 'fake-tsh-id', secret: 'fake-tsh-secret', propertyId: 'prop_1-A', testMode: false };
    const id = await seed(720, { tsh: on(complete) });
    assert.deepEqual(await port.tshCredentials(target(principals.sa(), id)), complete);
    const test = await seed(721, { tsh: on({ ...complete, testMode: true }) });
    assert.deepEqual(await port.tshCredentials(target(principals.psa(), test)), { ...complete, testMode: true });
    const odd = await seed(722, { tsh: on({ ...complete, testMode: 'yes' }) });
    assert.equal((await port.tshCredentials(target(principals.psa(), odd))).testMode, false);
    const missing: ReadonlyArray<readonly [Document, string]> = [
      [{ id: null, secret: null, propertyId: null }, 'id'],
      [{ id: 'fake-tsh-id', secret: '', propertyId: null }, 'secret'],
      [{ id: 'fake-tsh-id', secret: 'fake-tsh-secret', propertyId: null }, 'propertyId'],
      [{ id: 'fake-tsh-id', secret: 'fake-tsh-secret' }, 'propertyId'],
    ];
    for (const [keys, field] of missing) {
      const place = await seed(723, { tsh: on(keys) });
      assert.deepEqual(await refusal(port.tshCredentials(target(principals.sa(), place))), unprocessable(`integrations.tsh.${field}`, 'required'), field);
    }
    const off = await seed(724, { tsh: { ...complete, status: false } });
    assert.deepEqual(await refusal(port.tshCredentials(target(principals.sa(), off))), unprocessable('integrations.tsh.status', 'incorrect'));
  });

  it('refuses a stored property id that is not in the allowed form, so it never reaches the path of a call', async () => {
    for (const propertyId of ['../etc', 'a/b', 'a?b=1', 'a#b', 'a b', 'x'.repeat(65), 'é']) {
      const id = await seed(725, { tsh: on({ id: 'fake-tsh-id', secret: 'fake-tsh-secret', propertyId }) });
      assert.deepEqual(await refusal(port.tshCredentials(target(principals.sa(), id))), unprocessable('integrations.tsh.propertyId', 'pattern'), propertyId);
    }
    const longest = await seed(726, { tsh: on({ id: 'fake-tsh-id', secret: 'fake-tsh-secret', propertyId: 'p'.repeat(64) }) });
    assert.equal((await port.tshCredentials(target(principals.sa(), longest))).propertyId.length, 64);
  });
});

describe('the place port of the integrations: the activation of Satispay', () => {
  it('lets only a PSA or a dealer start it, before the switch and before the version are looked at', async () => {
    const id = await seed(730, { satispay: { status: false, keyId: null, type: 'checkin' } });
    const version = await versionNow(id);
    for (const principal of [principals.sa(), principals.ca(), principals.pa(), principalOf('SA', { groupId: g0(), permissions: new Set(['places:update']) })]) {
      const own = principal.role === 'PA' ? world.group(0).ownPlaceId : id;
      assert.deepEqual(await refusal(port.checkSatispayActivation(target(principal, own), 'stale')), { code: 'FORBIDDEN', details: [{ field: 'integrations.satispay.keyId', issue: 'notAllowed' }] }, principal.role);
      assert.deepEqual(await refusal(port.saveSatispayKeyId(target(principal, own), version, 'key-id-1')), { code: 'FORBIDDEN', details: [{ field: 'integrations.satispay.keyId', issue: 'notAllowed' }] }, principal.role);
    }
    assert.equal((await stored(id))['integrations'] && (await integrationsOf(id))['satispay']!['keyId'], null);
  });

  it('refuses a switch that is off (422), then a version that is not the current one (412), and accepts the current one', async () => {
    const off = await seed(731, { satispay: { status: false, keyId: null, type: 'checkin' } });
    for (const principal of [principals.psa(), principals.dealer()]) {
      assert.deepEqual(await refusal(port.checkSatispayActivation(target(principal, off), await versionNow(off))), unprocessable('integrations.satispay.status', 'incorrect'));
    }
    // The switch comes before the version.
    assert.equal((await refusal(port.checkSatispayActivation(target(principals.psa(), off), 'stale'))).code, 'VALIDATION_ERROR');
    const id = await seed(732, { satispay: { status: true, keyId: null, type: 'checkin' } });
    assert.deepEqual(await refusal(port.checkSatispayActivation(target(principals.psa(), id), 'stale')), { code: 'PRECONDITION_FAILED', details: undefined });
    for (const principal of [principals.psa(), principals.dealer()]) {
      assert.equal(await port.checkSatispayActivation(target(principal, id), await versionNow(id)), undefined);
    }
    // Nothing was written.
    assert.equal((await integrationsOf(id))['satispay']!['keyId'], null);
  });

  it('saves the key id and removes the activation code in one write, with the copy and the log, and gives the new version', async () => {
    const id = await seed(733, { satispay: { status: true, activationCode: 'OLDCODE12345', keyId: null, type: 'qrcode' } });
    const before = await stored(id);
    const read = await versionNow(id);
    const mark = log.length;
    const reply = await port.saveSatispayKeyId(target(principals.psa(), id), read, 'fake-satispay-key-id');
    assert.equal(reply.etag, await versionNow(id));
    assert.notEqual(reply.etag, read);
    const after = await stored(id);
    // Only the key id and the code changed: the other keys of the integration and of the place are as they were (the write is on the paths, never the block).
    assert.deepEqual(await integrationsOf(id), { ...(before['integrations'] as Document), satispay: { status: true, keyId: 'fake-satispay-key-id', type: 'qrcode' } });
    assert.equal('activationCode' in (await integrationsOf(id))['satispay']!, false);
    assert.deepEqual({ ...after, integrations: undefined, updateDate: undefined }, { ...before, integrations: undefined, updateDate: undefined });
    // The copy in the common database is the document.
    assert.ok(sameDocument({ ...after, groupId: g0() }, (await world.copyOfPlace(id))!));
    // The log names the block and the actor, and nothing of the key.
    const entries = log.slice(mark);
    assert.equal(entries.length, 1);
    assert.deepEqual({ ...entries[0], actor: undefined, groupId: undefined }, { category: 'data', action: 'place.updated', outcome: 'success', actor: undefined, groupId: undefined, resource: { type: 'place', id: hex(id) }, changes: [{ field: 'integrations', redacted: true }] });
    assert.deepEqual([entries[0]!['groupId'], entries[0]!['actor']], [g0(), { kind: 'user', id: principals.psa().userId, role: 'PSA' }]);
    assert.ok(!JSON.stringify(entries).includes('fake-satispay-key-id') && !JSON.stringify(entries).includes('OLDCODE12345'));
    // The same key saved again, by a dealer, still goes through.
    assert.equal(typeof (await port.saveSatispayKeyId(target(principals.dealer(), id), reply.etag!, 'fake-satispay-key-id')).etag, 'string');
  });

  it('writes the key id even when the place changed since the caller read it, and then gives no version', async () => {
    const id = await seed(734, { satispay: { status: true, activationCode: 'OLDCODE12345', keyId: null, type: 'checkin' } });
    const stale = await versionNow(id);
    assert.equal((await world.as.call(world.office.cluster.psa, 'PATCH', world.placePath(0, `/${hex(id)}`), { name: 'Renamed meanwhile' }, { 'if-match': `"${stale}"` })).status, 200);
    const reply = await port.saveSatispayKeyId(target(principals.psa(), id), stale, 'fake-satispay-key-id');
    assert.deepEqual(reply, { etag: null });
    assert.deepEqual((await integrationsOf(id))['satispay'], { status: true, keyId: 'fake-satispay-key-id', type: 'checkin' });
    assert.equal((await stored(id))['name'], 'Renamed meanwhile');
  });

  it('writes the key id also when the switch has been turned off since, and on a place that never had a code', async () => {
    const id = await seed(735, { satispay: { status: false, keyId: null, type: 'checkin' } });
    assert.equal(typeof (await port.saveSatispayKeyId(target(principals.psa(), id), await versionNow(id), 'fake-satispay-key-id')).etag, 'string');
    assert.deepEqual((await integrationsOf(id))['satispay'], { status: false, keyId: 'fake-satispay-key-id', type: 'checkin' });
  });

  it('refuses a key id that is not in the form of the field before it writes anything', async () => {
    const id = await seed(736, { satispay: { status: true, activationCode: 'OLDCODE12345', keyId: null, type: 'checkin' } });
    const before = await stored(id);
    const read = await versionNow(id);
    for (const keyId of ['', 'has a space', 'x'.repeat(513), 'tab\tkey', 'é', 5 as unknown as string, null as unknown as string]) {
      await assert.rejects(port.saveSatispayKeyId(target(principals.psa(), id), read, keyId), (error) => error instanceof InvalidProviderDataError && error.kind === 'satispayKeyId' && !error.message.includes('space'));
    }
    assert.ok(sameDocument(before, await stored(id)));
    assert.equal((await port.saveSatispayKeyId(target(principals.psa(), id), read, 'x'.repeat(512))).etag, await versionNow(id));
  });

  it('keeps trying when the place is changed under the write, gives up with a conflict, and reports a place that disappeared', async () => {
    const id = await seed(737, { satispay: { status: true, keyId: null, type: 'checkin' } });
    const conflicting = (times: number) => {
      let calls = 0;
      return portWith((writer) => ({
        ...writer,
        updatePlace: (...args) => (calls++ < times ? Promise.resolve({ outcome: 'conflict' as const }) : writer.updatePlace(...args)),
      }));
    };
    assert.equal(typeof (await conflicting(2).saveSatispayKeyId(target(principals.psa(), id), await versionNow(id), 'fake-satispay-key-id-2')).etag, 'string');
    assert.equal((await integrationsOf(id))['satispay']!['keyId'], 'fake-satispay-key-id-2');
    assert.deepEqual(await refusal(conflicting(3).saveSatispayKeyId(target(principals.psa(), id), await versionNow(id), 'fake-satispay-key-id-3')), { code: 'CONFLICT', details: undefined });
    assert.equal((await integrationsOf(id))['satispay']!['keyId'], 'fake-satispay-key-id-2');
    const vanished = portWith((writer) => ({ ...writer, updatePlace: () => Promise.resolve({ outcome: 'notFound' as const }) }));
    assert.deepEqual(await refusal(vanished.saveSatispayKeyId(target(principals.psa(), id), await versionNow(id), 'fake-satispay-key-id-4')), { code: 'NOT_FOUND', details: undefined });
  });

  it('answers a conflict, not a failure, for a place whose integration block cannot be written', async () => {
    const id = await seed(738, { satispay: 'broken' });
    assert.deepEqual(await refusal(port.saveSatispayKeyId(target(principals.psa(), id), await versionNow(id), 'fake-satispay-key-id')), { code: 'CONFLICT', details: undefined });
  });

  it('does not hide a failure of the write that is not about the document', async () => {
    const id = await seed(739, { satispay: { status: true, keyId: null, type: 'checkin' } });
    const broken = portWith((writer) => ({ ...writer, updatePlace: () => Promise.reject(new Error('disk')) }));
    await assert.rejects(broken.saveSatispayKeyId(target(principals.psa(), id), await versionNow(id), 'fake-satispay-key-id'), /disk/);
  });
});

describe('the place port of the integrations: the categories of TS Hospitality', () => {
  const CATEGORIES = [{ id: 'cat-1', name: 'Bar' }, { id: 'cat-2', name: 'Cucina' }];

  it('saves the copy of the categories only if the place is at the version, and gives the new version, the copy and the log', async () => {
    const id = await seed(740, { tsh: on({ id: 'fake-tsh-id', secret: 'fake-tsh-secret', propertyId: 'prop', categoriesMap: { c1: 'old' }, tshCategories: [{ id: 'old', name: 'Old' }] }) });
    const before = await stored(id);
    const read = await versionNow(id);
    const mark = log.length;
    const reply = await port.saveTshCategories(target(principals.sa(), id), read, CATEGORIES);
    assert.equal(reply.etag, await versionNow(id));
    assert.notEqual(reply.etag, read);
    const after = await stored(id);
    assert.deepEqual((await integrationsOf(id))['tsh'], { ...(before['integrations'] as Record<string, Document>)['tsh'], tshCategories: CATEGORIES });
    assert.deepEqual({ ...after, integrations: undefined, updateDate: undefined }, { ...before, integrations: undefined, updateDate: undefined });
    assert.ok(sameDocument({ ...after, groupId: g0() }, (await world.copyOfPlace(id))!));
    const entries = log.slice(mark);
    assert.equal(entries.length, 1);
    assert.deepEqual([entries[0]!['action'], entries[0]!['changes'], entries[0]!['resource']], ['place.updated', [{ field: 'integrations', redacted: true }], { type: 'place', id: hex(id) }]);
    assert.ok(!JSON.stringify(entries).includes('Cucina') && !JSON.stringify(entries).includes('fake-tsh-secret'));
    // What the backoffice reads is the new copy, under the new version.
    const reading = await world.as.call(world.office.cluster.psa, 'GET', world.placePath(0, `/${hex(id)}`));
    assert.deepEqual(reading.body.data.integrations.tsh.categories, CATEGORIES);
    assert.equal(reading.headers.get('etag'), `"${reply.etag}"`);
    // An empty list is a list too.
    assert.equal(typeof (await port.saveTshCategories(target(principals.psa(), id), reply.etag, [])).etag, 'string');
    assert.deepEqual((await integrationsOf(id))['tsh']!['tshCategories'], []);
  });

  it('refuses a switch that is off first, then a version that is not the current one, and writes nothing', async () => {
    const off = await seed(741, { tsh: { status: false, tshCategories: [] } });
    const id = await seed(742, { tsh: on({ tshCategories: [] }) });
    assert.deepEqual(await refusal(port.saveTshCategories(target(principals.sa(), off), 'stale', CATEGORIES)), unprocessable('integrations.tsh.status', 'incorrect'));
    assert.deepEqual(await refusal(port.saveTshCategories(target(principals.sa(), id), 'stale', CATEGORIES)), { code: 'PRECONDITION_FAILED', details: undefined });
    assert.deepEqual((await integrationsOf(id))['tsh']!['tshCategories'], []);
    // A place that changes between the check and the write is the same 412; one that disappears is a 404.
    const racing = portWith((writer) => ({ ...writer, updatePlace: () => Promise.resolve({ outcome: 'conflict' as const }) }));
    assert.deepEqual(await refusal(racing.saveTshCategories(target(principals.sa(), id), await versionNow(id), CATEGORIES)), { code: 'PRECONDITION_FAILED', details: undefined });
    const vanished = portWith((writer) => ({ ...writer, updatePlace: () => Promise.resolve({ outcome: 'notFound' as const }) }));
    assert.deepEqual(await refusal(vanished.saveTshCategories(target(principals.sa(), id), await versionNow(id), CATEGORIES)), { code: 'NOT_FOUND', details: undefined });
    // A block of the integration that is not an object has no switch on.
    const broken = await seed(743, { tsh: 'broken' });
    assert.deepEqual(await refusal(port.saveTshCategories(target(principals.sa(), broken), await versionNow(broken), CATEGORIES)), unprocessable('integrations.tsh.status', 'incorrect'));
  });

  it('refuses a list that is not in the form of the copy before it writes anything', async () => {
    const id = await seed(745, { tsh: on({ tshCategories: [{ id: 'keep', name: 'Keep' }] }) });
    const before = await stored(id);
    const read = await versionNow(id);
    const bad: unknown[] = [
      'not a list',
      null,
      [{ id: 1, name: 'x' }],
      [{ id: 'a' }],
      [{ id: 'a', name: 'x', extra: true }],
      ['a'],
      [{ id: 'x'.repeat(65), name: 'x' }],
      [{ id: 'a', name: 'x'.repeat(201) }],
      Array.from({ length: 501 }, (_unused, index) => ({ id: `c${String(index)}`, name: 'n' })),
    ];
    for (const categories of bad) {
      await assert.rejects(port.saveTshCategories(target(principals.sa(), id), read, categories as never), (error) => error instanceof InvalidProviderDataError && error.kind === 'tshCategories', JSON.stringify(categories)?.slice(0, 40));
    }
    assert.ok(sameDocument(before, await stored(id)));
  });
});

describe('the place port of the integrations: the geocoding', () => {
  it('lets a caller who may write the place through while Google Maps is on, and refuses it when it is off', async () => {
    const id = await seed(750, { googleMaps: { status: true } });
    for (const principal of [principals.psa(), principals.dealer(), principals.sa(), principals.ca()]) {
      assert.equal(await port.checkGeocoding(target(principal, id)), undefined);
    }
    const off = await seed(751, { googleMaps: { status: false } });
    assert.deepEqual(await refusal(port.checkGeocoding(target(principals.sa(), off))), unprocessable('integrations.googleMaps.status', 'incorrect'));
  });
});
