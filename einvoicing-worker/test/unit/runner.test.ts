import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Lease } from '../../src/lease.ts';
import type { LogFields, Logger } from '../../src/logger.ts';
import { createRunner } from '../../src/runner.ts';
import type { Job, JobContext } from '../../src/runner.ts';

const TTL = 30_000;
const RENEW = 10_000;

interface Entry {
  readonly level: string;
  readonly message: string;
  readonly fields: LogFields | undefined;
}

function setup(options: { jobs?: readonly Job[]; lease?: Partial<Lease>; sleep?: (ms: number, signal?: AbortSignal) => Promise<void> } = {}) {
  const clock = { now: 1_000_000 };
  const log: Entry[] = [];
  const logger: Logger = {
    debug: (message, fields) => log.push({ level: 'debug', message, fields }),
    info: (message, fields) => log.push({ level: 'info', message, fields }),
    warn: (message, fields) => log.push({ level: 'warn', message, fields }),
    error: (message, fields) => log.push({ level: 'error', message, fields }),
  };
  const calls: string[] = [];
  const lease: Lease = {
    tryAcquire: async () => {
      calls.push('acquire');
      return 1;
    },
    renew: async () => {
      calls.push('renew');
      return true;
    },
    release: async () => {
      calls.push('release');
      return true;
    },
    ...options.lease,
  };
  // Never elapses by itself: only an abort wakes it.
  const waitForAbort = (_ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
      signal?.addEventListener('abort', () => resolve(), { once: true });
      if (signal?.aborted === true) {
        resolve();
      }
    });
  const runner = createRunner({
    lease,
    jobs: options.jobs ?? [],
    clock: () => clock.now,
    sleep: options.sleep ?? waitForAbort,
    logger,
    intervalMs: 5_000,
    leaseRenewMs: RENEW,
    leaseTtlMs: TTL,
    staleMs: 60_000,
  });
  return { runner, clock, log, calls, lease };
}

describe('runner lease loop', () => {
  it('stays in standby, logging once, while another instance holds the lease', async () => {
    const { runner, log, calls } = setup({ lease: { tryAcquire: async () => null } });
    await runner.leaseStep();
    await runner.leaseStep();
    assert.equal(log.filter((e) => e.message.startsWith('standby')).length, 1);
    assert.deepEqual(calls, []);
  });

  it('acquires, then renews on later steps', async () => {
    const { runner, log, calls, clock } = setup();
    await runner.leaseStep();
    clock.now += RENEW;
    await runner.leaseStep();
    assert.deepEqual(calls, ['acquire', 'renew']);
    assert.deepEqual(log.find((e) => e.message === 'lease acquired')?.fields, { epoch: 1 });
  });

  it('logs and retries when acquisition throws', async () => {
    let attempts = 0;
    const { runner, log } = setup({
      lease: {
        tryAcquire: async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error('network');
          }
          return 3;
        },
      },
    });
    await runner.leaseStep();
    assert.equal(log.at(-1)?.message, 'lease acquisition failed');
    await runner.leaseStep();
    assert.equal(log.at(-1)?.message, 'lease acquired');
  });

  it('goes back to standby, aborting the jobs, when the renewal says the lease is lost', async () => {
    const seen: JobContext[] = [];
    let renewed = true;
    const { runner, log } = setup({
      lease: { renew: async () => renewed },
      jobs: [{ name: 'probe', run: async (ctx) => void seen.push(ctx) }],
    });
    await runner.leaseStep();
    await runner.jobsStep();
    renewed = false;
    await runner.leaseStep();
    assert.equal(seen[0]?.signal.aborted, true);
    assert.equal(log.at(-1)?.message, 'lease lost');
    await runner.jobsStep();
    assert.equal(seen.length, 1, 'no job runs without the lease');
  });

  it('keeps the lease through a transient renewal error but gives it up past the safety window', async () => {
    let failing = false;
    const { runner, log, clock } = setup({
      lease: {
        renew: async () => {
          if (failing) {
            throw new Error('network');
          }
          return true;
        },
      },
      jobs: [],
    });
    await runner.leaseStep();
    failing = true;
    clock.now += RENEW;
    await runner.leaseStep();
    assert.equal(log.at(-1)?.message, 'lease renewal failed');
    clock.now += RENEW;
    await runner.leaseStep();
    assert.equal(log.filter((e) => e.message.includes('giving the lease up')).length, 0, 'still inside TTL - renew');
    clock.now += RENEW;
    await runner.leaseStep();
    assert.equal(log.at(-1)?.message, 'lease renewal failing for too long: giving the lease up');
  });
});

