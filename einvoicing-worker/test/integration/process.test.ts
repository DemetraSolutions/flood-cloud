import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { after, describe, it } from 'node:test';
import type { MongoClient } from 'mongodb';
import { LEASE_COLLECTION, LEASE_ID } from '../../src/lease.ts';
import type { LeaseDocument } from '../../src/lease.ts';
import { freePort, mongoEnv, waitFor } from '../helpers/env.ts';
import { createTestClient, dropPrefixAndClose, randomTestPrefix } from '../helpers/mongo.ts';

/** Starts `node src/main.ts` (a real process, so the entry point itself is covered) with exactly the given environment. */
function startProcess(env: Record<string, string | undefined>, script = 'src/main.ts', args: string[] = []) {
  const child: ChildProcess = spawn(process.execPath, [script, ...args], {
    cwd: new URL('../..', import.meta.url),
    // NODE_V8_COVERAGE is forwarded so the test runner merges the child's coverage.
    env: { PATH: process.env['PATH'], NODE_V8_COVERAGE: process.env['NODE_V8_COVERAGE'], ...env } as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => void (stdout += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => void (stderr += chunk.toString()));
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  return { child, exited, stdout: () => stdout, stderr: () => stderr };
}

describe('the worker process', () => {
  const prefix = randomTestPrefix();
  let observer: MongoClient | undefined;
  after(async () => {
    observer ??= await createTestClient();
    await dropPrefixAndClose(observer, prefix);
  });

  it('starts, answers the liveness probe, and stops on SIGTERM releasing the lease', async () => {
    const port = await freePort();
    const proc = startProcess(mongoEnv({ DB_NAME_PREFIX: prefix, HEALTH_PORT: String(port) }));
    try {
      await waitFor(() => (proc.stdout().includes('worker started') ? true : undefined));
      assert.equal((await fetch(`http://127.0.0.1:${port}/health/live`)).status, 200);
      observer = await createTestClient();
      const leases = observer.db(`${prefix}development_common`).collection<LeaseDocument>(LEASE_COLLECTION);
      const doc = await waitFor(async () => (await leases.findOne({ _id: LEASE_ID })) ?? undefined);
      assert.equal(doc.holder, 'worker-test-0');
      proc.child.kill('SIGTERM');
      assert.equal(await proc.exited, 0);
      assert.match(proc.stdout(), /worker stopped/);
      assert.equal(proc.stderr(), '');
      const released = await leases.findOne({ _id: LEASE_ID });
      assert.ok((released?.expiresAt.getTime() ?? Infinity) <= Date.now());
    } finally {
      proc.child.kill('SIGKILL');
    }
  });

  it('exits 1 with the list of issues on an invalid configuration', async () => {
    const proc = startProcess({ APP_ENV: 'development', MONGODB_URI: 'nope' });
    assert.equal(await proc.exited, 1);
    assert.match(proc.stderr(), /WORKER_INSTANCE_ID/);
    assert.match(proc.stderr(), /MONGODB_URI/);
    assert.doesNotMatch(proc.stderr(), /nope/);
  });

  it('runs the operator commands as plain scripts, with the exit codes they promise', async () => {
    const report = startProcess(mongoEnv({ DB_NAME_PREFIX: prefix }), 'src/tools/shadow-report.ts', ['--json', '--version', 'none']);
    assert.equal(await report.exited, 0);
    assert.equal((JSON.parse(report.stdout()) as { total: number }).total, 0);
    assert.equal(report.stderr(), '');
    const inflight = startProcess(mongoEnv({ DB_NAME_PREFIX: prefix }), 'src/tools/inflight.ts');
    assert.equal(await inflight.exited, 0);
    assert.match(inflight.stdout(), /Nothing is claimed, uploading or possibly sent: exit 0/);
    const wrong = startProcess(mongoEnv({ DB_NAME_PREFIX: prefix }), 'src/tools/inflight.ts', ['--nope']);
    assert.equal(await wrong.exited, 2);
    observer ??= await createTestClient();
    await observer.db(`${prefix}development_queue`).collection('documents').insertOne({ worker: { state: 'uploading' } });
    const busy = startProcess(mongoEnv({ DB_NAME_PREFIX: prefix }), 'src/tools/inflight.ts');
    assert.equal(await busy.exited, 1);
    assert.match(busy.stdout(), /uploading 1/);
  });
});
