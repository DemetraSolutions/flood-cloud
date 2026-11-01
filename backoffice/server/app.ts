/**
 * Static file server for the Angular build: safe path resolution, caching,
 * precompressed assets, SPA fallback, runtime config and health endpoint.
 * @module
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { open, readFile, realpath, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { join, sep } from 'node:path';
import type { ServerConfig } from './config.ts';
import { buildSecurityHeaders, NONCE_PLACEHOLDER } from './headers.ts';
import { mimeType } from './mime.ts';

/** One structured access-log entry. */
export interface AccessLogEntry {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly durationMs: number;
  /** Server-generated identifier, also sent as `X-Request-Id`. */
  readonly requestId: string;
  /** Error name and code (e.g. `Error:EACCES`) when the request failed unexpectedly, else `null`. */
  readonly error: string | null;
}

/** Sink for access-log entries. */
export type AccessLogger = (entry: AccessLogEntry) => void;

interface ResolvedFile {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

const HASHED_ASSET = /-[A-Z0-9]{8,}\.(js|css)$/;
const IMMUTABLE = 'public, max-age=31536000, immutable';
const INDEX = 'index.html';

/** Maximum accepted length of a request target. */
const MAX_TARGET_LENGTH = 2048;
/** Maximum byte length of one path segment (file-name limit of common file systems). */
const MAX_SEGMENT_BYTES = 255;

/** Thrown for malformed or unsafe request targets (answered with 400). */
class BadRequestError extends Error {}

/** Thrown for request targets that are too long (answered with 414). */
class UriTooLongError extends Error {}

/**
 * Decodes and splits a request target into safe path segments.
 *
 * @param target Raw `req.url`.
 * @returns Path segments (empty for the root).
 * @throws If the target is too long (414), not origin-form, badly encoded,
 * or contains null bytes, backslashes, dot segments or oversized segments (400).
 */
function toSegments(target: string): string[] {
  if (target.length > MAX_TARGET_LENGTH) {
    throw new UriTooLongError('target too long');
  }
  if (!target.startsWith('/')) {
    throw new BadRequestError('invalid target');
  }
  const rawPath = target.split('?', 1)[0] as string;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    throw new BadRequestError('invalid encoding');
  }
  if (decoded.includes('\0') || decoded.includes('\\')) {
    throw new BadRequestError('invalid characters');
  }
  const segments = decoded.split('/').filter((segment) => segment !== '');
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new BadRequestError('dot segments');
  }
  if (segments.some((segment) => Buffer.byteLength(segment) > MAX_SEGMENT_BYTES)) {
    throw new BadRequestError('segment too long');
  }
  return segments;
}

/**
 * Whether a header value (e.g. Accept-Encoding) lists a token with q > 0.
 *
 * @param header Header value, possibly undefined.
 * @param token Token to look for (lower case).
 */
function accepts(header: string | undefined, token: string): boolean {
  if (header === undefined) {
    return false;
  }
  return header.split(',').some((part) => {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    const zero = params.some((param) => /^\s*q=0(\.0*)?\s*$/.test(param));
    return name === token && !zero;
  });
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'ENAMETOOLONG';
}

/**
 * Resolves segments to a regular file strictly inside the real root.
 *
 * @param realRoot Canonical (realpath) root directory.
 * @param segments Safe path segments.
 * @returns The file, or `undefined` if missing, a directory, or outside the
 * root once symlinks are resolved.
 * @throws On unexpected I/O errors (e.g. permissions).
 */
async function resolveFile(realRoot: string, segments: readonly string[]): Promise<ResolvedFile | undefined> {
  let real: string;
  try {
    real = await realpath(join(realRoot, ...segments));
  } catch (error) {
    if (isMissing(error)) {
      return undefined;
    }
    throw error;
  }
  if (!real.startsWith(realRoot + sep)) {
    return undefined;
  }
  const info = await stat(real);
  return info.isFile() ? { path: real, size: info.size, mtimeMs: info.mtimeMs } : undefined;
}

function etagOf(file: ResolvedFile, encoding: string): string {
  return `W/"${file.size.toString(16)}-${Math.trunc(file.mtimeMs).toString(16)}${encoding}"`;
}

function matchesEtag(header: string | undefined, etag: string): boolean {
  if (header === undefined) {
    return false;
  }
  return header.split(',').some((candidate) => {
    const value = candidate.trim();
    return value === '*' || value === etag;
  });
}

