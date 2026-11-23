import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { createCompaniesRepository } from '../../src/modules/companies/companies.repository.ts';
import { createCompaniesService } from '../../src/modules/companies/companies.service.ts';
import { createCatalogsRepository } from '../../src/modules/groups/catalogs/catalogs.repository.ts';
import { createPlacesRepository } from '../../src/modules/places/places.repository.ts';
import { createPlacesService } from '../../src/modules/places/places.service.ts';
import { createTrashService } from '../../src/modules/trash/trash.service.ts';
import { createUsersRepository } from '../../src/modules/users/users.repository.ts';
import { createUsersService } from '../../src/modules/users/users.service.ts';
import { createCredentialsRepository } from '../../src/modules/users/credentials.repository.ts';
import { createDealersRepository } from '../../src/modules/dealers/dealers.repository.ts';
import { createGroupDirectoryRepository } from '../../src/modules/users/group-directory.repository.ts';
import { createSessionsRepository } from '../../src/modules/sessions/sessions.repository.ts';
import { companiesPlacesWriter } from '../../src/shared/legacy-write/companies-places.writer.ts';
import { ACTION_CATALOG } from '../../src/shared/activity-log/catalog.ts';
import { Secret } from '../../src/shared/security/secret.ts';
import { memoryActivityLog } from '../helpers/activity.ts';
import { TEST_PEPPER, addUser, startBackoffice } from '../helpers/backoffice.ts';
import { fullLegacyCompany } from '../helpers/company-fixtures.ts';
import { fullLegacyPlace } from '../helpers/place-fixtures.ts';
import { accessFor } from '../helpers/group-access.ts';
import { fixtureId, legacyGroup } from '../helpers/legacy-fixtures.ts';
import { insertCopies } from '../helpers/mirror.ts';
import { openTestDatabases, TEST_CLUSTER } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { startPlacesWorld } from '../helpers/places.ts';
import type { PlacesWorld } from '../helpers/places.ts';
import { principalOf } from '../helpers/principal.ts';
import { TEST_VERSION_KEY } from '../helpers/version-key.ts';
import { groupReaders } from '../helpers/user-deps.ts';
import { actors } from '../helpers/users.ts';

let ctx: TestDatabases;
let world: PlacesWorld;
const call = (...args: Parameters<PlacesWorld['as']['call']>) => world.as.call(...args);
const failure = (reply: Awaited<ReturnType<typeof call>>) => world.as.failure(reply);
const hex = (id: ObjectId) => id.toHexString();
const psa = () => world.office.cluster.psa;
const dealerA = () => world.office.cluster.dealerA;
const dealerB = () => world.office.cluster.dealerB;
const g0 = () => world.group(0);
const g1 = () => world.group(1);
const g2 = () => world.group(2);
const denied = { status: 403, code: 'FORBIDDEN', details: undefined };
const notFound = { status: 404, code: 'NOT_FOUND', details: undefined };
const invalid = (...details: Array<[string, string]>) => ({ status: 422, code: 'VALIDATION_ERROR', details: details.map(([field, issue]) => ({ field, issue })) });
const trashPath = (kind: string, action: string, group = g0()) => `/groups/${hex(group.groupId)}/trash/${kind}/${action}`;
const company = (n: number) => fixtureId('company', n);
const place = (n: number) => fixtureId('place', n);
const DATE = new Date('2026-11-01T08:00:00.000Z');
const entries = (from: number) => world.office.activity.entries.slice(from);
const mark = (): number => world.office.activity.entries.length;
const FULL = { status: true, groups: { r: true, w: true }, users: { r: true, w: true }, companies: { r: true, w: true }, places: { r: true, w: true }, logs: { r: true, w: true }, stats: { r: true, w: false }, apps: { cash: { status: true, sub: { discounts: true } } } };
const common = () => ctx.databases.common();
const users = () => common().collection('users');
const groupDb = (group = g0()) => ctx.databases.group(group.groupId, 'cluster0');

/** The result of a call, as `[id, outcome, issue?]` lines. */
const lines = (reply: Awaited<ReturnType<typeof call>>): Array<[string, string, string?]> =>
  reply.body.data.results.map((item: { id: string; outcome: string; issue?: string }) => (item.issue === undefined ? [item.id, item.outcome] : [item.id, item.outcome, item.issue]));

/** A user of the first group (an SA unless told otherwise) with the whole matrix, in the trash when asked. */
const freshUser = async (overrides: Document = {}, group = g0()): Promise<ObjectId> => (await addUser(ctx, world.office, { permissions: FULL, groupId: group.groupId, dealerId: group.dealerId, ...overrides })).id;
const freshPa = (overrides: Document = {}, group = g0(), placeId = place(1)): Promise<ObjectId> => freshUser({ role: 'PA', companyId: company(1), placeId, placesId: [placeId], ...overrides }, group);
const trashedPa = (overrides: Document = {}, group = g0(), placeId = place(1)) => freshPa({ trash: true, trashDate: DATE, ...overrides }, group, placeId);

before(async () => {
  ctx = await openTestDatabases();
  world = await startPlacesWorld(ctx);
});
after(async () => {
  await world.office.close();
  await ctx.cleanup();
});

