import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { createManagedGroupsRepository } from '../../src/modules/groups/groups.repository.ts';
import { createGroupsService, REVOCATION_BATCH_SIZE } from '../../src/modules/groups/groups.service.ts';
import { sendData } from '../../src/shared/http/envelope.ts';
import { defineRoute } from '../../src/shared/http/routes.ts';
import { memoryActivityLog } from '../helpers/activity.ts';
import { memoryLogger } from '../helpers/app.ts';
import { addUser, startBackoffice, userName } from '../helpers/backoffice.ts';
import type { Backoffice } from '../helpers/backoffice.ts';
import { fixtureId, legacyGroup, legacyUser } from '../helpers/legacy-fixtures.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { principalOf } from '../helpers/principal.ts';
import { actors, send } from '../helpers/users.ts';

let ctx: TestDatabases;
let office: Backoffice;
let as: ReturnType<typeof actors>;

const probe = defineRoute({
  method: 'GET',
  path: '/groups/:groupId/probe',
  auth: { kind: 'user', permission: 'places:read', group: true, feature: 'rooms' },
  handler: (_req, res) => sendData(res, { ok: true }),
});

const g = (index: number) => office.cluster.groups[index]!;
const hex = (id: ObjectId) => id.toHexString();
const path = (index: number, rest = '') => `/groups/${hex(g(index).groupId)}${rest}`;
const groups = () => ctx.databases.common().collection('groups');
const users = () => ctx.databases.common().collection('users');
const sessions = () => ctx.databases.common().collection('sessions');
const stored = async (index: number): Promise<Document> => (await groups().findOne({ _id: g(index).groupId }))!;
const failure = (reply: Awaited<ReturnType<typeof as.call>>) => as.failure(reply);
const denied = { status: 403, code: 'FORBIDDEN', details: undefined };
const notFound = { status: 404, code: 'NOT_FOUND', details: undefined };
const conflict = { status: 409, code: 'CONFLICT', details: undefined };
const entriesSince = (mark: number) => office.activity.entries.slice(mark);

before(async () => {
  ctx = await openTestDatabases();
  office = await startBackoffice(ctx, { extraRoutes: [probe] });
  as = actors(office);
});
after(async () => {
  await office.close();
  await ctx.cleanup();
});

