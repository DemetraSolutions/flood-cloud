import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SECRET_PREFIXES, generateSecret, hashSecret, parseSecret } from '../../src/shared/security/secrets.ts';

describe('secrets', () => {
  it('generates prefix + 43 base64url characters for every prefix', () => {
    for (const prefix of SECRET_PREFIXES) {
      const secret = generateSecret(prefix);
      assert.match(secret, new RegExp(`^${prefix}[A-Za-z0-9_-]{43}$`));
      assert.equal(parseSecret(secret, prefix), secret);
    }
  });

  it('does not collide over 1000 generations', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      seen.add(generateSecret('fc_at_'));
    }
    assert.equal(seen.size, 1000);
  });

  it('rejects wrong prefix, wrong length, bad characters and non-strings without throwing', () => {
    const secret = generateSecret('fc_at_');
    assert.equal(parseSecret(secret, 'fc_rt_'), null);
    assert.equal(parseSecret(secret.slice(0, -1), 'fc_at_'), null);
    assert.equal(parseSecret(`${secret}A`, 'fc_at_'), null);
    assert.equal(parseSecret(`${secret.slice(0, -1)}!`, 'fc_at_'), null);
    assert.equal(parseSecret(`${secret}\n`, 'fc_at_'), null);
    assert.equal(parseSecret('', 'fc_at_'), null);
    assert.equal(parseSecret(undefined, 'fc_at_'), null);
    assert.equal(parseSecret({ toString: () => secret }, 'fc_at_'), null);
  });

  it('hashes with SHA-256 hex (known vector)', () => {
    assert.equal(hashSecret('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.match(hashSecret(generateSecret('fc_pk_')), /^[0-9a-f]{64}$/);
  });

  it('issues and recognizes the store key: fc_sk_ and 43 characters of body, and no other prefix is accepted for it', () => {
    const key = generateSecret('fc_sk_');
    assert.match(key, /^fc_sk_[A-Za-z0-9_-]{43}$/);
    assert.equal(parseSecret(key, 'fc_sk_'), key);
    assert.equal(parseSecret(key, 'fc_at_'), null);
    assert.equal(parseSecret(generateSecret('fc_at_'), 'fc_sk_'), null);
    assert.ok(SECRET_PREFIXES.includes('fc_sk_'));
  });
});
