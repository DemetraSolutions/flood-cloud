import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import type { Request, Response } from 'express';
import { createStoreContextRoutes } from '../../src/modules/store-context/store-context.routes.ts';
import { GROUP_CREDENTIAL_PROJECTION, toGroupCredentials, toStoreGroup } from '../../src/modules/store-context/store-context.mapper.ts';
import { createStoreContextService } from '../../src/modules/store-context/store-context.service.ts';
import type { StoreContextServiceDeps } from '../../src/modules/store-context/store-context.service.ts';
import { PROVIDERS } from '../../src/modules/groups/group.types.ts';
import type { GroupResponse } from '../../src/modules/groups/group.types.ts';
import { AppError } from '../../src/shared/http/errors.ts';
import { STORE_PROFILE } from '../../src/shared/security/rbac/policy.ts';
import { requireStoreGroupAccess } from '../../src/shared/security/scope/group-access.ts';
import type { GroupAccess } from '../../src/shared/security/scope/group-access.ts';
import type { StorePrincipal } from '../../src/shared/security/scope/principal.ts';
import { toStoreUser } from '../../src/modules/store-context/store-context.mapper.ts';
import { storeUsersFilter, storeUsersQuery } from '../../src/modules/store-context/store-context.users.ts';
import type { UserResponse } from '../../src/modules/users/user.types.ts';
import { fromLegacy } from '../../src/modules/users/user.mapper.ts';
import { createConfigurationReadAudit } from '../../src/modules/store-context/store-context.audit.ts';
import { fixtureId } from '../helpers/legacy-fixtures.ts';
import { toPlace, toStorePlace } from '../../src/modules/places/place.mapper.ts';
import type { Place } from '../../src/modules/places/place.types.ts';

const GROUP = fixtureId('group', 1);
const COMPANY = fixtureId('company', 1);
const PLACE = fixtureId('place', 1);
const STORE: StorePrincipal = Object.freeze({
  kind: 'store',
  keyId: fixtureId('user', 77),
  groupId: GROUP,
  companyId: COMPANY,
  placeId: PLACE,
  activatedAt: new Date('2026-01-01T00:00:00.000Z'),
  permissions: STORE_PROFILE,
  scope: Object.freeze({ kind: 'store', groupId: GROUP, companyId: COMPANY, placeId: PLACE }),
});
const ACCESS = { groupId: GROUP } as unknown as GroupAccess;

describe('the credentials of a stored group', () => {
  it('reads the legacy key and the key of every provider, and nothing for the rest', () => {
    const credentials = toGroupCredentials({
      apiKey: 'legacy-key-sentinel', // gitleaks:allow (fake test value)
      settings: { integrations: { yellgo: { status: true, apiKey: 'yellgo-key-sentinel' }, qodeup: { status: true }, unknownProvider: { apiKey: 'x' } } }, // gitleaks:allow (fake test value)
    });
    assert.equal(credentials.legacyApiKey, 'legacy-key-sentinel');
    assert.deepEqual(Object.keys(credentials.integrationKeys), [...PROVIDERS]);
    assert.equal(credentials.integrationKeys.yellgo, 'yellgo-key-sentinel');
    assert.equal(credentials.integrationKeys.qodeup, null);
    assert.ok(!('unknownProvider' in credentials.integrationKeys));
  });

  it('reads the capitalized variant of easyappear only when the right one is missing', () => {
    const variant = { settings: { integrations: { easyAppear: { apiKey: 'variant-key' } } } };
    assert.equal(toGroupCredentials(variant).integrationKeys.easyappear, 'variant-key');
    assert.equal(toGroupCredentials({ settings: { integrations: { easyappear: null, easyAppear: { apiKey: 'variant-key' } } } }).integrationKeys.easyappear, 'variant-key');
    assert.equal(toGroupCredentials({ settings: { integrations: { easyappear: { status: true }, easyAppear: { apiKey: 'variant-key' } } } }).integrationKeys.easyappear, null);
  });

  it('turns every junk value into null, never an error', () => {
    const none = Object.fromEntries(PROVIDERS.map((provider) => [provider, null]));
    for (const document of [
      {},
      { settings: 'none' },
      { settings: { integrations: [] } },
      { settings: { integrations: 'x' } },
      { settings: null },
      { settings: { integrations: { yellgo: 'text', qodeup: null, cooperto: [] } } },
    ]) {
      assert.deepEqual(toGroupCredentials(document).integrationKeys, none);
    }
    for (const apiKey of [undefined, null, '', 7, {}, ['k'], true]) {
      assert.equal(toGroupCredentials({ apiKey }).legacyApiKey, null);
      assert.equal(toGroupCredentials({ settings: { integrations: { yellgo: { apiKey } } } }).integrationKeys.yellgo, null);
    }
  });

  it('projects exactly the paths of the credentials', () => {
    assert.deepEqual(Object.keys(GROUP_CREDENTIAL_PROJECTION).sort(), ['apiKey', 'settings.integrations.easyAppear.apiKey', ...PROVIDERS.map((provider) => `settings.integrations.${provider}.apiKey`)].sort());
  });
});

