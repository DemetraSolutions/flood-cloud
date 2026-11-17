import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { emptyPos } from '../../src/modules/users/pos.catalog.ts';
import { emptyShiftTime } from '../../src/modules/users/shift-time.ts';
import { createAuthService } from '../../src/modules/auth/auth.service.ts';
import type { AuthServiceDeps } from '../../src/modules/auth/auth.service.ts';
import { checkAccount } from '../../src/modules/auth/account-state.ts';
import { createAuthenticate } from '../../src/modules/auth/authenticate.ts';
import type { AuthenticateDeps } from '../../src/modules/auth/authenticate.ts';
import type { Session, SessionsRepository } from '../../src/modules/sessions/sessions.repository.ts';
import type { CredentialsRepository } from '../../src/modules/users/credentials.repository.ts';
import type { UsersRepository } from '../../src/modules/users/users.repository.ts';
import type { AuthRecord, User } from '../../src/modules/users/user.types.ts';
import { clientContextOf, MAX_USER_AGENT_LENGTH } from '../../src/shared/http/client-context.ts';
import { hashSecret } from '../../src/shared/security/secrets.ts';
import type { GroupAvailability } from '../../src/shared/security/scope/groups.repository.ts';
import { Secret } from '../../src/shared/security/secret.ts';
import { memoryActivityLog } from '../helpers/activity.ts';
import { memoryLogger } from '../helpers/app.ts';

const USER_ID = new ObjectId();
const GROUP_ID = new ObjectId();
const NOW = Date.parse('2026-11-04T10:00:00.000Z');
const CLIENT = { requestId: 'req-12345678', ip: null, userAgent: null };

/** An object that throws when a method nobody planned for is called. */
function fake<T extends object>(planned: Partial<T>): T {
  return new Proxy(planned as T, {
    get: (target, property) => (property in target ? (target as Record<string | symbol, unknown>)[property] : () => Promise.reject(new Error(`unexpected call: ${String(property)}`))),
  });
}

const fakeUsers = (planned: Partial<UsersRepository>): UsersRepository => fake<UsersRepository>(planned);
const fakeSessions = (planned: Partial<SessionsRepository>): SessionsRepository => fake<SessionsRepository>(planned);
const fakeCredentials = (planned: Partial<CredentialsRepository>): CredentialsRepository => fake<CredentialsRepository>(planned);

const user = (overrides: Partial<User> = {}): User => ({
  id: USER_ID.toHexString(),
  username: 'ada',
  firstName: null,
  lastName: null,
  email: null,
  phone: null,
  role: 'SA',
  groupId: GROUP_ID.toHexString(),
  dealerId: null,
  companyIds: [],
  placeIds: [],
  status: 'active',
  trashed: false,
  trashedAt: null,
  language: 'it',
  hiddenInStats: false,
  description: null,
  hasAvatar: false,
  pinSet: false,
  serviceIds: [],
  permissions: { status: true, modules: {}, canManagePermissions: true },
  pos: emptyPos(),
  shiftTime: emptyShiftTime(),
  createdAt: null,
  updatedAt: null,
  ...overrides,
});

const session = (overrides: Partial<Session> = {}): Session => ({
  id: new ObjectId(),
  userId: USER_ID,
  accessTokenHash: 'a'.repeat(64),
  accessExpiresAt: new Date(NOW + 900_000),
  refreshTokenHash: 'b'.repeat(64),
  refreshExpiresAt: new Date(NOW + 86_400_000),
  familyExpiresAt: new Date(NOW + 2 * 86_400_000),
  createdAt: new Date(NOW),
  lastUsedAt: new Date(NOW),
  rotatedAt: null,
  userAgent: null,
  ip: null,
  revokedAt: null,
  revokeReason: null,
  ...overrides,
});

const authRecord = (overrides: Partial<User> = {}): AuthRecord => {
  const mapped = user(overrides);
  return {
    user: mapped,
    anomalies: [],
    stored: { userId: USER_ID, role: mapped.role as 'SA', groupId: mapped.groupId === null ? null : GROUP_ID, companyIds: [], placeIds: [], legacyPermissions: {} },
  };
};

const available = { findAvailability: () => Promise.resolve<GroupAvailability | null>('available') };

