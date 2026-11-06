import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { frozenArray, frozenSet } from '../../src/shared/security/frozen.ts';
import { EMPTY_MATRIX, defaultMatrix, flagsOf, matricesEqual, normalizeMatrix } from '../../src/shared/security/rbac/permission-matrix.ts';
import { ALL_PERMISSIONS, PERMISSIONS, ROLES, ROLE_RANK } from '../../src/shared/security/rbac/permissions.ts';
import { MANAGEABLE_ROLES, ROLE_CEILING, ceilingOf, manageableRoles } from '../../src/shared/security/rbac/policy.ts';

describe('normalizeMatrix', () => {
  it('keeps only strictly true flags, core and non-core modules alike, and drops apps', () => {
    const matrix = normalizeMatrix({
      status: true,
      groups: { r: true, w: false },
      stats: { r: true, w: true },
      documents: { r: 'true', w: 1 },
      apps: { cash: { status: true, sub: { discounts: true } } },
      logs: { w: true },
    });
    assert.equal(matrix.status, true);
    assert.deepEqual(Object.keys(matrix.modules).sort(), ['groups', 'logs', 'stats']);
    // A module with an explicit false flag is represented too, so true -> false is never invisible.
    const explicit = normalizeMatrix({ users: { r: false, w: false }, places: { r: false } });
    assert.deepEqual(Object.keys(explicit.modules).sort(), ['places', 'users']);
    assert.deepEqual(explicit.modules['users'], { r: false, w: false });
    assert.deepEqual(flagsOf(matrix, 'stats'), { r: true, w: true });
    assert.deepEqual(flagsOf(matrix, 'groups'), { r: true, w: false });
    assert.deepEqual(flagsOf(matrix, 'documents'), { r: false, w: false });
  });

  it('gives the empty matrix for anything that is not a plain object', () => {
    for (const value of [undefined, null, 'x', 5, true, [], [{ r: true }]]) {
      assert.equal(normalizeMatrix(value), EMPTY_MATRIX);
    }
    assert.equal(normalizeMatrix({}).status, false);
    assert.deepEqual(Object.keys(normalizeMatrix({ groups: 'rw', users: [true], places: null }).modules), []);
  });

  it('is frozen and safe against prototype keys', () => {
    const hostile = JSON.parse('{"__proto__": {"r": true}, "constructor": {"r": true}, "toString": {"w": true}}') as unknown;
    const matrix = normalizeMatrix(hostile);
    assert.ok(Object.isFrozen(matrix) && Object.isFrozen(matrix.modules));
    assert.equal(Object.getPrototypeOf(matrix.modules), null);
    assert.deepEqual(flagsOf(matrix, 'constructor'), { r: true, w: false });
    assert.deepEqual(flagsOf(EMPTY_MATRIX, 'constructor'), { r: false, w: false });
    assert.deepEqual(flagsOf(EMPTY_MATRIX, '__proto__'), { r: false, w: false });
  });
});

describe('matricesEqual', () => {
  it('compares flags and status, absent equal to all-false', () => {
    assert.equal(matricesEqual(normalizeMatrix({ users: { r: true } }), normalizeMatrix({ users: { r: true, w: false }, places: { r: false } })), true);
    assert.equal(matricesEqual(normalizeMatrix({ users: { r: true } }), normalizeMatrix({ users: { w: true } })), false);
    assert.equal(matricesEqual(normalizeMatrix({ users: { r: true } }), normalizeMatrix({ users: { r: true, w: true } })), false);
    assert.equal(matricesEqual(normalizeMatrix({ users: { r: true } }), EMPTY_MATRIX), false);
    assert.equal(matricesEqual(EMPTY_MATRIX, normalizeMatrix({ stats: { r: true } })), false);
    assert.equal(matricesEqual(normalizeMatrix({ status: true }), EMPTY_MATRIX), false);
    assert.equal(matricesEqual(EMPTY_MATRIX, normalizeMatrix({})), true);
  });
});

