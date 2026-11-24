import { ACTIVITY_ALERT_ACTIONS } from '../../src/shared/activity-log/catalog.ts';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { buildActivityDocument } from '../../src/shared/activity-log/activity-log.ts';
import type { ActivityEntry, ActivityError } from '../../src/shared/activity-log/activity-log.ts';
import { createMinuteCap } from '../../src/shared/http/minute-cap.ts';
import { createClientErrorsService } from '../../src/modules/client-errors/client-errors.service.ts';
import type { ClientErrorBody } from '../../src/modules/client-errors/client-errors.schemas.ts';
import type { AuthPrincipal } from '../../src/shared/security/scope/principal.ts';
import { activityLogScopeFilter } from '../../src/shared/security/scope/scope-filters.ts';
import { memoryLogger } from '../helpers/app.ts';
import { memoryActivityLog } from '../helpers/activity.ts';

const MINUTE = 60_000;
const body: ClientErrorBody = { name: 'TypeError', message: 'm', route: '/a/:id', appVersion: '1.0.0' };
const client = { requestId: 'req-12345678', ip: '203.0.113.9', userAgent: 'agent' };
const principal = (groupId: ObjectId | null): AuthPrincipal => ({ userId: new ObjectId(), role: 'SA', groupId }) as AuthPrincipal;

describe('createMinuteCap', () => {
  it('allows the limit per minute, logs the first refusal at once and the count in the next minute', () => {
    const { logger, events } = memoryLogger();
    let now = 10 * MINUTE;
    const cap = createMinuteCap({ limit: 2, now: () => now, logger, skippingMessage: 'skipping', skippedMessage: 'skipped' });
    assert.deepEqual([cap.take(), cap.take(), cap.take(), cap.take(), cap.take()], [true, true, false, false, false]);
    assert.deepEqual(events.map((event) => [event['level'], event['msg']]), [['warn', 'skipping']]);
    now += MINUTE;
    assert.equal(cap.take(), true);
    assert.deepEqual(events.map((event) => [event['msg'], event['skipped'], event['limit']]), [['skipping', undefined, 2], ['skipped', 3, 2]]);
    now += MINUTE;
    assert.equal(cap.take(), true);
    assert.equal(events.length, 2, 'a minute without refusals logs nothing');
  });
});

describe('client errors service', () => {
  it('records a client.error entry for the reporter and his group, without optional parts when absent', async () => {
    const activity = memoryActivityLog();
    const service = createClientErrorsService({ activityLog: activity, logger: memoryLogger().logger, now: () => 0 });
    const user = principal(new ObjectId());
    await service.report(user, { ...body, stack: 's' }, client);
    await service.report(principal(null), body, { requestId: 'req-12345678', ip: null, userAgent: null });
    assert.deepEqual(activity.entries[0], {
      category: 'error',
      action: 'client.error',
      outcome: 'failure',
      actor: { kind: 'user', id: user.userId, role: 'SA' },
      groupId: user.groupId,
      requestId: 'req-12345678',
      ip: '203.0.113.9',
      metadata: { route: '/a/:id', appVersion: '1.0.0', userAgent: 'agent' },
      error: { name: 'TypeError', message: 'm', stack: 's' },
    });
    assert.deepEqual(Object.keys(activity.entries[1]!).sort(), ['action', 'actor', 'category', 'error', 'metadata', 'outcome', 'requestId']);
    assert.deepEqual(activity.entries[1]!.metadata, { route: '/a/:id', appVersion: '1.0.0' });
    assert.deepEqual(activity.entries[1]!.error, { name: 'TypeError', message: 'm' });
  });

  it('drops the reports over the per-process budget of the minute, and counts them on stdout', async () => {
    const activity = memoryActivityLog();
    const { logger, events } = memoryLogger();
    let now = 0;
    const service = createClientErrorsService({ activityLog: activity, logger, now: () => now, maxPerMinute: 2 });
    for (let i = 0; i < 5; i += 1) {
      await service.report(principal(null), body, client);
    }
    assert.equal(activity.entries.length, 2);
    now += MINUTE;
    await service.report(principal(null), body, client);
    assert.equal(activity.entries.length, 3);
    assert.deepEqual(events.map((event) => event['msg']), ['client error entries are being skipped by the per-minute limit', 'client error entries were skipped by the per-minute limit']);
  });

  it('uses the default budget of 100 reports per minute', async () => {
    const activity = memoryActivityLog();
    const service = createClientErrorsService({ activityLog: activity, logger: memoryLogger().logger, now: () => 0 });
    for (let i = 0; i < 101; i += 1) {
      await service.report(principal(null), body, client);
    }
    assert.equal(activity.entries.length, 100);
  });

  it('stores the same error of the same user once in ten minutes, counting the repeats on stdout', async () => {
    const activity = memoryActivityLog();
    const { logger, events } = memoryLogger();
    let now = 0;
    const service = createClientErrorsService({ activityLog: activity, logger, now: () => now });
    const user = principal(null);
    const report = { ...body, stack: 'TypeError: m\n    at a' };
    await service.report(user, report, client);
    await service.report(user, { ...report, stack: 'TypeError: m\n    at a\n    at b' }, client);
    await service.report(user, { ...report, route: '/other' }, client);
    now += 599_999;
    await service.report(user, report, client);
    assert.equal(activity.entries.length, 1);
    assert.deepEqual(events.map((event) => [event['msg'], event['repeats']]), [['client error repeated, not stored again', 1], ['client error repeated, not stored again', 2], ['client error repeated, not stored again', 3]]);
    now += 1;
    await service.report(user, report, client);
    assert.equal(activity.entries.length, 2);
    await service.report(user, { ...body }, client);
    await service.report(principal(null), report, client);
    assert.equal(activity.entries.length, 4);
  });

  it('forgets the oldest fingerprints beyond its bound', async () => {
    const activity = memoryActivityLog();
    const service = createClientErrorsService({ activityLog: activity, logger: memoryLogger().logger, now: () => 0, maxRemembered: 2 });
    const user = principal(null);
    for (const message of ['a', 'b', 'c']) {
      await service.report(user, { ...body, message }, client);
    }
    await service.report(user, { ...body, message: 'c' }, client);
    await service.report(user, { ...body, message: 'a' }, client);
    assert.deepEqual(activity.entries.map((entry) => entry.error!.message), ['a', 'b', 'c', 'a']);
  });

  it('never fails the request when the write fails: it is logged instead', async () => {
    const { logger, events } = memoryLogger();
    const failing = { record: () => Promise.reject(new Error('disk full')) };
    const service = createClientErrorsService({ activityLog: failing, logger, now: () => 0 });
    await service.report(principal(null), body, client);
    assert.deepEqual(events.map((event) => [event['level'], event['msg'], event['requestId']]), [['error', 'client error entry rejected', 'req-12345678']]);
  });
});

