/**
 * Startup and graceful shutdown of the static server.
 * @module
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHttpServer } from './app.ts';
import { ConfigError, loadConfig } from './config.ts';

/** The subset of `process` used by {@link run}, injectable for tests. */
export interface ProcessLike {
  readonly env: Readonly<Record<string, string | undefined>>;
  on(signal: 'SIGTERM' | 'SIGINT', listener: () => void): unknown;
  exit(code: number): void;
  readonly stdout: { write(line: string): unknown };
  readonly stderr: { write(line: string): unknown };
}

/** Shutdown timings in milliseconds. */
export interface ShutdownTimings {
  /** Time to let in-flight requests finish before closing connections. */
  readonly drainMs: number;
  /** Time after which the process exits regardless. */
  readonly forceMs: number;
}

/** Default timings: 5 s drain, forced exit at 25 s (GKE grace is 30 s). */
export const DEFAULT_TIMINGS: ShutdownTimings = { drainMs: 5_000, forceMs: 25_000 };

/**
 * Starts the server and installs SIGTERM/SIGINT handlers.
 *
 * On signal the server stops accepting connections, idle connections are
 * closed, active ones get `drainMs` to finish, then all are closed; the
 * process exits when the server is closed or after `forceMs`.
 *
 * On invalid configuration it writes the (value-free) message to stderr and
 * exits with code 1.
 *
 * @param proc Process-like object (usually `process`).
 * @param defaultStaticRoot Directory served when `STATIC_ROOT` is not set.
 * @param timings Shutdown timings.
 * @returns The listening server, or `undefined` if startup failed.
 */
export async function run(
  proc: ProcessLike,
  defaultStaticRoot: string,
  timings: ShutdownTimings = DEFAULT_TIMINGS,
): Promise<Server | undefined> {
  let config;
  try {
    config = loadConfig(proc.env, defaultStaticRoot);
  } catch (error) {
    if (!(error instanceof ConfigError)) {
      throw error;
    }
    proc.stderr.write(`${JSON.stringify({ level: 'fatal', message: error.message })}\n`);
    proc.exit(1);
    return undefined;
  }
  const server = createHttpServer(config, (entry) => {
    proc.stdout.write(`${JSON.stringify({ level: 'info', type: 'access', ...entry })}\n`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  proc.stdout.write(`${JSON.stringify({ level: 'info', type: 'listening', port })}\n`);

  let stopping = false;
  const shutdown = (): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    setTimeout(() => proc.exit(1), timings.forceMs).unref();
    setTimeout(() => server.closeAllConnections(), timings.drainMs).unref();
    server.close(() => proc.exit(0));
    server.closeIdleConnections();
  };
  proc.on('SIGTERM', shutdown);
  proc.on('SIGINT', shutdown);
  return server;
}
