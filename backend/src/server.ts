import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { MongoClient } from 'mongodb';
import { createApp } from './app.ts';
import { createBackofficeModules } from './composition.ts';
import { createMediaStorage } from './integrations/gcs/index.ts';
import type { MediaStorage } from './integrations/gcs/index.ts';
import { loadConfig } from './config.ts';
import type { Config } from './config.ts';
import { closeClusters, connectClusters, createClusterClients } from './db/clusters.ts';
import type { ClusterClients, ClusterRegistry } from './db/clusters.ts';
import { createDatabases } from './db/databases.ts';
import type { Databases } from './db/databases.ts';
import { COLLECTIONS } from './db/collections.ts';
import { ensureIndexes } from './db/indexes.ts';
import { createPingCheck } from './db/ping.ts';
import { createActivityLog } from './shared/activity-log/activity-log.ts';
import { createRateLimiter } from './shared/security/rate-limit/rate-limiter.ts';
import { handleClientError } from './shared/http/client-error.ts';
import { warmUpPasswordVerifier } from './shared/security/password-verifier.ts';
import { createLogger } from './shared/logging/logger.ts';

/** Time granted to in-flight requests during shutdown before the forced exit. */
export const SHUTDOWN_TIMEOUT_MS = 25_000;
/** Longer than Google's load balancer keep-alive (600 s), so it never reuses a closed socket. */
export const KEEP_ALIVE_TIMEOUT_MS = 620_000;
const MAX_HEADERS_TIMEOUT_MS = 60_000;

/** The slice of Node's `process` used by the server, injectable for tests. */
export interface ProcessLike {
  readonly env: Record<string, string | undefined>;
  readonly stdout: { write(text: string): unknown };
  readonly stderr: { write(text: string): unknown };
  loadEnvFile(path: string): void;
  exit(code: number): void;
  on(event: 'SIGTERM' | 'SIGINT' | 'uncaughtException' | 'unhandledRejection', listener: (...args: unknown[]) => void): unknown;
}

/** Collaborators of {@link run} that tests can replace. */
export interface RunDeps {
  /** Creates the process-wide MongoDB clients (two per cluster), without connecting. */
  readonly createClusters: (config: Config) => ClusterRegistry;
  /** Creates the startup indexes. */
  readonly ensureIndexes: typeof ensureIndexes;
  /** Tells whether a `.env` file exists in the working directory (the real check by default). */
  readonly dotEnvExists?: () => boolean;
}

