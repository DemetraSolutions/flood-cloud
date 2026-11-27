import { createServer } from 'node:net';
import { testMongoUri } from './mongo.ts';

/** A valid worker environment pointing at the test MongoDB. */
export function validEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    APP_ENV: 'development',
    MONGODB_URI: 'mongodb://127.0.0.1:27017/?directConnection=true',
    WORKER_INSTANCE_ID: 'worker-test-0',
    ...overrides,
  };
}

/** A valid environment whose `MONGODB_URI` is the test MongoDB. */
export function mongoEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return validEnv({ MONGODB_URI: testMongoUri(), ...overrides });
}

/** Finds a free TCP port on loopback (briefly bound, then released). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

/** Polls `check` until it returns a value other than `undefined`, or fails after `timeoutMs`. */
export async function waitFor<T>(check: () => T | undefined | Promise<T | undefined>, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error('waitFor: condition not met in time');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