describe('the representation of the group for a store', () => {
  const detail = {
    id: 'g',
    name: 'Group',
    description: null,
    dealerId: 'dealer-sentinel',
    status: 'active',
    trashed: false,
    trashedAt: null,
    demo: false,
    features: { a: true },
    languages: ['it'],
    statsSettings: { openingTime: null, compressProductsCategories: false, timeSlots: [] },
    integrations: Object.fromEntries(PROVIDERS.map((provider) => [provider, { enabled: provider === 'yellgo', apiKeySet: provider === 'yellgo' }])),
    publicApi: { enabled: true },
    dataCluster: 'cluster-sentinel',
    priceLists: [],
    taxes: [],
    currencies: [],
    measureUnits: [],
    warehouseRules: [],
    fidelityCardRules: [],
    createdAt: null,
    updatedAt: null,
    unknownField: 'x',
  } as unknown as GroupResponse;
  const extra = { cardTypes: [], pointsCollections: [], prizeCatalogues: [], productFavorites: [], promotions: [] };

  it('is an allowlist: no dealer, public API, cluster or unknown field, keys in clear instead of flags', () => {
    const credentials = { legacyApiKey: 'legacy', integrationKeys: Object.fromEntries(PROVIDERS.map((provider) => [provider, provider === 'yellgo' ? 'k' : null])) } as never;
    const group = toStoreGroup(detail, credentials, extra);
    const text = JSON.stringify(group);
    for (const forbidden of ['dealer-sentinel', 'cluster-sentinel', 'publicApi', 'unknownField', 'apiKeySet', 'dealerId', 'dataCluster']) {
      assert.ok(!text.includes(forbidden), forbidden);
    }
    assert.deepEqual(group.integrations.yellgo, { enabled: true, apiKey: 'k' });
    assert.deepEqual(group.integrations.qodeup, { enabled: false, apiKey: null });
    assert.equal(group.legacyApiKey, 'legacy');
  });
});

describe('the routes of the store context', () => {
  const noop = () => undefined;
  const routes = createStoreContextRoutes({ group: noop, company: noop, place: noop, countries: noop, users: noop });

  it('declares five store-only routes without path parameters: four that carry credentials (never compressed, with the group access of the store) and the countries (platform data, default compression, no group)', () => {
    assert.deepEqual(routes.map((route) => `${route.method} ${route.path}`), ['GET /store-context/group', 'GET /store-context/company', 'GET /store-context/place', 'GET /store-context/users', 'GET /store-context/countries']);
    for (const route of routes.slice(0, 4)) {
      assert.deepEqual(route.auth, { kind: 'store', group: true });
      assert.equal(route.compress, false);
    }
    assert.deepEqual(routes.slice(0, 3).map((route) => route.middleware), [undefined, undefined, undefined]);
    assert.equal(routes[3]!.middleware?.length, 1, 'the page parameters are validated');
    assert.deepEqual(routes[4]!.auth, { kind: 'store' });
    assert.equal(routes[4]!.compress, undefined);
    assert.equal(routes[4]!.middleware, undefined);
  });

});

describe('the group access of a store', () => {
  const found = { availability: 'available' as const, group: { _id: GROUP } };
  const run = async (store: StorePrincipal | undefined, access: { availability: 'available' | 'unavailable'; group: { _id: ObjectId } } | null) => {
    const handler = requireStoreGroupAccess({ findAccess: async () => access, resolveCluster: () => 'cluster0' });
    const res = { locals: { store } } as unknown as Response;
    let nexted = false;
    await handler({} as Request, res, () => void (nexted = true));
    return { res, nexted };
  };

  it('issues the access to the group of the principal, and only to it', async () => {
    const { res, nexted } = await run(STORE, found);
    assert.ok(nexted && (res.locals.groupAccess as GroupAccess).groupId.equals(GROUP));
  });

  it('is 401 without a store principal and 404 when the group is no longer reachable', async () => {
    await assert.rejects(run(undefined, found), (error: unknown) => error instanceof AppError && error.code === 'UNAUTHENTICATED');
    await assert.rejects(run(STORE, null), (error: unknown) => error instanceof AppError && error.code === 'NOT_FOUND');
    await assert.rejects(run(STORE, { availability: 'unavailable', group: { _id: GROUP } }), (error: unknown) => error instanceof AppError && error.code === 'NOT_FOUND');
  });
});

