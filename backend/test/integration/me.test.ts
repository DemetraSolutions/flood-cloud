import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { featuresOf } from '../../src/modules/groups/features.ts';
import { createGroupSummaryRepository } from '../../src/modules/me/group-summary.repository.ts';
import { createRateLimiter } from '../../src/shared/security/rate-limit/rate-limiter.ts';
import { ALL_PERMISSIONS, PERMISSIONS } from '../../src/shared/security/rbac/permissions.ts';
import { ROLE_CEILING } from '../../src/shared/security/rbac/policy.ts';
import { TEST_PASSWORD, addUser as addBackofficeUser, hashWithTestPepper, startBackoffice, userName } from '../helpers/backoffice.ts';
import type { Backoffice, Tokens } from '../helpers/backoffice.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';

/** A frozen clock for the real counters: the one-minute window cannot change in the middle of a test. */
// Frozen at the real time of the run, never in the past: counters live in MongoDB with a TTL, and the TTL monitor
// would delete the counters of a window that already ended while the test is still running.
const FROZEN_NOW = Date.now();
let ctx: TestDatabases;
let office: Backoffice;
const cleanups: Array<() => Promise<void>> = [];

before(async () => {
  ctx = await openTestDatabases();
  office = await startBackoffice(ctx);
  cleanups.push(async () => {
    await office.close();
    await ctx.cleanup();
  });
});
after(async () => {
  for (const cleanup of cleanups.reverse()) {
    await cleanup();
  }
});

const users = () => ctx.databases.common().collection('users');
const credentials = () => ctx.databases.common().collection('userCredentials');
const sessions = () => ctx.databases.common().collection('sessions');
const addUser = (overrides: Document = {}) => addBackofficeUser(ctx, office, overrides);
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const since = (): number => office.activity.entries.length;
const logged = (from: number) => office.activity.entries.slice(from);
const errorOf = async (response: Response): Promise<[number, string, unknown]> => {
  const { error } = (await response.json()) as { error: { code: string; details?: unknown } };
  return [response.status, error.code, error.details];
};

type Profile = Record<string, unknown> & { scope: Record<string, unknown>; permissions: string[]; group: { id: string; name: string | null } | null };
const profileOf = async (response: Response): Promise<Profile> => {
  assert.equal(response.status, 200);
  return ((await response.json()) as { data: Profile }).data;
};

