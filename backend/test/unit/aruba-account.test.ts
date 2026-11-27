import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { PLATFORM_HUB, arubaAccountOf, hubOf, versionOf, viewOf } from '../../src/modules/einvoicing-accounts/aruba-account.ts';
import type { AccountTarget, ArubaAccount } from '../../src/modules/einvoicing-accounts/aruba-account.ts';

const dealerId = new ObjectId();
const dealer: AccountTarget = { kind: 'dealer', dealerId };
const platform: AccountTarget = { kind: 'platform' };
const key = Buffer.alloc(32, 7);

const account: ArubaAccount = {
  enabled: true,
  username: 'user1',
  password: { v: 2, kid: 'k', epk: 'EPK1', iv: 'IV1', tag: 'TAG', data: 'CIPHERTEXT' },
  maxPerHour: 55,
  maxPerYear: 10_000,
  updatedAt: new Date('2026-11-27T10:00:00.000Z'),
  updatedBy: new ObjectId(),
};

describe('the Aruba account helpers', () => {
  it('names the hub', () => {
    assert.equal(PLATFORM_HUB, 'aruba');
    assert.equal(hubOf(platform), 'aruba');
    assert.equal(hubOf(dealer), `aruba__${dealerId.toHexString()}`);
  });

  it('accepts a well formed stored account (with or without an annual ceiling) and refuses anything else', () => {
    assert.deepEqual(arubaAccountOf(account), account);
    assert.deepEqual(arubaAccountOf({ ...account, maxPerYear: null }), { ...account, maxPerYear: null });
    const bad: unknown[] = [
      undefined,
      null,
      'text',
      {},
      { ...account, enabled: 'yes' },
      { ...account, username: 1 },
      { ...account, password: 'plain' },
      { ...account, password: null },
      { ...account, password: { ...account.password, v: 1 } },
      { ...account, password: { ...account.password, epk: 1 } },
      { ...account, password: { v: 2, kid: 'k', iv: 'IV1', tag: 'TAG', data: 'C' } },
      { ...account, password: { ...account.password, kid: 1 } },
      { ...account, password: { ...account.password, iv: 1 } },
      { ...account, password: { ...account.password, tag: 1 } },
      { ...account, password: { ...account.password, data: 1 } },
      { ...account, maxPerHour: 1.5 },
      { ...account, maxPerYear: 'x' },
      { ...account, maxPerYear: undefined },
      { ...account, updatedAt: '2026-11-27' },
      { ...account, updatedBy: 'x' },
    ];
    for (const value of bad) {
      assert.equal(arubaAccountOf(value), null, JSON.stringify(value));
    }
  });

  it('shows an account without the password, its ciphertext, tag or IV', () => {
    assert.deepEqual(viewOf(dealer, null), { hub: `aruba__${dealerId.toHexString()}`, configured: false });
    const view = viewOf(platform, account);
    assert.deepEqual(view, { hub: 'aruba', configured: true, enabled: true, username: 'user1', passwordSet: true, maxPerHour: 55, maxPerYear: 10_000, updatedAt: '2026-11-27T10:00:00.000Z' });
    assert.equal(JSON.stringify(view).includes('CIPHERTEXT') || JSON.stringify(view).includes('TAG') || JSON.stringify(view).includes('IV1'), false);
  });

  it('signs a version that changes with every visible field, the hub and the password IV, and is 43 base64url characters', () => {
    const base = versionOf(platform, account, key);
    assert.match(base, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(versionOf(platform, { ...account }, key), base);
    const variants: Array<[AccountTarget, ArubaAccount | null, Buffer]> = [
      [dealer, account, key],
      [platform, null, key],
      [dealer, null, key],
      [platform, { ...account, enabled: false }, key],
      [platform, { ...account, username: 'other' }, key],
      [platform, { ...account, maxPerHour: 56 }, key],
      [platform, { ...account, maxPerYear: null }, key],
      [platform, { ...account, password: { ...account.password, iv: 'IV2' } }, key],
      [platform, { ...account, updatedAt: new Date('2026-11-28T10:00:00.000Z') }, key],
      [platform, account, Buffer.alloc(32, 8)],
    ];
    const versions = variants.map(([target, value, secret]) => versionOf(target, value, secret));
    assert.equal(new Set([base, ...versions]).size, variants.length + 1);
    // The ciphertext itself does not enter the version.
    assert.equal(versionOf(platform, { ...account, password: { ...account.password, data: 'OTHER', tag: 'OTHER' } }, key), base);
  });
});
