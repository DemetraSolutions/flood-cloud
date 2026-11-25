import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ObjectId } from 'mongodb';
import { effectivePermissions } from '../../src/shared/security/rbac/effective-permissions.ts';
import { defaultMatrix, flagsOf, normalizeMatrix } from '../../src/shared/security/rbac/permission-matrix.ts';
import type { PermissionMatrix } from '../../src/shared/security/rbac/permission-matrix.ts';
import type { Permission, Role } from '../../src/shared/security/rbac/permissions.ts';
import { ROLES } from '../../src/shared/security/rbac/permissions.ts';
import { ROLE_CEILING } from '../../src/shared/security/rbac/policy.ts';
import { canManageUser, checkUserChange, inheritedMatrix } from '../../src/shared/security/rbac/user-management.ts';
import type { UserChangeView } from '../../src/shared/security/rbac/user-management.ts';
import type { UserScopeView } from '../../src/shared/security/scope/principal.ts';
import { fixtureId } from '../helpers/legacy-fixtures.ts';
import { principalOf } from '../helpers/principal.ts';

const g1 = fixtureId('group', 1);
const g2 = fixtureId('group', 2);
const c1 = fixtureId('company', 1);
const c2 = fixtureId('company', 2);
const p1 = fixtureId('place', 1);
const p2 = fixtureId('place', 2);

const actors = {
  PSA: principalOf('PSA'),
  D: principalOf('D', { dealerGroupIds: [g1] }),
  SA: principalOf('SA', { groupId: g1 }),
  CA: principalOf('CA', { groupId: g1, companyIds: [c1], placeIds: [p1] }),
  PA: principalOf('PA', { groupId: g1, placeIds: [p1] }),
  E: principalOf('E', { groupId: g1, placeIds: [p1] }),
};

/** Who may manage whom (decision of 2026-11-02), as a table independent of the policy code. */
const MANAGES: Record<Role, Role[]> = {
  PSA: ['PSA', 'D', 'SA', 'CA', 'PA', 'E'],
  D: ['SA', 'CA', 'PA', 'E'],
  SA: ['SA', 'CA', 'PA', 'E'],
  CA: ['CA', 'PA', 'E'],
  PA: ['PA', 'E'],
  E: [],
};

let counter = 1000;
/** A user of the given role placed inside every actor's perimeter (group 1, company 1, place 1). */
function target(role: Role, overrides: Partial<UserScopeView> = {}): UserScopeView {
  return { userId: fixtureId('user', counter++), role, groupId: role === 'PSA' || role === 'D' ? null : g1, companyIds: [c1], placeIds: [p1], ...overrides };
}

/** A view built the way the real code builds it: normalized matrix and effective permissions from a legacy value. */
function realView(role: Role, legacy: unknown, overrides: Partial<UserScopeView> = {}): UserChangeView {
  return { ...target(role, overrides), matrix: normalizeMatrix(legacy), permissions: effectivePermissions(role, legacy).permissions };
}

/** The legacy value of a role's default matrix, optionally with changes. */
function legacyOf(role: Role, changes: Record<string, unknown> = {}): Record<string, unknown> {
  const matrix = defaultMatrix(role);
  const legacy: Record<string, unknown> = { status: matrix.status };
  for (const [name, flags] of Object.entries(matrix.modules)) {
    legacy[name] = { r: flags.r, w: flags.w };
  }
  return { ...legacy, ...changes };
}

const defaultView = (role: Role, changes: Record<string, unknown> = {}, overrides: Partial<UserScopeView> = {}): UserChangeView => realView(role, legacyOf(role, changes), overrides);

/** An actor with the given role whose own permissions are the ceiling minus some. */
const actorWithout = (role: 'SA' | 'CA' | 'PA', removed: Permission[], extra: { canManagePermissions?: boolean; matrix?: PermissionMatrix } = {}) => {
  const base = actors[role];
  return { ...base, permissions: new Set([...ROLE_CEILING[role]].filter((permission) => !removed.includes(permission))), ...extra };
};

describe('canManageUser: every actor role against every target role (inside the perimeter)', () => {
  for (const actor of ROLES) {
    for (const role of ROLES) {
      const allowed = MANAGES[actor].includes(role);
      it(`${actor} ${allowed ? 'manages' : 'does not manage'} ${role}`, () => {
        // PSA and D targets have no group; D and PSA are the only actors who might reach them.
        assert.equal(canManageUser(actors[actor], target(role, role === 'PSA' || role === 'D' ? { groupId: g1 } : {})), allowed);
      });
    }
  }
});