describe('checkAccount', () => {
  const denial = (u: User | null, availability: GroupAvailability | null = 'available') => checkAccount(u, { findAvailability: () => Promise.resolve(availability) });

  it('allows an active backoffice user and applies the group state to SA, CA and PA only', async () => {
    assert.equal(await denial(user()), null);
    assert.equal(await denial(user({ role: 'PSA', groupId: null }), null), null);
    assert.equal(await denial(user({ role: 'D', groupId: null }), 'unavailable'), null);
    assert.equal(await denial(user({ role: 'CA' }), 'unavailable'), 'groupUnavailable');
    assert.equal(await denial(user({ role: 'PA' }), null), 'groupMissing');
    assert.equal(await denial(user({ groupId: null })), 'groupMissing');
  });

  it('names the first thing that is wrong', async () => {
    assert.equal(await denial(null), 'userMissing');
    assert.equal(await denial(user({ role: 'E' })), 'roleNotAllowed');
    assert.equal(await denial(user({ role: 'invalid' })), 'roleNotAllowed');
    assert.equal(await denial(user({ status: 'disabled', trashed: true })), 'userDisabled');
    assert.equal(await denial(user({ trashed: true })), 'userTrashed');
  });
});

describe('clientContextOf', () => {
  const contextOf = (headers: Record<string, string>, ip?: string) =>
    clientContextOf({ get: (name: string) => headers[name.toLowerCase()], ip } as never, { locals: { requestId: 'req-1' } } as never);

  it('reads the request id, the address and the user agent, cut to its maximum', () => {
    assert.deepEqual(contextOf({ 'user-agent': 'Agent/1' }, '203.0.113.5'), { requestId: 'req-1', ip: '203.0.113.5', userAgent: 'Agent/1' });
    assert.equal(contextOf({ 'user-agent': 'x'.repeat(1000) }).userAgent?.length, MAX_USER_AGENT_LENGTH);
  });

  it('uses null for what is missing or empty', () => {
    assert.deepEqual(contextOf({}), { requestId: 'req-1', ip: null, userAgent: null });
    assert.equal(contextOf({ 'user-agent': '' }).userAgent, null);
  });
});

