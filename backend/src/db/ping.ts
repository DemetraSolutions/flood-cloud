import type { Databases } from './databases.ts';

/**
 * Readiness check that pings the common database.
 * The timeout is enforced by the health module, not here.
 *
 * @param databases Database accessor.
 * @returns A check that resolves when the server answers and rejects otherwise.
 */
export function createPingCheck(databases: Databases): () => Promise<void> {
  return async () => {
    await databases.common().command({ ping: 1 });
  };
}
