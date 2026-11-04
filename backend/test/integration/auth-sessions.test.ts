import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { TEST_PASSWORD, addUser as addBackofficeUser, hashWithTestPepper, startBackoffice, userName } from '../helpers/backoffice.ts';
import type { Backoffice, Tokens } from '../helpers/backoffice.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';

let ctx: TestDatabases;
let office: Backoffice;

before(async () => {
  ctx = await openTestDatabases();
  office = await startBackoffice(ctx);
});
after(async () => {
  await office.close();
  await ctx.cleanup();
});

const users = () => ctx.databases.common().collection('users');
const sessions = () => ctx.databases.common().collection('sessions');
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const DAY = 86_400_000;
const addUser = (overrides: Document = {}) => addBackofficeUser(ctx, office, overrides);

const refresh = (refreshToken: unknown, headers?: Record<string, string>) => office.call('POST', '/auth/refresh', undefined, { refreshToken }, headers);
const me = (accessToken: string | undefined, headers?: Record<string, string>) => office.call('GET', '/me', accessToken, undefined, headers);
const errorOf = async (response: Response): Promise<[number, string]> => [response.status, ((await response.json()) as { error: { code: string } }).error.code];
const tokensOf = async (response: Response): Promise<Tokens> => {
  assert.equal(response.status, 200);
  return ((await response.json()) as { data: Tokens }).data;
};
const since = (): number => office.activity.entries.length;
const logged = (from: number) => office.activity.entries.slice(from);

