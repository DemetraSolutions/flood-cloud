import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import type { Request, Response } from 'express';
import { responseActorOf } from '../../src/shared/activity-log/actor.ts';
import { AppError } from '../../src/shared/http/errors.ts';
import { requireApiKeyGroupAccess } from '../../src/shared/security/scope/group-access.ts';
import type { GroupAccess } from '../../src/shared/security/scope/group-access.ts';
import type { ApiKeyPrincipal } from '../../src/shared/security/scope/principal.ts';
import { actorOfCaller, isApiKeyCaller, languageOfCaller, operatorMetadata } from '../../src/modules/product-catalog/caller.ts';
import type { ApiKeyCaller } from '../../src/modules/product-catalog/caller.ts';
import { centsOf, toPublicStock } from '../../src/modules/public-catalog/public-catalog.mapper.ts';
import type { ProductSource } from '../../src/modules/public-catalog/public-catalog.mapper.ts';
import { createRateLimitAudit } from '../../src/shared/activity-log/rate-limit-audit.ts';
import { createErrorActivityReporter } from '../../src/shared/http/error-activity.ts';
import { preserveCategory, preserveProduct, withHiddenIds } from '../../src/modules/public-catalog/public-catalog.preserve.ts';
import { memoryActivityLog } from '../helpers/activity.ts';
import { memoryLogger } from '../helpers/app.ts';
import { fixtureId } from '../helpers/legacy-fixtures.ts';

const GROUP = fixtureId('group', 1);
const KEY = fixtureId('user', 5);
const principal = (): ApiKeyPrincipal => ({ kind: 'apiKey', keyId: KEY, groupId: GROUP }) as ApiKeyPrincipal;
const caller: ApiKeyCaller = Object.freeze({ kind: 'apiKey', keyId: KEY, prefix: 'fc_pk_AbCdEf', scope: Object.freeze({ kind: 'group', groupId: GROUP }) });

describe('the group access of a public API key', () => {
  const found = { availability: 'available' as const, group: { _id: GROUP } };
  const run = async (key: ApiKeyPrincipal | undefined, access: { availability: 'available' | 'unavailable'; group: { _id: ObjectId } } | null) => {
    const handler = requireApiKeyGroupAccess({ findAccess: async () => access, resolveCluster: () => 'cluster0' });
    const res = { locals: { apiKey: key } } as unknown as Response;
    let nexted = false;
    await handler({} as Request, res, () => void (nexted = true));
    return { res, nexted };
  };

  it('issues the access to the group of the key, and only to it', async () => {
    const { res, nexted } = await run(principal(), found);
    assert.ok(nexted && (res.locals.groupAccess as GroupAccess).groupId.equals(GROUP));
  });

  it('is 401 without a key principal and 404 when the group is no longer reachable', async () => {
    await assert.rejects(run(undefined, found), (error: unknown) => error instanceof AppError && error.code === 'UNAUTHENTICATED');
    await assert.rejects(run(principal(), null), (error: unknown) => error instanceof AppError && error.code === 'NOT_FOUND');
    await assert.rejects(run(principal(), { availability: 'unavailable', group: { _id: GROUP } }), (error: unknown) => error instanceof AppError && error.code === 'NOT_FOUND');
  });
});

describe('the public API key as a caller of the catalog', () => {
  it('is recognized, is the actor with its id and shows its indicator, never an operator', async () => {
    assert.equal(isApiKeyCaller(caller), true);
    assert.deepEqual(actorOfCaller(caller), { kind: 'apiKey', id: KEY });
    assert.deepEqual(operatorMetadata(caller), { keyHint: 'AbCdEf' });
    const language = await languageOfCaller({ users: { findById: async () => assert.fail('a key has no user') }, languages: { of: async () => ['fr', 'it'] } }, caller, GROUP);
    assert.equal(language, 'fr', 'the first language of the group');
  });

  it('is the actor of the requests that a response belongs to, before a store or a user', () => {
    const res = { locals: { apiKey: principal() } } as unknown as Response;
    assert.deepEqual(responseActorOf(res), { kind: 'apiKey', id: KEY });
  });
});

describe('the public representation of the numbers', () => {
  it('rounds an amount to the cent, and has none for none', () => {
    assert.deepEqual([centsOf(null), centsOf(0), centsOf(19.99), centsOf(1.225), centsOf(0.1 + 0.2), centsOf(1_000_000.01)], [null, 0, 1999, 123, 30, 100_000_001]);
  });

  it('reads the stock of a product with the rows in the order of the places and the storages', () => {
    const product = { id: 'p', code: null, updatedAt: null, stock: { a: { s1: { quantity: 1, min: null, max: null, location: null }, s2: { quantity: null, min: 1, max: 2, location: 'A' } }, b: {} } } as unknown as ProductSource;
    assert.deepEqual(toPublicStock(product).stock, [
      { placeId: 'a', storageId: 's1', quantity: 1, min: null, max: null, location: null },
      { placeId: 'a', storageId: 's2', quantity: null, min: 1, max: 2, location: 'A' },
    ]);
  });
});

