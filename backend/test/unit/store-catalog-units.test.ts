import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { AppError } from '../../src/shared/http/errors.ts';
import { STORE_PROFILE } from '../../src/shared/security/rbac/policy.ts';
import type { GroupAccess } from '../../src/shared/security/scope/group-access.ts';
import { actorOfCaller, isStoreCaller, languageOfCaller, operatorMetadata } from '../../src/modules/product-catalog/caller.ts';
import type { CatalogCaller, StoreCaller } from '../../src/modules/product-catalog/caller.ts';
import { isForEveryPlace, isWritablePlaces, ownsEveryPlace, perimeterOf, placesWrite, withSoleLocation } from '../../src/modules/product-catalog/availability.ts';
import { createOperatorAudit } from '../../src/modules/store-catalog/store-catalog.audit.ts';
import { toStoreProduct } from '../../src/modules/store-catalog/store-catalog.mapper.ts';
import type { ProductDetail } from '../../src/modules/products/products.service.ts';
import { memoryActivityLog } from '../helpers/activity.ts';
import { fixtureId } from '../helpers/legacy-fixtures.ts';
import { principalOf } from '../helpers/principal.ts';

const GROUP = fixtureId('group', 1);
const PLACE = fixtureId('place', 1);
const OTHER = fixtureId('place', 2);
const KEY = fixtureId('user', 77);
const OPERATOR = fixtureId('user', 5);
const storeCaller = (operator: StoreCaller['operator'] = null, extra: object = {}): StoreCaller & { soleLocation?: true } =>
  Object.freeze({ kind: 'store' as const, keyId: KEY, scope: Object.freeze({ kind: 'store' as const, groupId: GROUP, companyId: fixtureId('company', 1), placeId: PLACE }), operator, ...extra });
const ACCESS = { groupId: GROUP } as unknown as GroupAccess;

describe('the caller of the catalog', () => {
  it('tells a store from a user, names the store as the actor and the operator apart', () => {
    const user = principalOf('PA', { placeIds: [PLACE] });
    assert.deepEqual([isStoreCaller(user), isStoreCaller(storeCaller())], [false, true]);
    assert.deepEqual(actorOfCaller(storeCaller({ id: OPERATOR, language: 'it' })), { kind: 'store', id: KEY });
    assert.deepEqual(actorOfCaller(user), { kind: 'user', id: user.userId, role: 'PA' });
    assert.deepEqual(operatorMetadata(storeCaller({ id: OPERATOR, language: 'it' })), { operatorId: OPERATOR.toHexString() });
    assert.deepEqual(operatorMetadata(storeCaller()), {});
    assert.deepEqual(operatorMetadata(user), {});
  });

  it('reads the language of the operator, else the first of the group for a store, and of the user for a user', async () => {
    const languages = { of: async () => ['fr', 'it'] };
    const users = { findById: async (id: ObjectId) => (id.equals(OPERATOR) ? ({ user: { language: 'de' } } as never) : null) };
    assert.equal(await languageOfCaller({ users, languages }, storeCaller({ id: OPERATOR, language: 'en' }), GROUP), 'en');
    assert.equal(await languageOfCaller({ users, languages }, storeCaller(), GROUP), 'fr');
    assert.equal(await languageOfCaller({ users, languages }, principalOf('PA', { userId: OPERATOR }), GROUP), 'de');
    await assert.rejects(languageOfCaller({ users, languages }, principalOf('PA', { userId: fixtureId('user', 9) }), GROUP), (error: unknown) => error instanceof AppError && error.code === 'NOT_FOUND');
  });
});

