import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/app.ts';
import type { AppDeps } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import type { Config } from '../../src/config.ts';
import { createLogger } from '../../src/shared/logging/logger.ts';
import type { Logger } from '../../src/shared/logging/logger.ts';

/** A valid environment with random throw-away secrets, overridable per test. */
export function validEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    APP_ENV: 'development',
    MONGODB_URI: 'mongodb://localhost:27017',
    LEGACY_PASSWORD_PEPPER: randomBytes(16).toString('hex'),
    ...overrides,
  };
}

/** A valid configuration, overridable through the environment. */
export function testConfig(overrides: Record<string, string | undefined> = {}): Config {
  return loadConfig(validEnv(overrides));
}

/** In-memory logger: parsed events are collected in `events`. */
export function memoryLogger(): { logger: Logger; events: Array<Record<string, unknown>>; lines: string[] } {
  const lines: string[] = [];
  const events: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    write: (line) => {
      lines.push(line);
      events.push(JSON.parse(line) as Record<string, unknown>);
    },
  });
  return { logger, events, lines };
}

/** A started test server. */
export interface TestServer {
  readonly baseUrl: string;
  readonly server: Server;
  readonly events: Array<Record<string, unknown>>;
  readonly lines: string[];
  close(): Promise<void>;
}

/** Starts the app on an ephemeral port. */
export async function startApp(
  overrides: Partial<AppDeps> = {},
  env: Record<string, string | undefined> = {},
): Promise<TestServer> {
  const { logger, events, lines } = memoryLogger();
  const app = createApp({
    config: testConfig(env),
    logger,
    readiness: { isShuttingDown: () => false, checks: [] },
    ...overrides,
  });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    server,
    events,
    lines,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

/** Finds a free TCP port by binding to port 0 and releasing it. */
export async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}
