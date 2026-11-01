import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { request, type IncomingHttpHeaders, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createHttpServer, type AccessLogEntry, type ServerTimeouts } from '../app.ts';
import type { ServerConfig } from '../config.ts';

const isRoot = process.getuid?.() === 0;
const API = 'https://api.example.com';

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

async function start(
  root: string,
  logs: AccessLogEntry[],
  timeouts: Partial<ServerTimeouts> = {},
): Promise<{ server: Server; port: number }> {
  const config: ServerConfig = { port: 0, staticRoot: root, apiBaseUrl: `${API}/v1`, apiOrigin: API };
  const server = createHttpServer(config, (entry) => logs.push(entry), timeouts);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, port: (server.address() as AddressInfo).port };
}

/** Sends a request with the target exactly as given (no URL normalisation). */
function raw(port: number, target: string, method = 'GET', headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: target, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode as number, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}

const HTML = { accept: 'text/html,application/xhtml+xml' };

describe('static server', () => {
  let base: string;
  let outside: string;
  let port: number;
  let server: Server;
  const logs: AccessLogEntry[] = [];

  before(async () => {
    base = await mkdtemp(join(tmpdir(), 'bo-static-'));
    const root = join(base, 'root');
    outside = join(base, 'outside');
    await mkdir(join(root, 'i18n'), { recursive: true });
    await mkdir(join(root, 'sub'));
    await mkdir(outside);
    await writeFile(join(outside, 'secret.txt'), 'top secret');
    await writeFile(join(root, 'index.html'), '<html>plain index</html>');
    await writeFile(join(root, 'main-ABCDEF12.js'), 'console.log(1)');
    await writeFile(join(root, 'styles-ZZZZ9999.css'), 'a{}');
    await writeFile(join(root, 'plain.js'), 'x');
    await writeFile(join(root, 'i18n', 'it.json'), '{"a":1}');
    await writeFile(join(root, 'hello.txt'), 'hello');
    await writeFile(join(root, 'hello.txt.br'), 'BR');
    await writeFile(join(root, 'hello.txt.gz'), 'GZ');
    await writeFile(join(root, 'gzonly.txt'), 'plain');
    await writeFile(join(root, 'gzonly.txt.gz'), 'GZ2');
    await writeFile(join(root, 'big.bin'), Buffer.alloc(48 * 1024 * 1024));
    await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'));
    await symlink(outside, join(root, 'dirlink'));
    await symlink(join(root, 'hello.txt'), join(root, 'inner-link.txt'));
    if (!isRoot) {
      await writeFile(join(root, 'locked.txt'), 'x');
      await chmod(join(root, 'locked.txt'), 0o000);
      await mkdir(join(root, 'lockeddir'));
      await writeFile(join(root, 'lockeddir', 'f.txt'), 'x');
      await chmod(join(root, 'lockeddir'), 0o000);
    }
    ({ server, port } = await start(root, logs));
  });

  after(async () => {
    server.closeAllConnections();
    server.close();
    await chmod(join(base, 'root', 'lockeddir'), 0o755).catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  });

  test('GET /healthz answers ok with security headers', async () => {
    const res = await raw(port, '/healthz');
    assert.equal(res.status, 200);
    assert.equal(res.body, 'ok');
    assert.match(res.headers['content-security-policy'] as string, /connect-src 'self' https:\/\/api\.example\.com/);
    assert.equal(res.headers['x-frame-options'], 'DENY');
    assert.equal(res.headers['server'], undefined);
    assert.equal(res.headers['x-powered-by'], undefined);
  });

  test('GET /config.json exposes only apiBaseUrl, not cacheable', async () => {
    const res = await raw(port, '/config.json?x=1');
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { apiBaseUrl: `${API}/v1` });
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.match(res.headers['content-type'] as string, /application\/json/);
  });

  test('serves index.html at / and /index.html with no-cache and ETag', async () => {
    for (const target of ['/', '/index.html']) {
      const res = await raw(port, target);
      assert.equal(res.status, 200);
      assert.equal(res.body, '<html>plain index</html>');
      assert.equal(res.headers['cache-control'], 'no-cache');
      assert.match(res.headers['content-type'] as string, /text\/html/);
      assert.ok(res.headers['etag']);
    }
  });

  test('hashed assets are immutable, other files no-cache', async () => {
    const js = await raw(port, '/main-ABCDEF12.js');
    assert.equal(js.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.equal(js.headers['x-content-type-options'], 'nosniff');
    const css = await raw(port, '/styles-ZZZZ9999.css');
    assert.equal(css.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.equal((await raw(port, '/plain.js')).headers['cache-control'], 'no-cache');
    const json = await raw(port, '/i18n/it.json');
    assert.equal(json.headers['cache-control'], 'no-cache');
    assert.equal(json.body, '{"a":1}');
  });

  test('answers 304 on matching If-None-Match (list and wildcard)', async () => {
    const first = await raw(port, '/plain.js');
    const etag = first.headers['etag'] as string;
    const hit = await raw(port, '/plain.js', 'GET', { 'if-none-match': `"zzz", ${etag}` });
    assert.equal(hit.status, 304);
    assert.equal(hit.body, '');
    assert.equal((await raw(port, '/plain.js', 'GET', { 'if-none-match': '*' })).status, 304);
    assert.equal((await raw(port, '/plain.js', 'GET', { 'if-none-match': '"other"' })).status, 200);
  });

  test('HEAD returns headers and length without body', async () => {
    const res = await raw(port, '/plain.js', 'HEAD');
    assert.equal(res.status, 200);
    assert.equal(res.body, '');
    assert.equal(res.headers['content-length'], '1');
    const health = await raw(port, '/healthz', 'HEAD');
    assert.equal(health.body, '');
    assert.equal(health.headers['content-length'], '2');
  });

  test('rejects other methods with 405 and Allow', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      const res = await raw(port, '/', method);
      assert.equal(res.status, 405);
      assert.equal(res.headers['allow'], 'GET, HEAD');
    }
  });

  test('serves precompressed variants by Accept-Encoding preference', async () => {
    const br = await raw(port, '/hello.txt', 'GET', { 'accept-encoding': 'gzip, br' });
    assert.equal(br.body, 'BR');
    assert.equal(br.headers['content-encoding'], 'br');
    assert.equal(br.headers['vary'], 'Accept-Encoding');
    assert.match(br.headers['content-type'] as string, /text\/plain/);
    const gz = await raw(port, '/hello.txt', 'GET', { 'accept-encoding': 'gzip;q=0.5, br;q=0' });
    assert.equal(gz.body, 'GZ');
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.notEqual(br.headers['etag'], gz.headers['etag']);
    const none = await raw(port, '/hello.txt');
    assert.equal(none.body, 'hello');
    assert.equal(none.headers['content-encoding'], undefined);
    assert.equal(none.headers['vary'], 'Accept-Encoding');
    const fallback = await raw(port, '/gzonly.txt', 'GET', { 'accept-encoding': 'br, gzip' });
    assert.equal(fallback.body, 'GZ2');
    const absent = await raw(port, '/plain.js', 'GET', { 'accept-encoding': 'br, gzip' });
    assert.equal(absent.body, 'x');
    assert.equal(absent.headers['content-encoding'], undefined);
  });

  test('SPA fallback: extensionless navigation gets index.html, others 404', async () => {
    const nav = await raw(port, '/users/42', 'GET', HTML);
    assert.equal(nav.status, 200);
    assert.equal(nav.body, '<html>plain index</html>');
    assert.equal((await raw(port, '/sub', 'GET', HTML)).body, '<html>plain index</html>');
    assert.equal((await raw(port, '/users/42', 'GET', { accept: 'application/json' })).status, 404);
    assert.equal((await raw(port, '/users/42')).status, 404);
    const missing = await raw(port, '/missing.js', 'GET', HTML);
    assert.equal(missing.status, 404);
    assert.equal(missing.body, 'Not found');
    assert.match(missing.headers['content-type'] as string, /text\/plain/);
  });

  test('directories are never listed', async () => {
    const res = await raw(port, '/i18n/');
    assert.equal(res.status, 404);
  });

  test('rejects traversal, bad encoding, null bytes, backslashes and bad targets with 400', async () => {
    for (const target of [
      '/../etc/passwd',
      '/%2e%2e/etc/passwd',
      '/a/./b',
      '/%E0%A4%A',
      '/a%00b',
      '/a%5Cb',
      '*',
      'http://example.com/',
    ]) {
      const res = await raw(port, target);
      assert.equal(res.status, 400, target);
      assert.equal(res.body, 'Bad request');
    }
  });

  test('does not follow symlinks leaving the root, but follows inner ones', async () => {
    assert.equal((await raw(port, '/link.txt')).status, 404);
    assert.equal((await raw(port, '/dirlink/secret.txt')).status, 404);
    assert.equal((await raw(port, '/inner-link.txt')).body, 'hello');
  });

  test('path through a regular file is a plain 404', async () => {
    assert.equal((await raw(port, '/hello.txt/child')).status, 404);
  });

  test('unreadable file or directory yields 500 without details', { skip: isRoot }, async () => {
    for (const target of ['/locked.txt', '/lockeddir/f.txt']) {
      const res = await raw(port, target);
      assert.equal(res.status, 500);
      assert.equal(res.body, 'Internal server error');
    }
    assert.ok(logs.some((entry) => entry.status === 500 && entry.error === 'Error:EACCES'));
  });

  test('drops the connection when the client aborts mid-transfer', async () => {
    const before = logs.length;
    const socket = connect(port, '127.0.0.1');
    socket.write('GET /big.bin HTTP/1.1\r\nHost: x\r\n\r\n');
    await once(socket, 'data');
    socket.destroy();
    for (let i = 0; i < 100 && logs.length === before; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(logs.length > before);
    const entry = logs[before];
    assert.equal(entry?.status, 200);
    assert.match(entry?.error as string, /ERR_STREAM_PREMATURE_CLOSE/);
  });

  test('rejects over-long targets with 414 and security headers', async () => {
    const res = await raw(port, `/${'a'.repeat(2100)}`);
    assert.equal(res.status, 414);
    assert.equal(res.body, 'URI too long');
    assert.ok(res.headers['content-security-policy']);
    const entry = logs.at(-1);
    assert.ok((entry?.path.length ?? 9999) <= 256);
  });

  test('rejects segments over 255 bytes with 400, accepts exactly 255', async () => {
    assert.equal((await raw(port, `/${'a'.repeat(256)}`)).status, 400);
    assert.equal((await raw(port, `/${'%C3%A9'.repeat(128)}`)).status, 400);
    assert.equal((await raw(port, `/${'a'.repeat(255)}`)).status, 404);
  });

  test('every response carries a server-generated X-Request-Id, also in the log', async () => {
    const a = await raw(port, '/healthz', 'GET', { 'x-request-id': 'client-chosen' });
    const b = await raw(port, '/healthz');
    assert.match(a.headers['x-request-id'] as string, /^[0-9a-f-]{36}$/);
    assert.notEqual(a.headers['x-request-id'], b.headers['x-request-id']);
    assert.equal(logs.at(-1)?.requestId, b.headers['x-request-id']);
    assert.ok(logs.some((entry) => entry.requestId === a.headers['x-request-id']));
  });

  test('writes one structured access-log entry per request, without the query', async () => {
    logs.length = 0;
    await raw(port, '/healthz?token=secret');
    assert.equal(logs.length, 1);
    const [entry] = logs;
    assert.equal(entry?.method, 'GET');
    assert.equal(entry?.path, '/healthz');
    assert.equal(entry?.status, 200);
    assert.equal(entry?.error, null);
    assert.ok((entry?.durationMs ?? -1) >= 0);
    assert.doesNotMatch(JSON.stringify(entry), /secret/);
  });

  test('sets hardened server timeouts', () => {
    assert.equal(server.requestTimeout, 30_000);
    assert.equal(server.headersTimeout, 15_000);
    assert.equal(server.keepAliveTimeout, 5_000);
    assert.equal(server.timeout, 30_000);
  });
});