/**
 * Creates the request handler of the static server.
 *
 * @param config Validated configuration.
 * @param log Access-log sink, called once per request when it completes.
 * @returns A Node request listener.
 */
export function createApp(
  config: ServerConfig,
  log: AccessLogger,
): (req: IncomingMessage, res: ServerResponse) => void {
  const configBody = Buffer.from(JSON.stringify({ apiBaseUrl: config.apiBaseUrl }));
  const baseHeaders = buildSecurityHeaders(config.apiOrigin);
  let realRootPromise: Promise<string> | undefined;
  const getRealRoot = (): Promise<string> => (realRootPromise ??= realpath(config.staticRoot));

  function reply(
    req: IncomingMessage,
    res: ServerResponse,
    status: number,
    headers: Record<string, string>,
    body: Buffer | string,
  ): void {
    const payload = typeof body === 'string' ? Buffer.from(body) : body;
    res.writeHead(status, { ...baseHeaders, ...headers, 'content-length': String(payload.length) });
    res.end(req.method === 'HEAD' ? undefined : payload);
  }

  function text(req: IncomingMessage, res: ServerResponse, status: number, body: string, extra: Record<string, string> = {}): void {
    reply(req, res, status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...extra }, body);
  }

  async function serveFile(
    req: IncomingMessage,
    res: ServerResponse,
    realRoot: string,
    segments: readonly string[],
    file: ResolvedFile,
  ): Promise<void> {
    const acceptEncoding = req.headers['accept-encoding'];
    let served = file;
    let encoding = '';
    for (const [token, suffix] of [['br', '.br'], ['gzip', '.gz']] as const) {
      if (encoding === '' && accepts(acceptEncoding, token)) {
        const last = `${segments[segments.length - 1] as string}${suffix}`;
        const variant = await resolveFile(realRoot, [...segments.slice(0, -1), last]);
        if (variant !== undefined) {
          served = variant;
          encoding = token;
        }
      }
    }
    const name = segments[segments.length - 1] as string;
    const etag = etagOf(served, encoding);
    const headers: Record<string, string> = {
      'content-type': mimeType(name),
      'cache-control': HASHED_ASSET.test(name) ? IMMUTABLE : 'no-cache',
      etag,
      vary: 'Accept-Encoding',
    };
    if (encoding !== '') {
      headers['content-encoding'] = encoding;
    }
    if (matchesEtag(req.headers['if-none-match'], etag)) {
      res.writeHead(304, { ...baseHeaders, ...headers });
      res.end();
      return;
    }
    const handle = await open(served.path, 'r');
    res.writeHead(200, { ...baseHeaders, ...headers, 'content-length': String(served.size) });
    if (req.method === 'HEAD') {
      await handle.close();
      res.end();
      return;
    }
    try {
      await pipeline(handle.createReadStream({ autoClose: true }), res);
    } catch (error) {
      // The client went away or the read failed after the headers were sent:
      // pipeline() has already closed the socket. Re-throw so the failure
      // reaches the access log.
      res.destroy();
      throw error;
    }
  }

  async function serveIndex(
    req: IncomingMessage,
    res: ServerResponse,
    realRoot: string,
  ): Promise<void> {
    const file = await resolveFile(realRoot, [INDEX]);
    if (file === undefined) {
      text(req, res, 404, 'Not found');
      return;
    }
    const html = await readFile(file.path, 'utf8');
    if (!html.includes(NONCE_PLACEHOLDER)) {
      await serveFile(req, res, realRoot, [INDEX], file);
      return;
    }
    // index.html asks for a nonce (Angular `ngCspNonce`): fresh value per request.
    const nonce = randomBytes(16).toString('base64');
    reply(
      req,
      res,
      200,
      {
        ...buildSecurityHeaders(config.apiOrigin, nonce),
        'content-type': mimeType(INDEX),
        'cache-control': 'no-store',
      },
      html.replaceAll(NONCE_PLACEHOLDER, nonce),
    );
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      text(req, res, 405, 'Method not allowed', { allow: 'GET, HEAD' });
      return;
    }
    const segments = toSegments(req.url as string);
    const pathname = `/${segments.join('/')}`;
    if (pathname === '/healthz') {
      text(req, res, 200, 'ok');
      return;
    }
    if (pathname === '/config.json') {
      reply(req, res, 200, { 'content-type': mimeType('config.json'), 'cache-control': 'no-store' }, configBody);
      return;
    }
    const realRoot = await getRealRoot();
    if (segments.length === 0) {
      await serveIndex(req, res, realRoot);
      return;
    }
    const file = await resolveFile(realRoot, segments);
    if (file !== undefined) {
      if (segments[segments.length - 1] === INDEX && segments.length === 1) {
        await serveIndex(req, res, realRoot);
        return;
      }
      await serveFile(req, res, realRoot, segments, file);
      return;
    }
    const last = segments[segments.length - 1] as string;
    const navigation = !last.includes('.') && (req.headers.accept ?? '').includes('text/html');
    if (navigation) {
      await serveIndex(req, res, realRoot);
      return;
    }
    text(req, res, 404, 'Not found');
  }

  return (req, res) => {
    const started = process.hrtime.bigint();
    const requestId = randomUUID();
    res.setHeader('x-request-id', requestId);
    let failure: string | null = null;
    // The entry is logged once the response is closed AND the handler settled,
    // so a failure raised while streaming is always included.
    let pending = 2;
    const done = (): void => {
      pending -= 1;
      if (pending === 0) {
        log({
          method: req.method as string,
          path: (req.url as string).split('?', 1)[0]?.slice(0, 256) as string,
          status: res.statusCode,
          durationMs: Number(process.hrtime.bigint() - started) / 1e6,
          requestId,
          error: failure,
        });
      }
    };
    res.once('close', done);
    route(req, res)
      .catch((error: unknown) => {
        if (!(error instanceof BadRequestError) && !(error instanceof UriTooLongError)) {
          const { name, code } = error as NodeJS.ErrnoException;
          failure = [name, code].filter(Boolean).join(':');
        }
        if (res.headersSent) {
          res.destroy();
          return;
        }
        if (error instanceof UriTooLongError) {
          text(req, res, 414, 'URI too long');
        } else if (error instanceof BadRequestError) {
          text(req, res, 400, 'Bad request');
        } else {
          text(req, res, 500, 'Internal server error');
        }
      })
      .finally(done);
  };
}