describe('canManageUser: perimeter', () => {
  it('never lets anybody manage himself, not even PSA', () => {
    for (const role of ROLES) {
      const actor = actors[role];
      assert.equal(canManageUser(actor, { userId: actor.userId, role, groupId: g1, companyIds: [c1], placeIds: [p1] }), false);
    }
  });

  it('PSA reaches every group, also without group', () => {
    assert.equal(canManageUser(actors.PSA, target('SA', { groupId: g2 })), true);
    assert.equal(canManageUser(actors.PSA, target('D')), true);
  });

  it('D reaches only the groups of the dealer', () => {
    assert.equal(canManageUser(actors.D, target('SA', { groupId: g1 })), true);
    assert.equal(canManageUser(actors.D, target('SA', { groupId: g2 })), false);
    assert.equal(canManageUser(actors.D, target('SA', { groupId: null })), false);
  });

  it('SA reaches only his group', () => {
    assert.equal(canManageUser(actors.SA, target('CA', { groupId: g2 })), false);
    assert.equal(canManageUser(actors.SA, target('CA', { groupId: null })), false);
    assert.equal(canManageUser(actors.SA, target('E', { companyIds: [], placeIds: [] })), true);
  });

  it('CA manages a CA through the companies, all of which must be his', () => {
    assert.equal(canManageUser(actors.CA, target('CA', { companyIds: [c1] })), true);
    assert.equal(canManageUser(actors.CA, target('CA', { companyIds: [c2, c1] })), false);
    assert.equal(canManageUser(actors.CA, target('CA', { companyIds: [c2] })), false);
    assert.equal(canManageUser(actors.CA, target('CA', { companyIds: [] })), false);
    assert.equal(canManageUser(actors.CA, target('CA', { groupId: g2 })), false);
    assert.equal(canManageUser(actors.CA, target('CA', { groupId: null })), false);
  });

  it('CA manages a PA or E through the places of his companies, ignoring the legacy companyId', () => {
    for (const role of ['PA', 'E'] as const) {
      assert.equal(canManageUser(actors.CA, target(role, { companyIds: [], placeIds: [p1] })), true, `${role} without companyId`);
      assert.equal(canManageUser(actors.CA, target(role, { companyIds: [c2], placeIds: [p1] })), true, `${role} with a foreign companyId`);
      assert.equal(canManageUser(actors.CA, target(role, { placeIds: [p1, p2] })), false);
      assert.equal(canManageUser(actors.CA, target(role, { placeIds: [p2] })), false);
      assert.equal(canManageUser(actors.CA, target(role, { placeIds: [] })), false);
      assert.equal(canManageUser(actors.CA, target(role, { groupId: g2 })), false);
      assert.equal(canManageUser(actors.CA, target(role, { groupId: null })), false);
    }
  });

  it('a CA whose companies have no places (or dangling references) manages no PA or E', () => {
    const orphan = principalOf('CA', { groupId: g1, companyIds: [c2], placeIds: [] });
    assert.equal(canManageUser(orphan, target('PA')), false);
    assert.equal(canManageUser(orphan, target('CA', { companyIds: [c2] })), true);
  });

  it('PA needs every place of the target to be his, and some', () => {
    assert.equal(canManageUser(actors.PA, target('E', { placeIds: [p1] })), true);
    assert.equal(canManageUser(actors.PA, target('E', { placeIds: [p1, p2] })), false);
    assert.equal(canManageUser(actors.PA, target('PA', { placeIds: [p2] })), false);
    assert.equal(canManageUser(actors.PA, target('E', { placeIds: [] })), false);
    assert.equal(canManageUser(actors.PA, target('E', { groupId: g2 })), false);
    assert.equal(canManageUser(actors.PA, target('E', { groupId: null })), false);
  });

  it('E manages nobody, even in his own perimeter', () => {
    assert.equal(canManageUser(actors.E, target('E')), false);
  });

  it('a principal without a usable scope, or with a corrupt role, manages nobody', () => {
    assert.equal(canManageUser({ ...actors.SA, scope: { kind: 'none' } }, target('E')), false);
    assert.equal(canManageUser({ ...actors.SA, role: 'API' as never }, target('E')), false);
  });
});