describe('the service of the store context', () => {
  const warnings: unknown[] = [];
  const groupDocument = { group: { id: GROUP.toHexString() }, anomalies: [] as unknown[] };
  const credentials = { legacyApiKey: null, integrationKeys: Object.fromEntries(PROVIDERS.map((provider) => [provider, null])) };
  let mapped: { group: unknown; anomalies: unknown[] } | null;
  let stored: unknown;
  let read: { document: Record<string, unknown>; version: string } | null;
  const listed: Array<{ filter: unknown; params: unknown }> = [];
  const deps = (): StoreContextServiceDeps =>
    ({
      groups: { findById: async () => mapped },
      repository: { groupCredentials: async () => stored },
      users: { listForStore: async (filter: unknown, params: unknown) => (listed.push({ filter, params }), { users: [], page: { limit: 50, next: null } }) },
      catalogs: { list: async () => [] },
      readerFor: () => ({ read: async () => read }),
      logger: { warn: (_message: string, fields: unknown) => warnings.push(fields) },
    }) as unknown as StoreContextServiceDeps;
  const notFound = (error: unknown) => error instanceof AppError && error.code === 'NOT_FOUND';

  it('is 404 when the group, its credentials, the company or the place is gone', async () => {
    const service = createStoreContextService(deps());
    mapped = null;
    stored = credentials;
    read = null;
    await assert.rejects(service.getGroup(STORE, ACCESS), notFound);
    mapped = groupDocument;
    stored = null;
    await assert.rejects(service.getGroup(STORE, ACCESS), notFound);
    await assert.rejects(service.getCompany(STORE, ACCESS), notFound);
    await assert.rejects(service.getPlace(STORE, ACCESS), notFound);
    read = { document: { _id: PLACE, companyId: 'not-an-id' }, version: 'v1' };
    await assert.rejects(service.getCompany(STORE, ACCESS), notFound);
    read = { document: { _id: PLACE }, version: 'v1' };
    await assert.rejects(service.getCompany(STORE, ACCESS), notFound);
  });

  it('logs the anomalies of the stored group by name, never a value', async () => {
    const service = createStoreContextService({ ...deps(), groups: { findById: async () => ({ ...groupDocument, anomalies: [{ kind: 'invalidType', field: 'status' }] }) } as never });
    // The group above has no integrations: the mapping of the response is not what this test is about.
    stored = credentials;
    await assert.rejects(service.getGroup(STORE, ACCESS));
    assert.deepEqual(warnings, [{ groupId: GROUP.toHexString(), anomalies: [{ kind: 'invalidType', field: 'status' }] }]);
  });

  it('reads the place, then the company the place document has now (not the one of the principal), and the place with the version of its document', async () => {
    const moved = fixtureId('company', 2);
    const seen: string[] = [];
    const service = createStoreContextService({
      ...deps(),
      readerFor: (principal: StorePrincipal) => ({
        read: async (kind: string, id: ObjectId) => {
          seen.push(`${kind}:${id.toHexString()}:${principal.companyId.toHexString()}:${principal.scope.companyId.toHexString()}`);
          return { document: { _id: id, companyId: moved }, version: 'v1' };
        },
      }),
    } as never);
    assert.equal((await service.getCompany(STORE, ACCESS)).version, 'v1');
    assert.equal((await service.getPlace(STORE, ACCESS)).version, 'v1');
    const c = (id: ObjectId) => id.toHexString();
    assert.deepEqual(seen, [
      `places:${c(PLACE)}:${c(COMPANY)}:${c(COMPANY)}`,
      `companies:${c(moved)}:${c(moved)}:${c(moved)}`,
      `places:${c(PLACE)}:${c(COMPANY)}:${c(COMPANY)}`,
    ]);
  });

  it('lists with the default order of the users and the page asked, the filter built from the store', async () => {
    mapped = groupDocument;
    read = { document: { _id: PLACE, companyId: COMPANY }, version: 'v1' };
    listed.length = 0;
    const service = createStoreContextService(deps());
    const result = await service.getUsers(STORE, ACCESS, { limit: 7 });
    assert.deepEqual(result, { users: [], page: { limit: 50, next: null }, companyId: COMPANY });
    assert.deepEqual(listed[0]!.filter, storeUsersFilter(GROUP, PLACE, COMPANY));
    assert.equal((listed[0]!.params as { limit: number; sort: string }).limit, 7);
    assert.equal((listed[0]!.params as { sort: string }).sort, 'username');
  });
});