describe('defaultMatrix', () => {
  /** The table A3 of the legacy analysis, written by hand: `rw`, `r` or `-` for PSA and D, SA, CA, PA, E. */
  const TABLE: Record<string, string[]> = {
    groups: ['rw', 'rw', '-', '-', '-'],
    users: ['rw', 'rw', 'rw', 'rw', '-'],
    companies: ['rw', 'rw', 'rw', '-', '-'],
    places: ['rw', 'rw', 'rw', 'rw', 'r'],
    documents: ['-', 'rw', 'rw', 'rw', '-'],
    products: ['-', 'rw', 'rw', 'rw', 'r'],
    calendar: ['-', 'rw', 'rw', 'rw', '-'],
    warehouse: ['-', 'rw', 'rw', 'rw', '-'],
    contacts: ['-', 'rw', 'rw', 'rw', 'rw'],
    fidelity: ['-', 'rw', '-', '-', '-'],
    settings: ['-', 'rw', '-', '-', '-'],
    stats: ['-', 'r', 'r', 'r', '-'],
    logs: ['r', 'r', 'r', 'r', '-'],
  };
  const COLUMNS = ['PSA', 'SA', 'CA', 'PA', 'E'] as const;

  it('follows the legacy form for every module and role', () => {
    for (const [index, role] of [...COLUMNS].entries()) {
      for (const role2 of role === 'PSA' ? (['PSA', 'D'] as const) : [role]) {
        const matrix = defaultMatrix(role2);
        assert.equal(matrix.status, false);
        assert.deepEqual(Object.keys(matrix.modules).sort(), Object.keys(TABLE).sort());
        for (const [module, cells] of Object.entries(TABLE)) {
          const cell = cells[index]!;
          assert.deepEqual(flagsOf(matrix, module), { r: cell !== '-', w: cell === 'rw' }, `${role2} ${module}`);
        }
      }
    }
  });

  it('gives nothing to a value that is not a role', () => {
    assert.equal(defaultMatrix('API' as never), EMPTY_MATRIX);
  });
});

describe('immutability of the policy data', () => {
  it('freezes the role tables and their values', () => {
    for (const table of [ROLE_CEILING, MANAGEABLE_ROLES, ROLE_RANK, PERMISSIONS, ROLES]) {
      assert.ok(Object.isFrozen(table));
    }
    for (const role of ROLES) {
      assert.ok(Object.isFrozen(MANAGEABLE_ROLES[role]));
      assert.throws(() => (MANAGEABLE_ROLES[role] as string[]).push('PSA'), TypeError);
      assert.throws(() => (ROLE_CEILING[role] as Set<string>).add('groups:trash'), TypeError);
      assert.throws(() => (ROLE_CEILING[role] as Set<string>).delete('users:read'), TypeError);
      assert.throws(() => (ROLE_CEILING[role] as Set<string>).clear(), TypeError);
    }
    assert.throws(() => (ALL_PERMISSIONS as Set<string>).add('x'), TypeError);
    assert.throws(() => {
      (ROLE_CEILING as Record<string, unknown>)['PA'] = new Set();
    }, TypeError);
    assert.equal(ROLE_CEILING.PA.has('groups:trash'), false);
  });

  it('survives an attempt to mutate through the lookups', () => {
    assert.equal(ceilingOf('API'), ROLE_CEILING.E);
    assert.equal(ceilingOf('constructor').size, 0);
    assert.deepEqual(manageableRoles('API'), []);
    assert.deepEqual(manageableRoles('SA'), ['SA', 'CA', 'PA', 'E']);
  });

  it('frozenSet copies its input and frozenArray freezes a copy', () => {
    const source = [1, 2];
    const set = frozenSet(source);
    source.push(3);
    assert.equal(set.size, 2);
    assert.deepEqual([...set], [1, 2]);
    assert.deepEqual([...set.values()], [1, 2]);
    assert.deepEqual(Array.from(set), [1, 2]);
    assert.equal(frozenSet().size, 0);
    const array = frozenArray(source);
    assert.ok(Object.isFrozen(array));
    assert.deepEqual(array, [1, 2, 3]);
  });
});

describe('who holds the sensitive permissions', () => {
  it('only PSA can suspend or trash a group', () => {
    for (const role of ROLES) {
      assert.equal(ROLE_CEILING[role].has(PERMISSIONS.GROUPS_SUSPEND), role === 'PSA', role);
      assert.equal(ROLE_CEILING[role].has(PERMISSIONS.GROUPS_TRASH), role === 'PSA', role);
    }
  });
});
