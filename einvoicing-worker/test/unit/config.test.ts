import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../../src/config.ts';
import type { Config, ConfigIssue } from '../../src/config.ts';
import { generateKeys } from '../helpers/credentials.ts';
import { validEnv } from '../helpers/env.ts';

function ok(env: Record<string, string | undefined>): Config {
  const result = loadConfig(env);
  assert.equal(result.ok, true, JSON.stringify(result));
  return (result as { config: Config }).config;
}

function issues(env: Record<string, string | undefined>): readonly ConfigIssue[] {
  const result = loadConfig(env);
  assert.equal(result.ok, false);
  return (result as { issues: readonly ConfigIssue[] }).issues;
}

describe('loadConfig', () => {
  it('applies the defaults', () => {
    const config = ok(validEnv());
    assert.equal(config.appEnv, 'development');
    assert.equal(config.dbNamePrefix, '');
    assert.equal(config.instanceId, 'worker-test-0');
    assert.equal(config.leaseTtlMs, 30_000);
    assert.equal(config.leaseRenewMs, 10_000);
    assert.equal(config.loopIntervalMs, 5_000);
    assert.equal(config.healthPort, 8080);
    assert.equal(config.healthStaleMs, 180_000);
    assert.equal(config.logLevel, 'info');
    assert.equal(config.mongodbUri.reveal(), 'mongodb://127.0.0.1:27017/?directConnection=true');
  });

  it('reads every variable and treats empty strings as unset', () => {
    const config = ok(
      validEnv({
        DB_NAME_PREFIX: 'pre_',
        LEASE_TTL_MS: '20000',
        LEASE_RENEW_MS: '2000',
        LOOP_INTERVAL_MS: '1000',
        HEALTH_PORT: '9000',
        HEALTH_STALE_MS: '5000',
        LOG_LEVEL: 'debug',
      }),
    );
    assert.deepEqual(
      [config.dbNamePrefix, config.leaseTtlMs, config.leaseRenewMs, config.loopIntervalMs, config.healthPort, config.healthStaleMs, config.logLevel],
      ['pre_', 20_000, 2_000, 1_000, 9_000, 5_000, 'debug'],
    );
    const empty = ok(validEnv({ DB_NAME_PREFIX: '', LEASE_TTL_MS: '', LOG_LEVEL: '', HEALTH_PORT: '' }));
    assert.equal(empty.leaseTtlMs, 30_000);
    assert.equal(empty.logLevel, 'info');
  });

  it('reports every problem together without echoing values', () => {
    const list = issues({
      APP_ENV: 'staging',
      MONGODB_URI: 'http://user:topsecret@host/',
      DB_NAME_PREFIX: 'bad prefix!',
      WORKER_INSTANCE_ID: 'a b',
      LEASE_TTL_MS: '5',
      LEASE_RENEW_MS: 'abc',
      LOOP_INTERVAL_MS: '999999999',
      HEALTH_PORT: '0',
      HEALTH_STALE_MS: '-1',
      LOG_LEVEL: 'trace',
    });
    assert.deepEqual(
      list.map((issue) => issue.variable),
      ['APP_ENV', 'MONGODB_URI', 'DB_NAME_PREFIX', 'WORKER_INSTANCE_ID', 'LEASE_TTL_MS', 'LEASE_RENEW_MS', 'LOOP_INTERVAL_MS', 'HEALTH_PORT', 'HEALTH_STALE_MS', 'LOG_LEVEL'],
    );
    assert.doesNotMatch(JSON.stringify(list), /topsecret|bad prefix|staging/);
  });

  it('requires APP_ENV, MONGODB_URI and WORKER_INSTANCE_ID', () => {
    const list = issues({});
    assert.deepEqual(list, [
      { variable: 'APP_ENV', reason: 'is required' },
      { variable: 'MONGODB_URI', reason: 'is required' },
      { variable: 'WORKER_INSTANCE_ID', reason: 'is required' },
    ]);
  });

  it('requires LEASE_RENEW_MS to be less than half of LEASE_TTL_MS', () => {
    assert.deepEqual(issues(validEnv({ LEASE_TTL_MS: '20000', LEASE_RENEW_MS: '10000' })), [
      { variable: 'LEASE_RENEW_MS', reason: 'must be less than half of LEASE_TTL_MS' },
    ]);
    assert.equal(ok(validEnv({ LEASE_TTL_MS: '20000', LEASE_RENEW_MS: '9999' })).leaseRenewMs, 9_999);
  });

  it('requires HEALTH_STALE_MS to be greater than LOOP_INTERVAL_MS', () => {
    assert.deepEqual(issues(validEnv({ LOOP_INTERVAL_MS: '5000', HEALTH_STALE_MS: '5000' })), [
      { variable: 'HEALTH_STALE_MS', reason: 'must be greater than LOOP_INTERVAL_MS' },
    ]);
  });

  describe('MongoDB TLS in production', () => {
    const production = (uri: string) => validEnv({ APP_ENV: 'production', MONGODB_URI: uri });

    it('accepts mongodb+srv and mongodb with tls=true or ssl=true', () => {
      ok(production('mongodb+srv://u:p@cluster.example.net/'));
      ok(production('mongodb://h:27017/?tls=true'));
      ok(production('mongodb://h:27017/?SSL=TRUE'));
    });

    it('refuses plain mongodb, tls=false and options that weaken the checks', () => {
      for (const uri of ['mongodb://h:27017/', 'mongodb://h:27017/?tls=false', 'mongodb+srv://h/?tlsInsecure=true', 'mongodb://h/?tls=true&tlsAllowInvalidHostnames=true']) {
        const list = issues(production(uri));
        assert.equal(list.length, 1, uri);
        assert.equal(list[0]?.variable, 'MONGODB_URI');
        assert.doesNotMatch(JSON.stringify(list), /\/\/h|27017/);
      }
    });

    it('does not apply to development', () => {
      ok(validEnv({ MONGODB_URI: 'mongodb://h:27017/' }));
    });
  });

  it('keeps the connection string out of every serialization of the configuration', () => {
    const config = ok(validEnv({ MONGODB_URI: 'mongodb://user:topsecret@h/' }));
    assert.doesNotMatch(JSON.stringify(config), /topsecret/);
    assert.doesNotMatch(`${config.mongodbUri}`, /topsecret/);
  });

  describe('the queue engine settings', () => {
    const keys = generateKeys();
    const hub = 'aruba__0123456789abcdef01234567';
    const sendEnv = (overrides: Record<string, string | undefined> = {}) => validEnv({ WORKER_MODE: 'send', ...overrides });

    it('processes nothing by default: no hubs, no key needed', () => {
      const config = ok(sendEnv());
      assert.deepEqual(config.workerHubs, []);
      assert.equal(config.credentials, undefined);
      assert.deepEqual([config.accountsRefreshMs, config.recordLeaseMs, config.tickBudgetMs], [120_000, 240_000, 30_000]);
      assert.deepEqual(ok(sendEnv({ WORKER_HUBS: ' , ' })).workerHubs, []);
    });

    it('reads the allowlist (trimmed, without duplicates) and the key', () => {
      const config = ok(sendEnv({ WORKER_HUBS: ` aruba , ${hub},aruba`, ARUBA_ENVIRONMENT: 'demo', CREDENTIALS_PRIVATE_KEY: keys.privatePem, CREDENTIALS_PRIVATE_KEY_ID: 'k-1', ACCOUNTS_REFRESH_MS: '10000', RECORD_LEASE_MS: '60000', TICK_BUDGET_MS: '5000' }));
      assert.deepEqual(config.workerHubs, ['aruba', hub]);
      assert.equal(config.arubaEnvironment, 'demo');
      assert.equal(config.credentials?.keyId, 'k-1');
      assert.equal(config.credentials?.privateKey.type, 'private');
      assert.equal(config.credentials?.privateKey.asymmetricKeyType, 'x25519');
      assert.doesNotMatch(JSON.stringify(config.credentials), /BEGIN|PRIVATE/);
      assert.deepEqual([config.accountsRefreshMs, config.recordLeaseMs, config.tickBudgetMs], [10_000, 60_000, 5_000]);
    });

    it('validates the format of every hub, without echoing it', () => {
      for (const bad of ['Aruba', 'aruba__XYZ', 'aruba__0123', '__0123456789abcdef01234567', 'aruba/../x', 'a'.repeat(40)]) {
        const list = issues(sendEnv({ WORKER_HUBS: `aruba,${bad}` }));
        assert.ok(list.some((entry) => entry.variable === 'WORKER_HUBS'), bad);
        assert.doesNotMatch(JSON.stringify(list), /XYZ|\.\./);
      }
      const many = Array.from({ length: 101 }, (_, i) => `h${i}`).join(',');
      const key = { CREDENTIALS_PRIVATE_KEY: keys.privatePem, CREDENTIALS_PRIVATE_KEY_ID: 'k-1' };
      assert.deepEqual(issues(sendEnv({ WORKER_HUBS: many, ...key })).map((entry) => entry.variable), ['WORKER_HUBS']);
    });

    it('needs the key and its id whenever a hub is enabled, and both or none otherwise', () => {
      assert.deepEqual(
        issues(sendEnv({ WORKER_HUBS: 'aruba', ARUBA_ENVIRONMENT: 'demo' })).map((entry) => entry.variable),
        ['CREDENTIALS_PRIVATE_KEY', 'CREDENTIALS_PRIVATE_KEY_ID'],
      );
      assert.deepEqual(issues(sendEnv({ CREDENTIALS_PRIVATE_KEY_ID: 'k-1' })).map((entry) => entry.variable), ['CREDENTIALS_PRIVATE_KEY']);
      assert.deepEqual(issues(sendEnv({ CREDENTIALS_PRIVATE_KEY: keys.privatePem })).map((entry) => entry.variable), ['CREDENTIALS_PRIVATE_KEY_ID']);
      assert.equal(ok(sendEnv({ CREDENTIALS_PRIVATE_KEY: keys.privatePem, CREDENTIALS_PRIVATE_KEY_ID: 'k-1' })).credentials?.keyId, 'k-1');
    });

    it('needs the Aruba environment when an aruba hub is enabled, and refuses a value that is not demo or production', () => {
      const key = { CREDENTIALS_PRIVATE_KEY: keys.privatePem, CREDENTIALS_PRIVATE_KEY_ID: 'k-1' };
      assert.deepEqual(issues(sendEnv({ WORKER_HUBS: hub, ...key })), [{ variable: 'ARUBA_ENVIRONMENT', reason: 'is required when an aruba hub is enabled in WORKER_HUBS' }]);
      assert.equal(ok(sendEnv({ WORKER_HUBS: 'other', ...key })).arubaEnvironment, undefined, 'another provider needs no Aruba environment');
      assert.equal(ok(sendEnv()).arubaEnvironment, undefined);
      assert.equal(ok(sendEnv({ ARUBA_ENVIRONMENT: 'production' })).arubaEnvironment, 'production');
      const list = issues(sendEnv({ ARUBA_ENVIRONMENT: 'prod-secret-looking' }));
      assert.deepEqual(list.map((entry) => entry.variable), ['ARUBA_ENVIRONMENT']);
      assert.doesNotMatch(JSON.stringify(list), /prod-secret-looking/);
    });

    it('refuses a key that is not an X25519 PEM private key and an invalid key id, never echoing them', () => {
      const publicPem = keys.publicKey.export({ format: 'pem', type: 'spki' }).toString();
      for (const bad of ['garbage-text-secret', publicPem]) {
        const list = issues(sendEnv({ CREDENTIALS_PRIVATE_KEY: bad, CREDENTIALS_PRIVATE_KEY_ID: 'k-1' }));
        assert.deepEqual(list.map((entry) => entry.variable), ['CREDENTIALS_PRIVATE_KEY']);
        assert.doesNotMatch(JSON.stringify(list), /garbage-text-secret|BEGIN/);
      }
      assert.deepEqual(issues(sendEnv({ CREDENTIALS_PRIVATE_KEY: keys.privatePem, CREDENTIALS_PRIVATE_KEY_ID: 'Bad Id' })), [{ variable: 'CREDENTIALS_PRIVATE_KEY_ID', reason: 'must match ^[a-z0-9-]{1,32}$' }]);
    });

    it('bounds the timings and keeps the record lease above the round budget', () => {
      const list = issues(sendEnv({ ACCOUNTS_REFRESH_MS: '1', RECORD_LEASE_MS: '1', TICK_BUDGET_MS: '1' }));
      assert.deepEqual(list.map((entry) => entry.variable), ['ACCOUNTS_REFRESH_MS', 'RECORD_LEASE_MS', 'TICK_BUDGET_MS']);
      assert.deepEqual(issues(sendEnv({ RECORD_LEASE_MS: '30000', TICK_BUDGET_MS: '30000' })), [{ variable: 'RECORD_LEASE_MS', reason: 'must be greater than TICK_BUDGET_MS' }]);
    });
  });

  describe('the shadow mode settings', () => {
    const keys = generateKeys();

    it('is the default mode, selects no hub and analyses 50 records per round', () => {
      const config = ok(validEnv());
      assert.deepEqual([config.workerMode, config.shadowHubs, config.shadowBatch, config.shadowLookbackDays, config.buildSha], ['shadow', [], 50, 30, undefined]);
      assert.equal(ok(validEnv({ WORKER_MODE: 'send' })).workerMode, 'send');
      assert.equal(ok(validEnv({ WORKER_MODE: '' })).workerMode, 'shadow');
    });

    it('refuses an unknown mode, without echoing it', () => {
      const list = issues(validEnv({ WORKER_MODE: 'sendd-secret' }));
      assert.deepEqual(list, [{ variable: 'WORKER_MODE', reason: 'must be one of: shadow, send' }]);
    });

    it('reads the shadow hubs: a list, or * for every hub', () => {
      const hub = 'aruba__0123456789abcdef01234567';
      assert.deepEqual(ok(validEnv({ SHADOW_HUBS: ` aruba, ${hub} ,aruba` })).shadowHubs, ['aruba', hub]);
      assert.equal(ok(validEnv({ SHADOW_HUBS: ' * ' })).shadowHubs, '*');
      assert.deepEqual(issues(validEnv({ SHADOW_HUBS: 'aruba,*' })).map((entry) => entry.variable), ['SHADOW_HUBS']);
      assert.deepEqual(issues(validEnv({ SHADOW_HUBS: 'Bad' })).map((entry) => entry.variable), ['SHADOW_HUBS']);
    });

    it('bounds the look-back, and validates the shadow settings only in shadow mode', () => {
      assert.equal(ok(validEnv({ SHADOW_LOOKBACK_DAYS: '365' })).shadowLookbackDays, 365);
      for (const bad of ['0', '366']) {
        assert.deepEqual(issues(validEnv({ SHADOW_LOOKBACK_DAYS: bad })).map((entry) => entry.variable), ['SHADOW_LOOKBACK_DAYS']);
      }
      const send = ok(validEnv({ WORKER_MODE: 'send', SHADOW_HUBS: 'Bad Hub!', SHADOW_BATCH: 'x', SHADOW_LOOKBACK_DAYS: '0' }));
      assert.deepEqual([send.shadowHubs, send.shadowBatch, send.shadowLookbackDays], [[], 50, 30]);
    });

    it('bounds the batch and checks the build identifier', () => {
      assert.equal(ok(validEnv({ SHADOW_BATCH: '1000' })).shadowBatch, 1_000);
      assert.deepEqual(issues(validEnv({ SHADOW_BATCH: '0' })).map((entry) => entry.variable), ['SHADOW_BATCH']);
      assert.deepEqual(issues(validEnv({ SHADOW_BATCH: '1001' })).map((entry) => entry.variable), ['SHADOW_BATCH']);
      assert.equal(ok(validEnv({ BUILD_SHA: '3f2a9c1-x.y_z' })).buildSha, '3f2a9c1-x.y_z');
      const list = issues(validEnv({ BUILD_SHA: 'bad sha!' }));
      assert.deepEqual(list, [{ variable: 'BUILD_SHA', reason: 'must match ^[A-Za-z0-9._-]{1,64}$' }]);
    });

    it('neither needs nor reads the credentials or the Aruba environment, even with hubs listed or a key present', () => {
      const config = ok(validEnv({ WORKER_HUBS: 'aruba', SHADOW_HUBS: '*', CREDENTIALS_PRIVATE_KEY: 'garbage-not-a-pem', CREDENTIALS_PRIVATE_KEY_ID: 'Bad Id', ARUBA_ENVIRONMENT: 'nonsense' }));
      assert.equal(config.credentials, undefined);
      assert.equal(config.arubaEnvironment, undefined);
      assert.deepEqual(config.workerHubs, ['aruba']);
      assert.equal(ok(validEnv({ CREDENTIALS_PRIVATE_KEY: keys.privatePem, CREDENTIALS_PRIVATE_KEY_ID: 'k-1' })).credentials, undefined);
    });
  });
});
