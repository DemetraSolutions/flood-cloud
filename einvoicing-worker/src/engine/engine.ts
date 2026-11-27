/**
 * The queue engine: three jobs run in order on every round of the runner.
 *
 * 1. `engine-prepare`: starts the round (time budget), loads the persistent limiters when the lease epoch changed,
 *    creates the indexes once, refreshes the provider accounts when due, and decides which hubs are active.
 * 2. `upload`: claims and sends queued invoices (`upload.ts`).
 * 3. `status`: asks the provider about the uploaded ones (`status.ts`).
 *
 * **Safety switch.** `WORKER_HUBS` is an allowlist; empty means the engine does nothing at all: it reads no account, no
 * queue record and writes nothing (it only says so in the log once). This is what keeps the worker from sending a second
 * copy of an invoice while the legacy cron is still running. A record whose hub is not in the allowlist, or whose
 * account is missing, disabled or unusable, or whose provider has no adapter, is never claimed or modified.
 *
 * @module
 */
import { parseHub } from '../accounts/hub.ts';
import type { AccountRegistry } from '../accounts/registry.ts';
import type { ProviderAdapter } from '../providers/types.ts';
import type { Job } from '../runner.ts';
import type { EngineContext, RoundState } from './context.ts';
import { createStatusJob } from './status.ts';
import { createUploadJob } from './upload.ts';

/**
 * Tells the adapter of a hub's provider to drop what it cached for the hub (the account was disabled, removed or changed).
 *
 * @param adapters The adapters by provider.
 * @param hub The hub.
 */
export function forgetHub(adapters: ReadonlyMap<string, ProviderAdapter>, hub: string): void {
  adapters.get(parseHub(hub).provider)?.forget(hub);
}

/** Settings of {@link createEngine}. */
export interface EngineOptions {
  readonly context: EngineContext;
  /** The allowlist (`WORKER_HUBS`). */
  readonly hubs: readonly string[];
  /** Time budget of one round, in milliseconds (already capped by the caller at half of the liveness window). */
  readonly budgetMs: number;
  /** How often the accounts are read again, in milliseconds. */
  readonly accountsRefreshMs: number;
  /** Creates what the engine needs in the database (indexes), idempotently; run once, on the first round with a hub enabled. */
  readonly ensureIndexes: () => Promise<void>;
}

/** The engine. */
export interface Engine {
  /** The jobs to hand to the runner, in the order they must run. */
  readonly jobs: readonly Job[];
}

/**
 * Creates the engine.
 *
 * @param options Context, allowlist and timings.
 * @returns The jobs.
 */
export function createEngine(options: EngineOptions): Engine {
  const { context, hubs } = options;
  const { logger, clock, limiters } = context;
  const registry: AccountRegistry = context.registry;
  const round: RoundState = { startedAt: 0, activeHubs: [], rotation: 0 };
  let announced = false;
  let indexesReady = false;
  let lastRefreshAt: number | null = null;
  const missingAdapter = new Set<string>();

  const prepare: Job = {
    name: 'engine-prepare',
    async run({ epoch }) {
      round.startedAt = clock();
      round.activeHubs = [];
      round.rotation += 1;
      if (hubs.length === 0) {
        if (!announced) {
          announced = true;
          logger.info('no hubs enabled (WORKER_HUBS is empty): the worker processes nothing');
        }
        return;
      }
      if (!indexesReady) {
        await options.ensureIndexes();
        indexesReady = true;
      }
      await limiters.attach(epoch);
      limiters.sweep(round.startedAt);
      if (lastRefreshAt === null || round.startedAt - lastRefreshAt >= options.accountsRefreshMs) {
        await registry.refresh();
        lastRefreshAt = round.startedAt;
      }
      round.activeHubs = registry.hubs().filter((hub) => {
        const { provider } = parseHub(hub);
        if (context.adapters.has(provider)) {
          return true;
        }
        if (!missingAdapter.has(provider)) {
          missingAdapter.add(provider);
          logger.warn('no adapter for the provider: its hubs are skipped', { provider });
        }
        return false;
      });
    },
  };

  return { jobs: [prepare, createUploadJob(context, round, options.budgetMs), createStatusJob(context, round, options.budgetMs)] };
}
