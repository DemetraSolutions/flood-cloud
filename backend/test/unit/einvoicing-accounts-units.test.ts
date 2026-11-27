import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { MongoServerError, ObjectId } from 'mongodb';
import type { Databases } from '../../src/db/databases.ts';
import { arubaAccountOf, versionOf } from '../../src/modules/einvoicing-accounts/aruba-account.ts';
import type { AccountTarget, ArubaAccount } from '../../src/modules/einvoicing-accounts/aruba-account.ts';
import { createEInvoicingAccountsRepository } from '../../src/modules/einvoicing-accounts/einvoicing-accounts.repository.ts';
import type { AccountRead, EInvoicingAccountsRepository } from '../../src/modules/einvoicing-accounts/einvoicing-accounts.repository.ts';
import { createEInvoicingAccountsService } from '../../src/modules/einvoicing-accounts/einvoicing-accounts.service.ts';
import { ACTION_CATALOG } from '../../src/shared/activity-log/catalog.ts';
import { AppError } from '../../src/shared/http/errors.ts';
import { memoryActivityLog } from '../helpers/activity.ts';
import { principalOf } from '../helpers/principal.ts';

const versionKey = randomBytes(32);
const principal = principalOf('PSA');
const client = { requestId: 'req-1', ip: null, userAgent: null };
const target: AccountTarget = { kind: 'dealer', dealerId: new ObjectId() };
const body = { enabled: true, username: 'user', password: 'secret-pw', maxPerHour: 55, maxPerYear: null };

const stored: ArubaAccount = {
  enabled: true,
  username: 'user',
  password: { v: 2, kid: 'k', epk: 'epk', iv: 'iv', tag: 'tag', data: 'data' },
  maxPerHour: 55,
  maxPerYear: null,
  updatedAt: new Date('2026-11-27T10:00:00Z'),
  updatedBy: new ObjectId(),
};

/** A repository that holds one account and lets a test say that a write loses the race. */
function fakeRepository(raw: unknown, wins: { replace: boolean; remove: boolean }): EInvoicingAccountsRepository {
  const read: AccountRead = { raw, exists: true };
  return {
    read: () => Promise.resolve(read),
    replace: () => Promise.resolve(wins.replace),
    remove: () => Promise.resolve(wins.remove),
    isUsernameTaken: () => Promise.resolve(false),
  };
}

const serviceOf = (repository: EInvoicingAccountsRepository, withKey = true) =>
  createEInvoicingAccountsService({ repository, activityLog: memoryActivityLog(), versionKey, credentialsRecipient: withKey ? { key: generateKeyPairSync('x25519').publicKey, id: 'k' } : null, now: () => 0 });

const rejection = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    assert.ok(error instanceof AppError);
    return error.code;
  }
  return 'none';
};

describe('the Aruba accounts service', () => {
  it('answers 503 to a save without the encryption key, before reading anything, and still reads and removes', async () => {
    let reads = 0;
    const repository = { ...fakeRepository(stored, { replace: true, remove: true }), read: () => { reads += 1; return Promise.resolve({ raw: stored, exists: true }); } };
    const service = serviceOf(repository, false);
    assert.equal(await rejection(service.save(principal, target, 'x', body, client)), 'SERVICE_UNAVAILABLE');
    assert.equal(reads, 0);
    const version = versionOf(target, arubaAccountOf(stored), versionKey);
    assert.equal((await service.get(target)).version, version);
    await service.remove(principal, target, version, client);
  });

  it('answers 412 when a save or a removal loses the race after the version matched', async () => {
    const service = serviceOf(fakeRepository(stored, { replace: false, remove: false }));
    const version = versionOf(target, arubaAccountOf(stored), versionKey);
    assert.equal(await rejection(service.save(principal, target, version, { ...body, maxPerHour: 1 }, client)), 'PRECONDITION_FAILED');
    assert.equal(await rejection(service.remove(principal, target, version, client)), 'PRECONDITION_FAILED');
  });

  it('removes a damaged stored value (version of "no account") and answers 404 only when nothing is stored', async () => {
    const damaged = serviceOf(fakeRepository({ enabled: 'yes' }, { replace: true, remove: true }));
    assert.equal(await rejection(damaged.remove(principal, target, 'stale', client)), 'PRECONDITION_FAILED');
    await damaged.remove(principal, target, versionOf(target, null, versionKey), client);
    const empty = serviceOf(fakeRepository(undefined, { replace: true, remove: true }));
    assert.equal(await rejection(empty.remove(principal, target, versionOf(target, null, versionKey), client)), 'NOT_FOUND');
  });

  it('answers 404 for a dealer that is not there', async () => {
    const service = serviceOf({ ...fakeRepository(stored, { replace: true, remove: true }), read: () => Promise.resolve(null) });
    assert.equal(await rejection(service.get(target)), 'NOT_FOUND');
  });
});

describe('the Aruba accounts repository', () => {
  const databasesThrowing = (error: Error): Databases => {
    const collection = () => ({ insertOne: () => Promise.reject(error) });
    return { common: () => ({ collection }) } as unknown as Databases;
  };
  const first: AccountRead = { raw: undefined, exists: false };

  it('turns a duplicate key of the platform document into a lost race and rethrows any other error', async () => {
    const duplicate = new MongoServerError({ message: 'dup', code: 11000 });
    assert.equal(await createEInvoicingAccountsRepository(databasesThrowing(duplicate)).replace({ kind: 'platform' }, first, stored), false);
    const other = new MongoServerError({ message: 'down', code: 91 });
    await assert.rejects(createEInvoicingAccountsRepository(databasesThrowing(other)).replace({ kind: 'platform' }, first, stored), other);
    const plain = new Error('boom');
    await assert.rejects(createEInvoicingAccountsRepository(databasesThrowing(plain)).replace({ kind: 'platform' }, first, stored), plain);
  });
});

describe('the activity catalog of the Aruba accounts', () => {
  it('lists the four data actions, the saves with the names of the fields and the password flag, the removals with nothing', () => {
    for (const action of ['dealer.eInvoicingAccountSaved', 'platform.eInvoicingAccountSaved']) {
      assert.deepEqual(ACTION_CATALOG.get(action), { categories: ['data'], metadataKeys: ['changesTotal', 'changesTruncated', 'fields', 'passwordChanged'] });
    }
    for (const action of ['dealer.eInvoicingAccountRemoved', 'platform.eInvoicingAccountRemoved']) {
      assert.deepEqual(ACTION_CATALOG.get(action)!.categories, ['data']);
      assert.ok(!ACTION_CATALOG.get(action)!.metadataKeys.includes('fields'));
    }
  });
});
