import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NON_BROWSER_POLICIES, SECURITY_POLICY_RETRY_MS, SECURITY_POLICY_TTL_MS, createSecurityPolicyProvider, SUSTAINED_POLICIES, securityPolicyOf, storedSecurityPolicyOf } from '../../src/shared/security/security-policy.ts';
import { memoryLogger } from '../helpers/app.ts';

const view = (nonBrowserRequests: string, sustainedLimits: string, a: string, b: string) => ({ nonBrowserRequests, sustainedLimits, sources: { nonBrowserRequests: a, sustainedLimits: b } });

describe('storedSecurityPolicyOf and securityPolicyOf', () => {
  it('keeps the well formed fields of a stored value and ignores everything else', () => {
    assert.deepEqual([...NON_BROWSER_POLICIES], ['report', 'block']);
    assert.deepEqual([...SUSTAINED_POLICIES], ['report', 'enforce']);
    assert.deepEqual(storedSecurityPolicyOf({ nonBrowserRequests: 'block', sustainedLimits: 'enforce' }), { nonBrowserRequests: 'block', sustainedLimits: 'enforce' });
    assert.deepEqual(storedSecurityPolicyOf({ nonBrowserRequests: 'block', extra: 1 }), { nonBrowserRequests: 'block' });
    assert.deepEqual(storedSecurityPolicyOf({ sustainedLimits: 'report' }), { sustainedLimits: 'report' });
    for (const damaged of [null, undefined, 'block', 7, [], [{ nonBrowserRequests: 'block' }], {}, { nonBrowserRequests: 'maybe', sustainedLimits: 'block' }, { nonBrowserRequests: 'BLOCK' }, { other: 'block' }]) {
      assert.deepEqual(storedSecurityPolicyOf(damaged), {}, JSON.stringify(damaged));
    }
  });

  it('is report for the non-browser requests and the given default for the limits when nothing is saved, and what is saved prevails, field by field', () => {
    assert.deepEqual(securityPolicyOf(null, 'report'), view('report', 'report', 'default', 'default'));
    assert.deepEqual(securityPolicyOf(null, 'enforce'), view('report', 'enforce', 'default', 'default'));
    assert.deepEqual(securityPolicyOf({ nonBrowserRequests: 'block' }, 'enforce'), view('block', 'enforce', 'database', 'default'));
    assert.deepEqual(securityPolicyOf({ sustainedLimits: 'report' }, 'enforce'), view('report', 'report', 'default', 'database'));
    assert.deepEqual(securityPolicyOf({ nonBrowserRequests: 'report', sustainedLimits: 'enforce' }, 'report'), view('report', 'enforce', 'database', 'database'));
    assert.deepEqual(securityPolicyOf({ nonBrowserRequests: 'maybe', sustainedLimits: 'x' }, 'enforce'), view('report', 'enforce', 'default', 'default'));
    assert.ok(Object.isFrozen(securityPolicyOf(null, 'report')) && Object.isFrozen(securityPolicyOf(null, 'report').sources));
    // The emergency exit: both fields report only, with the source forced, whatever is saved and whatever the default is.
    for (const stored of [null, { nonBrowserRequests: 'block', sustainedLimits: 'enforce' }]) {
      assert.deepEqual(securityPolicyOf(stored, 'enforce', true), view('report', 'report', 'forced', 'forced'));
    }
    assert.ok(Object.isFrozen(securityPolicyOf(null, 'report', true).sources));
  });
});

