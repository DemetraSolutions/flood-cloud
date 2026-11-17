import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { countryVersionOf, toCountry } from '../../src/modules/countries/countries.mapper.ts';
import { readCountryUsage } from '../../src/shared/security/scope/group-mirror.ts';
import { codeVariants } from '../../src/shared/validation/code-variants.ts';
import type { Databases } from '../../src/db/databases.ts';

const key = Buffer.alloc(32, 3);
const id = new ObjectId('050000000000000000000001');

describe('countryVersionOf', () => {
  const base = { _id: id, code: 'IT', name: 'Italia', areas: [{ code: 'MI', name: 'Milano' }] };

  it('follows _id, code, name and areas (every key of an area), and nothing else', () => {
    const version = countryVersionOf(base, key);
    assert.match(version, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(countryVersionOf({ ...base, updateDate: new Date(), insertDate: new Date(), note: 'x' }, key), version);
    for (const changed of [{ code: 'DE' }, { name: 'Italy' }, { areas: [] }, { areas: [{ code: 'MI', name: 'Milano', extra: 1 }] }, { _id: new ObjectId() }]) {
      assert.notEqual(countryVersionOf({ ...base, ...changed }, key), version, JSON.stringify(changed));
    }
    assert.notEqual(countryVersionOf(base, Buffer.alloc(32, 4)), version);
  });

  it('tells an absent field from a null one', () => {
    const { areas: _areas, ...without } = base;
    assert.notEqual(countryVersionOf(without, key), countryVersionOf({ ...without, areas: null }, key));
  });
});

describe('toCountry', () => {
  it('reads the legacy shapes tolerantly, like the list', () => {
    assert.deepEqual(toCountry({ code: 'FR', name: 'Francia', areas: 'none' }), { code: 'FR', name: 'Francia', areas: [] });
  });
});

describe('readCountryUsage', () => {
  it('refuses a code that is not two uppercase letters, an operator among them, and a limit that is not a positive integer, before reading', async () => {
    const databases = {} as Databases;
    for (const [country, area] of [['it', null], ['ITA', null], ['IT', 'mi'], [{ $ne: 'x' } as unknown as string, null], ['IT', { $ne: 'x' } as unknown as string]] as const) {
      await assert.rejects(readCountryUsage(databases, country, area, 20), /two uppercase letters/);
    }
    for (const limit of [0, -1, 1.5]) {
      await assert.rejects(readCountryUsage(databases, 'IT', null, limit), /positive limit/);
    }
  });
});

describe('codeVariants', () => {
  it('lists the four spellings of a code, the upper-case one first', () => {
    assert.deepEqual(codeVariants('IT'), ['IT', 'it', 'It', 'iT']);
  });
});