describe('POST /v1/groups/{groupId}/trash/companies/restore', () => {
  it('restores each company as the single-item restore does, in the order of the request, and one failing item never stops the others', async () => {
    const restorable = await world.seed(0, 800, { code: 'TR-800', trash: true, trashDate: DATE });
    const legacy = await world.seed(0, 801, { code: 'TR-801', trash: true });
    const taken = await world.seed(0, 802, { code: 'TR-802', trash: true, trashDate: DATE });
    await world.seed(0, 803, { code: 'TR-802' });
    const active = await world.seed(0, 804, { code: 'TR-804' });
    const otherGroup = await world.seed(1, 805, { code: 'TR-805', trash: true, trashDate: DATE });
    const unknown = new ObjectId();
    const from = mark();
    const reply = await call(g0().sa, 'POST', trashPath('companies', 'restore'), { ids: [hex(restorable), hex(taken), hex(active), hex(unknown), hex(otherGroup), hex(legacy), hex(restorable)] });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.deepEqual(lines(reply), [
      [hex(restorable), 'restored'],
      [hex(taken), 'skipped', 'taken'],
      [hex(active), 'skipped', 'notTrashed'],
      [hex(unknown), 'skipped', 'notFound'],
      [hex(otherGroup), 'skipped', 'notFound'],
      [hex(legacy), 'restored'],
    ]);
    // The flag goes down and the date goes away, in the original and in the copy.
    for (const id of [restorable, legacy]) {
      assert.equal((await world.stored(0, id))!['trash'], false);
      assert.equal(Object.hasOwn((await world.stored(0, id))!, 'trashDate'), false);
      assert.equal(Object.hasOwn((await world.copyOf(id))!, 'trashDate'), false);
      assert.equal((await world.copyOf(id))!['trash'], false);
    }
    // What was refused is as it was, and what lives in another group is untouched.
    assert.equal((await world.stored(0, taken))!['trash'], true);
    assert.deepEqual((await world.stored(1, otherGroup))!['trashDate'], DATE);
    assert.equal((await world.stored(1, otherGroup))!['trash'], true);
    const log = entries(from);
    assert.deepEqual(log.filter((entry) => entry.action === 'company.restored').map((entry) => entry.resource!.id), [hex(restorable), hex(legacy)]);
    const [bulk] = log.filter((entry) => entry.action === 'trash.bulkRestored');
    assert.deepEqual([bulk!.category, bulk!.outcome, bulk!.groupId, bulk!.resource, bulk!.metadata, bulk!.actor.id], ['data', 'success', g0().groupId, { type: 'trash', id: 'companies' }, { kind: 'companies', requested: 6, restored: 2, skipped: 4 }, g0().sa]);
    assert.ok(!JSON.stringify(bulk).includes(hex(restorable)), 'the entry of the call carries no id');
    const definition = ACTION_CATALOG.get('trash.bulkRestored')!;
    assert.deepEqual(definition.categories, ['data']);
    assert.ok(Object.keys(bulk!.metadata!).every((key) => definition.metadataKeys.includes(key)));
  });

  it('shows the date of the trash of the companies in the list of the trash, and nothing for a company the legacy trashed', async () => {
    const dated = await world.seed(0, 810, { code: 'TR-810', trash: true, trashDate: DATE });
    const legacy = await world.seed(0, 811, { code: 'TR-811', trash: true });
    const junk = await world.seed(0, 812, { code: 'TR-812', trash: true, trashDate: 'yesterday' });
    const items: Array<{ id: string; trashedAt: string | null }> = (await call(g0().sa, 'GET', world.path(0, '?trashed=true&limit=200'))).body.data;
    const at = (id: ObjectId) => items.find((item) => item.id === hex(id))!.trashedAt;
    assert.deepEqual([at(dated), at(legacy), at(junk)], [DATE.toISOString(), null, null]);
    assert.equal((await call(g0().sa, 'GET', world.path(0, `/${hex(dated)}`))).body.data.trashedAt, DATE.toISOString());
    assert.equal((await call(g0().sa, 'GET', world.path(0, `/${hex(legacy)}`))).body.data.trashedAt, null);
  });

  it('is open to whoever may restore companies, and refuses everybody else with 403, whatever the body says', async () => {
    const id = await world.seed(0, 820, { code: 'TR-820', trash: true, trashDate: DATE });
    const body = { ids: [hex(id)] };
    // A CA and a PA may restore users but not companies.
    for (const actor of [g0().ca, g0().pa]) {
      assert.deepEqual(failure(await call(actor, 'POST', trashPath('companies', 'restore'), body)), denied);
    }
    // The permission is checked before the body is.
    assert.deepEqual(failure(await call(g0().ca, 'POST', trashPath('companies', 'restore'), { ids: [] })), denied);
    assert.deepEqual(failure(await call(g0().sa, 'POST', trashPath('companies', 'restore'), { ids: [] })), invalid(['ids', 'minLength']));
    // A group out of the perimeter is hidden, for the SA of another group and for the dealer of other groups.
    assert.deepEqual(failure(await call(g1().sa, 'POST', trashPath('companies', 'restore'), body)), notFound);
    assert.deepEqual(failure(await call(dealerB(), 'POST', trashPath('companies', 'restore'), body)), notFound);
    assert.equal((await world.stored(0, id))!['trash'], true);
    // The company of another group of the same dealer is not found through this group.
    const reply = await call(dealerA(), 'POST', trashPath('companies', 'restore'), body);
    assert.deepEqual(lines(reply), [[hex(id), 'restored']]);
  });

  it('keeps the company administrator inside his companies: what he cannot see is not found', async () => {
    const own = await world.seed(0, 821, { code: 'TR-821', trash: true, trashDate: DATE });
    // The CA has no permission to restore companies (it is the PSA, the dealers and the SA who do): the single-item route is the same.
    assert.equal((await call(g0().ca, 'POST', world.path(0, `/${hex(own)}/restore`), undefined, { 'if-match': '"x"' })).status, 403);
    assert.deepEqual(failure(await call(g0().ca, 'POST', trashPath('companies', 'restore'), { ids: [hex(own)] })), denied);
  });
});

describe('the permission of each kind', () => {
  it('is the one of the route: an SA who may delete places but not companies is refused on the companies only, and a dealer, whose permissions are always whole, is audited as granted', async () => {
    const sa = await freshUser({ permissions: { ...FULL, companies: { r: true, w: false } } });
    const id = await world.seed(0, 890, { code: 'TR-890', trash: true });
    assert.deepEqual(failure(await call(sa, 'POST', trashPath('companies', 'delete'), { ids: [hex(id)] })), denied);
    assert.deepEqual(failure(await call(sa, 'POST', trashPath('companies', 'restore'), { ids: [hex(id)] })), denied);
    const placeId = await world.seedPlace(0, 891, 1, { trash: true });
    assert.deepEqual(lines(await call(sa, 'POST', trashPath('places', 'delete'), { ids: [hex(placeId)] })), [[hex(placeId), 'deleted']]);
    // The access of a dealer to a group is audited once the permission is granted, by the check of the route itself (the group is one the dealer has not reached in this test).
    const from = mark();
    const other = await world.seed(1, 892, { code: 'TR-892', trash: true });
    assert.deepEqual(lines(await call(dealerA(), 'POST', trashPath('companies', 'delete', g1()), { ids: [hex(other)] })), [[hex(other), 'deleted']]);
    assert.deepEqual(entries(from).filter((entry) => entry.action === 'group.crossAccess').map((entry) => [entry.outcome, entry.groupId]), [['success', g1().groupId]]);
  });
});

