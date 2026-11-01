import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDatabaseConfig } from '../../src/config.ts';
import { createMongoClient } from '../../src/db/client.ts';
import { main, safeMessage } from '../../src/tools/profile-legacy/main.ts';
import type { MainDeps } from '../../src/tools/profile-legacy/main.ts';
import { seedLegacyCluster } from '../helpers/legacy-fixtures.ts';
import { mongoEnv, openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';

const CLI = fileURLToPath(new URL('../../src/tools/profile-legacy/cli.ts', import.meta.url));

interface Run {
  code: number;
  info: string[];
  error: string[];
}

async function run(
  argv: string[],
  env: Record<string, string | undefined>,
  loadEnvFile: MainDeps['loadEnvFile'] = () => undefined,
  cwd: string = tmpdir(),
): Promise<Run> {
  const info: string[] = [];
  const error: string[] = [];
  const code = await main(argv, { env, cwd, loadEnvFile, info: (line) => info.push(line), error: (line) => error.push(line) });
  return { code, info, error };
}

function errnoError(code: string): Error {
  return Object.assign(new Error(`${code}: boom`), { code });
}

describe('profile-legacy main (real MongoDB)', () => {
  let dir: string;
  let ctx: TestDatabases;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'flood-profile-'));
    ctx = await openTestDatabases();
    await seedLegacyCluster(ctx.databases);
  });
  after(async () => {
    await ctx.cleanup();
    await rm(dir, { recursive: true, force: true });
  });

  const env = (overrides: Record<string, string | undefined> = {}) => mongoEnv({ DB_NAME_PREFIX: ctx.prefix, ...overrides }) as Record<string, string>;

  it('prints progress as numbers only', async () => {
    const info: string[] = [];
    const error: string[] = [];
    const code = await main(['--out', join(dir, 'progress.json')], {
      env: env(),
      cwd: dir,
      loadEnvFile: () => undefined,
      info: (line) => info.push(line),
      error: (line) => error.push(line),
      progressEvery: 1,
    });
    assert.equal(code, 0, error.join());
    assert.deepEqual(error.filter((line) => line.startsWith('profiled')), ['profiled 1/2 group databases', 'profiled 2/2 group databases']);
  });

  it('requires exactly --out <path>', async () => {
    for (const argv of [
      ['--out'],
      ['--out', ''],
      ['--out', 'a', 'b'],
      ['--file', 'a'],
      ['--env'],
      ['--env', 'staging'],
      ['--env', 'PRODUCTION'],
      ['--out', 'a', '--out', 'b'],
      ['--env', 'production', '--env', 'development'],
    ]) {
      const result = await run(argv, env());
      assert.equal(result.code, 1, argv.join(' '));
      assert.match(result.error.join(), /Usage/);
    }
  });

  it('writes the report to a new file and refuses to overwrite it', async () => {
    const out = join(dir, 'report.json');
    const first = await run(['--out', out], env());
    assert.equal(first.code, 0, first.error.join());
    assert.match(first.info.join(), /Report written/);
    assert.ok(first.error.includes('Profiling development: 2 group databases found, read-only'));
    const parsed = JSON.parse(await readFile(out, 'utf8')) as { appEnv: string; collections: { users: { fields: { documents: number } } } };
    assert.equal(parsed.appEnv, 'development');
    assert.equal(parsed.collections.users.fields.documents, 10);
    const before = await readFile(out, 'utf8');
    const second = await run(['--out', out], env());
    assert.equal(second.code, 1);
    assert.match(second.error.join(), /overwrite/);
    assert.equal(await readFile(out, 'utf8'), before);
  });

  it('does not need secrets it does not use', async () => {
    const out = join(dir, 'no-pepper.json');
    const result = await run(['--out', out], env({ LEGACY_PASSWORD_PEPPER: undefined }));
    assert.equal(result.code, 0, result.error.join());
    await access(out);
  });

  it('refuses any environment but development', async () => {
    const result = await run(['--out', join(dir, 'prod.json')], env({ APP_ENV: 'production', MONGODB_URI: 'mongodb://127.0.0.1:1/?tls=true' }));
    assert.equal(result.code, 1);
    assert.match(result.error.join(), /does not match/);
    await assert.rejects(access(join(dir, 'prod.json')));
  });

  it('accepts --env development and refuses a mismatch in either direction', async () => {
    const ok = await run(['--env', 'development', '--out', join(dir, 'dev-explicit.json')], env());
    assert.equal(ok.code, 0, ok.error.join());
    const wanted = await run(['--env', 'production', '--out', join(dir, 'p1.json')], env());
    assert.equal(wanted.code, 1);
    assert.match(wanted.error.join(), /does not match/);
    const defaulted = await run(['--out', join(dir, 'p2.json')], env({ APP_ENV: 'production', MONGODB_URI: 'mongodb://127.0.0.1:1/?tls=true' }));
    assert.equal(defaulted.code, 1);
    assert.match(defaulted.error.join(), /does not match/);
    const mismatch = await run(['--env', 'development', '--out', join(dir, 'p3.json')], env({ APP_ENV: 'production', MONGODB_URI: 'mongodb://127.0.0.1:1/?tls=true' }));
    assert.equal(mismatch.code, 1);
    for (const name of ['p1', 'p2', 'p3']) {
      await assert.rejects(access(join(dir, `${name}.json`)));
    }
  });

  it('keeps the TLS rule for --env production and never connects when it fails', async () => {
    const weak = await run(['--env', 'production', '--out', join(dir, 'weak.json')], env({ APP_ENV: 'production', MONGODB_URI: 'mongodb://127.0.0.1:27027/?directConnection=true' }));
    assert.equal(weak.code, 1);
    assert.match(weak.error.join(), /MONGODB_URI: must use TLS in production/);
    const tls = await run(
      ['--env', 'production', '--out', join(dir, 'tls.json')],
      env({ APP_ENV: 'production', MONGODB_URI: 'mongodb://127.0.0.1:1/?tls=true&directConnection=true', MONGODB_SERVER_SELECTION_TIMEOUT_MS: '1000' }),
    );
    assert.equal(tls.code, 1);
    assert.ok(!tls.error.join().includes('127.0.0.1'));
  });

  it('profiles production when asked, reporting the real environment and a default name with it', async () => {
    const prod = await openTestDatabases('production');
    const repo = await mkdtemp(join(tmpdir(), 'flood-repo-'));
    try {
      await seedLegacyCluster(prod.databases);
      await mkdir(join(repo, '.git'), { recursive: true });
      const backend = join(repo, 'backend');
      await mkdir(backend);
      const errors: string[] = [];
      const code = await main(['--env', 'production'], {
        env: {},
        cwd: backend,
        loadEnvFile: () => undefined,
        info: () => undefined,
        error: (line) => void errors.push(line),
        // The TLS rule is not weakened: the loader and client factory are replaced because the local server has no TLS.
        loadDatabaseConfig: () => ({ ...loadDatabaseConfig(env()), appEnv: 'production', dbNamePrefix: prod.prefix }),
        createClient: (config, options) => createMongoClient({ ...config, appEnv: 'development' }, options),
      });
      assert.equal(code, 0, errors.join());
      assert.ok(errors.includes('Profiling production: 2 group databases found, read-only'));
      const [file] = await readdir(join(backend, 'reports'));
      assert.match(file ?? '', /^legacy-profile-production-\d{8}T\d{9}Z\.json$/);
      const report = JSON.parse(await readFile(join(backend, 'reports', file ?? ''), 'utf8')) as { appEnv: string; databases: { groupDatabases: number } };
      assert.equal(report.appEnv, 'production');
      assert.equal(report.databases.groupDatabases, 2);
    } finally {
      await prod.cleanup();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('reports configuration problems by variable name', async () => {
    const result = await run(['--out', join(dir, 'x.json')], {}, () => {
      throw errnoError('ENOENT');
    });
    assert.equal(result.code, 1);
    assert.match(result.error.join(), /APP_ENV: is required/);
    assert.match(result.error.join(), /MONGODB_URI: is required/);
  });

  it('tolerates only a missing .env file', async () => {
    const other = await run(['--out', join(dir, 'y.json')], env(), () => {
      throw errnoError('EISDIR');
    });
    assert.equal(other.code, 1);
    assert.match(other.error.join(), /EISDIR/);
    const thrown = await run(['--out', join(dir, 'y.json')], env(), () => {
      throw 'not an error object';
    });
    assert.equal(thrown.code, 1);
    assert.match(thrown.error.join(), /Unknown error/);
  });

  it('fails cleanly when MongoDB is unreachable, without printing the URI', async () => {
    const uri = 'mongodb://127.0.0.1:1/?directConnection=true';
    const result = await run(['--out', join(dir, 'down.json')], env({ MONGODB_URI: uri, MONGODB_SERVER_SELECTION_TIMEOUT_MS: '1000' }));
    assert.equal(result.code, 1);
    assert.ok(result.error.length > 0);
    assert.ok(!result.error.join().includes(uri));
    await assert.rejects(access(join(dir, 'down.json')));
  });

  it('fails cleanly when the report cannot be written', async () => {
    const result = await run(['--out', join(dir, 'missing-dir', 'r.json')], env());
    assert.equal(result.code, 1);
    assert.match(result.error.join(), /ENOENT/);
  });

  it('writes to backend/reports by default and refuses other places inside the repository', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'flood-repo-'));
    try {
      const backend = join(repo, 'backend');
      await mkdir(join(repo, '.git'), { recursive: true });
      await mkdir(backend);
      const byDefault = await run([], env(), undefined, backend);
      assert.equal(byDefault.code, 0, byDefault.error.join());
      const reports = await readdir(join(backend, 'reports'));
      assert.equal(reports.length, 1);
      assert.match(reports[0] ?? '', /^legacy-profile-development-\d{8}T\d{9}Z\.json$/);

      const explicit = await run(['--out', 'reports/named.json'], env(), undefined, backend);
      assert.equal(explicit.code, 0, explicit.error.join());
      await access(join(backend, 'reports', 'named.json'));

      for (const forbidden of ['src/report.json', '../report.json', join(repo, 'report.json'), 'reports/../report.json']) {
        const refused = await run(['--out', forbidden], env(), undefined, backend);
        assert.equal(refused.code, 1, forbidden);
        assert.match(refused.error.join(), /inside the repository/);
      }
      await assert.rejects(access(join(backend, 'report.json')));

      const outside = await run(['--out', join(dir, 'outside-repo.json')], env(), undefined, backend);
      assert.equal(outside.code, 0, outside.error.join());
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('fails without any host in the output when the connection string cannot be parsed', async () => {
    const result = await run(['--out', join(dir, 'bad-uri.json')], env({ MONGODB_URI: 'mongodb://secret-host.invalid:99999/' }));
    assert.equal(result.code, 1);
    const output = result.error.join();
    assert.ok(output.length > 0);
    assert.ok(!output.includes('secret-host') && !output.includes('99999'));
  });

  it('prints only the name and codes of driver errors', () => {
    const driver = Object.assign(new Error('auth failed for mongodb://u:pw@host'), { name: 'MongoServerError', code: 13, codeName: 'Unauthorized' });
    assert.equal(safeMessage(driver, []), 'MongoServerError code=13 codeName=Unauthorized');
    const bare = Object.assign(new Error('mongodb://u:pw@host is bad'), { name: 'MongoParseError' });
    assert.equal(safeMessage(bare, []), 'MongoParseError');
    const oddCodes = Object.assign(new Error('x'), { name: 'MongoNetworkError', code: {}, codeName: 5 });
    assert.equal(safeMessage(oddCodes, []), 'MongoNetworkError');
    assert.equal(safeMessage(Object.assign(new Error('x'), { code: 'ECODE' }), []), 'Error: x');
  });

  it('masks secrets in error messages', () => {
    assert.equal(safeMessage(new Error('cannot reach mongodb://user:pw@host/db now'), ['mongodb://user:pw@host/db']), 'Error: cannot reach [redacted] now');
    assert.equal(safeMessage('plain', ['x']), 'Unknown error');
  });
});

interface Outcome {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the real CLI in an empty directory that holds only the given `.env`; the parent environment is not inherited. */
async function runCli(args: string[], dotEnv: string | undefined): Promise<Outcome> {
  const cwd = await mkdtemp(join(tmpdir(), 'flood-cli-'));
  try {
    if (dotEnv !== undefined) {
      await writeFile(join(cwd, '.env'), dotEnv);
    }
    return await new Promise<Outcome>((resolve, reject) => {
      const child = spawn(process.execPath, [CLI, ...args], {
        cwd,
        env: process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {},
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function dotEnv(overrides: Record<string, string | undefined> = {}): string {
  return Object.entries(mongoEnv(overrides))
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

describe('node src/tools/profile-legacy/cli.ts', () => {
  it('reads .env, profiles the cluster and writes the report', async () => {
    const out = join(tmpdir(), `flood-report-${process.pid}-${Date.now()}.json`);
    try {
      const outcome = await runCli(['--out', out], dotEnv({ LEGACY_PASSWORD_PEPPER: undefined }));
      assert.equal(outcome.code, 0, outcome.stderr);
      assert.match(outcome.stdout, /Report written/);
      const parsed = JSON.parse(await readFile(out, 'utf8')) as { databases: { commonPresent: boolean } };
      assert.equal(parsed.databases.commonPresent, false);
    } finally {
      await rm(out, { force: true });
    }
  });

  it('exits 1 when there is no .env and no environment', async () => {
    const outcome = await runCli(['--out', join(tmpdir(), 'never-written.json')], undefined);
    assert.equal(outcome.code, 1);
    assert.match(outcome.stderr, /APP_ENV/);
  });

  it('exits 1 on unknown arguments', async () => {
    const outcome = await runCli(['--bogus'], dotEnv());
    assert.equal(outcome.code, 1);
    assert.match(outcome.stderr, /Usage/);
  });

  it('exits 1 when .env is not development', async () => {
    const outcome = await runCli(['--out', join(tmpdir(), 'never-written.json')], dotEnv({ APP_ENV: 'production', MONGODB_URI: 'mongodb://127.0.0.1:1/?tls=true' }));
    assert.equal(outcome.code, 1);
    assert.match(outcome.stderr, /development/);
  });
});