describe('POST /v1/auth/refresh', () => {
  it('rotates the pair, keeps the session and invalidates the previous tokens', async () => {
    const { name } = await addUser();
    const first = await office.tokens(name);
    office.clock.advance(60_000);
    const mark = since();
    const response = await refresh(first.refreshToken, { 'accept-encoding': 'gzip' });
    assert.equal(response.headers.get('content-encoding'), null);
    const second = await tokensOf(response);
    assert.equal(second.sessionId, first.sessionId);
    assert.notEqual(second.accessToken, first.accessToken);
    assert.notEqual(second.refreshToken, first.refreshToken);
    assert.equal(second.accessTokenExpiresAt, new Date(office.clock.now() + 900_000).toISOString());
    assert.equal(second.refreshTokenExpiresAt, new Date(office.clock.now() + 7 * DAY).toISOString());

    assert.deepEqual(await errorOf(await me(first.accessToken)), [401, 'UNAUTHENTICATED']);
    assert.equal((await me(second.accessToken)).status, 200);
    const stored = await sessions().findOne({ _id: ObjectId.createFromHexString(first.sessionId) });
    assert.deepEqual(stored?.['previousRefreshHashes'], [sha256(first.refreshToken)]);
    assert.equal(stored?.['refreshTokenHash'], sha256(second.refreshToken));
    assert.equal(stored?.['accessTokenHash'], sha256(second.accessToken));
    assert.deepEqual(logged(mark).map((entry) => [entry.action, entry.outcome]), [['auth.refreshed', 'success']]);
  });

  it('treats a reused refresh token as theft: the whole family is revoked and the event recorded', async () => {
    const { id, name } = await addUser();
    const first = await office.tokens(name);
    const second = await tokensOf(await refresh(first.refreshToken));
    office.clock.advance(31_000);
    const mark = since();
    assert.deepEqual(await errorOf(await refresh(first.refreshToken)), [401, 'UNAUTHENTICATED']);
    const stored = await sessions().findOne({ _id: ObjectId.createFromHexString(first.sessionId) });
    assert.ok(stored?.['revokedAt'] instanceof Date);
    assert.equal(stored['revokeReason'], 'refreshReuse');
    assert.deepEqual(await errorOf(await me(second.accessToken)), [401, 'UNAUTHENTICATED']);
    assert.deepEqual(await errorOf(await refresh(second.refreshToken)), [401, 'UNAUTHENTICATED']);
    const [reuse, ...others] = logged(mark);
    assert.deepEqual([reuse?.action, reuse?.outcome, reuse?.actor.id?.toHexString(), reuse?.resource?.id, reuse?.groupId?.toHexString()], ['auth.refreshReuseDetected', 'denied', id.toHexString(), first.sessionId, office.cluster.groups[0]!.groupId.toHexString()]);
    assert.equal(others.length, 0);
  });

  it('does not report a reuse on a session that was already ended', async () => {
    const { name } = await addUser();
    const first = await office.tokens(name);
    const second = await tokensOf(await refresh(first.refreshToken));
    assert.equal((await office.call('POST', '/auth/logout', second.accessToken)).status, 204);
    const mark = since();
    assert.deepEqual(await errorOf(await refresh(first.refreshToken)), [401, 'UNAUTHENTICATED']);
    assert.deepEqual(logged(mark), []);
  });

  it('tolerates a retry of the latest rotated token inside the grace window: nothing issued, session kept', async () => {
    const { id, name } = await addUser();
    const first = await office.tokens(name);
    office.clock.advance(10_000);
    const second = await tokensOf(await refresh(first.refreshToken));
    office.clock.advance(19_000);
    const mark = since();
    assert.deepEqual(await errorOf(await refresh(first.refreshToken)), [401, 'UNAUTHENTICATED']);
    const stored = await sessions().findOne({ _id: ObjectId.createFromHexString(first.sessionId) });
    assert.equal(stored?.['revokedAt'], null);
    assert.equal(stored?.['refreshTokenHash'], sha256(second.refreshToken));
    const [event, ...others] = logged(mark);
    assert.deepEqual([event?.category, event?.action, event?.outcome, event?.actor.id?.toHexString(), event?.groupId?.toHexString(), others.length], ['security', 'auth.refreshRaceTolerated', 'denied', id.toHexString(), office.cluster.groups[0]!.groupId.toHexString(), 0]);
    // The pair the client did receive is still good, and refreshes again.
    assert.equal((await me(second.accessToken)).status, 200);
    assert.equal((await refresh(second.refreshToken)).status, 200);
  });

  it('ends the session when the retry comes after the grace window', async () => {
    const { name } = await addUser();
    const first = await office.tokens(name);
    const second = await tokensOf(await refresh(first.refreshToken));
    office.clock.advance(31_000);
    const mark = since();
    assert.deepEqual(await errorOf(await refresh(first.refreshToken)), [401, 'UNAUTHENTICATED']);
    assert.equal((await sessions().findOne({ _id: ObjectId.createFromHexString(first.sessionId) }))?.['revokeReason'], 'refreshReuse');
    assert.deepEqual(await errorOf(await me(second.accessToken)), [401, 'UNAUTHENTICATED']);
    assert.deepEqual(logged(mark).map((entry) => entry.action), ['auth.refreshReuseDetected']);
  });

  it('ends the session when an older token than the latest rotated one is used, even inside the window', async () => {
    const { name } = await addUser();
    const first = await office.tokens(name);
    const second = await tokensOf(await refresh(first.refreshToken));
    await tokensOf(await refresh(second.refreshToken));
    assert.deepEqual(await errorOf(await refresh(first.refreshToken)), [401, 'UNAUTHENTICATED']);
    assert.equal((await sessions().findOne({ _id: ObjectId.createFromHexString(first.sessionId) }))?.['revokeReason'], 'refreshReuse');
  });

  it('serves two simultaneous uses of one refresh token with one success and one tolerated retry', async () => {
    const { name } = await addUser();
    const first = await office.tokens(name);
    const mark = since();
    const results = await Promise.all([refresh(first.refreshToken), refresh(first.refreshToken)]);
    assert.deepEqual(results.map((response) => response.status).sort(), [200, 401]);
    const winner = await tokensOf(results.find((response) => response.status === 200)!);
    assert.equal((await me(winner.accessToken)).status, 200);
    const stored = await sessions().findOne({ _id: ObjectId.createFromHexString(first.sessionId) });
    assert.equal(stored?.['revokedAt'], null);
    assert.deepEqual(logged(mark).map((entry) => entry.action).sort(), ['auth.refreshRaceTolerated', 'auth.refreshed']);
  });

  it('records exactly one revocation when a logout and the use of an old token race', async () => {
    const { name } = await addUser();
    const first = await office.tokens(name);
    const second = await tokensOf(await refresh(first.refreshToken));
    const third = await tokensOf(await refresh(second.refreshToken));
    const mark = since();
    const [stale, loggedOut] = await Promise.all([refresh(first.refreshToken), office.call('POST', '/auth/logout', third.accessToken)]);
    assert.equal(stale.status, 401);
    assert.equal(loggedOut.status, 204);
    assert.equal((await sessions().findOne({ _id: ObjectId.createFromHexString(first.sessionId) }))?.['revokedAt'] instanceof Date, true);
    assert.equal(logged(mark).filter((entry) => entry.action === 'auth.refreshReuseDetected' || entry.action === 'session.revoked').length, 1);
  });

  it('refuses unknown, malformed and wrongly prefixed tokens with the same answer', async () => {
    const { name } = await addUser();
    const own = await office.tokens(name);
    const unknown = `fc_rt_${'A'.repeat(43)}`;
    for (const token of [unknown, 'fc_rt_short', own.accessToken, '', 'x'.repeat(300).slice(0, 200)]) {
      assert.deepEqual(await errorOf(await refresh(token)), [401, 'UNAUTHENTICATED']);
    }
    assert.equal((await refresh(own.refreshToken)).status, 200);
  });

  it('answers 422 to a body that is not { refreshToken: string }', async () => {
    for (const body of [{ refreshToken: 5 }, { refreshToken: { $ne: null } }, {}, { refreshToken: 'x', extra: 1 }, { refreshToken: 'x'.repeat(300) }]) {
      assert.equal((await office.call('POST', '/auth/refresh', undefined, body)).status, 422);
    }
  });

  it('refuses after the inactivity period', async () => {
    const { name } = await addUser();
    const first = await office.tokens(name);
    office.clock.advance(7 * DAY + 1000);
    assert.deepEqual(await errorOf(await refresh(first.refreshToken)), [401, 'UNAUTHENTICATED']);
  });

  it('never goes beyond the maximum duration of the family', async () => {
    const { name } = await addUser();
    const start = office.clock.now();
    let current = await office.tokens(name);
    for (let step = 0; step < 4; step += 1) {
      office.clock.advance(6 * DAY);
      current = await tokensOf(await refresh(current.refreshToken));
    }
    // Day 24: seven days of inactivity would end on day 31, so the end of the family (day 30) wins.
    assert.equal(current.refreshTokenExpiresAt, new Date(start + 30 * DAY).toISOString());
    office.clock.advance(5 * DAY);
    current = await tokensOf(await refresh(current.refreshToken));
    assert.equal(current.refreshTokenExpiresAt, new Date(start + 30 * DAY).toISOString());
    office.clock.advance(DAY - 5 * 60_000);
    current = await tokensOf(await refresh(current.refreshToken));
    // Five minutes from the end: the access token cannot outlive the family.
    assert.equal(current.accessTokenExpiresAt, new Date(start + 30 * DAY).toISOString());
    office.clock.advance(6 * 60_000);
    assert.deepEqual(await errorOf(await me(current.accessToken)), [401, 'TOKEN_EXPIRED']);
    assert.deepEqual(await errorOf(await refresh(current.refreshToken)), [401, 'UNAUTHENTICATED']);
  });

  it('revokes the session when the user was disabled, trashed or lost the group in the meantime', async () => {
    const states: Array<[Document, string]> = [
      [{ status: false }, 'userDisabled'],
      [{ trash: true }, 'userTrashed'],
      [{ role: 'E' }, 'roleNotAllowed'],
    ];
    for (const [change, reason] of states) {
      const { id, name } = await addUser();
      const first = await office.tokens(name);
      await users().updateOne({ _id: id }, { $set: change });
      const mark = since();
      assert.deepEqual(await errorOf(await refresh(first.refreshToken)), [401, 'UNAUTHENTICATED']);
      const stored = await sessions().findOne({ _id: ObjectId.createFromHexString(first.sessionId) });
      assert.equal(stored?.['revokeReason'], reason);
      const [event] = logged(mark);
      assert.deepEqual([event?.action, event?.actor.kind, event?.metadata, event?.groupId?.toHexString()], ['session.revoked', 'system', { reason }, office.cluster.groups[0]!.groupId.toHexString()]);
    }
  });

  it('revokes the session when the user no longer exists', async () => {
    const { id, name } = await addUser();
    const first = await office.tokens(name);
    await users().deleteOne({ _id: id });
    const mark = since();
    assert.deepEqual(await errorOf(await refresh(first.refreshToken)), [401, 'UNAUTHENTICATED']);
    const [event] = logged(mark);
    assert.deepEqual([event?.metadata, event?.groupId], [{ reason: 'userMissing' }, undefined]);
  });

  it('does not log a second revocation for a session that is already revoked', async () => {
    const { id, name } = await addUser();
    const first = await office.tokens(name);
    await users().updateOne({ _id: id }, { $set: { status: false } });
    assert.deepEqual(await errorOf(await refresh(first.refreshToken)), [401, 'UNAUTHENTICATED']);
    const mark = since();
    assert.deepEqual(await errorOf(await refresh(first.refreshToken)), [401, 'UNAUTHENTICATED']);
    assert.deepEqual(logged(mark), []);
  });
});

