import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, loadConfig } from '../../src/config.ts';
import { validEnv } from '../helpers/app.ts';

function issuesOf(env: Record<string, string | undefined>): Array<{ variable: string; reason: string }> {
  try {
    loadConfig(env);
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    return [...error.issues];
  }
  return assert.fail('expected a ConfigError');
}

function reasonFor(env: Record<string, string | undefined>, variable: string): string | undefined {
  return issuesOf(env).find((issue) => issue.variable === variable)?.reason;
}

describe('loadConfig', () => {
  it('applies the documented defaults', () => {
    const env = validEnv();
    const config = loadConfig(env);
    assert.equal(config.appEnv, 'development');
    assert.equal(config.port, 3000);
    assert.equal(config.mongodbUri.reveal(), 'mongodb://localhost:27017');
    assert.equal(config.dbNamePrefix, '');
    assert.equal(config.trustProxy, 0);
    assert.deepEqual(config.corsAllowedOrigins, []);
    assert.equal(config.accessTokenTtlSeconds, 900);
    assert.equal(config.refreshIdleTtlSeconds, 604800);
    assert.equal(config.sessionMaxTtlSeconds, 2592000);
    assert.equal(config.requestTimeoutMs, 30000);
    assert.equal(config.shutdownDrainMs, 5000);
    assert.equal(config.legacyPasswordPepper.reveal(), env['LEGACY_PASSWORD_PEPPER']);
  });

  it('reads every explicit value', () => {
    const config = loadConfig(
      validEnv({
        APP_ENV: 'production',
        PORT: '8080',
        MONGODB_URI: 'mongodb+srv://cluster.example.net',
        DB_NAME_PREFIX: 'flood_1',
        TRUST_PROXY: '2',
        CORS_ALLOWED_ORIGINS: 'https://a.example.com, https://b.example.com:8443',
        ACCESS_TOKEN_TTL_SECONDS: '60',
        REFRESH_IDLE_TTL_SECONDS: '100',
        SESSION_MAX_TTL_SECONDS: '100',
        REQUEST_TIMEOUT_MS: '1000',
      }),
    );
    assert.equal(config.appEnv, 'production');
    assert.equal(config.port, 8080);
    assert.equal(config.dbNamePrefix, 'flood_1');
    assert.equal(config.trustProxy, 2);
    assert.deepEqual(config.corsAllowedOrigins, ['https://a.example.com', 'https://b.example.com:8443']);
    assert.equal(config.accessTokenTtlSeconds, 60);
    assert.equal(config.requestTimeoutMs, 1000);
  });

  it('is deeply frozen', () => {
    const config = loadConfig(validEnv({ CORS_ALLOWED_ORIGINS: 'https://a.example.com' }));
    assert.ok(Object.isFrozen(config));
    assert.ok(Object.isFrozen(config.corsAllowedOrigins));
    assert.ok(Object.isFrozen(config.mongodbUri));
  });

  it('keeps secrets out of serializations', () => {
    const env = validEnv();
    const text = JSON.stringify(loadConfig(env));
    assert.ok(!text.includes(env['LEGACY_PASSWORD_PEPPER'] as string));
    assert.ok(!text.includes('mongodb://'));
  });

  it('collects every problem and never prints values', () => {
    const env = {
      APP_ENV: 'staging-secret-value',
      PORT: 'port-secret-value',
      MONGODB_URI: 'http://uri-secret-value',
      LEGACY_PASSWORD_PEPPER: ' pepper-secret-value ',
      TRUST_PROXY: '-1',
    };
    try {
      loadConfig(env);
      assert.fail('expected a ConfigError');
    } catch (error) {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.name, 'ConfigError');
      assert.deepEqual(
        error.issues.map((issue) => issue.variable),
        ['APP_ENV', 'PORT', 'MONGODB_URI', 'TRUST_PROXY', 'LEGACY_PASSWORD_PEPPER'],
      );
      assert.ok(!error.message.includes('secret-value'));
      assert.match(error.message, /APP_ENV: must be one of: development, production/);
    }
  });

  it('reports missing required variables', () => {
    const issues = issuesOf({});
    assert.deepEqual(
      issues.map((issue) => `${issue.variable}: ${issue.reason}`),
      ['APP_ENV: is required', 'MONGODB_URI: is required', 'LEGACY_PASSWORD_PEPPER: is required'],
    );
  });

  it('validates PORT', () => {
    for (const value of ['0', '65536', '1e3', '0x10', ' 80', '+80', '-1', '', '8.5', '9'.repeat(30)]) {
      assert.match(reasonFor(validEnv({ PORT: value }), 'PORT') ?? '', /between 1 and 65535/, value);
    }
    assert.equal(loadConfig(validEnv({ PORT: '65535' })).port, 65535);
    assert.equal(loadConfig(validEnv({ PORT: '1' })).port, 1);
  });

  it('validates MONGODB_URI scheme', () => {
    assert.match(reasonFor(validEnv({ MONGODB_URI: 'localhost:27017' }), 'MONGODB_URI') ?? '', /mongodb:\/\//);
  });

  it('validates DB_NAME_PREFIX', () => {
    assert.ok(reasonFor(validEnv({ DB_NAME_PREFIX: 'bad prefix' }), 'DB_NAME_PREFIX'));
    assert.ok(reasonFor(validEnv({ DB_NAME_PREFIX: 'a'.repeat(33) }), 'DB_NAME_PREFIX'));
    assert.equal(loadConfig(validEnv({ DB_NAME_PREFIX: 'a'.repeat(32) })).dbNamePrefix, 'a'.repeat(32));
  });

  it('validates TRUST_PROXY and TTLs', () => {
    assert.match(reasonFor(validEnv({ TRUST_PROXY: 'two' }), 'TRUST_PROXY') ?? '', /between 0 and 5/);
    assert.ok(reasonFor(validEnv({ TRUST_PROXY: '6' }), 'TRUST_PROXY'));
    assert.equal(loadConfig(validEnv({ TRUST_PROXY: '5' })).trustProxy, 5);
    assert.equal(loadConfig(validEnv({ TRUST_PROXY: '0' })).trustProxy, 0);
    for (const name of ['ACCESS_TOKEN_TTL_SECONDS', 'REFRESH_IDLE_TTL_SECONDS', 'SESSION_MAX_TTL_SECONDS']) {
      assert.match(reasonFor(validEnv({ [name]: '0' }), name) ?? '', />= 1/);
    }
  });

  it('requires the session maximum to cover the refresh idle lifetime', () => {
    assert.match(
      reasonFor(validEnv({ REFRESH_IDLE_TTL_SECONDS: '100', SESSION_MAX_TTL_SECONDS: '99' }), 'SESSION_MAX_TTL_SECONDS') ?? '',
      /greater than or equal to REFRESH_IDLE_TTL_SECONDS/,
    );
    // An invalid operand is reported on its own, without a misleading comparison.
    const issues = issuesOf(validEnv({ REFRESH_IDLE_TTL_SECONDS: 'x', SESSION_MAX_TTL_SECONDS: '5' }));
    assert.deepEqual(issues.map((issue) => issue.variable), ['REFRESH_IDLE_TTL_SECONDS']);
    const other = issuesOf(validEnv({ REFRESH_IDLE_TTL_SECONDS: '5', SESSION_MAX_TTL_SECONDS: 'x' }));
    assert.deepEqual(other.map((issue) => issue.variable), ['SESSION_MAX_TTL_SECONDS']);
  });

  it('validates REQUEST_TIMEOUT_MS', () => {
    assert.match(reasonFor(validEnv({ REQUEST_TIMEOUT_MS: '999' }), 'REQUEST_TIMEOUT_MS') ?? '', /between 1000 and 300000/);
    assert.ok(reasonFor(validEnv({ REQUEST_TIMEOUT_MS: '300001' }), 'REQUEST_TIMEOUT_MS'));
  });

  it('validates SHUTDOWN_DRAIN_MS', () => {
    assert.match(reasonFor(validEnv({ SHUTDOWN_DRAIN_MS: '20001' }), 'SHUTDOWN_DRAIN_MS') ?? '', /between 0 and 20000/);
    assert.ok(reasonFor(validEnv({ SHUTDOWN_DRAIN_MS: '-1' }), 'SHUTDOWN_DRAIN_MS'));
    assert.equal(loadConfig(validEnv({ SHUTDOWN_DRAIN_MS: '0' })).shutdownDrainMs, 0);
    assert.equal(loadConfig(validEnv({ SHUTDOWN_DRAIN_MS: '20000' })).shutdownDrainMs, 20000);
  });

  it('validates LEGACY_PASSWORD_PEPPER', () => {
    for (const value of ['', ' x', 'x ', '\tx']) {
      assert.ok(reasonFor(validEnv({ LEGACY_PASSWORD_PEPPER: value }), 'LEGACY_PASSWORD_PEPPER'), JSON.stringify(value));
    }
  });

  describe('CORS_ALLOWED_ORIGINS', () => {
    it('accepts an empty or blank list', () => {
      assert.deepEqual(loadConfig(validEnv({ CORS_ALLOWED_ORIGINS: '  ' })).corsAllowedOrigins, []);
    });

    it('rejects entries that are not plain origins', () => {
      for (const value of ['not a url', 'https://a.example.com/', 'https://a.example.com/path', 'https://a.example.com,', 'https://a.example.com:443', '*']) {
        assert.match(reasonFor(validEnv({ CORS_ALLOWED_ORIGINS: value }), 'CORS_ALLOWED_ORIGINS') ?? '', /must be an origin/, value);
      }
    });

    it('requires https except for loopback in development', () => {
      assert.match(
        reasonFor(validEnv({ CORS_ALLOWED_ORIGINS: 'http://a.example.com' }), 'CORS_ALLOWED_ORIGINS') ?? '',
        /https is required/,
      );
      assert.ok(reasonFor(validEnv({ APP_ENV: 'production', CORS_ALLOWED_ORIGINS: 'http://localhost:4200' }), 'CORS_ALLOWED_ORIGINS'));
      assert.ok(reasonFor(validEnv({ APP_ENV: undefined, CORS_ALLOWED_ORIGINS: 'http://localhost:4200' }), 'CORS_ALLOWED_ORIGINS'));
      assert.ok(reasonFor(validEnv({ CORS_ALLOWED_ORIGINS: 'ftp://localhost' }), 'CORS_ALLOWED_ORIGINS'));
      const config = loadConfig(validEnv({ CORS_ALLOWED_ORIGINS: 'http://localhost:4200,http://127.0.0.1:4200' }));
      assert.deepEqual(config.corsAllowedOrigins, ['http://localhost:4200', 'http://127.0.0.1:4200']);
    });
  });
});