/** Timeouts of the HTTP server in milliseconds (overridable in tests). */
export interface ServerTimeouts {
  /** Socket inactivity timeout (slow readers). */
  readonly socketMs: number;
  /** Time allowed to receive the request headers. */
  readonly headersMs: number;
  /** Time allowed to receive the whole request. */
  readonly requestMs: number;
  /** Interval of the server's connection timeout checks. */
  readonly checkIntervalMs: number;
}

const DEFAULT_SERVER_TIMEOUTS: ServerTimeouts = {
  socketMs: 30_000,
  headersMs: 15_000,
  requestMs: 30_000,
  checkIntervalMs: 30_000,
};

const CLIENT_ERROR_STATUS: Readonly<Record<string, [number, string]>> = {
  HPE_HEADER_OVERFLOW: [431, 'Request Header Fields Too Large'],
  ERR_HTTP_REQUEST_TIMEOUT: [408, 'Request Timeout'],
};

/**
 * Creates the HTTP server with hardened timeouts and a `clientError` handler
 * that answers protocol errors with a security-headed 400/408/431.
 *
 * @param config Validated configuration.
 * @param log Access-log sink.
 * @param timeouts Optional overrides of the default timeouts (for tests).
 * @returns A not-yet-listening `http.Server`.
 */
export function createHttpServer(
  config: ServerConfig,
  log: AccessLogger,
  timeouts: Partial<ServerTimeouts> = {},
): Server {
  const t = { ...DEFAULT_SERVER_TIMEOUTS, ...timeouts };
  const server = createServer({ connectionsCheckingInterval: t.checkIntervalMs }, createApp(config, log));
  server.timeout = t.socketMs;
  server.headersTimeout = t.headersMs;
  server.requestTimeout = t.requestMs;
  server.keepAliveTimeout = 5_000;
  const headers = buildSecurityHeaders(config.apiOrigin);
  server.on('clientError', (error: NodeJS.ErrnoException, socket: Duplex) => {
    if (error.code === 'ECONNRESET' || !socket.writable) {
      socket.destroy();
      return;
    }
    const [status, reason] = CLIENT_ERROR_STATUS[error.code as string] ?? [400, 'Bad Request'];
    const requestId = randomUUID();
    const lines = Object.entries({ ...headers, 'x-request-id': requestId, 'content-length': '0', connection: 'close' });
    socket.end(`HTTP/1.1 ${status} ${reason}\r\n${lines.map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`, () =>
      socket.destroy(),
    );
    log({ method: '-', path: '-', status, durationMs: 0, requestId, error: error.code ?? 'ClientError' });
  });
  return server;
}