describe('the perimeter of a store and the group with one place', () => {
  it('limits a store to the place of its key, like a place administrator, and the roles that are not limited to none', () => {
    assert.deepEqual([...perimeterOf(storeCaller())!], [PLACE.toHexString()]);
    assert.deepEqual([...perimeterOf(principalOf('PA', { placeIds: [PLACE, OTHER] }))!].sort(), [PLACE.toHexString(), OTHER.toHexString()].sort());
    assert.equal(perimeterOf(principalOf('SA')), null);
    assert.equal(perimeterOf(principalOf('PSA')), null);
  });

  it('knows the entries for every place: missing, null or empty', () => {
    assert.deepEqual([undefined, null, []].map(isForEveryPlace), [true, true, true]);
    assert.deepEqual([[PLACE], 'x', 0, {}].map(isForEveryPlace), [false, false, false, false]);
  });

  it('gives the whole of an entry for every place only to a caller marked as the owner of the one place, and never to the roles that are not limited', () => {
    const pa = principalOf('PA', { placeIds: [PLACE] });
    assert.deepEqual([ownsEveryPlace(pa), ownsEveryPlace({ ...pa, soleLocation: true }), ownsEveryPlace({ ...principalOf('SA'), soleLocation: true }), ownsEveryPlace(storeCaller(null, { soleLocation: true }))], [false, true, false, true]);
    assert.equal(isWritablePlaces(pa, []), false);
    assert.equal(isWritablePlaces({ ...pa, soleLocation: true }, []), true);
    assert.equal(isWritablePlaces({ ...pa, soleLocation: true }, [OTHER]), false, 'an entry of another place is not made theirs');
    assert.equal(isWritablePlaces({ ...pa, soleLocation: true }, 'garbage'), false);
    assert.throws(() => placesWrite(pa, undefined, []), (error: unknown) => error instanceof AppError && error.code === 'FORBIDDEN');
    assert.deepEqual(placesWrite({ ...pa, soleLocation: true }, undefined, []).value, []);
  });

  it('marks the caller on every call from a fresh read, only when the one place is in his perimeter, denies on a failed read, and passes everything else through', async () => {
    const reads: string[] = [];
    const errors: string[] = [];
    let found: ObjectId | null | 'fail' = PLACE;
    const places = { soleActivePlaceId: async () => (reads.push('read'), found === 'fail' ? Promise.reject(new Error('down')) : found) };
    const seen: Array<boolean | undefined> = [];
    const service = withSoleLocation({ name: 'service', look: async (caller: CatalogCaller, _access: GroupAccess, extra: string) => (seen.push(caller.soleLocation), extra) }, places, { error: (message: string) => errors.push(message) } as never);
    const pa = principalOf('PA', { placeIds: [PLACE] });
    assert.equal(service.name, 'service');
    assert.equal(await service.look(pa, ACCESS, 'a'), 'a');
    found = null;
    await service.look(pa, ACCESS, 'b');
    found = OTHER;
    await service.look(pa, ACCESS, 'c');
    found = 'fail';
    await service.look(pa, ACCESS, 'd');
    found = PLACE;
    await service.look(storeCaller(), ACCESS, 'e');
    await service.look(principalOf('SA'), ACCESS, 'f');
    assert.deepEqual(seen, [true, undefined, undefined, undefined, true, undefined]);
    assert.equal(reads.length, 5, 'one read for each call of a limited caller, none for the others: nothing is kept');
    assert.equal(errors.length, 1);
  });
});

describe('the audit of the refused operators', () => {
  const store = Object.freeze({ kind: 'store' as const, keyId: KEY, groupId: GROUP, companyId: fixtureId('company', 1), placeId: PLACE, activatedAt: new Date(), permissions: STORE_PROFILE, scope: storeCaller().scope });
  const client = { requestId: 'r-1', ip: null, userAgent: null };

  it('writes the event even when the counter fails, and says so in the log', async () => {
    const activityLog = memoryActivityLog();
    const errors: string[] = [];
    const audit = createOperatorAudit({ activityLog, rateLimiter: { consume: async () => Promise.reject(new Error('down')) }, logger: { error: (message: string) => errors.push(message) } as never });
    await audit.rejected(store, client, 'missing', null);
    assert.equal(activityLog.entries.length, 1);
    assert.deepEqual(activityLog.entries[0]!.metadata, { reason: 'missing' });
    assert.equal(activityLog.entries[0]!.ip, undefined);
    assert.equal(errors.length, 1);
  });

  it('writes it once for a key and an address, with the address and the declared id when there are', async () => {
    const activityLog = memoryActivityLog();
    const seen = new Set<string>();
    const audit = createOperatorAudit({
      activityLog,
      rateLimiter: { consume: async (bucket: string, key: string) => ({ allowed: !seen.has(`${bucket}:${key}`) && (seen.add(`${bucket}:${key}`), true), limit: 1, remaining: 0, resetSeconds: 1, firstExcess: false }) } as never,
      logger: { error: () => undefined } as never,
    });
    await audit.rejected(store, { ...client, ip: '10.0.0.1' }, 'notFound', OPERATOR);
    await audit.rejected(store, { ...client, ip: '10.0.0.1' }, 'notFound', OPERATOR);
    await audit.rejected(store, { ...client, ip: '10.0.0.2' }, 'disabled', OPERATOR);
    assert.equal(activityLog.entries.length, 2);
    assert.deepEqual(activityLog.entries.map((entry) => [entry.ip, entry.metadata]), [['10.0.0.1', { reason: 'notFound', operatorId: OPERATOR.toHexString() }], ['10.0.0.2', { reason: 'disabled', operatorId: OPERATOR.toHexString() }]]);
  });
});

describe('the representation of a product for a store', () => {
  it('drops the costs and the suppliers and keeps of the warnings the field only', () => {
    const detail = {
      id: 'x',
      costs: { last: 1 },
      suppliers: [{ contactId: 'c' }],
      simpleCost: 2,
      name: { it: 'A' },
      warnings: [{ field: 'code', issue: 'duplicate', productIds: ['a', 'b'], others: 3 }],
    } as unknown as ProductDetail;
    assert.deepEqual(toStoreProduct(detail), { id: 'x', name: { it: 'A' }, warnings: [{ field: 'code', issue: 'duplicate' }] });
    assert.deepEqual(toStoreProduct({ ...detail, warnings: undefined } as unknown as ProductDetail), { id: 'x', name: { it: 'A' } });
  });
});
