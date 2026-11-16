import { after, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { loadDotEnv, run, SHUTDOWN_TIMEOUT_MS, KEEP_ALIVE_TIMEOUT_MS } from '../../src/server.ts';
import type { ProcessLike, RunningServer } from '../../src/server.ts';
import { closeClusters } from '../../src/db/clusters.ts';
import { freePort } from '../helpers/app.ts';
import { credentialsFile, testKeyPair } from '../helpers/fake-gcs.ts';
import { dropMongoEnvDatabases, mongoEnv, singleCluster, testMongoUri } from '../helpers/mongo.ts';

// The servers started by these tests create databases under the mongoEnv prefixes: drop them at the end.
after(dropMongoEnvDatabases);

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
  const fake = fakeProcess(mongoEnv({ PORT: '0', SHUTDOWN_DRAIN_MS: '0', ...extra }));
  const running = (await run(fake.proc)) as RunningServer;
  assert.ok(running);
  return { ...fake, running, port: (running.server.address() as AddressInfo).port };
}

async function closed(running: RunningServer): Promise<void> {
  await running.clusterConnections;
  await closeClusters(running.clusters, () => undefined);
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
    const missing = fakeProcess(mongoEnv({ PORT: '0' }), () => { throw errnoError('ENOENT'); });
    const running = await run(missing.proc);
    assert.ok(running);
    await closed(running);
    const broken = fakeProcess(mongoEnv(), () => { throw errnoError('EACCES'); });
    await assert.rejects(run(broken.proc), /EACCES/);
  });

  it('exits 1 when the port cannot be bound', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, () => resolve()));
    const busy = (blocker.address() as { port: number }).port;
    try {
      const fake = fakeProcess(mongoEnv({ PORT: String(busy) }));
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

describe('run: database lifecycle', () => {
  const URI_IN_ERROR = 'mongodb://user:hunter2@db.invalid:27017';

  /** A client double: only the methods `run` uses. */
  function fakeClient(options: { connect?: Error; close?: Error } = {}) {
    let closes = 0;
    const client = {
      connect: async () => {
        if (options.connect !== undefined) throw options.connect;
      },
      close: async () => {
        closes += 1;
        if (options.close !== undefined) throw options.close;
      },
      db: () => ({ command: async () => ({ ok: 1 }) }),
    };
    return { client: client as never, closes: () => closes };
  }

  const noIndexes = async (): Promise<void> => undefined;

  it('exits 1 without leaking the URI when the connection fails, closing the client', async () => {
    const fake = fakeProcess(mongoEnv());
    const { client, closes } = fakeClient({ connect: new Error(`cannot reach ${URI_IN_ERROR}`) });
    const result = await run(fake.proc, { createClusters: () => singleCluster(client), ensureIndexes: noIndexes });
    assert.equal(result, undefined);
    assert.deepEqual(fake.exits, [1]);
    assert.equal(closes(), 1);
    const log = fake.out.join('');
    assert.match(log, /database startup failed/);
    assert.ok(!log.includes('hunter2') && !log.includes('db.invalid'));
  });

  it('exits 1 without any host in the output when the connection string cannot be parsed', async () => {
    const fake = fakeProcess(mongoEnv({ MONGODB_URI: 'mongodb://secret-host.invalid:99999/' }));
    assert.equal(await run(fake.proc), undefined);
    assert.deepEqual(fake.exits, [1]);
    const output = fake.out.join('') + fake.err.join('');
    assert.match(output, /database startup failed/);
    assert.ok(!output.includes('secret-host') && !output.includes('99999'));
  });

  it('refuses to start in production when a .env file exists', async () => {
    const fake = fakeProcess(mongoEnv({ APP_ENV: 'production', MONGODB_URI: 'mongodb://127.0.0.1:1/?tls=true' }));
    let created = false;
    const result = await run(fake.proc, {
      createClusters: () => {
        created = true;
        throw new Error('must not be reached');
      },
      ensureIndexes: noIndexes,
      dotEnvExists: () => true,
    });
    assert.equal(result, undefined);
    assert.deepEqual(fake.exits, [1]);
    assert.equal(created, false);
    assert.match(fake.err.join(''), /\.env file exists/);
  });

  it('starts in production when no .env file exists', async () => {
    const fake = fakeProcess(mongoEnv({ APP_ENV: 'production', MONGODB_URI: 'mongodb://127.0.0.1:1/?tls=true', PORT: '0', SHUTDOWN_DRAIN_MS: '0' }));
    const { client } = fakeClient();
    const running = (await run(fake.proc, { createClusters: () => singleCluster(client), ensureIndexes: noIndexes, dotEnvExists: () => false })) as RunningServer;
    assert.ok(running);
    assert.match(fake.out.join(''), /"level":"warn","msg":"TRUST_PROXY is 0 in production/);
    await closed(running);
  });

  it('does not warn about TRUST_PROXY when it is set in production, nor in development', async () => {
    for (const extra of [{ APP_ENV: 'production', MONGODB_URI: 'mongodb://127.0.0.1:1/?tls=true', TRUST_PROXY: '1' }, {}]) {
      const fake = fakeProcess(mongoEnv({ ...extra, PORT: '0', SHUTDOWN_DRAIN_MS: '0' }));
      const { client } = fakeClient();
      const running = (await run(fake.proc, { createClusters: () => singleCluster(client), ensureIndexes: noIndexes, dotEnvExists: () => false })) as RunningServer;
      assert.ok(running);
      assert.ok(!fake.out.join('').includes('TRUST_PROXY is 0'));
      await closed(running);
    }
  });

  it('logs the type of a non-Error startup failure', async () => {
    const fake = fakeProcess(mongoEnv());
    const { client } = fakeClient();
    const failing = async (): Promise<void> => Promise.reject('plain string');
    assert.equal(await run(fake.proc, { createClusters: () => singleCluster(client), ensureIndexes: failing }), undefined);
    assert.match(fake.out.join(''), /"errorName":"string"/);
  });

  it('exits 1 when creating the indexes fails', async () => {
    const fake = fakeProcess(mongoEnv());
    const { client, closes } = fakeClient();
    const failing = async (): Promise<void> => Promise.reject(new Error('index build failed'));
    assert.equal(await run(fake.proc, { createClusters: () => singleCluster(client), ensureIndexes: failing }), undefined);
    assert.deepEqual(fake.exits, [1]);
    assert.equal(closes(), 1);
  });

  it('really fails to connect to an unreachable server within the selection timeout', async () => {
    // A port nobody listens on, known before the run: see the helper.
    const port = await freePort();
    const fake = fakeProcess(
      mongoEnv({ MONGODB_URI: `mongodb://127.0.0.1:${port}/?directConnection=true`, MONGODB_SERVER_SELECTION_TIMEOUT_MS: '1000' }),
    );
    assert.equal(await run(fake.proc), undefined);
    assert.deepEqual(fake.exits, [1]);
    assert.match(fake.out.join(''), /database startup failed/);
  });

  it('closes the client when the port cannot be bound', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, () => resolve()));
    const busy = (blocker.address() as { port: number }).port;
    try {
      const fake = fakeProcess(mongoEnv({ PORT: String(busy) }));
      const { client, closes } = fakeClient();
      assert.equal(await run(fake.proc, { createClusters: () => singleCluster(client), ensureIndexes: noIndexes }), undefined);
      assert.equal(closes(), 1);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it('closes the client on shutdown, and exits 1 if closing it fails', async () => {
    const fake = fakeProcess(mongoEnv({ PORT: '0', SHUTDOWN_DRAIN_MS: '0' }));
    const { client, closes } = fakeClient({ close: new Error('close failed') });
    const running = (await run(fake.proc, { createClusters: () => singleCluster(client), ensureIndexes: noIndexes })) as RunningServer;
    (fake.listeners.get('SIGTERM') as Listener)();
    await new Promise<void>((resolve) => running.server.once('close', () => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(closes(), 1);
    assert.deepEqual(fake.exits, [1]);
    const log = fake.out.join('');
    assert.match(log, /closing a database client failed/);
    assert.match(log, /"clusterId":"cluster0","errorName":"Error"/);
    assert.ok(!log.includes('close failed'));
    assert.match(log, /shutdown failed/);
  });

  it('starts and stays ready when a secondary cluster is unreachable, logging only its id and role', async () => {
    const dead = await freePort();
    const fake = fakeProcess(
      mongoEnv({
        MONGODB_URI: undefined,
        MONGODB_CLUSTERS: 'cluster0,cluster1',
        MONGODB_URI_CLUSTER0: testMongoUri(),
        MONGODB_URI_CLUSTER1: `mongodb://127.0.0.1:${dead}/?directConnection=true`,
        MONGODB_SERVER_SELECTION_TIMEOUT_MS: '1000',
        PORT: '0',
        SHUTDOWN_DRAIN_MS: '0',
      }),
    );
    const running = (await run(fake.proc)) as RunningServer;
    try {
      assert.ok(running);
      await running.clusterConnections;
      const port = (running.server.address() as AddressInfo).port;
      assert.equal((await fetch(`http://127.0.0.1:${port}/health/ready`)).status, 200);
      const log = fake.out.join('');
      const failures = log.split('\n').filter((line) => line.includes('database cluster not reachable at startup'));
      assert.deepEqual(
        failures.map((line) => {
          const event = JSON.parse(line) as { clusterId: string; role: string };
          return `${event.clusterId}:${event.role}`;
        }).sort(),
        ['cluster1:analytics', 'cluster1:main'],
      );
      assert.ok(!log.includes(String(dead)) && !log.includes('mongodb://'));
    } finally {
      await closed(running);
    }
  });

  it('logs only the type of a non-Error failure when closing a client', async () => {
    const fake = fakeProcess(mongoEnv({ PORT: '0', SHUTDOWN_DRAIN_MS: '0' }));
    const { client } = fakeClient({ close: 'plain string' as unknown as Error });
    const running = (await run(fake.proc, { createClusters: () => singleCluster(client), ensureIndexes: noIndexes })) as RunningServer;
    (fake.listeners.get('SIGTERM') as Listener)();
    await new Promise<void>((resolve) => running.server.once('close', () => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.match(fake.out.join(''), /"errorName":"string"/);
    assert.ok(!fake.out.join('').includes('plain string'));
  });

  it('readiness pings the real database', async () => {
    const up = await started();
    try {
      assert.equal((await fetch(`http://127.0.0.1:${up.port}/health/ready`)).status, 200);
    } finally {
      await closed(up.running);
    }
  });
});

describe('run: media storage', () => {
  it('starts without a storage by default, and with Google Cloud Storage through the metadata server (nothing is called at start-up)', async () => {
    const off = await started();
    const metadata = await started({ MEDIA_STORAGE: 'gcs', GCS_MEDIA_BUCKET: 'test-media-bucket', GCS_AUTH: 'metadata' });
    try {
      assert.equal((await fetch(`http://127.0.0.1:${off.port}/health/ready`)).status, 200);
      assert.equal((await fetch(`http://127.0.0.1:${metadata.port}/health/ready`)).status, 200);
    } finally {
      await closed(off.running);
      await closed(metadata.running);
    }
  });

  it('reads the credentials file once at start-up, and exits 1 when it cannot be used, without naming the file or any key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'media-'));
    try {
      const good = join(directory, 'sa.json');
      await writeFile(good, credentialsFile(testKeyPair().privatePem));
      const up = await started({ MEDIA_STORAGE: 'gcs', GCS_MEDIA_BUCKET: 'test-media-bucket', GCS_AUTH: 'service-account-file', GCS_SERVICE_ACCOUNT_FILE: good });
      await closed(up.running);
      for (const file of [join(directory, 'missing.json'), join(directory, 'broken.json')]) {
        await writeFile(join(directory, 'broken.json'), '{"type":"service_account","private_key":"-----BEGIN PRIVATE KEY-----"}'); // gitleaks:allow (fake test value)
        const fake = fakeProcess(mongoEnv({ PORT: '0', SHUTDOWN_DRAIN_MS: '0', MEDIA_STORAGE: 'gcs', GCS_MEDIA_BUCKET: 'test-media-bucket', GCS_AUTH: 'service-account-file', GCS_SERVICE_ACCOUNT_FILE: file }));
        assert.equal(await run(fake.proc), undefined);
        assert.deepEqual(fake.exits, [1]);
        const log = fake.out.join('');
        assert.match(log, /media storage startup failed/);
        assert.match(log, /Storage startup failed: configuration/);
        assert.ok(!log.includes(directory) && !log.includes('PRIVATE'));
      }
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  it('exits 1 with the configuration problem when the storage settings are not valid', async () => {
    const fake = fakeProcess(mongoEnv({ MEDIA_STORAGE: 'gcs' }));
    assert.equal(await run(fake.proc), undefined);
    assert.deepEqual(fake.exits, [1]);
    assert.match(fake.err.join(''), /GCS_MEDIA_BUCKET: is required/);
  });
});
