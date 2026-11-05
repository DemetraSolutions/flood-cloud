import { after, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { createRateLimiter } from '../../src/shared/security/rate-limit/rate-limiter.ts';
import { memoryRateLimiter } from '../helpers/activity.ts';
import { TEST_PASSWORD, addUser as addBackofficeUser, hashWithTestPepper, startBackoffice, userName } from '../helpers/backoffice.ts';
import type { Backoffice, Tokens } from '../helpers/backoffice.ts';
import { fixtureId } from '../helpers/legacy-fixtures.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';

/** A frozen clock for the real counters: the one-minute window cannot change in the middle of a test. */
// Frozen at the real time of the run, never in the past: counters live in MongoDB with a TTL, and the TTL monitor
// would delete the counters of a window that already ended while the test is still running.
const FROZEN_NOW = Date.now();
let ctx: TestDatabases;
let office: Backoffice;
const limiter = memoryRateLimiter();

before(async () => {
  ctx = await openTestDatabases();
  office = await startBackoffice(ctx, { rateLimiter: limiter });
});
after(async () => {
  await office.close();
  await ctx.cleanup();
});

const users = () => ctx.databases.common().collection('users');
const credentials = () => ctx.databases.common().collection('userCredentials');
const sessions = () => ctx.databases.common().collection('sessions');
const addUser = (overrides: Document = {}) => addBackofficeUser(ctx, office, overrides);

const events = (since: number) => office.activity.entries.slice(since);

describe('POST /v1/auth/login: success', () => {
  it('returns the token pair, stores only hashes and logs the success', async () => {
    const sa = office.cluster.groups[0]!.sa;
    const since = office.activity.entries.length;
    const response = await office.login(userName(sa), TEST_PASSWORD, { 'user-agent': 'Fixture/1.0', 'accept-encoding': 'gzip' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-encoding'), null);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const { data } = (await response.json()) as { data: Tokens };
    assert.deepEqual(Object.keys(data).sort(), ['accessToken', 'accessTokenExpiresAt', 'passwordChangeRequired', 'refreshToken', 'refreshTokenExpiresAt', 'sessionId']);
    assert.match(data.accessToken, /^fc_at_[A-Za-z0-9_-]{43}$/);
    assert.match(data.refreshToken, /^fc_rt_[A-Za-z0-9_-]{43}$/);
    const now = office.clock.now();
    assert.equal(data.accessTokenExpiresAt, new Date(now + 900_000).toISOString());
    assert.equal(data.refreshTokenExpiresAt, new Date(now + 604_800_000).toISOString());

    const session = await sessions().findOne({ _id: ObjectId.createFromHexString(data.sessionId) });
    assert.ok(session !== null);
    assert.equal(session['accessTokenHash'], createHash('sha256').update(data.accessToken).digest('hex'));
    assert.equal(session['refreshTokenHash'], createHash('sha256').update(data.refreshToken).digest('hex'));
    assert.deepEqual(session['previousRefreshHashes'], []);
    assert.equal(session['userAgent'], 'Fixture/1.0');
    assert.equal(session['revokedAt'], null);
    assert.equal((session['familyExpiresAt'] as Date).getTime(), now + 2_592_000_000);
    assert.equal((session['expiresAt'] as Date).getTime(), now + 2_592_000_000 + 86_400_000);
    assert.ok(!JSON.stringify(session).includes(data.accessToken) && !JSON.stringify(session).includes(data.refreshToken));

    const [logged, ...rest] = events(since);
    assert.equal(rest.length, 0);
    assert.deepEqual(
      { category: logged?.category, action: logged?.action, outcome: logged?.outcome, actor: logged?.actor.id?.toHexString(), role: logged?.actor.role, group: logged?.groupId?.toHexString() },
      { category: 'security', action: 'auth.loginSucceeded', outcome: 'success', actor: sa.toHexString(), role: 'SA', group: office.cluster.groups[0]!.groupId.toHexString() },
    );
    assert.ok(!JSON.stringify(logged).includes(userName(sa)));
  });

  it('lets PSA, dealer, SA, CA and PA in', async () => {
    const group = office.cluster.groups[0]!;
    for (const id of [office.cluster.psa, office.cluster.dealerA, group.sa, group.ca, group.pa]) {
      assert.equal((await office.login(userName(id))).status, 200, userName(id));
    }
  });

  it('matches the username without regard to case', async () => {
    assert.equal((await office.login(userName(office.cluster.groups[0]!.sa).toUpperCase())).status, 200);
  });

  it('turns a legacy password into scrypt credentials with the fingerprint of the legacy hash', async () => {
    const { id, name } = await addUser();
    assert.equal(await credentials().findOne({ _id: id }), null);
    assert.equal((await office.login(name)).status, 200);
    const stored = await credentials().findOne({ _id: id });
    assert.ok(stored !== null);
    assert.match(stored['passwordHash'] as string, /^scrypt\$/);
    assert.equal(stored['legacyHashFingerprint'], createHash('sha256').update(hashWithTestPepper(TEST_PASSWORD)).digest('hex'));
    assert.equal(stored['failedLogins'], 0);
    assert.ok(stored['lastLoginAt'] instanceof Date);
    // The second login is decided by scrypt and writes nothing new to the password.
    assert.equal((await office.login(name)).status, 200);
    assert.equal((await credentials().findOne({ _id: id }))?.['passwordHash'], stored['passwordHash']);
  });

  it('follows a password changed by the legacy: the old one stops working, the new one starts', async () => {
    const { id, name } = await addUser();
    assert.equal((await office.login(name)).status, 200);
    const changed = 'changed-by-the-legacy-1';
    await users().updateOne({ _id: id }, { $set: { password: hashWithTestPepper(changed) } });
    assert.equal((await office.login(name, TEST_PASSWORD)).status, 401);
    assert.equal((await office.login(name, changed)).status, 200);
    const stored = await credentials().findOne({ _id: id });
    assert.equal(stored?.['legacyHashFingerprint'], createHash('sha256').update(hashWithTestPepper(changed)).digest('hex'));
    assert.equal((await office.login(name, changed)).status, 200);
  });
});

describe('POST /v1/auth/login: refusals', () => {
  const refused = async (response: Response): Promise<void> => {
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: { code: 'INVALID_CREDENTIALS', message: 'Invalid credentials' } });
  };

  it('answers the same to a wrong password and an unknown user, with the same scrypt cost, and never logs the username', async () => {
    const { id, name } = await addUser();
    const scrypt = mock.method(crypto, 'scrypt');
    try {
      const since = office.activity.entries.length;
      await refused(await office.login(name, 'not the password'));
      const wrongPasswordRuns = scrypt.mock.callCount();
      await refused(await office.login('nobody-has-this-name', 'not the password'));
      assert.equal(scrypt.mock.callCount() - wrongPasswordRuns, wrongPasswordRuns);
      assert.ok(wrongPasswordRuns >= 1);
      const [wrong, unknown] = events(since);
      assert.deepEqual([wrong?.action, wrong?.outcome, wrong?.metadata, wrong?.actor.id?.toHexString()], ['auth.loginFailed', 'failure', { reason: 'wrongPassword' }, id.toHexString()]);
      assert.deepEqual([unknown?.action, unknown?.metadata, unknown?.actor], ['auth.loginFailed', { reason: 'unknownUser' }, { kind: 'anonymous' }]);
      assert.ok(!JSON.stringify(events(since)).includes(name) && !JSON.stringify(events(since)).includes('nobody-has-this-name'));
    } finally {
      scrypt.mock.restore();
    }
    assert.equal((await credentials().findOne({ _id: id }))?.['failedLogins'], 1);
  });

  const states: Array<[string, Document, string]> = [
    ['employee (E)', { role: 'E' }, 'roleNotAllowed'],
    ['retired API role', { role: 'API' }, 'roleNotAllowed'],
    ['disabled user', { status: false }, 'userDisabled'],
    ['trashed user', { trash: true }, 'userTrashed'],
    ['user of a group that does not exist', { groupId: fixtureId('group', 777) }, 'groupMissing'],
    ['SA without group', { groupId: null }, 'groupMissing'],
  ];
  for (const [label, overrides, reason] of states) {
    it(`refuses a ${label} with the same answer and records ${reason}`, async () => {
      const { id, name } = await addUser(overrides);
      const since = office.activity.entries.length;
      await refused(await office.login(name));
      const [logged] = events(since);
      assert.deepEqual([logged?.action, logged?.metadata, logged?.actor.id?.toHexString()], ['auth.loginFailed', { reason }, id.toHexString()]);
      assert.equal(await sessions().countDocuments({ userId: id }), 0);
      // The password was right: the failure counter is untouched.
      assert.equal((await credentials().findOne({ _id: id }))?.['failedLogins'] ?? 0, 0);
    });
  }

  for (const [label, groupChange] of [
    ['suspended', { status: false }],
    ['trashed', { trash: true }],
  ] as const) {
    it(`refuses SA, CA and PA of a ${label} group`, async () => {
      const group = office.cluster.groups[3]!;
      await ctx.databases.common().collection('groups').updateOne({ _id: group.groupId }, { $set: groupChange });
      try {
        for (const id of [group.sa, group.ca, group.pa]) {
          const since = office.activity.entries.length;
          await refused(await office.login(userName(id)));
          assert.deepEqual(events(since)[0]?.metadata, { reason: 'groupUnavailable' });
        }
        // Platform and dealer users are not tied to the group.
        assert.equal((await office.login(userName(office.cluster.psa))).status, 200);
      } finally {
        await ctx.databases.common().collection('groups').updateOne({ _id: group.groupId }, { $set: { status: true, trash: false } });
      }
    });
  }

  it('runs a single scrypt when the password is right but the account may not sign in, even with outdated scrypt parameters', async () => {
    const legacyHash = hashWithTestPepper(TEST_PASSWORD);
    const salt = randomBytes(16);
    const outdated = ['scrypt', 1024, 8, 1, salt.toString('base64url'), scryptSync(TEST_PASSWORD, salt, 32, { N: 1024, r: 8, p: 1 }).toString('base64url')].join('$');
    const states: Document[] = [{ status: false }, { role: 'E' }, { trash: true }, { groupId: fixtureId('group', 778) }];
    for (const viaScrypt of [true, false]) {
      for (const state of states) {
        const { id, name } = await addUser(state);
        if (viaScrypt) {
          const now = new Date();
          await credentials().insertOne({ _id: id, passwordHash: outdated, legacyHashFingerprint: createHash('sha256').update(legacyHash).digest('hex'), failedLogins: 0, createdAt: now, updatedAt: now });
        }
        const scrypt = mock.method(crypto, 'scrypt');
        try {
          await refused(await office.login(name));
          assert.equal(scrypt.mock.callCount(), 1, `${viaScrypt ? 'scrypt' : 'legacy'} ${JSON.stringify(state)}`);
        } finally {
          scrypt.mock.restore();
        }
        assert.equal((await credentials().findOne({ _id: id }))?.['passwordHash'] ?? null, viaScrypt ? outdated : null);
      }
    }
    // Allowed: the verification and the rehash, two runs, and the stored hash gets the current parameters.
    const { id, name } = await addUser();
    const now = new Date();
    await credentials().insertOne({ _id: id, passwordHash: outdated, legacyHashFingerprint: createHash('sha256').update(legacyHash).digest('hex'), failedLogins: 0, createdAt: now, updatedAt: now });
    const scrypt = mock.method(crypto, 'scrypt');
    try {
      assert.equal((await office.login(name)).status, 200);
      assert.equal(scrypt.mock.callCount(), 2);
    } finally {
      scrypt.mock.restore();
    }
    assert.notEqual((await credentials().findOne({ _id: id }))?.['passwordHash'], outdated);
  });

  it('locks the account progressively after five failures and does not count attempts while locked', async () => {
    const { id, name } = await addUser();
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await refused(await office.login(name, 'wrong'));
    }
    const locked = await credentials().findOne({ _id: id });
    assert.equal(locked?.['failedLogins'], 5);
    assert.equal((locked?.['lockedUntil'] as Date).getTime(), office.clock.now() + 60_000);
    const since = office.activity.entries.length;
    const scrypt = mock.method(crypto, 'scrypt');
    try {
      await refused(await office.login(name));
      assert.equal(scrypt.mock.callCount(), 1);
    } finally {
      scrypt.mock.restore();
    }
    assert.equal((await credentials().findOne({ _id: id }))?.['failedLogins'], 5);
    assert.deepEqual(events(since)[0]?.metadata, { reason: 'locked' });
    office.clock.advance(61_000);
    assert.equal((await office.login(name)).status, 200);
    const cleared = await credentials().findOne({ _id: id });
    assert.deepEqual([cleared?.['failedLogins'], cleared?.['lockedUntil']], [0, null]);
  });

  it('refuses without any hash a username or password outside 1 to 1024 units, after the rate limit', async () => {
    const { name } = await addUser();
    const scrypt = mock.method(crypto, 'scrypt');
    try {
      const callsBefore = limiter.calls.length;
      for (const [username, password, reason] of [
        ['x'.repeat(1025), TEST_PASSWORD, 'invalidInput'],
        [name, 'p'.repeat(1025), 'invalidInput'],
        ['', TEST_PASSWORD, 'invalidInput'],
        [name, '', 'invalidInput'],
      ] as const) {
        const since = office.activity.entries.length;
        await refused(await office.login(username, password));
        assert.deepEqual(events(since)[0]?.metadata, { reason });
      }
      assert.equal(scrypt.mock.callCount(), 0);
      // The IP rule ran four times; the username rule for the three non-empty usernames.
      const consumed = limiter.calls.slice(callsBefore).map((call) => call.bucket);
      assert.equal(consumed.filter((bucket) => bucket === 'login:ip').length, 4);
      assert.equal(consumed.filter((bucket) => bucket === 'login:username').length, 3);
      assert.ok(limiter.calls.some((call) => call.bucket === 'login:username' && call.key === 'x'.repeat(1025)));
      // The limit itself is inclusive.
      const edge = await office.login('y'.repeat(1024), 'p'.repeat(1024));
      await refused(edge);
      assert.ok(scrypt.mock.callCount() >= 1);
    } finally {
      scrypt.mock.restore();
    }
  });

  it('answers 413 to a body over 4 KB', async () => {
    const response = await office.call('POST', '/auth/login', undefined, { username: 'a', password: 'x'.repeat(5000) });
    assert.equal(response.status, 413);
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, 'PAYLOAD_TOO_LARGE');
  });
});

