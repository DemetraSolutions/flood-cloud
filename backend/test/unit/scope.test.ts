import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { legacyScopeIds } from '../../src/shared/security/scope/legacy-scope.ts';
import { buildPrincipal } from '../../src/shared/security/scope/principal.ts';
import type { StoredUser } from '../../src/shared/security/scope/principal.ts';
import { computeScope } from '../../src/shared/security/scope/scope.ts';
import type { UserScope } from '../../src/shared/security/scope/scope.ts';
import { companiesScopeFilter, companyInScope, groupsScopeFilter, placeInScope, placesScopeFilter, usersScopeFilter, withScope } from '../../src/shared/security/scope/scope-filters.ts';
import type { Scope } from '../../src/shared/security/scope/scope.ts';
import { fixtureId } from '../helpers/legacy-fixtures.ts';

const g1 = fixtureId('group', 1);
const g2 = fixtureId('group', 2);
const c1 = fixtureId('company', 1);
const c2 = fixtureId('company', 2);
const p1 = fixtureId('place', 1);
const p2 = fixtureId('place', 2);
const me = fixtureId('user', 1);

const placeLookups: Array<[ObjectId, ObjectId[]]> = [];
const deps = {
  listDealerGroupIds: async (id: ObjectId) => (id.equals(me) ? [g1, g2] : []),
  listCompanyPlaceIds: async (groupId: ObjectId, companyIds: readonly ObjectId[]) => {
    placeLookups.push([groupId, [...companyIds]]);
    return [p1, p2];
  },
};
const user = (overrides: Partial<StoredUser>): StoredUser => ({ userId: me, role: 'SA', groupId: g1, companyIds: [], placeIds: [], legacyPermissions: undefined, ...overrides });

describe('computeScope', () => {
  it('gives PSA the platform', async () => {
    assert.deepEqual(await computeScope(user({ role: 'PSA', groupId: null }), deps), { scope: { kind: 'platform' }, anomalies: [] });
  });

  it('gives D the groups whose dealerId is his id', async () => {
    const { scope, anomalies } = await computeScope(user({ role: 'D', groupId: null }), deps);
    assert.deepEqual(anomalies, []);
    assert.equal(scope.kind, 'dealer');
    assert.deepEqual([...(scope as Extract<Scope, { kind: 'dealer' }>).groupIds].sort(), [g1.toHexString(), g2.toHexString()]);
    const other = await computeScope(user({ role: 'D', userId: fixtureId('user', 2), groupId: null }), deps);
    assert.equal((other.scope as Extract<Scope, { kind: 'dealer' }>).groupIds.size, 0);
  });

  it('gives SA his group', async () => {
    assert.deepEqual(await computeScope(user({ role: 'SA' }), deps), { scope: { kind: 'group', groupId: g1 }, anomalies: [] });
  });

  it('gives CA his companies and PA his places, copying the arrays', async () => {
    const companyIds = [c1, c2];
    const ca = await computeScope(user({ role: 'CA', companyIds }), deps);
    assert.deepEqual(ca, { scope: { kind: 'companies', groupId: g1, companyIds: [c1, c2], placeIds: [p1, p2] }, anomalies: [] });
    assert.notEqual((ca.scope as Extract<Scope, { kind: 'companies' }>).companyIds, companyIds);
    assert.deepEqual(placeLookups.at(-1), [g1, [c1, c2]]);
    const pa = await computeScope(user({ role: 'PA', placeIds: [p1] }), deps);
    assert.deepEqual(pa, { scope: { kind: 'places', groupId: g1, placeIds: [p1] }, anomalies: [] });
  });

  it('gives E nothing', async () => {
    assert.deepEqual(await computeScope(user({ role: 'E', placeIds: [p1] }), deps), { scope: { kind: 'none' }, anomalies: [] });
  });

  it('reports a missing group and empty CA or PA scopes, with an empty scope', async () => {
    for (const role of ['SA', 'CA', 'PA'] as const) {
      assert.deepEqual(await computeScope(user({ role, groupId: null, companyIds: [c1], placeIds: [p1] }), deps), { scope: { kind: 'none' }, anomalies: ['missingGroup'] });
    }
    assert.deepEqual(await computeScope(user({ role: 'CA' }), deps), { scope: { kind: 'none' }, anomalies: ['companyAdminWithoutCompanies'] });
    assert.deepEqual(await computeScope(user({ role: 'PA' }), deps), { scope: { kind: 'none' }, anomalies: ['placeAdminWithoutPlaces'] });
  });
});