describe('runner jobs loop', () => {
  it('runs the jobs in order with the epoch while the lease is held', async () => {
    const order: string[] = [];
    const epochs: number[] = [];
    const { runner } = setup({
      jobs: [
        { name: 'a', run: async (ctx) => void (order.push('a'), epochs.push(ctx.epoch)) },
        { name: 'b', run: async () => void order.push('b') },
      ],
    });
    await runner.jobsStep();
    assert.deepEqual(order, [], 'standby: nothing runs');
    await runner.leaseStep();
    await runner.jobsStep();
    assert.deepEqual(order, ['a', 'b']);
    assert.deepEqual(epochs, [1]);
  });

  it('logs a failing job by name and message and goes on with the next one', async () => {
    const ran: string[] = [];
    const { runner, log } = setup({
      jobs: [
        {
          name: 'bad',
          run: async () => {
            throw Object.assign(new Error('boom'), { code: 'E_BAD' });
          },
        },
        { name: 'good', run: async () => void ran.push('good') },
      ],
    });
    await runner.leaseStep();
    await runner.jobsStep();
    assert.deepEqual(ran, ['good']);
    const entry = log.find((e) => e.message === 'job failed');
    assert.equal(entry?.level, 'error');
    assert.equal((entry?.fields as { job: string }).job, 'bad');
  });

  it('skips the remaining jobs once the lease is lost during a round', async () => {
    const ran: string[] = [];
    let renewed = true;
    let runnerRef: ReturnType<typeof setup>['runner'] | undefined;
    const { runner } = setup({
      lease: { renew: async () => renewed },
      jobs: [
        {
          name: 'first',
          run: async () => {
            ran.push('first');
            renewed = false;
            await runnerRef?.leaseStep();
          },
        },
        { name: 'second', run: async () => void ran.push('second') },
      ],
    });
    runnerRef = runner;
    await runner.leaseStep();
    await runner.jobsStep();
    assert.deepEqual(ran, ['first']);
  });

  it('reports liveness from the last heartbeat, standby included', async () => {
    const { runner, clock } = setup();
    assert.equal(runner.isAlive(), true);
    await runner.jobsStep();
    clock.now += 60_000;
    assert.equal(runner.isAlive(), true);
    clock.now += 1;
    assert.equal(runner.isAlive(), false);
    await runner.jobsStep();
    assert.equal(runner.isAlive(), true);
  });
});

describe('runner start and stop', () => {
  it('runs both loops, is idempotent on start, and releases the lease on stop', async () => {
    const ran: number[] = [];
    const { runner, calls } = setup({ jobs: [{ name: 'j', run: async (ctx) => void ran.push(ctx.epoch) }] });
    runner.start();
    runner.start();
    // The first lease step has run synchronously up to its first await: give the loops a turn.
    await new Promise((resolve) => setImmediate(resolve));
    await runner.stop(1000);
    assert.deepEqual(calls.filter((c) => c === 'acquire'), ['acquire']);
    assert.equal(calls.at(-1), 'release');
    await runner.stop(1000);
  });

  it('keeps looping until stopped', async () => {
    let wake: (() => void) | undefined;
    let sleeps = 0;
    const { runner, calls } = setup({
      sleep: (_ms, signal) =>
        new Promise((resolve) => {
          sleeps += 1;
          if (signal?.aborted === true) {
            resolve();
            return;
          }
          if (sleeps <= 2) {
            // First sleep of each loop elapses at once, later ones wait for the abort.
            resolve();
            return;
          }
          wake = resolve;
          signal?.addEventListener('abort', () => resolve(), { once: true });
        }),
    });
    runner.start();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    await runner.stop(1000);
    assert.ok(calls.includes('renew'), 'a second lease step ran');
    wake?.();
  });

  it('stops without having started', async () => {
    const { runner, calls } = setup();
    await runner.stop(1000);
    assert.deepEqual(calls, ['release']);
  });

  it('aborts the running job, waits for it, and releases the lease', async () => {
    let aborted = false;
    const { runner, calls } = setup({
      jobs: [
        {
          name: 'long',
          run: (ctx) =>
            new Promise<void>((resolve) => {
              ctx.signal.addEventListener('abort', () => {
                aborted = true;
                resolve();
              });
            }),
        },
      ],
    });
    await runner.leaseStep();
    runner.start();
    await new Promise((resolve) => setImmediate(resolve));
    await runner.stop(1000);
    assert.equal(aborted, true);
    assert.equal(calls.at(-1), 'release');
  });

  it('gives up waiting for a job that ignores the abort after the grace period, still releasing', async () => {
    const { runner, calls, log } = setup({
      sleep: (ms, signal) =>
        new Promise((resolve) => {
          if (ms === 250) {
            resolve();
            return;
          }
          signal?.addEventListener('abort', () => resolve(), { once: true });
        }),
      jobs: [{ name: 'stuck', run: () => new Promise<void>(() => undefined) }],
    });
    await runner.leaseStep();
    runner.start();
    await new Promise((resolve) => setImmediate(resolve));
    await runner.stop(250);
    assert.equal(log.some((e) => e.message.startsWith('the running round did not finish')), true);
    assert.equal(calls.at(-1), 'release');
  });

  it('logs a failing release instead of throwing', async () => {
    const { runner, log } = setup({
      lease: {
        release: async () => {
          throw new Error('network');
        },
      },
    });
    await runner.stop(1000);
    assert.equal(log.at(-1)?.message, 'lease release failed');
  });
});
