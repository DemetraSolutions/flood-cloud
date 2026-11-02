import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { actorOf } from '../../src/shared/activity-log/actor.ts';
import { createCrossGroupAuditor } from '../../src/shared/activity-log/cross-group-audit.ts';
import { recordDataChange } from '../../src/shared/activity-log/data-change.ts';
import { buildActivityDocument } from '../../src/shared/activity-log/activity-log.ts';
import { createRateLimitAudit } from '../../src/shared/activity-log/rate-limit-audit.ts';
import { createErrorActivityReporter } from '../../src/shared/http/error-activity.ts';
import { memoryActivityLog } from '../helpers/activity.ts';
import { memoryLogger } from '../helpers/app.ts';

const userId = new ObjectId();
const groupId = new ObjectId();
const principal = { userId, role: 'PSA' } as never;

describe('actorOf', () => {
  it('describes a user or an anonymous caller', () => {
    assert.deepEqual(actorOf(undefined), { kind: 'anonymous' });
    assert.deepEqual(actorOf({ userId, role: 'SA' }), { kind: 'user', id: userId, role: 'SA' });
  });
});

describe('recordDataChange', () => {
  it('records a success in the data category with the changes', async () => {
    const log = memoryActivityLog();
    await recordDataChange(log, {
      actor: { kind: 'user', id: userId, role: 'SA' },
      groupId,
      resource: { type: 'company', id: 'c1' },
      action: 'company.updated',
      before: { a: 1 },
      after: { a: 2, secret: 'x' },
      sensitive: ['secret'],
      requestId: 'r-1',
      ip: '1.2.3.4',
    });
    assert.deepEqual(log.entries, [
      {
        category: 'data',
        action: 'company.updated',
        outcome: 'success',
        actor: { kind: 'user', id: userId, role: 'SA' },
        groupId,
        resource: { type: 'company', id: 'c1' },
        changes: [{ field: 'a', before: 1, after: 2 }, { field: 'secret', redacted: true }],
        requestId: 'r-1',
        ip: '1.2.3.4',
      },
    ]);
  });

  it('works with the minimum, and caps the changes at 200 saying so in the metadata', async () => {
    const log = memoryActivityLog();
    await recordDataChange(log, { actor: { kind: 'system' }, resource: { type: 'place' }, action: 'place.created', before: undefined, after: { a: 1 } });
    assert.equal('groupId' in log.entries[0]!, false);
    assert.equal('requestId' in log.entries[0]!, false);
    assert.equal('metadata' in log.entries[0]!, false);
    const many = Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`f${i}`, i]));
    await recordDataChange(log, { actor: { kind: 'system' }, resource: { type: 'place' }, action: 'place.created', before: undefined, after: many });
    assert.equal(log.entries[1]?.changes?.length, 200);
    assert.deepEqual(log.entries[1]?.metadata, { changesTruncated: true, changesTotal: 250 });
    const exact = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`f${i}`, i]));
    await recordDataChange(log, { actor: { kind: 'system' }, resource: { type: 'place' }, action: 'place.created', before: undefined, after: exact });
    assert.equal(log.entries[2]?.metadata, undefined);
  });
});