describe('computeScope: hardening', () => {
  it('gives nothing, with an anomaly, to a value that is not a role', async () => {
    for (const role of ['API', 'constructor', '', undefined, null, 5]) {
      assert.deepEqual(await computeScope(user({ role: role as never, groupId: g1, companyIds: [c1], placeIds: [p1] }), deps), { scope: { kind: 'none' }, anomalies: ['invalidRole'] });
    }
  });

  it('keeps the scope of a SA with leftover companyId, placeId and placesId unchanged', async () => {
    const dirty = await computeScope(user({ role: 'SA', companyIds: [c1], placeIds: [p1, p2] }), deps);
    assert.deepEqual(dirty, await computeScope(user({ role: 'SA' }), deps));
    assert.deepEqual(usersScopeFilter({ role: 'SA', scope: dirty.scope }), { groupId: g1, role: { $in: ['SA', 'CA', 'PA', 'E', null] } });
  });

  it('returns scopes that cannot be modified', async () => {
    const dealer = (await computeScope(user({ role: 'D', groupId: null }), deps)).scope as Extract<Scope, { kind: 'dealer' }>;
    assert.throws(() => (dealer.groupIds as Set<string>).add('x'), TypeError);
    assert.throws(() => (dealer.groupIds as Set<string>).delete(g1.toHexString()), TypeError);
    assert.throws(() => (dealer.groupIds as Set<string>).clear(), TypeError);
    assert.ok(Object.isFrozen(dealer));
    const ca = (await computeScope(user({ role: 'CA', companyIds: [c1] }), deps)).scope as Extract<Scope, { kind: 'companies' }>;
    const pa = (await computeScope(user({ role: 'PA', placeIds: [p1] }), deps)).scope as Extract<Scope, { kind: 'places' }>;
    for (const frozen of [ca, ca.companyIds, ca.placeIds, pa, pa.placeIds]) {
      assert.ok(Object.isFrozen(frozen));
    }
    assert.throws(() => {
      (ca.companyIds as ObjectId[]).push(c2);
    }, TypeError);
  });
});

describe('buildPrincipal', () => {
  it('assembles a frozen principal from the stored user', async () => {
    const { principal, anomalies } = await buildPrincipal(user({ role: 'CA', companyIds: [c1], legacyPermissions: { status: true, places: { r: true } } }), deps);
    assert.deepEqual(anomalies, []);
    assert.equal(principal.scope.kind, 'companies');
    assert.equal(principal.canManagePermissions, true);
    assert.deepEqual([...principal.permissions].sort(), ['clientErrors:create', 'places:read', 'profile:read', 'profile:update', 'sessions:read', 'sessions:revoke']);
    assert.ok(Object.isFrozen(principal) && Object.isFrozen(principal.companyIds) && Object.isFrozen(principal.placeIds));
    assert.throws(() => (principal.permissions as Set<string>).add('groups:trash'), TypeError);
    assert.equal(principal.matrix.status, true);
    assert.deepEqual(principal.matrix.modules['places'], { r: true, w: false });
  });

  it('carries the scope anomalies', async () => {
    const built = await buildPrincipal(user({ role: 'PA' }), deps);
    assert.deepEqual(built.anomalies, ['placeAdminWithoutPlaces']);
    assert.equal(built.principal.scope.kind, 'none');
  });
});

