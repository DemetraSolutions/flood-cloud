import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { startBackoffice } from '../helpers/backoffice.ts';
import type { Backoffice } from '../helpers/backoffice.ts';
import { fixtureId } from '../helpers/legacy-fixtures.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { actors, send } from '../helpers/users.ts';
import { memoryRateLimiter } from '../helpers/activity.ts';
import { legacyPasswordHash } from '../../src/shared/security/legacy-password.ts';
import { Secret } from '../../src/shared/security/secret.ts';
import { TEST_PEPPER } from '../helpers/backoffice.ts';

let ctx: TestDatabases;
let office: Backoffice;
let as: ReturnType<typeof actors>;

const PROVISIONAL = `Prov-${randomBytes(8).toString('hex')}-pass`;
const CHOSEN = `Chosen-${randomBytes(8).toString('hex')}-pass`;
const g0 = () => office.cluster.groups[0]!;
const hex = (id: ObjectId) => id.toHexString();
const blocked = { status: 403, code: 'PASSWORD_CHANGE_REQUIRED' };

before(async () => {
  ctx = await openTestDatabases();
  office = await startBackoffice(ctx);
  as = actors(office);
});
after(async () => {
  await office.close();
  await ctx.cleanup();
});

/** Creates a PA through the API and logs him in with the provisional password. */
async function newcomer(name: string) {
  const created = await as.call(g0().sa, 'POST', `/groups/${hex(g0().groupId)}/users`, { username: name, password: PROVISIONAL, role: 'PA', placeIds: [hex(fixtureId('place', 1))] });
  assert.equal(created.status, 201);
  const login = await office.login(name, PROVISIONAL);
  const tokens = ((await login.json()) as { data: { accessToken: string; refreshToken: string; passwordChangeRequired: boolean } }).data;
  return { id: ObjectId.createFromHexString(created.body.data.id), ...tokens };
}

const outcome = async (method: string, path: string, token: string, body?: unknown) => {
  const reply = await send(office, method, path, token, body);
  return { status: reply.status, code: reply.body?.error?.code as string | undefined };
};

