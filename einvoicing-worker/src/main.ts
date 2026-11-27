import { existsSync } from 'node:fs';
import type { MongoClient } from 'mongodb';
import { loadConfig } from './config.ts';
import type { Config } from './config.ts';
import { createCredentialDecryptor, refuseCredentials } from './accounts/credentials.ts';
import { createAccountRegistry } from './accounts/registry.ts';
import { connectAndPing, createMongoClient } from './db/client.ts';
import { commonDatabaseName, queueDatabaseName } from './db/names.ts';
import { createEngine, forgetHub } from './engine/engine.ts';
import { createGroupStore } from './engine/groups.ts';
import { createSentHistory, SENT_COLLECTION } from './engine/history.ts';
import type { SentInvoice } from './engine/history.ts';
import { createQueueStore } from './engine/queue.ts';
import { startHealthServer } from './health.ts';
import type { HealthServer } from './health.ts';
import { createLease, LEASE_COLLECTION } from './lease.ts';
import type { LeaseDocument } from './lease.ts';
import { createShadowJob } from './shadow/job.ts';
import { createShadowQueue } from './shadow/queue.ts';
import { createShadowReports, SHADOW_COLLECTION } from './shadow/reports.ts';
import type { ShadowReport } from './shadow/reports.ts';
import { currentCodeVersion } from './shadow/version.ts';
import { createLimiters, ensureLimiterIndexes, LIMITS_COLLECTION } from './limits/limiters.ts';
import type { LimiterDocument } from './limits/limiters.ts';
import { createLogger } from './logger.ts';
import type { Logger } from './logger.ts';
import { createArubaAdapter } from './providers/aruba/adapter.ts';
import type { ProviderAdapter } from './providers/types.ts';
import { createRunner } from './runner.ts';
import type { Job, Runner } from './runner.ts';
import { sleep } from './time.ts';

/** Maximum wait for the running round of jobs during the shutdown. */
export const SHUTDOWN_GRACE_MS = 20_000;

/** Time kept free in the liveness window beyond the longest adapter call and the round budget. */
export const HEALTH_MARGIN_MS = 30_000;

/** Smallest round budget the worker starts with: below it no round could do useful work. */
export const MIN_BUDGET_MS = 2_000;

/** Most dealer accounts read per provider at a refresh. */
const ACCOUNT_SCAN_LIMIT = 5_000;

/** Most limiter documents loaded when the lease epoch changes. */
const LIMITER_LOAD_LIMIT = 100_000;

/** The parts of the Node `process` the worker uses (replaceable in tests). */
export interface ProcessLike {
  readonly env: Record<string, string | undefined>;
  readonly stdout: { write(text: string): unknown };
  readonly stderr: { write(text: string): unknown };
  loadEnvFile(path: string): void;
  exit(code: number): void;
  on(event: 'SIGTERM' | 'SIGINT' | 'uncaughtException' | 'unhandledRejection', listener: (...args: unknown[]) => void): unknown;
}

/** Collaborators of {@link startWorker} that tests can replace. */
export interface WorkerDeps {
  /** Tells whether a `.env` file exists in the working directory (the real check by default). */
  readonly dotEnvExists?: () => boolean;
  /** Builds the MongoDB client ({@link createMongoClient} by default). */
  readonly createClient?: typeof createMongoClient;
  /** Replaces the jobs of the run loop (tests); the queue engine (`send`) or the shadow job (`shadow`) by default. */
  readonly jobs?: readonly Job[];
  /** Computes the shadow code version from `BUILD_SHA` ({@link currentCodeVersion} by default). */
  readonly codeVersion?: (buildSha: string | undefined) => string;
  /** The provider adapters by provider; the Aruba adapter (when `ARUBA_ENVIRONMENT` is set) by default. */
  readonly adapters?: ReadonlyMap<string, ProviderAdapter>;
  /** Random source of the limiters' jitter (`Math.random` by default). */
  readonly random?: () => number;
}

/** Handle of a running worker. */
export interface RunningWorker {
  readonly client: MongoClient;
  readonly runner: Runner;
  readonly health: HealthServer;
  /** Starts the graceful shutdown (idempotent); settles after the exit was requested. */
  shutdown(signal: string): Promise<void>;
}

/**
 * Loads `.env` into `env`, ignoring only a missing file.
 *
 * @param proc Process abstraction.
 * @throws {Error} Any error other than `ENOENT` (for example a permission or parse error).
 */
