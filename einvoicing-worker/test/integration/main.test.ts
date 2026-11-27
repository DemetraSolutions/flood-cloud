import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { after, afterEach, before, describe, it } from 'node:test';
import { MongoClient } from 'mongodb';
import type { Document } from 'mongodb';
import { createMongoClient } from '../../src/db/client.ts';
import { commonDatabaseName } from '../../src/db/names.ts';
import { LEASE_COLLECTION, LEASE_ID } from '../../src/lease.ts';
import type { LeaseDocument } from '../../src/lease.ts';
import { Secret } from '../../src/secret.ts';
import { SHADOW_COLLECTION } from '../../src/shadow/reports.ts';
import type { ShadowReport } from '../../src/shadow/reports.ts';
import { currentCodeVersion } from '../../src/shadow/version.ts';
import { loadDotEnv, startWorker } from '../../src/main.ts';
import type { ProcessLike, RunningWorker } from '../../src/main.ts';
import { freePort, mongoEnv, validEnv, waitFor } from '../helpers/env.ts';
import { createTestClient, randomTestPrefix, testMongoUri } from '../helpers/mongo.ts';
import { createFakeAdapter, createWorld, queueRecordOf, seedPlatformAccount, seedRecord } from '../helpers/world.ts';

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

describe('loadDotEnv', () => {
  it('ignores a missing file and rethrows any other error', () => {
    loadDotEnv({ loadEnvFile: () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); } });
    loadDotEnv({ loadEnvFile: () => undefined });
    assert.throws(() => loadDotEnv({ loadEnvFile: () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); } }), { code: 'EACCES' });
    assert.throws(() => loadDotEnv({ loadEnvFile: () => { throw 'plain'; } }));
  });
});

