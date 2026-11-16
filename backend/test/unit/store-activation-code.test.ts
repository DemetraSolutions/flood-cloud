import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVATION_CODE_ALPHABET,
  ACTIVATION_CODE_LENGTH,
  encodeActivationCode,
  generateActivationCode,
  hashActivationCode,
  normalizeActivationCode,
} from '../../src/modules/store-keys/activation-code.ts';

describe('the activation code of a store key', () => {
  it('uses the 32 symbols of Crockford base32, without I, L, O and U', () => {
    assert.equal(ACTIVATION_CODE_ALPHABET.length, 32);
    assert.equal(new Set(ACTIVATION_CODE_ALPHABET).size, 32);
    for (const forbidden of ['I', 'L', 'O', 'U']) {
      assert.ok(!ACTIVATION_CODE_ALPHABET.includes(forbidden));
    }
  });

  it('maps every byte value to a symbol, each symbol exactly eight times: the choice is uniform', () => {
    const counts = new Map<string, number>();
    const all = Uint8Array.from({ length: 256 }, (_, value) => value);
    for (let start = 0; start < 256; start += ACTIVATION_CODE_LENGTH) {
      for (const symbol of encodeActivationCode(all.subarray(start, start + ACTIVATION_CODE_LENGTH))) {
        counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
      }
    }
    assert.equal(counts.size, 32);
    assert.deepEqual([...new Set(counts.values())], [8]);
  });

  it('generates 16 symbols of the alphabet, shown in four groups of four, and a different code every time', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const { normalized, presented } = generateActivationCode();
      assert.match(normalized, /^[0-9A-HJKMNP-TV-Z]{16}$/);
      assert.match(presented, /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
      assert.equal(presented.replaceAll('-', ''), normalized);
      assert.equal(normalizeActivationCode(presented), normalized);
      seen.add(normalized);
    }
    assert.equal(seen.size, 200);
  });

  it('normalizes what a person types: case, dashes and spaces, and the confusable letters', () => {
    const expected = '0123456789ABCDEF';
    assert.equal(normalizeActivationCode('0123-4567-89ab-cdef'), expected);
    assert.equal(normalizeActivationCode(' 0123 4567 89AB CDEF '), expected);
    assert.equal(normalizeActivationCode('o123-4567-89ab-cdef'), expected, 'O is read as 0');
    assert.equal(normalizeActivationCode('0I23-4567-89ab-cdef'), expected, 'I is read as 1');
    assert.equal(normalizeActivationCode('0l23-4567-89ab-cdef'), expected, 'L is read as 1');
  });

  it('refuses everything that is not a code, without throwing: wrong length, wrong symbols, wrong types, too long', () => {
    for (const value of ['', '0123', '0123-4567-89AB-CDE', '0123-4567-89AB-CDEFG', '0123-4567-89AB-CDEU', '0123-4567-89AB-CDE!', 5, null, undefined, {}, ['0123456789ABCDEF'], { $ne: '' }, 'A'.repeat(65)]) {
      assert.equal(normalizeActivationCode(value), null, String(JSON.stringify(value)));
    }
  });

  it('hashes with SHA-256, as hex', () => {
    assert.match(hashActivationCode('0123456789ABCDEF'), /^[0-9a-f]{64}$/);
    assert.notEqual(hashActivationCode('0123456789ABCDEF'), hashActivationCode('0123456789ABCDEG'));
    assert.equal(hashActivationCode('0123456789ABCDEF'), hashActivationCode('0123456789ABCDEF'));
  });
});