describe('GET /v1/me', () => {
  it('returns the profile, the effective permissions, the scope summary and the group, and no secret', async () => {
    const group = office.cluster.groups[0]!;
    const sentinels = ['PIN-SENTINEL-93', 'TOKEN-SENTINEL-93', 'RESIDUE-SENTINEL-93', 'CASH-SENTINEL-93', 'GROUPKEY-SENTINEL-93', 'SMTP-SENTINEL-93'];
    const { id, name } = await addUser({
      pin: sentinels[0],
      tokens: [{ token: sentinels[1] }],
      avatar: 'data:image/png;base64,iVBORw0KGgo=',
      permissions: { status: true, groups: { r: true, w: true }, users: { r: true, w: true }, companies: { r: true, w: true }, places: { r: true, w: true }, fidelity: { r: true, w: true }, products: { r: true, w: true }, logs: { r: true, w: true }, apps: { cash: { status: true, note: sentinels[3], sub: { productsStatus: sentinels[2] }, options: { service: sentinels[2] } } } },
    });
    await ctx.databases.common().collection('groups').updateOne({ _id: group.groupId }, { $set: { apiKey: sentinels[4], 'settings.email.password': sentinels[5] } });
    const own = await office.tokens(name);
    const response = await office.call('GET', '/me', own.accessToken);
    const text = await response.clone().text();
    for (const secret of [...sentinels, hashWithTestPepper(TEST_PASSWORD), 'scrypt$', own.accessToken, own.refreshToken]) {
      assert.ok(!text.includes(secret), secret);
    }
    const profile = await profileOf(response);
    assert.deepEqual(Object.keys(profile).sort(), [
      'avatar', 'canManagePermissions', 'companyIds', 'createdAt', 'dealer', 'dealerId', 'description', 'email', 'firstName', 'group', 'groupFeatures', 'groupId', 'hasAvatar', 'hiddenInStats', 'id', 'language', 'lastName', 'passwordChangeRequired', 'permissions', 'phone', 'pinSet', 'placeIds', 'pos', 'role', 'scope', 'serviceIds', 'shiftTime', 'status', 'theme', 'trashed', 'trashedAt', 'updatedAt', 'username',
    ]);
    assert.equal(profile['id'], id.toHexString());
    assert.equal(profile['username'], name);
    assert.deepEqual([profile['role'], profile['status'], profile['trashed'], profile['language']], ['SA', 'active', false, 'it']);
    assert.deepEqual(profile.permissions, [...ROLE_CEILING.SA].sort());
    assert.equal(profile['canManagePermissions'], true);
    assert.deepEqual(profile.scope, { kind: 'group', groupId: group.groupId.toHexString() });
    assert.deepEqual(profile.group, { id: group.groupId.toHexString(), name: 'group-001' });
    assert.equal(profile['dealer'], null);
  });

  it('narrows the permissions to the ones the user holds', async () => {
    const { name } = await addUser({ permissions: { status: false, users: { r: true, w: false } } });
    const profile = await profileOf(await office.call('GET', '/me', (await office.tokens(name)).accessToken));
    assert.deepEqual(profile.permissions, [PERMISSIONS.CLIENT_ERRORS_CREATE, PERMISSIONS.PROFILE_READ, PERMISSIONS.PROFILE_UPDATE, PERMISSIONS.SESSIONS_READ, PERMISSIONS.SESSIONS_REVOKE, PERMISSIONS.USERS_READ].sort());
    assert.equal(profile['canManagePermissions'], false);
  });

  it('describes the scope of every role', async () => {
    const [first, second] = office.cluster.groups as [(typeof office.cluster.groups)[number], (typeof office.cluster.groups)[number]];
    const as = async (id: ObjectId) => profileOf(await office.call('GET', '/me', (await office.tokens(userName(id))).accessToken));
    const psa = await as(office.cluster.psa);
    assert.deepEqual([psa.scope, psa.group, psa.permissions.length], [{ kind: 'platform' }, null, ALL_PERMISSIONS.size]);
    const dealer = await as(office.cluster.dealerA);
    assert.deepEqual(dealer.scope, { kind: 'dealer', groups: 2, groupIds: [first.groupId.toHexString(), second.groupId.toHexString()].sort() });
    assert.equal(dealer.group, null);
    assert.deepEqual((await as(first.ca)).scope, { kind: 'companies', groupId: first.groupId.toHexString(), companies: 1, places: 1 });
    assert.deepEqual((await as(first.pa)).scope, { kind: 'places', groupId: first.groupId.toHexString(), places: 1 });
    assert.equal((await as(first.pa)).group?.id, first.groupId.toHexString());
  });

  it('gives a null name to a group without one', async () => {
    const group = office.cluster.groups[1]!;
    await ctx.databases.common().collection('groups').updateOne({ _id: group.groupId }, { $unset: { name: '' } });
    const profile = await profileOf(await office.call('GET', '/me', (await office.tokens(userName(group.sa))).accessToken));
    assert.deepEqual(profile.group, { id: group.groupId.toHexString(), name: null });
  });

  it('needs a valid credential', async () => {
    assert.deepEqual(await errorOf(await office.call('GET', '/me', undefined)), [401, 'UNAUTHENTICATED', undefined]);
  });
});

