import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { connect, createServer } from 'node:net';
import { loadDotEnv, run, SHUTDOWN_TIMEOUT_MS, KEEP_ALIVE_TIMEOUT_MS } from '../../src/server.ts';
import type { ProcessLike, RunningServer } from '../../src/server.ts';
import { freePort, validEnv } from '../helpers/app.ts';

type Listener = (...args: unknown[]) => void;

function fakeProcess(env: Record<string, string | undefined>, loadEnvFile: (path: string) => void = () => undefined) {
  const out: string[] = [];
  const err: string[] = [];
  const exits: number[] = [];
  const listeners = new Map<string, Listener>();
  const proc: ProcessLike = {
    env,
    stdout: { write: (text) => out.push(text) },
    stderr: { write: (text) => err.push(text) },
    loadEnvFile,
    exit: (code) => void exits.push(code),
    on: (event, listener) => void listeners.set(event, listener),
  };
  return { proc, out, err, exits, listeners };
}

function errnoError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

async function started(extra: Record<string, string> = {}) {
  const port = await freePort();
  const fake = fakeProcess(validEnv({ PORT: String(port), SHUTDOWN_DRAIN_MS: '0', ...extra }));
  const running = (await run(fake.proc)) as RunningServer;
  assert.ok(running);
  return { ...fake, running, port };
}

async function closed(running: RunningServer): Promise<void> {
  if (running.server.listening) {
    await new Promise<void>((resolve) => {
      running.server.close(() => resolve());
      running.server.closeAllConnections();
    });
  }
}

describe('loadDotEnv', () => {
  it('loads .env', () => {
    const paths: string[] = [];
    loadDotEnv({ loadEnvFile: (path) => void paths.push(path) });
    assert.deepEqual(paths, ['.env']);
  });

  it('ignores a missing file only', () => {
    loadDotEnv({ loadEnvFile: () => { throw errnoError('ENOENT'); } });
    assert.throws(() => loadDotEnv({ loadEnvFile: () => { throw errnoError('EACCES'); } }), /EACCES/);
    assert.throws(() => loadDotEnv({ loadEnvFile: () => { throw new Error('parse'); } }), /parse/);
    assert.throws(() => loadDotEnv({ loadEnvFile: () => { throw 'not an error'; } }), (e) => e === 'not an error');
  });
});

