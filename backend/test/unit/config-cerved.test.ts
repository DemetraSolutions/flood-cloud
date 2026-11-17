import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, loadConfig } from '../../src/config.ts';
import { REDACTED } from '../../src/shared/security/secret.ts';
import { validEnv } from '../helpers/app.ts';

// Throw-away values: nothing here is a key of any provider.
const KEY = 'test-key-0123456789abcdef'; // gitleaks:allow (fake test value)

function reasonFor(env: Record<string, string | undefined>, variable: string): string | undefined {
  try {
    loadConfig(env);
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    return error.issues.find((issue) => issue.variable === variable)?.reason;
  }
  return undefined;
}

describe('the Cerved configuration', () => {
  it('has no key and the real base URL by default, and 10 lookups a minute', () => {
    for (const env of [validEnv(), validEnv({ CERVED_API_KEY: '', CERVED_BASE_URL: '', RATE_LIMIT_CERVED_LOOKUP_PER_USER: '' })]) {
      const config = loadConfig(env);
      assert.deepEqual([config.cervedApiKey, config.cervedBaseUrl, config.rateLimitCervedLookupPerUser], [null, 'https://api.cerved.com', 10]);
    }
  });

  it('reads the key as a secret that never shows in a string or in JSON', () => {
    const config = loadConfig(validEnv({ CERVED_API_KEY: KEY }));
    assert.equal(config.cervedApiKey?.reveal(), KEY);
    assert.equal(`${String(config.cervedApiKey)}${JSON.stringify(config)}`.includes(KEY), false);
    assert.equal(String(config.cervedApiKey), REDACTED);
    assert.equal(loadConfig(validEnv({ CERVED_API_KEY: 'x'.repeat(16) })).cervedApiKey?.reveal(), 'x'.repeat(16));
  });

  it('refuses a key that is too short, has a space or a control character, or is too long, without echoing it', () => {
    for (const bad of ['short', 'x'.repeat(15), `${'x'.repeat(16)} y`, ` ${'x'.repeat(16)}`, `${'x'.repeat(16)}\n`, `${'x'.repeat(16)}é`, 'x'.repeat(513)]) {
      assert.equal(reasonFor(validEnv({ CERVED_API_KEY: bad }), 'CERVED_API_KEY'), 'must be at least 16 printable characters without spaces');
      try {
        loadConfig(validEnv({ CERVED_API_KEY: bad }));
      } catch (error) {
        assert.equal(JSON.stringify((error as ConfigError).issues).includes(bad.trim() === '' ? 'never' : 'xxxxxxxx'), false);
      }
    }
  });

  it('accepts an https base URL, drops the trailing slash and keeps a path, and accepts http only for the loopback', () => {
    assert.equal(loadConfig(validEnv({ CERVED_BASE_URL: 'https://api.example.test/' })).cervedBaseUrl, 'https://api.example.test');
    assert.equal(loadConfig(validEnv({ CERVED_BASE_URL: 'https://gateway.example.test/cerved//' })).cervedBaseUrl, 'https://gateway.example.test/cerved');
    assert.equal(loadConfig(validEnv({ CERVED_BASE_URL: 'http://127.0.0.1:8123' })).cervedBaseUrl, 'http://127.0.0.1:8123');
    assert.equal(loadConfig(validEnv({ CERVED_BASE_URL: 'http://localhost:8123/' })).cervedBaseUrl, 'http://localhost:8123');
  });

  it('refuses a base URL that is not https (or loopback http), has credentials, a query or a fragment, or is not a URL', () => {
    for (const bad of ['http://api.cerved.com', 'http://127.0.0.1.example.test', 'ftp://api.cerved.com', 'api.cerved.com', 'https://user:pass@api.cerved.com', 'https://api.cerved.com?x=1', 'https://api.cerved.com#x', 'not a url']) {
      assert.match(reasonFor(validEnv({ CERVED_BASE_URL: bad }), 'CERVED_BASE_URL') ?? '', /must be an https URL/, bad);
    }
  });

  it('accepts http on the loopback only in development', () => {
    assert.match(reasonFor(validEnv({ APP_ENV: 'production', CERVED_BASE_URL: 'http://127.0.0.1:8123' }), 'CERVED_BASE_URL') ?? '', /must be an https URL/);
    assert.equal(reasonFor(validEnv({ APP_ENV: 'production', CERVED_BASE_URL: 'https://api.cerved.com' }), 'CERVED_BASE_URL'), undefined);
  });

  it('reads the daily cap as an integer from 1 to 1000000, 200 by default', () => {
    assert.equal(loadConfig(validEnv()).rateLimitCervedLookupPerUserDaily, 200);
    assert.equal(loadConfig(validEnv({ RATE_LIMIT_CERVED_LOOKUP_PER_USER_DAILY: '1000000' })).rateLimitCervedLookupPerUserDaily, 1_000_000);
    for (const bad of ['0', '1000001', 'x']) {
      assert.match(reasonFor(validEnv({ RATE_LIMIT_CERVED_LOOKUP_PER_USER_DAILY: bad }), 'RATE_LIMIT_CERVED_LOOKUP_PER_USER_DAILY') ?? '', /must be a decimal integer between 1 and 1000000/);
    }
  });

  it('reads the rate limit as an integer from 1 to 100000', () => {
    assert.equal(loadConfig(validEnv({ RATE_LIMIT_CERVED_LOOKUP_PER_USER: '100000' })).rateLimitCervedLookupPerUser, 100000);
    for (const bad of ['0', '100001', 'x', '1.5']) {
      assert.match(reasonFor(validEnv({ RATE_LIMIT_CERVED_LOOKUP_PER_USER: bad }), 'RATE_LIMIT_CERVED_LOOKUP_PER_USER') ?? '', /must be a decimal integer between 1 and 100000/);
    }
  });
});