describe('Bearer authentication', () => {
  it('refuses a missing, malformed or wrongly prefixed credential with the same 401', async () => {
    const { name } = await addUser();
    const own = await office.tokens(name);
    const bad = [undefined, 'Basic abc', 'Bearer', 'Bearer ', `Bearer  ${own.accessToken}`, `Token ${own.accessToken}`, `Bearer ${own.refreshToken}`, 'Bearer fc_at_short', `Bearer ${own.accessToken}x`, `Bearer ${own.accessToken} extra`, `Bearer fc_at_${'A'.repeat(43)}`];
    for (const header of bad) {
      const response = await fetch(`${office.app.baseUrl}/v1/me`, { headers: header === undefined ? {} : { authorization: header } });
      assert.deepEqual(await errorOf(response), [401, 'UNAUTHENTICATED'], String(header));
    }
    assert.equal((await fetch(`${office.app.baseUrl}/v1/me`, { headers: { authorization: `bearer ${own.accessToken}` } })).status, 200);
  });

  it('tells an expired token apart, and the refresh then recovers', async () => {
    const { name } = await addUser();
    const own = await office.tokens(name);
    office.clock.advance(901_000);
    assert.deepEqual(await errorOf(await me(own.accessToken)), [401, 'TOKEN_EXPIRED']);
    const renewed = await tokensOf(await refresh(own.refreshToken));
    assert.equal((await me(renewed.accessToken)).status, 200);
  });

  it('cuts a disabled user off at the next request and revokes the session', async () => {
    const { id, name } = await addUser();
    const own = await office.tokens(name);
    assert.equal((await me(own.accessToken)).status, 200);
    await users().updateOne({ _id: id }, { $set: { status: false } });
    const mark = since();
    assert.deepEqual(await errorOf(await me(own.accessToken)), [401, 'UNAUTHENTICATED']);
    const stored = await sessions().findOne({ _id: ObjectId.createFromHexString(own.sessionId) });
    assert.deepEqual([stored?.['revokeReason'], stored?.['revokedAt'] instanceof Date], ['userDisabled', true]);
    assert.deepEqual(logged(mark).map((entry) => [entry.action, entry.actor.kind, entry.metadata]), [['session.revoked', 'system', { reason: 'userDisabled' }]]);
    // Once revoked, later requests are plain refusals: nothing more is logged.
    assert.deepEqual(await errorOf(await me(own.accessToken)), [401, 'UNAUTHENTICATED']);
    assert.equal(logged(mark).length, 1);
  });

  it('cuts off SA, CA and PA of a suspended group, and trashed or demoted users', async () => {
    const group = office.cluster.groups[2]!;
    const sessionsOf = [await office.tokens(userName(group.sa)), await office.tokens(userName(group.ca)), await office.tokens(userName(group.pa))];
    await ctx.databases.common().collection('groups').updateOne({ _id: group.groupId }, { $set: { status: false } });
    try {
      for (const own of sessionsOf) {
        assert.deepEqual(await errorOf(await me(own.accessToken)), [401, 'UNAUTHENTICATED']);
      }
    } finally {
      await ctx.databases.common().collection('groups').updateOne({ _id: group.groupId }, { $set: { status: true } });
    }
    const trashed = await addUser();
    const demoted = await addUser();
    const a = await office.tokens(trashed.name);
    const b = await office.tokens(demoted.name);
    await users().updateOne({ _id: trashed.id }, { $set: { trash: true } });
    await users().updateOne({ _id: demoted.id }, { $set: { role: 'E' } });
    assert.deepEqual(await errorOf(await me(a.accessToken)), [401, 'UNAUTHENTICATED']);
    assert.deepEqual(await errorOf(await me(b.accessToken)), [401, 'UNAUTHENTICATED']);
  });

  it('refuses a session whose user disappeared, without a group on the event', async () => {
    const { id, name } = await addUser();
    const own = await office.tokens(name);
    await users().deleteOne({ _id: id });
    const mark = since();
    assert.deepEqual(await errorOf(await me(own.accessToken)), [401, 'UNAUTHENTICATED']);
    assert.deepEqual([logged(mark)[0]?.metadata, logged(mark)[0]?.groupId], [{ reason: 'userMissing' }, undefined]);
  });

  it('recomputes the permissions and the scope from the stored user on every request', async () => {
    const group = office.cluster.groups[0]!;
    const { id, name } = await addUser();
    const own = await office.tokens(name);
    const profile = async () => ((await (await me(own.accessToken)).json()) as { data: { role: string; scope: { kind: string } } }).data;
    assert.deepEqual([(await profile()).role, (await profile()).scope.kind], ['SA', 'group']);
    await users().updateOne({ _id: id }, { $set: { role: 'PA', placeId: group.ownPlaceId, placesId: [group.ownPlaceId] } });
    assert.deepEqual([(await profile()).role, (await profile()).scope.kind], ['PA', 'places']);
  });

  it('updates the last use at most once a minute, without delaying the response', async () => {
    const { name } = await addUser();
    const own = await office.tokens(name);
    const id = ObjectId.createFromHexString(own.sessionId);
    const lastUsed = async (): Promise<number> => ((await sessions().findOne({ _id: id }))?.['lastUsedAt'] as Date).getTime();
    const created = await lastUsed();
    assert.equal((await me(own.accessToken)).status, 200);
    assert.equal(await lastUsed(), created);
    office.clock.advance(61_000);
    assert.equal((await me(own.accessToken)).status, 200);
    for (let attempt = 0; attempt < 50 && (await lastUsed()) === created; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(await lastUsed(), office.clock.now());
    office.clock.advance(10_000);
    assert.equal((await me(own.accessToken)).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await lastUsed(), office.clock.now() - 10_000);
  });
});

describe('logout', () => {
  it('ends the current session only', async () => {
    const { id, name } = await addUser();
    const here = await office.tokens(name);
    const elsewhere = await office.tokens(name);
    const mark = since();
    const response = await office.call('POST', '/auth/logout', here.accessToken);
    assert.equal(response.status, 204);
    assert.equal(await response.text(), '');
    assert.deepEqual(await errorOf(await me(here.accessToken)), [401, 'UNAUTHENTICATED']);
    assert.deepEqual(await errorOf(await refresh(here.refreshToken)), [401, 'UNAUTHENTICATED']);
    assert.equal((await me(elsewhere.accessToken)).status, 200);
    const [event, ...others] = logged(mark);
    assert.deepEqual([event?.action, event?.actor.id?.toHexString(), event?.metadata, event?.resource?.id], ['session.revoked', id.toHexString(), { reason: 'logout' }, here.sessionId]);
    assert.equal(others.length, 0);
  });

  it('needs authentication', async () => {
    assert.deepEqual(await errorOf(await office.call('POST', '/auth/logout', undefined)), [401, 'UNAUTHENTICATED']);
    assert.deepEqual(await errorOf(await office.call('POST', '/auth/logout-all', undefined)), [401, 'UNAUTHENTICATED']);
  });
});

describe('logout from every device', () => {
  it('ends all the sessions of the user, empties the legacy tokens and leaves other users alone', async () => {
    const { id, name } = await addUser();
    const other = await addUser();
    const a = await office.tokens(name);
    const b = await office.tokens(name);
    const bystander = await office.tokens(other.name);
    assert.ok(((await users().findOne({ _id: id }))?.['tokens'] as unknown[]).length > 0);
    const mark = since();
    assert.equal((await office.call('POST', '/auth/logout-all', a.accessToken)).status, 204);
    for (const own of [a, b]) {
      assert.deepEqual(await errorOf(await me(own.accessToken)), [401, 'UNAUTHENTICATED']);
      assert.deepEqual(await errorOf(await refresh(own.refreshToken)), [401, 'UNAUTHENTICATED']);
    }
    assert.equal((await me(bystander.accessToken)).status, 200);
    assert.deepEqual((await users().findOne({ _id: id }))?.['tokens'], []);
    assert.ok(((await users().findOne({ _id: other.id }))?.['tokens'] as unknown[]).length > 0);
    const [event, ...others] = logged(mark);
    assert.deepEqual([event?.action, event?.actor.id?.toHexString(), event?.metadata, event?.resource], ['session.revoked', id.toHexString(), { reason: 'logoutAll' }, { type: 'session' }]);
    assert.equal(others.length, 0);
  });
});