describe('the place of a store', () => {
  const document = {
    _id: PLACE,
    name: 'Bar',
    unknownTop: 'UNKNOWN-TOP-SENTINEL', // gitleaks:allow (fake test value)
    integrations: { dojo: { status: true, apiKey: 'DOJO-SENTINEL', unknownKey: 'UNKNOWN-INTEGRATION-SENTINEL' }, unknownProvider: { apiKey: 'UNKNOWN-PROVIDER-SENTINEL' } }, // gitleaks:allow (fake test values)
    devices: [{ id: 'd1', type: 'desk', automaticCashPassword: 'DEVICE-SENTINEL', unknownDeviceKey: 'UNKNOWN-DEVICE-SENTINEL', info: { token: 'INFO-SENTINEL' } }], // gitleaks:allow (fake test values)
  };

  it('has the credentials in clear and nothing that is not modelled: no unknown key of a device, an integration or the document', () => {
    const place = toStorePlace(document, GROUP);
    const text = JSON.stringify(place);
    assert.ok(text.includes('DOJO-SENTINEL') && text.includes('DEVICE-SENTINEL'));
    for (const hidden of ['UNKNOWN-TOP-SENTINEL', 'UNKNOWN-INTEGRATION-SENTINEL', 'UNKNOWN-PROVIDER-SENTINEL', 'UNKNOWN-DEVICE-SENTINEL', 'INFO-SENTINEL']) {
      assert.ok(!text.includes(hidden), hidden);
    }
    assert.ok(!text.includes('Set"'), 'no flag');
  });

  it('is not a Place, nor a group of the backoffice, for the compiler', () => {
    const clear = toStorePlace(document, GROUP);
    // @ts-expect-error the representation with credentials is not assignable to the one of the backoffice
    const asPlace: Place = clear;
    // @ts-expect-error and the backoffice representation is not the one with credentials
    const asClear: typeof clear = toPlace(document, GROUP);
    // @ts-expect-error the group of a store is not the group of the backoffice
    const asGroup: GroupResponse = {} as ReturnType<typeof toStoreGroup>;
    assert.ok([asPlace, asClear, asGroup].length === 3);
  });
});

describe('the audit of the reads of the configuration', () => {
  const client = { requestId: 'req-1', ip: '10.0.0.9', userAgent: null } as never;
  const run = async (consume: () => Promise<{ allowed: boolean }>, ip: string | null = '10.0.0.9') => {
    const recorded: Array<Record<string, unknown>> = [];
    const consumed: unknown[][] = [];
    const errors: unknown[] = [];
    const audit = createConfigurationReadAudit({
      activityLog: { record: async (entry) => void recorded.push(entry as never) },
      rateLimiter: { consume: (...args: unknown[]) => (consumed.push(args), consume()) } as never,
      logger: { error: (_message: string, fields: unknown) => errors.push(fields) } as never,
    });
    await audit.record(STORE, { ...(client as object), ip } as never, 'place');
    return { recorded, consumed, errors };
  };

  it('counts one an hour per key and resource, and records the event once the counter allows it', async () => {
    const { recorded, consumed } = await run(async () => ({ allowed: true }));
    assert.deepEqual(consumed, [['storeConfigurationRead:key', `${STORE.keyId.toHexString()}:place:10.0.0.9`, 1, 3600]]);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]!['action'], 'store.configurationRead');
    assert.equal((await run(async () => ({ allowed: false }))).recorded.length, 0);
  });

  it('throttles per address too: the same key from a new address is a new counter, from the same one it is not; an unknown address has one token of its own', async () => {
    const keys: string[] = [];
    const audit = createConfigurationReadAudit({
      activityLog: { record: async () => undefined },
      rateLimiter: { consume: async (_bucket: string, key: string) => (keys.push(key), { allowed: true }) } as never,
      logger: { error: () => undefined } as never,
    });
    for (const ip of ['10.0.0.1', '10.0.0.2', '10.0.0.1', null]) {
      await audit.record(STORE, { requestId: 'r', ip, userAgent: null }, 'users');
    }
    const key = STORE.keyId.toHexString();
    assert.deepEqual(keys, [`${key}:users:10.0.0.1`, `${key}:users:10.0.0.2`, `${key}:users:10.0.0.1`, `${key}:users:unknown`]);
  });

  it('records the company the read used when the caller names one, the principal\'s otherwise', async () => {
    const recorded: Array<Record<string, unknown>> = [];
    const audit = createConfigurationReadAudit({
      activityLog: { record: async (entry) => void recorded.push(entry as never) },
      rateLimiter: { consume: async () => ({ allowed: true }) } as never,
      logger: { error: () => undefined } as never,
    });
    const used = fixtureId('company', 9);
    await audit.record(STORE, client, 'users', used);
    await audit.record(STORE, client, 'group');
    assert.deepEqual(recorded.map((entry) => (entry['metadata'] as Record<string, unknown>)['companyId']), [used.toHexString(), COMPANY.toHexString()]);
  });

  it('leaves out the address when the request has none', async () => {
    assert.ok(!('ip' in (await run(async () => ({ allowed: true }), null)).recorded[0]!));
  });

  it('writes the event anyway when the counter fails, and logs the failure: a read that succeeded stays a success', async () => {
    const { recorded, errors } = await run(async () => {
      throw new Error('counter down');
    });
    assert.equal(recorded.length, 1);
    assert.equal(errors.length, 1);
  });
});