describe('startWorker', () => {
  let observer: MongoClient;
  const prefixes: string[] = [];
  const workers: RunningWorker[] = [];

  before(async () => {
    observer = await createTestClient();
  });
  after(async () => {
    for (const prefix of prefixes) {
      const { databases } = await observer.db().admin().listDatabases({ nameOnly: true });
      for (const { name } of databases) {
        if (name.startsWith(prefix)) {
          await observer.db(name).dropDatabase();
        }
      }
    }
    await observer.close();
  });
  afterEach(async () => {
    for (const worker of workers.splice(0)) {
      await worker.shutdown('test cleanup');
    }
  });

  async function env(overrides: Record<string, string | undefined> = {}) {
    const prefix = randomTestPrefix();
    prefixes.push(prefix);
    return mongoEnv({ DB_NAME_PREFIX: prefix, HEALTH_PORT: String(await freePort()), LOG_LEVEL: 'debug', WORKER_MODE: 'send', ...overrides });
  }
  const leaseOf = (prefix: string) =>
    observer.db(commonDatabaseName({ prefix, appEnv: 'development' })).collection<LeaseDocument>(LEASE_COLLECTION);

  it('exits 1 listing variable and reason only when the configuration is invalid', async () => {
    const { proc, err, exits, out } = fakeProcess({ APP_ENV: 'development', MONGODB_URI: 'mongodb://user:topsecret@h/' });
    assert.equal(await startWorker(proc), undefined);
    assert.deepEqual(exits, [1]);
    assert.equal(out.length, 0);
    assert.match(err.join(''), /WORKER_INSTANCE_ID/);
    assert.doesNotMatch(err.join(''), /topsecret/);
  });

  it('refuses to start in production when a .env file exists', async () => {
    const { proc, out, exits } = fakeProcess(validEnv({ APP_ENV: 'production', MONGODB_URI: 'mongodb://127.0.0.1:1/?tls=true' }));
    assert.equal(await startWorker(proc, { dotEnvExists: () => true }), undefined);
    assert.deepEqual(exits, [1]);
    assert.match(out.join(''), /\.env file exists/);
  });

  it('checks the real working directory for .env by default (production)', async () => {
    const previous = process.cwd();
    process.chdir(mkdtempSync(`${tmpdir()}/einvoicing-worker-`));
    try {
      const { proc, exits, out } = fakeProcess(validEnv({ APP_ENV: 'production', MONGODB_URI: 'mongodb://127.0.0.1:1/?tls=true' }));
      const failing = createMongoClient({ mongodbUri: new Secret('mongodb://127.0.0.1:1/?tls=true'), appEnv: 'production' });
      failing.connect = async () => {
        throw new Error('down');
      };
      assert.equal(await startWorker(proc, { createClient: () => failing }), undefined);
      assert.deepEqual(exits, [1]);
      assert.match(out.join(''), /MongoDB is not available/);
      assert.doesNotMatch(out.join(''), /\.env file exists/);
    } finally {
      process.chdir(previous);
    }
  });

  it('exits 1 when the client cannot be built or MongoDB does not answer', async () => {
    const built = fakeProcess(validEnv());
    assert.equal(
      await startWorker(built.proc, {
        createClient: () => {
          throw new Error('bad uri');
        },
      }),
      undefined,
    );
    assert.deepEqual(built.exits, [1]);
    const down = fakeProcess(validEnv());
    const client = await createTestClient();
    await client.close();
    client.connect = async () => {
      throw new Error('down');
    };
    assert.equal(await startWorker(down.proc, { createClient: () => client }), undefined);
    assert.deepEqual(down.exits, [1]);
  });

  it('exits 1 and closes MongoDB when the probe port is taken', async () => {
    const taken = await (await import('../../src/health.ts')).startHealthServer(0, () => true);
    try {
      const { proc, exits, out } = fakeProcess(await env({ HEALTH_PORT: String(taken.port) }));
      assert.equal(await startWorker(proc), undefined);
      assert.deepEqual(exits, [1]);
      assert.match(out.join(''), /liveness probe cannot listen/);
    } finally {
      await taken.close();
    }
  });

  it('acquires the lease, runs the jobs with the epoch, answers the probe and shuts down in order', async () => {
    const environment = await env({ LOOP_INTERVAL_MS: '1000', HEALTH_STALE_MS: '40000' });
    const prefix = environment['DB_NAME_PREFIX'] as string;
    const { proc, out, exits, listeners } = fakeProcess(environment);
    const epochs: number[] = [];
    const worker = await startWorker(proc, { jobs: [{ name: 'probe', run: async (ctx) => void epochs.push(ctx.epoch) }] });
    assert.ok(worker);
    workers.push(worker);

    const doc = await waitFor(async () => leaseOf(prefix).findOne({ _id: LEASE_ID }).then((d) => d ?? undefined));
    assert.equal(doc.holder, 'worker-test-0');
    assert.equal(doc.epoch, 1);
    const live = await fetch(`http://127.0.0.1:${worker.health.port}/health/live`);
    assert.equal(live.status, 200);
    await waitFor(() => (epochs.length > 0 ? true : undefined), 3000);
    assert.equal(epochs[0], 1);
    assert.deepEqual([...listeners.keys()].sort(), ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection']);

    listeners.get('SIGTERM')?.();
    const first = worker.shutdown('again');
    assert.equal(first, worker.shutdown('third'), 'idempotent: the same promise');
    await first;
    assert.deepEqual(exits, [0]);
    assert.match(out.join(''), /worker stopped/);
    assert.doesNotMatch(out.join(''), /mongodb:\/\//);
    const released = await leaseOf(prefix).findOne({ _id: LEASE_ID });
    assert.ok((released?.expiresAt.getTime() ?? Infinity) <= Date.now());
    await assert.rejects(fetch(`http://127.0.0.1:${worker.health.port}/health/live`));
  });

  it('runs the queue engine by default: with no hub enabled it only says so and touches no record', async () => {
    const environment = await env({ LOOP_INTERVAL_MS: '1000', HEALTH_STALE_MS: '40000' });
    const { proc, out } = fakeProcess(environment);
    const worker = await startWorker(proc);
    assert.ok(worker);
    workers.push(worker);
    await waitFor(() => (out.join('').includes('no hubs enabled') ? true : undefined), 4000);
    assert.match(out.join(''), /"hubs":0/);
  });

  it('refuses to start with a hub enabled and no private key for the credentials', async () => {
    const { proc, exits, err } = fakeProcess(await env({ WORKER_HUBS: 'aruba' }));
    assert.equal(await startWorker(proc), undefined);
    assert.deepEqual(exits, [1]);
    assert.match(err.join(''), /CREDENTIALS_PRIVATE_KEY_ID/);
  });

  it('refuses to start with an aruba hub and no Aruba environment', async () => {
    const world = await createWorld();
    try {
      const { proc, exits, err } = fakeProcess(await env({ WORKER_HUBS: 'aruba', CREDENTIALS_PRIVATE_KEY: world.keys.privatePem, CREDENTIALS_PRIVATE_KEY_ID: world.keys.keyId }));
      assert.equal(await startWorker(proc), undefined);
      assert.deepEqual(exits, [1]);
      assert.match(err.join(''), /ARUBA_ENVIRONMENT/);
    } finally {
      await world.drop();
    }
  });

  it('refuses to start when the liveness window cannot hold the longest Aruba call, or the record lease cannot outlast a round and a call', async () => {
    const world = await createWorld();
    try {
      const base = { WORKER_HUBS: 'aruba', ARUBA_ENVIRONMENT: 'demo', CREDENTIALS_PRIVATE_KEY: world.keys.privatePem, CREDENTIALS_PRIVATE_KEY_ID: world.keys.keyId, LOOP_INTERVAL_MS: '1000' };
      const small = fakeProcess(await env({ ...base, HEALTH_STALE_MS: '100000' }));
      assert.equal(await startWorker(small.proc), undefined);
      assert.deepEqual(small.exits, [1]);
      assert.match(small.out.join('') + small.err.join(''), /HEALTH_STALE_MS is too small for the longest provider call/);
      const lease = fakeProcess(await env({ ...base, HEALTH_STALE_MS: '130000', RECORD_LEASE_MS: '90000' }));
      assert.equal(await startWorker(lease.proc), undefined);
      assert.deepEqual(lease.exits, [1]);
      assert.match(lease.out.join('') + lease.err.join(''), /RECORD_LEASE_MS must be greater than the round budget plus the longest provider call/);
    } finally {
      await world.drop();
    }
  });

  it('builds the Aruba adapter by default when the Aruba environment is set (an aruba hub is then active, no network is touched without a record)', async () => {
    const world = await createWorld();
    try {
      await seedPlatformAccount(world, 'aruba', { username: 'platform-user', password: 'platform-secret' });
      const environment = await env({
        DB_NAME_PREFIX: world.names.prefix,
        LOOP_INTERVAL_MS: '1000',
        HEALTH_STALE_MS: '130000',
        WORKER_HUBS: 'aruba',
        ARUBA_ENVIRONMENT: 'demo',
        CREDENTIALS_PRIVATE_KEY: world.keys.privatePem,
        CREDENTIALS_PRIVATE_KEY_ID: world.keys.keyId,
      });
      const { proc, out } = fakeProcess(environment);
      const worker = await startWorker(proc);
      assert.ok(worker);
      workers.push(worker);
      await waitFor(() => world.queue.indexes().then((indexes) => (indexes.some((index) => index.name === 'einvoicingWorker_upload') ? true : undefined), () => undefined), 6000);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      assert.doesNotMatch(out.join(''), /no adapter for the provider/);
    } finally {
      for (const worker of workers.splice(0)) {
        await worker.shutdown('test cleanup');
      }
      await world.drop();
    }
  });

  it('sends a queued invoice end to end: configuration, accounts, limiters, queue and adapter', async () => {
    const world = await createWorld();
    try {
      await seedPlatformAccount(world, 'fake', { username: 'platform-user', password: 'platform-secret' });
      const record = await seedRecord(world, 'fake');
      const adapter = createFakeAdapter('fake', true);
      const environment = await env({
        DB_NAME_PREFIX: world.names.prefix,
        LOOP_INTERVAL_MS: '1000',
        HEALTH_STALE_MS: '40000',
        WORKER_HUBS: 'fake',
        CREDENTIALS_PRIVATE_KEY: world.keys.privatePem,
        CREDENTIALS_PRIVATE_KEY_ID: world.keys.keyId,
      });
      const { proc, out } = fakeProcess(environment);
      const worker = await startWorker(proc, { adapters: new Map([['fake', adapter]]), random: () => 0 });
      assert.ok(worker);
      workers.push(worker);
      const sent = await waitFor(async () => ((await queueRecordOf(world, record))?.['sent'] === true ? true : undefined), 8000);
      assert.equal(sent, true);
      assert.equal(adapter.uploads.length, 1);
      assert.equal(adapter.uploads[0]?.account.password.reveal(), 'platform-secret');
      await waitFor(async () => ((await world.sent.countDocuments()) === 1 ? true : undefined), 4000);

      // The account changes while the worker runs: the next upload re-reads it and the adapter drops what it cached.
      await seedPlatformAccount(world, 'fake', { username: 'platform-user', password: 'new-secret' });
      const second = await seedRecord(world, 'fake', { number: 43 });
      await waitFor(async () => ((await queueRecordOf(world, second))?.['sent'] === true ? true : undefined), 8000);
      assert.deepEqual(adapter.forgotten, ['fake']);
      assert.equal(adapter.uploads[1]?.account.password.reveal(), 'new-secret');
      assert.doesNotMatch(out.join(''), /platform-secret|new-secret|BEGIN PRIVATE KEY|<p:Fattura/);
    } finally {
      for (const worker of workers.splice(0)) {
        await worker.shutdown('test cleanup');
      }
      await world.drop();
    }
  });

  it('stays in standby while another instance holds the lease, with a live probe', async () => {
    const environment = await env({ WORKER_INSTANCE_ID: 'standby-1' });
    const prefix = environment['DB_NAME_PREFIX'] as string;
    await leaseOf(prefix).insertOne({
      _id: LEASE_ID,
      holder: 'other',
      epoch: 7,
      acquiredAt: new Date(),
      renewedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const { proc, out } = fakeProcess(environment);
    const epochs: number[] = [];
    const worker = await startWorker(proc, { jobs: [{ name: 'never', run: async (ctx) => void epochs.push(ctx.epoch) }] });
    assert.ok(worker);
    workers.push(worker);
    await waitFor(() => (out.join('').includes('standby') ? true : undefined));
    assert.equal((await fetch(`http://127.0.0.1:${worker.health.port}/health/live`)).status, 200);
    assert.equal((await leaseOf(prefix).findOne({ _id: LEASE_ID }))?.holder, 'other');
    assert.deepEqual(epochs, []);
  });

  it('handles SIGINT and exits 1 on uncaught errors and unhandled rejections', async () => {
    const { proc, exits, out, listeners } = fakeProcess(await env());
    const worker = await startWorker(proc);
    assert.ok(worker);
    workers.push(worker);
    listeners.get('uncaughtException')?.(new Error('boom'));
    listeners.get('unhandledRejection')?.('reason');
    assert.deepEqual(exits, [1, 1]);
    assert.match(out.join(''), /uncaught exception/);
    assert.match(out.join(''), /unhandled rejection/);
    listeners.get('SIGINT')?.();
    await worker.shutdown('SIGINT');
    assert.deepEqual(exits, [1, 1, 0]);
  });

  it('exits 1 when the shutdown fails', async () => {
    const { proc, exits, out } = fakeProcess(await env());
    const worker = await startWorker(proc);
    assert.ok(worker);
    const realClose = worker.client.close.bind(worker.client);
    worker.client.close = async () => {
      throw new Error('close failed');
    };
    await worker.shutdown('SIGTERM');
    assert.deepEqual(exits, [1]);
    assert.match(out.join(''), /shutdown failed/);
    await realClose();
  });
  describe('the shadow mode (the default)', () => {
    it('analyses the queue into reports and writes nothing else: no send, no claim, no account, no credential, no queue index', async () => {
      const world = await createWorld();
      const commands: Array<{ name: string; db: string; collection: string }> = [];
      const monitored = new MongoClient(testMongoUri(), { monitorCommands: true });
      monitored.on('commandStarted', (event) => {
        const target: unknown = (event.command as Document)[event.commandName];
        commands.push({ name: event.commandName, db: event.databaseName, collection: typeof target === 'string' ? target : '' });
      });
      try {
        const record = await seedRecord(world, 'aruba');
        await seedRecord(world, 'aruba', { sent: true, hubId: 'legacy.xml' });
        const queueBefore = await world.queue.find({}).sort({ _id: 1 }).toArray();
        const groupBefore = await world.group(record['groupId']).find({}).toArray();
        const environment = await env({
          DB_NAME_PREFIX: world.names.prefix,
          WORKER_MODE: undefined,
          SHADOW_HUBS: 'aruba',
          BUILD_SHA: 'sha-1',
          LOOP_INTERVAL_MS: '1000',
          HEALTH_STALE_MS: '40000',
          // A configuration meant for `send` is ignored: nothing is parsed, nothing is decrypted.
          WORKER_HUBS: 'aruba',
          CREDENTIALS_PRIVATE_KEY: 'not-a-key',
          ARUBA_ENVIRONMENT: 'nonsense',
        });
        const { proc, out } = fakeProcess(environment);
        const worker = await startWorker(proc, { createClient: () => monitored });
        assert.ok(worker);
        workers.push(worker);
        const reports = world.client.db(commonDatabaseName(world.names)).collection<ShadowReport>(SHADOW_COLLECTION);
        await waitFor(async () => ((await reports.countDocuments()) === 2 ? true : undefined), 6000);
        const version = currentCodeVersion('sha-1');
        assert.deepEqual([...new Set((await reports.find({}).toArray()).map((entry) => entry.codeVersion))], [version]);
        assert.match(out.join(''), /"mode":"shadow","hubs":1/);
        await worker.shutdown('test');
        assert.deepEqual(await world.queue.find({}).sort({ _id: 1 }).toArray(), queueBefore);
        assert.deepEqual(await world.group(record['groupId']).find({}).toArray(), groupBefore);
        assert.deepEqual((await world.queue.indexes()).map((index) => index.name), ['_id_']);
        assert.equal(await world.limits.countDocuments(), 0);
        assert.equal(await world.sent.countDocuments(), 0);
        const common = commonDatabaseName(world.names);
        const writes = commands.filter((entry) => ['insert', 'update', 'delete', 'findAndModify', 'createIndexes', 'drop', 'create'].includes(entry.name));
        assert.ok(writes.length > 0);
        for (const entry of writes) {
          assert.ok(entry.db === common && [SHADOW_COLLECTION, LEASE_COLLECTION].includes(entry.collection), `${entry.name} ${entry.db}.${entry.collection}`);
        }
        assert.ok(!commands.some((entry) => ['dealers', 'settings', 'users'].includes(entry.collection)), 'the accounts are never read');
      } finally {
        await world.drop();
      }
    });

    it('says so when no hub is selected, and starts in shadow when WORKER_MODE is not set', async () => {
      const { proc, out } = fakeProcess(await env({ WORKER_MODE: undefined, LOOP_INTERVAL_MS: '1000', HEALTH_STALE_MS: '40000' }));
      const worker = await startWorker(proc);
      assert.ok(worker);
      workers.push(worker);
      await waitFor(() => (out.join('').includes('no hubs selected') ? true : undefined), 4000);
      assert.match(out.join(''), /"mode":"shadow","hubs":0/);
    });

    it('counts every hub when SHADOW_HUBS is *', async () => {
      const { proc, out } = fakeProcess(await env({ WORKER_MODE: 'shadow', SHADOW_HUBS: '*', LOOP_INTERVAL_MS: '1000', HEALTH_STALE_MS: '40000' }));
      const worker = await startWorker(proc);
      assert.ok(worker);
      workers.push(worker);
      assert.match(out.join(''), /"mode":"shadow","hubs":"all"/);
    });

    it('exits 1 and closes MongoDB when the code version cannot be determined', async () => {
      const { proc, exits, out } = fakeProcess(await env({ WORKER_MODE: 'shadow' }));
      assert.equal(
        await startWorker(proc, {
          codeVersion: () => {
            throw new Error('no package.json');
          },
        }),
        undefined,
      );
      assert.deepEqual(exits, [1]);
      assert.match(out.join(''), /the code version cannot be determined/);
    });

    it('exits 1 when the liveness window leaves no room for a round', async () => {
      const { proc, exits, out } = fakeProcess(await env({ WORKER_MODE: 'shadow', HEALTH_STALE_MS: '31000', LOOP_INTERVAL_MS: '1000' }));
      assert.equal(await startWorker(proc), undefined);
      assert.deepEqual(exits, [1]);
      assert.match(out.join(''), /HEALTH_STALE_MS is too small: raise it/);
    });
  });
});