describe('checkUserChange: rank, perimeter, self', () => {
  const sa = actors.SA;
  const ca = actors.CA;

  it('allows creating and updating a manageable user inside the perimeter', () => {
    assert.deepEqual(checkUserChange(sa, null, defaultView('CA')), []);
    const before = defaultView('PA');
    assert.deepEqual(checkUserChange(sa, before, { ...before }), []);
  });

  it('rejects any change of the actor himself', () => {
    const own = defaultView('SA', {}, { userId: sa.userId });
    assert.ok(checkUserChange(sa, own, own).includes('selfChange'));
    const promoted = defaultView('PSA', {}, { userId: sa.userId });
    const violations = checkUserChange(sa, own, promoted);
    assert.ok(violations.includes('selfChange') && violations.includes('roleNotManageable'));
  });

  it('rejects promoting beyond the actor rank', () => {
    const before = defaultView('PA');
    assert.ok(checkUserChange(ca, before, { ...before, role: 'SA' }).includes('roleNotManageable'));
    assert.ok(checkUserChange(ca, null, defaultView('SA')).includes('roleNotManageable'));
    assert.deepEqual(checkUserChange(actors.D, null, defaultView('D', {}, { groupId: g1 })), ['roleNotManageable']);
  });

  it('rejects touching a user stronger than the actor, whatever he becomes', () => {
    const before = defaultView('SA');
    assert.deepEqual(checkUserChange(ca, before, { ...before, role: 'PA' }), ['roleNotManageable']);
  });

  it('allows demotion of a manageable user', () => {
    const before = defaultView('CA');
    assert.deepEqual(checkUserChange(sa, before, { ...before, role: 'PA' }), []);
  });

  it('rejects moving a user out of the perimeter, or editing one outside it', () => {
    const before = defaultView('PA');
    assert.deepEqual(checkUserChange(sa, before, { ...before, groupId: g2 }), ['outOfScope']);
    assert.deepEqual(checkUserChange(sa, defaultView('PA', {}, { groupId: g2 }), defaultView('PA', {}, { groupId: g1 })), ['outOfScope']);
    assert.deepEqual(checkUserChange(ca, defaultView('PA'), defaultView('PA', {}, { placeIds: [p1, p2] })), ['outOfScope']);
    assert.deepEqual(checkUserChange(actors.PA, defaultView('E'), defaultView('E', {}, { placeIds: [p1, p2] })), ['outOfScope']);
    // A D holds every flag of the matrix (D-10): only the perimeter is reported.
    assert.deepEqual(checkUserChange(actors.D, null, defaultView('SA', {}, { groupId: g2 })), ['outOfScope']);
  });

  it('reports every violation at once, without duplicates', () => {
    const before = defaultView('SA', {}, { groupId: g2 });
    const violations = checkUserChange(ca, before, { ...before, role: 'PA' });
    assert.deepEqual(violations.sort(), ['outOfScope', 'roleNotManageable']);
  });

  it('ids compare by value, not by reference', () => {
    const copy = (id: ObjectId): ObjectId => fixtureId('place', Number.parseInt(id.toHexString().slice(2), 16));
    assert.deepEqual(checkUserChange(ca, null, defaultView('PA', {}, { placeIds: [copy(p1)] })), []);
  });
});

