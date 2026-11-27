import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_PERMISSIONS, PERMISSIONS, ROLES, ROLE_RANK, isPermission, isRole } from '../../src/shared/security/rbac/permissions.ts';
import type { Permission, Role } from '../../src/shared/security/rbac/permissions.ts';
import { MANAGEABLE_ROLES, ROLE_CEILING, hasPermission } from '../../src/shared/security/rbac/policy.ts';

const ALL: Role[] = ['PSA', 'D', 'SA', 'CA', 'PA', 'E'];
const FROM_D: Role[] = ['PSA', 'D'];
const FROM_SA: Role[] = ['PSA', 'D', 'SA'];
const FROM_CA: Role[] = ['PSA', 'D', 'SA', 'CA'];
const FROM_PA: Role[] = ['PSA', 'D', 'SA', 'CA', 'PA'];

/** The table of the product decision (2026-11-02), written independently of the policy code. */
const EXPECTED: Record<Permission, Role[]> = {
  'groups:read': FROM_SA,
  'groups:create': FROM_D,
  'groups:update': FROM_SA,
  'groups:suspend': ['PSA'],
  'groups:trash': ['PSA'],
  'dealers:read': ['PSA'],
  'dealers:create': ['PSA'],
  'dealers:update': ['PSA'],
  'tobaccos:read': ['PSA'],
  'tobaccos:import': ['PSA'],
  'tobaccos:sync': FROM_SA,
  'contacts:export': FROM_SA,
  'contacts:import': FROM_SA,
  'fidelityCards:export': FROM_SA,
  'fidelityCards:import': FROM_SA,
  'countries:manage': ['PSA'],
  'trash:empty': ['PSA'],
  'errorDocuments:read': FROM_D,
  'activations:read': FROM_D,
  'activations:manage': ['PSA'],
  'securityPolicy:manage': ['PSA'],
  'eInvoicingAccounts:manage': ['PSA'],
  'companies:read': FROM_CA,
  'companies:create': FROM_SA,
  'companies:update': FROM_CA,
  'companies:trash': FROM_SA,
  'companies:delete': FROM_SA,
  'places:read': FROM_PA,
  'places:create': FROM_D,
  'places:update': FROM_PA,
  'places:trash': FROM_SA,
  'places:delete': FROM_SA,
  'users:read': FROM_PA,
  'users:create': FROM_PA,
  'users:update': FROM_PA,
  'users:trash': FROM_PA,
  'users:delete': FROM_SA,
  'fidelity:read': FROM_PA,
  'fidelity:update': FROM_PA,
  'products:read': FROM_PA,
  'products:update': FROM_PA,
  'contacts:read': FROM_PA,
  'contacts:write': FROM_PA,
  'sales:read': FROM_PA,
  'sales:write': FROM_PA,
  'sales:delete': FROM_SA,
  'activityLog:read': FROM_PA,
  'sessions:read': FROM_PA,
  'sessions:revoke': FROM_PA,
  'profile:read': FROM_PA,
  'profile:update': FROM_PA,
  'clientErrors:create': FROM_PA,
  'storeKeys:read': FROM_D,
  'storeKeys:manage': FROM_D,
  'apiKeys:read': FROM_D,
  'apiKeys:manage': FROM_D,
};

describe('permission catalog', () => {
  it('lists the resource:action strings without duplicates', () => {
    const values = Object.values(PERMISSIONS);
    assert.equal(new Set(values).size, values.length);
    assert.equal(ALL_PERMISSIONS.size, values.length);
    assert.deepEqual([...values].sort(), Object.keys(EXPECTED).sort());
    for (const value of values) {
      assert.match(value, /^[a-zA-Z]+:[a-z]+$/);
    }
  });

  it('recognizes permissions and roles', () => {
    assert.equal(isPermission('places:read'), true);
    for (const value of ['places:fly', '', 'toString', 5, null, undefined, {}]) {
      assert.equal(isPermission(value), false);
    }
    for (const role of ROLES) {
      assert.equal(isRole(role), true);
    }
    for (const value of ['API', 'X', 'psa', 5, null]) {
      assert.equal(isRole(value), false);
    }
  });

  it('orders the roles PSA > D > SA > CA > PA > E', () => {
    const ranks = ROLES.map((role) => ROLE_RANK[role]);
    assert.deepEqual(ranks, [...ranks].sort((a, b) => b - a));
    assert.equal(new Set(ranks).size, ROLES.length);
  });
});

describe('role ceiling: full role x permission matrix', () => {
  for (const role of ALL) {
    for (const permission of Object.values(PERMISSIONS)) {
      const allowed = EXPECTED[permission].includes(role);
      it(`${role} ${allowed ? 'has' : 'lacks'} ${permission}`, () => {
        assert.equal(ROLE_CEILING[role].has(permission), allowed);
        assert.equal(hasPermission({ role, permissions: ALL_PERMISSIONS }, permission), allowed);
      });
    }
  }

  it('E has an empty ceiling', () => {
    assert.equal(ROLE_CEILING.E.size, 0);
  });
});

describe('hasPermission', () => {
  it('requires the effective set as well as the ceiling', () => {
    assert.equal(hasPermission({ role: 'SA', permissions: new Set<Permission>() }, 'places:read'), false);
    assert.equal(hasPermission({ role: 'SA', permissions: new Set<Permission>(['places:read']) }, 'places:read'), true);
  });

  it('never exceeds the ceiling even with a corrupted set', () => {
    assert.equal(hasPermission({ role: 'PA', permissions: ALL_PERMISSIONS }, 'groups:trash'), false);
    assert.equal(hasPermission({ role: 'E', permissions: ALL_PERMISSIONS }, 'sessions:read'), false);
  });
});

describe('manageable roles', () => {
  it('follows the product decision', () => {
    assert.deepEqual(MANAGEABLE_ROLES, {
      PSA: ['PSA', 'D', 'SA', 'CA', 'PA', 'E'],
      D: ['SA', 'CA', 'PA', 'E'],
      SA: ['SA', 'CA', 'PA', 'E'],
      CA: ['CA', 'PA', 'E'],
      PA: ['PA', 'E'],
      E: [],
    });
  });

  it('never lets a role manage a stronger one', () => {
    for (const role of ROLES) {
      for (const target of MANAGEABLE_ROLES[role]) {
        assert.ok(ROLE_RANK[target] <= ROLE_RANK[role], `${role} manages ${target}`);
      }
    }
  });
});
