import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { ConfigError, loadConfig } from '../../src/config.ts';
import { validEnv } from '../helpers/app.ts';

/** Public keys made here: never a stored key. */
const pem = (publicKey: KeyObject): string => publicKey.export({ type: 'spki', format: 'pem' }).toString();
const x25519 = pem(generateKeyPairSync('x25519').publicKey);

function issuesOf(env: Record<string, string | undefined>): Array<{ variable: string; reason: string }> {
  try {
    loadConfig(env);
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    return error.issues.filter((issue) => issue.variable.startsWith('CREDENTIALS_'));
  }
  return [];
}

describe('the credentials public key configuration', () => {
  it('is off by default, also with empty variables', () => {
    for (const env of [validEnv(), validEnv({ CREDENTIALS_PUBLIC_KEY: '', CREDENTIALS_PUBLIC_KEY_ID: '' })]) {
      const config = loadConfig(env);
      assert.deepEqual([config.credentialsPublicKey, config.credentialsPublicKeyId], [null, null]);
    }
  });

  it('reads an X25519 PEM public key as a key object, also with the line breaks typed as \\n', () => {
    for (const text of [x25519, x25519.trim(), x25519.trim().replaceAll('\n', '\\n')]) {
      const config = loadConfig(validEnv({ CREDENTIALS_PUBLIC_KEY: text, CREDENTIALS_PUBLIC_KEY_ID: 'k-1' }));
      assert.equal(config.credentialsPublicKey?.type, 'public');
      assert.equal(config.credentialsPublicKey?.asymmetricKeyType, 'x25519');
      assert.equal(config.credentialsPublicKey?.export({ type: 'spki', format: 'pem' }).toString(), x25519);
      assert.equal(config.credentialsPublicKeyId, 'k-1');
    }
  });

  it('refuses any other key type, a private key and anything that is not a public key, without echoing the value', () => {
    const private25519 = generateKeyPairSync('x25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    for (const bad of [pem(generateKeyPairSync('ed25519').publicKey), pem(generateKeyPairSync('x448').publicKey), pem(generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey), private25519, 'not a key', 'c2VjcmV0LXNlY3JldC1zZWNyZXQ=']) { // gitleaks:allow (fake test value)
      const issues = issuesOf(validEnv({ CREDENTIALS_PUBLIC_KEY: bad, CREDENTIALS_PUBLIC_KEY_ID: 'k-1' }));
      assert.deepEqual(issues, [{ variable: 'CREDENTIALS_PUBLIC_KEY', reason: 'must be a PEM (SPKI) X25519 public key' }]);
      assert.equal(JSON.stringify(issues).includes(bad.trim()), false);
    }
  });

  it('refuses a malformed key id', () => {
    for (const bad of ['UPPER', 'with space', 'under_score', 'x'.repeat(33), 'é']) {
      assert.deepEqual(issuesOf(validEnv({ CREDENTIALS_PUBLIC_KEY: x25519, CREDENTIALS_PUBLIC_KEY_ID: bad })), [
        { variable: 'CREDENTIALS_PUBLIC_KEY_ID', reason: 'must be 1 to 32 lower case letters, digits or dashes' },
      ]);
    }
    assert.equal(loadConfig(validEnv({ CREDENTIALS_PUBLIC_KEY: x25519, CREDENTIALS_PUBLIC_KEY_ID: 'x'.repeat(32) })).credentialsPublicKeyId, 'x'.repeat(32));
  });

  it('wants the key and its id together', () => {
    assert.deepEqual(issuesOf(validEnv({ CREDENTIALS_PUBLIC_KEY: x25519 })), [{ variable: 'CREDENTIALS_PUBLIC_KEY_ID', reason: 'is required when CREDENTIALS_PUBLIC_KEY is set' }]);
    assert.deepEqual(issuesOf(validEnv({ CREDENTIALS_PUBLIC_KEY_ID: 'k-1' })), [{ variable: 'CREDENTIALS_PUBLIC_KEY', reason: 'is required when CREDENTIALS_PUBLIC_KEY_ID is set' }]);
  });
});
