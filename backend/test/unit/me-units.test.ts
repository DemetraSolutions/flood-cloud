import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { createMeService } from '../../src/modules/me/me.service.ts';
import type { MeServiceDeps } from '../../src/modules/me/me.service.ts';
import { MAX_SCOPE_SUMMARY_IDS, summarizeScope } from '../../src/modules/me/profile.ts';
import type { UsersRepository } from '../../src/modules/users/users.repository.ts';
import type { MappedUser } from '../../src/modules/users/user.types.ts';
import { legacyPasswordHash } from '../../src/shared/security/legacy-password.ts';
import { Secret } from '../../src/shared/security/secret.ts';
import { memoryActivityLog } from '../helpers/activity.ts';
import { principalOf } from '../helpers/principal.ts';
import { fixtureId, legacyUser } from '../helpers/legacy-fixtures.ts';
import { fromLegacy } from '../../src/modules/users/user.mapper.ts';
import type { LegacyUserDocument } from '../../src/modules/users/user.types.ts';

const CLIENT = { requestId: 'req-12345678', ip: null, userAgent: null };
const principal = principalOf('SA');

const mapped = (): MappedUser => fromLegacy(legacyUser(900, { role: 'SA', groupId: fixtureId('group', 1) }) as LegacyUserDocument);

function build(users: Partial<UsersRepository>, groupFind: () => Promise<{ id: string; name: string | null } | null> = () => Promise.resolve(null)) {
  const activityLog = memoryActivityLog();
  const unexpected = new Proxy(users, {
    get: (target, property) => (property in target ? (target as Record<string | symbol, unknown>)[property] : () => Promise.reject(new Error(`unexpected call: ${String(property)}`))),
  }) as UsersRepository;
  const service = createMeService({
    config: { legacyPasswordPepper: new Secret('unit-test-pepper'), legacyPasswordCoexistence: true },
    users: unexpected,
    credentials: { find: () => Promise.resolve(null), recordFailure: () => Promise.reject(new Error('unexpected')), recordSuccess: () => Promise.reject(new Error('unexpected')), upsertPassword: () => Promise.reject(new Error('unexpected')) },
    sessions: {} as MeServiceDeps['sessions'],
    groups: { find: groupFind },
    activityLog,
    now: () => Date.parse('2026-11-04T10:00:00.000Z'),
  });
  return { service, activityLog };
}

describe('MeService: a user who disappears mid-request', () => {
  it('answers 404 when the profile, the update or the password change cannot find the user', async () => {
    const gone = build({ findById: () => Promise.resolve(null), findLoginRecordById: () => Promise.resolve(null) });
    await assert.rejects(gone.service.getProfile(principal), { code: 'NOT_FOUND' });
    await assert.rejects(gone.service.updateProfile(principal, { firstName: 'Ada' }, CLIENT), { code: 'NOT_FOUND' });
    await assert.rejects(gone.service.changePassword(principal, new ObjectId(), { currentPassword: 'x', newPassword: 'y' }, CLIENT), { code: 'NOT_FOUND' });
    const vanished = build({ findById: () => Promise.resolve(mapped()), updateOwned: () => Promise.resolve(false) });
    await assert.rejects(vanished.service.updateProfile(principal, { firstName: 'Ada' }, CLIENT), { code: 'NOT_FOUND' });
    assert.deepEqual([gone.activityLog.entries, vanished.activityLog.entries], [[], []]);
  });
});

describe('MeService: requests without a client address', () => {
  it('records the profile change without an address and reports a group that vanished as no group', async () => {
    const { service, activityLog } = build({ findById: () => Promise.resolve(mapped()), updateOwned: () => Promise.resolve(true) });
    const profile = await service.updateProfile(principal, { firstName: 'Ada' }, CLIENT);
    assert.equal(profile.group, null);
    assert.equal('ip' in activityLog.entries[0]!, false);
  });

  it('records the group when the summary finds it', async () => {
    const { service } = build({ findById: () => Promise.resolve(mapped()) }, () => Promise.resolve({ id: fixtureId('group', 1).toHexString(), name: 'Acme' }));
    assert.deepEqual((await service.getProfile(principal)).group, { id: fixtureId('group', 1).toHexString(), name: 'Acme' });
  });

  it('gives no group to a user whose scope has none', async () => {
    const { service } = build({ findById: () => Promise.resolve(mapped()) }, () => Promise.reject(new Error('must not look up a group')));
    assert.equal((await service.getProfile(principalOf('PSA'))).group, null);
  });
});

describe('MeService: password change without a client address', () => {
  it('records the change without an address and logs no revocation when nothing was revoked', async () => {
    const pepper = new Secret('unit-test-pepper');
    const record = { ...mapped(), legacyPasswordHash: legacyPasswordHash('the current passphrase', pepper) };
    const writes: string[] = [];
    const activityLog = memoryActivityLog();
    const service = createMeService({
      config: { legacyPasswordPepper: pepper, legacyPasswordCoexistence: true },
      users: {
        findLoginRecordById: () => Promise.resolve(record),
        updateOwned: () => Promise.resolve(void writes.push('legacy') as never),
        clearLegacyTokens: () => Promise.resolve(void writes.push('tokens') as never),
      } as unknown as UsersRepository,
      credentials: { find: () => Promise.resolve(null), upsertPassword: () => Promise.resolve(void writes.push('credentials')) } as unknown as MeServiceDeps['credentials'],
      sessions: { revokeAllOfUser: () => Promise.resolve(0) } as unknown as MeServiceDeps['sessions'],
      groups: { find: () => Promise.resolve(null) },
      activityLog,
      now: () => Date.now(),
    });
    await service.changePassword(principal, new ObjectId(), { currentPassword: 'the current passphrase', newPassword: 'the next passphrase, longer' }, CLIENT);
    assert.deepEqual(writes, ['legacy', 'credentials', 'tokens']);
    assert.deepEqual(activityLog.entries.map((entry) => [entry.action, 'ip' in entry]), [['user.updated', false]]);
  });
});

describe('summarizeScope', () => {
  it('lists at most 100 dealer groups and always gives the total', () => {
    const ids = Array.from({ length: 150 }, (_unused, index) => fixtureId('group', index + 1));
    const summary = summarizeScope(principalOf('D', { dealerGroupIds: ids }));
    assert.ok(summary.kind === 'dealer');
    assert.equal(summary.groups, 150);
    assert.equal(summary.groupIds.length, MAX_SCOPE_SUMMARY_IDS);
    assert.deepEqual([...summary.groupIds], ids.map((id) => id.toHexString()).sort().slice(0, MAX_SCOPE_SUMMARY_IDS));
  });

  it('describes the other scopes', () => {
    const group = fixtureId('group', 1);
    const place = fixtureId('place', 1);
    assert.deepEqual(summarizeScope(principalOf('PSA')), { kind: 'platform' });
    assert.deepEqual(summarizeScope(principalOf('E')), { kind: 'none' });
    assert.deepEqual(summarizeScope(principalOf('SA', { groupId: group })), { kind: 'group', groupId: group.toHexString() });
    assert.deepEqual(summarizeScope(principalOf('CA', { groupId: group, companyIds: [fixtureId('company', 1)], placeIds: [place, fixtureId('place', 2)] })), { kind: 'companies', groupId: group.toHexString(), companies: 1, places: 2 });
    assert.deepEqual(summarizeScope(principalOf('PA', { groupId: group, placeIds: [place] })), { kind: 'places', groupId: group.toHexString(), places: 1 });
  });
});
