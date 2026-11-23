import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { ensureIndexes } from '../../src/db/indexes.ts';
import type { Databases } from '../../src/db/databases.ts';
import { createActivityLog } from '../../src/shared/activity-log/activity-log.ts';
import type { ActivityEntry, ActivityLogDocument } from '../../src/shared/activity-log/activity-log.ts';
import { recordDataChange } from '../../src/shared/activity-log/data-change.ts';
import { memoryLogger } from '../helpers/app.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { COLLECTIONS } from '../../src/db/collections.ts';
import { ACTION_CATALOG } from '../../src/shared/activity-log/catalog.ts';

let ctx: TestDatabases;
before(async () => {
  ctx = await openTestDatabases();
});
after(async () => {
  await ctx.cleanup();
});

const DAY = 86_400_000;
// Anchored at the real time: documents with a TTL must never be born expired.
const NOW = Date.now();
const log = () => ctx.databases.common().collection<ActivityLogDocument>('activityEvents');
const make = (logger = memoryLogger().logger, databases: Databases = ctx.databases) =>
  createActivityLog({ databases, logger, retentionDays: 365, errorRetentionDays: 90, now: () => NOW });
const entry = (overrides: Partial<ActivityEntry> = {}): ActivityEntry => ({
  category: 'security',
  action: 'group.crossAccess',
  outcome: 'success',
  actor: { kind: 'user', id: new ObjectId(), role: 'PSA' },
  groupId: new ObjectId(),
  requestId: 'req-12345678',
  ip: '203.0.113.7',
  ...overrides,
});

describe('activityEvents collection (real MongoDB)', () => {
  it('is created without validator, with the expected indexes, idempotently (two startups)', async () => {
    await ensureIndexes(ctx.databases, COLLECTIONS);
    await ensureIndexes(ctx.databases, COLLECTIONS);
    const [info] = await ctx.databases.common().listCollections({ name: 'activityEvents' }).toArray();
    assert.ok(info !== undefined);
    const options = (info as unknown as { options?: Record<string, unknown> }).options ?? {};
    assert.equal(options['validator'], undefined);
    assert.equal(options['validationLevel'], undefined);
    assert.equal(options['validationAction'], undefined);
    const indexes = new Map((await log().indexes()).map((index) => [index.name, index]));
    assert.deepEqual([...indexes.keys()].sort(), ['_id_', 'actor.id_1_at_-1__id_-1', 'at_-1__id_-1', 'category_1_at_-1__id_-1', 'expiresAt_1', 'groupId_1_at_-1__id_-1', 'requestId_1']);
    assert.equal(indexes.get('expiresAt_1')?.expireAfterSeconds, 0);
    assert.deepEqual(indexes.get('groupId_1_at_-1__id_-1')?.key, { groupId: 1, at: -1, _id: -1 });
  });

  it('never touches the legacy activityLog collection', async () => {
    const names = (await ctx.databases.common().listCollections({ name: 'activityLog' }).toArray()).map((info) => info.name);
    assert.deepEqual(names, []);
  });

  it('stores every action of the catalog, whatever the database knows about the catalog', async () => {
    const actionNames = [...ACTION_CATALOG.keys()];
    assert.ok(actionNames.length >= 75);
    const probe = actionNames.map((action, index) => ({ action, requestId: `req-catalog-${index}` }));
    for (const { action, requestId } of probe) {
      const definition = ACTION_CATALOG.get(action);
      assert.ok(definition !== undefined, action);
      const category = definition.categories[0] as ActivityEntry['category'];
      await make().record(entry({ action: action as ActivityEntry['action'], category, requestId, actor: { kind: 'system' }, ...(definition.hasErrorDetails === true ? { outcome: 'failure' as const } : {}) }));
    }
    assert.equal(await log().countDocuments({ requestId: /^req-catalog-/ }), probe.length);
  });

  it('rejects in the application, and does not store, an unknown action, category, outcome, actor role or an oversized entry', async () => {
    const { logger, lines } = memoryLogger();
    const service = make(logger);
    const bad: Array<[string, unknown]> = [
      ['unknown action', { action: 'not.in.catalog' }],
      ['unknown category', { category: 'other' }],
      ['unknown outcome', { outcome: 'maybe' }],
      ['unknown actor role', { actor: { kind: 'user', id: new ObjectId(), role: 'X' } }],
      ['unknown actor kind', { actor: { kind: 'robot' } }],
      ['user actor without id', { actor: { kind: 'user' } }],
      ['nested metadata', { metadata: { nested: { a: 1 } } }],
      ['array metadata', { metadata: { list: [1] } }],
      ['too many metadata keys', { metadata: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 1])) }],
      ['too many changes', { changes: Array.from({ length: 201 }, () => ({ field: 'a' })) }],
      ['long resource type', { resource: { type: 'x'.repeat(33) } }],
      ['groupId not an ObjectId', { groupId: 'x' }],
    ];
    for (const [label, override] of bad) {
      await service.record({ ...entry({ requestId: 'req-rejected' }), ...(override as object) } as never);
      assert.equal(await log().countDocuments({ requestId: 'req-rejected' }), 0, label);
    }
    assert.equal(lines.filter((line) => line.includes('activity log entry rejected')).length, bad.length);
  });
});

