import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, loadConfig } from '../../src/config.ts';
import { REDACTED } from '../../src/shared/security/secret.ts';
import { validEnv } from '../helpers/app.ts';

// Throw-away values: nothing here is a key of any provider.
const GOOGLE = 'test-google-key-0123456789'; // gitleaks:allow (fake test value)
const rsa = (modulusLength: number): string => generateKeyPairSync('rsa', { modulusLength }).publicKey.export({ type: 'spki', format: 'pem' }).toString();
const PEM = rsa(2048);

function reasonFor(env: Record<string, string | undefined>, variable: string): string | undefined {
  try {
    loadConfig(env);
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    return error.issues.find((issue) => issue.variable === variable)?.reason;
  }
  return undefined;
}

describe('the configuration of the providers of the integrations', () => {
  it('has every provider off, the real hosts of Dojo and Google and the version of Dojo by default, also when the variables are empty', () => {
    const empty = { DOJO_BASE_URL: '', DOJO_RESELLER_ID: '', DOJO_SOFTWARE_HOUSE_ID: '', DOJO_API_VERSION: '', SATISPAY_AUTH_BASE_URL: '', SATISPAY_PUBLIC_KEY: '', TSH_AUTH_BASE_URL: '', TSH_API_BASE_URL: '', TSH_TEST_AUTH_BASE_URL: '', TSH_TEST_API_BASE_URL: '', GOOGLE_MAPS_API_KEY: '', GEOCODING_BASE_URL: '', GEOCODING_DAILY_LIMIT: '' };
    for (const env of [validEnv(), validEnv(empty)]) {
      const config = loadConfig(env);
      assert.deepEqual(
        [config.dojoBaseUrl, config.dojoResellerId, config.dojoSoftwareHouseId, config.dojoApiVersion, config.satispayAuthBaseUrl, config.satispayPublicKey, config.tshAuthBaseUrl, config.tshApiBaseUrl, config.tshTestAuthBaseUrl, config.tshTestApiBaseUrl, config.googleMapsApiKey, config.geocodingBaseUrl, config.geocodingDailyLimit],
        ['https://api.dojo.tech', null, null, '2024-02-05', null, null, null, null, null, null, null, 'https://maps.googleapis.com', 2000],
      );
    }
  });

  it('reads the identifiers and the version of Dojo, and refuses the ones that cannot travel in a header or are not a date', () => {
    const config = loadConfig(validEnv({ DOJO_RESELLER_ID: 'Flood Software srl', DOJO_SOFTWARE_HOUSE_ID: 'house_1-a.b', DOJO_API_VERSION: '2025-01-31' }));
    assert.deepEqual([config.dojoResellerId, config.dojoSoftwareHouseId, config.dojoApiVersion], ['Flood Software srl', 'house_1-a.b', '2025-01-31']);
    for (const variable of ['DOJO_RESELLER_ID', 'DOJO_SOFTWARE_HOUSE_ID']) {
      for (const bad of [' leading', 'trailing ', 'new\nline', 'a'.repeat(65), 'é', 'semi;colon']) {
        assert.match(reasonFor(validEnv({ [variable]: bad }), variable) ?? '', /must be 1 to 64 letters/, `${variable} ${bad}`);
      }
      assert.equal(loadConfig(validEnv({ [variable]: 'x' })).dojoResellerId === undefined, false);
    }
    for (const bad of ['2024-2-5', 'latest', '2024-02-05T00:00']) {
      assert.equal(reasonFor(validEnv({ DOJO_API_VERSION: bad }), 'DOJO_API_VERSION'), 'must be a date (YYYY-MM-DD)');
    }
  });

  it('accepts the base URLs of the providers as https URLs, drops the trailing slash and keeps a path, and refuses everything else, naming only the variable', () => {
    const names = ['DOJO_BASE_URL', 'TSH_AUTH_BASE_URL', 'TSH_API_BASE_URL', 'TSH_TEST_AUTH_BASE_URL', 'TSH_TEST_API_BASE_URL', 'GEOCODING_BASE_URL'];
    const fields: Record<string, 'dojoBaseUrl' | 'tshAuthBaseUrl' | 'tshApiBaseUrl' | 'tshTestAuthBaseUrl' | 'tshTestApiBaseUrl' | 'geocodingBaseUrl'> = { DOJO_BASE_URL: 'dojoBaseUrl', TSH_AUTH_BASE_URL: 'tshAuthBaseUrl', TSH_API_BASE_URL: 'tshApiBaseUrl', TSH_TEST_AUTH_BASE_URL: 'tshTestAuthBaseUrl', TSH_TEST_API_BASE_URL: 'tshTestApiBaseUrl', GEOCODING_BASE_URL: 'geocodingBaseUrl' };
    for (const name of names) {
      assert.equal(loadConfig(validEnv({ [name]: 'https://host.example/' }))[fields[name]!], 'https://host.example');
      assert.equal(loadConfig(validEnv({ [name]: 'https://host.example/base//' }))[fields[name]!], 'https://host.example/base');
      assert.equal(loadConfig(validEnv({ [name]: 'http://127.0.0.1:8123' }))[fields[name]!], 'http://127.0.0.1:8123');
      assert.equal(loadConfig(validEnv({ [name]: 'http://localhost:8123/' }))[fields[name]!], 'http://localhost:8123');
      for (const bad of ['http://host.example', 'ftp://host.example', 'host.example', 'https://user:pass@host.example', 'https://host.example?x=1', 'https://host.example#x', 'not a url', 'https://93.184.216.34', 'https://[2001:db8::1]', 'https://[::1]:8443', 'http://127.0.0.1.example.test']) {
        const reason = reasonFor(validEnv({ [name]: bad }), name) ?? '';
        assert.match(reason, /must be an https URL without credentials, query, fragment or IP address/, `${name} ${bad}`);
        assert.ok(!reason.includes(bad));
      }
      assert.match(reasonFor(validEnv({ APP_ENV: 'production', [name]: 'http://127.0.0.1:8123' }), name) ?? '', /must be an https URL/);
    }
  });

  it('accepts for Satispay only the two hosts of its authentication service (production and staging), and http on the loopback in development', () => {
    for (const host of ['https://authservices.satispay.com', 'https://staging.authservices.satispay.com/']) {
      assert.equal(loadConfig(validEnv({ SATISPAY_AUTH_BASE_URL: host })).satispayAuthBaseUrl, host.replace(/\/$/, ''));
    }
    assert.equal(loadConfig(validEnv({ SATISPAY_AUTH_BASE_URL: 'http://127.0.0.1:9001' })).satispayAuthBaseUrl, 'http://127.0.0.1:9001');
    for (const bad of ['https://api.satispay.com', 'https://authservices.satispay.com.evil.example', 'https://evil.example/authservices.satispay.com', 'https://authservices.satispay.com/path', 'https://xauthservices.satispay.com', 'http://authservices.satispay.com', 'https://user@authservices.satispay.com']) {
      assert.match(reasonFor(validEnv({ SATISPAY_AUTH_BASE_URL: bad }), 'SATISPAY_AUTH_BASE_URL') ?? '', /must be an https URL/, bad);
    }
    assert.match(reasonFor(validEnv({ APP_ENV: 'production', SATISPAY_AUTH_BASE_URL: 'http://127.0.0.1:9001' }), 'SATISPAY_AUTH_BASE_URL') ?? '', /must be an https URL/);
  });

  it('reads the public key of Satispay as a PEM RSA key of at least 2048 bits, in its canonical form, also with `\\n` typed on one line', () => {
    const config = loadConfig(validEnv({ SATISPAY_PUBLIC_KEY: PEM }));
    assert.equal(config.satispayPublicKey, PEM);
    assert.equal(loadConfig(validEnv({ SATISPAY_PUBLIC_KEY: PEM.trim().replaceAll('\n', '\\n') })).satispayPublicKey, PEM);
    assert.equal(loadConfig(validEnv({ SATISPAY_PUBLIC_KEY: `  ${PEM}  ` })).satispayPublicKey, PEM);
  });

  it('refuses a public key that is not a key, is a private key, is too small or is not RSA, without echoing it', () => {
    const small = rsa(1024);
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'pem' }).toString();
    for (const bad of ['not a key', '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----', small, ec]) {
      const reason = reasonFor(validEnv({ SATISPAY_PUBLIC_KEY: bad }), 'SATISPAY_PUBLIC_KEY');
      assert.equal(reason, 'must be a PEM RSA public key of at least 2048 bits');
    }
    assert.equal(reasonFor(validEnv({ SATISPAY_PUBLIC_KEY: PEM }), 'SATISPAY_PUBLIC_KEY'), undefined);
  });

  it('reads the key of Google Maps as a secret that never shows, and refuses a short one or one with characters that do not belong in a query', () => {
    const config = loadConfig(validEnv({ GOOGLE_MAPS_API_KEY: GOOGLE }));
    assert.equal(config.googleMapsApiKey?.reveal(), GOOGLE);
    assert.equal(String(config.googleMapsApiKey), REDACTED);
    assert.ok(!`${JSON.stringify(config)}${String(config.googleMapsApiKey)}`.includes(GOOGLE));
    for (const bad of ['short', 'x'.repeat(15), `${'x'.repeat(16)} y`, `${'x'.repeat(16)}&x=1`, 'x'.repeat(129), `${'x'.repeat(16)}é`]) {
      const reason = reasonFor(validEnv({ GOOGLE_MAPS_API_KEY: bad }), 'GOOGLE_MAPS_API_KEY');
      assert.equal(reason, 'must be 16 to 128 letters, digits, dashes or underscores');
    }
  });

  it('reads the daily cap of the geocoding as an integer from 1 to 1000000', () => {
    assert.equal(loadConfig(validEnv({ GEOCODING_DAILY_LIMIT: '1' })).geocodingDailyLimit, 1);
    assert.equal(loadConfig(validEnv({ GEOCODING_DAILY_LIMIT: '1000000' })).geocodingDailyLimit, 1_000_000);
    for (const bad of ['0', '1000001', 'x', '1.5', '-1']) {
      assert.match(reasonFor(validEnv({ GEOCODING_DAILY_LIMIT: bad }), 'GEOCODING_DAILY_LIMIT') ?? '', /must be a decimal integer between 1 and 1000000/, bad);
    }
  });

  it('reports every problem at once', () => {
    try {
      loadConfig(validEnv({ DOJO_BASE_URL: 'http://dojo.example', GOOGLE_MAPS_API_KEY: 'x', SATISPAY_PUBLIC_KEY: 'x' }));
      assert.fail('The configuration was accepted');
    } catch (error) {
      assert.deepEqual((error as ConfigError).issues.map((issue) => issue.variable).sort(), ['DOJO_BASE_URL', 'GOOGLE_MAPS_API_KEY', 'SATISPAY_PUBLIC_KEY']);
    }
  });
});