describe('PATCH /v1/me', () => {
  it('changes the personal fields, normalizes them, keeps the rest of the document and logs the changes', async () => {
    const { id, name } = await addUser({ pin: 'KEEP-PIN', permissions: { status: true, users: { r: true, w: true }, apps: { cash: { status: true } } } });
    const own = await office.tokens(name);
    const mark = since();
    office.clock.advance(5000);
    const patched = await profileOf(
      await office.call('PATCH', '/me', own.accessToken, { firstName: '  Ada ', lastName: 'Lovelace', email: ' Ada@Example.TEST ', phone: '+39 06 1234', language: 'it' }),
    );
    assert.deepEqual([patched['firstName'], patched['lastName'], patched['email'], patched['phone']], ['Ada', 'Lovelace', 'ada@example.test', '+39 06 1234']);
    const stored = await users().findOne({ _id: id });
    assert.deepEqual([stored?.['name'], stored?.['surname'], stored?.['email'], stored?.['telephone']], ['Ada', 'Lovelace', 'ada@example.test', '+39 06 1234']);
    assert.deepEqual([stored?.['pin'], stored?.['role'], stored?.['userName'], stored?.['status']], ['KEEP-PIN', 'SA', name, true]);
    assert.deepEqual((stored?.['permissions'] as Document)['apps'], { cash: { status: true } });
    assert.equal((stored?.['updateDate'] as Date).getTime(), office.clock.now());
    const [event, ...others] = logged(mark);
    assert.equal(others.length, 0);
    assert.deepEqual([event?.category, event?.action, event?.outcome, event?.actor.id?.toHexString(), event?.resource], ['data', 'user.updated', 'success', id.toHexString(), { type: 'user', id: id.toHexString() }]);
    assert.deepEqual(
      event?.changes?.map((change) => change.field).sort(),
      ['email', 'firstName', 'lastName', 'phone'],
    );
    assert.ok(!JSON.stringify(event).includes('KEEP-PIN'));
  });

  it('reads the theme as system by default, from settings.theme, and changes only it, keeping the other settings and logging the change', async () => {
    const { id, name } = await addUser({ settings: { language: 'it', hiddenInStats: true, custom: 'KEEP' } });
    const own = await office.tokens(name);
    assert.equal((await profileOf(await office.call('GET', '/me', own.accessToken)))['theme'], 'system');
    for (const theme of ['dark', 'light', 'system']) {
      const mark = since();
      const patched = await profileOf(await office.call('PATCH', '/me', own.accessToken, { theme }));
      assert.equal(patched['theme'], theme);
      assert.equal((await profileOf(await office.call('GET', '/me', own.accessToken)))['theme'], theme);
      assert.deepEqual((await users().findOne({ _id: id }))?.['settings'], { language: 'it', hiddenInStats: true, custom: 'KEEP', theme });
      const events = logged(mark);
      assert.equal(events.length, 1);
      assert.deepEqual(events[0]?.changes?.map((change) => change.field), ['theme']);
    }
  });

  it('reads an invalid stored theme as system', async () => {
    const { name } = await addUser({ settings: { language: 'it', theme: 'blue' } });
    assert.equal((await profileOf(await office.call('GET', '/me', (await office.tokens(name)).accessToken)))['theme'], 'system');
  });

  it('rejects a theme that is not one of the three values', async () => {
    const { name } = await addUser();
    const own = await office.tokens(name);
    const patch = async (body: unknown) => errorOf(await office.call('PATCH', '/me', own.accessToken, body));
    assert.deepEqual(await patch({ theme: 'blue' }), [422, 'VALIDATION_ERROR', [{ field: 'theme', issue: 'enum' }]]);
    assert.deepEqual(await patch({ theme: null }), [422, 'VALIDATION_ERROR', [{ field: 'theme', issue: 'type' }]]);
  });

  it('clears a personal field with null', async () => {
    const { id, name } = await addUser({ email: 'old@example.test', telephone: '+390000' });
    const own = await office.tokens(name);
    const patched = await profileOf(await office.call('PATCH', '/me', own.accessToken, { email: null, phone: null }));
    assert.deepEqual([patched['email'], patched['phone']], [null, null]);
    const stored = await users().findOne({ _id: id });
    assert.equal('email' in (stored ?? {}) || 'telephone' in (stored ?? {}), false);
  });

  it('refuses what a user may not change, a bad value and an empty patch, with details per field', async () => {
    const { name } = await addUser();
    const own = await office.tokens(name);
    const patch = async (body: unknown) => errorOf(await office.call('PATCH', '/me', own.accessToken, body));
    for (const field of ['role', 'groupId', 'permissions', 'status', 'username', 'password', 'dealerId', 'companyIds', 'placeIds', 'trashed', 'id']) {
      assert.deepEqual(await patch({ [field]: 'PSA' }), [422, 'VALIDATION_ERROR', [{ field, issue: 'unknown' }]], field);
    }
    assert.deepEqual(await patch({ $set: { role: 'PSA' } }), [422, 'VALIDATION_ERROR', [{ field: '(key)', issue: 'forbiddenKey' }]]);
    assert.deepEqual(await patch({ email: 'not an email' }), [422, 'VALIDATION_ERROR', [{ field: 'email', issue: 'format' }]]);
    for (const hidden of ['\u0000', '\u0007', '\u007f', '\u0085', '\u202e', '\u2066']) {
      assert.deepEqual(await patch({ lastName: `Lo${hidden}velace` }), [422, 'VALIDATION_ERROR', [{ field: 'lastName', issue: 'format' }]], hidden.charCodeAt(0).toString(16));
    }
    assert.deepEqual(await patch({ phone: 'abc' }), [422, 'VALIDATION_ERROR', [{ field: 'phone', issue: 'format' }]]);
    assert.deepEqual(await patch({ firstName: '' }), [422, 'VALIDATION_ERROR', [{ field: 'firstName', issue: 'minLength' }]]);
    assert.deepEqual(await patch({ firstName: 'x'.repeat(101) }), [422, 'VALIDATION_ERROR', [{ field: 'firstName', issue: 'maxLength' }]]);
    assert.deepEqual(await patch({ language: 'en' }), [422, 'VALIDATION_ERROR', [{ field: 'language', issue: 'enum' }]]);
    assert.deepEqual(await patch({ language: null }), [422, 'VALIDATION_ERROR', [{ field: 'language', issue: 'type' }]]);
    assert.deepEqual(await patch({}), [422, 'VALIDATION_ERROR', [{ field: '(body)', issue: 'required' }]]);
    assert.deepEqual(await patch([]), [422, 'VALIDATION_ERROR', [{ field: '(body)', issue: 'type' }]]);
    const wrongType = await fetch(`${office.app.baseUrl}/v1/me`, { method: 'PATCH', headers: { authorization: `Bearer ${own.accessToken}`, 'content-type': 'text/plain' }, body: 'x' });
    assert.equal(wrongType.status, 415);
  });

  it('needs a valid credential', async () => {
    assert.deepEqual(await errorOf(await office.call('PATCH', '/me', undefined, { firstName: 'x' })), [401, 'UNAUTHENTICATED', undefined]);
  });
});