describe('AuthService: paths a race or a missing address can reach', () => {
  const pepper = new Secret('unit-test-pepper');
  const config = { refreshReuseGraceSeconds: 30, accessTokenTtlSeconds: 900, refreshIdleTtlSeconds: 86_400, sessionMaxTtlSeconds: 172_800, legacyPasswordPepper: pepper };
  const build = (planned: Partial<AuthServiceDeps>) => {
    const activityLog = memoryActivityLog();
    const service = createAuthService({
      config,
      users: fakeUsers({}),
      credentials: fakeCredentials({}),
      sessions: fakeSessions({}),
      groups: available,
      activityLog,
      now: () => NOW,
      ...planned,
    } as AuthServiceDeps);
    return { service, activityLog };
  };

  it('logs a refused login without an address when the request has none', async () => {
    const { service, activityLog } = build({ users: fakeUsers({ findByUsernameForLogin: () => Promise.resolve(null) }) });
    await assert.rejects(service.login({ username: 'nobody', password: 'x' }, CLIENT), { code: 'INVALID_CREDENTIALS' });
    assert.equal('ip' in activityLog.entries[0]!, false);
  });

  it('writes no revocation event when the session was revoked by another request in the meantime', async () => {
    const current = session();
    const { service, activityLog } = build({
      sessions: fakeSessions({ findByRefreshHash: () => Promise.resolve({ kind: 'current' as const, session: current }), revoke: () => Promise.resolve(false) }),
      users: fakeUsers({ findAuthRecord: () => Promise.resolve(authRecord({ status: 'disabled' })) }),
    });
    await assert.rejects(service.refresh(`fc_rt_${'A'.repeat(43)}`, CLIENT), { code: 'UNAUTHENTICATED' });
    assert.deepEqual(activityLog.entries, []);
  });

  it('records the refresh and a reuse without an address', async () => {
    const current = session();
    const rotated = session({ id: current.id });
    const token = `fc_rt_${'A'.repeat(43)}`;
    const lookups = [{ kind: 'current' as const, session: current }, { kind: 'rotated' as const, session: current, latest: false }];
    const { service, activityLog } = build({
      sessions: fakeSessions({ findByRefreshHash: () => Promise.resolve(lookups.shift()!), rotate: () => Promise.resolve(rotated), revoke: () => Promise.resolve(true) }),
      users: fakeUsers({ findAuthRecord: () => Promise.resolve(authRecord()) }),
    });
    const issued = await service.refresh(token, CLIENT);
    assert.equal(issued.sessionId, current.id.toHexString());
    await assert.rejects(service.refresh(token, CLIENT), { code: 'UNAUTHENTICATED' });
    assert.deepEqual(activityLog.entries.map((entry) => [entry.action, 'ip' in entry]), [['auth.refreshed', false], ['auth.refreshReuseDetected', false]]);
  });

  const token = `fc_rt_${'A'.repeat(43)}`;
  const raceBuild = (lookups: Array<unknown>, revoke: boolean, graceSeconds = 30) =>
    build({
      config: { ...config, refreshReuseGraceSeconds: graceSeconds },
      sessions: fakeSessions({
        findByRefreshHash: () => Promise.resolve(lookups.shift() as never),
        rotate: () => Promise.resolve(null),
        revoke: () => Promise.resolve(revoke),
      }),
      users: fakeUsers({ findAuthRecord: () => Promise.resolve(authRecord()) }),
    });
  const current = () => session();
  const rotated = (extra: Partial<Session>, latest = true) => ({ kind: 'rotated' as const, latest, session: session({ rotatedAt: new Date(NOW - 5000), ...extra }) });

  it('treats a lost rotation race as a retry when the other request just rotated the latest token', async () => {
    const { service, activityLog } = raceBuild([{ kind: 'current', session: current() }, rotated({})], true);
    await assert.rejects(service.refresh(token, CLIENT), { code: 'UNAUTHENTICATED' });
    assert.deepEqual(activityLog.entries.map((entry) => [entry.action, entry.outcome, entry.groupId?.toHexString()]), [['auth.refreshRaceTolerated', 'denied', GROUP_ID.toHexString()]]);
  });

  it('refuses without events when the lost race left the session revoked, missing or still current', async () => {
    for (const second of [null, { kind: 'rotated', latest: true, session: session({ revokedAt: new Date(NOW) }) }, { kind: 'current', session: current() }]) {
      const { service, activityLog } = raceBuild([{ kind: 'current', session: current() }, second], true);
      await assert.rejects(service.refresh(token, CLIENT), { code: 'UNAUTHENTICATED' });
      assert.deepEqual(activityLog.entries, []);
    }
  });

  it('tolerates the latest rotated token inside the grace window and nothing else', async () => {
    const cases: Array<[string, ReturnType<typeof rotated>, number, string[]]> = [
      ['inside the window', rotated({}), 30, ['auth.refreshRaceTolerated']],
      ['just inside', rotated({ rotatedAt: new Date(NOW - 29_999) }), 30, ['auth.refreshRaceTolerated']],
      ['at the end of the window', rotated({ rotatedAt: new Date(NOW - 30_000) }), 30, ['auth.refreshReuseDetected']],
      ['an older token', rotated({}, false), 30, ['auth.refreshReuseDetected']],
      ['grace switched off', rotated({}), 0, ['auth.refreshReuseDetected']],
      ['never rotated', rotated({ rotatedAt: null }), 30, ['auth.refreshReuseDetected']],
    ];
    for (const [label, found, grace, expected] of cases) {
      const { service, activityLog } = raceBuild([found], true, grace);
      await assert.rejects(service.refresh(token, CLIENT), { code: 'UNAUTHENTICATED' });
      assert.deepEqual(activityLog.entries.map((entry) => entry.action), expected, label);
    }
  });

  it('reports a reuse without a group when the user no longer exists', async () => {
    const { service, activityLog } = build({
      sessions: fakeSessions({ findByRefreshHash: () => Promise.resolve(rotated({}, false)), revoke: () => Promise.resolve(true) }),
      users: fakeUsers({ findAuthRecord: () => Promise.resolve(null) }),
    });
    await assert.rejects(service.refresh(token, CLIENT), { code: 'UNAUTHENTICATED' });
    assert.deepEqual(activityLog.entries.map((entry) => [entry.action, entry.groupId]), [['auth.refreshReuseDetected', undefined]]);
  });

  it('reports a reuse only when this request is the one that revoked the session', async () => {
    const { service, activityLog } = raceBuild([rotated({}, false)], false);
    await assert.rejects(service.refresh(token, CLIENT), { code: 'UNAUTHENTICATED' });
    assert.deepEqual(activityLog.entries, []);
  });

  it('logs nothing when there was nothing to end, and still empties the legacy tokens', async () => {
    let cleared = 0;
    const { service, activityLog } = build({
      sessions: fakeSessions({ revokeOwned: () => Promise.resolve(false), revokeAllOfUser: () => Promise.resolve(0) }),
      users: fakeUsers({ clearLegacyTokens: () => Promise.resolve(void (cleared += 1) as never) }),
    });
    await service.logout(USER_ID, new ObjectId(), { kind: 'user', id: USER_ID }, null, CLIENT);
    await service.logoutAll(USER_ID, { kind: 'user', id: USER_ID }, null, CLIENT);
    assert.deepEqual([activityLog.entries.length, cleared], [0, 1]);
  });

  it('logs out and logs out everywhere without a group or an address', async () => {
    const { service, activityLog } = build({
      sessions: fakeSessions({ revokeOwned: () => Promise.resolve(true), revokeAllOfUser: () => Promise.resolve(2) }),
      users: fakeUsers({ clearLegacyTokens: () => Promise.resolve(true) }),
    });
    await service.logout(USER_ID, new ObjectId(), { kind: 'user', id: USER_ID }, null, CLIENT);
    await service.logoutAll(USER_ID, { kind: 'user', id: USER_ID }, GROUP_ID, CLIENT);
    assert.deepEqual(activityLog.entries.map((entry) => [entry.action, entry.groupId?.toHexString(), 'ip' in entry]), [
      ['session.revoked', undefined, false],
      ['session.revoked', GROUP_ID.toHexString(), false],
    ]);
  });
});