describe('createCrossGroupAuditor', () => {
  const req = () => ({ ip: '203.0.113.1', res: { locals: { requestId: 'req-1' } } }) as never;
  const setup = (maxEntries?: number) => {
    const log = memoryActivityLog();
    let now = 1_000_000;
    const audit = createCrossGroupAuditor({ activityLog: log, now: () => now, ...(maxEntries === undefined ? {} : { maxEntries }) });
    return { log, audit, advance: (ms: number) => void (now += ms) };
  };

  it('records success and denied accesses with group, request id and IP', async () => {
    const { log, audit } = setup();
    await audit({ principal, groupId, req: req(), granted: true });
    await audit({ principal, groupId, req: req(), granted: false });
    assert.deepEqual(
      log.entries.map(({ category, action, outcome, actor, groupId: g, requestId, ip }) => ({ category, action, outcome, actor, g, requestId, ip })),
      [
        { category: 'security', action: 'group.crossAccess', outcome: 'success', actor: { kind: 'user', id: userId, role: 'PSA' }, g: groupId, requestId: 'req-1', ip: '203.0.113.1' },
        { category: 'security', action: 'group.crossAccess', outcome: 'denied', actor: { kind: 'user', id: userId, role: 'PSA' }, g: groupId, requestId: 'req-1', ip: '203.0.113.1' },
      ],
    );
  });

  it('omits what the request does not have', async () => {
    const { log, audit } = setup();
    await audit({ principal, groupId, req: {} as never, granted: true });
    assert.equal('ip' in log.entries[0]!, false);
    assert.equal('requestId' in log.entries[0]!, false);
  });

  it('records a repeated (actor, group, outcome) once per 15 minutes, per triple', async () => {
    const { log, audit, advance } = setup();
    const other = { userId: new ObjectId(), role: 'D' } as never;
    for (let i = 0; i < 3; i += 1) {
      await audit({ principal, groupId, req: req(), granted: true });
    }
    await audit({ principal: other, groupId, req: req(), granted: true });
    await audit({ principal, groupId: new ObjectId(), req: req(), granted: true });
    assert.equal(log.entries.length, 3);
    advance(15 * 60 * 1000 - 1);
    await audit({ principal, groupId, req: req(), granted: true });
    assert.equal(log.entries.length, 3);
    advance(1);
    await audit({ principal, groupId, req: req(), granted: true });
    assert.equal(log.entries.length, 4);
  });

  it('forgets the oldest triple when the memory is full', async () => {
    const { log, audit } = setup(2);
    const [g1, g2, g3] = [new ObjectId(), new ObjectId(), new ObjectId()];
    for (const g of [g1, g2, g3]) {
      await audit({ principal, groupId: g, req: req(), granted: true });
    }
    assert.equal(log.entries.length, 3);
    await audit({ principal, groupId: g2, req: req(), granted: true }); // still remembered
    assert.equal(log.entries.length, 3);
    await audit({ principal, groupId: g1, req: req(), granted: true }); // evicted: recorded again
    assert.equal(log.entries.length, 4);
  });

  it('uses the production limits by default', async () => {
    const log = memoryActivityLog();
    const audit = createCrossGroupAuditor({ activityLog: log, now: () => 0 });
    await audit({ principal, groupId, req: req(), granted: true });
    await audit({ principal, groupId, req: req(), granted: true });
    assert.equal(log.entries.length, 1);
  });
});

describe('createErrorActivityReporter', () => {
  const locals = (extra: Record<string, unknown> = {}) => ({ locals: { requestId: 'req-9', ...extra } }) as never;
  const request = (overrides: Record<string, unknown> = {}) => ({ method: 'POST', originalUrl: '/v1/groups/fc_at_secret?token=secret', ip: '10.0.0.1', ...overrides }) as never;
  const setup = (maxPerMinute?: number) => {
    const log = memoryActivityLog();
    const { logger, events } = memoryLogger();
    let now = 60_000 * 10;
    const reporter = createErrorActivityReporter({ activityLog: log, logger, now: () => now, ...(maxPerMinute === undefined ? {} : { maxPerMinute }) });
    return { log, events, reporter, advance: (ms: number) => void (now += ms) };
  };

  it('records an anonymous failure with method, route pattern and error class, never message or stack', () => {
    const { log, reporter } = setup();
    reporter.report(new TypeError('secret detail'), request(), locals({ routePattern: '/v1/groups/:groupId' }));
    assert.deepEqual(log.entries, [
      {
        category: 'error',
        action: 'request.failed',
        outcome: 'failure',
        actor: { kind: 'anonymous' },
        requestId: 'req-9',
        ip: '10.0.0.1',
        metadata: { method: 'POST', route: '/v1/groups/:groupId', errorName: 'TypeError' },
      },
    ]);
    assert.ok(!JSON.stringify(log.entries).includes('secret'));
  });

  it('takes the actor and the group from the response, and the code of the error when it has one', () => {
    const { log, reporter } = setup();
    const access = { groupId, crossGroup: false };
    reporter.report(Object.assign(new Error('x'), { code: 11000 }), request({ ip: undefined }), locals({ auth: { userId, role: 'SA' }, groupAccess: access }));
    reporter.report(Object.assign(new Error('x'), { code: 'EPIPE' }), request(), locals());
    reporter.report(Object.assign(new Error('x'), { code: {} }), request(), locals());
    reporter.report('plain string', request(), locals());
    reporter.report(null, request(), locals());
    const [first, second, third, fourth, fifth] = log.entries;
    assert.deepEqual([first?.actor, first?.groupId, 'ip' in first!, first?.metadata?.['errorCode']], [{ kind: 'user', id: userId, role: 'SA' }, groupId, false, 11000]);
    assert.equal(second?.metadata?.['errorCode'], 'EPIPE');
    assert.equal('errorCode' in third!.metadata!, false);
    assert.equal(fourth?.metadata?.['errorName'], 'string');
    assert.equal(fifth?.metadata?.['errorName'], 'object');
  });

  it('writes at most 100 entries a minute and logs how many it skipped once the minute is over', () => {
    const { log, events, reporter, advance } = setup();
    for (let i = 0; i < 130; i += 1) {
      reporter.report(new Error('x'), request(), locals());
    }
    assert.equal(log.entries.length, 100);
    assert.deepEqual(events.map((event) => [event['level'], event['msg']]), [['warn', 'error activity entries are being skipped by the per-minute limit']]);
    advance(60_000);
    reporter.report(new Error('x'), request(), locals());
    assert.equal(log.entries.length, 101);
    assert.equal(events.length, 2);
    assert.deepEqual([events[1]?.['level'], events[1]?.['skipped'], events[1]?.['limit']], ['warn', 30, 100]);
    advance(60_000);
    reporter.report(new Error('x'), request(), locals());
    assert.equal(events.length, 2);
  });

  it('records the route pattern, or [unmatched], never the concrete path', () => {
    const { log, reporter } = setup();
    const encoded = '%66c_at_SECRETTOKEN';
    reporter.report(new Error('x'), request({ originalUrl: `/v1/things/${encoded}` }), locals({ routePattern: '/v1/things/:id' }));
    reporter.report(new Error('x'), request({ originalUrl: `/v1/${encoded}/x` }), locals());
    assert.deepEqual(log.entries.map((entry) => entry.metadata?.['route']), ['/v1/things/:id', '[unmatched]']);
    assert.ok(!JSON.stringify(log.entries).includes('SECRETTOKEN'));
  });

  it('honors a custom limit', () => {
    const { log, reporter } = setup(2);
    for (let i = 0; i < 5; i += 1) {
      reporter.report(new Error('x'), request(), locals());
    }
    assert.equal(log.entries.length, 2);
  });

  it('does not wait for the write, and logs a rejected write instead of leaving it unhandled', async () => {
    const { logger, events } = memoryLogger();
    const rejecting = { record: () => Promise.reject(new Error('invalid entry')) };
    createErrorActivityReporter({ activityLog: rejecting, logger, now: () => 0 }).report(new Error('x'), request(), locals());
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(events[0]?.['msg'], 'error activity entry rejected');
    assert.equal(events[0]?.['requestId'], 'req-9');
  });
});

