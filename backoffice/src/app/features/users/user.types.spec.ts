import { Role } from '../../core/session/session.types';
import {
  areaOf,
  assignableRoles,
  canGrantFlag,
  PERMISSION_MODULES,
  emptyMatrix,
  fullName,
  matrixOf,
  scopeKindOf,
  userRoute,
} from './user.types';
import { fakeUser } from '../../../testing/users';

describe('scopeKindOf', () => {
  it.each<[Role | '', string]>([
    ['CA', 'companies'],
    ['PA', 'places'],
    ['E', 'places'],
    ['SA', 'none'],
    ['PSA', 'none'],
    ['D', 'none'],
    ['', 'none'],
  ])('%s -> %s', (role, kind) => {
    expect(scopeKindOf(role)).toBe(kind);
  });
});

describe('assignableRoles', () => {
  const group = { kind: 'group', groupId: 'g' } as const;
  const platform = { kind: 'platform' } as const;

  it.each<[Role, Role[]]>([
    ['PSA', ['SA', 'CA', 'PA', 'E']],
    ['D', ['SA', 'CA', 'PA', 'E']],
    ['SA', ['SA', 'CA', 'PA', 'E']],
    ['CA', ['CA', 'PA', 'E']],
    ['PA', ['PA', 'E']],
    ['E', []],
  ])('%s in a group', (actor, roles) => {
    expect(assignableRoles(actor, group)).toEqual(roles);
  });

  it('only the PSA manages platform users', () => {
    expect(assignableRoles('PSA', platform)).toEqual(['PSA', 'D']);
    expect(assignableRoles('D', platform)).toEqual([]);
  });
});

describe('matrices', () => {
  it('has the 13 modules, logs last', () => {
    expect(PERMISSION_MODULES).toHaveLength(13);
    expect(PERMISSION_MODULES.at(-1)).toBe('logs');
    expect(Object.keys(emptyMatrix().modules)).toEqual([...PERMISSION_MODULES]);
  });

  it('never grants write on logs, even when the stored data says so', () => {
    const user = fakeUser({
      permissions: { modules: { logs: { r: true, w: true }, users: { r: true, w: true } } },
    });
    const matrix = matrixOf(user);
    expect(matrix.modules.logs).toEqual({ r: true, w: false });
    expect(matrix.modules.users).toEqual({ r: true, w: true });
  });

  it('starts with nothing granted', () => {
    const matrix = emptyMatrix();
    expect(matrix.canManagePermissions).toBe(false);
    expect(Object.values(matrix.modules).every((m) => !m.r && !m.w)).toBe(true);
  });

  it('reads the stored flags, treating missing ones as not granted', () => {
    const matrix = matrixOf(fakeUser());
    expect(matrix.modules.users).toEqual({ r: true, w: false });
    expect(matrix.modules.places).toEqual({ r: true, w: true });
    expect(matrix.modules.logs).toEqual({ r: false, w: false });
    expect(matrixOf(fakeUser({ permissions: {} })).modules.users).toEqual({ r: false, w: false });
    expect(
      matrixOf(fakeUser({ permissions: { canManagePermissions: true } })).canManagePermissions,
    ).toBe(true);
  });
});

describe('user helpers', () => {
  it('derives the area and the route from the group', () => {
    expect(areaOf(fakeUser())).toEqual({ kind: 'group', groupId: '665f1c2e9b1d4a0012ab34a1' });
    expect(areaOf({ groupId: null })).toEqual({ kind: 'platform' });
    expect(userRoute(fakeUser())).toEqual([
      '/groups',
      '665f1c2e9b1d4a0012ab34a1',
      'users',
      '665f1c2e9b1d4a0012ab34ce',
    ]);
    expect(userRoute({ id: 'u', groupId: null })).toEqual(['/platform', 'users', 'u']);
  });

  it('joins the names that exist', () => {
    expect(fullName(fakeUser())).toBe('Luca Bianchi');
    expect(fullName(fakeUser({ firstName: null }))).toBe('Bianchi');
    expect(fullName(fakeUser({ firstName: null, lastName: '' }))).toBeNull();
  });
});

describe('canGrantFlag', () => {
  const holds =
    (...held: string[]) =>
    (permission: string) =>
      held.includes(permission);
  const none = holds();

  it('lets the PSA and D grant everything', () => {
    for (const actor of ['PSA', 'D'] as const) {
      expect(canGrantFlag(actor, none, 'users', 'w')).toBe(true);
      expect(canGrantFlag(actor, none, 'logs', 'r')).toBe(true);
    }
  });

  it('leaves the modules without permissions to the server', () => {
    expect(canGrantFlag('CA', none, 'calendar', 'r')).toBe(true);
    expect(canGrantFlag('PA', none, 'stats', 'w')).toBe(true);
  });

  it('needs the read permission for the read flag', () => {
    expect(canGrantFlag('CA', holds('users:read'), 'users', 'r')).toBe(true);
    expect(canGrantFlag('CA', none, 'users', 'r')).toBe(false);
    expect(canGrantFlag('SA', holds('activityLog:read'), 'logs', 'r')).toBe(true);
  });

  it('needs every write permission of the module for the write flag', () => {
    const all = ['products:update'];
    expect(canGrantFlag('CA', holds(...all), 'products', 'w')).toBe(true);
    expect(canGrantFlag('CA', none, 'products', 'w')).toBe(false);
    const partial = holds('users:create', 'users:update', 'users:trash');
    expect(canGrantFlag('CA', partial, 'users', 'w')).toBe(false);
    const full = holds('users:create', 'users:update', 'users:trash', 'users:delete');
    expect(canGrantFlag('CA', full, 'users', 'w')).toBe(true);
  });

  it('never allows write on logs to a non-PSA actor', () => {
    expect(canGrantFlag('SA', holds('activityLog:read'), 'logs', 'w')).toBe(false);
  });
});
