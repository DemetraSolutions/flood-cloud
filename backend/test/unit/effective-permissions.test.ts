import type { ReadOnlySet } from '../../src/shared/security/frozen.ts';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { effectivePermissions } from '../../src/shared/security/rbac/effective-permissions.ts';
import { PERMISSIONS, ROLES } from '../../src/shared/security/rbac/permissions.ts';
import type { Permission } from '../../src/shared/security/rbac/permissions.ts';
import { ROLE_CEILING } from '../../src/shared/security/rbac/policy.ts';

const sorted = (set: ReadOnlySet<Permission>): Permission[] => [...set].sort();
const SESSIONS: Permission[] = ['clientErrors:create', 'profile:read', 'profile:update', 'sessions:read', 'sessions:revoke'];

describe('effectivePermissions (D-06)', () => {
  it('maps r to read and w to every write action, plus own sessions', () => {
    const result = effectivePermissions('PSA', { status: true, groups: { r: true, w: true }, users: { r: true, w: false }, companies: { r: false, w: true }, places: { r: true }, logs: { r: true, w: true } });
    assert.deepEqual(
      sorted(result.permissions),
      [
        'groups:read', 'groups:create', 'groups:update', 'groups:suspend', 'groups:trash',
        'users:read',
        'companies:create', 'companies:update', 'companies:trash',
        'places:read',
        'activityLog:read',
        ...SESSIONS,
      ].sort(),
    );
    assert.equal(result.canManagePermissions, true);
  });

  it('grants nothing but the own sessions for a missing, malformed or non-boolean matrix', () => {
    const bad: unknown[] = [undefined, null, 'x', 5, true, [], [{ r: true }], {}, { groups: null }, { groups: 'rw' }, { groups: [true] }, { groups: { r: 'true', w: 1 } }, { groups: { r: 1 } }, { products: { r: true, w: true } }, { apps: { cash: { status: true } } }];
    for (const value of bad) {
      const result = effectivePermissions('PSA', value);
      assert.deepEqual(sorted(result.permissions), SESSIONS, JSON.stringify(value));
      assert.equal(result.canManagePermissions, false);
    }
  });

  it('keeps the modules as data it does not turn into permissions', () => {
    const result = effectivePermissions('SA', { products: { r: true, w: true }, documents: { r: true } });
    assert.deepEqual(sorted(result.permissions), SESSIONS);
  });

  it('never exceeds the ceiling of the role', () => {
    const everything = { status: true, groups: { r: true, w: true }, users: { r: true, w: true }, companies: { r: true, w: true }, places: { r: true, w: true }, logs: { r: true, w: true } };
    for (const role of ROLES) {
      const { permissions } = effectivePermissions(role, everything);
      for (const permission of permissions) {
        assert.ok(ROLE_CEILING[role].has(permission), `${role} got ${permission}`);
      }
    }
    assert.deepEqual(sorted(effectivePermissions('PA', everything).permissions), ['activityLog:read', 'places:read', 'places:update', 'users:create', 'users:read', 'users:trash', 'users:update', ...SESSIONS].sort());
    assert.equal(effectivePermissions('SA', everything).permissions.has('groups:trash'), false);
    assert.equal(effectivePermissions('CA', everything).permissions.has('companies:create'), false);
  });

  it('grants users:delete with users write only where the role ceiling allows it (D-14)', () => {
    const write = { users: { r: true, w: true } };
    for (const role of ROLES) {
      assert.equal(effectivePermissions(role, write).permissions.has('users:delete'), ['PSA', 'D', 'SA'].includes(role), role);
      assert.equal(effectivePermissions(role, { users: { r: true, w: false } }).permissions.has('users:delete'), false, role);
    }
  });

  it('gives nothing to E, not even sessions or permission management', () => {
    const result = effectivePermissions('E', { status: true, places: { r: true, w: true } });
    assert.equal(result.permissions.size, 0);
    assert.equal(result.canManagePermissions, false);
  });

  it('canManagePermissions needs status === true', () => {
    for (const status of [false, 'true', 1, null, undefined]) {
      assert.equal(effectivePermissions('SA', { status }).canManagePermissions, false);
    }
    assert.equal(effectivePermissions('SA', { status: true }).canManagePermissions, true);
  });

  it('gives nothing, without throwing, to a value that is not a role', () => {
    const everything = { status: true, groups: { r: true, w: true }, users: { r: true, w: true } };
    for (const role of ['API', 'constructor', '__proto__', '', undefined, null, 5, 'psa']) {
      const result = effectivePermissions(role as never, everything);
      assert.equal(result.permissions.size, 0, String(role));
      assert.equal(result.canManagePermissions, false);
    }
  });

  it('never runs getters of the matrix', () => {
    let calls = 0;
    const trap = (): never => {
      calls += 1;
      throw new Error('getter executed');
    };
    const matrix = {
      get status() {
        return trap();
      },
      get groups() {
        return trap();
      },
      users: {
        get r() {
          return trap();
        },
        w: true,
      },
    };
    const result = effectivePermissions('PSA', matrix);
    assert.equal(calls, 0);
    assert.equal(result.canManagePermissions, false);
    assert.deepEqual(sorted(result.permissions), ['clientErrors:create', 'profile:read', 'profile:update', 'sessions:read', 'sessions:revoke', 'users:create', 'users:delete', 'users:trash', 'users:update']);
  });

  it('returns a read-only set', () => {
    const { permissions } = effectivePermissions('PSA', { users: { r: true } });
    assert.throws(() => (permissions as Set<string>).add('groups:trash'), TypeError);
    assert.throws(() => (permissions as Set<string>).delete('users:read'), TypeError);
    assert.throws(() => (permissions as Set<string>).clear(), TypeError);
    assert.equal(permissions.has('users:read'), true);
  });

  it('ignores inherited properties of the matrix', () => {
    const inherited = Object.create({ status: true, groups: { r: true } }) as unknown;
    const result = effectivePermissions('PSA', inherited);
    assert.equal(result.canManagePermissions, false);
    assert.equal(result.permissions.has(PERMISSIONS.GROUPS_READ), false);
  });
});

describe('always granted permissions', () => {
  it('names exactly the own session and profile permissions, and a prefix is not enough', async () => {
    const { ALWAYS_GRANTED_PERMISSIONS, isAlwaysGranted } = await import('../../src/shared/security/rbac/effective-permissions.ts');
    assert.deepEqual([...ALWAYS_GRANTED_PERMISSIONS].sort(), ['clientErrors:create', 'profile:read', 'profile:update', 'sessions:read', 'sessions:revoke']);
    for (const permission of ALWAYS_GRANTED_PERMISSIONS) {
      assert.equal(isAlwaysGranted(permission), true);
    }
    for (const other of ['sessions:purge', 'profile:delete', 'users:read', 'sessions:', '']) {
      assert.equal(isAlwaysGranted(other), false, other);
    }
  });
});
