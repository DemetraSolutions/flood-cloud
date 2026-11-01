import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { Secret } from '../../src/shared/security/secret.ts';

describe('Secret', () => {
  const secret = new Secret('very-sensitive');

  it('reveals the value only explicitly', () => {
    assert.equal(secret.reveal(), 'very-sensitive');
  });

  it('never prints the value', () => {
    assert.equal(String(secret), '[REDACTED]');
    assert.equal(`${secret}`, '[REDACTED]');
    assert.equal(JSON.stringify({ secret }), '{"secret":"[REDACTED]"}');
    assert.equal(inspect(secret), '[REDACTED]');
    assert.equal(inspect({ nested: secret }), '{ nested: [REDACTED] }');
  });

  it('is frozen', () => {
    assert.ok(Object.isFrozen(secret));
  });
});