/** Handle of a running server. */
export interface RunningServer {
  readonly server: Server;
  /** The main client of the common cluster. */
  readonly client: MongoClient;
  /** Every MongoDB client of the process (all closed by the shutdown). */
  readonly clusters: ClusterRegistry;
  /** Settles when the background connections to the other clusters and to the analytics nodes have finished. */
  readonly clusterConnections: Promise<void>;
  /** Starts the graceful shutdown (idempotent). */
  shutdown(signal: string): void;
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
 * Entry point logic: the only place that reads `process.env`, opens the port and
 * handles signals. Invalid configuration prints the list of problems on stderr and
 * exits with code 1.
 *
 * @param proc The Node `process` (or a test double).
 * @param deps Replaceable collaborators; the real ones by default.
 * @returns The running server, or `undefined` if startup failed (exit already requested).
 * @throws {Error} If `.env` exists but cannot be read.
 */
export async function run(
  proc: ProcessLike,
  deps: RunDeps = { createClusters: createClusterClients, ensureIndexes },
): Promise<RunningServer | undefined> {
  loadDotEnv(proc);

  let config: Config;
  try {
    config = loadConfig(proc.env);
  } catch (error) {
    proc.stderr.write(`${String(error)}\n`);
    proc.exit(1);
    return undefined;
  }

  if (config.appEnv === 'production' && (deps.dotEnvExists ?? (() => existsSync('.env')))()) {
    proc.stderr.write('A .env file exists in the working directory: in production secrets come from the secret manager, remove it\n');
    proc.exit(1);
    return undefined;
  }

  const logger = createLogger({ write: (line) => proc.stdout.write(`${line}\n`) });
  if (config.appEnv === 'production' && config.trustProxy === 0) {
    logger.warn('TRUST_PROXY is 0 in production: behind a load balancer every client would share its address, and the per-IP rate limits would count them together');
  }

  // One set of clients for the whole process (two per cluster). Errors are logged by name only: they could echo a URI.
  // Building the clients is inside the guard too: a connection string the driver cannot parse throws here.
  const closeClients = (toClose: ClusterRegistry): Promise<boolean> =>
    closeClusters(toClose, (clusterId, error) => logger.error('closing a database client failed', { clusterId, errorName: error instanceof Error ? error.name : typeof error }));
  let clusters: ClusterRegistry | undefined;
  let databases: Databases;
  let clusterConnections: Promise<void>;
  try {
    clusters = deps.createClusters(config);
    databases = createDatabases(clusters, { prefix: config.dbNamePrefix, appEnv: config.appEnv });
    // The common cluster must answer before the server starts; the other clusters connect in the background.
    ({ background: clusterConnections } = await connectClusters(clusters, ({ clusterId, role, errorName }) =>
      logger.error('database cluster not reachable at startup', { clusterId, role, errorName }),
    ));
    await deps.ensureIndexes(databases, COLLECTIONS, logger);
    await warmUpPasswordVerifier();
  } catch (error) {
    logger.error('database startup failed', { errorName: error instanceof Error ? error.name : typeof error });
    if (clusters !== undefined) {
      await closeClients(clusters);
    }
    proc.exit(1);
    return undefined;
  }
  const openClusters = clusters;

  // The credentials file of the media storage is read here, once: a file that cannot be used stops the server, never a request.
  let mediaStorage: MediaStorage | null;
  try {
    mediaStorage = await createMediaStorage(config.media);
  } catch (error) {
    // A StorageError says only what failed (never a path or a key), so it can be logged whole.
    logger.error('media storage startup failed', { error });
    await closeClients(openClusters);
    proc.exit(1);
    return undefined;
  }

  let shuttingDown = false;
  const activityLog = createActivityLog({
    databases,
    logger,
    retentionDays: config.activityLogRetentionDays,
    errorRetentionDays: config.activityLogErrorRetentionDays,
  });
  const backoffice = createBackofficeModules({ config, databases, activityLog, logger, mediaStorage });
  const app = createApp({
    config,
    logger,
    activityLog,
    rateLimiter: createRateLimiter(databases),
    routes: { v1: backoffice.routes },
    authenticate: { v1: backoffice.authenticate },
    groupAccess: { groups: backoffice.groups },
    readiness: { isShuttingDown: () => shuttingDown, checks: [createPingCheck(databases)] },
  });

  const server = createServer(app);
  server.requestTimeout = config.requestTimeoutMs;
  server.headersTimeout = Math.min(MAX_HEADERS_TIMEOUT_MS, config.requestTimeoutMs - 1);
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.on('clientError', handleClientError);

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    logger.error('server failed to start', { error });
    await closeClients(openClusters);
    proc.exit(1);
    return undefined;
  }
  logger.info('server started', { port: (server.address() as AddressInfo).port, appEnv: config.appEnv });

  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      logger.info('shutdown already in progress, signal ignored', { signal });
      return;
    }
    // Readiness turns 503 immediately; the drain lets the load balancer notice before closing.
    shuttingDown = true;
    logger.info('shutdown started', { signal, drainMs: config.shutdownDrainMs });
    const forced = setTimeout(() => {
      logger.error('shutdown timed out, forcing exit');
      proc.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forced.unref();
    setTimeout(() => {
      server.close((error) => {
        void closeClients(openClusters).then((clientClosed) => {
          clearTimeout(forced);
          if (error === undefined && clientClosed) {
            logger.info('shutdown completed');
            proc.exit(0);
          } else {
            logger.error('shutdown failed', error === undefined ? {} : { error });
            proc.exit(1);
          }
        });
      });
      server.closeIdleConnections();
    }, config.shutdownDrainMs);
  };

  proc.on('SIGTERM', () => shutdown('SIGTERM'));
  proc.on('SIGINT', () => shutdown('SIGINT'));
  proc.on('uncaughtException', (error) => {
    logger.error('uncaught exception', { error });
    proc.exit(1);
  });
  proc.on('unhandledRejection', (reason) => {
    logger.error('unhandled rejection', { error: reason });
    proc.exit(1);
  });

  return { server, client: (openClusters.clusters.get(openClusters.commonCluster) as ClusterClients).main, clusters: openClusters, clusterConnections, shutdown };
}

if (import.meta.main) {
  await run(process);
}
