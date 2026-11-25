import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { groupCallerOf } from '../../src/modules/public-catalog/public-catalog.caller.ts';
import { toPublicCardRow, toPublicMovement } from '../../src/modules/public-fidelity-cards/public-fidelity-cards.mapper.ts';
import { toPublicContact } from '../../src/modules/public-contacts/public-contacts.mapper.ts';
import { contactVersion } from '../../src/modules/contacts/contacts.document.ts';
import { AppError } from '../../src/shared/http/errors.ts';
import { contactView } from '../../src/modules/contacts/contacts.mapper.ts';
import { createContactsService } from '../../src/modules/contacts/contacts.service.ts';
import type { ContactsCaller } from '../../src/modules/contacts/contacts.service.ts';
import { frozenSet } from '../../src/shared/security/frozen.ts';
import type { GroupAccess } from '../../src/shared/security/scope/group-access.ts';
import type { ApiKeyPrincipal } from '../../src/shared/security/scope/principal.ts';
import { memoryActivityLog, memoryRateLimiter } from '../helpers/activity.ts';
import { legacyContact } from '../helpers/contacts.ts';
import { fixtureId } from '../helpers/legacy-fixtures.ts';

const GROUP = fixtureId('group', 1);
const KEY = fixtureId('user', 5);

describe('the caller of a public key for the contacts and the cards', () => {
  it('has the scope of the whole group, whatever the restrictions of the key, and carries what the key may do', () => {
    const permissions = frozenSet(['contacts:read' as const]);
    const principal = { kind: 'apiKey', keyId: KEY, groupId: GROUP, prefix: 'fc_pk_AbCdEf', permissions, restrictions: { companyIds: [fixtureId('company', 1)], placeIds: [fixtureId('place', 1)] } } as unknown as ApiKeyPrincipal;
    const caller = groupCallerOf(principal);
    assert.deepEqual([caller.kind, caller.keyId, caller.prefix, caller.scope.kind, caller.scope.groupId, caller.permissions], ['apiKey', KEY, 'fc_pk_AbCdEf', 'group', GROUP, permissions]);
    assert.ok(Object.isFrozen(caller) && Object.isFrozen(caller.scope));
  });
});

describe('the public representation of the contacts and of the cards', () => {
  it('tells a card of a contact that is advanced with a type that is gone, and a simple one', () => {
    const view = contactView(legacyContact({ fidelities: [{ code: 'A', points: 1 }, { code: 'B', points: 0 }] }), { services: false }, new Map([['B', { cardId: 'card-1', cardType: null, enabled: false, balance: null, totalPoints: 0 }]]));
    assert.deepEqual(toPublicContact(view).fidelityCards, [{ code: 'A', advanced: false, points: 1 }, { code: 'B', advanced: true, card: { cardId: 'card-1', cardType: null, enabled: false, balance: null, totalPoints: 0 } }]);
  });

  it('shows a row of the list of cards whose type is gone, and a movement of a collection', () => {
    const row = { id: 'c', code: 'X', cardType: null, enabled: true, balance: null, totalPoints: 0, contact: null, contactsCount: 0, createdAt: null };
    assert.deepEqual(toPublicCardRow(row, false), { id: 'c', code: 'X', cardType: null, enabled: true, balance: null, totalPoints: 0, contactsCount: 0, createdAt: null });
    assert.deepEqual(toPublicMovement({ id: 'm', date: null, type: null, balance: null, points: 3, collection: { id: 'k', name: 'Raccolta' }, operator: { kind: 'user', id: 'u1', name: 'Anna' } }), { id: 'm', date: null, type: null, balance: null, points: 3, collection: { id: 'k', name: 'Raccolta' }, operator: { kind: 'user', name: 'Anna' } });
    assert.deepEqual(toPublicMovement({ id: 'm', date: null, type: null, balance: null, points: 3, collection: null, operator: { kind: 'apiKey', id: 'k1', name: 'Webshop' } }).operator, { kind: 'apiKey', name: 'Webshop' });
  });
});

describe('the contacts service for a caller that holds no permission', () => {
  it('says only that a code is an advanced card to a key whose caller carries no permissions at all', async () => {
    const document = legacyContact({ fidelities: [{ code: 'ADV', points: 0 }] });
    const repository = {
      listFull: async () => ({ items: [document] as Document[], page: { limit: 1, next: null } }),
      advancedCards: async () => [{ code: 'ADV', _id: new ObjectId() }],
    };
    const service = createContactsService({ repository: repository as never, catalogs: { list: async () => assert.fail('the catalogs are not read') }, findCountry: async () => null, activityLog: memoryActivityLog(), rateLimiter: memoryRateLimiter(), deleteRule: { bucket: 'b', limit: 1, windowSeconds: 1, key: () => null }, versionKey: Buffer.alloc(32, 1), now: () => 0 });
    const caller: ContactsCaller = Object.freeze({ kind: 'apiKey', keyId: KEY, prefix: 'fc_pk_AbCdEf', scope: Object.freeze({ kind: 'group', groupId: GROUP }) });
    const { items } = await service.listChanges(caller, { groupId: GROUP, features: { services: false } } as unknown as GroupAccess, {});
    assert.deepEqual(items[0]!.fidelityCards, [{ code: 'ADV', points: 0, advanced: { cardId: null, cardType: null, enabled: null, balance: null, totalPoints: null } }]);
  });
});

describe('the contacts service and the codes of the advanced cards', () => {
  it('refuses a key whose caller carries no permissions at all the code of an advanced card, and lets it a simple one', async () => {
    const document = legacyContact({ fidelities: [] });
    const key = Buffer.alloc(32, 1);
    const repository = {
      findById: async () => document,
      accountTaken: async () => ({ email: false, phone: false }),
      isAdvancedCard: async (_p: unknown, _a: unknown, codes: string[]) => codes.includes('ADV'),
    };
    const service = createContactsService({ repository: repository as never, catalogs: { list: async () => [] }, findCountry: async () => null, activityLog: memoryActivityLog(), rateLimiter: memoryRateLimiter(), deleteRule: { bucket: 'b', limit: 1, windowSeconds: 1, key: () => null }, versionKey: key, now: () => 0 });
    const caller: ContactsCaller = Object.freeze({ kind: 'apiKey', keyId: KEY, prefix: 'fc_pk_AbCdEf', scope: Object.freeze({ kind: 'group', groupId: GROUP }) });
    const access = { groupId: GROUP, features: { services: false } } as unknown as GroupAccess;
    const version = contactVersion(document, key);
    await assert.rejects(service.update(caller, access, document['_id'] as ObjectId, version, { fidelityCards: [{ code: 'ADV' }] }, { requestId: 'r', ip: null, userAgent: null }), (error: unknown) => error instanceof AppError && error.code === 'FORBIDDEN');
  });
});
