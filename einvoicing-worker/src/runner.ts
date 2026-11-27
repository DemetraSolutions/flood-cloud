import type { Lease } from './lease.ts';
import type { Logger } from './logger.ts';

/** What a job receives on every run. */
export interface JobContext {
  /** Fencing epoch of the lease currently held: later steps stamp their writes with it. */
  readonly epoch: number;
  /** Aborted when the lease is lost or the worker shuts down: the job must stop promptly. */
  readonly signal: AbortSignal;
}

/** A unit of work run on every round while this instance holds the lease. */
export interface Job {
  /** Stable name, used in logs. */
  readonly name: string;
  /**
   * Runs one round of the job. Errors are logged by the runner and never stop the loop.
   *
   * @param context Epoch and abort signal.
   */
  run(context: JobContext): Promise<void>;
}

/** Collaborators and settings of {@link createRunner}. */
export interface RunnerOptions {
  readonly lease: Lease;
  /** Jobs run sequentially on every round; empty in the skeleton step. */
  readonly jobs: readonly Job[];
  /** Current time in milliseconds since the epoch. */
  readonly clock: () => number;
  /**
   * Resolves after `ms` milliseconds, or as soon as `signal` is aborted (it never rejects).
   * Injected so tests run without real waiting.
   */
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly logger: Logger;
  /** Pause between two rounds of jobs. */
  readonly intervalMs: number;
  /** Period of lease renewal while held and of acquisition attempts in standby. */
  readonly leaseRenewMs: number;
  /** Lease lifetime: renewals failing for longer than `leaseTtlMs - leaseRenewMs` make the runner give the lease up. */
  readonly leaseTtlMs: number;
  /** Maximum age of the last heartbeat for {@link Runner.isAlive}. */
  readonly staleMs: number;
}

/** The run loop. */
export interface Runner {
  /** Starts the lease loop and the jobs loop (idempotent). */
  start(): void;
  /**
   * Stops the loops (aborting the running jobs), waits for the current round up to `graceMs`, then releases the lease.
   *
   * @param graceMs Maximum wait for the running round.
   */
  stop(graceMs: number): Promise<void>;
  /** Whether the loop ticked within the stale window (standby counts as ticking). */
  isAlive(): boolean;
  /** One iteration of the lease loop: acquire in standby, renew while held. Exposed for tests. */
  leaseStep(): Promise<void>;
  /** One round of jobs, run only while the lease is held, then the heartbeat. Exposed for tests. */
  jobsStep(): Promise<void>;
}

/** The lease while this instance holds it. */
interface Held {
  readonly epoch: number;
  readonly controller: AbortController;
  lastRenewOkAt: number;
}

/**
 * Creates the run loop. The lease loop acquires (standby) or renews the lease every `leaseRenewMs`; the jobs loop runs the
 * jobs every `intervalMs` only while the lease is held, and records the heartbeat that feeds the liveness probe.
 * The two loops are independent so a long job never delays a renewal. A job error is logged (name, code and message only)
 * and never stops the loop. On lease loss or shutdown the jobs' signal is aborted.
 *
 * @param options Lease, jobs, clock, sleep, logger and timings.
 * @returns The runner.
 */
export function createRunner(options: RunnerOptions): Runner {
  const { lease, jobs, clock, sleep, logger } = options;
  const shutdown = new AbortController();
  let held: Held | null = null;
  let standbyLogged = false;
  let lastTickAt = clock();
  let loops: Promise<unknown> | null = null;

  /** Gives the lease up locally (the jobs are aborted) after it was lost or could not be renewed in time. */
  const drop = (reason: string): void => {
    (held as Held).controller.abort();
    logger.warn(reason, { epoch: (held as Held).epoch });
    held = null;
  };

  const leaseStep = async (): Promise<void> => {
    if (held === null) {
      let epoch: number | null;
      try {
        epoch = await lease.tryAcquire(clock());
      } catch (error) {
        logger.warn('lease acquisition failed', { error });
        return;
      }
      if (epoch === null) {
        if (!standbyLogged) {
          logger.info('standby: another instance holds the lease');
          standbyLogged = true;
        }
        return;
      }
      held = { epoch, controller: new AbortController(), lastRenewOkAt: clock() };
      standbyLogged = false;
      logger.info('lease acquired', { epoch });
      return;
    }
    let renewed: boolean;
    try {
      renewed = await lease.renew(clock());
    } catch (error) {
      logger.warn('lease renewal failed', { error });
      if (clock() - held.lastRenewOkAt > options.leaseTtlMs - options.leaseRenewMs) {
        drop('lease renewal failing for too long: giving the lease up');
      }
      return;
    }
    if (renewed) {
      held.lastRenewOkAt = clock();
    } else {
      drop('lease lost');
    }
  };

  const jobsStep = async (): Promise<void> => {
    lastTickAt = clock();
    const current = held;
    if (current !== null) {
      for (const job of jobs) {
        if (current.controller.signal.aborted) {
          break;
        }
        try {
          await job.run({ epoch: current.epoch, signal: current.controller.signal });
        } catch (error) {
          logger.error('job failed', { job: job.name, error });
        }
      }
    }
    lastTickAt = clock();
  };

  const loop = async (step: () => Promise<void>, periodMs: number): Promise<void> => {
    while (!shutdown.signal.aborted) {
      await step();
      await sleep(periodMs, shutdown.signal);
    }
  };

  return {
    leaseStep,
    jobsStep,

    start() {
      if (loops !== null) {
        return;
      }
      lastTickAt = clock();
      loops = Promise.all([loop(leaseStep, options.leaseRenewMs), loop(jobsStep, options.intervalMs)]);
    },

    isAlive() {
      return clock() - lastTickAt <= options.staleMs;
    },

    async stop(graceMs) {
      shutdown.abort();
      held?.controller.abort();
      if (loops !== null) {
        const graceTimer = new AbortController();
        const timedOut = await Promise.race([loops.then(() => false), sleep(graceMs, graceTimer.signal).then(() => true)]);
        graceTimer.abort();
        if (timedOut) {
          logger.warn('the running round did not finish within the grace period', { graceMs });
        }
      }
      try {
        await lease.release(clock());
      } catch (error) {
        logger.error('lease release failed', { error });
      }
    },
  };
}