describe('Bearer authentication: paths a race or an incident can reach', () => {
  const token = `fc_at_${'A'.repeat(43)}`;
  const build = (planned: Partial<AuthenticateDeps>) => {
    const { logger, events } = memoryLogger();
    const activityLog = memoryActivityLog();
    const handler = createAuthenticate({
      sessions: fakeSessions({}),
      users: fakeUsers({}),
      credentials: fakeCredentials({ isPasswordChangeRequired: () => Promise.resolve(false) }),
      groups: available,
      scope: fake<AuthenticateDeps['scope']>({}),
      activityLog,
      logger,
      now: () => NOW,
      ...planned,
    } as AuthenticateDeps);
    const run = async () => {
      const res = { locals: { requestId: 'req-12345678' } };
      let proceeded = false;
      await handler({ get: (name: string) => (name === 'authorization' ? `Bearer ${token}` : undefined), ip: '127.0.0.1' } as never, res as never, () => void (proceeded = true));
      return { res, proceeded };
    };
    return { run, events, activityLog };
  };

  it('does not fail the request when updating the last use fails, and logs it', async () => {
    const stale = session({ lastUsedAt: new Date(NOW - 120_000) });
    const { run, events } = build({
      sessions: fakeSessions({ findByAccessHash: () => Promise.resolve(stale), touch: () => Promise.reject(new Error('database down')) }),
      users: fakeUsers({ findAuthRecord: () => Promise.resolve(authRecord()) }),
    });
    const { proceeded } = await run();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(proceeded, true);
    assert.deepEqual(events.filter((event) => event['level'] === 'error').map((event) => event['msg']), ['updating the last use of a session failed']);
  });

  it('does not touch a session used less than a minute ago', async () => {
    let touched = 0;
    const { run } = build({
      sessions: fakeSessions({ findByAccessHash: () => Promise.resolve(session({ lastUsedAt: new Date(NOW - 30_000) })), touch: () => Promise.resolve(void (touched += 1)) }),
      users: fakeUsers({ findAuthRecord: () => Promise.resolve(authRecord()) }),
    });
    assert.equal((await run()).proceeded, true);
    assert.equal(touched, 0);
  });

  it('logs a scope anomaly and still authenticates', async () => {
    const { run, events } = build({
      sessions: fakeSessions({ findByAccessHash: () => Promise.resolve(session()), touch: () => Promise.resolve() }),
      users: fakeUsers({ findAuthRecord: () => Promise.resolve({ ...authRecord({ role: 'CA' }), stored: { ...authRecord().stored, role: 'CA', companyIds: [] } }) }),
    });
    const { res, proceeded } = await run();
    assert.equal(proceeded, true);
    assert.equal((res.locals as { auth?: { scope: { kind: string } } }).auth?.scope.kind, 'none');
    assert.deepEqual(events.filter((event) => event['level'] === 'warn').map((event) => [event['msg'], event['anomalies']]), [['scope anomaly', ['companyAdminWithoutCompanies']]]);
  });

  it('refuses a user who was disabled without logging when the session was already revoked by another request', async () => {
    const { run, activityLog } = build({
      sessions: fakeSessions({ findByAccessHash: () => Promise.resolve(session()), revoke: () => Promise.resolve(false) }),
      users: fakeUsers({ findAuthRecord: () => Promise.resolve(authRecord({ status: 'disabled' })) }),
    });
    await assert.rejects(run(), { code: 'UNAUTHENTICATED' });
    assert.deepEqual(activityLog.entries, []);
  });

  it('hashes the presented token before looking it up', async () => {
    let looked = '';
    const { run } = build({
      sessions: fakeSessions({ findByAccessHash: (hash: string) => Promise.resolve((looked = hash, null)) }),
    });
    await assert.rejects(run(), { code: 'UNAUTHENTICATED' });
    assert.equal(looked, hashSecret(token));
  });
});