describe('checkUserChange: permissions and matrix', () => {
  const sa = actors.SA;

  it('rejects effective permissions newly granted that the actor does not hold, alone', () => {
    // The actor changes the role only: the matrix stays the same, but the new role grants more.
    const limited = actorWithout('SA', ['companies:update'], { canManagePermissions: false });
    // The matrix of a PA that has the companies module on: it grants nothing to a PA (his ceiling has no companies), and a CA with the same matrix gets the companies permissions.
    const before = defaultView('PA', { companies: { r: true, w: true } });
    const after = realView('CA', legacyOf('PA', { companies: { r: true, w: true } }), { userId: before.userId });
    assert.deepEqual(checkUserChange(limited, before, after), ['permissionNotHeld']);
    assert.deepEqual(checkUserChange(sa, before, after), []);
  });

  it('judges only the newly granted permissions', () => {
    const limited = actorWithout('SA', ['places:trash']);
    const before = defaultView('CA');
    assert.deepEqual(checkUserChange(limited, before, { ...before }), []);
  });

  it('does not compare the sessions of the user himself', () => {
    const noSessions = actorWithout('SA', ['sessions:read', 'sessions:revoke', 'profile:read', 'profile:update']);
    const after: UserChangeView = { ...defaultView('PA'), permissions: new Set<Permission>(['sessions:read', 'sessions:revoke', 'profile:read', 'profile:update', 'users:read']) };
    assert.deepEqual(checkUserChange(noSessions, null, after), []);
  });

  it('requires the actor to hold every flag that turns on: core modules', () => {
    // A CA has no groups module: he cannot hand it out, even to someone whose role ignores it.
    const withGroups = defaultView('PA', { groups: { r: true, w: false } });
    assert.deepEqual(checkUserChange(actors.CA, null, withGroups), ['permissionNotHeld']);
    assert.deepEqual(checkUserChange(actors.SA, null, withGroups), []);
    // Read only is not write.
    const readOnly = actorWithout('SA', ['places:update', 'places:create', 'places:trash']);
    assert.deepEqual(checkUserChange(readOnly, null, defaultView('PA', { places: { r: true, w: true } })), ['permissionNotHeld']);
    assert.deepEqual(checkUserChange(readOnly, null, defaultView('PA', { places: { r: true, w: false } })), []);
    // Logs have a read flag only: nobody can grant logs.w.
    assert.deepEqual(checkUserChange(sa, null, defaultView('PA', { logs: { r: true, w: true } })), ['permissionNotHeld']);
  });

  it('requires the actor to hold the documents flags: the read one through sales:read, the write one (which grants nothing) through his own matrix', () => {
    const view = (flags: { r: boolean; w: boolean }) => defaultView('PA', { documents: flags });
    // The default matrix of an SA has documents r/w: he hands out both.
    assert.deepEqual(checkUserChange(actors.SA, null, view({ r: true, w: true })), []);
    // Without sales:read he cannot hand out the read; without his own write flag, not the write.
    assert.deepEqual(checkUserChange(actorWithout('SA', ['sales:read']), null, view({ r: true, w: false })), ['permissionNotHeld']);
    const readOnly = { ...actors.SA, matrix: normalizeMatrix(legacyOf('SA', { documents: { r: true, w: false } })) };
    assert.deepEqual(checkUserChange(readOnly, null, view({ r: true, w: false })), []);
    assert.deepEqual(checkUserChange(readOnly, null, view({ r: true, w: true })), ['permissionNotHeld']);
    // The inherited matrix follows the same rule.
    assert.deepEqual(flagsOf(inheritedMatrix(readOnly, 'PA'), 'documents'), { r: true, w: false });
    assert.deepEqual(flagsOf(inheritedMatrix(actors.SA, 'PA'), 'documents'), { r: true, w: true });
  });

  it('requires the actor to hold every flag that turns on: the fidelity and products modules', () => {
    for (const module of ['fidelity', 'products'] as const) {
      const [read, write] = module === 'fidelity' ? (['fidelity:read', 'fidelity:update'] as const) : (['products:read', 'products:update'] as const);
      // An actor without the module cannot hand it out, in read or in write; one with read only cannot hand out the write.
      const without = actorWithout('SA', [read, write]);
      assert.deepEqual(checkUserChange(without, null, defaultView('PA', { [module]: { r: true, w: false } })), ['permissionNotHeld'], module);
      const readOnly = actorWithout('CA', [write]);
      assert.deepEqual(checkUserChange(readOnly, null, defaultView('PA', { [module]: { r: true, w: false } })), [], module);
      assert.deepEqual(checkUserChange(readOnly, null, defaultView('PA', { [module]: { r: true, w: true } })), ['permissionNotHeld'], module);
      // The holder can, and the permissions then become effective for the role.
      const view = defaultView('PA', { [module]: { r: true, w: true } });
      assert.deepEqual(checkUserChange(actors.PA, null, view), []);
      assert.equal([read, write].every((permission) => view.permissions.has(permission)), true, module);
    }
    // The defaults of the legacy form: products for SA, CA and PA; fidelity for the SA alone.
    const RW = { r: true, w: true };
    const NONE = { r: false, w: false };
    const expected = { PSA: [NONE, NONE], D: [NONE, NONE], SA: [RW, RW], CA: [NONE, RW], PA: [NONE, RW] } as const;
    for (const role of ['PSA', 'D', 'SA', 'CA', 'PA'] as const) {
      assert.deepEqual([flagsOf(defaultMatrix(role), 'fidelity'), flagsOf(defaultMatrix(role), 'products')], expected[role], role);
    }
  });

  it('requires the actor to hold every flag that turns on: non-core modules use his raw flag', () => {
    const stats = defaultView('PA', { stats: { r: true, w: true } });
    // The default SA holds stats read only (the legacy form never gives the write flag).
    assert.deepEqual(checkUserChange(sa, null, stats), ['permissionNotHeld']);
    const holder = principalOf('SA', { groupId: g1, matrix: normalizeMatrix({ ...legacyOf('SA'), stats: { r: true, w: true } }) });
    assert.deepEqual(checkUserChange(holder, null, stats), []);
    // The raw flag is read and write apart.
    const readOnly = principalOf('SA', { groupId: g1, matrix: normalizeMatrix({ ...legacyOf('SA'), settings: { r: true, w: false } }) });
    assert.deepEqual(checkUserChange(readOnly, null, defaultView('PA', { settings: { r: true, w: true } })), ['permissionNotHeld']);
    assert.deepEqual(checkUserChange(readOnly, null, defaultView('PA', { settings: { r: true, w: false } })), []);
    // Keeping a flag the actor lacks is fine: only flags that turn on count.
    const before = defaultView('PA', { stats: { r: true, w: true } });
    assert.deepEqual(checkUserChange(sa, before, { ...before }), []);
  });

  it('changing the stored matrix, non-core modules and status included, needs canManagePermissions', () => {
    const noManage = { ...sa, canManagePermissions: false };
    const before = defaultView('PA', { stats: { r: true, w: true } });
    // Effective permissions do not change at all, but the stored matrix does.
    const changed = defaultView('PA', { stats: { r: false, w: true } }, { userId: before.userId });
    assert.deepEqual(checkUserChange(noManage, before, changed), ['cannotManagePermissions']);
    assert.deepEqual(checkUserChange(sa, before, changed), []);
    const dropped = defaultView('PA', {}, { userId: before.userId });
    assert.deepEqual(checkUserChange(noManage, before, dropped), ['cannotManagePermissions']);
    // An unchanged matrix needs nothing.
    assert.deepEqual(checkUserChange(noManage, before, { ...before }), []);
    // A core flag turned off is a change too.
    const narrower = defaultView('PA', { places: { r: true, w: false }, stats: { r: true, w: true } }, { userId: before.userId });
    assert.deepEqual(checkUserChange(noManage, before, narrower), ['cannotManagePermissions']);
  });

  it('turning status on needs the actor to hold it, off needs canManagePermissions', () => {
    const noManage = { ...sa, canManagePermissions: false };
    const before = defaultView('PA');
    const granting = defaultView('PA', { status: true }, { userId: before.userId });
    assert.deepEqual(checkUserChange(noManage, before, granting), ['cannotManagePermissions']);
    assert.deepEqual(checkUserChange(noManage, null, granting), ['cannotManagePermissions']);
    assert.deepEqual(checkUserChange(sa, before, granting), []);
    assert.deepEqual(checkUserChange(sa, null, granting), []);
    assert.deepEqual(checkUserChange(noManage, granting, before), ['cannotManagePermissions']);
    assert.deepEqual(checkUserChange(sa, granting, before), []);
    assert.deepEqual(checkUserChange(noManage, granting, { ...granting }), []);
  });

  it('a creation by an actor without canManagePermissions gets the role default limited to his flags', () => {
    const noManage = { ...sa, canManagePermissions: false };
    assert.deepEqual(checkUserChange(noManage, null, defaultView('PA')), []);
    assert.deepEqual(checkUserChange(noManage, null, defaultView('E')), []);
    assert.deepEqual(checkUserChange(noManage, null, defaultView('PA', { places: { r: true, w: false } })), ['cannotManagePermissions']);
    assert.deepEqual(checkUserChange(noManage, null, defaultView('PA', { stats: { r: true, w: true } })).sort(), ['cannotManagePermissions', 'permissionNotHeld']);
    // The actor lacks places write: the default is limited, and the limited matrix is what is allowed.
    const noPlacesWrite = { ...actorWithout('SA', ['places:create', 'places:update', 'places:trash']), canManagePermissions: false };
    assert.deepEqual(checkUserChange(noPlacesWrite, null, defaultView('PA', { places: { r: true, w: false } })), []);
    assert.deepEqual(checkUserChange(noPlacesWrite, null, defaultView('PA')).sort(), ['cannotManagePermissions', 'permissionNotHeld']);
    // A CA creating a PA: no groups in the default of a PA anyway; companies is not part of it.
    assert.deepEqual(checkUserChange({ ...actors.CA, canManagePermissions: false }, null, defaultView('PA')), []);
  });

  it('with canManagePermissions the actor customizes the matrix within his own flags', () => {
    assert.deepEqual(checkUserChange(sa, null, defaultView('PA', { places: { r: true, w: false }, users: { r: false, w: false } })), []);
    assert.deepEqual(checkUserChange(sa, null, defaultView('PA', { users: { r: true, w: true }, companies: { r: true, w: true } })), []);
  });
});

