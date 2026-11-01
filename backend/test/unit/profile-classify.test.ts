import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import {
  classifyPii,
  classifyRef,
  emptyPasswordProfile,
  emptyPiiCounts,
  emptyPinProfile,
  emptyRefProfile,
  lengthBand,
  tallyKind,
  tallyPassword,
  tallyPin,
  tallyRef,
} from '../../src/tools/profile-legacy/classify.ts';
import { indexUnion } from '../../src/tools/profile-legacy/indexes.ts';
import type { IndexInfo } from '../../src/tools/profile-legacy/indexes.ts';

const HEX = '0123456789abcdef01234567';

describe('classifyPii', () => {
  it('tells encrypted, plain, empty, missing and other types apart', () => {
    const encrypted = `${'ab'.repeat(16)}${'cd'.repeat(16)}$${'ef'.repeat(16)}`;
    assert.equal(classifyPii(encrypted), 'encryptedLegacy');
    assert.equal(classifyPii(`${'ab'.repeat(16)}$short`), 'plain');
    assert.equal(classifyPii('mario@example.test'), 'plain');
    assert.equal(classifyPii('   '), 'empty');
    assert.equal(classifyPii(undefined), 'missingOrNull');
    assert.equal(classifyPii(null), 'missingOrNull');
    assert.equal(classifyPii(12), 'otherType');
    assert.deepEqual(emptyPiiCounts(), { encryptedLegacy: 0, plain: 0, empty: 0, missingOrNull: 0, otherType: 0 });
  });
});

describe('password and pin', () => {
  it('bands lengths', () => {
    assert.deepEqual([0, 1, 7, 8, 16, 17, 64, 65].map(lengthBand), ['0', '1-7', '1-7', '8-16', '8-16', '17-64', '17-64', '65+']);
  });

  it('tallies password formats without keeping values', () => {
    const profile = emptyPasswordProfile();
    for (const value of ['a'.repeat(128), 'plain', '', 'b'.repeat(128).toUpperCase(), 5, null, undefined]) {
      tallyPassword(profile, value);
    }
    assert.deepEqual(profile, {
      hmacSha512Hex: 1,
      missingOrNull: 2,
      other: 4,
      otherLengths: { '0': 1, '1-7': 1, '8-16': 0, '17-64': 0, '65+': 1, nonString: 1 },
    });
  });

  it('tallies pin formats', () => {
    const profile = emptyPinProfile();
    for (const value of ['1234', '12345678', '123', '123456789', 1234, null, undefined]) {
      tallyPin(profile, value);
    }
    assert.deepEqual(profile, { missingOrNull: 2, numeric4to8: 2, other: 3 });
  });
});

describe('references', () => {
  it('classifies every kind', () => {
    const id = new ObjectId(HEX);
    assert.deepEqual(classifyRef(id), { kind: 'objectId', hex: HEX });
    assert.deepEqual(classifyRef(HEX.toUpperCase()), { kind: 'hexString', hex: HEX });
    assert.deepEqual(classifyRef('nope'), { kind: 'otherString', hex: null });
    assert.deepEqual(classifyRef(null), { kind: 'null', hex: null });
    assert.deepEqual(classifyRef(undefined), { kind: 'missing', hex: null });
    assert.deepEqual(classifyRef(5), { kind: 'otherType', hex: null });
  });

  it('counts orphans and unverifiable references', () => {
    const profile = emptyRefProfile();
    const existing = new Set([HEX]);
    tallyRef(profile, new ObjectId(HEX), existing);
    tallyRef(profile, '1'.repeat(24), existing);
    tallyRef(profile, new ObjectId(HEX), undefined);
    tallyRef(profile, null, undefined);
    assert.equal(profile.orphans, 1);
    assert.equal(profile.unverifiable, 1);
    assert.deepEqual(profile.kinds, { objectId: 2, hexString: 1, otherString: 0, null: 1, missing: 0, otherType: 0 });
    const kinds = emptyRefProfile().kinds;
    assert.equal(tallyKind(kinds, HEX).hex, HEX);
    assert.equal(kinds.hexString, 1);
  });
});

describe('indexUnion', () => {
  const base: IndexInfo = { name: 'a', key: { a: 1 }, unique: false, sparse: false, expireAfterSeconds: null, hasPartialFilter: false };

  it('counts databases per distinct index and sorts by name then frequency', () => {
    const union = indexUnion();
    union.add([base, { ...base, name: 'b' }]);
    union.add([{ ...base, key: { a: -1 } }, base]);
    union.add([base]);
    assert.deepEqual(
      union.result().map((index) => [index.name, index.key, index.databases]),
      [
        ['a', { a: 1 }, 3],
        ['a', { a: -1 }, 1],
        ['b', { a: 1 }, 1],
      ],
    );
  });
});