describe('POST /v1/groups/{groupId}/trash/companies/delete', () => {
  it('deletes each trashed company as the single-item deletion does, with its copy, and tells why an item was not deleted', async () => {
    const gone = await world.seed(0, 830, { code: 'TR-830', trash: true, trashDate: DATE });
    const referenced = await world.seed(0, 831, { code: 'TR-831', trash: true, trashDate: DATE });
    await world.seedPlace(0, 8310, 831, { trash: true });
    const active = await world.seed(0, 832, { code: 'TR-832' });
    const unknown = new ObjectId();
    const otherGroup = await world.seed(1, 833, { code: 'TR-833', trash: true });
    const from = mark();
    const reply = await call(g0().sa, 'POST', trashPath('companies', 'delete'), { ids: [hex(gone), hex(referenced), hex(active), hex(unknown), hex(otherGroup), hex(gone)] });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.deepEqual(lines(reply), [
      [hex(gone), 'deleted'],
      [hex(referenced), 'skipped', 'referenced'],
      [hex(active), 'skipped', 'notTrashed'],
      [hex(unknown), 'skipped', 'notFound'],
      [hex(otherGroup), 'skipped', 'notFound'],
    ]);
    assert.equal(await world.stored(0, gone), null);
    assert.equal(await world.copyOf(gone), null);
    for (const id of [referenced, active]) {
      assert.notEqual(await world.stored(0, id), null);
      assert.notEqual(await world.copyOf(id), null);
    }
    assert.notEqual(await world.stored(1, otherGroup), null);
    const log = entries(from);
    assert.deepEqual(log.filter((entry) => entry.action === 'company.deleted').map((entry) => entry.resource!.id), [hex(gone)]);
    const [bulk] = log.filter((entry) => entry.action === 'trash.bulkDeleted');
    assert.deepEqual([bulk!.groupId, bulk!.resource, bulk!.metadata], [g0().groupId, { type: 'trash', id: 'companies' }, { kind: 'companies', requested: 5, deleted: 1, skipped: 4 }]);
  });

  it('is limited by companies:delete, in the permission and in the perimeter', async () => {
    const id = await world.seed(0, 835, { code: 'TR-835', trash: true });
    for (const actor of [g0().ca, g0().pa]) {
      assert.deepEqual(failure(await call(actor, 'POST', trashPath('companies', 'delete'), { ids: [hex(id)] })), denied);
    }
    assert.deepEqual(failure(await call(dealerB(), 'POST', trashPath('companies', 'delete'), { ids: [hex(id)] })), notFound);
    assert.deepEqual(lines(await call(dealerA(), 'POST', trashPath('companies', 'delete'), { ids: [hex(id)] })), [[hex(id), 'deleted']]);
  });
});

describe('the bulk operations on places', () => {
  it('restores and deletes places with the rules of the single-item routes', async () => {
    const trashed = await world.seedPlace(0, 840, 1, { trash: true, trashDate: DATE });
    const legacy = await world.seedPlace(0, 841, 1, { trash: true });
    const active = await world.seedPlace(0, 842, 1);
    const used = await world.seedPlace(0, 843, 1, { trash: true, trashDate: DATE });
    await freshPa({}, g0(), used);
    const unknown = new ObjectId();
    const otherGroup = await world.seedPlace(1, 844, 3, { trash: true, trashDate: DATE });
    const from = mark();
    const restored = await call(g0().sa, 'POST', trashPath('places', 'restore'), { ids: [hex(trashed), hex(active), hex(unknown), hex(otherGroup), hex(trashed)] });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.deepEqual(lines(restored), [
      [hex(trashed), 'restored'],
      [hex(active), 'skipped', 'notTrashed'],
      [hex(unknown), 'skipped', 'notFound'],
      [hex(otherGroup), 'skipped', 'notFound'],
    ]);
    assert.equal((await world.storedPlace(0, trashed))!['trash'], false);
    assert.equal(Object.hasOwn((await world.storedPlace(0, trashed))!, 'trashDate'), false);
    assert.equal(Object.hasOwn((await world.copyOfPlace(trashed))!, 'trashDate'), false);
    assert.equal((await world.storedPlace(1, otherGroup))!['trash'], true);
    const deleted = await call(g0().sa, 'POST', trashPath('places', 'delete'), { ids: [hex(legacy), hex(used), hex(active), hex(trashed), hex(unknown), hex(otherGroup)] });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.deepEqual(lines(deleted), [
      [hex(legacy), 'deleted'],
      [hex(used), 'skipped', 'referenced'],
      [hex(active), 'skipped', 'notTrashed'],
      [hex(trashed), 'skipped', 'notTrashed'],
      [hex(unknown), 'skipped', 'notFound'],
      [hex(otherGroup), 'skipped', 'notFound'],
    ]);
    assert.equal(await world.storedPlace(0, legacy), null);
    assert.equal(await world.copyOfPlace(legacy), null);
    assert.notEqual(await world.storedPlace(0, used), null);
    const log = entries(from);
    assert.deepEqual(log.filter((entry) => entry.action === 'place.restored' || entry.action === 'place.deleted').map((entry) => [entry.action, entry.resource!.id]), [['place.restored', hex(trashed)], ['place.deleted', hex(legacy)]]);
    assert.deepEqual(
      log.filter((entry) => entry.action.startsWith('trash.')).map((entry) => [entry.action, entry.metadata]),
      [
        ['trash.bulkRestored', { kind: 'places', requested: 4, restored: 1, skipped: 3 }],
        ['trash.bulkDeleted', { kind: 'places', requested: 6, deleted: 1, skipped: 5 }],
      ],
    );
  });

  it('refuses the roles that cannot restore or delete places, and lets the dealer restore them', async () => {
    const own = await world.seedPlace(0, 845, 1, { trash: true, trashDate: DATE });
    const other = await world.seedPlace(0, 846, 2, { trash: true, trashDate: DATE });
    // Only the PSA, the dealers and the SA restore and delete places (`places:trash`, `places:delete`): a CA and a PA are refused, the PA on the kind and not on the route.
    for (const actor of [g0().ca, g0().pa]) {
      assert.deepEqual(failure(await call(actor, 'POST', trashPath('places', 'restore'), { ids: [hex(other), hex(own)] })), denied);
    }
    assert.deepEqual(failure(await call(g0().ca, 'POST', trashPath('places', 'delete'), { ids: [hex(own)] })), denied);
    assert.deepEqual(failure(await call(g0().pa, 'POST', trashPath('places', 'delete'), { ids: [hex(own)] })), denied);
    assert.deepEqual(lines(await call(dealerA(), 'POST', trashPath('places', 'restore'), { ids: [hex(other), hex(own)] })), [[hex(other), 'restored'], [hex(own), 'restored']]);
  });
});