describe('a provisional password must be replaced before anything else', () => {
  it('tells the login about it, lets only the profile, the password change and the logout through, and nothing else', async () => {
    const user = await newcomer('provisional-one');
    assert.equal(user.passwordChangeRequired, true);
    const me = await send(office, 'GET', '/me', user.accessToken);
    assert.deepEqual([me.status, me.body.data.passwordChangeRequired], [200, true]);
    const group = `/groups/${hex(g0().groupId)}`;
    const closed: Array<[string, string, unknown?]> = [
      ['PATCH', '/me', { firstName: 'x' }],
      ['GET', '/me/sessions'],
      ['DELETE', `/me/sessions/${hex(new ObjectId())}`],
      ['GET', `${group}/users`],
      ['POST', `${group}/users`, {}],
      ['GET', `${group}/users/${hex(user.id)}`],
      ['GET', '/users'],
      ['GET', '/usernames/anything/availability'],
    ];
    for (const [method, path, body] of closed) {
      assert.deepEqual(await outcome(method, path, user.accessToken, body), { status: blocked.status, code: blocked.code }, `${method} ${path}`);
    }
    // An unknown route is a 404 for everybody; a bad token is still a 401, not a 403.
    assert.equal((await outcome('GET', '/nothing-here', user.accessToken)).status, 404);
    assert.equal((await outcome('GET', '/me', 'fc_at_' + 'A'.repeat(43))).status, 401);
    // The refresh goes on working, and so does the logout.
    const refreshed = await send(office, 'POST', '/auth/refresh', undefined, { refreshToken: user.refreshToken });
    assert.equal(refreshed.status, 200);
    assert.ok(!('passwordChangeRequired' in refreshed.body.data));
    assert.equal((await outcome('POST', '/auth/logout', refreshed.body.data.accessToken)).status, 204);
    const again = ((await (await office.login('provisional-one', PROVISIONAL)).json()) as { data: { accessToken: string } }).data;
    assert.equal((await outcome('POST', '/auth/logout-all', again.accessToken)).status, 204);
  });

  it('is released by changing the password: the flag goes, the other sessions end, the new password is also the legacy one', async () => {
    const user = await newcomer('provisional-two');
    const other = ((await (await office.login('provisional-two', PROVISIONAL)).json()) as { data: { accessToken: string } }).data;
    const wrong = await send(office, 'PUT', '/me/password', user.accessToken, { currentPassword: 'not the password', newPassword: CHOSEN });
    assert.deepEqual([wrong.status, wrong.body.error.details], [422, [{ field: 'currentPassword', issue: 'incorrect' }]]);
    assert.equal((await send(office, 'GET', '/me', user.accessToken)).body.data.passwordChangeRequired, true);
    // The provisional password cannot be its own replacement.
    const same = await send(office, 'PUT', '/me/password', user.accessToken, { currentPassword: PROVISIONAL, newPassword: PROVISIONAL });
    assert.deepEqual([same.status, same.body.error.details], [422, [{ field: 'newPassword', issue: 'reused' }]]);
    assert.equal((await send(office, 'GET', '/me', user.accessToken)).body.data.passwordChangeRequired, true);
    const changed = await send(office, 'PUT', '/me/password', user.accessToken, { currentPassword: PROVISIONAL, newPassword: CHOSEN });
    assert.equal(changed.status, 204);
    const me = await send(office, 'GET', '/me', user.accessToken);
    assert.deepEqual([me.status, me.body.data.passwordChangeRequired], [200, false]);
    assert.equal((await outcome('GET', `/groups/${hex(g0().groupId)}/users`, user.accessToken)).status, 200);
    assert.equal((await outcome('GET', '/me', other.accessToken)).status, 401, 'the other session ended');
    const credentials = (await ctx.databases.common().collection('userCredentials').findOne({ _id: user.id }))!;
    assert.equal(credentials['mustChangePassword'], false);
    assert.equal((await ctx.databases.common().collection('users').findOne({ _id: user.id }))!['password'], legacyPasswordHash(CHOSEN, new Secret(TEST_PEPPER)));
    const login = ((await (await office.login('provisional-two', CHOSEN)).json()) as { data: { passwordChangeRequired: boolean } }).data;
    assert.equal(login.passwordChangeRequired, false);
  });

  it('comes back when an administrator resets the password again', async () => {
    const user = await newcomer('provisional-three');
    await send(office, 'PUT', '/me/password', user.accessToken, { currentPassword: PROVISIONAL, newPassword: CHOSEN });
    assert.equal((await outcome('GET', '/me/sessions', user.accessToken)).status, 200);
    const reset = await as.call(g0().sa, 'PUT', `/groups/${hex(g0().groupId)}/users/${hex(user.id)}/password`, { password: PROVISIONAL });
    assert.equal(reset.status, 204);
    const login = ((await (await office.login('provisional-three', PROVISIONAL)).json()) as { data: { accessToken: string; passwordChangeRequired: boolean } }).data;
    assert.equal(login.passwordChangeRequired, true);
    assert.equal((await outcome('GET', '/me/sessions', login.accessToken)).code, 'PASSWORD_CHANGE_REQUIRED');
  });

  it('does not touch users who chose their own password', async () => {
    const login = await office.login('user-003');
    const data = ((await login.json()) as { data: { accessToken: string; passwordChangeRequired: boolean } }).data;
    assert.equal(data.passwordChangeRequired, false);
    assert.equal((await outcome('GET', '/me/sessions', data.accessToken)).status, 200);
    assert.equal((await send(office, 'GET', '/me', data.accessToken)).body.data.passwordChangeRequired, false);
  });
});

describe('the refusal comes after the rate limit', () => {
  it('counts a refused request against the API limit of the user, so a pending account cannot hammer the API for free', async () => {
    const own = await openTestDatabases();
    const limiter = memoryRateLimiter();
    const limited = await startBackoffice(own, { rateLimiter: limiter });
    try {
      const group = limited.cluster.groups[0]!;
      const tools = actors(limited);
      const created = await tools.call(group.sa, 'POST', `/groups/${hex(group.groupId)}/users`, { username: 'pending.counted', password: PROVISIONAL, role: 'PA', placeIds: [hex(fixtureId('place', 1))] });
      const login = ((await (await limited.login('pending.counted', PROVISIONAL)).json()) as { data: { accessToken: string } }).data;
      const before = limiter.calls.filter((call) => call.bucket === 'api:user').length;
      const refused = await send(limited, 'GET', '/users', login.accessToken);
      assert.deepEqual([refused.status, refused.body.error.code], [403, 'PASSWORD_CHANGE_REQUIRED']);
      const after = limiter.calls.filter((call) => call.bucket === 'api:user');
      assert.equal(after.length, before + 1);
      assert.equal(after.at(-1)!.key, created.body.data.id);
    } finally {
      await limited.close();
      await own.cleanup();
    }
  });
});
