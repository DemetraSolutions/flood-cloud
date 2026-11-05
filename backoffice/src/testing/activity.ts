import { ActivityEntry } from '../app/features/activity-log/activity-log.types';

/** A complete activity log entry for tests; override what the test cares about. */
export function fakeEntry(overrides: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    id: '665f1c2e9b1d4a0012ab3501',
    at: '2026-11-05T09:30:00.000Z',
    category: 'data',
    action: 'user.updated',
    outcome: 'success',
    actor: { kind: 'user', id: '665f1c2e9b1d4a0012ab34ce', role: 'SA', username: 'mario' },
    groupId: '665f1c2e9b1d4a0012ab34a1',
    resource: { type: 'user', id: '665f1c2e9b1d4a0012ab3401' },
    changes: null,
    requestId: 'req-1',
    ip: '10.0.0.1',
    metadata: null,
    ...overrides,
  };
}