describe('ActivityLog.record (real MongoDB)', () => {
  it('stores the entry with the time and the expiry of its category', async () => {
    const actor = { kind: 'user', id: new ObjectId(), role: 'D' } as const;
    const groupId = new ObjectId();
    await make().record(entry({ actor, groupId, resource: { type: 'group', id: 'g1' }, metadata: { bucket: 'login:ip' }, action: 'rateLimit.exceeded', outcome: 'denied' }));
    const stored = await log().findOne({ groupId });
    assert.deepEqual(
      { at: stored?.at.getTime(), expiresAt: stored?.expiresAt.getTime(), category: stored?.category, action: stored?.action, outcome: stored?.outcome, role: stored?.actor.role, resource: stored?.resource, metadata: stored?.metadata, requestId: stored?.requestId, ip: stored?.ip },
      { at: NOW, expiresAt: NOW + 365 * DAY, category: 'security', action: 'rateLimit.exceeded', outcome: 'denied', role: 'D', resource: { type: 'group', id: 'g1' }, metadata: { bucket: 'login:ip' }, requestId: 'req-12345678', ip: '203.0.113.7' },
    );
    assert.equal(stored?.actor.id?.toHexString(), actor.id.toHexString());
  });

  it('keeps error entries 90 days and data entries 365 days', async () => {
    const requestId = 'req-expiry-1';
    await make().record(entry({ category: 'error', action: 'request.failed', outcome: 'failure', actor: { kind: 'anonymous' }, requestId, metadata: { method: 'GET', route: '/v1/x', errorName: 'Error' } }));
    await make().record(entry({ category: 'data', action: 'user.created', actor: { kind: 'system' }, requestId: 'req-expiry-2' }));
    assert.equal((await log().findOne({ requestId }))?.expiresAt.getTime(), NOW + 90 * DAY);
    assert.equal((await log().findOne({ requestId: 'req-expiry-2' }))?.expiresAt.getTime(), NOW + 365 * DAY);
  });

  it('redacts credentials and bounds strings before writing', async () => {
    const requestId = 'req-redact-1';
    await make().record(
      entry({
        requestId,
        action: 'auth.loginFailed',
        outcome: 'failure',
        resource: { type: 'session', id: `fc_at_${'a'.repeat(100)}` },
        metadata: { reason: `x${'y'.repeat(400)}` },
      }),
    );
    await make().record(entry({ requestId: 'req-redact-2', action: 'auth.loginFailed', metadata: { reason: 'mongodb://user:pw@host/db' } }));
    const stored = await log().findOne({ requestId });
    assert.equal(stored?.resource?.id, '[REDACTED]');
    assert.equal((stored?.metadata?.['reason'] as string).length, 256);
    assert.equal((await log().findOne({ requestId: 'req-redact-2' }))?.metadata?.['reason'], '[REDACTED]');
    await make().record(entry({ requestId: 'req-redact-3', resource: { type: 'place', id: 'z'.repeat(100) }, ip: '1'.repeat(100) }));
    const clipped = await log().findOne({ requestId: 'req-redact-3' });
    assert.equal(clipped?.resource?.id?.length, 64);
    assert.equal(clipped?.ip?.length, 64);
  });

  it('stores data changes (redacting credential-looking values) through recordDataChange', async () => {
    const groupId = new ObjectId();
    await recordDataChange(make(), {
      actor: { kind: 'user', id: new ObjectId(), role: 'SA' },
      groupId,
      resource: { type: 'user', id: 'u1' },
      action: 'user.updated',
      before: { role: 'CA', password: 'old', note: 'a' },
      after: { role: 'SA', password: 'new', note: 'fc_rt_secretvalue' },
      requestId: 'req-data-1',
      ip: '203.0.113.7',
    });
    const stored = await log().findOne({ groupId });
    assert.deepEqual(stored?.changes, [
      { field: 'role', before: 'CA', after: 'SA' },
      { field: 'password', redacted: true },
      { field: 'note', before: 'a', after: '[REDACTED]' },
    ]);
    assert.ok(!JSON.stringify(stored).includes('secretvalue'));
  });

  it('does not throw when the write fails: the redacted entry goes to the logger', async () => {
    const failing = { common: () => ({ collection: () => ({ insertOne: () => Promise.reject(new Error('mongo down')) }) }) } as unknown as Databases;
    const { logger, events, lines } = memoryLogger();
    const requestId = 'req-fail-1';
    const groupId = new ObjectId();
    await make(logger, failing).record(entry({ requestId, groupId, action: 'auth.loginFailed', resource: { type: 'session', id: 'fc_at_leak' }, metadata: { reason: 'bad' } }));
    assert.equal(events.length, 1);
    assert.equal(events[0]?.['level'], 'error');
    assert.equal(events[0]?.['msg'], 'activity log write failed');
    const logged = events[0]?.['entry'] as Record<string, unknown>;
    assert.equal(logged['requestId'], requestId);
    assert.equal(logged['groupId'], groupId.toHexString());
    assert.equal(logged['action'], 'auth.loginFailed');
    assert.ok(!lines.join('').includes('fc_at_leak'));
    // Personal data and secrets in the changes stay out of stdout, whatever the depth of the field.
    events.length = 0;
    lines.length = 0;
    await make(logger, failing).record(
      entry({
        action: 'user.updated',
        category: 'data',
        changes: [
          { field: 'email', before: 'old@x.it', after: 'new@x.it' },
          { field: 'contact.phone', after: '555' },
          { field: 'password', redacted: true },
          { field: 'role', before: 'CA', after: 'SA' },
        ],
      }),
    );
    const changes = (events[0]?.['entry'] as { changes: Array<Record<string, unknown>> }).changes;
    assert.deepEqual(changes, [
      { field: 'email', before: '[REDACTED]', after: '[REDACTED]' },
      { field: 'contact.phone', after: '[REDACTED]' },
      { field: 'password', redacted: true },
      { field: 'role', before: 'CA', after: 'SA' },
    ]);
    assert.ok(!lines.join('').match(/old@x\.it|new@x\.it|555/));
  });

  it('accepts the events of the store keys (the actor is the store, identified by its key) and nothing else in their metadata', async () => {
    const { logger, events } = memoryLogger();
    const service = make(logger);
    const keyId = new ObjectId();
    const groupId = new ObjectId();
    const base = { category: 'security', outcome: 'success', groupId, requestId: 'req-store-events', ip: '203.0.113.7' } as const;
    const good: ActivityEntry[] = [
      { ...base, action: 'store.activationCodeCreated', actor: { kind: 'user', id: new ObjectId(), role: 'PSA' }, resource: { type: 'place', id: 'p1' } },
      { ...base, action: 'store.activationCodeCancelled', actor: { kind: 'user', id: new ObjectId(), role: 'D' }, resource: { type: 'place', id: 'p1' } },
      { ...base, action: 'store.activated', actor: { kind: 'store', id: keyId }, resource: { type: 'storeKey', id: keyId.toHexString() }, metadata: { replacedKeyId: null } },
      { ...base, action: 'store.activated', actor: { kind: 'store', id: keyId }, metadata: { replacedKeyId: new ObjectId().toHexString() } },
      { ...base, action: 'store.activationFailed', outcome: 'denied', actor: { kind: 'anonymous' }, metadata: { reason: 'rejected' } },
      { ...base, action: 'store.keyRevoked', actor: { kind: 'system' }, resource: { type: 'storeKey', id: keyId.toHexString() }, metadata: { reason: 'placeTrashed', keyHint: 'AbC1' } },
      { ...base, action: 'store.revokedKeyPresented', outcome: 'denied', actor: { kind: 'anonymous' }, resource: { type: 'storeKey', id: keyId.toHexString() } },
      { ...base, action: 'rateLimit.exceeded', outcome: 'denied', actor: { kind: 'store', id: keyId }, metadata: { bucket: 'api:store' } },
    ];
    for (const item of good) {
      await service.record(item);
    }
    assert.deepEqual(events, []);
    const stored = await log().find({ requestId: 'req-store-events' }).sort({ _id: 1 }).toArray();
    assert.deepEqual(stored.map((item) => item.action), good.map((item) => item.action));
    assert.deepEqual(stored[2]!.actor, { kind: 'store', id: keyId });
    for (const bad of [
      { action: 'store.keyRevoked', metadata: { key: 'fc_sk_x' } },
      { action: 'store.activationCodeCreated', metadata: { code: '0000' } },
      { action: 'store.activated', category: 'data' },
    ]) {
      events.length = 0;
      await service.record({ ...good[2]!, ...bad } as ActivityEntry);
      assert.equal(events[0]?.['msg'], 'activity log entry rejected', JSON.stringify(bad));
    }
  });

  it('never rejects: a malformed entry is logged without its raw content and not stored', async () => {
    const { logger, events, lines } = memoryLogger();
    const service = make(logger);
    const bad: Array<[Partial<ActivityEntry> | Record<string, unknown>, RegExp]> = [
      [{ action: 'nope' }, /unknown action/],
      [{ category: 'data' }, /does not belong to category/],
      [{ outcome: 'maybe' }, /unknown outcome/],
      [{ actor: { kind: 'robot' } }, /unknown actor kind/],
      [{ actor: { kind: 'user', id: 'x' } }, /actor id/],
      [{ actor: { kind: 'anonymous', id: new ObjectId() } }, /actor id/],
      [{ actor: { kind: 'user', role: 'ROOT' } }, /unknown actor role/],
      [{ actor: { kind: 'user', role: 'SA' } }, /user, store or apiKey actor needs an id/],
      [{ actor: { kind: 'store' } }, /user, store or apiKey actor needs an id/],
      [{ actor: { kind: 'apiKey' } }, /user, store or apiKey actor needs an id/],
      [{ actor: { kind: 'system', id: new ObjectId() } }, /actor id/],
      [{ groupId: 'abc' }, /groupId/],
      [{ resource: { type: '' } }, /resource type/],
      [{ resource: { type: 'x'.repeat(33) } }, /resource type/],
      [{ metadata: { unexpected: 1 } }, /not allowed for group.crossAccess/],
      [{ action: 'auth.loginFailed', metadata: { reason: { nested: true } } }, /must be a scalar/],
      [{ action: 'rateLimit.exceeded', metadata: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 1])) }, /too many metadata keys/],
      [{ changes: Array.from({ length: 201 }, () => ({ field: 'f' })) }, /too many changes/],
    ];
    for (const [overrides, message] of bad) {
      events.length = 0;
      const raw = entry({ requestId: 'req-never-logged', ...(overrides as Partial<ActivityEntry>) });
      assert.equal(await service.record(raw), undefined);
      assert.equal(events.length, 1);
      assert.equal(events[0]?.['msg'], 'activity log entry rejected');
      assert.match(String(events[0]?.['reason']), message);
      assert.deepEqual(Object.keys(events[0] ?? {}).sort(), ['action', 'category', 'level', 'msg', 'reason', 'time']);
    }
    assert.ok(!lines.join('').includes('req-never-logged'));
    assert.equal(await log().countDocuments({ requestId: 'req-never-logged' }), 0);
    // A non-Error failure of the build is still reported.
    events.length = 0;
    await service.record({ ...entry(), actor: null } as never);
    assert.equal(events[0]?.['msg'], 'activity log entry rejected');
    // Scalar metadata of every type is accepted.
    await make().record(entry({ requestId: 'req-scalar', action: 'user.statusChanged', metadata: { from: true, to: null } }));
    await make().record(entry({ requestId: 'req-scalar-2', action: 'request.failed', category: 'error', outcome: 'failure', metadata: { errorCode: 5 } }));
    assert.deepEqual((await log().findOne({ requestId: 'req-scalar' }))?.metadata, { from: true, to: null });
  });
});