describe('a platform user, who has no group', () => {
  it('edits the profile and changes the password like the others', async () => {
    const { id, name } = await addUser({ role: 'PSA', groupId: null, dealerId: null });
    const own = await office.tokens(name);
    const profile = await profileOf(await office.call('PATCH', '/me', own.accessToken, { firstName: 'Root' }));
    assert.deepEqual([profile['firstName'], profile.group, profile['groupId']], ['Root', null, null]);
    assert.equal((await office.call('PUT', '/me/password', own.accessToken, { currentPassword: TEST_PASSWORD, newPassword: 'a passphrase for a platform user' })).status, 204);
    assert.ok(office.activity.entries.filter((entry) => entry.actor.id?.equals(id) === true && entry.action === 'user.updated').every((entry) => entry.groupId === undefined));
  });
});

describe('PUT /v1/me/password', () => {
  const NEW_PASSWORD = 'a brand new passphrase for the test';

  it('accepts the legacy password of a user whose credentials hold only failure counters', async () => {
    const { id, name } = await addUser();
    const own = await office.tokens(name);
    await credentials().updateOne({ _id: id }, { $unset: { passwordHash: '', legacyHashFingerprint: '' } });
    assert.equal((await office.call('PUT', '/me/password', own.accessToken, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD })).status, 204);
    assert.match((await credentials().findOne({ _id: id }))?.['passwordHash'] as string, /^scrypt\$/);
  });

  it('changes the password, ends the other sessions, empties the legacy tokens and writes the legacy hash', async () => {
    const { id, name } = await addUser();
    const here = await office.tokens(name);
    const elsewhere = await office.tokens(name);
    const mark = since();
    office.clock.advance(1000);
    const response = await office.call('PUT', '/me/password', here.accessToken, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });
    assert.equal(response.status, 204);
    assert.equal(await response.text(), '');

    assert.equal((await office.call('GET', '/me', here.accessToken)).status, 200);
    assert.equal((await office.call('GET', '/me', elsewhere.accessToken)).status, 401);
    assert.equal((await office.call('POST', '/auth/refresh', undefined, { refreshToken: elsewhere.refreshToken })).status, 401);
    assert.equal((await sessions().findOne({ _id: ObjectId.createFromHexString(elsewhere.sessionId) }))?.['revokeReason'], 'passwordChanged');
    assert.deepEqual((await users().findOne({ _id: id }))?.['tokens'], []);
    assert.equal((await users().findOne({ _id: id }))?.['password'], hashWithTestPepper(NEW_PASSWORD));
    const stored = await credentials().findOne({ _id: id });
    assert.match(stored?.['passwordHash'] as string, /^scrypt\$/);
    assert.equal(stored?.['legacyHashFingerprint'], sha256(hashWithTestPepper(NEW_PASSWORD)));
    assert.equal((stored?.['passwordChangedAt'] as Date).getTime(), office.clock.now());

    assert.equal((await office.login(name, TEST_PASSWORD)).status, 401);
    assert.equal((await office.login(name, NEW_PASSWORD)).status, 200);

    const [updated, revoked] = logged(mark);
    assert.deepEqual([updated?.category, updated?.action, updated?.changes], ['data', 'user.updated', [{ field: 'password', redacted: true }]]);
    assert.deepEqual([revoked?.action, revoked?.metadata, revoked?.actor.id?.toHexString()], ['session.revoked', { reason: 'passwordChanged' }, id.toHexString()]);
    const text = JSON.stringify(logged(mark));
    assert.ok(!text.includes(NEW_PASSWORD) && !text.includes(TEST_PASSWORD));
  });

  it('logs no revocation when there is no other session', async () => {
    const { name } = await addUser();
    const only = await office.tokens(name);
    const mark = since();
    assert.equal((await office.call('PUT', '/me/password', only.accessToken, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD })).status, 204);
    assert.deepEqual(logged(mark).map((entry) => entry.action), ['user.updated']);
  });

  it('refuses a wrong current password without changing anything', async () => {
    const { id, name } = await addUser();
    const own = await office.tokens(name);
    const before = await users().findOne({ _id: id });
    const mark = since();
    assert.deepEqual(await errorOf(await office.call('PUT', '/me/password', own.accessToken, { currentPassword: 'not it', newPassword: NEW_PASSWORD })), [422, 'VALIDATION_ERROR', [{ field: 'currentPassword', issue: 'incorrect' }]]);
    assert.deepEqual(await users().findOne({ _id: id }), before);
    const [failed, ...others] = logged(mark);
    assert.deepEqual([failed?.category, failed?.action, failed?.outcome, failed?.actor.id?.toHexString(), failed?.groupId?.toHexString(), others.length], ['security', 'auth.passwordCheckFailed', 'failure', id.toHexString(), office.cluster.groups[0]!.groupId.toHexString(), 0]);
    assert.ok(!JSON.stringify(failed).includes('not it'));
    assert.equal(await credentials().findOne({ _id: id, passwordChangedAt: { $exists: true } }), null);
    assert.equal((await office.call('GET', '/me', own.accessToken)).status, 200);
    // No progressive lock for a failed password change.
    assert.equal((await credentials().findOne({ _id: id }))?.['failedLogins'] ?? 0, 0);
  });

  it('applies the password policy and says which rules failed', async () => {
    const { name } = await addUser();
    const own = await office.tokens(name);
    const put = async (newPassword: string) => errorOf(await office.call('PUT', '/me/password', own.accessToken, { currentPassword: TEST_PASSWORD, newPassword }));
    assert.deepEqual(await put('short'), [422, 'VALIDATION_ERROR', [{ field: 'newPassword', issue: 'tooShort' }]]);
    assert.deepEqual(await put('x'.repeat(129)), [422, 'VALIDATION_ERROR', [{ field: 'newPassword', issue: 'tooLong' }]]);
    assert.deepEqual(await put(name), [422, 'VALIDATION_ERROR', [{ field: 'newPassword', issue: 'tooShort' }, { field: 'newPassword', issue: 'sameAsUsername' }]]);
    assert.deepEqual(await put('lone surrogate \ud800 in it'), [422, 'VALIDATION_ERROR', [{ field: 'newPassword', issue: 'format' }]]);
    assert.deepEqual(await errorOf(await office.call('PUT', '/me/password', own.accessToken, { currentPassword: TEST_PASSWORD })), [422, 'VALIDATION_ERROR', [{ field: 'newPassword', issue: 'required' }]]);
    assert.deepEqual(await errorOf(await office.call('PUT', '/me/password', own.accessToken, { currentPassword: '', newPassword: NEW_PASSWORD })), [422, 'VALIDATION_ERROR', [{ field: 'currentPassword', issue: 'minLength' }]]);
    assert.deepEqual(await errorOf(await office.call('PUT', '/me/password', own.accessToken, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD, extra: 1 })), [422, 'VALIDATION_ERROR', [{ field: 'extra', issue: 'unknown' }]]);
  });

  it('needs a valid credential', async () => {
    assert.deepEqual(await errorOf(await office.call('PUT', '/me/password', undefined, { currentPassword: 'x', newPassword: 'y' })), [401, 'UNAUTHENTICATED', undefined]);
  });

  it('removes the legacy hash once the coexistence is off, and scrypt alone then decides', async () => {
    const own = await openTestDatabases();
    const solo = await startBackoffice(own, { env: { LEGACY_PASSWORD_COEXISTENCE: 'false' } });
    cleanups.push(async () => {
      await solo.close();
      await own.cleanup();
    });
    const { id, name } = await addBackofficeUser(own, solo);
    const tokens = await solo.tokens(name);
    assert.equal((await solo.call('PUT', '/me/password', tokens.accessToken, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD })).status, 204);
    const users = own.databases.common().collection('users');
    assert.equal('password' in ((await users.findOne({ _id: id })) ?? {}), false);
    assert.deepEqual([(await own.databases.common().collection('userCredentials').findOne({ _id: id }))?.['legacyHashFingerprint']], [null]);
    assert.equal((await solo.login(name, NEW_PASSWORD)).status, 200);
    assert.equal((await solo.login(name, TEST_PASSWORD)).status, 401);
    // The new password is also the one the next change must present.
    assert.equal((await solo.call('PUT', '/me/password', tokens.accessToken, { currentPassword: NEW_PASSWORD, newPassword: `${NEW_PASSWORD} again` })).status, 204);
  });

  it('limits the attempts per user', async () => {
    const own = await openTestDatabases();
    const limited = await startBackoffice(own, { rateLimiter: createRateLimiter(own.databases, () => FROZEN_NOW), env: { RATE_LIMIT_LOGIN_PER_USERNAME: '2' } });
    cleanups.push(async () => {
      await limited.close();
      await own.cleanup();
    });
    const { name } = await addBackofficeUser(own, limited);
    const tokens = await limited.tokens(name);
    const attempt = async () => limited.call('PUT', '/me/password', tokens.accessToken, { currentPassword: 'wrong', newPassword: NEW_PASSWORD });
    assert.equal((await attempt()).status, 422);
    assert.equal((await attempt()).status, 422);
    const third = await attempt();
    assert.equal(third.status, 429);
    assert.ok(Number(third.headers.get('retry-after')) >= 1);
  });
});