describe('index.html with a CSP nonce placeholder', () => {
  let root: string;
  let server: Server;
  let port: number;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'bo-nonce-'));
    await writeFile(join(root, 'index.html'), '<app-root ngCspNonce="__CSP_NONCE__"></app-root><i data-n="__CSP_NONCE__">');
    ({ server, port } = await start(root, []));
  });

  after(async () => {
    server.closeAllConnections();
    server.close();
    await rm(root, { recursive: true, force: true });
  });

  test('injects a fresh nonce per request and allows it in style-src only', async () => {
    const a = await raw(port, '/', 'GET', HTML);
    const b = await raw(port, '/deep/link', 'GET', HTML);
    const nonceA = /ngCspNonce="([^"]+)"/.exec(a.body)?.[1] as string;
    const nonceB = /ngCspNonce="([^"]+)"/.exec(b.body)?.[1] as string;
    assert.ok(nonceA.length >= 22);
    assert.notEqual(nonceA, nonceB);
    assert.ok(a.body.includes(`data-n="${nonceA}"`));
    assert.match(a.headers['content-security-policy'] as string, new RegExp(`style-src 'self' 'nonce-${nonceA.replace(/\+/g, '\\+')}';`));
    assert.match(a.headers['content-security-policy'] as string, /script-src 'self';/);
    assert.equal(a.headers['cache-control'], 'no-store');
    assert.equal(a.headers['etag'], undefined);
  });

  test('HEAD does not send the body', async () => {
    const res = await raw(port, '/', 'HEAD');
    assert.equal(res.body, '');
    assert.ok(Number(res.headers['content-length']) > 0);
  });
});