export function loadDotEnv(proc: Pick<ProcessLike, 'loadEnvFile'>): void {
  try {
    proc.loadEnvFile('.env');
  } catch (error) {
    if (!(error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT')) {
      throw error;
    }
  }
}

/**
 * Entry point logic: the only place that reads `process.env`, opens the port and handles signals.
 * A startup failure (invalid configuration, `.env` in production, MongoDB or port unavailable) is logged and ends with
 * exit code 1. On SIGTERM/SIGINT it stops the runner (aborting the jobs), waits for the current round (at most
 * {@link SHUTDOWN_GRACE_MS}), releases the lease, closes the probe and MongoDB, and exits with 0.
 *
 * @param proc The Node `process` (or a test double).
 * @param deps Replaceable collaborators; the real ones by default.
 * @returns The running worker, or `undefined` if startup failed (exit already requested).
 * @throws {Error} If `.env` exists but cannot be read.
 */
export async function startWorker(proc: ProcessLike, deps: WorkerDeps = {}): Promise<RunningWorker | undefined> {
  loadDotEnv(proc);

  const fail = (logger: Logger, message: string, fields: Record<string, unknown>): undefined => {
    logger.error(message, fields);
    proc.exit(1);
    return undefined;
  };

  const result = loadConfig(proc.env);
  if (!result.ok) {
    const early = createLogger({ level: 'error', write: (line) => proc.stderr.write(`${line}\n`), now: Date.now });
    return fail(early, 'invalid configuration', { issues: result.issues });
  }
  const config: Config = result.config;
  const logger = createLogger({ level: config.logLevel, write: (line) => proc.stdout.write(`${line}\n`), now: Date.now });

  // A deployed image takes its secrets from the secret manager: a `.env` next to a production process is refused.
  if (config.appEnv === 'production' && (deps.dotEnvExists ?? (() => existsSync('.env')))()) {
    return fail(logger, 'a .env file exists in the working directory: in production secrets come from the secret manager, remove it', {});
  }

  let client: MongoClient;
  try {
    client = (deps.createClient ?? createMongoClient)(config);
    await connectAndPing(client);
  } catch (error) {
    return fail(logger, 'MongoDB is not available', { error });
  }
  const closeClient = async (): Promise<void> => {
    await client.close();
  };

  const names = { prefix: config.dbNamePrefix, appEnv: config.appEnv };
  const common = client.db(commonDatabaseName(names));
  const lease = createLease({
    collection: common.collection<LeaseDocument>(LEASE_COLLECTION),
    instanceId: config.instanceId,
    ttlMs: config.leaseTtlMs,
  });
  const history = createSentHistory(common.collection<SentInvoice>(SENT_COLLECTION));
  const queueCollection = client.db(queueDatabaseName(names)).collection('documents');
  const groupStore = createGroupStore(client, names);

  let jobs: readonly Job[];
  if (config.workerMode === 'shadow') {
    // Shadow: nothing is sent, claimed or modified. The jobs get read-only ports (the queue reads, the original of a credit
    // note, the history lookup) and the report collection; no account registry, limiter or adapter is built and no
    // credential is read (the configuration did not even load the key).
    const budgetMs = Math.min(config.tickBudgetMs, config.healthStaleMs - HEALTH_MARGIN_MS);
    if (budgetMs < MIN_BUDGET_MS) {
      await closeClient();
      return fail(logger, 'HEALTH_STALE_MS is too small: raise it (or lower TICK_BUDGET_MS)', { healthStaleMs: config.healthStaleMs, marginMs: HEALTH_MARGIN_MS });
    }
    let codeVersion: string;
    try {
      codeVersion = (deps.codeVersion ?? currentCodeVersion)(config.buildSha);
    } catch (error) {
      await closeClient();
      return fail(logger, 'the code version cannot be determined', { error });
    }
    jobs = deps.jobs ?? [
      createShadowJob({
        queue: createShadowQueue(queueCollection),
        reports: createShadowReports(common.collection<ShadowReport>(SHADOW_COLLECTION)),
        groups: { readOriginal: groupStore.readOriginal },
        lookupFor: history.lookupFor,
        hubs: config.shadowHubs,
        batch: config.shadowBatch,
        lookbackDays: config.shadowLookbackDays,
        codeVersion,
        budgetMs,
        logger,
        clock: Date.now,
      }),
    ];
  } else {
    const limitsCollection = common.collection<LimiterDocument>(LIMITS_COLLECTION);
    const queue = createQueueStore({ collection: queueCollection, recordLeaseMs: config.recordLeaseMs });
    const limiters = createLimiters({ collection: limitsCollection, random: deps.random ?? Math.random, loadLimit: LIMITER_LOAD_LIMIT });
    const registry = createAccountRegistry({
      dealers: common.collection('dealers'),
      settings: common.collection('settings'),
      users: common.collection('users'),
      hubs: config.workerHubs,
      decrypt: config.credentials === undefined ? refuseCredentials : createCredentialDecryptor(config.credentials.privateKey, config.credentials.keyId),
      logger,
      onDrop: (hub) => forgetHub(adapters, hub),
      scanLimit: ACCOUNT_SCAN_LIMIT,
    });
    const adapters: ReadonlyMap<string, ProviderAdapter> =
      deps.adapters ??
      new Map<string, ProviderAdapter>(config.arubaEnvironment === undefined ? [] : [['aruba', createArubaAdapter({ environment: config.arubaEnvironment, registry, limiters, logger, clock: Date.now, sleep })]]);
    // A round and the adapter call in progress at its end must fit the liveness window, and a claimed record's lease must
    // outlast both; with nothing enabled the engine does nothing and there is nothing to size.
    const maxCallMs = Math.max(0, ...[...adapters.values()].map((adapter) => adapter.limits.maxCallMs));
    const budgetMs = config.workerHubs.length === 0 ? config.tickBudgetMs : Math.min(config.tickBudgetMs, config.healthStaleMs - maxCallMs - HEALTH_MARGIN_MS);
    if (budgetMs < MIN_BUDGET_MS) {
      await closeClient();
      return fail(logger, 'HEALTH_STALE_MS is too small for the longest provider call: raise it (or lower TICK_BUDGET_MS)', { healthStaleMs: config.healthStaleMs, maxCallMs, marginMs: HEALTH_MARGIN_MS });
    }
    if (config.workerHubs.length > 0 && config.recordLeaseMs <= budgetMs + maxCallMs) {
      await closeClient();
      return fail(logger, 'RECORD_LEASE_MS must be greater than the round budget plus the longest provider call: raise it', { recordLeaseMs: config.recordLeaseMs, budgetMs, maxCallMs });
    }
    const engine = createEngine({
      context: {
        queue,
        history,
        groups: groupStore,
        registry,
        limiters,
        adapters,
        logger,
        clock: Date.now,
        sleep,
      },
      hubs: config.workerHubs,
      budgetMs,
      accountsRefreshMs: config.accountsRefreshMs,
      ensureIndexes: async () => {
        await history.ensureIndexes();
        await ensureLimiterIndexes(limitsCollection);
        await queue.ensureIndexes();
      },
    });
    jobs = deps.jobs ?? engine.jobs;
  }
  const runner = createRunner({
    lease,
    jobs,
    clock: Date.now,
    sleep,
    logger,
    intervalMs: config.loopIntervalMs,
    leaseRenewMs: config.leaseRenewMs,
    leaseTtlMs: config.leaseTtlMs,
    staleMs: config.healthStaleMs,
  });

  let health: HealthServer;
  try {
    health = await startHealthServer(config.healthPort, () => runner.isAlive());
  } catch (error) {
    await closeClient();
    return fail(logger, 'the liveness probe cannot listen', { error, port: config.healthPort });
  }

  runner.start();
  logger.info('worker started', { instanceId: config.instanceId, appEnv: config.appEnv, healthPort: health.port, mode: config.workerMode, hubs: config.workerMode === 'send' ? config.workerHubs.length : config.shadowHubs === '*' ? 'all' : config.shadowHubs.length });

  let stopping: Promise<void> | null = null;
  const shutdown = (signal: string): Promise<void> => {
    stopping ??= (async () => {
      logger.info('shutting down', { signal });
      try {
        await runner.stop(SHUTDOWN_GRACE_MS);
        await health.close();
        await closeClient();
      } catch (error) {
        logger.error('shutdown failed', { error });
        proc.exit(1);
        return;
      }
      logger.info('worker stopped');
      proc.exit(0);
    })();
    return stopping;
  };

  proc.on('SIGTERM', () => void shutdown('SIGTERM'));
  proc.on('SIGINT', () => void shutdown('SIGINT'));
  proc.on('uncaughtException', (error) => {
    logger.error('uncaught exception', { error });
    proc.exit(1);
  });
  proc.on('unhandledRejection', (reason) => {
    logger.error('unhandled rejection', { error: reason });
    proc.exit(1);
  });

  return { client, runner, health, shutdown };
}

if (import.meta.main) {
  await startWorker(process);
}