describe('POST /v1/auth/login: malformed requests', () => {
  const code = async (response: Response): Promise<[number, string, unknown]> => {
    const body = (await response.json()) as { error: { code: string; details?: unknown } };
    return [response.status, body.error.code, body.error.details];
  };

  it('answers 422 to a username that is not a string, a missing field, an unknown field and an empty body', async () => {
    assert.deepEqual(await code(await office.call('POST', '/auth/login', undefined, { username: { $ne: null }, password: 'x' })), [422, 'VALIDATION_ERROR', [{ field: 'username', issue: 'type' }]]);
    assert.deepEqual(await code(await office.call('POST', '/auth/login', undefined, { username: 5, password: 'x' })), [422, 'VALIDATION_ERROR', [{ field: 'username', issue: 'type' }]]);
    assert.deepEqual(await code(await office.call('POST', '/auth/login', undefined, { username: 'a' })), [422, 'VALIDATION_ERROR', [{ field: 'password', issue: 'required' }]]);
    assert.deepEqual(await code(await office.call('POST', '/auth/login', undefined, { username: 'a', password: 'x', role: 'PSA' })), [422, 'VALIDATION_ERROR', [{ field: 'role', issue: 'unknown' }]]);
    const empty = await fetch(`${office.app.baseUrl}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' } });
    assert.deepEqual(await code(empty), [422, 'VALIDATION_ERROR', [{ field: 'username', issue: 'required' }, { field: 'password', issue: 'required' }]]);
  });

  it('answers 415 to another content type and 400 to malformed JSON', async () => {
    const text = await fetch(`${office.app.baseUrl}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' });
    assert.equal(text.status, 415);
    const broken = await fetch(`${office.app.baseUrl}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
    assert.deepEqual(await code(broken), [400, 'MALFORMED_JSON', undefined]);
  });
});

describe('POST /v1/auth/login: rate limit (real counters)', () => {
  let limited: Backoffice;
  before(async () => {
    const own = await openTestDatabases();
    limited = await startBackoffice(own, {
      rateLimiter: createRateLimiter(own.databases, () => FROZEN_NOW),
      env: { RATE_LIMIT_LOGIN_PER_USERNAME: '2', RATE_LIMIT_LOGIN_PER_IP: '5' },
    });
    cleanups.push(async () => {
      await limited.close();
      await own.cleanup();
    });
  });
  const cleanups: Array<() => Promise<void>> = [];
  after(async () => {
    for (const cleanup of cleanups) {
      await cleanup();
    }
  });

  it('answers 429 with Retry-After on the third attempt for the same username, whatever its case, then on the sixth from one IP', async () => {
    const name = userName(limited.cluster.groups[0]!.sa);
    assert.equal((await limited.login(name, 'wrong')).status, 401);
    assert.equal((await limited.login(name.toUpperCase(), 'wrong')).status, 401);
    const third = await limited.login(name, 'wrong');
    assert.equal(third.status, 429);
    assert.ok(Number(third.headers.get('retry-after')) >= 1);
    assert.equal(((await third.json()) as { error: { code: string } }).error.code, 'RATE_LIMITED');
    // Three attempts so far fed the IP counter; two more for other names reach its limit of five.
    assert.equal((await limited.login('someone-else', 'wrong')).status, 401);
    assert.equal((await limited.login('another-one', 'wrong')).status, 401);
    const sixth = await limited.login('yet-another', 'wrong');
    assert.equal(sixth.status, 429);
    assert.equal(sixth.headers.get('ratelimit-remaining'), '0');
  });
});
