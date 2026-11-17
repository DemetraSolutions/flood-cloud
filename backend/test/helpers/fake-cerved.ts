import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** What the fake answers to one request. */
export interface FakeCervedReply {
  /** HTTP status, 200 by default. */
  readonly status?: number;
  /** Answered as JSON. */
  readonly json?: unknown;
  /** Answered as it is (not JSON, or JSON of the wrong size). */
  readonly raw?: string;
  /** Extra response headers. */
  readonly headers?: Record<string, string>;
  /** Never answer (the client's timeout fires). */
  readonly hang?: true;
  /** Close the connection without an answer. */
  readonly drop?: true;
  /** Send the headers and the start of a body, then stop (the timeout fires while the body is read). */
  readonly stallBody?: true;
  /** Send this many megabytes in chunks, without a `Content-Length`. */
  readonly streamMegabytes?: number;
}

/** One request the fake received. */
export interface FakeCervedRequest {
  readonly method: string;
  /** Path without the query. */
  readonly path: string;
  readonly query: URLSearchParams;
  readonly headers: IncomingMessage['headers'];
}

/** A fake Cerved API in one local HTTP server. */
export interface FakeCerved {
  /** `http://127.0.0.1:<port>`. */
  readonly baseUrl: string;
  /** Every request, in order. */
  readonly requests: FakeCervedRequest[];
  /** Answer to the search (`testoricerca`); an empty list of companies by default. */
  onSearch: (text: string) => FakeCervedReply;
  /** Answer to the profile (`id_soggetto`); an empty profile by default. */
  onProfile: (id: string) => FakeCervedReply;
  /** Back to the defaults, with no request recorded. */
  reset(): void;
  close(): Promise<void>;
}

/** The answer of a search with these subjects (the raw `dati_anagrafici` of each). */
export const searchOf = (...subjects: Array<Record<string, unknown>>): FakeCervedReply => ({ json: { companies: subjects.map((dati_anagrafici) => ({ dati_anagrafici })) } });

/** The `dati_anagrafici` of a subject, with the fields the lookup reads. */
export const subject = (vat: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id_soggetto: 4242,
  denominazione: 'ROSSI SRL',
  partita_iva: vat,
  codice_fiscale: vat,
  indirizzo: { descrizione: 'VIA ROMA 1', cap: '20100', descrizione_comune: 'MILANO', provincia: 'MI' },
  ...extra,
});

/** The answer of a profile with this PEC list. */
export const profileOf = (...emails: string[]): FakeCervedReply => ({ json: { dati_anagrafici: { pec: { email: emails } } } });

/** Starts the fake on an ephemeral port of the loopback. */
export async function startFakeCerved(): Promise<FakeCerved> {
  const fake: FakeCerved = {
    baseUrl: '',
    requests: [],
    onSearch: () => searchOf(),
    onProfile: () => ({ json: {} }),
    reset: () => {
      fake.requests.length = 0;
      fake.onSearch = () => searchOf();
      fake.onProfile = () => ({ json: {} });
    },
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
  const answer = (request: IncomingMessage, response: ServerResponse, reply: FakeCervedReply): void => {
    if (reply.hang === true) {
      return;
    }
    if (reply.drop === true) {
      request.socket.destroy();
      return;
    }
    response.statusCode = reply.status ?? 200;
    for (const [name, value] of Object.entries(reply.headers ?? {})) {
      response.setHeader(name, value);
    }
    if (reply.stallBody === true) {
      response.setHeader('Content-Type', 'application/json');
      response.write('{"companies":[');
      return;
    }
    if (reply.streamMegabytes !== undefined) {
      const chunk = Buffer.alloc(1024 * 1024, 0x20);
      for (let sent = 0; sent < reply.streamMegabytes; sent += 1) {
        response.write(chunk);
      }
      response.end();
      return;
    }
    if (reply.json !== undefined) {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(reply.json));
      return;
    }
    response.end(reply.raw);
  };
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fake');
    fake.requests.push({ method: request.method ?? '', path: url.pathname, query: url.searchParams, headers: request.headers });
    if (url.pathname === '/cervedApi/v1/entitySearch/live') {
      answer(request, response, fake.onSearch(url.searchParams.get('testoricerca') ?? ''));
    } else if (url.pathname === '/cervedApi/v1/entityProfile/live') {
      answer(request, response, fake.onProfile(url.searchParams.get('id_soggetto') ?? ''));
    } else {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return Object.assign(fake, { baseUrl: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}` });
}
