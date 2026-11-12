import { TestBed } from '@angular/core/testing';
import { SessionService } from '../app/core/session/session.service';
import { Profile } from '../app/core/session/session.types';

/** A complete profile for tests; override what the test cares about. */
export function fakeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: '665f1c2e9b1d4a0012ab34ce',
    username: 'mario.rossi',
    firstName: 'Mario',
    lastName: 'Rossi',
    email: 'mario.rossi@example.com',
    phone: '+39 02 1234567',
    role: 'CA',
    groupId: '665f1c2e9b1d4a0012ab34a1',
    dealerId: null,
    status: 'active',
    language: 'it',
    permissions: ['profile:read', 'profile:update', 'sessions:revoke'],
    canManagePermissions: false,
    passwordChangeRequired: false,
    scope: { kind: 'companies', groupId: '665f1c2e9b1d4a0012ab34a1', companies: 1, places: 2 },
    group: { id: '665f1c2e9b1d4a0012ab34a1', name: 'Gruppo Esempio' },
    groupFeatures: null,
    createdAt: '2025-03-10T08:30:00.000Z',
    updatedAt: '2026-10-01T12:00:00.000Z',
    ...overrides,
  };
}

/** Signs a user in the session of the current TestBed (no HTTP involved). */
export function signIn(overrides: Partial<Profile> = {}): Profile {
  const profile = fakeProfile(overrides);
  TestBed.inject(SessionService).setProfile(profile);
  return profile;
}
