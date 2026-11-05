import { UserRecord } from '../app/features/users/user.types';

/** A complete user record for tests; override what the test cares about. */
export function fakeUser(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    id: '665f1c2e9b1d4a0012ab34ce',
    username: 'luca.bianchi',
    firstName: 'Luca',
    lastName: 'Bianchi',
    email: 'luca@example.com',
    phone: '+39 02 1',
    role: 'CA',
    groupId: '665f1c2e9b1d4a0012ab34a1',
    dealerId: null,
    companyIds: ['665f1c2e9b1d4a0012ab34b2'],
    placeIds: [],
    status: 'active',
    trashed: false,
    language: 'it',
    permissions: {
      modules: { users: { r: true, w: false }, places: { r: true, w: true } },
      canManagePermissions: false,
    },
    createdAt: '2026-11-04T09:00:00.000Z',
    updatedAt: '2026-11-04T10:00:00.000Z',
    ...overrides,
  };
}
