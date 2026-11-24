import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import type { Request, Response } from 'express';
import { AppError } from '../../src/shared/http/errors.ts';
import { createSustainedRateLimitAudit } from '../../src/shared/activity-log/rate-limit-audit.ts';
import type { RateLimitDecision, RateLimiter } from '../../src/shared/security/rate-limit/rate-limiter.ts';
import { createRateLimitRules } from '../../src/shared/security/rate-limit/rules.ts';
import { SUSTAINED_EXEMPT_ROLES, sustainedRateLimit } from '../../src/shared/security/rate-limit/sustained.ts';
import type { SustainedExceededEvent, SustainedMode } from '../../src/shared/security/rate-limit/sustained.ts';
import { ACTIVITY_ALERT_ACTIONS, SECURITY_ACTIONS } from '../../src/shared/activity-log/catalog.ts';
import { memoryActivityLog } from '../helpers/activity.ts';
import { testConfig } from '../helpers/app.ts';

const rules = createRateLimitRules(testConfig());
const userId = new ObjectId();

/** A limiter that answers the decisions it is given for the hour and the day, in the order of the calls. */
function scripted(hour: Partial<RateLimitDecision>, day: Partial<RateLimitDecision>): RateLimiter & { calls: string[] } {
  const calls: string[] = [];
  const base = { allowed: true, limit: 10, remaining: 5, resetSeconds: 100, firstExcess: false };
  return {
    calls,
    peek: () => Promise.reject(new Error('unused')),
    consume: (bucket) => {
      calls.push(bucket);
      return Promise.resolve({ ...base, ...(bucket === 'api-hour:user' ? hour : day) });
    },
  };
}

function exchange(role: 'SA' | 'PSA' | 'D' | null, headers: Record<string, string> = {}) {
  const sent: Record<string, string> = { ...headers };
  const res = {
    locals: role === null ? {} : { auth: { userId, role } },
    getHeader: (name: string) => sent[name],
    set: (values: Record<string, string>) => void Object.assign(sent, values),
  } as unknown as Response;
  return { res, sent, req: {} as Request };
}

async function run(mode: SustainedMode, limiter: RateLimiter, role: 'SA' | 'PSA' | 'D' | null, headers: Record<string, string> = {}) {
  const events: Array<Pick<SustainedExceededEvent, 'window' | 'mode'>> = [];
  const handler = sustainedRateLimit({ hour: rules.apiPerUserHour, day: rules.apiPerUserDay, mode: () => Promise.resolve(mode), onExceeded: ({ window, mode: applied }) => void events.push({ window, mode: applied }) }, limiter);
  const { res, sent, req } = exchange(role, headers);
  let passed = false;
  let error: unknown;
  try {
    await handler(req, res, () => void (passed = true));
  } catch (caught) {
    error = caught;
  }
  return { passed, error, events, sent };
}