describe('the users of the place of a store', () => {
  const groupId = GROUP;
  const stored = {
    _id: fixtureId('user', 5),
    userName: 'cassiere',
    name: 'Mario',
    role: 'E',
    groupId,
    placeId: PLACE,
    placesId: [PLACE],
    status: true,
    pin: '4321', // gitleaks:allow (fake test value)
    password: 'PASSWORD-SENTINEL', // gitleaks:allow (fake test value)
    tokens: ['TOKEN-SENTINEL'], // gitleaks:allow (fake test value)
    avatar: 'data:image/png;base64,AAAA',
    unknownKey: 'UNKNOWN-USER-KEY-SENTINEL', // gitleaks:allow (fake test value)
    dealerId: fixtureId('user', 77),
  };
  const record = (document: Record<string, unknown>, pin: string | null) => ({ mapped: fromLegacy(document as never, { summary: true }), pin });

  it('is the backoffice representation with the PIN in clear instead of the flag, and without dealer, picture or anything stored that is not modelled', () => {
    const user = toStoreUser(record(stored, '4321')) as Record<string, unknown>;
    assert.equal(user['pin'], '4321');
    for (const absent of ['pinSet', 'avatar', 'dealerId', 'password', 'tokens', 'unknownKey']) {
      assert.ok(!(absent in user), absent);
    }
    assert.deepEqual([user['id'], user['username'], user['role'], user['status'], user['hasAvatar']], [fixtureId('user', 5).toHexString(), 'cassiere', 'E', 'active', true]);
    assert.ok('pos' in user && 'permissions' in user && 'shiftTime' in user && 'serviceIds' in user);
    const text = JSON.stringify(user);
    for (const hidden of ['PASSWORD-SENTINEL', 'TOKEN-SENTINEL', 'UNKNOWN-USER-KEY-SENTINEL']) {
      assert.ok(!text.includes(hidden), hidden);
    }
  });

  it('is built field by field: a field added to the source is not copied', () => {
    const base = record(stored, '4321');
    const widened = { ...base, mapped: { ...base.mapped, user: { ...base.mapped.user, futureField: 'FUTURE-SENTINEL', dealerId: 'dealer-sentinel' } } } as never;
    const text = JSON.stringify(toStoreUser(widened));
    assert.ok(!text.includes('FUTURE-SENTINEL') && !text.includes('dealer-sentinel'));
  });

  it('has a null PIN when there is none', () => {
    assert.equal((toStoreUser(record(stored, null)) as Record<string, unknown>)['pin'], null);
  });

  it('is not a UserResponse, for the compiler', () => {
    // @ts-expect-error the representation with the PIN is not assignable to the one of the backoffice
    const asResponse: UserResponse = toStoreUser(record(stored, null));
    assert.ok(asResponse !== undefined);
  });

  it('selects by the principal alone: the group, not trashed, E and PA of the place, the CA of the company, the SA', () => {
    const company = fixtureId('company', 3);
    assert.deepEqual(storeUsersFilter(GROUP, PLACE, company), {
      groupId: GROUP,
      trash: { $ne: true },
      $or: [{ role: { $in: ['E', 'PA', null] }, $or: [{ placeId: PLACE }, { placesId: PLACE }] }, { role: 'CA', companyId: company }, { role: 'SA' }],
    });
  });
});
