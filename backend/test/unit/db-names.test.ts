import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { commonDatabaseName, groupDatabaseName, parseGroupDatabaseName } from '../../src/db/names.ts';
import { assertAllowedDatabaseName } from '../../src/db/databases.ts';

const HEX = '0123456789abcdef01234567';
const ctx = { prefix: '', appEnv: 'development' } as const;
const prefixed = { prefix: 'my.pre-', appEnv: 'production' } as const;

describe('db names', () => {
  it('builds the common and group names', () => {
    assert.equal(commonDatabaseName(ctx), 'development_common');
    assert.equal(commonDatabaseName(prefixed), 'my.pre-production_common');
    assert.equal(groupDatabaseName(ctx, new ObjectId(HEX)), `development_${HEX}`);
    assert.equal(groupDatabaseName(prefixed, HEX), `my.pre-production_${HEX}`);
  });

  it('rejects a textual group id that is not 24 lowercase hex characters', () => {
    for (const bad of ['', 'abc', HEX.toUpperCase(), `${HEX}0`, `${HEX.slice(1)}g`, `x_${HEX}`, '../common']) {
      assert.throws(() => groupDatabaseName(ctx, bad), /Invalid group id/);
    }
  });

  it('parses a group database name back to its id', () => {
    assert.equal(parseGroupDatabaseName(ctx, `development_${HEX}`)?.toHexString(), HEX);
    assert.equal(parseGroupDatabaseName(prefixed, `my.pre-production_${HEX}`)?.toHexString(), HEX);
    assert.equal(parseGroupDatabaseName(ctx, 'development_common'), null);
    assert.equal(parseGroupDatabaseName(ctx, `production_${HEX}`), null);
    assert.equal(parseGroupDatabaseName(ctx, `development_${HEX.toUpperCase()}`), null);
    assert.equal(parseGroupDatabaseName(ctx, `development_${HEX}0`), null);
  });
});

describe('assertAllowedDatabaseName', () => {
  it('accepts exactly this environment', () => {
    assertAllowedDatabaseName('development_common', ctx);
    assertAllowedDatabaseName(`development_${HEX}`, ctx);
    assertAllowedDatabaseName('my.pre-production_common', prefixed);
  });

  it('refuses other environments, prefixes, and malformed names', () => {
    for (const name of [
      'production_common',
      `production_${HEX}`,
      'development_flite_common',
      'development_queue',
      'development_COMMON',
      `development_${HEX}x`,
      'xdevelopment_common',
      'admin',
      'local',
      'myXpre-production_common',
    ]) {
      const context = name.startsWith('myX') ? prefixed : ctx;
      assert.throws(() => assertAllowedDatabaseName(name, context), /not allowed in environment/, name);
    }
  });

  it('refuses names longer than 63 bytes and accepts exactly 63', () => {
    const longest = { prefix: 'a'.repeat(27), appEnv: 'development' } as const;
    const name = groupDatabaseName(longest, HEX);
    assert.equal(Buffer.byteLength(name), 63);
    assertAllowedDatabaseName(name, longest);
    const tooLong = { prefix: 'a'.repeat(28), appEnv: 'development' } as const;
    assert.throws(() => assertAllowedDatabaseName(groupDatabaseName(tooLong, HEX), tooLong), /not allowed/);
  });

  it('escapes regex metacharacters of the prefix', () => {
    assert.throws(() => assertAllowedDatabaseName('myXpre-production_common', prefixed), /not allowed/);
  });
});