describe('the bulk operations on users', () => {
  it('restores and deletes users with the rules of the single-item routes, scope and anti-escalation included', async () => {
    const trashed = await trashedPa();
    const active = await freshPa();
    const unknown = new ObjectId();
    const otherGroup = await trashedPa({}, g1(), place(3));
    const psaUser = psa();
    const from = mark();
    const restored = await call(g0().sa, 'POST', trashPath('users', 'restore'), { ids: [hex(trashed), hex(active), hex(unknown), hex(otherGroup), hex(psaUser), hex(trashed)] });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.deepEqual(lines(restored), [
      [hex(trashed), 'restored'],
      [hex(active), 'skipped', 'notTrashed'],
      [hex(unknown), 'skipped', 'notFound'],
      [hex(otherGroup), 'skipped', 'notFound'],
      [hex(psaUser), 'skipped', 'notFound'],
    ]);
    const stored = (await users().findOne({ _id: trashed }))!;
    assert.equal(stored['trash'], false);
    assert.equal(Object.hasOwn(stored, 'trashDate'), false);
    assert.equal((await users().findOne({ _id: otherGroup }))!['trash'], true);
    assert.deepEqual(entries(from).filter((entry) => entry.action === 'user.restored').map((entry) => entry.resource!.id), [hex(trashed)]);
    assert.deepEqual(entries(from).filter((entry) => entry.action === 'trash.bulkRestored').map((entry) => entry.metadata), [{ kind: 'users', requested: 5, restored: 1, skipped: 4 }]);

    const victim = await trashedPa();
    await world.office.activity.entries.length;
    const deleted = await call(g0().sa, 'POST', trashPath('users', 'delete'), { ids: [hex(victim), hex(active), hex(unknown), hex(otherGroup), hex(victim)] });
    assert.deepEqual(lines(deleted), [
      [hex(victim), 'deleted'],
      [hex(active), 'skipped', 'notTrashed'],
      [hex(unknown), 'skipped', 'notFound'],
      [hex(otherGroup), 'skipped', 'notFound'],
    ]);
    assert.equal(await users().countDocuments({ _id: victim }), 1 - 1);
    assert.equal(await common().collection('userCredentials').countDocuments({ _id: victim }), 0);
    assert.equal(await users().countDocuments({ _id: otherGroup }), 1);
    assert.deepEqual(entries(from).filter((entry) => entry.action === 'user.deleted').map((entry) => [entry.resource!.id, entry.metadata]), [[hex(victim), { role: 'PA' }]]);
  });

  it('answers forbidden for a user the caller may see but not manage, and keeps what a role cannot reach out of the results', async () => {
    // The CA sees the users of his company and restores them (`users:trash`), but not a PA who also has a place of another company's: that user is out of his reach.
    const mixed = await trashedPa({ placeId: place(1), placesId: [place(1), place(2)] });
    const own = await trashedPa();
    const employeeOfOtherPlace = await freshUser({ role: 'E', trash: true, trashDate: DATE, placeId: place(2), placesId: [place(2)] });
    const saUser = await freshUser({ trash: true, trashDate: DATE });
    const reply = await call(g0().ca, 'POST', trashPath('users', 'restore'), { ids: [hex(mixed), hex(own), hex(employeeOfOtherPlace), hex(saUser)] });
    assert.deepEqual(lines(reply), [
      [hex(mixed), 'skipped', 'forbidden'],
      [hex(own), 'restored'],
      [hex(employeeOfOtherPlace), 'skipped', 'notFound'],
      [hex(saUser), 'skipped', 'notFound'],
    ]);
    // A restricted SA cannot delete a user who holds more than he does.
    const restricted = await freshUser({ permissions: { ...FULL, status: false, logs: { r: false, w: false }, companies: { r: true, w: false } } });
    const strong = await freshUser({ trash: true, trashDate: DATE });
    assert.deepEqual(lines(await call(restricted, 'POST', trashPath('users', 'delete'), { ids: [hex(strong)] })), [[hex(strong), 'skipped', 'forbidden']]);
    assert.equal(await users().countDocuments({ _id: strong }), 1);
    // The roles without users:delete cannot delete at all; a PA can restore users but not a user outside his place.
    assert.deepEqual(failure(await call(g0().ca, 'POST', trashPath('users', 'delete'), { ids: [hex(strong)] })), denied);
    assert.deepEqual(failure(await call(g0().pa, 'POST', trashPath('users', 'delete'), { ids: [hex(strong)] })), denied);
    assert.deepEqual(lines(await call(g0().pa, 'POST', trashPath('users', 'restore'), { ids: [hex(mixed), hex(employeeOfOtherPlace)] })), [[hex(mixed), 'skipped', 'forbidden'], [hex(employeeOfOtherPlace), 'skipped', 'notFound']]);
  });
});

describe('POST /v1/groups/{groupId}/trash/{kind}/…: the request', () => {
  it('accepts 1 to 100 ids, removes the duplicates, and refuses everything else with 422', async () => {
    const many = Array.from({ length: 100 }, () => hex(new ObjectId()));
    const reply = await call(g0().sa, 'POST', trashPath('companies', 'restore'), { ids: [...many, ...many.slice(0, 10)].slice(0, 100) });
    assert.equal(reply.status, 200);
    assert.equal(reply.body.data.results.length, 100);
    assert.ok(lines(reply).every(([, outcome, issue]) => outcome === 'skipped' && issue === 'notFound'));
    const body = (value: unknown) => call(g0().sa, 'POST', trashPath('companies', 'delete'), value);
    assert.deepEqual(failure(await body({ ids: Array.from({ length: 101 }, () => hex(new ObjectId())) })), invalid(['ids', 'tooMany']));
    assert.deepEqual(failure(await body({ ids: [] })), invalid(['ids', 'minLength']));
    assert.deepEqual(failure(await body({})), invalid(['ids', 'required']));
    assert.deepEqual(failure(await body({ ids: 'x' })), invalid(['ids', 'type']));
    assert.deepEqual(failure(await body({ ids: ['not-an-id'] })), invalid(['ids.0', 'format']));
    assert.deepEqual(failure(await body({ ids: [5] })), invalid(['ids.0', 'type']));
    assert.deepEqual(failure(await body({ ids: [hex(new ObjectId())], extra: 1 })), invalid(['extra', 'unknown']));
    assert.deepEqual(failure(await body({ ids: [hex(new ObjectId())], $where: 'x' })), invalid(['(key)', 'forbiddenKey']));
    assert.deepEqual(failure(await call(g0().sa, 'POST', trashPath('companies', 'delete'))), invalid(['(body)', 'required']));
    assert.deepEqual(failure(await call(g0().sa, 'POST', trashPath('cats', 'delete'), { ids: [hex(new ObjectId())] })), invalid(['kind', 'enum']));
    assert.deepEqual(failure(await call(g0().sa, 'POST', trashPath('groups', 'restore'), { ids: [hex(new ObjectId())] })), invalid(['kind', 'enum']));
    assert.equal((await call(g0().sa, 'POST', trashPath('companies', 'purge'), { ids: [hex(new ObjectId())] })).status, 404);
    assert.equal((await call(g0().sa, 'POST', `/groups/not-an-id/trash/companies/restore`, { ids: [hex(new ObjectId())] })).status, 404);
    // Mixed case in an id is the same id.
    const id = await world.seed(0, 850, { code: 'TR-850', trash: true });
    assert.deepEqual(lines(await call(g0().sa, 'POST', trashPath('companies', 'restore'), { ids: [hex(id).toUpperCase()] })), [[hex(id), 'restored']]);
  });
});