describe('run', () => {
  it('starts, serves and logs the start', async () => {
    const { running, port, out, listeners } = await started();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health/ready`);
      assert.equal(res.status, 200);
      assert.match(out.join(''), /"msg":"server started"/);
      assert.equal(running.server.requestTimeout, 30000);
      assert.ok(running.server.headersTimeout < running.server.requestTimeout);
      assert.equal(running.server.keepAliveTimeout, KEEP_ALIVE_TIMEOUT_MS);
      assert.deepEqual([...listeners.keys()].sort(), ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection']);
      assert.ok(out.every((line) => line.endsWith('\n')));
    } finally {
      await closed(running);
    }
  });

  it('keeps headersTimeout below a short request timeout', async () => {
    const { running } = await started({ REQUEST_TIMEOUT_MS: '1000' });
    try {
      assert.equal(running.server.headersTimeout, 999);
    } finally {
      await closed(running);
    }
  });

  it('exits 1 listing the problems when the configuration is invalid', async () => {
    const fake = fakeProcess({ APP_ENV: 'qa', LEGACY_PASSWORD_PEPPER: 'super-secret-pepper' });
    const result = await run(fake.proc);
    assert.equal(result, undefined);
    assert.deepEqual(fake.exits, [1]);
    const text = fake.err.join('');
    assert.match(text, /APP_ENV/);
    assert.match(text, /MONGODB_URI: is required/);
    assert.ok(!text.includes('super-secret-pepper'));
    assert.equal(fake.out.length, 0);
  });

  it('tolerates a missing .env and propagates other .env errors', async () => {
    const port = await freePort();
    const missing = fakeProcess(validEnv({ PORT: String(port) }), () => { throw errnoError('ENOENT'); });
    const running = await run(missing.proc);
    assert.ok(running);
    await closed(running);
    const broken = fakeProcess(validEnv(), () => { throw errnoError('EACCES'); });
    await assert.rejects(run(broken.proc), /EACCES/);
  });

  it('exits 1 when the port cannot be bound', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, () => resolve()));
    const busy = (blocker.address() as { port: number }).port;
    try {
      const fake = fakeProcess(validEnv({ PORT: String(busy) }));
      assert.equal(await run(fake.proc), undefined);
      assert.deepEqual(fake.exits, [1]);
      assert.match(fake.out.join(''), /server failed to start/);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it('shuts down on SIGTERM: readiness 503, graceful close, exit 0, idempotent', async () => {
    const { running, port, out, exits, listeners } = await started();
    const sigterm = listeners.get('SIGTERM') as Listener;
    // A keep-alive connection that is idle must not block the shutdown.
    await fetch(`http://127.0.0.1:${port}/health/live`);
    sigterm();
    sigterm();
    await new Promise<void>((resolve) => running.server.once('close', () => resolve()));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(exits, [0]);
    const log = out.join('');
    assert.match(log, /"signal":"SIGTERM".*"msg":"shutdown started"/);
    assert.match(log, /shutdown completed/);
  });

  it('shuts down on SIGINT too', async () => {
    const { running, out, exits, listeners } = await started();
    (listeners.get('SIGINT') as Listener)();
    await new Promise<void>((resolve) => running.server.once('close', () => resolve()));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(exits, [0]);
    assert.match(out.join(''), /"signal":"SIGINT"/);
  });

  it('forces the exit if the shutdown takes too long', async () => {
    const { running, exits, out, listeners } = await started();
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      (listeners.get('SIGTERM') as Listener)();
      mock.timers.tick(SHUTDOWN_TIMEOUT_MS);
      assert.equal(exits[0], 1);
      assert.match(out.join(''), /shutdown timed out/);
    } finally {
      mock.timers.reset();
      await closed(running);
    }
  });

  it('exits 1 when closing fails', async () => {
    const { running, exits, out, listeners } = await started();
    await closed(running);
    (listeners.get('SIGTERM') as Listener)();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(exits, [1]);
    assert.match(out.join(''), /shutdown failed/);
  });

  it('logs and exits 1 on uncaught exceptions and unhandled rejections', async () => {
    const { running, exits, out, listeners } = await started();
    try {
      (listeners.get('uncaughtException') as Listener)(new Error('kaboom'));
      (listeners.get('unhandledRejection') as Listener)(new Error('rejected'));
      assert.deepEqual(exits, [1, 1]);
      const log = out.join('');
      assert.match(log, /uncaught exception/);
      assert.match(log, /kaboom/);
      assert.match(log, /unhandled rejection/);
    } finally {
      await closed(running);
    }
  });

  it('fails readiness immediately on SIGTERM but keeps serving during the drain, then closes; a second signal is ignored', async () => {
    const { running, port, out, exits, listeners } = await started({ SHUTDOWN_DRAIN_MS: '300' });
    const sigterm = listeners.get('SIGTERM') as Listener;
    sigterm();
    sigterm();
    const ready = await fetch(`http://127.0.0.1:${port}/health/ready`);
    assert.equal(ready.status, 503);
    assert.equal(running.server.listening, true);
    assert.deepEqual(exits, []);
    await new Promise<void>((resolve) => running.server.once('close', () => resolve()));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(exits, [0]);
    assert.match(out.join(''), /shutdown already in progress/);
  });

  it('answers a minimal 400 to an unparsable request', async () => {
    const { running, port } = await started();
    try {
      const raw = await new Promise<string>((resolve, reject) => {
        const socket = connect(port, '127.0.0.1', () => socket.write('NOT HTTP AT ALL\r\n\r\n'));
        let received = '';
        socket.on('data', (chunk) => (received += chunk.toString()));
        socket.on('close', () => resolve(received));
        socket.on('error', reject);
      });
      assert.match(raw, /^HTTP\/1\.1 400 Bad Request\r\n/);
      assert.match(raw, /X-Content-Type-Options: nosniff/);
      assert.match(raw, /"code":"BAD_REQUEST"/);
    } finally {
      await closed(running);
    }
  });
});
