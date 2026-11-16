import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createStoreKeysRoutes } from '../../src/modules/store-keys/store-keys.routes.ts';
import type { StoreKeysController } from '../../src/modules/store-keys/store-keys.controller.ts';
import { createRateLimitRules } from '../../src/shared/security/rate-limit/rules.ts';
import { createPlacesRoutes } from '../../src/modules/places/places.routes.ts';
import { testConfig } from '../helpers/app.ts';

const rules = createRateLimitRules(testConfig());
const noop = () => undefined;
const controller = { status: noop, createCode: noop, cancelCode: noop, revoke: noop, exchange: noop, context: noop } as unknown as StoreKeysController;
const routes = createStoreKeysRoutes(controller, rules);
const find = (method: string, path: string) => routes.find((route) => route.method === method && route.path === path)!;
const key = '/groups/:groupId/places/:placeId/store-key';

describe('the routes of the store keys', () => {
  it('declares the management on a group, for the permissions of the key and for no store: only a PSA or a dealer reaches them', () => {
    const expected: Array<[string, string, string]> = [
      ['GET', key, 'storeKeys:read'],
      ['POST', `${key}/activation-codes`, 'storeKeys:manage'],
      ['DELETE', `${key}/activation-code`, 'storeKeys:manage'],
      ['DELETE', key, 'storeKeys:manage'],
    ];
    for (const [method, path, permission] of expected) {
      assert.deepEqual(find(method, path).auth, { kind: 'user', permission, group: true }, `${method} ${path}`);
    }
    assert.equal(routes.length, 6);
  });

  it('never compresses the response that carries the code or the key, and limits what changes per user', () => {
    assert.equal(find('POST', `${key}/activation-codes`).compress, false);
    assert.equal(find('POST', '/store-activations').compress, false);
    assert.equal(find('GET', key).compress, undefined);
    for (const [method, path] of [['POST', `${key}/activation-codes`], ['DELETE', `${key}/activation-code`], ['DELETE', key]] as const) {
      assert.deepEqual(find(method, path).rateLimit, [rules.storeKeyAdminPerUser], `${method} ${path}`);
    }
  });

  it('makes the exchange anonymous by nature, limited per address before the body, with a small body', () => {
    const exchange = find('POST', '/store-activations');
    assert.equal(exchange.auth.kind, 'anonymous');
    assert.match((exchange.auth as { reason: string }).reason, /activation code/);
    assert.deepEqual([exchange.rateLimit, exchange.bodyLimit], [[rules.storeActivationPerIp], '2kb']);
    assert.equal(rules.storeActivationPerIp.needsBody, undefined);
  });

  it('opens the one route only a store may call, and no other', () => {
    assert.deepEqual(find('GET', '/store-context').auth, { kind: 'store' });
    const opened = routes.filter((route) => 'store' in route.auth);
    assert.deepEqual(opened, []);
  });

  it('opens to a store, among the routes of the places, the detail alone', () => {
    const places = createPlacesRoutes({ replace: {} } as never, {} as never);
    const open = places.filter((route) => (route.auth as { store?: unknown }).store === true).map((route) => `${route.method} ${route.path}`);
    assert.deepEqual(open, ['GET /groups/:groupId/places/:placeId']);
  });
});
