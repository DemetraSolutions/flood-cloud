import { createServer } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ArubaHosts } from '../../src/providers/aruba/settings.ts';

/** One request the fake received. */
export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  /** The raw query string, to check the encoding. */
  readonly rawQuery: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

/** What the fake answers. */
export interface Reply {
  /** HTTP status, 200 by default. */
  readonly status?: number;
  /** A JSON body. */
  readonly json?: unknown;
  /** A raw text body (wins over `json`). */
  readonly text?: string;
  /** Never answer (until the fake closes). */
  readonly hang?: boolean;
  /** Cut the connection without an answer. */
  readonly destroy?: boolean;
}

/** A reply, a sequence of replies (the last one repeats) or a function of the request and its number (from 0). */
export type Route = Reply | readonly Reply[] | ((request: RecordedRequest, count: number) => Reply);

/** A local stand-in for Aruba's two hosts: no real network is ever used. */
export interface FakeAruba {
  /** `http://127.0.0.1:<port>`. */
  readonly origin: string;
  /** Both hosts point at the fake. */
  readonly hosts: ArubaHosts;
  /** Every request, in order. */
  readonly requests: RecordedRequest[];
  /** Sets the route of `"<METHOD> <path>"`. */
  route(key: string, route: Route): void;
  /** The requests of a route. */
  hits(key: string): RecordedRequest[];
  close(): Promise<void>;
}

/** Starts the fake on an ephemeral loopback port. Unrouted requests get a `404`. */
export async function startFakeAruba(): Promise<FakeAruba> {
  const routes = new Map<string, Route>();
  const counts = new Map<string, number>();
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://fake');
      const recorded: RecordedRequest = { method: req.method ?? '', path: url.pathname, query: url.searchParams, rawQuery: url.search.slice(1), headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      requests.push(recorded);
      const key = `${recorded.method} ${recorded.path}`;
      const route = routes.get(key);
      const count = counts.get(key) ?? 0;
      counts.set(key, count + 1);
      const reply: Reply = route === undefined ? { status: 404, text: 'no route' } : typeof route === 'function' ? route(recorded, count) : Array.isArray(route) ? ((route as readonly Reply[])[Math.min(count, route.length - 1)] as Reply) : (route as Reply);
      if (reply.hang === true) {
        return;
      }
      if (reply.destroy === true) {
        req.socket.destroy();
        return;
      }
      const body = reply.text ?? (reply.json === undefined ? '' : JSON.stringify(reply.json));
      res.writeHead(reply.status ?? 200, { 'content-type': reply.text === undefined ? 'application/json' : 'text/plain' });
      res.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    hosts: { auth: origin, ws: origin },
    requests,
    route: (key, route) => void routes.set(key, route),
    hits: (key) => requests.filter((request) => `${request.method} ${request.path}` === key),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A successful sign-in answer. */
export const tokenReply = (access = 'access-token-1', refresh = 'refresh-token-1', expiresIn = 1800): Reply => ({ json: { access_token: access, expires_in: expiresIn, refresh_token: refresh } });