describe('root without index.html', () => {
  let root: string;
  let server: Server;
  let port: number;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'bo-empty-'));
    ({ server, port } = await start(root, []));
  });

  after(async () => {
    server.closeAllConnections();
    server.close();
    await rm(root, { recursive: true, force: true });
  });

  test('answers 404 for / and for navigations', async () => {
    assert.equal((await raw(port, '/')).status, 404);
    assert.equal((await raw(port, '/x', 'GET', HTML)).status, 404);
  });
});

describe('missing static root', () => {
  test('answers 500 because the root cannot be resolved', async () => {
    const logs: AccessLogEntry[] = [];
    const { server, port } = await start(join(tmpdir(), 'bo-does-not-exist'), logs);
    try {
      assert.equal((await raw(port, '/')).status, 500);
      assert.equal(logs[0]?.error, 'Error:ENOENT');
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

describe('slow readers', () => {
  test('a client that does not read a large asset is disconnected on socket timeout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bo-slow-'));
    await writeFile(join(root, 'big.bin'), Buffer.alloc(64 * 1024 * 1024));
    const logs: AccessLogEntry[] = [];
    const { server, port } = await start(root, logs, { socketMs: 200 });
    const socket = connect(port, '127.0.0.1');
    try {
      socket.pause();
      socket.write('GET /big.bin HTTP/1.1\r\nHost: x\r\n\r\n');
      for (let i = 0; i < 150 && logs.length === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(logs.length, 1);
      assert.ok(logs[0]?.error);
    } finally {
      socket.destroy();
      server.closeAllConnections();
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('client errors', () => {
  let root: string;
  let server: Server;
  let port: number;
  const logs: AccessLogEntry[] = [];

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'bo-client-'));
    ({ server, port } = await start(root, logs, { requestMs: 150, headersMs: 150, checkIntervalMs: 30 }));
  });

  after(async () => {
    server.closeAllConnections();
    server.close();
    await rm(root, { recursive: true, force: true });
  });

  async function exchange(payload: string): Promise<string> {
    const socket = connect(port, '127.0.0.1');
    let data = '';
    socket.on('data', (chunk: Buffer) => (data += chunk.toString()));
    socket.on('error', () => undefined); // a reset after the response is irrelevant
    socket.write(payload);
    await once(socket, 'close');
    return data;
  }

  function assertSecure(response: string, status: string): void {
    assert.ok(response.startsWith(`HTTP/1.1 ${status}`), response);
    assert.match(response, /content-security-policy: default-src 'none'/i);
    assert.match(response, /x-frame-options: DENY/i);
    assert.match(response, /x-request-id: [0-9a-f-]{36}/i);
    assert.match(response, /content-length: 0/i);
    assert.match(response, /connection: close/i);
  }

  test('malformed request gets a security-headed 400 and is logged with the parser code', async () => {
    assertSecure(await exchange('NOT A VALID REQUEST\r\n\r\n'), '400 Bad Request');
    const entry = logs.at(-1);
    assert.equal(entry?.status, 400);
    assert.match(entry?.error as string, /^HPE_/);
    assert.equal(entry?.method, '-');
  });

  test('oversized headers get 431', async () => {
    const response = await exchange(`GET / HTTP/1.1\r\nHost: x\r\nX-Big: ${'a'.repeat(17_000)}\r\n\r\n`);
    assertSecure(response, '431 Request Header Fields Too Large');
    assert.equal(logs.at(-1)?.error, 'HPE_HEADER_OVERFLOW');
  });

  test('an incomplete request is answered with 408 after the timeout', async () => {
    assertSecure(await exchange('GET / HTTP/1.1\r\nHost: x\r\n'), '408 Request Timeout');
    assert.equal(logs.at(-1)?.error, 'ERR_HTTP_REQUEST_TIMEOUT');
  });

  test('ECONNRESET and unwritable sockets are destroyed silently', () => {
    const before = logs.length;
    let destroyed = 0;
    const socket = (writable: boolean) => ({ writable, destroy: () => (destroyed += 1) });
    server.emit('clientError', Object.assign(new Error('reset'), { code: 'ECONNRESET' }), socket(true));
    server.emit('clientError', new Error('closed'), socket(false));
    assert.equal(destroyed, 2);
    assert.equal(logs.length, before);
  });

  test('errors without a code still get a 400 and a generic log code', () => {
    let written = '';
    const socket = {
      writable: true,
      end: (data: string, callback: () => void) => {
        written = data;
        callback();
      },
      destroy: () => undefined,
    };
    server.emit('clientError', new Error('odd'), socket);
    assert.ok(written.startsWith('HTTP/1.1 400 Bad Request'));
    assert.equal(logs.at(-1)?.error, 'ClientError');
  });
});

describe('very long paths', () => {
  test('a path exceeding the OS limit is a 404, never a 500', async () => {
    const limit = process.platform === 'darwin' ? 1024 : 4096;
    const base = await mkdtemp(join(tmpdir(), 'bo-long-'));
    let root = base;
    while (root.length < Math.min(limit - 300, 2200)) {
      root = join(root, 'd'.repeat(250));
      await mkdir(root);
    }
    const { server, port } = await start(root, []);
    try {
      const target = `/${Array.from({ length: 8 }, () => 'a'.repeat(250)).join('/')}`;
      assert.equal((await raw(port, target)).status, 404);
    } finally {
      server.closeAllConnections();
      server.close();
      await rm(base, { recursive: true, force: true });
    }
  });
});