describe('POST /v1/groups/{groupId}/trash/{kind}/empty', () => {
  it('empties a tab, 200 items at a time in the order of the ids, and tells how many are left', async () => {
    const group = g2();
    const documents = Array.from({ length: 205 }, (_, index) => fullLegacyCompany(1000 + index, group.groupId, { code: `EMP-${String(index)}`, trash: true, trashDate: DATE }));
    await groupDb(group).collection('companies').insertMany(documents);
    await insertCopies(ctx.databases, 'companies', documents);
    // The first one (the lowest id) is kept by a place that refers to it.
    await world.seedPlace(2, 1100, 1000, { trash: true });
    const ids = documents.map((document) => hex(document['_id'] as ObjectId));
    const from = mark();
    const first = await call(psa(), 'POST', trashPath('companies', 'empty', group));
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.data.results.length, 200);
    assert.deepEqual(first.body.data.results.map((item: { id: string }) => item.id), ids.slice(0, 200));
    assert.deepEqual(lines(first)[0], [ids[0]!, 'skipped', 'referenced']);
    assert.ok(lines(first).slice(1).every(([, outcome]) => outcome === 'deleted'));
    assert.equal(first.body.data.remaining, 6);
    assert.equal(first.body.data.next, ids[199], 'a full call says where to go on');
    // The next call starts after the last item processed: the one that could not be deleted is not met again.
    const second = await call(psa(), 'POST', trashPath('companies', 'empty', group), { after: first.body.data.next });
    assert.deepEqual(lines(second), ids.slice(200).map((id) => [id, 'deleted']));
    assert.deepEqual([second.body.data.remaining, second.body.data.next], [1, null]);
    // Without a cursor the walk starts again, and finds only what is left.
    const third = await call(psa(), 'POST', trashPath('companies', 'empty', group));
    assert.deepEqual([lines(third), third.body.data.remaining, third.body.data.next], [[[ids[0], 'skipped', 'referenced']], 1, null]);
    assert.equal(await groupDb(group).collection('companies').countDocuments({ trash: true }), 1);
    assert.equal(await common().collection('companies').countDocuments({ groupId: group.groupId, trash: true }), 1);
    const log = entries(from);
    assert.deepEqual(log.filter((entry) => entry.action === 'trash.emptied').map((entry) => entry.metadata), [
      { kind: 'companies', requested: 200, deleted: 199, skipped: 1 },
      { kind: 'companies', requested: 5, deleted: 5, skipped: 0 },
      { kind: 'companies', requested: 1, deleted: 0, skipped: 1 },
    ]);
    assert.equal(log.filter((entry) => entry.action === 'company.deleted').length, 204);
  });

  it('reaches the items that can be deleted behind more than 200 that cannot', async () => {
    const group = world.group(3);
    const kept = Array.from({ length: 201 }, (_, index) => fullLegacyCompany(2000 + index, group.groupId, { code: `KEP-${String(index)}`, trash: true }));
    const free = Array.from({ length: 3 }, (_, index) => fullLegacyCompany(2300 + index, group.groupId, { code: `FRE-${String(index)}`, trash: true }));
    await groupDb(group).collection('companies').insertMany([...kept, ...free]);
    await insertCopies(ctx.databases, 'companies', [...kept, ...free]);
    const places = kept.map((document, index) => fullLegacyPlace(3000 + index, group.groupId, document['_id'] as ObjectId, { trash: true }));
    await groupDb(group).collection('places').insertMany(places);
    await insertCopies(ctx.databases, 'places', places);
    const first = await call(psa(), 'POST', trashPath('companies', 'empty', group));
    assert.ok(lines(first).every(([, outcome, issue]) => outcome === 'skipped' && issue === 'referenced'));
    assert.deepEqual([first.body.data.results.length, first.body.data.remaining, first.body.data.next], [200, 204, hex(kept[199]!['_id'] as ObjectId)]);
    const second = await call(psa(), 'POST', trashPath('companies', 'empty', group), { after: first.body.data.next });
    assert.deepEqual(lines(second).map(([, outcome]) => outcome), ['skipped', 'deleted', 'deleted', 'deleted']);
    assert.deepEqual([second.body.data.remaining, second.body.data.next], [201, null]);
    assert.equal(await groupDb(group).collection('companies').countDocuments({ trash: true }), 201);
  });

  it('empties the places and the users of a group, and an empty tab answers with nothing left', async () => {
    const group = g2();
    const gone = await world.seedPlace(2, 1200, 5, { trash: true });
    const kept = await world.seedPlace(2, 1201, 5, { trash: true });
    await freshPa({}, group, kept);
    const places = await call(psa(), 'POST', trashPath('places', 'empty', group));
    assert.deepEqual([lines(places).filter(([id]) => id === hex(gone) || id === hex(kept)), places.body.data.remaining], [[[hex(gone), 'deleted'], [hex(kept), 'skipped', 'referenced']], 1]);
    assert.deepEqual(lines(await call(psa(), 'POST', trashPath('places', 'empty', group), { after: hex(new ObjectId(Buffer.alloc(12, 255))) })), []);
    const trashed = [await trashedPa({}, group, place(5)), await trashedPa({}, group, place(5))];
    const emptied = await call(psa(), 'POST', trashPath('users', 'empty', group));
    assert.deepEqual(lines(emptied).map(([id, outcome]) => [id, outcome]), trashed.map((id) => [hex(id), 'deleted']));
    assert.deepEqual([emptied.body.data.remaining, emptied.body.data.next], [0, null]);
    // A cursor past every item finds nothing; one before them finds them (users and places walk by the same rule).
    assert.deepEqual(lines(await call(psa(), 'POST', trashPath('users', 'empty', group), { after: hex(new ObjectId(Buffer.alloc(12, 255))) })), []);
    assert.deepEqual(lines(await call(psa(), 'POST', trashPath('users', 'empty', group))), []);
  });

  it('is the PSA\'s alone, in the permission and in the perimeter, and takes no body', async () => {
    for (const actor of [dealerA(), g0().sa, g0().ca, g0().pa]) {
      assert.deepEqual(failure(await call(actor, 'POST', trashPath('companies', 'empty'))), denied);
    }
    assert.deepEqual(failure(await call(psa(), 'POST', trashPath('companies', 'empty'), { all: true })), invalid(['all', 'unknown']));
    assert.deepEqual(failure(await call(psa(), 'POST', trashPath('companies', 'empty'), { after: 'nope' })), invalid(['after', 'format']));
    assert.deepEqual(failure(await call(psa(), 'POST', trashPath('companies', 'empty'), { after: 5 })), invalid(['after', 'type']));
    assert.deepEqual(failure(await call(psa(), 'POST', trashPath('cats', 'empty'))), invalid(['kind', 'enum']));
    assert.equal((await call(psa(), 'POST', `/groups/${hex(new ObjectId())}/trash/companies/empty`)).status, 404);
    // The permission shows in the profile of the PSA and of nobody else.
    for (const [actor, expected] of [[psa(), true], [dealerA(), false], [g0().sa, false]] as const) {
      assert.equal(((await call(actor, 'GET', '/me')).body.data.permissions as string[]).includes('trash:empty'), expected);
    }
    // A body that is not an object is refused too.
    assert.equal((await call(psa(), 'POST', trashPath('companies', 'empty'), [])).status, 422);
  });
});