describe('sustainedRateLimit', () => {
  it('does nothing for a request without a user and counts nothing', async () => {
    const limiter = scripted({}, {});
    const result = await run('enforce', limiter, null);
    assert.deepEqual([result.passed, limiter.calls], [true, []]);
  });

  it('counts both windows of a user and leaves a request under the limits alone, with the headers of the tightest window in enforce', async () => {
    const limiter = scripted({ remaining: 7, limit: 20 }, { remaining: 3, limit: 9, resetSeconds: 500 });
    const result = await run('enforce', limiter, 'SA');
    assert.deepEqual([result.passed, limiter.calls, result.events], [true, ['api-hour:user', 'api-day:user'], []]);
    assert.deepEqual(result.sent, { 'RateLimit-Limit': '9', 'RateLimit-Remaining': '3', 'RateLimit-Reset': '500' });
    // On a tie the hour is shown.
    const tie = await run('enforce', scripted({ remaining: 4, limit: 20, resetSeconds: 60 }, { remaining: 4, limit: 9 }), 'SA');
    assert.equal(tie.sent['RateLimit-Limit'], '20');
    // Never replaces headers that already show fewer requests left (the per-minute rule).
    const tighter = await run('enforce', scripted({ remaining: 7 }, { remaining: 6 }), 'SA', { 'RateLimit-Remaining': '2', 'RateLimit-Limit': '300' });
    assert.deepEqual(tighter.sent, { 'RateLimit-Remaining': '2', 'RateLimit-Limit': '300' });
  });

  it('report mode lets everything pass, records each window once and never touches headers', async () => {
    const both = await run('report', scripted({ allowed: false, remaining: 0, firstExcess: true }, { allowed: false, remaining: 0, firstExcess: true }), 'SA');
    assert.deepEqual([both.passed, both.error, both.events, both.sent], [true, undefined, [{ window: 'hour', mode: 'report' }, { window: 'day', mode: 'report' }], {}]);
    const later = await run('report', scripted({ allowed: false, remaining: 0 }, { allowed: false, remaining: 0 }), 'SA');
    assert.deepEqual([later.passed, later.events], [true, []]);
  });

  it('enforce refuses with 429 and the Retry-After of the window that reopens last, reporting once', async () => {
    const result = await run('enforce', scripted({ allowed: false, remaining: 0, resetSeconds: 120, firstExcess: true }, { allowed: false, remaining: 0, limit: 99, resetSeconds: 4000, firstExcess: true }), 'SA');
    assert.equal(result.passed, false);
    assert.ok(result.error instanceof AppError && result.error.code === 'RATE_LIMITED');
    assert.deepEqual((result.error as AppError).headers, { 'Retry-After': '4000' });
    assert.deepEqual(result.events, [{ window: 'hour', mode: 'enforce' }, { window: 'day', mode: 'enforce' }]);
    assert.deepEqual(result.sent, { 'RateLimit-Limit': '99', 'RateLimit-Remaining': '0', 'RateLimit-Reset': '4000' });
    const hourOnly = await run('enforce', scripted({ allowed: false, remaining: 0, resetSeconds: 120 }, { remaining: 400, resetSeconds: 4000 }), 'SA');
    assert.deepEqual([(hourOnly.error as AppError).headers, hourOnly.events], [{ 'Retry-After': '120' }, []]);
    assert.equal(hourOnly.sent['RateLimit-Reset'], '120');
  });

  it('never refuses PSA and D, even in enforce: they are only reported, with the mode report', async () => {
    assert.deepEqual([...SUSTAINED_EXEMPT_ROLES], ['PSA', 'D']);
    for (const role of ['PSA', 'D'] as const) {
      const result = await run('enforce', scripted({ allowed: false, remaining: 0, firstExcess: true }, { allowed: false, remaining: 0 }), role);
      assert.deepEqual([result.passed, result.error, result.events, result.sent], [true, undefined, [{ window: 'hour', mode: 'report' }], {}]);
    }
  });

  it('propagates a failure of the counters (fail closed, like every rule)', async () => {
    const failing: RateLimiter = { peek: () => Promise.reject(new Error('x')), consume: () => Promise.reject(new Error('database down')) };
    const result = await run('report', failing, 'SA');
    assert.deepEqual([result.passed, (result.error as Error).message], [false, 'database down']);
  });

  it('keys the rules by the id of the user and never by a store key', () => {
    const store = { locals: { store: { keyId: userId } } } as never;
    assert.equal(rules.apiPerUserHour.key({} as never, { locals: { auth: { userId } } } as never), userId.toHexString());
    assert.equal(rules.apiPerUserDay.key({} as never, { locals: { auth: { userId } } } as never), userId.toHexString());
    assert.deepEqual([rules.apiPerUserHour.key({} as never, store), rules.apiPerUserDay.key({} as never, store)], [null, null]);
  });
});

describe('createSustainedRateLimitAudit', () => {
  const rec = async (mode: SustainedMode, groupId: ObjectId | null | undefined, ip: string | undefined) => {
    const log = memoryActivityLog();
    const audit = createSustainedRateLimitAudit(log);
    await audit({ window: 'day', rule: rules.apiPerUserDay, mode, req: { ip } as Request, res: { locals: { requestId: 'req-1', auth: { userId, role: 'SA', groupId } } } as never });
    return log.entries[0]!;
  };

  it('records a security event with the user, the window, the limit and the mode, and nothing of the request', async () => {
    const group = new ObjectId();
    const reported = await rec('report', group, '203.0.113.1');
    assert.deepEqual(
      { category: reported.category, action: reported.action, outcome: reported.outcome, actor: reported.actor, groupId: reported.groupId, requestId: reported.requestId, ip: reported.ip, metadata: reported.metadata },
      { category: 'security', action: 'rateLimit.sustainedExceeded', outcome: 'success', actor: { kind: 'user', id: userId, role: 'SA' }, groupId: group, requestId: 'req-1', ip: '203.0.113.1', metadata: { bucket: 'api-day:user', window: 'day', limit: 10000, mode: 'report' } },
    );
    const enforced = await rec('enforce', null, undefined);
    assert.deepEqual([enforced.outcome, 'groupId' in enforced, 'ip' in enforced, enforced.metadata?.['mode']], ['denied', false, false, 'enforce']);
    assert.equal('groupId' in (await rec('report', undefined, undefined)), false);
  });
});

describe('the alert actions', () => {
  it('are a frozen subset of the security actions', () => {
    assert.deepEqual([...ACTIVITY_ALERT_ACTIONS], ['rateLimit.sustainedExceeded', 'request.nonBrowser', 'settings.securityPolicyUpdated', 'store.activationCodeForActivePlace', 'store.activeKeyReplaced', 'store.activeKeyRevoked']);
    assert.ok(Object.isFrozen(ACTIVITY_ALERT_ACTIONS));
    for (const action of ACTIVITY_ALERT_ACTIONS) {
      assert.ok(SECURITY_ACTIONS.includes(action));
    }
  });
});
