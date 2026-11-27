import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

/** A running liveness server. */
export interface HealthServer {
  /** The port actually bound (useful when 0 was requested). */
  readonly port: number;
  /** Stops accepting connections and closes the idle ones. */
  close(): Promise<void>;
}

/**
 * Starts the liveness probe: `GET /health/live` answers `200 {"status":"ok"}` while `isAlive()` is true and
 * `503 {"status":"stale"}` otherwise; every other path or method answers `404`. Nothing else is exposed: no lease
 * holder, no configuration, no version.
 *
 * @param port TCP port to bind (0 for an ephemeral one).
 * @param isAlive Tells whether the run loop ticked recently.
 * @param host Address to bind; every interface when omitted (the kubelet probes the pod address).
 * @returns The running server.
 * @throws {Error} If the port cannot be bound.
 */
export async function startHealthServer(port: number, isAlive: () => boolean, host?: string): Promise<HealthServer> {
  const server: Server = createServer((req, res) => {
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Type': 'application/json; charset=utf-8' };
    const path = (req.url as string).split('?', 1)[0];
    if (req.method !== 'GET' || path !== '/health/live') {
      res.writeHead(404, headers).end('{"status":"not_found"}');
      return;
    }
    if (isAlive()) {
      res.writeHead(200, headers).end('{"status":"ok"}');
    } else {
      res.writeHead(503, headers).end('{"status":"stale"}');
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  let closing: Promise<void> | null = null;
  return {
    port: (server.address() as AddressInfo).port,
    close() {
      closing ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