describe('POST /v1/trash/groups/restore', () => {
  it('restores groups platform-wide, as the single-item restore does, and never deletes one', async () => {
    const trashed = fixtureId('group', 70);
    const legacy = fixtureId('group', 71);
    const active = fixtureId('group', 72);
    await common().collection('groups').insertMany([
      legacyGroup(70, { dealerId: dealerA(), trash: true, trashDate: DATE }),
      legacyGroup(71, { dealerId: dealerB(), trash: true }),
      legacyGroup(72, { dealerId: dealerA() }),
    ]);
    const unknown = new ObjectId();
    const from = mark();
    const reply = await call(psa(), 'POST', '/trash/groups/restore', { ids: [hex(trashed), hex(active), hex(unknown), hex(legacy), hex(trashed)] });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.deepEqual(lines(reply), [
      [hex(trashed), 'restored'],
      [hex(active), 'skipped', 'notTrashed'],
      [hex(unknown), 'skipped', 'notFound'],
      [hex(legacy), 'restored'],
    ]);
    for (const id of [trashed, legacy]) {
      const stored = (await common().collection('groups').findOne({ _id: id }))!;
      assert.equal(stored['trash'], false);
      assert.equal(Object.hasOwn(stored, 'trashDate'), false);
    }
    // The PSA's access to every group the call reached is audited like the one of a `:groupId` route; a group that does not exist is not an access.
    assert.deepEqual(entries(from).filter((entry) => entry.action === 'group.crossAccess').map((entry) => [entry.outcome, entry.groupId]), [trashed, active, legacy].map((id) => ['success', id]));
    assert.deepEqual(entries(from).filter((entry) => entry.action === 'group.restored' && entry.category === 'data').map((entry) => entry.resource!.id), [hex(trashed), hex(legacy)]);
    const [bulk] = entries(from).filter((entry) => entry.action === 'trash.bulkRestored');
    assert.deepEqual([bulk!.groupId, bulk!.resource, bulk!.metadata], [undefined, { type: 'trash', id: 'groups' }, { kind: 'groups', requested: 4, restored: 2, skipped: 2 }]);
    // Only the PSA restores groups.
    for (const actor of [dealerA(), g0().sa, g0().ca]) {
      assert.deepEqual(failure(await call(actor, 'POST', '/trash/groups/restore', { ids: [hex(trashed)] })), denied);
    }
    assert.deepEqual(failure(await call(psa(), 'POST', '/trash/groups/restore', { ids: [] })), invalid(['ids', 'minLength']));
    assert.deepEqual(failure(await call(psa(), 'POST', '/trash/groups/restore', { ids: ['x'] })), invalid(['ids.0', 'format']));
    assert.equal((await call(psa(), 'POST', '/trash/groups/delete', { ids: [hex(trashed)] })).status, 404);
  });

  it('writes the date of the trash with the group and removes it with the restore, and shows it as trashedAt', async () => {
    const id = fixtureId('group', 73);
    await common().collection('groups').insertOne(legacyGroup(73, { dealerId: dealerA() }));
    const trashed = await call(psa(), 'POST', `/groups/${hex(id)}/trash`);
    assert.equal(trashed.status, 200, JSON.stringify(trashed.body));
    const stored = (await common().collection('groups').findOne({ _id: id }))!;
    assert.ok(stored['trashDate'] instanceof Date);
    assert.equal(trashed.body.data.trashedAt, (stored['trashDate'] as Date).toISOString());
    const listed = (await call(psa(), 'GET', '/groups?trashed=true&limit=200')).body.data.find((item: { id: string }) => item.id === hex(id));
    assert.equal(listed.trashedAt, (stored['trashDate'] as Date).toISOString());
    assert.equal((await call(psa(), 'GET', `/groups/${hex(id)}`)).body.data.trashedAt, (stored['trashDate'] as Date).toISOString());
    const restored = await call(psa(), 'POST', `/groups/${hex(id)}/restore`);
    assert.equal(restored.body.data.trashedAt, null);
    assert.equal(Object.hasOwn((await common().collection('groups').findOne({ _id: id }))!, 'trashDate'), false);
    // A group the legacy trashed has no date.
    const legacy = fixtureId('group', 74);
    await common().collection('groups').insertOne(legacyGroup(74, { dealerId: dealerA(), trash: true }));
    const other = (await call(psa(), 'GET', '/groups?trashed=true&limit=200')).body.data.find((item: { id: string }) => item.id === hex(legacy));
    assert.equal(other.trashedAt, null);
  });
});

