import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { DEFAULT_TIMINGS, run, type ProcessLike } from '../run.ts';

function fakeProcess(env: Record<string, string>): {
  proc: ProcessLike;
  out: string[];
  err: string[];
  exits: number[];
  signals: Map<string, () => void>;
} {
  const out: string[] = [];
  const err: string[] = [];
  const exits: number[] = [];
  const signals = new Map<string, () => void>();
  const proc: ProcessLike = {
    env,
    on: (signal, listener) => signals.set(signal, listener),
    exit: (code) => exits.push(code),
    stdout: { write: (line) => out.push(line) },
    stderr: { write: (line) => err.push(line) },
  };
  return { proc, out, err, exits, signals };
}

async function exited(exits: number[]): Promise<void> {
  for (let i = 0; i < 200 && exits.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('default timings follow the 5 s drain / 25 s force policy', () => {
  assert.deepEqual(DEFAULT_TIMINGS, { drainMs: 5_000, forceMs: 25_000 });
});

test('invalid configuration writes a value-free fatal line and exits 1', async () => {
  const { proc, err, exits } = fakeProcess({});
  assert.equal(await run(proc, '/nowhere'), undefined);
  assert.deepEqual(exits, [1]);
  assert.deepEqual(JSON.parse(err[0] as string), { level: 'fatal', message: 'API_BASE_URL is required' });
});

test('unexpected errors during configuration are not swallowed', async () => {
  const { proc } = fakeProcess({});
  Object.defineProperty(proc, 'env', {
    get() {
      throw new TypeError('boom');
    },
  });
  await assert.rejects(run(proc, '/nowhere'), TypeError);
});

test('listens, logs requests, and shuts down on SIGTERM', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bo-run-'));
  await writeFile(join(root, 'index.html'), 'ok');
  const { proc, out, exits, signals } = fakeProcess({ PORT: '0', STATIC_ROOT: root, API_BASE_URL: 'http://localhost:1' });
  const server = await run(proc, '/unused', { drainMs: 10, forceMs: 5_000 });
  try {
    assert.ok(server);
    const { port } = server.address() as AddressInfo;
    assert.equal(JSON.parse(out[0] as string).type, 'listening');
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { headers: { connection: 'keep-alive' } });
    assert.equal(await res.text(), 'ok');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const access = JSON.parse(out.find((line) => line.includes('"access"')) as string);
    assert.equal(access.path, '/healthz');
    assert.deepEqual([...signals.keys()].sort(), ['SIGINT', 'SIGTERM']);
    signals.get('SIGTERM')?.();
    signals.get('SIGINT')?.(); // second signal is ignored
    await exited(exits);
    assert.deepEqual(exits, [0]);
  } finally {
    server?.closeAllConnections();
    server?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('forces exit with code 1 when the drain never completes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bo-run-'));
  const { proc, exits, signals } = fakeProcess({ PORT: '0', STATIC_ROOT: root, API_BASE_URL: 'https://api.example.com' });
  const server = await run(proc, '/unused', { drainMs: 60_000, forceMs: 20 });
  const { port } = (server as NonNullable<typeof server>).address() as AddressInfo;
  const { connect } = await import('node:net');
  const socket = connect(port, '127.0.0.1');
  await once(socket, 'connect');
  socket.write('GET /healthz HTTP/1.1\r\nHost: x\r\nContent-Length: 10\r\n\r\n'); // request left incomplete: active connection
  await new Promise((resolve) => setTimeout(resolve, 30));
  signals.get('SIGTERM')?.();
  await exited(exits);
  assert.deepEqual(exits, [1]);
  socket.destroy();
  server?.closeAllConnections();
  await rm(root, { recursive: true, force: true });
});

test('startup failure on a busy port is reported', async () => {
  const first = fakeProcess({ PORT: '0', STATIC_ROOT: tmpdir(), API_BASE_URL: 'https://api.example.com' });
  const server = await run(first.proc, '/unused');
  const { port } = (server as NonNullable<typeof server>).address() as AddressInfo;
  const second = fakeProcess({ PORT: String(port), STATIC_ROOT: tmpdir(), API_BASE_URL: 'https://api.example.com' });
  await assert.rejects(run(second.proc, '/unused'), { code: 'EADDRINUSE' });
  server?.close();
});

test('main.ts boots as a real process, serves, and exits 0 on SIGTERM', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bo-main-'));
  await writeFile(join(root, 'index.html'), 'main-ok');
  const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'main.ts')], {
    env: { ...process.env, PORT: '0', STATIC_ROOT: root, API_BASE_URL: 'https://api.example.com' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  try {
    let buffered = '';
    const port = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.stdout.on('data', (chunk: Buffer) => {
        buffered += chunk.toString();
        const line = buffered.split('\n').find((candidate) => candidate.includes('"listening"'));
        if (line !== undefined) {
          resolve(JSON.parse(line).port);
        }
      });
    });
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'main-ok');
    child.kill('SIGTERM');
    const [code] = await once(child, 'exit');
    assert.equal(code, 0);
  } finally {
    child.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
});
