import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { DPOP_REJECTED_BUCKET, DPOP_REJECTED_EVENTS_PER_HOUR, createDpopRejectedAudit } from '../../src/shared/security/dpop-audit.ts';
import type { DpopRejectedEvent } from '../../src/shared/security/dpop-audit.ts';
import { memoryActivityLog, memoryRateLimiter } from '../helpers/activity.ts';
import { memoryLogger } from '../helpers/app.ts';

const USER = new ObjectId();
const SESSION = new ObjectId();
const GROUP = new ObjectId();
const event = (overrides: Partial<DpopRejectedEvent> = {}): DpopRejectedEvent => ({
  userId: USER,
  actor: { kind: 'user', id: USER, role: 'SA' },
  groupId: GROUP,
  sessionId: SESSION,
  reason: 'claims',
  source: 'api',
  context: { requestId: 'req-12345678', ip: '203.0.113.9', userAgent: null },
  ...overrides,
});

describe('createDpopRejectedAudit', () => {
  it('writes the security event with the closed metadata and nothing else', async () => {
    const activityLog = memoryActivityLog();
    const limiter = memoryRateLimiter();
    await createDpopRejectedAudit({ activityLog, rateLimiter: limiter, logger: memoryLogger().logger })(event());
    assert.deepEqual(activityLog.entries, [
      {
        category: 'security',
        action: 'auth.dpopRejected',
        outcome: 'denied',
        actor: { kind: 'user', id: USER, role: 'SA' },
        groupId: GROUP,
        resource: { type: 'session', id: SESSION.toHexString() },
        requestId: 'req-12345678',
        ip: '203.0.113.9',
        metadata: { reason: 'claims', source: 'api' },
      },
    ]);
    assert.deepEqual(limiter.calls, [{ bucket: DPOP_REJECTED_BUCKET, key: USER.toHexString(), limit: DPOP_REJECTED_EVENTS_PER_HOUR }]);
  });

  it('leaves out the group and the address when there are none', async () => {
    const activityLog = memoryActivityLog();
    const { groupId: _, ...noGroup } = event();
    await createDpopRejectedAudit({ activityLog, rateLimiter: memoryRateLimiter(), logger: memoryLogger().logger })({ ...noGroup, context: { requestId: 'req-1', ip: null, userAgent: null } });
    assert.deepEqual([('groupId' in activityLog.entries[0]!), ('ip' in activityLog.entries[0]!)], [false, false]);
  });

  it('writes at most ten events an hour per user, except for a key mismatch', async () => {
    const activityLog = memoryActivityLog();
    const audit = createDpopRejectedAudit({ activityLog, rateLimiter: memoryRateLimiter(), logger: memoryLogger().logger });
    for (let i = 0; i < 12; i += 1) {
      await audit(event());
    }
    assert.equal(activityLog.entries.length, 10);
    await audit(event({ reason: 'keyMismatch' }));
    await audit(event({ userId: new ObjectId() }));
    assert.equal(activityLog.entries.length, 12);
  });

  it('logs a failing counter, without any detail, and writes the event anyway', async () => {
    const activityLog = memoryActivityLog();
    const logs = memoryLogger();
    const failing = { consume: () => Promise.reject(new TypeError('down')) };
    const audit = createDpopRejectedAudit({ activityLog, rateLimiter: failing, logger: logs.logger });
    await audit(event());
    const odd = createDpopRejectedAudit({ activityLog, rateLimiter: { consume: () => Promise.reject('plain') }, logger: logs.logger });
    await odd(event());
    assert.equal(activityLog.entries.length, 2);
    assert.deepEqual(logs.events.map((line) => [line['level'], line['msg'], line['errorName']]), [['error', 'dpop rejection counter failed', 'TypeError'], ['error', 'dpop rejection counter failed', 'unknown']]);
  });
});