describe('the date of the trash of a user', () => {
  it('is written with the flag, removed with the restore, and shown as trashedAt in the detail and in the list', async () => {
    const id = await freshPa();
    const path = (rest = '') => `/groups/${hex(g0().groupId)}/users/${hex(id)}${rest}`;
    const trashed = await call(g0().sa, 'POST', path('/trash'));
    assert.equal(trashed.status, 200, JSON.stringify(trashed.body));
    const stored = (await users().findOne({ _id: id }))!;
    assert.ok(stored['trashDate'] instanceof Date);
    assert.equal(stored['trashDate'].getTime(), stored['updateDate'].getTime());
    assert.equal(trashed.body.data.trashedAt, (stored['trashDate'] as Date).toISOString());
    assert.equal((await call(g0().sa, 'GET', path())).body.data.trashedAt, (stored['trashDate'] as Date).toISOString());
    const listed = (await call(g0().sa, 'GET', `/groups/${hex(g0().groupId)}/users?trashed=true&limit=100`)).body.data.find((item: { id: string }) => item.id === hex(id));
    assert.equal(listed.trashedAt, (stored['trashDate'] as Date).toISOString());
    const restored = await call(g0().sa, 'POST', path('/restore'));
    assert.equal(restored.body.data.trashedAt, null);
    assert.equal(Object.hasOwn((await users().findOne({ _id: id }))!, 'trashDate'), false);
    // A user the legacy trashed has none.
    const legacy = await freshPa({ trash: true });
    assert.equal((await call(g0().sa, 'GET', `/groups/${hex(g0().groupId)}/users/${hex(legacy)}`)).body.data.trashedAt, null);
    // The date of a place goes with the trash too, and shows in the list of the places.
    const placeId = await world.seedPlace(0, 860, 1);
    const tag = (await call(g0().sa, 'GET', world.placePath(0, `/${hex(placeId)}`))).headers.get('etag')!;
    const trashedPlace = await call(g0().sa, 'POST', world.placePath(0, `/${hex(placeId)}/trash`), undefined, { 'if-match': tag });
    const at = ((await world.storedPlace(0, placeId))!['trashDate'] as Date).toISOString();
    assert.equal(trashedPlace.body.data.trashedAt, at);
    assert.equal((await call(g0().sa, 'GET', world.placePath(0, '?trashed=true&limit=200'))).body.data.find((item: { id: string }) => item.id === hex(placeId)).trashedAt, at);
  });
});

describe('the rate limit of the bulk calls', () => {
  it('counts one call as one request, whatever the number of items', async () => {
    const other = await openTestDatabases();
    const limited = await startBackoffice(other, { env: { RATE_LIMIT_TRASH_ADMIN_PER_USER: '2' } });
    try {
      const as = actors(limited);
      const path = `/groups/${hex(limited.cluster.groups[0]!.groupId)}/trash/companies/delete`;
      const ids = Array.from({ length: 50 }, () => hex(new ObjectId()));
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        statuses.push((await as.call(limited.cluster.psa, 'POST', path, { ids })).status);
      }
      assert.deepEqual(statuses, [200, 200, 429]);
      const limit = await as.call(limited.cluster.psa, 'POST', path, { ids });
      assert.equal(limit.headers.get('retry-after') !== null, true);
      assert.equal((await as.call(limited.cluster.psa, 'GET', '/countries')).status, 200);
    } finally {
      await limited.close();
      await other.cleanup();
    }
  });
});