describe('the events of a public key carry its group', () => {
  it('puts the group of the key on a failed request and on the excess of a limit, before and after the access to the group is issued', async () => {
    const log = memoryActivityLog();
    const reporter = createErrorActivityReporter({ activityLog: log, logger: memoryLogger().logger, now: () => 0 });
    const request = { method: 'POST', ip: '10.0.0.1' } as never;
    reporter.report(new Error('x'), request, { locals: { requestId: 'r1', apiKey: principal() } } as never);
    const other = fixtureId('group', 2);
    reporter.report(new Error('x'), request, { locals: { requestId: 'r2', apiKey: principal(), groupAccess: { groupId: other } } } as never);
    reporter.report(new Error('x'), request, { locals: { requestId: 'r3' } } as never);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(log.entries.map((entry) => [entry.actor.kind, entry.groupId?.toHexString()]), [['apiKey', GROUP.toHexString()], ['apiKey', other.toHexString()], ['anonymous', undefined]]);
    const audit = createRateLimitAudit(log);
    await audit({ rule: { bucket: 'public-catalog-write:key', limit: 1, key: () => 'k' }, req: { ip: '10.0.0.1' } as never, res: { locals: { requestId: 'r4', apiKey: principal() } } as never });
    await audit({ rule: { bucket: 'login:ip', limit: 1, key: () => 'k' }, req: {} as never, res: { locals: { requestId: 'r5' } } as never });
    assert.deepEqual(log.entries.slice(3).map((entry) => entry.groupId?.toHexString()), [GROUP.toHexString(), undefined]);
  });
});

describe('the references a key does not reach', () => {
  it('are put back where they were, once, and never invented', () => {
    const none = new Set<string>();
    assert.deepEqual(withHiddenIds(['a', 'c'], ['a', 'x', 'c', 'y'], new Set(['a', 'c'])), ['a', 'x', 'c', 'y']);
    assert.deepEqual(withHiddenIds([], ['x', 'y'], none), ['x', 'y']);
    assert.deepEqual(withHiddenIds(['x'], ['x', 'y'], none), ['x', 'y'], 'an id already sent is not repeated');
    assert.deepEqual(withHiddenIds(['a'], [], none), ['a']);
    assert.deepEqual(withHiddenIds(['a'], ['q', 'r', 's'], none), ['q', 'r', 's', 'a'], 'at the index it had, or as near as the list allows');
  });
});

describe('completing a modification with what the key does not see', () => {
  const features = { rooms: true, warehouse: true };
  const none = new Set<string>();

  it('has nothing to put back from a product that has none of it, and sends the lists as they are', () => {
    const bare = { barcodes: [], places: [], prices: [] } as unknown as ProductSource;
    const body = {
      barcodes: [{ value: '1' }],
      places: [{ placeId: 'p1' }],
      prices: [{ id: null, priceListId: 'l', currency: 'EUR', taxId: 't', gross: 1 }, { id: 'x', priceListId: 'l', currency: 'EUR', taxId: 't' }],
      requiredModifierIds: ['r'],
      modifierIds: ['m'],
      excludedModifierIds: [],
      menu: [{ categoryId: 'c', quantity: 1 }],
      modifierChoices: [{ categoryId: 'c', freeQuantity: 1, priceRule: 'highest' as const }, { categoryId: 'd', freeQuantity: 1, priceRule: 'lowest' as const, productIds: ['q'] }],
    };
    assert.deepEqual(preserveProduct(body as never, bare, none, features), body);
    assert.deepEqual(preserveProduct({ code: 'x' }, bare, none, features), { code: 'x' });
  });

  it('puts back the course only with the function of the rooms and never over the one the client sent', () => {
    const stored = { barcodes: [], places: [], prices: [], menu: [{ categoryId: 'c', quantity: 1, course: 2, productIds: [] }, { categoryId: 'c', quantity: 1, course: null, productIds: [] }] } as unknown as ProductSource;
    const sent = { menu: [{ categoryId: 'c', quantity: 1 }, { categoryId: 'c', quantity: 1 }, { categoryId: 'c', quantity: 1, course: 5 }] };
    assert.deepEqual(preserveProduct(sent as never, stored, none, features).menu, [{ categoryId: 'c', quantity: 1, course: 2 }, { categoryId: 'c', quantity: 1 }, { categoryId: 'c', quantity: 1, course: 5 }]);
    assert.deepEqual(preserveProduct(sent as never, stored, none, { rooms: false, warehouse: true }).menu, sent.menu);
  });

  it('completes a category that has no modifiers and a place that has no production center', () => {
    const stored = { places: [{ placeId: 'p1', position: 1, productionCenterId: 'pc' }, { placeId: 'p2', position: 1, productionCenterId: null }], modifierIds: undefined } as never;
    const body = { places: [{ placeId: 'p1' }, { placeId: 'p2' }, { placeId: 'p3' }, { placeId: 'p1', productionCenterId: 'other' }], modifierIds: ['m'] };
    assert.deepEqual(preserveCategory(body as never, stored, none), { places: [{ placeId: 'p1', productionCenterId: 'pc' }, { placeId: 'p2' }, { placeId: 'p3' }, { placeId: 'p1', productionCenterId: 'other' }], modifierIds: ['m'] });
    assert.deepEqual(preserveCategory({ position: 1 }, stored, none), { position: 1 });
  });
});