describe('checkUserChange on views produced by effectivePermissions', () => {
  it('lets an SA with the default matrix create every role he manages with its own default', () => {
    for (const role of MANAGES.SA) {
      assert.deepEqual(checkUserChange(actors.SA, null, defaultView(role)), [], role);
      assert.deepEqual(checkUserChange({ ...actors.SA, canManagePermissions: false }, null, defaultView(role)), [], `${role} without canManagePermissions`);
    }
  });

  it('refuses every role above the actor with the actor own default as target', () => {
    for (const actor of ['SA', 'CA', 'PA'] as const) {
      for (const role of ROLES.filter((candidate) => !MANAGES[actor].includes(candidate))) {
        assert.ok(checkUserChange(actors[actor], null, defaultView(role)).includes('roleNotManageable'), `${actor} -> ${role}`);
      }
    }
  });

  it('a legacy matrix full of garbage produces a view that grants nothing', () => {
    const garbage = realView('PA', { status: 'yes', users: 'rw', places: [true], logs: null });
    assert.equal(garbage.matrix.status, false);
    assert.deepEqual([...garbage.permissions].sort(), ['clientErrors:create', 'profile:read', 'profile:update', 'sessions:read', 'sessions:revoke']);
    assert.deepEqual(checkUserChange(actors.SA, null, garbage), []);
  });
});

