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
    assert.deepEqual([...config.clusters.keys()], ['cluster0']);
    assert.equal(config.clusters.get('cluster0')?.uri.reveal(), 'mongodb://127.0.0.1:1/?directConnection=true');
    assert.equal(config.clusters.get('cluster0')?.analyticsUri, null);
    assert.equal(config.commonCluster, 'cluster0');
    assert.equal(config.defaultGroupCluster, 'cluster0');
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
    assert.equal(config.legacyPasswordCoexistence, true);
  });

  it('validates LEGACY_PASSWORD_COEXISTENCE', () => {
    assert.equal(loadConfig(validEnv({ LEGACY_PASSWORD_COEXISTENCE: 'false' })).legacyPasswordCoexistence, false);
    assert.equal(loadConfig(validEnv({ LEGACY_PASSWORD_COEXISTENCE: 'true' })).legacyPasswordCoexistence, true);
    assert.equal(loadConfig(validEnv({ LEGACY_PASSWORD_COEXISTENCE: '' })).legacyPasswordCoexistence, true);
    for (const value of ['TRUE', '1', 'yes']) {
      assert.equal(reasonFor(validEnv({ LEGACY_PASSWORD_COEXISTENCE: value }), 'LEGACY_PASSWORD_COEXISTENCE'), 'must be true or false');
    }
  });

  it('applies, reads and validates the rate limit and activity log settings', () => {
    const config = loadConfig(validEnv());
    assert.deepEqual(
      [config.rateLimitLoginPerUsername, config.rateLimitLoginPerIp, config.rateLimitRefreshPerIp, config.rateLimitUsernameCheckPerUser, config.rateLimitApiPerUser],
      [5, 15, 30, 15, 300],
    );
    assert.equal(config.rateLimitUnauthenticatedPerIp, 300);
    assert.deepEqual([config.activityLogRetentionDays, config.activityLogErrorRetentionDays], [365, 90]);
    const custom = loadConfig(
      validEnv({
        RATE_LIMIT_LOGIN_PER_USERNAME: '1',
        RATE_LIMIT_REFRESH_PER_IP: '3',
        RATE_LIMIT_USERNAME_CHECK_PER_USER: '4',
        RATE_LIMIT_USER_CREDENTIALS_PER_USER: '7',
        RATE_LIMIT_CLIENT_ERRORS_PER_USER: '9',
        RATE_LIMIT_API_PER_USER: '100000',
        RATE_LIMIT_UNAUTHENTICATED_PER_IP: '100000',
        ACTIVITY_LOG_RETENTION_DAYS: '3650',
        ACTIVITY_LOG_ERROR_RETENTION_DAYS: '7',
        RATE_LIMIT_LOGIN_PER_IP: '',
      }),
    );
    assert.deepEqual([custom.rateLimitLoginPerUsername, custom.rateLimitLoginPerIp, custom.rateLimitRefreshPerIp, custom.rateLimitUsernameCheckPerUser, custom.rateLimitApiPerUser], [1, 15, 3, 4, 100000]);
    assert.equal(custom.rateLimitUnauthenticatedPerIp, 100000);
    assert.deepEqual([loadConfig(validEnv()).rateLimitClientErrorsPerUser, custom.rateLimitClientErrorsPerUser], [30, 9]);
    assert.deepEqual([loadConfig(validEnv()).rateLimitUserCredentialsPerUser, custom.rateLimitUserCredentialsPerUser], [20, 7]);
    assert.deepEqual([custom.activityLogRetentionDays, custom.activityLogErrorRetentionDays], [3650, 7]);
    for (const [variable, bad] of [
      ['RATE_LIMIT_LOGIN_PER_USERNAME', '0'],
      ['RATE_LIMIT_LOGIN_PER_IP', '100001'],
      ['RATE_LIMIT_REFRESH_PER_IP', 'x'],
      ['RATE_LIMIT_USERNAME_CHECK_PER_USER', '-1'],
      ['RATE_LIMIT_USER_CREDENTIALS_PER_USER', '0'],
      ['RATE_LIMIT_API_PER_USER', '1.5'],
      ['RATE_LIMIT_UNAUTHENTICATED_PER_IP', '0'],
      ['ACTIVITY_LOG_RETENTION_DAYS', '3651'],
      ['ACTIVITY_LOG_ERROR_RETENTION_DAYS', '0'],
    ] as const) {
      assert.match(reasonFor(validEnv({ [variable]: bad }), variable) ?? '', /must be a decimal integer between/);
    }
  });

  it('reads and validates the refresh reuse grace window', () => {
    assert.equal(loadConfig(validEnv()).refreshReuseGraceSeconds, 30);
    assert.equal(loadConfig(validEnv({ REFRESH_REUSE_GRACE_SECONDS: '0' })).refreshReuseGraceSeconds, 0);
    assert.equal(loadConfig(validEnv({ REFRESH_REUSE_GRACE_SECONDS: '300' })).refreshReuseGraceSeconds, 300);
    for (const bad of ['301', '-1', 'x']) {
      assert.match(reasonFor(validEnv({ REFRESH_REUSE_GRACE_SECONDS: bad }), 'REFRESH_REUSE_GRACE_SECONDS') ?? '', /must be a decimal integer between/);
    }
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
    assert.ok(Object.isFrozen(config.clusters.get('cluster0')?.uri));
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
        ['APP_ENV', 'MONGODB_URI', 'PORT', 'TRUST_PROXY', 'LEGACY_PASSWORD_PEPPER', 'VERSION_HMAC_KEY'],
      );
      assert.ok(!error.message.includes('secret-value'));
      assert.match(error.message, /APP_ENV: must be one of: development, production/);
    }
  });

  it('reports missing required variables', () => {
    const issues = issuesOf({});
    assert.deepEqual(
      issues.map((issue) => `${issue.variable}: ${issue.reason}`),
      ['APP_ENV: is required', 'MONGODB_URI: is required', 'LEGACY_PASSWORD_PEPPER: is required', 'VERSION_HMAC_KEY: is required'],
    );
  });

  it('requires the key of the version HMAC: base64 or base64url of at least 32 bytes, never printed', () => {
    const base = validEnv();
    for (const value of [undefined, '']) {
      assert.deepEqual(issuesOf({ ...base, VERSION_HMAC_KEY: value }).map((issue) => issue.reason), ['is required']);
    }
    for (const value of ['short', 'a'.repeat(42), 'not base64 at all!!', Buffer.alloc(31, 1).toString('base64')]) {
      const issues = issuesOf({ ...base, VERSION_HMAC_KEY: value });
      assert.deepEqual(issues.map((issue) => issue.variable), ['VERSION_HMAC_KEY']);
      assert.ok(!JSON.stringify(issues).includes(value));
    }
    const key = Buffer.alloc(32, 7);
    for (const value of [key.toString('base64'), key.toString('base64url')]) {
      const config = loadConfig({ ...base, VERSION_HMAC_KEY: value });
      assert.equal(Buffer.from(config.versionHmacKey.reveal(), 'base64').length, 32);
      assert.ok(!`${config.versionHmacKey}`.includes(value));
    }
  });

  it('validates HOST as an IP address or a hostname and leaves it unset by default', () => {
    assert.equal(loadConfig(validEnv()).host, undefined);
    for (const value of ['127.0.0.1', '::1', 'localhost', 'api.example.com', 'a-b.c1']) {
      assert.equal(loadConfig(validEnv({ HOST: value })).host, value, value);
    }
    for (const value of ['-bad', 'bad-', 'a..b', 'a b', 'host/path', 'host:80', 'a'.repeat(64), `${'a.'.repeat(130)}a`]) {
      assert.match(reasonFor(validEnv({ HOST: value }), 'HOST') ?? '', /IP address or a hostname/, value);
    }
  });

  it('validates PORT', () => {
    for (const value of ['65536', '1e3', '0x10', ' 80', '+80', '-1', '8.5', '9'.repeat(30)]) {
      assert.match(reasonFor(validEnv({ PORT: value }), 'PORT') ?? '', /between 0 and 65535/, value);
    }
    assert.equal(loadConfig(validEnv({ PORT: '65535' })).port, 65535);
    assert.equal(loadConfig(validEnv({ PORT: '1' })).port, 1);
    assert.equal(loadConfig(validEnv({ PORT: '0' })).port, 0, '0 lets the operating system choose the port');
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
      'HOST',
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
    assert.deepEqual(Object.keys(config).sort(), ['appEnv', 'clusters', 'commonCluster', 'dbNamePrefix', 'defaultGroupCluster', 'mongodbMaxPoolSize', 'mongodbServerSelectionTimeoutMs']);
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

describe('multi-cluster configuration', () => {
  const URI0 = 'mongodb://127.0.0.1:1/?directConnection=true';
  const multi = (extra: Record<string, string | undefined> = {}) =>
    validEnv({
      MONGODB_URI: undefined,
      MONGODB_CLUSTERS: 'cluster0,cluster-1',
      MONGODB_URI_CLUSTER0: URI0,
      MONGODB_URI_CLUSTER_1: 'mongodb://127.0.0.1:2/?directConnection=true',
      ...extra,
    });

  it('reads the optional analytics URI in single-cluster mode', () => {
    const config = loadConfig(validEnv({ MONGODB_ANALYTICS_URI: 'mongodb://127.0.0.1:3/?directConnection=true' }));
    assert.equal(config.clusters.get('cluster0')?.analyticsUri?.reveal(), 'mongodb://127.0.0.1:3/?directConnection=true');
    assert.equal(loadConfig(validEnv({ MONGODB_ANALYTICS_URI: '' })).clusters.get('cluster0')?.analyticsUri, null);
  });

  it('reads one URI pair per listed cluster, id upper-cased with dashes as underscores', () => {
    const config = loadConfig(multi({ MONGODB_ANALYTICS_URI_CLUSTER_1: 'mongodb://127.0.0.1:4/?directConnection=true', MONGODB_CLUSTERS: ' cluster0 , cluster-1 ' }));
    assert.deepEqual([...config.clusters.keys()], ['cluster0', 'cluster-1']);
    assert.equal(config.clusters.get('cluster0')?.uri.reveal(), URI0);
    assert.equal(config.clusters.get('cluster0')?.analyticsUri, null);
    assert.equal(config.clusters.get('cluster-1')?.analyticsUri?.reveal(), 'mongodb://127.0.0.1:4/?directConnection=true');
    assert.equal(config.commonCluster, 'cluster0');
    assert.equal(config.defaultGroupCluster, 'cluster0');
    assert.ok(loadDatabaseConfig(multi()).clusters.has('cluster-1'));
  });

  it('defaults the common cluster to the first one and the group default to the common cluster', () => {
    assert.equal(loadConfig(multi({ MONGODB_CLUSTERS: 'zeta,alpha', MONGODB_URI_ZETA: URI0, MONGODB_URI_ALPHA: URI0 })).commonCluster, 'zeta');
    const config = loadConfig(multi({ MONGODB_COMMON_CLUSTER: 'cluster-1' }));
    assert.deepEqual([config.commonCluster, config.defaultGroupCluster], ['cluster-1', 'cluster-1']);
    const split = loadConfig(multi({ MONGODB_DEFAULT_GROUP_CLUSTER: 'cluster-1' }));
    assert.deepEqual([split.commonCluster, split.defaultGroupCluster], ['cluster0', 'cluster-1']);
    assert.equal(loadConfig(multi({ MONGODB_COMMON_CLUSTER: '', MONGODB_DEFAULT_GROUP_CLUSTER: '' })).commonCluster, 'cluster0');
  });

  it('refuses invalid, empty and duplicated ids', () => {
    for (const list of ['Cluster0', '0cluster', 'a_b', 'a b', 'x'.repeat(33), ',', 'a,,b', 'a,']) {
      assert.match(reasonFor(multi({ MONGODB_CLUSTERS: list }), 'MONGODB_CLUSTERS') ?? '', /must match/, list);
    }
    assert.equal(reasonFor(multi({ MONGODB_CLUSTERS: 'cluster0,cluster0' }), 'MONGODB_CLUSTERS'), 'ids must be unique');
    assert.equal(loadConfig(multi({ MONGODB_CLUSTERS: `a${'b'.repeat(31)}`, [`MONGODB_URI_A${'B'.repeat(31)}`]: URI0 })).commonCluster.length, 32);
  });

  it('requires an URI for each cluster and refuses MONGODB_URI together with the list', () => {
    assert.equal(reasonFor(multi({ MONGODB_URI_CLUSTER_1: undefined }), 'MONGODB_URI_CLUSTER_1'), 'is required');
    assert.equal(reasonFor(multi({ MONGODB_URI_CLUSTER_1: 'localhost:27017' }), 'MONGODB_URI_CLUSTER_1'), 'must start with mongodb:// or mongodb+srv://');
    assert.match(reasonFor(multi({ MONGODB_ANALYTICS_URI_CLUSTER0: 'nope' }), 'MONGODB_ANALYTICS_URI_CLUSTER0') ?? '', /mongodb:\/\//);
    assert.match(reasonFor(multi({ MONGODB_URI: URI0 }), 'MONGODB_URI') ?? '', /must not be set together with MONGODB_CLUSTERS/);
    assert.equal(issuesOf(multi({ MONGODB_URI: URI0 })).length, 1);
    assert.doesNotThrow(() => loadConfig(multi({ MONGODB_URI: '' })));
  });

  it('refuses MONGODB_ANALYTICS_URI together with the list, naming the per-cluster variable', () => {
    const reason = reasonFor(multi({ MONGODB_ANALYTICS_URI: URI0 }), 'MONGODB_ANALYTICS_URI') ?? '';
    assert.match(reason, /MONGODB_ANALYTICS_URI_<ID>/);
    assert.ok(!reason.includes('127.0.0.1'));
    assert.doesNotThrow(() => loadConfig(multi({ MONGODB_ANALYTICS_URI: '' })));
  });

  it('allows at most 16 clusters', () => {
    const ids = (count: number): string[] => Array.from({ length: count }, (_, index) => `c${index}`);
    const withIds = (list: string[]) =>
      multi({ MONGODB_CLUSTERS: list.join(','), ...Object.fromEntries(list.map((id) => [`MONGODB_URI_${id.toUpperCase()}`, URI0])) });
    assert.equal(loadConfig(withIds(ids(16))).clusters.size, 16);
    assert.equal(reasonFor(withIds(ids(17)), 'MONGODB_CLUSTERS'), 'at most 16 clusters are allowed');
  });

  it('refuses a common or default cluster that is not in the list', () => {
    assert.match(reasonFor(multi({ MONGODB_COMMON_CLUSTER: 'other' }), 'MONGODB_COMMON_CLUSTER') ?? '', /one of the ids/);
    assert.match(reasonFor(multi({ MONGODB_DEFAULT_GROUP_CLUSTER: 'other' }), 'MONGODB_DEFAULT_GROUP_CLUSTER') ?? '', /one of the ids/);
    const both = issuesOf(multi({ MONGODB_COMMON_CLUSTER: 'other', MONGODB_DEFAULT_GROUP_CLUSTER: 'other' })).map((issue) => issue.variable);
    assert.deepEqual(both, ['MONGODB_COMMON_CLUSTER', 'MONGODB_DEFAULT_GROUP_CLUSTER']);
    assert.deepEqual(issuesOf(multi({ MONGODB_COMMON_CLUSTER: 'other' })).map((issue) => issue.variable), ['MONGODB_COMMON_CLUSTER']);
  });

  it('requires TLS in production for every URI, analytics ones included', () => {
    const secure = 'mongodb+srv://secret-host.example.net';
    const production = (extra: Record<string, string | undefined>) => multi({ APP_ENV: 'production', MONGODB_URI_CLUSTER0: secure, MONGODB_URI_CLUSTER_1: secure, ...extra });
    assert.doesNotThrow(() => loadConfig(production({ MONGODB_ANALYTICS_URI_CLUSTER_1: secure })));
    for (const variable of ['MONGODB_URI_CLUSTER0', 'MONGODB_URI_CLUSTER_1', 'MONGODB_ANALYTICS_URI_CLUSTER0', 'MONGODB_ANALYTICS_URI_CLUSTER_1']) {
      assert.match(reasonFor(production({ [variable]: 'mongodb://host-with-secret/?tls=false' }), variable) ?? '', /must use TLS in production/, variable);
      assert.match(reasonFor(production({ [variable]: `${secure}/?tlsInsecure=true` }), variable) ?? '', /weaken/, variable);
    }
    assert.match(reasonFor(validEnv({ APP_ENV: 'production', MONGODB_ANALYTICS_URI: 'mongodb://host/' }), 'MONGODB_ANALYTICS_URI') ?? '', /TLS/);
  });

  it('never prints a value in an error', () => {
    const env = multi({
      MONGODB_URI_CLUSTER_1: 'http://uri-secret-value',
      MONGODB_ANALYTICS_URI_CLUSTER0: 'http://analytics-secret-value',
      MONGODB_COMMON_CLUSTER: 'common-secret-value',
    });
    try {
      loadConfig(env);
      assert.fail('expected a ConfigError');
    } catch (error) {
      assert.ok(error instanceof ConfigError);
      assert.ok(!error.message.includes('secret-value'));
    }
    const bad = reasonFor(multi({ MONGODB_CLUSTERS: 'Secret-Value' }), 'MONGODB_CLUSTERS') ?? '';
    assert.ok(!bad.includes('Secret-Value'));
  });
});

describe('the settings of the public API (step 9A)', () => {
  it('has the defaults of the decision: 60 requests a minute, 10 000 a day, a write of the usage every 30 seconds, 20 key writes a minute per user', () => {
    const config = loadConfig(validEnv());
    assert.deepEqual([config.publicApiDefaultRateLimitPerMinute, config.publicApiDefaultDailyQuota, config.publicApiUsageFlushSeconds, config.rateLimitApiKeyAdminPerUser], [60, 10_000, 30, 20]);
    assert.deepEqual([config.publicApiDefaultGroupRateLimitPerMinute, config.publicApiDefaultGroupDailyQuota, config.rateLimitUnauthenticatedPublicPerIp], [120, 20_000, 300]);
  });

  it('reads the variables and refuses what is out of the bounds of a key (1 to 6000 a minute, 1 to 10 000 000 a day)', () => {
    const custom = loadConfig(validEnv({ PUBLIC_API_DEFAULT_RATE_LIMIT_PER_MINUTE: '6000', PUBLIC_API_DEFAULT_DAILY_QUOTA: '10000000', PUBLIC_API_USAGE_FLUSH_SECONDS: '3600', RATE_LIMIT_API_KEY_ADMIN_PER_USER: '5', PUBLIC_API_DEFAULT_GROUP_RATE_LIMIT_PER_MINUTE: '6000', PUBLIC_API_DEFAULT_GROUP_DAILY_QUOTA: '10000000', RATE_LIMIT_UNAUTHENTICATED_PUBLIC_PER_IP: '7' }));
    assert.deepEqual([custom.publicApiDefaultGroupRateLimitPerMinute, custom.publicApiDefaultGroupDailyQuota, custom.rateLimitUnauthenticatedPublicPerIp], [6000, 10_000_000, 7]);
    assert.deepEqual([custom.publicApiDefaultRateLimitPerMinute, custom.publicApiDefaultDailyQuota, custom.publicApiUsageFlushSeconds, custom.rateLimitApiKeyAdminPerUser], [6000, 10_000_000, 3600, 5]);
    for (const [variable, bad] of [
      ['PUBLIC_API_DEFAULT_RATE_LIMIT_PER_MINUTE', '0'],
      ['PUBLIC_API_DEFAULT_RATE_LIMIT_PER_MINUTE', '6001'],
      ['PUBLIC_API_DEFAULT_DAILY_QUOTA', '0'],
      ['PUBLIC_API_DEFAULT_DAILY_QUOTA', '10000001'],
      ['PUBLIC_API_USAGE_FLUSH_SECONDS', '0'],
      ['PUBLIC_API_USAGE_FLUSH_SECONDS', '3601'],
      ['RATE_LIMIT_API_KEY_ADMIN_PER_USER', '0'],
      ['PUBLIC_API_DEFAULT_GROUP_RATE_LIMIT_PER_MINUTE', '0'],
      ['PUBLIC_API_DEFAULT_GROUP_RATE_LIMIT_PER_MINUTE', '6001'],
      ['PUBLIC_API_DEFAULT_GROUP_DAILY_QUOTA', '0'],
      ['PUBLIC_API_DEFAULT_GROUP_DAILY_QUOTA', '10000001'],
      ['RATE_LIMIT_UNAUTHENTICATED_PUBLIC_PER_IP', '0'],
      ['PUBLIC_API_DEFAULT_DAILY_QUOTA', 'many'],
    ] as const) {
      assert.throws(() => loadConfig(validEnv({ [variable]: bad })), (error: unknown) => error instanceof ConfigError && error.issues.some((issue) => issue.variable === variable));
    }
  });
});

describe('the rate limit of the countries (step 9-ter)', () => {
  it('allows 30 writes a minute per user by default, reads the variable and refuses what is out of 1 to 100000', () => {
    assert.equal(loadConfig(validEnv()).rateLimitCountriesAdminPerUser, 30);
    assert.equal(loadConfig(validEnv({ RATE_LIMIT_COUNTRIES_ADMIN_PER_USER: '5' })).rateLimitCountriesAdminPerUser, 5);
    for (const bad of ['0', '100001', 'many']) {
      assert.throws(() => loadConfig(validEnv({ RATE_LIMIT_COUNTRIES_ADMIN_PER_USER: bad })), (error: unknown) => error instanceof ConfigError && error.issues.some((issue) => issue.variable === 'RATE_LIMIT_COUNTRIES_ADMIN_PER_USER'));
    }
  });
});

describe('the rate limits of the activations', () => {
  it('allow 30 writes and 5 exports a minute per user by default, read their variables and refuse what is out of 1 to 100000', () => {
    const defaults = loadConfig(validEnv());
    assert.deepEqual([defaults.rateLimitActivationsAdminPerUser, defaults.rateLimitActivationsExportPerUser], [30, 5]);
    const tuned = loadConfig(validEnv({ RATE_LIMIT_ACTIVATIONS_ADMIN_PER_USER: '4', RATE_LIMIT_ACTIVATIONS_EXPORT_PER_USER: '2' }));
    assert.deepEqual([tuned.rateLimitActivationsAdminPerUser, tuned.rateLimitActivationsExportPerUser], [4, 2]);
    for (const variable of ['RATE_LIMIT_ACTIVATIONS_ADMIN_PER_USER', 'RATE_LIMIT_ACTIVATIONS_EXPORT_PER_USER']) {
      for (const bad of ['0', '100001', 'many']) {
        assert.throws(() => loadConfig(validEnv({ [variable]: bad })), (error: unknown) => error instanceof ConfigError && error.issues.some((issue) => issue.variable === variable));
      }
    }
  });
});

describe('the rate limit of the bulk trash operations (step P2)', () => {
  it('allows 30 calls a minute per user by default, reads the variable and refuses what is out of 1 to 100000', () => {
    assert.equal(loadConfig(validEnv()).rateLimitTrashAdminPerUser, 30);
    assert.equal(loadConfig(validEnv({ RATE_LIMIT_TRASH_ADMIN_PER_USER: '5' })).rateLimitTrashAdminPerUser, 5);
    for (const bad of ['0', '100001', 'many']) {
      assert.throws(() => loadConfig(validEnv({ RATE_LIMIT_TRASH_ADMIN_PER_USER: bad })), (error: unknown) => error instanceof ConfigError && error.issues.some((issue) => issue.variable === 'RATE_LIMIT_TRASH_ADMIN_PER_USER'));
    }
  });
});