describe('legacyScopeIds (D-08)', () => {
  it('reads companyIds from companyId and placeIds from the union of placeId and placesId', () => {
    assert.deepEqual(legacyScopeIds({ companyId: c1, placeId: p1, placesId: [p1, p2] }), { companyIds: [c1], placeIds: [p1, p2] });
    assert.deepEqual(legacyScopeIds({ companyId: null, placeId: null, placesId: [p2] }), { companyIds: [], placeIds: [p2] });
  });

  it('keeps only ObjectId values, without duplicates', () => {
    const ids = legacyScopeIds({ companyId: c1.toHexString(), placeId: p1, placesId: [p1, 'not-an-id', p1.toHexString(), 7, null, ObjectId.createFromHexString(p2.toHexString())] });
    assert.deepEqual(ids, { companyIds: [], placeIds: [p1, p2] });
  });

  it('tolerates missing or malformed fields', () => {
    for (const placesId of [undefined, 'single', 5, {}]) {
      assert.deepEqual(legacyScopeIds({ placesId }), { companyIds: [], placeIds: [] });
    }
    assert.deepEqual(legacyScopeIds({}), { companyIds: [], placeIds: [] });
  });
});

describe('scope filters', () => {
  const dealer: Scope = { kind: 'dealer', groupIds: new Set([g1.toHexString()]) };
  const companies: Scope = { kind: 'companies', groupId: g1, companyIds: [c1, c2], placeIds: [p1, p2] };
  const places: Scope = { kind: 'places', groupId: g1, placeIds: [p1] };
  const store: Scope = { kind: 'store', groupId: g1, companyId: c1, placeId: p1 };
  const NOTHING = { _id: { $in: [] } };
  const managed = (role: 'D' | 'SA' | 'CA' | 'PA') => ({ $in: role === 'D' || role === 'SA' ? ['SA', 'CA', 'PA', 'E', null] : role === 'CA' ? ['CA', 'PA', 'E', null] : ['PA', 'E', null] });

  it('users', () => {
    assert.deepEqual(usersScopeFilter({ role: 'PSA', scope: { kind: 'platform' } }), {});
    assert.deepEqual(usersScopeFilter({ role: 'D', scope: dealer }), { groupId: { $in: [g1] }, role: managed('D') });
    assert.deepEqual(usersScopeFilter({ role: 'D', scope: { kind: 'dealer', groupIds: new Set() } }), { groupId: { $in: [] }, role: managed('D') });
    assert.deepEqual(usersScopeFilter({ role: 'SA', scope: { kind: 'group', groupId: g1 } }), { groupId: g1, role: managed('SA') });
    assert.deepEqual(usersScopeFilter({ role: 'CA', scope: companies }), {
      groupId: g1,
      $or: [
        { role: { $in: ['CA'] }, companyId: { $in: [c1, c2] } },
        { role: { $in: ['PA', 'E', null] }, $or: [{ placeId: { $in: [p1, p2] } }, { placesId: { $in: [p1, p2] } }] },
      ],
    });
    assert.deepEqual(usersScopeFilter({ role: 'PA', scope: places }), { groupId: g1, role: managed('PA'), $or: [{ placeId: { $in: [p1] } }, { placesId: { $in: [p1] } }] });
    assert.deepEqual(usersScopeFilter({ role: 'E', scope: { kind: 'none' } }), NOTHING);
  });

  it('never lets a role see users above his rank', () => {
    const sa = usersScopeFilter({ role: 'SA', scope: { kind: 'group', groupId: g1 } }) as { role: { $in: unknown[] } };
    assert.ok(!sa.role.$in.includes('PSA') && !sa.role.$in.includes('D'));
    const d = usersScopeFilter({ role: 'D', scope: dealer }) as { role: { $in: unknown[] } };
    assert.ok(!d.role.$in.includes('D') && !d.role.$in.includes('PSA'));
    // A role that manages nobody (corrupted principal) sees no role at all.
    assert.deepEqual((usersScopeFilter({ role: 'E', scope: places }) as { role: unknown }).role, { $in: [] });
    assert.deepEqual(usersScopeFilter({ role: 'E', scope: companies }), {
      groupId: g1,
      $or: [
        { role: { $in: [] }, companyId: { $in: [c1, c2] } },
        { role: { $in: [] }, $or: [{ placeId: { $in: [p1, p2] } }, { placesId: { $in: [p1, p2] } }] },
      ],
    });
  });

  it('groups', () => {
    assert.deepEqual(groupsScopeFilter({ kind: 'platform' }), {});
    assert.deepEqual(groupsScopeFilter(dealer), { _id: { $in: [...(dealer as Extract<Scope, { kind: 'dealer' }>).groupIds].map((hex) => ObjectId.createFromHexString(hex)) } });
    for (const scope of [{ kind: 'group', groupId: g1 }, companies, places] as UserScope[]) {
      assert.deepEqual(groupsScopeFilter(scope), { _id: g1 });
    }
    assert.deepEqual(groupsScopeFilter({ kind: 'none' }), NOTHING);
  });

  it('companies', () => {
    for (const scope of [{ kind: 'platform' }, dealer, { kind: 'group', groupId: g1 }] as UserScope[]) {
      assert.deepEqual(companiesScopeFilter(scope), {});
    }
    assert.deepEqual(companiesScopeFilter(companies), { _id: { $in: [c1, c2] } });
    assert.deepEqual(companiesScopeFilter(places), NOTHING);
    assert.deepEqual(companiesScopeFilter({ kind: 'none' }), NOTHING);
  });

  it('tells whether a company is inside a scope exactly as the companies filter does', () => {
    for (const scope of [{ kind: 'platform' }, dealer, { kind: 'group', groupId: g1 }] as Scope[]) {
      assert.equal(companyInScope(scope, fixtureId('company', 99)), true);
    }
    assert.equal(companyInScope(companies, c1), true);
    assert.equal(companyInScope(companies, c2), true);
    assert.equal(companyInScope(companies, fixtureId('company', 99)), false);
    assert.equal(companyInScope(places, c1), false);
    assert.equal(companyInScope({ kind: 'none' }, c1), false);
    assert.equal(companyInScope(store, c1), true, 'a store reaches its own company');
    assert.equal(companyInScope(store, c2), false);
  });

  it('tells whether a place is inside a scope', () => {
    for (const scope of [{ kind: 'platform' }, dealer, { kind: 'group', groupId: g1 }] as Scope[]) {
      assert.equal(placeInScope(scope, p1, undefined), true);
    }
    assert.equal(placeInScope(companies, fixtureId('place', 99), c1), true);
    assert.equal(placeInScope(companies, p1, fixtureId('company', 99)), false);
    assert.equal(placeInScope(companies, p1, 'x'), false);
    assert.equal(placeInScope(places, p1, undefined), true);
    assert.equal(placeInScope(places, fixtureId('place', 99), c1), false);
    assert.equal(placeInScope({ kind: 'none' }, p1, c1), false);
    assert.equal(placeInScope(store, p1, c2), true, 'a store reaches its own place, whatever the company stored on it');
    assert.equal(placeInScope(store, p2, c1), false);
  });

  it('places', () => {
    for (const scope of [{ kind: 'platform' }, dealer, { kind: 'group', groupId: g1 }] as Scope[]) {
      assert.deepEqual(placesScopeFilter(scope), {});
    }
    assert.deepEqual(placesScopeFilter(companies), { companyId: { $in: [c1, c2] } });
    assert.deepEqual(placesScopeFilter(places), { _id: { $in: [p1] } });
    assert.deepEqual(placesScopeFilter({ kind: 'none' }), NOTHING);
    assert.deepEqual(placesScopeFilter(store), { _id: p1 }, 'a store sees its own place and nothing else');
  });

  it('withScope puts the scope and the query side by side under $and', () => {
    const scopeFilter = { groupId: g1 };
    const query = { $or: [{ groupId: g2 }, {}] };
    assert.deepEqual(withScope(scopeFilter, query), { $and: [scopeFilter, query] });
  });
});
