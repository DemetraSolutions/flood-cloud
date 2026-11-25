import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** What a fake provider answers to one request. */
export interface FakeReply {
  /** HTTP status, 200 by default. */
  readonly status?: number;
  /** Answered as JSON. */
  readonly json?: unknown;
  /** Answered as it is (JSON by default, unless `noContentType`). */
  readonly raw?: string;
  readonly noContentType?: true;
  /** Extra response headers. */
  readonly headers?: Record<string, string>;
  /** Never answer (the timeout of the client fires). */
  readonly hang?: true;
  /** Close the connection without an answer. */
  readonly drop?: true;
  /** Answer `302` to this location. */
  readonly redirectTo?: string;
  /** Send this many megabytes of JSON whitespace, without a `Content-Length`. */
  readonly streamMegabytes?: number;
}

/** One request the fake received. */
export interface FakeRequest {
  readonly method: string;
  /** Path without the query. */
  readonly path: string;
  /** The URL as it was sent (path and query). */
  readonly url: string;
  readonly query: URLSearchParams;
  readonly headers: IncomingMessage['headers'];
  /** The body as text, `''` when none. */
  readonly body: string;
}

/** A fake provider in one local HTTP server on the loopback. */
export interface FakeProvider {
  /** `http://127.0.0.1:<port>`. */
  readonly baseUrl: string;
  /** Every request, in order. */
  readonly requests: FakeRequest[];
  /** What it answers; replace it in a test (`reset` restores the one it started with). */
  respond: (request: FakeRequest) => FakeReply | Promise<FakeReply>;
  reset(): void;
  close(): Promise<void>;
}

/**
 * Starts a fake provider on an ephemeral port.
 *
 * @param initial What it answers by default.
 */
export async function startFakeProvider(initial: (request: FakeRequest) => FakeReply | Promise<FakeReply>): Promise<FakeProvider> {
  const fake: FakeProvider = {
    baseUrl: '',
    requests: [],
    respond: initial,
    reset: () => {
      fake.requests.length = 0;
      fake.respond = initial;
    },
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://fake');
      const received: FakeRequest = { method: request.method ?? '', path: url.pathname, url: `${url.pathname}${url.search}`, query: url.searchParams, headers: request.headers, body: Buffer.concat(chunks).toString('utf8') };
      fake.requests.push(received);
      void Promise.resolve(fake.respond(received)).then((reply) => answer(request, response, reply));
    });
  });
  const answer = (request: IncomingMessage, response: ServerResponse, reply: FakeReply): void => {
      if (reply.hang === true) {
        return;
      }
      if (reply.drop === true) {
        request.socket.destroy();
        return;
      }
      response.statusCode = reply.redirectTo === undefined ? (reply.status ?? 200) : 302;
      if (reply.redirectTo !== undefined) {
        response.setHeader('Location', reply.redirectTo);
      }
      for (const [name, value] of Object.entries(reply.headers ?? {})) {
        response.setHeader(name, value);
      }
      if (reply.streamMegabytes !== undefined) {
        response.setHeader('Content-Type', 'application/json');
        for (let sent = 0; sent < reply.streamMegabytes; sent += 1) {
          response.write(Buffer.alloc(1024 * 1024, 0x20));
        }
        response.end();
        return;
      }
      if (reply.json !== undefined) {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(reply.json));
        return;
      }
      if (reply.raw !== undefined && reply.noContentType !== true) {
        response.setHeader('Content-Type', 'application/json');
      }
      response.end(reply.raw);
  };
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return Object.assign(fake, { baseUrl: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}` });
}
