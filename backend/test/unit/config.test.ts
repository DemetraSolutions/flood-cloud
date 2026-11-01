import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, loadConfig, loadDatabaseConfig } from '../../src/config.ts';
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
    assert.equal(config.mongodbUri.reveal(), 'mongodb://127.0.0.1:1/?directConnection=true');
    assert.equal(config.dbNamePrefix, '');
    assert.equal(config.mongodbServerSelectionTimeoutMs, 5000);
    assert.equal(config.mongodbMaxPoolSize, 20);
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
        ['APP_ENV', 'MONGODB_URI', 'PORT', 'TRUST_PROXY', 'LEGACY_PASSWORD_PEPPER'],
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
    for (const value of ['0', '65536', '1e3', '0x10', ' 80', '+80', '-1', '8.5', '9'.repeat(30)]) {
      assert.match(reasonFor(validEnv({ PORT: value }), 'PORT') ?? '', /between 1 and 65535/, value);
    }
    assert.equal(loadConfig(validEnv({ PORT: '65535' })).port, 65535);
    assert.equal(loadConfig(validEnv({ PORT: '1' })).port, 1);
  });

  it('validates the MongoDB timeout and pool size', () => {
    const config = loadConfig(validEnv({ MONGODB_SERVER_SELECTION_TIMEOUT_MS: '1000', MONGODB_MAX_POOL_SIZE: '500' }));
    assert.equal(config.mongodbServerSelectionTimeoutMs, 1000);
    assert.equal(config.mongodbMaxPoolSize, 500);
    for (const bad of ['999', '60001', 'abc']) {
      assert.match(reasonFor(validEnv({ MONGODB_SERVER_SELECTION_TIMEOUT_MS: bad }), 'MONGODB_SERVER_SELECTION_TIMEOUT_MS') ?? '', /between 1000 and 60000/);
    }
    for (const bad of ['0', '501', '1.5']) {
      assert.match(reasonFor(validEnv({ MONGODB_MAX_POOL_SIZE: bad }), 'MONGODB_MAX_POOL_SIZE') ?? '', /between 1 and 500/);
    }
  });

  it('requires TLS for MONGODB_URI in production only, without echoing the URI', () => {
    const production = (uri: string) => validEnv({ APP_ENV: 'production', MONGODB_URI: uri });
    for (const ok of [
      'mongodb+srv://user:pw@cluster.example.net/?retryWrites=true',
      'mongodb://user:pw@a.example.net:27017,b.example.net:27017/?tls=true&replicaSet=rs0',
      'mongodb://host/?replicaSet=rs0&tls=true',
      'mongodb://host/?SSL=TRUE',
      'mongodb+srv://user:pw@cluster.example.net/?tls=true&TlsInsecure=false',
    ]) {
      assert.doesNotThrow(() => loadConfig(production(ok)), ok);
    }
    for (const bad of [
      'mongodb://user:pw-secret@host.example.net:27017',
      'mongodb://host/?tls=false',
      'mongodb://host/?replicaSet=rs0',
      'mongodb://host/?tls=true2=1&other=tls',
      'mongodb+srv://user:pw-secret@cluster.example.net/?tls=false',
      'mongodb+srv://user:pw-secret@cluster.example.net/?SSL=false',
      'mongodb://host/?tls=true&ssl=false',
    ]) {
      const issues = issuesOf(production(bad));
      assert.match(issues.find((issue) => issue.variable === 'MONGODB_URI')?.reason ?? '', /must use TLS in production/, bad);
      assert.ok(!JSON.stringify(issues).includes('pw-secret'));
    }
    assert.doesNotThrow(() => loadConfig(validEnv({ MONGODB_URI: 'mongodb://host/?tls=false' })));
  });

  it('refuses options that weaken TLS in production, whatever the case of the name', () => {
    for (const option of [
      'tlsInsecure',
      'TLSALLOWINVALIDCERTIFICATES',
      'tlsAllowInvalidHostnames',
      'tlsDisableOCSPEndpointCheck',
      'tlsDisableCertificateRevocationCheck',
    ]) {
      for (const base of ['mongodb+srv://u:pw-secret@c.example.net/', 'mongodb://u:pw-secret@h.example.net/?tls=true&']) {
        const env = validEnv({ APP_ENV: 'production', MONGODB_URI: `${base}${base.includes('?') ? '' : '?'}${option}=TRUE` });
        const issues = issuesOf(env);
        assert.match(issues.find((issue) => issue.variable === 'MONGODB_URI')?.reason ?? '', /weaken certificate/, option);
        assert.ok(!JSON.stringify(issues).includes('pw-secret'));
      }
    }
    assert.doesNotThrow(() => loadConfig(validEnv({ MONGODB_URI: 'mongodb://h/?tlsInsecure=true' })));
  });

  it('validates MONGODB_URI scheme', () => {
    assert.match(reasonFor(validEnv({ MONGODB_URI: 'localhost:27017' }), 'MONGODB_URI') ?? '', /mongodb:\/\//);
  });

  it('validates DB_NAME_PREFIX', () => {
    assert.ok(reasonFor(validEnv({ DB_NAME_PREFIX: 'bad prefix' }), 'DB_NAME_PREFIX'));
    assert.ok(reasonFor(validEnv({ DB_NAME_PREFIX: 'a'.repeat(28) }), 'DB_NAME_PREFIX'));
    assert.equal(loadConfig(validEnv({ DB_NAME_PREFIX: 'a'.repeat(27) })).dbNamePrefix, 'a'.repeat(27));
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

describe('empty values', () => {
  it('treat an optional variable as unset, as copied from .env.example', () => {
    const optional = [
      'PORT',
      'MONGODB_SERVER_SELECTION_TIMEOUT_MS',
      'MONGODB_MAX_POOL_SIZE',
      'DB_NAME_PREFIX',
      'TRUST_PROXY',
      'CORS_ALLOWED_ORIGINS',
      'ACCESS_TOKEN_TTL_SECONDS',
      'REFRESH_IDLE_TTL_SECONDS',
      'SESSION_MAX_TTL_SECONDS',
      'SHUTDOWN_DRAIN_MS',
      'REQUEST_TIMEOUT_MS',
    ];
    const emptied = loadConfig(validEnv(Object.fromEntries(optional.map((name) => [name, '']))));
    assert.deepEqual(JSON.parse(JSON.stringify(emptied)), JSON.parse(JSON.stringify(loadConfig(validEnv()))));
    assert.equal(emptied.port, 3000);
  });

  it('stay an error for the required variables', () => {
    assert.ok(reasonFor(validEnv({ APP_ENV: '' }), 'APP_ENV'));
    assert.ok(reasonFor(validEnv({ MONGODB_URI: '' }), 'MONGODB_URI'));
    assert.ok(reasonFor(validEnv({ LEGACY_PASSWORD_PEPPER: '' }), 'LEGACY_PASSWORD_PEPPER'));
  });
});

describe('loadDatabaseConfig', () => {
  it('validates only the database variables, without the secrets it does not use', () => {
    const config = loadDatabaseConfig({ APP_ENV: 'development', MONGODB_URI: 'mongodb://127.0.0.1:1/?directConnection=true', DB_NAME_PREFIX: 'p_' });
    assert.deepEqual(Object.keys(config).sort(), ['appEnv', 'dbNamePrefix', 'mongodbMaxPoolSize', 'mongodbServerSelectionTimeoutMs', 'mongodbUri']);
    assert.equal(config.dbNamePrefix, 'p_');
    assert.equal(config.mongodbMaxPoolSize, 20);
  });

  it('applies the same rules as loadConfig, TLS in production included', () => {
    const issues = (env: Record<string, string | undefined>) => {
      try {
        loadDatabaseConfig(env);
      } catch (error) {
        return (error as ConfigError).issues.map((issue) => issue.variable);
      }
      return [];
    };
    assert.deepEqual(issues({}), ['APP_ENV', 'MONGODB_URI']);
    assert.deepEqual(issues({ APP_ENV: 'production', MONGODB_URI: 'mongodb://host/' }), ['MONGODB_URI']);
    assert.deepEqual(issues({ APP_ENV: 'development', MONGODB_URI: 'mongodb://h/', DB_NAME_PREFIX: 'bad prefix', MONGODB_MAX_POOL_SIZE: '0' }), [
      'MONGODB_MAX_POOL_SIZE',
      'DB_NAME_PREFIX',
    ]);
  });
});