describe('the dealers:* permissions ride on the groups module but belong to the PSA alone', () => {
  it('a D with groups r/w creates an SA who inherits groups.r and groups.w, with no violation', () => {
    const inherited = inheritedMatrix(actors.D, 'SA');
    const view = realView('SA', { status: false, ...Object.fromEntries(Object.entries(inherited.modules).map(([name, flags]) => [name, { r: flags.r, w: flags.w }])) });
    assert.deepEqual(checkUserChange(actors.D, null, view), []);
    assert.deepEqual(flagsOf(inherited, 'groups'), { r: true, w: true });
    // A D holds every flag of the matrix (D-10), the operational modules included: the whole default of the role is inherited.
    assert.deepEqual(flagsOf(inherited, 'documents'), { r: true, w: true });
    assert.deepEqual(inherited.modules, defaultMatrix('SA').modules);
    assert.deepEqual(checkUserChange(actors.D, null, defaultView('SA')), []);
  });

  it('inheritedMatrix(D, SA) holds groups.r', () => {
    assert.equal(flagsOf(inheritedMatrix(actors.D, 'SA'), 'groups').r, true);
  });

  it('a PSA holds every flag whatever his own matrix (D-10): he turns groups.w on for another PSA, whose permissions do not change', () => {
    const before = defaultView('PSA', { groups: { r: true, w: false } });
    const after = { ...realView('PSA', legacyOf('PSA', { groups: { r: true, w: true } })), userId: before.userId };
    assert.deepEqual(checkUserChange(actors.PSA, before, after), []);
    assert.deepEqual([...after.permissions].sort(), [...before.permissions].sort());
  });

  it('an SA who turns groups.w on for an SA grants groups:update only, never a dealers:* permission', () => {
    const before = defaultView('SA', { groups: { r: true, w: false } });
    const after = { ...realView('SA', legacyOf('SA', { groups: { r: true, w: true } })), userId: before.userId };
    assert.deepEqual(checkUserChange(actors.SA, before, after), []);
    assert.deepEqual([...after.permissions].filter((permission) => permission.startsWith('groups:') || permission.startsWith('dealers:')).sort(), ['groups:read', 'groups:update']);
    assert.deepEqual([...before.permissions].filter((permission) => permission.startsWith('groups:')), ['groups:read']);
  });
});
