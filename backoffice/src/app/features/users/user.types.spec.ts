import { Role } from '../../core/session/session.types';
import {
  areaOf,
  assignableRoles,
  emptyMatrix,
  fullName,
  inheritedMatrix,
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

describe('inheritedMatrix', () => {
  const all = () => true;
  const none = () => false;
  const flags = (role: Role | '', can: (p: string) => boolean) =>
    Object.values(inheritedMatrix(role as Role, can).modules).map((m) => [m.r, m.w]);

  it.each<[Role, boolean[][]]>([
    [
      'PSA',
      [
        [true, true],
        [true, true],
        [true, true],
        [true, true],
        [true, false],
      ],
    ],
    [
      'D',
      [
        [true, true],
        [true, true],
        [true, true],
        [true, true],
        [true, false],
      ],
    ],
    [
      'SA',
      [
        [true, true],
        [true, true],
        [true, true],
        [true, true],
        [true, false],
      ],
    ],
    [
      'CA',
      [
        [false, false],
        [true, true],
        [true, true],
        [true, true],
        [true, false],
      ],
    ],
    [
      'PA',
      [
        [false, false],
        [true, true],
        [false, false],
        [true, true],
        [true, false],
      ],
    ],
    [
      'E',
      [
        [false, false],
        [false, false],
        [false, false],
        [false, false],
        [false, false],
      ],
    ],
  ])('gives %s the default of the role when the creator holds everything', (role, expected) => {
    expect(flags(role, all)).toEqual(expected);
  });

  it('gives nothing for an unknown role or a creator who holds nothing, and never the manage flag', () => {
    expect(flags('', all).flat().some(Boolean)).toBe(false);
    expect(flags('SA', none).flat().some(Boolean)).toBe(false);
    expect(inheritedMatrix('SA', all).canManagePermissions).toBe(false);
  });

  it('needs every write permission of the module', () => {
    const can = (p: string) => p !== 'users:delete';
    expect(inheritedMatrix('SA', can).modules.users).toEqual({ r: true, w: false });
  });
});