describe('createRateLimitAudit', () => {
  it('records the bucket, the caller, the request id and the IP, never the subject key', async () => {
    const log = memoryActivityLog();
    const audit = createRateLimitAudit(log);
    const rule = { bucket: 'login:ip', limit: 1, key: () => 'the-key' };
    await audit({ rule, req: { ip: '10.0.0.2' } as never, res: { locals: { requestId: 'req-3' } } as never });
    await audit({ rule, req: {} as never, res: { locals: { requestId: 'req-4', auth: { userId, role: 'SA' } } } as never });
    assert.deepEqual(log.entries, [
      { category: 'security', action: 'rateLimit.exceeded', outcome: 'denied', actor: { kind: 'anonymous' }, requestId: 'req-3', ip: '10.0.0.2', metadata: { bucket: 'login:ip' } },
      { category: 'security', action: 'rateLimit.exceeded', outcome: 'denied', actor: { kind: 'user', id: userId, role: 'SA' }, requestId: 'req-4', metadata: { bucket: 'login:ip' } },
    ]);
    assert.ok(!JSON.stringify(log.entries).includes('the-key'));
  });
});

describe('buildActivityDocument changes', () => {
  it('keeps structured change values, flags and redacts only their strings', () => {
    const document = buildActivityDocument(
      {
        category: 'data',
        action: 'place.updated',
        outcome: 'success',
        actor: { kind: 'system' },
        changes: [
          { field: 'a', before: [1, 'x', null, { k: true }], after: { n: 2, s: 'fc_at_zzz', list: ['mongodb://h'] } },
          { field: 'password', redacted: true },
          { field: 'bio', after: 'cut', truncated: true },
          { field: 'only', before: false },
          { field: 'who', after: { name: 'Mario', email: 'm@x.it', token: 'zzz' } },
        ],
      },
      new Date(0),
      1,
    );
    assert.deepEqual(document.changes, [
      { field: 'a', before: [1, 'x', null, { k: true }], after: { n: 2, s: '[REDACTED]', list: ['[REDACTED]'] } },
      { field: 'password', redacted: true },
      { field: 'bio', after: 'cut', truncated: true },
      { field: 'only', before: false },
      { field: 'who', after: { name: 'Mario', email: 'm@x.it', token: '[REDACTED]' } },
    ]);
    assert.equal(document.expiresAt.getTime(), 86_400_000);
  });
});