describe('GET /v1/groups/{groupId}', () => {
  it('shows the whole group to the PSA, with the cluster, and no secret of the legacy document', async () => {
    await groups().updateOne({ _id: g(0).groupId }, { $set: { 'settings.languages': 'it;en', 'settings.stats': { openingTime: '06:30', compressProductsCategories: true, timeSlots: [{ start: 0, end: 5 }] }, 'settings.integrations.yellgo': { status: true, apiKey: 'integration-key' } } });
    const reply = await as.call(office.cluster.psa, 'GET', path(0));
    assert.equal(reply.status, 200);
    const data = reply.body.data;
    assert.deepEqual(Object.keys(data).sort(), ['createdAt', 'currencies', 'dataCluster', 'dealerId', 'demo', 'description', 'features', 'fidelityCardRules', 'id', 'integrations', 'languages', 'measureUnits', 'name', 'priceLists', 'status', 'statsSettings', 'taxes', 'trashed', 'updatedAt', 'warehouseRules'].sort());
    assert.deepEqual([data.id, data.name, data.dealerId, data.status, data.trashed, data.demo, data.dataCluster], [hex(g(0).groupId), 'group-001', hex(g(0).dealerId), 'active', false, false, null]);
    assert.deepEqual([data.features.cash, data.features.warehouse, data.features.rooms], [true, true, false]);
    assert.deepEqual(data.languages, ['it', 'en']);
    assert.deepEqual(data.statsSettings, { openingTime: '06:30', compressProductsCategories: true, timeSlots: [{ from: '00:00', to: '06:00' }] });
    assert.deepEqual([data.integrations.yellgo, data.integrations.satispay], [{ enabled: true, apiKeySet: true }, undefined]);
    const text = JSON.stringify(reply.body);
    for (const secret of ['plain-key', 'integration-key', 'databaseHost', 'db.example', 'files.example', 'smtp', 'fixture-secret']) {
      assert.ok(!text.includes(secret), secret);
    }
  });

  it('shows it to the dealer and to the SA of the group without the cluster, and refuses CA and PA by permission', async () => {
    for (const actor of [g(0).dealerId, g(0).sa]) {
      const reply = await as.call(actor, 'GET', path(0));
      assert.equal(reply.status, 200);
      assert.equal('dataCluster' in reply.body.data, false);
    }
    assert.deepEqual(failure(await as.call(g(0).ca, 'GET', path(0))), denied);
    assert.deepEqual(failure(await as.call(g(0).pa, 'GET', path(0))), denied);
  });

  it('does not reveal the group outside the perimeter: other dealer, other group, malformed and unknown ids', async () => {
    assert.deepEqual(failure(await as.call(office.cluster.dealerB, 'GET', path(0))), notFound);
    assert.deepEqual(failure(await as.call(office.cluster.dealerA, 'GET', path(2))), notFound);
    assert.deepEqual(failure(await as.call(g(0).sa, 'GET', path(1))), notFound);
    assert.deepEqual(failure(await as.call(office.cluster.psa, 'GET', '/groups/not-a-group')), notFound);
    assert.deepEqual(failure(await as.call(office.cluster.psa, 'GET', `/groups/${hex(new ObjectId())}`)), notFound);
  });

  it('carries an ETag and revalidation, answers 304 to a matching If-None-Match and a new tag after a change; other responses have none', async () => {
    const token = await as.tokenOf(office.cluster.psa);
    const first = await office.call('GET', path(0), token);
    const tag = first.headers.get('etag')!;
    assert.match(tag, /^W\/"/);
    assert.equal(first.headers.get('cache-control'), 'no-store');
    await first.text();
    const again = await office.call('GET', path(0), token, undefined, { 'if-none-match': tag });
    assert.deepEqual([again.status, await again.text(), again.headers.get('etag'), again.headers.get('cache-control')], [304, '', tag, 'no-store']);
    const stale = await office.call('GET', path(0), token, undefined, { 'if-none-match': 'W/"old"' });
    assert.equal(stale.status, 200);
    await stale.text();
    // The SA sees another representation (no cluster), so another tag.
    const sa = await office.call('GET', path(0), await as.tokenOf(g(0).sa));
    assert.notEqual(sa.headers.get('etag'), tag);
    await sa.text();
    assert.equal((await as.call(office.cluster.psa, 'PATCH', path(0), { description: 'changed' })).status, 200);
    const changed = await office.call('GET', path(0), token, undefined, { 'if-none-match': tag });
    assert.equal(changed.status, 200);
    assert.notEqual(changed.headers.get('etag'), tag);
    await changed.text();
    const list = await office.call('GET', '/groups', token);
    assert.deepEqual([list.headers.get('etag'), list.headers.get('cache-control')], [null, 'no-store']);
    await list.text();
  });
});

describe('GET /v1/me: the features of the group', () => {
  it('gives them to SA, CA and PA, and null to PSA and dealers', async () => {
    for (const actor of [g(0).sa, g(0).ca, g(0).pa]) {
      const { body } = await as.call(actor, 'GET', '/me');
      assert.deepEqual([body.data.groupFeatures.cash, body.data.groupFeatures.warehouse, body.data.groupFeatures.rooms], [true, true, false]);
      assert.equal(Object.keys(body.data.groupFeatures).length, 15);
    }
    for (const actor of [office.cluster.psa, office.cluster.dealerA]) {
      assert.equal((await as.call(actor, 'GET', '/me')).body.data.groupFeatures, null);
    }
  });
});

describe('a route that requires a feature', () => {
  it('answers 403 FEATURE_DISABLED to everybody, PSA and dealers included, while the group has it off', async () => {
    const off = { status: 403, code: 'FEATURE_DISABLED', details: undefined };
    for (const actor of [office.cluster.psa, g(0).dealerId, g(0).sa, g(0).ca, g(0).pa]) {
      assert.deepEqual(failure(await as.call(actor, 'GET', path(0, '/probe'))), off);
    }
  });

  it('checks the group and the permission first', async () => {
    assert.deepEqual(failure(await as.call(office.cluster.dealerB, 'GET', path(0, '/probe'))), notFound);
    const noPlaces = await addUser(ctx, office, { permissions: { status: false, groups: { r: true, w: true } } });
    const reply = await send(office, 'GET', path(0, '/probe'), (await office.tokens(noPlaces.name)).accessToken);
    assert.deepEqual(as.failure(reply), denied);
  });

  it('lets the request through once the group has the feature, and reads the change without a restart', async () => {
    await groups().updateOne({ _id: g(0).groupId }, { $set: { 'settings.rooms': true } });
    for (const actor of [office.cluster.psa, g(0).dealerId, g(0).sa, g(0).ca]) {
      assert.equal((await as.call(actor, 'GET', path(0, '/probe'))).status, 200);
    }
    await groups().updateOne({ _id: g(0).groupId }, { $set: { 'settings.rooms': 'yes' } });
    assert.equal((await as.call(office.cluster.psa, 'GET', path(0, '/probe'))).status, 403);
    await groups().updateOne({ _id: g(0).groupId }, { $set: { 'settings.rooms': false } });
  });
});

describe('PATCH /v1/groups/{groupId}', () => {
  const all = (extra: Document = {}): Document => ({
    name: 'Renamed',
    description: 'A description',
    languages: ['it', 'fr'],
    statsSettings: { openingTime: '05:00', compressProductsCategories: true, timeSlots: [{ from: '06:00', to: '12:00' }, { from: '18:00', to: '24:00' }] },
    features: { rooms: true, cash: false },
    integrations: { cooperto: { enabled: true }, yellgo: { enabled: false } },
    ...extra,
  });

  it('lets the PSA change everything, writes only owned legacy fields and records the change without any secret', async () => {
    const before = await stored(1);
    const mark = office.activity.entries.length;
    const reply = await as.call(office.cluster.psa, 'PATCH', path(1), all({ demo: true }));
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const data = reply.body.data;
    assert.deepEqual([data.name, data.description, data.languages, data.demo, data.features.rooms, data.features.cash, data.features.warehouse, data.integrations.cooperto.enabled], ['Renamed', 'A description', ['it', 'fr'], true, true, false, true, true]);
    assert.deepEqual(data.statsSettings.timeSlots, [{ from: '06:00', to: '12:00' }, { from: '18:00', to: '24:00' }]);
    const after = await stored(1);
    assert.deepEqual([after['name'], after['demo'], after['settings'].languages, after['settings'].rooms, after['settings'].cash], ['Renamed', true, 'it;fr', true, false]);
    assert.deepEqual(after['settings'].stats, { daily: true, openingTime: '05:00', compressProductsCategories: true, timeSlots: [{ start: 6, end: 11 }, { start: 18, end: 23 }] });
    assert.deepEqual(after['settings'].integrations.cooperto, { status: true });
    // Untouched: keys and everything of the legacy or of later domains.
    assert.deepEqual(after['settings'].integrations.satispay, before['settings'].integrations.satispay);
    for (const field of ['apiKey', 'databaseHost', 'filesHost', 'type', 'plan', 'dealerId', 'status', 'trash', 'priceLists', 'taxes', 'places', 'warehouseRules', 'insertDate']) {
      assert.deepEqual(after[field], before[field], field);
    }
    assert.ok((after['updateDate'] as Date) > (before['updateDate'] as Date));
    const events = entriesSince(mark).filter((entry) => entry.action === 'group.updated');
    assert.equal(events.length, 1);
    assert.deepEqual([events[0]!.category, events[0]!.groupId?.toHexString(), events[0]!.resource, events[0]!.actor.role], ['data', hex(g(1).groupId), { type: 'group', id: hex(g(1).groupId) }, 'PSA']);
    assert.ok(events[0]!.changes!.some((change) => change.field === 'name' && change.after === 'Renamed'));
    assert.ok(!JSON.stringify(events).includes('integration-key'));
  });

  it('writes the integration state without touching the provider key that is already there', async () => {
    await groups().updateOne({ _id: g(1).groupId }, { $set: { 'settings.integrations.yellgo': { status: true, apiKey: 'integration-key' } } });
    assert.equal((await as.call(office.cluster.psa, 'PATCH', path(1), { integrations: { yellgo: { enabled: false } } })).status, 200);
    assert.deepEqual((await stored(1))['settings'].integrations.yellgo, { status: false, apiKey: 'integration-key' });
  });

  it('answers 200 and writes and logs nothing when the request repeats the current values', async () => {
    const mark = office.activity.entries.length;
    const before = await stored(1);
    const reply = await as.call(office.cluster.psa, 'PATCH', path(1), all({ demo: true, description: 'A description', languages: ['it', 'fr'] }));
    assert.equal(reply.status, 200);
    assert.deepEqual(await stored(1), before);
    assert.equal(entriesSince(mark).filter((entry) => entry.action === 'group.updated').length, 0);
  });

  it('gives the dealer everything but demo, and the SA only name, description, languages and statistics (D-13)', async () => {
    const refused = (fields: string[]) => ({ status: 403, code: 'FORBIDDEN', details: fields.map((field) => ({ field, issue: 'notAllowed' })) });
    assert.deepEqual(failure(await as.call(g(0).dealerId, 'PATCH', path(0), { demo: true, name: 'X' })), refused(['demo']));
    assert.equal((await as.call(g(0).dealerId, 'PATCH', path(0), all())).status, 200);
    assert.deepEqual(failure(await as.call(g(0).sa, 'PATCH', path(0), all({ demo: true }))), refused(['features', 'integrations', 'demo']));
    const ok = await as.call(g(0).sa, 'PATCH', path(0), { name: 'By the SA', description: null, languages: ['de'], statsSettings: { openingTime: null, timeSlots: [] } });
    assert.equal(ok.status, 200);
    assert.deepEqual([ok.body.data.name, ok.body.data.description, ok.body.data.languages, ok.body.data.statsSettings], ['By the SA', null, ['de'], { openingTime: null, compressProductsCategories: true, timeSlots: [] }]);
    assert.equal((await stored(0))['settings'].languages, 'de');
    assert.equal('dataCluster' in ok.body.data, false);
    assert.equal((await as.call(office.cluster.psa, 'PATCH', path(0), { name: 'group-001', languages: [] })).body.data.dataCluster, null);
    assert.equal((await stored(0))['settings'].languages, null);
  });

  it('never lets state, trash or secrets through the body', async () => {
    for (const body of [{ status: 'suspended' }, { trash: true }, { trashed: true }, { apiKey: 'x' }, { dealerId: hex(g(0).dealerId) }, { dataCluster: 'c' }, { integrations: { yellgo: { enabled: true, apiKey: 'k' } } }, { 'settings.cash': true },
      { $set: { apiKey: 'x' } }, { features: { $where: true } }, { integrations: { 'yellgo.apiKey': { enabled: true } } },
      JSON.parse('{"__proto__":{"demo":true}}') as unknown, JSON.parse('{"features":{"__proto__":{"cash":true}}}') as unknown, { name: 'X', constructor: { prototype: { demo: true } } }]) {
      assert.equal((await as.call(office.cluster.psa, 'PATCH', path(0), body)).status, 422, JSON.stringify(body));
    }
    assert.equal((await stored(0))['status'], true);
  });

  it('validates the body: 422 with the fields, an empty body is required', async () => {
    const invalid = async (body: unknown) => failure(await as.call(office.cluster.psa, 'PATCH', path(0), body));
    assert.deepEqual(await invalid({}), { status: 422, code: 'VALIDATION_ERROR', details: [{ field: '(body)', issue: 'required' }] });
    assert.deepEqual((await invalid({ languages: ['it', 'it', 'xx'] })).details, [{ field: 'languages.1', issue: 'incorrect' }, { field: 'languages.2', issue: 'enum' }]);
    assert.deepEqual((await invalid({ statsSettings: { openingTime: '9:00', timeSlots: [{ from: '10:15', to: '11:00' }] } })).details, [{ field: 'statsSettings.openingTime', issue: 'pattern' }, { field: 'statsSettings.timeSlots.0.from', issue: 'pattern' }]);
    assert.deepEqual((await invalid({ features: { teleport: true } })).details, [{ field: 'features.teleport', issue: 'unknown' }]);
    assert.deepEqual((await invalid({ name: 7 })).details, [{ field: 'name', issue: 'type' }]);
  });

  it('refuses a user with groups.update missing, CA and PA, and hides the group from another dealer', async () => {
    assert.deepEqual(failure(await as.call(g(0).ca, 'PATCH', path(0), { name: 'X' })), denied);
    assert.deepEqual(failure(await as.call(g(0).pa, 'PATCH', path(0), { name: 'X' })), denied);
    assert.deepEqual(failure(await as.call(office.cluster.dealerB, 'PATCH', path(0), { name: 'X' })), notFound);
    assert.deepEqual(failure(await as.call(g(1).sa, 'PATCH', path(0), { name: 'X' })), notFound);
    const readOnly = await addUser(ctx, office, { permissions: { status: false, groups: { r: true, w: false } } });
    assert.deepEqual(as.failure(await send(office, 'PATCH', path(0), (await office.tokens(readOnly.name)).accessToken, { name: 'X' })), denied);
    assert.notEqual((await stored(0))['name'], 'X');
  });

  it('refuses with 409 a group whose document cannot take the change, and leaves it as it is', async () => {
    const odd = legacyGroup(60, { dealerId: g(0).dealerId, settings: 'none' });
    const oddStats = legacyGroup(61, { dealerId: g(0).dealerId, settings: { cash: true, stats: null } });
    await groups().insertMany([odd, oddStats]);
    const at = (n: number) => `/groups/${hex(fixtureId('group', n))}`;
    assert.deepEqual(failure(await as.call(office.cluster.psa, 'PATCH', at(60), { features: { cash: true } })), conflict);
    assert.deepEqual(failure(await as.call(office.cluster.psa, 'PATCH', at(61), { statsSettings: { openingTime: '07:00' } })), conflict);
    assert.equal((await groups().findOne({ _id: fixtureId('group', 60) }))!['settings'], 'none');
    assert.equal((await groups().findOne({ _id: fixtureId('group', 61) }))!['settings'].stats, null);
    // A change that writes no nested field still goes through.
    assert.equal((await as.call(office.cluster.psa, 'PATCH', at(60), { name: 'Fixed name' })).status, 200);
    const read = await as.call(office.cluster.psa, 'GET', at(60));
    assert.deepEqual([read.status, read.body.data.name], [200, 'Fixed name']);
  });
});

describe('suspension and reactivation', () => {
  it('ends the sessions and the legacy tokens of every user of the group and not of the others, then refuses the group to its users', async () => {
    const sa = await office.tokens(userName(g(2).sa));
    const ca = await office.tokens(userName(g(2).ca));
    const other = await office.tokens(userName(g(3).sa));
    const psa = await as.tokenOf(office.cluster.psa);
    assert.equal((await users().findOne({ _id: g(2).sa }))!['tokens'].length > 0, true);
    const mark = office.activity.entries.length;
    const reply = await send(office, 'POST', path(2, '/suspension'), psa);
    assert.deepEqual([reply.status, reply.body.data.status], [200, 'suspended']);
    assert.equal((await stored(2))['status'], false);
    for (const token of [sa, ca]) {
      assert.equal((await send(office, 'GET', '/me', token.accessToken)).status, 401);
    }
    assert.equal((await send(office, 'GET', '/me', other.accessToken)).status, 200);
    assert.deepEqual((await users().findOne({ _id: g(2).sa }))!['tokens'], []);
    assert.deepEqual((await users().findOne({ _id: g(2).ca }))!['tokens'], []);
    assert.ok(((await users().findOne({ _id: g(3).sa }))!['tokens'] as unknown[]).length > 0);
    assert.equal(await sessions().countDocuments({ userId: g(2).sa, revokedAt: null }), 0);
    assert.equal((await office.login(userName(g(2).sa))).status, 401);
    const events = entriesSince(mark);
    const suspended = events.filter((entry) => entry.action === 'group.suspended');
    assert.deepEqual(suspended.map((e) => [e.category, e.outcome, e.actor.role, e.groupId?.toHexString(), e.resource?.id]), [['security', 'success', 'PSA', hex(g(2).groupId), hex(g(2).groupId)]]);
    assert.deepEqual(events.filter((entry) => entry.action === 'session.revoked').map((e) => [e.metadata, e.groupId?.toHexString()]), [[{ reason: 'groupSuspended' }, hex(g(2).groupId)]]);
  });

  it('hides the suspended group from its dealer and administrator, shows it to the PSA, and refuses a second suspension', async () => {
    assert.deepEqual(failure(await as.call(g(2).dealerId, 'GET', path(2))), notFound);
    assert.deepEqual(failure(await as.call(g(2).dealerId, 'POST', path(2, '/suspension'))), notFound);
    assert.equal((await as.call(office.cluster.psa, 'GET', path(2))).body.data.status, 'suspended');
    assert.equal((await as.call(office.cluster.psa, 'PATCH', path(2), { name: 'Edited while suspended' })).status, 200);
    assert.deepEqual(failure(await as.call(office.cluster.psa, 'POST', path(2, '/suspension'))), conflict);
  });

  it('reactivates with 204, once, and the users can sign in again', async () => {
    const mark = office.activity.entries.length;
    const psa = await as.tokenOf(office.cluster.psa);
    const reply = await send(office, 'DELETE', path(2, '/suspension'), psa);
    assert.deepEqual([reply.status, reply.body], [204, undefined]);
    assert.equal((await stored(2))['status'], true);
    assert.deepEqual(entriesSince(mark).map((e) => e.action), ['group.crossAccess', 'group.reactivated'].filter((a) => entriesSince(mark).some((e) => e.action === a)));
    assert.equal(entriesSince(mark).filter((e) => e.action === 'group.reactivated').length, 1);
    assert.equal(entriesSince(mark).filter((e) => e.action === 'session.revoked').length, 0);
    assert.deepEqual(failure(await as.call(office.cluster.psa, 'DELETE', path(2, '/suspension'))), conflict);
    assert.equal((await office.login(userName(g(2).sa))).status, 200);
  });

  it('is for the PSA alone: dealers and administrators get 403', async () => {
    for (const actor of [g(0).dealerId, g(0).sa, g(0).ca, g(0).pa]) {
      assert.deepEqual(failure(await as.call(actor, 'POST', path(0, '/suspension'))), denied);
      assert.deepEqual(failure(await as.call(actor, 'DELETE', path(0, '/suspension'))), denied);
    }
    // A PSA holds the whole ceiling of his role whatever his matrix (D-10): one without groups.w is not refused, here on a group that does not exist.
    const reader = await addUser(ctx, office, { role: 'PSA', groupId: null, dealerId: null, permissions: { status: false, groups: { r: true, w: false } } });
    assert.equal((await send(office, 'POST', `/groups/${new ObjectId().toHexString()}/suspension`, (await office.tokens(reader.name)).accessToken)).status, 404);
    assert.equal((await stored(0))['status'], true);
  });

  it('answers 404 when the group is not there', async () => {
    assert.deepEqual(failure(await as.call(office.cluster.psa, 'POST', `/groups/${hex(new ObjectId())}/suspension`)), notFound);
  });

  it('ends at the reactivation a session left open while the group was suspended (a failed revocation or a concurrent login), never a later one', async () => {
    const psa = await as.tokenOf(office.cluster.psa);
    assert.equal((await send(office, 'POST', path(2, '/suspension'), psa)).status, 200);
    const now = new Date();
    const { insertedId } = await sessions().insertOne({
      userId: g(2).sa,
      accessTokenHash: 'c'.repeat(64),
      accessExpiresAt: new Date(now.getTime() + 60_000),
      refreshTokenHash: 'd'.repeat(64),
      previousRefreshHashes: [],
      refreshExpiresAt: new Date(now.getTime() + 60_000),
      familyExpiresAt: new Date(now.getTime() + 60_000),
      createdAt: now,
      lastUsedAt: now,
      rotatedAt: null,
      userAgent: null,
      ip: null,
      revokedAt: null,
      revokeReason: null,
      expiresAt: new Date(now.getTime() + 120_000),
    });
    const mark = office.activity.entries.length;
    assert.equal((await send(office, 'DELETE', path(2, '/suspension'), psa)).status, 204);
    const left = (await sessions().findOne({ _id: insertedId }))!;
    assert.deepEqual([left['revokedAt'] instanceof Date, left['revokeReason']], [true, 'groupSuspended']);
    assert.deepEqual(entriesSince(mark).filter((e) => e.action === 'session.revoked').map((e) => e.metadata), [{ reason: 'groupSuspended' }]);
    const fresh = await office.tokens(userName(g(2).sa));
    assert.equal((await send(office, 'GET', '/me', fresh.accessToken)).status, 200);
  });
});

describe('trash and restore', () => {
  it('trashes a group with the same revocation, two events, and the PSA still reaches it', async () => {
    const token = await office.tokens(userName(g(2).pa));
    const mark = office.activity.entries.length;
    const reply = await as.call(office.cluster.psa, 'POST', path(2, '/trash'));
    assert.deepEqual([reply.status, reply.body.data.trashed], [200, true]);
    assert.equal((await stored(2))['trash'], true);
    assert.equal((await send(office, 'GET', '/me', token.accessToken)).status, 401);
    assert.deepEqual((await users().findOne({ _id: g(2).pa }))!['tokens'], []);
    const events = entriesSince(mark).filter((e) => e.action === 'group.trashed');
    assert.deepEqual(events.map((e) => e.category).sort(), ['data', 'security']);
    assert.deepEqual(events.find((e) => e.category === 'data')!.changes, [{ field: 'trashed', before: false, after: true }]);
    assert.deepEqual(entriesSince(mark).filter((e) => e.action === 'session.revoked').map((e) => e.metadata), [{ reason: 'groupTrashed' }]);
    assert.deepEqual(failure(await as.call(g(2).dealerId, 'GET', path(2))), notFound);
    assert.deepEqual(failure(await as.call(office.cluster.psa, 'POST', path(2, '/trash'))), conflict);
    const list = await as.call(office.cluster.psa, 'GET', '/groups?trashed=true');
    assert.ok(list.body.data.some((item: { id: string }) => item.id === hex(g(2).groupId)));
  });

  it('restores it once, with two events, and nothing is revoked', async () => {
    const mark = office.activity.entries.length;
    const reply = await as.call(office.cluster.psa, 'POST', path(2, '/restore'));
    assert.deepEqual([reply.status, reply.body.data.trashed], [200, false]);
    assert.equal((await stored(2))['trash'], false);
    const events = entriesSince(mark);
    assert.deepEqual(events.filter((e) => e.action === 'group.restored').map((e) => e.category).sort(), ['data', 'security']);
    assert.equal(events.filter((e) => e.action === 'session.revoked').length, 0);
    assert.deepEqual(failure(await as.call(office.cluster.psa, 'POST', path(2, '/restore'))), conflict);
    assert.equal((await as.call(g(2).dealerId, 'GET', path(2))).status, 200);
  });

  it('is for the PSA alone and never deletes a group', async () => {
    for (const actor of [g(0).dealerId, g(0).sa, g(0).ca, g(0).pa]) {
      assert.deepEqual(failure(await as.call(actor, 'POST', path(0, '/trash'))), denied);
      assert.deepEqual(failure(await as.call(actor, 'POST', path(0, '/restore'))), denied);
    }
    assert.deepEqual(failure(await as.call(office.cluster.psa, 'DELETE', path(0))), { status: 405, code: 'METHOD_NOT_ALLOWED', details: undefined });
    assert.equal(await groups().countDocuments({ _id: g(0).groupId }), 1);
  });
});

describe('a group with more users than one batch', () => {
  it('ends the sessions and the legacy tokens of every one of them, batch after batch, and of nobody else', async () => {
    const target = g(3).groupId;
    const count = REVOCATION_BATCH_SIZE + 1;
    const extra = Array.from({ length: count }, (_unused, i) => legacyUser(5000 + i, { role: 'E', groupId: target }));
    await users().insertMany(extra);
    const now = new Date();
    const ids = extra.map((user) => user['_id'] as ObjectId);
    await sessions().insertMany(
      [ids[0]!, ids[REVOCATION_BATCH_SIZE - 1]!, ids[REVOCATION_BATCH_SIZE]!, g(0).sa].map((userId, i) => ({
        userId,
        accessTokenHash: `${'a'.repeat(63)}${String(i)}`,
        accessExpiresAt: new Date(now.getTime() + 60_000),
        refreshTokenHash: `${'b'.repeat(63)}${String(i)}`,
        previousRefreshHashes: [],
        refreshExpiresAt: new Date(now.getTime() + 60_000),
        familyExpiresAt: new Date(now.getTime() + 60_000),
        createdAt: now,
        lastUsedAt: now,
        rotatedAt: null,
        userAgent: null,
        ip: null,
        revokedAt: null,
        revokeReason: null,
        expiresAt: new Date(now.getTime() + 120_000),
      })),
    );
    assert.equal((await send(office, 'POST', path(3, '/suspension'), await as.tokenOf(office.cluster.psa))).status, 200);
    assert.equal(await users().countDocuments({ groupId: target, tokens: { $ne: [] } }), 0);
    assert.equal(await sessions().countDocuments({ userId: { $in: ids }, revokedAt: null }), 0);
    assert.equal(await sessions().countDocuments({ userId: { $in: ids }, revokeReason: 'groupSuspended' }), 3);
    assert.equal(await sessions().countDocuments({ userId: g(0).sa, revokedAt: null }) > 0, true);
    assert.ok(((await users().findOne({ _id: g(0).sa }))!['tokens'] as unknown[]).length > 0);
  });
});

describe('GET /v1/groups with the new filters', () => {
  it('adds dealerId and demo to the items and filters by them', async () => {
    await groups().updateOne({ _id: g(1).groupId }, { $set: { demo: true } });
    const all = await as.call(office.cluster.psa, 'GET', '/groups?limit=200');
    const item = all.body.data.find((entry: { id: string }) => entry.id === hex(g(1).groupId));
    assert.deepEqual([item.dealerId, item.demo], [hex(g(1).dealerId), true]);
    const ids = (reply: { body: { data: Array<{ id: string }> } }) => reply.body.data.map((entry) => entry.id);
    assert.deepEqual(ids(await as.call(office.cluster.psa, 'GET', '/groups?demo=true')), [hex(g(1).groupId)]);
    assert.ok(!ids(await as.call(office.cluster.psa, 'GET', '/groups?demo=false&limit=200')).includes(hex(g(1).groupId)));
    const byDealer = ids(await as.call(office.cluster.psa, 'GET', `/groups?dealerId=${hex(office.cluster.dealerB)}&limit=200`));
    assert.ok(byDealer.includes(hex(g(2).groupId)) && !byDealer.includes(hex(g(0).groupId)));
    assert.deepEqual(failure(await as.call(office.cluster.dealerA, 'GET', `/groups?dealerId=${hex(office.cluster.dealerA)}`)), denied);
    assert.deepEqual(ids(await as.call(office.cluster.dealerA, 'GET', '/groups?demo=true')), [hex(g(1).groupId)]);
    assert.equal(failure(await as.call(office.cluster.psa, 'GET', '/groups?dealerId=x')).status, 422);
    assert.equal(failure(await as.call(office.cluster.psa, 'GET', '/groups?demo=maybe')).status, 422);
  });
});

describe('the groups service on its own', () => {
  it('answers 404 when the group vanishes between the check and the read or the write', async () => {
    const gone = new ObjectId();
    const { logger } = memoryLogger();
    const service = createGroupsService({
      groups: { findById: () => Promise.resolve(null), updateOwned: () => Promise.resolve('notFound') },
      users: { findIdsOfGroup: () => Promise.resolve([]), clearLegacyTokensOfMany: () => Promise.resolve(0) },
      sessions: { revokeAllOfUsers: () => Promise.resolve(0) },
      activityLog: memoryActivityLog(),
      logger,
      transaction: (work) => work(undefined as never),
      now: Date.now,
    });
    const base = { groupId: gone, clusterId: 'cluster0', crossGroup: true, features: {} };
    const access = base as never;
    const client = { requestId: 'req-12345678', ip: null, userAgent: null };
    await assert.rejects(service.get(principalOf('PSA'), access), { code: 'NOT_FOUND' });
    await assert.rejects(service.update(principalOf('PSA'), access, { name: 'X' }, client), { code: 'NOT_FOUND' });
    await assert.rejects(service.suspend(principalOf('PSA'), access, client), { code: 'NOT_FOUND' });
    const present = createManagedGroupsRepository(ctx.databases);
    const raced = createGroupsService({
      groups: { findById: present.findById, updateOwned: () => Promise.resolve('notFound') },
      users: { findIdsOfGroup: () => Promise.resolve([]), clearLegacyTokensOfMany: () => Promise.resolve(0) },
      sessions: { revokeAllOfUsers: () => Promise.resolve(0) },
      activityLog: memoryActivityLog(),
      logger,
      transaction: (work) => work(undefined as never),
      now: Date.now,
    });
    const real = { ...base, groupId: g(0).groupId } as never;
    await assert.rejects(raced.update(principalOf('PSA'), real, { name: 'Another name' }, client), { code: 'NOT_FOUND' });
    await assert.rejects(raced.restore(principalOf('PSA'), real, client), { code: 'CONFLICT' });
    await assert.rejects(raced.trash(principalOf('PSA'), real, client), { code: 'NOT_FOUND' });
  });

  it('logs the anomalies of a stored group and refuses to write a field it does not own', async () => {
    const { logger, events } = memoryLogger();
    const repository = createManagedGroupsRepository(ctx.databases);
    const service = createGroupsService({
      groups: repository,
      users: { findIdsOfGroup: () => Promise.resolve([]), clearLegacyTokensOfMany: () => Promise.resolve(0) },
      sessions: { revokeAllOfUsers: () => Promise.resolve(0) },
      activityLog: memoryActivityLog(),
      logger,
      transaction: (work) => work(undefined as never),
      now: Date.now,
    });
    const access = { groupId: g(0).groupId, clusterId: 'cluster0', crossGroup: true, features: {} } as never;
    await service.get(principalOf('PSA'), access);
    const warning = events.find((event) => event['msg'] === 'group anomalies');
    assert.ok(warning !== undefined);
    assert.ok(!JSON.stringify(warning).includes('plain-key'));
    await assert.rejects(repository.updateOwned(g(0).groupId, { $set: { apiKey: 'x' } }), /do not own|does not own/);
    await assert.rejects(repository.updateOwned(g(0).groupId, { $set: { name: 'x' }, $unset: { name: '' } } as never), /operators other than \$set/);
    assert.equal(await repository.updateOwned(new ObjectId(), { $set: { name: 'x' } }), 'notFound');
    assert.equal(await repository.findById(new ObjectId()), null);
    assert.equal((await stored(0))['apiKey'], 'plain-key-001');
  });

  it('records its events without an address when the client has none', async () => {
    const extra = legacyGroup(70, { dealerId: g(0).dealerId });
    await groups().insertOne(extra);
    const log = memoryActivityLog();
    const service = createGroupsService({
      groups: createManagedGroupsRepository(ctx.databases),
      users: { findIdsOfGroup: () => Promise.resolve([]), clearLegacyTokensOfMany: () => Promise.resolve(0) },
      sessions: { revokeAllOfUsers: () => Promise.resolve(0) },
      activityLog: log,
      logger: memoryLogger().logger,
      transaction: (work) => work(undefined as never),
      now: Date.now,
    });
    const access = { groupId: extra['_id'] as ObjectId, clusterId: 'cluster0', crossGroup: true, features: {} } as never;
    const client = { requestId: 'req-12345678', ip: null, userAgent: null };
    const psa = principalOf('PSA');
    await service.update(psa, access, { name: 'No address' }, client);
    await service.suspend(psa, access, client);
    await service.reactivate(psa, access, client);
    await service.trash(psa, access, client);
    await service.restore(psa, access, client);
    assert.deepEqual(log.entries.map((entry) => entry.action), ['group.updated', 'group.suspended', 'group.reactivated', 'group.trashed', 'group.trashed', 'group.restored', 'group.restored']);
    assert.ok(log.entries.every((entry) => !('ip' in entry)));
  });

  it('revokes before and after the suspension write, so a failure leaves the group active and the PSA can repeat it', async () => {
    const extra = legacyGroup(71, { dealerId: g(0).dealerId });
    await groups().insertOne(extra);
    const groupId = extra['_id'] as ObjectId;
    const member = new ObjectId();
    const calls: string[] = [];
    let failNext = true;
    const service = createGroupsService({
      groups: createManagedGroupsRepository(ctx.databases),
      users: {
        findIdsOfGroup: (_group, after) => Promise.resolve(after === null ? [member] : []),
        clearLegacyTokensOfMany: () => {
          calls.push('tokens');
          return Promise.resolve(1);
        },
      },
      sessions: {
        revokeAllOfUsers: (_ids, reason) => {
          if (failNext) {
            failNext = false;
            return Promise.reject(new Error('lost connection'));
          }
          calls.push(`sessions:${reason}`);
          return Promise.resolve(1);
        },
      },
      activityLog: memoryActivityLog(),
      logger: memoryLogger().logger,
      transaction: (work) => work(undefined as never),
      now: Date.now,
    });
    const access = { groupId, clusterId: 'cluster0', crossGroup: true, features: {} } as never;
    const client = { requestId: 'req-12345678', ip: null, userAgent: null };
    const psa = principalOf('PSA');
    await assert.rejects(service.suspend(psa, access, client), /lost connection/);
    assert.equal((await groups().findOne({ _id: groupId }))!['status'], true);
    await service.suspend(psa, access, client);
    assert.deepEqual(calls, ['sessions:groupSuspended', 'tokens', 'sessions:groupSuspended', 'tokens']);
    calls.length = 0;
    await service.reactivate(psa, access, client);
    assert.deepEqual(calls, ['sessions:groupSuspended']);
    calls.length = 0;
    await service.trash(psa, access, client);
    await service.restore(psa, access, client);
    assert.deepEqual(calls, ['sessions:groupTrashed', 'tokens', 'sessions:groupTrashed', 'tokens', 'sessions:groupTrashed']);
  });
});