describe('activity log entries with an error', () => {
  const entry = (error: ActivityError | undefined, overrides: Partial<ActivityEntry> = {}): ActivityEntry => ({
    category: 'error',
    action: 'client.error',
    outcome: 'failure',
    actor: { kind: 'user', id: new ObjectId(), role: 'PA' },
    ...(error === undefined ? {} : { error }),
    ...overrides,
  });
  const at = new Date(0);

  it('redacts, cuts and bounds the name, the message and the stack', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `    at f${String(i)} ${'x'.repeat(400)}`);
    lines[1] = '    at login fc_rt_abcdef';
    const document = buildActivityDocument(entry({ name: 'N'.repeat(150), message: 'm'.repeat(500), stack: ['Error', ...lines].join('\n') }), at, 90);
    assert.equal(document.error!.name.length, 100);
    assert.equal(document.error!.message.length, 300);
    const stack = document.error!.stack!;
    assert.equal(stack.split('\n').length <= 10, true);
    assert.equal(stack.length <= 4000, true);
    assert.equal(stack.split('\n')[2], '[REDACTED]');
    const secret = buildActivityDocument(entry({ name: 'E', message: 'mongodb://u:p@h/db', stack: '' }), at, 90);
    assert.deepEqual(secret.error, { name: 'E', message: '[REDACTED]' });
  });

  it('replaces the first stack line by the bounded message and cuts every line before redaction', () => {
    const message = 'long '.repeat(200);
    const stack = [`TypeError: ${message}`, `    at ${'y'.repeat(1000)}`, 'TypeError without colon', ...Array.from({ length: 12 }, (_, i) => `    at f${String(i)}`)].join('\n');
    const document = buildActivityDocument(entry({ name: 'TypeError', message, stack }), at, 90);
    const lines = document.error!.stack!.split('\n');
    assert.equal(lines[0], `TypeError: ${message.slice(0, 300)}`);
    assert.equal(lines[1]!.length, 300);
    assert.equal(lines.length, 10);
    assert.ok(document.error!.stack!.length <= 4000);
    const other = buildActivityDocument(entry({ name: 'Other', message: 'm', stack: 'TypeError: first' }), at, 90);
    assert.equal(other.error!.stack, 'TypeError: first');
  });

  it('keeps an error without stack and refuses an error on an action that carries none', () => {
    assert.deepEqual(buildActivityDocument(entry({ name: 'E', message: 'm' }), at, 90).error, { name: 'E', message: 'm' });
    assert.equal('error' in buildActivityDocument(entry(undefined), at, 90), false);
    assert.throws(() => buildActivityDocument(entry({ name: 'E', message: 'm' }, { action: 'request.failed' }), at, 90), /does not carry an error/);
  });
});

describe('activityLogScopeFilter', () => {
  it('builds the filter of each scope and nothing for none', () => {
    const userId = new ObjectId();
    const groupId = new ObjectId();
    const filter = (scope: unknown) => activityLogScopeFilter({ userId, scope } as never);
    assert.deepEqual(filter({ kind: 'platform' }), {});
    assert.deepEqual(filter({ kind: 'dealer', groupIds: new Set([groupId.toHexString()]) }), { category: { $ne: 'error' }, groupId: { $in: [groupId] } });
    assert.deepEqual(filter({ kind: 'group', groupId }), { category: { $ne: 'error' }, groupId });
    assert.deepEqual(filter({ kind: 'companies', groupId }), { category: { $ne: 'error' }, 'actor.id': userId, action: { $nin: [...ACTIVITY_ALERT_ACTIONS] } });
    assert.deepEqual(filter({ kind: 'places', groupId }), { category: { $ne: 'error' }, 'actor.id': userId, action: { $nin: [...ACTIVITY_ALERT_ACTIONS] } });
    assert.deepEqual(filter({ kind: 'none' }), { _id: { $in: [] } });
  });
});