describe('own sessions', () => {
  it('lists the active sessions of the user only, most recent first, marking the current one', async () => {
    const { name } = await addUser();
    const other = await addUser();
    const first = await office.tokens(name, { 'user-agent': 'First/1' });
    office.clock.advance(1000);
    const second = await office.tokens(name, { 'user-agent': 'Second/2' });
    const ended = await office.tokens(name);
    await office.call('POST', '/auth/logout', ended.accessToken);
    await office.tokens(other.name);
    const response = await office.call('GET', '/me/sessions', first.accessToken);
    assert.equal(response.status, 200);
    const text = await response.clone().text();
    assert.ok(!text.includes('Hash') && !text.includes(first.refreshToken) && !text.includes(first.accessToken));
    const { data } = JSON.parse(text) as { data: Array<Record<string, unknown>> };
    assert.deepEqual(data.map((item) => item['id']), [second.sessionId, first.sessionId]);
    assert.deepEqual(data.map((item) => item['current']), [false, true]);
    assert.deepEqual(Object.keys(data[0]!).sort(), ['createdAt', 'current', 'id', 'ip', 'lastUsedAt', 'userAgent']);
    assert.deepEqual(data.map((item) => item['userAgent']), ['Second/2', 'First/1']);
    assert.match(data[0]!['ip'] as string, /127\.0\.0\.1/);
    assert.equal(Date.parse(data[0]!['createdAt'] as string) - Date.parse(data[1]!['createdAt'] as string), 1000);
  });

  it('does not list a session whose inactivity period is over', async () => {
    const { name } = await addUser();
    const old = await office.tokens(name);
    office.clock.advance(7 * 86_400_000 + 1000);
    const fresh = await office.tokens(name);
    const { data } = (await (await office.call('GET', '/me/sessions', fresh.accessToken)).json()) as { data: Array<{ id: string }> };
    assert.deepEqual(data.map((item) => item.id), [fresh.sessionId]);
    assert.ok(old.sessionId !== fresh.sessionId);
  });

  it('revokes one of the own sessions and records it', async () => {
    const { id, name } = await addUser();
    const here = await office.tokens(name);
    const there = await office.tokens(name);
    const mark = since();
    const response = await office.call('DELETE', `/me/sessions/${there.sessionId}`, here.accessToken);
    assert.equal(response.status, 204);
    assert.equal((await office.call('GET', '/me', there.accessToken)).status, 401);
    assert.equal((await office.call('GET', '/me', here.accessToken)).status, 200);
    const [event, ...others] = logged(mark);
    assert.equal(others.length, 0);
    assert.deepEqual([event?.action, event?.metadata, event?.actor.id?.toHexString(), event?.resource?.id], ['session.revoked', { reason: 'revokedByUser' }, id.toHexString(), there.sessionId]);
    // The current session can be ended the same way.
    assert.equal((await office.call('DELETE', `/me/sessions/${here.sessionId}`, here.accessToken)).status, 204);
    assert.equal((await office.call('GET', '/me', here.accessToken)).status, 401);
  });

  it('answers 404 for the session of another user, a missing one and one already revoked, and 422 for a malformed id', async () => {
    const mine = await addUser();
    const theirs = await addUser();
    const own = await office.tokens(mine.name);
    const foreign = await office.tokens(theirs.name);
    const attempt = async (sessionId: string) => errorOf(await office.call('DELETE', `/me/sessions/${sessionId}`, own.accessToken));
    assert.deepEqual(await attempt(foreign.sessionId), [404, 'NOT_FOUND', undefined]);
    assert.equal((await office.call('GET', '/me', foreign.accessToken)).status, 200);
    assert.deepEqual(await attempt(new ObjectId().toHexString()), [404, 'NOT_FOUND', undefined]);
    const ended = await office.tokens(mine.name);
    assert.equal((await office.call('DELETE', `/me/sessions/${ended.sessionId}`, own.accessToken)).status, 204);
    assert.deepEqual(await attempt(ended.sessionId), [404, 'NOT_FOUND', undefined]);
    assert.deepEqual(await attempt('not-an-id'), [422, 'VALIDATION_ERROR', [{ field: 'sessionId', issue: 'format' }]]);
    assert.deepEqual(await errorOf(await office.call('DELETE', `/me/sessions/${foreign.sessionId}`, undefined)), [401, 'UNAUTHENTICATED', undefined]);
  });
});

describe('group summary repository', () => {
  it('reads only the id and the name, and answers null for a group that does not exist', async () => {
    const repository = createGroupSummaryRepository(ctx.databases);
    const group = office.cluster.groups[0]!;
    assert.deepEqual(await repository.find(group.groupId), { id: group.groupId.toHexString(), name: 'group-001', features: featuresOf({ warehouse: true, cash: true }) });
    assert.equal(await repository.find(new ObjectId()), null);
  });
});
