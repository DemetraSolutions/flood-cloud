import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { describe, it } from 'node:test';
import { REDACTED, Secret } from '../../src/secret.ts';
import { romeDate, romeYear, sleep, startOfNextRomeYear } from '../../src/time.ts';

describe('Secret', () => {
  it('never reveals the value except through reveal()', () => {
    const secret = new Secret('s3cr3t');
    assert.equal(secret.reveal(), 's3cr3t');
    assert.equal(String(secret), REDACTED);
    assert.equal(JSON.stringify({ secret }), `{"secret":"${REDACTED}"}`);
    assert.equal(inspect(secret), REDACTED);
    assert.equal(Object.isFrozen(secret), true);
  });
});

describe('sleep', () => {
  it('resolves after the time has elapsed', async () => {
    const started = Date.now();
    await sleep(30);
    assert.ok(Date.now() - started >= 25);
  });

  it('resolves at once when the signal is already aborted', async () => {
    const started = Date.now();
    await sleep(10_000, AbortSignal.abort());
    assert.ok(Date.now() - started < 1000);
  });

  it('resolves as soon as the signal is aborted', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const waiting = sleep(10_000, controller.signal);
    controller.abort();
    await waiting;
    assert.ok(Date.now() - started < 1000);
  });

  it('works without a signal and with one that never fires', async () => {
    await sleep(1);
    await sleep(1, new AbortController().signal);
  });
});

describe('the fiscal calendar (Europe/Rome)', () => {
  it('romeDate follows the Rome calendar day, not UTC', () => {
    assert.equal(romeDate(Date.UTC(2026, 10, 27, 10, 0)), '2026-11-27');
    assert.equal(romeDate(Date.UTC(2026, 11, 31, 22, 59, 59)), '2026-12-31');
    assert.equal(romeDate(Date.UTC(2026, 11, 31, 23, 0, 0)), '2027-01-01');
    assert.equal(romeDate(Date.UTC(2026, 5, 30, 22, 0, 0)), '2026-07-01', 'summer time is +02:00');
  });

  it('romeYear and startOfNextRomeYear turn over at midnight in Italy', () => {
    assert.equal(romeYear(Date.UTC(2026, 11, 31, 23, 0, 0)), 2027);
    assert.equal(romeYear(Date.UTC(2026, 0, 1, 0, 0, 0)), 2026);
    assert.equal(startOfNextRomeYear(Date.UTC(2026, 5, 1)), Date.UTC(2026, 11, 31, 23, 0, 0));
    assert.equal(startOfNextRomeYear(Date.UTC(2026, 11, 31, 23, 30)), Date.UTC(2027, 11, 31, 23, 0, 0));
  });
});
