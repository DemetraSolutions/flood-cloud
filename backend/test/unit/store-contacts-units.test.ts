import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { createStoreContactsAudit } from '../../src/modules/store-contacts/store-contacts.audit.ts';
import { createStoreContactsService } from '../../src/modules/store-contacts/store-contacts.service.ts';
import type { StoreContactsAudit } from '../../src/modules/store-contacts/store-contacts.audit.ts';
import type { StorePrincipal } from '../../src/shared/security/scope/principal.ts';
import { memoryActivityLog, memoryRateLimiter } from '../helpers/activity.ts';
import { memoryLogger } from '../helpers/app.ts';

const KEY = new ObjectId();
const store = { keyId: KEY, groupId: new ObjectId(), companyId: new ObjectId(), placeId: new ObjectId() } as unknown as StorePrincipal;
const operator = { id: new ObjectId(), language: 'it' };
const client = { requestId: 'r1', ip: '10.0.0.1' } as never;
const noAddress = { requestId: 'r2', ip: null } as never;
const limits = { perOperation: 100, perDay: 300 };
const HOUR = 3_600_000;

function audited(now = () => 10 * HOUR, rateLimiter = memoryRateLimiter()) {
  const activityLog = memoryActivityLog();
  const log = memoryLogger();
  return { audit: createStoreContactsAudit({ activityLog, rateLimiter, logger: log.logger, limits, now }), activityLog, log, rateLimiter };
}

describe('the audit of the contacts and loyalty cards of a store', () => {
  it('alerts for a credit above one operation, and once for the day over the daily limit, in cents', async () => {
    const { audit, activityLog } = audited();
    await audit.creditAdded(store, operator, client, 'c1', 0);
    await audit.creditAdded(store, operator, client, 'c1', -5);
    await audit.creditAdded(store, operator, noAddress, 'c1', 100);
    assert.equal(activityLog.entries.length, 0);
    await audit.creditAdded(store, operator, client, 'c1', 100.5);
    await audit.creditAdded(store, operator, client, 'c1', 99.5);
    await audit.creditAdded(store, operator, client, 'c1', 5);
    await audit.creditAdded(store, operator, client, 'c1', 1);
    assert.deepEqual(activityLog.entries.map((entry) => [entry.action, entry.metadata?.['reason'], entry.metadata?.['amount'], entry.ip]), [
      ['store.creditAlert', 'operation', 100.5, '10.0.0.1'],
      ['store.creditAlert', 'daily', 5, '10.0.0.1'],
    ]);
  });

  it('writes an alert without an address when the request has none, and never rejects: a failure is logged', async () => {
    const { audit, activityLog, log } = audited();
    await audit.cardRelinked(store, operator, noAddress, 'k1', 'c1', 2);
    assert.equal('ip' in activityLog.entries[0]!, false);
    assert.deepEqual(activityLog.entries[0]!.metadata, { contactId: 'k1', cardId: 'c1', otherContacts: 2, operatorId: operator.id.toHexString() });
    const broken = { consume: () => Promise.reject(new Error('down')), peek: () => Promise.reject(new Error('down')) };
    const failing = audited(undefined, broken as never);
    await failing.audit.creditAdded(store, operator, client, 'c1', 10);
    await failing.audit.contactsRead(store, client, 3);
    assert.equal(failing.log.events.filter((event) => event['level'] === 'error').length, 2);
    assert.equal(log.events.length, 0);
  });

  it('counts the contacts read by the hour and tells the hours before once, at the first read of an hour', async () => {
    let now = 10 * HOUR + 5;
    const { audit, activityLog } = audited(() => now);
    await audit.contactsRead(store, client, 0);
    await audit.contactsRead(store, client, 4);
    await audit.contactsRead(store, client, 6);
    assert.equal(activityLog.entries.length, 0, 'the first hour tells nothing: nothing was read before');
    now = 11 * HOUR + 1;
    await audit.contactsRead(store, client, 1);
    await audit.contactsRead(store, client, 1);
    assert.deepEqual(activityLog.entries.map((entry) => [entry.action, entry.metadata]), [['store.contactsRead', { count: 10, hour: new Date(11 * HOUR).toISOString() }]]);
    now = 14 * HOUR;
    await audit.contactsRead(store, client, 2);
    assert.deepEqual(activityLog.entries.at(-1)!.metadata?.['count'], 2, 'the hours that were told are not told again: the hour of the first reads only had the 2 of the second');
    assert.equal(activityLog.entries.length, 2);
    now = 60 * HOUR;
    await audit.contactsRead(store, client, 1);
    assert.equal(activityLog.entries.length, 2, 'what is further back than a day is not looked for');
  });
});

describe('the contacts service of a store', () => {
  const caller = { kind: 'store' };
  const noAudit: StoreContactsAudit = { creditAdded: () => Promise.resolve(), cardRelinked: () => Promise.resolve(), contactsRead: () => Promise.resolve() };

  it('does not turn a card that cannot be read after a write into a failure of the write: it is logged', async () => {
    const log = memoryLogger();
    const cardId = new ObjectId().toHexString();
    const result = { entity: { id: 'k1', fidelityCards: [{ code: 'A', points: 0, advanced: { cardId } }, { code: 'B', points: 0, advanced: { cardId: null } }, { code: 'C', points: 0, advanced: null }] }, version: 'v' };
    const service = createStoreContactsService({
      contacts: { create: () => Promise.resolve(result) } as never,
      contactGroups: {} as never,
      cards: { get: () => Promise.reject(new Error('gone')) } as never,
      audit: noAudit,
      logger: log.logger,
    });
    const access = {} as never;
    assert.equal(await service.createContact(store, operator, access, {} as never, client), result);
    assert.equal(log.events.filter((event) => event['level'] === 'error').length, 1);
    void caller;
  });
});