describe('the security policy in memory', () => {
  const setup = (read: () => Promise<unknown>) => {
    const clock = { now: 1_000_000 };
    const logs = memoryLogger();
    return { clock, logs, provider: createSecurityPolicyProvider({ read, sustainedDefault: 'enforce', forceReport: false, logger: logs.logger, now: () => clock.now }) };
  };

  it('reads once, keeps the value for its time and reads again after it expires', async () => {
    let reads = 0;
    let stored: unknown = { nonBrowserRequests: 'block' };
    const { clock, provider } = setup(() => (reads += 1, Promise.resolve(stored)));
    assert.equal((await provider.get()).nonBrowserRequests, 'block');
    stored = { nonBrowserRequests: 'report' };
    clock.now += SECURITY_POLICY_TTL_MS - 1;
    assert.equal((await provider.get()).nonBrowserRequests, 'block', 'the copy is kept until it expires');
    clock.now += 1;
    assert.equal((await provider.get()).nonBrowserRequests, 'report');
    assert.equal(reads, 2);
  });

  it('does one read at a time whatever the number of requests waiting', async () => {
    let reads = 0;
    let release: (value: unknown) => void = () => undefined;
    const { provider } = setup(() => (reads += 1, new Promise((resolve) => (release = resolve))));
    const waiting = Array.from({ length: 20 }, () => provider.get());
    release({ nonBrowserRequests: 'block' });
    assert.deepEqual((await Promise.all(waiting)).map((policy) => policy.nonBrowserRequests), Array(20).fill('block'));
    assert.equal(reads, 1);
  });

  it('is replaced at once by set, and expires after it like a read', async () => {
    let reads = 0;
    const { clock, provider } = setup(() => (reads += 1, Promise.resolve(null)));
    provider.set(securityPolicyOf({ nonBrowserRequests: 'block' }, 'report'));
    assert.equal((await provider.get()).nonBrowserRequests, 'block');
    assert.equal(reads, 0);
    clock.now += SECURITY_POLICY_TTL_MS;
    assert.deepEqual([(await provider.get()).nonBrowserRequests, (await provider.get()).sustainedLimits], ['report', 'enforce'], 'a document that is gone is the defaults, the environment one included');
  });

  it('uses the last known value when a read fails, and report when there is none, logging the error and trying again after a short while', async () => {
    let fail = true;
    let reads = 0;
    const { clock, logs, provider } = setup(() => (reads += 1, fail ? Promise.reject(new Error('mongo down')) : Promise.resolve({ nonBrowserRequests: 'block' })));
    assert.deepEqual([(await provider.get()).nonBrowserRequests, (await provider.get()).sustainedLimits], ['report', 'enforce'], 'a cold start with the database down: the default of the server (the environment says enforce), never a block of the non-browser requests');
    assert.equal((await provider.get()).nonBrowserRequests, 'report');
    assert.equal(reads, 1, 'not retried at once');
    assert.deepEqual(logs.events.map((event) => [event['level'], event['msg'], event['errorName']]), [['error', 'security policy read failed', 'Error']]);
    fail = false;
    clock.now += SECURITY_POLICY_RETRY_MS;
    assert.equal((await provider.get()).nonBrowserRequests, 'block');
    fail = true;
    clock.now += SECURITY_POLICY_TTL_MS;
    assert.equal((await provider.get()).nonBrowserRequests, 'block', 'the last known value survives a failed read');
    const odd = setup(() => Promise.reject('plain string'));
    assert.equal((await odd.provider.get()).nonBrowserRequests, 'report');
    const forced = createSecurityPolicyProvider({ read: () => Promise.reject(new Error('down')), sustainedDefault: 'enforce', forceReport: true, logger: memoryLogger().logger, now: () => 1 });
    assert.deepEqual((await forced.get()).sources, { nonBrowserRequests: 'forced', sustainedLimits: 'forced' }, 'forced, even before the first read');
    const forcedRead = createSecurityPolicyProvider({ read: () => Promise.resolve({ nonBrowserRequests: 'block', sustainedLimits: 'enforce' }), sustainedDefault: 'enforce', forceReport: true, logger: memoryLogger().logger, now: () => 1 });
    assert.deepEqual([(await forcedRead.get()).nonBrowserRequests, (await forcedRead.get()).sustainedLimits], ['report', 'report']);
    assert.equal(odd.logs.events[0]?.['errorName'], 'unknown');
  });
});