describe('a concurrent restore during a bulk delete', () => {
  const client = { requestId: 'req-12345678', ip: null, userAgent: null };
  const SA = () => principalOf('PSA');

  /** The trash service over the real services, with the hooks a test needs to restore an item between the read of its version and its deletion. */
  const serviceWith = (hooks: { companies?: (id: ObjectId) => Promise<void>; places?: (id: ObjectId) => Promise<void>; users?: (id: ObjectId) => Promise<void>; restoreUser?: (id: ObjectId) => Promise<void> }) => {
    const activityLog = memoryActivityLog();
    const principal = SA();
    const writerFor = (caller: typeof principal, access: Parameters<typeof companiesPlacesWriter>[1]) => {
      const real = companiesPlacesWriter(caller, access, ctx.databases, { versionKey: TEST_VERSION_KEY });
      return {
        ...real,
        deleteTrashed: async (kind: 'companies' | 'places', id: ObjectId, expected: string) => {
          await (kind === 'companies' ? hooks.companies : hooks.places)?.(id);
          return real.deleteTrashed(kind, id, expected);
        },
      };
    };
    const catalogs = createCatalogsRepository(ctx.databases);
    const companiesRepository = createCompaniesRepository(ctx.databases, catalogs);
    const companies = createCompaniesService({ repository: companiesRepository, writerFor, images: { logoSource: async () => null }, activityLog, newId: () => 'a'.repeat(24) });
    const places = createPlacesService({
      repository: createPlacesRepository(ctx.databases, companiesRepository),
      writerFor,
      readerFor: (caller, access) => companiesPlacesWriter(caller as typeof principal, access, ctx.databases, { versionKey: TEST_VERSION_KEY }),
      logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
      activityLog,
      references: { missing: async () => [] },
      images: { logoSource: async () => null },
      storeKeys: { revokeForPlace: async () => undefined },
      newId: () => 'generated1',
    });
    const usersRepository = createUsersRepository(ctx.databases);
    const usersService = createUsersService({
      config: { legacyPasswordPepper: new Secret(TEST_PEPPER), legacyPasswordCoexistence: true },
      users: {
        ...usersRepository,
        updateOwned: async (id, update, session, onlyIf) => {
          await hooks.restoreUser?.(id);
          return usersRepository.updateOwned(id, update, session, onlyIf);
        },
        deleteTrashed: async (id, session) => {
          await hooks.users?.(id);
          return usersRepository.deleteTrashed(id, session);
        },
      },
      credentials: createCredentialsRepository(ctx.databases),
      sessions: createSessionsRepository(ctx.databases),
      directory: createGroupDirectoryRepository(ctx.databases),
      ...groupReaders(ctx.databases),
      dealers: createDealersRepository(ctx.databases),
      activityLog,
      transaction: (work) => ctx.databases.transaction(work),
      now: () => Date.now(),
    });
    const trash = createTrashService({ companies, places, users: usersService, groups: { restoreFromTrash: async () => ({ done: false, issue: 'notFound' }) }, products: { restoreFromTrash: async () => ({ done: false, issue: 'notFound' }), deleteFromTrash: async () => ({ done: false, issue: 'notFound' }), trashedIds: async () => [], countTrashed: async () => 0 }, activityLog });
    return { trash, activityLog, principal, companies, places };
  };
  const accessOf = async () => (await accessFor(SA(), g0().groupId, TEST_CLUSTER))!;

  it('never deletes a company, a place or a user that was restored in the meantime', async () => {
    const companyId = await world.seed(0, 870, { code: 'TR-870', trash: true, trashDate: DATE });
    const placeId = await world.seedPlace(0, 871, 1, { trash: true, trashDate: DATE });
    const userId = await trashedPa();
    const writer = companiesPlacesWriter(SA(), await accessOf(), ctx.databases, { versionKey: TEST_VERSION_KEY });
    const restoreNow = (kind: 'companies' | 'places') => async (id: ObjectId) => {
      // Somebody else restores the item through the single-item route between the version read and the deletion.
      assert.equal((await writer.restore(kind, id, (await writer.currentVersion(kind, id))!)).outcome, 'written');
    };
    const { trash, principal, activityLog } = serviceWith({
      companies: restoreNow('companies'),
      places: restoreNow('places'),
      users: async (id) => void (await users().updateOne({ _id: id }, { $set: { trash: false } })),
    });
    const access = await accessOf();
    const asked = (id: ObjectId) => [id];
    const companyReply = await trash.remove(principal, access, 'companies', asked(companyId), client);
    assert.deepEqual(companyReply.results, [{ id: hex(companyId), outcome: 'skipped', issue: 'notTrashed' }]);
    assert.equal((await world.stored(0, companyId))!['trash'], false);
    const placeReply = await trash.remove(principal, access, 'places', asked(placeId), client);
    assert.deepEqual(placeReply.results, [{ id: hex(placeId), outcome: 'skipped', issue: 'notTrashed' }]);
    assert.equal((await world.storedPlace(0, placeId))!['trash'], false);
    const userReply = await trash.remove(principal, access, 'users', asked(userId), client);
    assert.deepEqual(userReply.results, [{ id: hex(userId), outcome: 'skipped', issue: 'notTrashed' }]);
    assert.equal(await users().countDocuments({ _id: userId }), 1);
    // The entries of the calls carry no address when the client has none.
    assert.deepEqual(activityLog.entries.filter((entry) => entry.action === 'trash.bulkDeleted').map((entry) => [entry.ip, entry.metadata]), [
      [undefined, { kind: 'companies', requested: 1, deleted: 0, skipped: 1 }],
      [undefined, { kind: 'places', requested: 1, deleted: 0, skipped: 1 }],
      [undefined, { kind: 'users', requested: 1, deleted: 0, skipped: 1 }],
    ]);
  });

  it('lets a fault that is not a refusal of the item reach the central handler instead of hiding it in the results', async () => {
    const id = await world.seed(0, 880, { code: 'TR-880', trash: true, trashDate: DATE });
    const boom = new Error('storage is down');
    const { trash, principal } = serviceWith({
      companies: async () => {
        throw boom;
      },
    });
    await assert.rejects(trash.remove(principal, await accessOf(), 'companies', [id], client), (error: unknown) => error === boom);
    assert.equal((await world.stored(0, id))!['trash'], true);
  });

  it('records the entry of a call that fails half-way, with the outcome failure and the counts so far, and rethrows', async () => {
    const first = await world.seed(0, 881, { code: 'TR-881', trash: true, trashDate: DATE });
    const second = await world.seed(0, 882, { code: 'TR-882', trash: true, trashDate: DATE });
    const third = await world.seed(0, 883, { code: 'TR-883', trash: true, trashDate: DATE });
    const boom = new Error('storage is down');
    const { trash, principal, activityLog } = serviceWith({
      companies: async (id) => {
        if (id.equals(second)) {
          throw boom;
        }
      },
    });
    await assert.rejects(trash.remove(principal, await accessOf(), 'companies', [first, second, third], client), (error: unknown) => error === boom);
    assert.equal(await world.stored(0, first), null);
    assert.notEqual(await world.stored(0, third), null);
    assert.deepEqual(
      activityLog.entries.filter((entry) => entry.action === 'trash.bulkDeleted').map((entry) => [entry.outcome, entry.metadata]),
      [['failure', { kind: 'companies', requested: 3, deleted: 1, skipped: 0 }]],
    );
  });

  it('never skips the version check because an If-Match is missing: only an item of a bulk call takes the version just read', async () => {
    const id = await world.seed(0, 884, { code: 'TR-884', trash: true, trashDate: DATE });
    const placeId = await world.seedPlace(0, 885, 1, { trash: true, trashDate: DATE });
    const { companies, places, principal } = serviceWith({});
    const access = await accessOf();
    const missing = undefined as never;
    for (const run of [
      () => companies.trash(principal, access, id, missing, client),
      () => companies.restore(principal, access, id, missing, client),
      () => companies.remove(principal, access, id, missing, client),
      () => places.trash(principal, access, placeId, missing, client),
      () => places.restore(principal, access, placeId, missing, client),
      () => places.remove(principal, access, placeId, missing, client),
    ]) {
      await assert.rejects(run(), { code: 'PRECONDITION_FAILED' });
    }
    assert.equal((await world.stored(0, id))!['trash'], true);
    assert.equal((await world.storedPlace(0, placeId))!['trash'], true);
  });

  it('restores a user once when two requests restore him together, and records one event', async () => {
    const id = await trashedPa();
    const from = mark();
    const path = `/groups/${hex(g0().groupId)}/users/${hex(id)}/restore`;
    const statuses = (await Promise.all([call(g0().sa, 'POST', path), call(g0().sa, 'POST', path)])).map((reply) => reply.status).sort();
    assert.deepEqual(statuses, [200, 409]);
    assert.equal(entries(from).filter((entry) => entry.action === 'user.restored').length, 1);
    // The same when the other restore lands between the read and the write: the write finds him no longer in the trash.
    const raced = await trashedPa();
    const { trash, principal, activityLog } = serviceWith({ restoreUser: async (userId) => void (await users().updateOne({ _id: userId }, { $set: { trash: false } })) });
    const reply = await trash.restore(principal, await accessOf(), 'users', [raced], client);
    assert.deepEqual(reply.results, [{ id: hex(raced), outcome: 'skipped', issue: 'notTrashed' }]);
    assert.equal(activityLog.entries.filter((entry) => entry.action === 'user.restored').length, 0);
  });
});
