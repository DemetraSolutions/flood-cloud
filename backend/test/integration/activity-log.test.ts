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
import { quietLogger } from '../helpers/indexes.ts';
import { COLLECTIONS } from '../../src/db/collections.ts';

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
const log = () => ctx.databases.common().collection<ActivityLogDocument>('activityLog');
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

describe('activityLog collection (real MongoDB)', () => {
  it('creates the collection, validator and indexes idempotently (two startups)', async () => {
    await ensureIndexes(ctx.databases, COLLECTIONS, quietLogger);
    await ensureIndexes(ctx.databases, COLLECTIONS, quietLogger);
    const [info] = await ctx.databases.common().listCollections({ name: 'activityLog' }).toArray();
    const options = (info as unknown as { options: { validator: { $jsonSchema: { required: string[] } }; validationLevel: string; validationAction: string } }).options;
    assert.deepEqual(options.validator.$jsonSchema.required, ['at', 'category', 'action', 'outcome', 'actor', 'expiresAt']);
    assert.deepEqual([options.validationLevel, options.validationAction], ['strict', 'error']);
    const indexes = new Map((await log().indexes()).map((index) => [index.name, index]));
    assert.deepEqual([...indexes.keys()].sort(), ['_id_', 'actor.id_1_at_-1__id_-1', 'at_-1__id_-1', 'category_1_at_-1__id_-1', 'expiresAt_1', 'groupId_1_at_-1__id_-1', 'requestId_1']);
    assert.equal(indexes.get('expiresAt_1')?.expireAfterSeconds, 0);
    assert.deepEqual(indexes.get('groupId_1_at_-1__id_-1')?.key, { groupId: 1, at: -1, _id: -1 });
  });

  it('replaces the indexes of earlier versions by the current ones, idempotently', async () => {
    await log().createIndexes([
      { key: { groupId: 1, at: -1 }, name: 'groupId_1_at_-1' },
      { key: { 'actor.id': 1, at: -1 }, name: 'actor.id_1_at_-1' },
      { key: { category: 1, at: -1 }, name: 'category_1_at_-1' },
    ]);
    await ensureIndexes(ctx.databases, COLLECTIONS, quietLogger);
    await ensureIndexes(ctx.databases, COLLECTIONS, quietLogger);
    const names = (await log().indexes()).map((index) => index.name);
    assert.deepEqual(names.sort(), ['_id_', 'actor.id_1_at_-1__id_-1', 'at_-1__id_-1', 'category_1_at_-1__id_-1', 'expiresAt_1', 'groupId_1_at_-1__id_-1', 'requestId_1']);
  });

  it('updates an outdated validator in place on the next startup', async () => {
    await ctx.databases.common().command({ collMod: 'activityLog', validator: {} });
    await ensureIndexes(ctx.databases, COLLECTIONS, quietLogger);
    const [info] = await ctx.databases.common().listCollections({ name: 'activityLog' }).toArray();
    assert.ok((info as unknown as { options: { validator: { $jsonSchema?: unknown } } }).options.validator.$jsonSchema !== undefined);
  });

  it('rejects documents that break the schema', async () => {
    const valid = { at: new Date(NOW), category: 'data', action: 'user.created', outcome: 'success', actor: { kind: 'anonymous' }, expiresAt: new Date(NOW + DAY) };
    await log().insertOne(valid as never);
    const invalid: Array<Record<string, unknown>> = [
      { ...valid, extra: 1 },
      { ...valid, category: 'other' },
      { ...valid, action: 'not.in.catalog' },
      { ...valid, outcome: 'maybe' },
      { ...valid, actor: { kind: 'robot' } },
      { ...valid, actor: { kind: 'user', id: 'not-an-object-id' } },
      { ...valid, groupId: 'x' },
      { ...valid, resource: { type: 'x'.repeat(33) } },
      { ...valid, expiresAt: 'tomorrow' },
      { ...valid, changes: [{ nofield: 1 }] },
    ];
    for (const document of invalid) {
      await assert.rejects(log().insertOne(document as never), (error: { code?: number }) => error.code === 121);
    }
    const { expiresAt: _omitted, ...missing } = valid;
    void _omitted;
    await assert.rejects(log().insertOne(missing as never), (error: { code?: number }) => error.code === 121);
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
      [{ actor: { kind: 'user', role: 'SA' } }, /user actor needs an id/],
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

  it('has a validator that also bounds the metadata and requires the id of a user actor', async () => {
    const base = { at: new Date(NOW), category: 'security', action: 'rateLimit.exceeded', outcome: 'denied', expiresAt: new Date(NOW + DAY) };
    const code121 = (error: { code?: number }) => error.code === 121;
    await log().insertOne({ ...base, actor: { kind: 'user', id: new ObjectId() }, metadata: { bucket: 'x', n: 1, ok: true, none: null, f: 1.5 } } as never);
    await log().insertOne({ ...base, actor: { kind: 'system' } } as never);
    await assert.rejects(log().insertOne({ ...base, actor: { kind: 'user' } } as never), code121);
    await assert.rejects(log().insertOne({ ...base, actor: { kind: 'anonymous' }, metadata: { nested: { a: 1 } } } as never), code121);
    await assert.rejects(log().insertOne({ ...base, actor: { kind: 'anonymous' }, metadata: { list: [1] } } as never), code121);
    await assert.rejects(log().insertOne({ ...base, actor: { kind: 'anonymous' }, metadata: { long: 'x'.repeat(257) } } as never), code121);
    await assert.rejects(log().insertOne({ ...base, actor: { kind: 'anonymous' }, metadata: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 1])) } as never), code121);
    await log().insertOne({ ...base, actor: { kind: 'anonymous' }, metadata: { long: 'x'.repeat(256) } } as never);
  });
});
