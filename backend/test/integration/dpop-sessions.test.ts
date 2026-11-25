import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { TEST_PASSWORD, addUser as addBackofficeUser, startBackoffice, userName } from '../helpers/backoffice.ts';
import type { Backoffice, Tokens } from '../helpers/backoffice.ts';
import { memoryRateLimiter } from '../helpers/activity.ts';
import { TEST_API_PUBLIC_BASE_URL, newBrowserKey, signProof } from '../helpers/dpop.ts';
import type { BrowserKey } from '../helpers/dpop.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { startKeysWorld } from '../helpers/api-keys.ts';
import type { KeysWorld } from '../helpers/api-keys.ts';

let ctx: TestDatabases;
let world: KeysWorld;
let office: Backoffice;

before(async () => {
  ctx = await openTestDatabases();
  world = await startKeysWorld(ctx);
  office = world.office;
});
after(async () => {
  await office.close();
  await ctx.cleanup();
});

const users = () => ctx.databases.common().collection('users');
const sessions = () => ctx.databases.common().collection('sessions');
const credentials = () => ctx.databases.common().collection('userCredentials');
const addUser = (overrides: Document = {}) => addBackofficeUser(ctx, office, overrides);
const url = (path: string) => `${office.app.baseUrl}/v1${path}`;
const errorOf = async (response: Response): Promise<[number, string]> => [response.status, ((await response.json()) as { error: { code: string } }).error.code];
const since = (): number => office.activity.entries.length;
const logged = (from: number) => office.activity.entries.slice(from);
const secondsNow = (): number => Math.floor(office.clock.now() / 1000);
const stored = (tokens: Tokens) => sessions().findOne({ _id: ObjectId.createFromHexString(tokens.sessionId) });
const dpopEvents = (from: number) => logged(from).filter((entry) => entry.action === 'auth.dpopRejected');
const signedFor = (key: BrowserKey, method: string, path: string, extra: { accessToken?: string; refreshToken?: string; iat?: number } = {}): string =>
  signProof(key, { method, path: `/v1${path}`, iat: extra.iat ?? secondsNow(), ...extra });

/** A new user with a fresh login. */
async function session(): Promise<{ id: ObjectId; name: string; tokens: Tokens; key: BrowserKey }> {
  const { id, name } = await addUser();
  const tokens = await office.tokens(name);
  return { id, name, tokens, key: office.keyOf(tokens.accessToken) };
}

const refreshWith = (refreshToken: string, dpop: string | undefined) =>
  fetch(url('/auth/refresh'), { method: 'POST', headers: { 'content-type': 'application/json', ...(dpop === undefined ? {} : { dpop }) }, body: JSON.stringify({ refreshToken }) });
const loginWith = (name: string, dpop: string | undefined, password = TEST_PASSWORD) =>
  fetch(url('/auth/login'), { method: 'POST', headers: { 'content-type': 'application/json', ...(dpop === undefined ? {} : { dpop }) }, body: JSON.stringify({ username: name, password }) });

describe('the proof of a request to /v1', () => {
  it('needs the DPoP scheme: a missing or Bearer credential is UNAUTHENTICATED', async () => {
    const { tokens } = await session();
    assert.deepEqual(await errorOf(await fetch(url('/me'))), [401, 'UNAUTHENTICATED']);
    assert.deepEqual(await errorOf(await fetch(url('/me'), { headers: { ...office.userHeaders('GET', '/me', tokens.accessToken), authorization: `Bearer ${tokens.accessToken}` } })), [401, 'UNAUTHENTICATED']);
  });

  it('answers INVALID_DPOP_PROOF with the challenge and a fixed message when the proof is missing or junk', async () => {
    const { tokens } = await session();
    for (const dpop of [undefined, '', 'junk', 'a.b.c']) {
      const response = await fetch(url('/me'), { headers: { authorization: `DPoP ${tokens.accessToken}`, ...(dpop === undefined ? {} : { dpop }) } });
      assert.equal(response.headers.get('www-authenticate'), 'DPoP algs="ES256"');
      assert.deepEqual(await response.json(), { error: { code: 'INVALID_DPOP_PROOF', message: 'Invalid proof of possession' } });
    }
  });

  it('refuses a proof made for another method, another URL, another token or another time', async () => {
    const { tokens, key } = await session();
    const other = await session();
    const headers = (extra: Parameters<Backoffice['userHeaders']>[3]) => office.userHeaders('GET', '/me', tokens.accessToken, { key, ...extra });
    const cases: Array<[string, Record<string, string>]> = [
      ['method', headers({ method: 'POST' })],
      ['path', headers({ path: '/me/sessions' })],
      ['another token', headers({ boundTo: other.tokens.accessToken })],
      ['too old', headers({ iat: secondsNow() - 61 })],
      ['too new', headers({ iat: secondsNow() + 61 })],
      ['another host', { authorization: `DPoP ${tokens.accessToken}`, dpop: signProof(key, { method: 'GET', path: '/v1/me', iat: secondsNow(), accessToken: tokens.accessToken, htu: 'https://evil.example.test/api/v1/me' }) }],
      ['no ath', { authorization: `DPoP ${tokens.accessToken}`, dpop: signedFor(key, 'GET', '/me') }],
    ];
    for (const [label, sent] of cases) {
      assert.deepEqual(await errorOf(await fetch(url('/me'), { headers: sent })), [401, 'INVALID_DPOP_PROOF'], label);
    }
    assert.equal((await fetch(url('/me?ignored=1'), { headers: office.userHeaders('GET', '/me', tokens.accessToken) })).status, 200);
  });

  it('answers INVALID_DPOP_PROOF before TOKEN_EXPIRED, and TOKEN_EXPIRED only to a valid proof of the key of the session', async () => {
    const { tokens } = await session();
    office.clock.advance(901_000);
    assert.deepEqual(await errorOf(await fetch(url('/me'), { headers: { authorization: `DPoP ${tokens.accessToken}`, dpop: 'junk' } })), [401, 'INVALID_DPOP_PROOF']);
    assert.deepEqual(await errorOf(await office.call('GET', '/me', tokens.accessToken)), [401, 'TOKEN_EXPIRED']);
    // The key of another browser is not told that the token expired: it ends the family.
    const foreign = await fetch(url('/me'), { headers: office.userHeaders('GET', '/me', tokens.accessToken, { key: newBrowserKey() }) });
    assert.deepEqual(await errorOf(foreign), [401, 'UNAUTHENTICATED']);
  });

  it('records a refused proof of a live session once per request, with the user, the group and the session, and nothing else', async () => {
    const { id, tokens } = await session();
    const mark = since();
    await fetch(url('/me'), { headers: { authorization: `DPoP ${tokens.accessToken}`, dpop: 'junk' } });
    const [event, ...rest] = logged(mark);
    assert.equal(rest.length, 0);
    assert.deepEqual(
      [event?.category, event?.action, event?.outcome, event?.actor.id?.toHexString(), event?.actor.role, event?.groupId?.toHexString(), event?.resource?.id, event?.metadata],
      ['security', 'auth.dpopRejected', 'denied', id.toHexString(), 'SA', office.cluster.groups[0]!.groupId.toHexString(), tokens.sessionId, { reason: 'malformed', source: 'api' }],
    );
    assert.ok(!JSON.stringify(event).includes(tokens.accessToken));
    // A token nobody knows, a revoked session: nothing to attribute the event to.
    const unknown = since();
    await fetch(url('/me'), { headers: { authorization: `DPoP fc_at_${'A'.repeat(43)}`, dpop: 'junk' } });
    await fetch(url('/me'), { headers: { authorization: 'DPoP nonsense', dpop: 'junk' } });
    await office.call('POST', '/auth/logout', tokens.accessToken);
    const revoked = since();
    assert.equal((await fetch(url('/me'), { headers: { authorization: `DPoP ${tokens.accessToken}`, dpop: 'junk' } })).status, 401);
    assert.deepEqual([dpopEvents(unknown).length, dpopEvents(revoked).length], [0, 0]);
  });

  it('does not accept the proof on the session routes: logout, logout-all, password, PIN and revoking a session need it', async () => {
    const { tokens } = await session();
    const routes: Array<[string, string, unknown]> = [
      ['POST', '/auth/logout', undefined],
      ['POST', '/auth/logout-all', undefined],
      ['PUT', '/me/password', { currentPassword: TEST_PASSWORD, newPassword: 'a-new-Password-123!' }],
      ['PUT', '/me/pin', { password: TEST_PASSWORD, pin: '4821' }],
      ['DELETE', `/me/sessions/${tokens.sessionId}`, undefined],
    ];
    for (const [method, path, body] of routes) {
      const response = await fetch(url(path), { method, headers: { authorization: `DPoP ${tokens.accessToken}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      assert.deepEqual(await errorOf(response), [401, 'INVALID_DPOP_PROOF'], `${method} ${path}`);
    }
    assert.equal((await stored(tokens))?.['revokedAt'], null);
    assert.equal((await office.call('POST', '/auth/logout', tokens.accessToken)).status, 204);
  });

  it('answers a refused proof before the body is read: a multipart upload is not parsed, whatever its size', async () => {
    const { tokens } = await session();
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(11 * 1024 * 1024)]), 'big.xlsx');
    const response = await fetch(url('/tobaccos/import'), { method: 'POST', headers: { authorization: `DPoP ${tokens.accessToken}`, dpop: 'junk' }, body: form });
    assert.deepEqual(await errorOf(response), [401, 'INVALID_DPOP_PROOF']);
    const garbage = await fetch(url('/tobaccos/import'), { method: 'POST', headers: { authorization: `DPoP ${tokens.accessToken}`, 'content-type': 'multipart/form-data; boundary=xyz' }, body: 'not a multipart body' });
    assert.deepEqual(await errorOf(garbage), [401, 'INVALID_DPOP_PROOF']);
  });
});

describe('the key of a session', () => {
  it('is stored as its thumbprint at login, survives a refresh and is never in an answer', async () => {
    const { tokens, key } = await session();
    assert.equal((await stored(tokens))?.['jkt'], key.jkt);
    const renewed = ((await (await office.call('POST', '/auth/refresh', undefined, { refreshToken: tokens.refreshToken })).json()) as { data: Tokens }).data;
    assert.equal((await stored(renewed))?.['jkt'], key.jkt);
    const listed = await office.call('GET', '/me/sessions', renewed.accessToken);
    assert.equal(listed.status, 200);
    const text = JSON.stringify(await listed.json());
    assert.ok(!text.includes(key.jkt) && !text.includes('jkt'));
    assert.equal((await office.call('GET', '/me', renewed.accessToken)).status, 200);
  });

  it('revokes the family when a valid token comes with a valid proof of another key, and records the theft', async () => {
    const { id, tokens, key } = await session();
    const mark = since();
    const stolen = await fetch(url('/me'), { headers: office.userHeaders('GET', '/me', tokens.accessToken, { key: newBrowserKey() }) });
    assert.deepEqual(await errorOf(stolen), [401, 'UNAUTHENTICATED']);
    assert.equal((await stored(tokens))?.['revokeReason'], 'dpopKeyMismatch');
    assert.deepEqual(logged(mark).map((entry) => [entry.action, entry.metadata]), [['session.revoked', { reason: 'dpopKeyMismatch' }], ['auth.dpopRejected', { reason: 'keyMismatch', source: 'api' }]]);
    assert.equal(dpopEvents(mark)[0]?.actor.id?.toHexString(), id.toHexString());
    // The legitimate browser is out too, with its access token and its refresh token.
    assert.equal((await fetch(url('/me'), { headers: office.userHeaders('GET', '/me', tokens.accessToken, { key }) })).status, 401);
    assert.deepEqual(await errorOf(await office.call('POST', '/auth/refresh', undefined, { refreshToken: tokens.refreshToken })), [401, 'UNAUTHENTICATED']);
  });

  it('revokes a session stored without a key at its first use, with no proof event', async () => {
    const { tokens } = await session();
    await sessions().updateOne({ _id: ObjectId.createFromHexString(tokens.sessionId) }, { $unset: { jkt: '' } });
    const mark = since();
    assert.deepEqual(await errorOf(await office.call('GET', '/me', tokens.accessToken)), [401, 'UNAUTHENTICATED']);
    assert.equal((await stored(tokens))?.['revokeReason'], 'dpopUnbound');
    assert.deepEqual(logged(mark).map((entry) => [entry.action, entry.metadata]), [['session.revoked', { reason: 'dpopUnbound' }]]);
    assert.deepEqual(await errorOf(await office.call('GET', '/me', tokens.accessToken)), [401, 'UNAUTHENTICATED']);
  });

  it('revokes a session stored without a key at its first refresh', async () => {
    const { tokens } = await session();
    await sessions().updateOne({ _id: ObjectId.createFromHexString(tokens.sessionId) }, { $set: { jkt: null } });
    const mark = since();
    assert.deepEqual(await errorOf(await office.call('POST', '/auth/refresh', undefined, { refreshToken: tokens.refreshToken })), [401, 'UNAUTHENTICATED']);
    assert.equal((await stored(tokens))?.['revokeReason'], 'dpopUnbound');
    assert.deepEqual(logged(mark).map((entry) => entry.action), ['session.revoked']);
  });

  it('answers a disabled user with an expired access token UNAUTHENTICATED and revokes the session, not TOKEN_EXPIRED', async () => {
    const { id, tokens } = await session();
    await users().updateOne({ _id: id }, { $set: { status: false } });
    office.clock.advance(901_000);
    const mark = since();
    assert.deepEqual(await errorOf(await office.call('GET', '/me', tokens.accessToken)), [401, 'UNAUTHENTICATED']);
    assert.equal((await stored(tokens))?.['revokeReason'], 'userDisabled');
    assert.deepEqual(logged(mark).map((entry) => entry.action), ['session.revoked']);
  });

  it('answers a disabled user with an expired refresh token UNAUTHENTICATED and revokes the session', async () => {
    const { id, tokens } = await session();
    await users().updateOne({ _id: id }, { $set: { status: false } });
    office.clock.advance(8 * 24 * 3600 * 1000);
    const mark = since();
    assert.deepEqual(await errorOf(await office.call('POST', '/auth/refresh', undefined, { refreshToken: tokens.refreshToken })), [401, 'UNAUTHENTICATED']);
    assert.equal((await stored(tokens))?.['revokeReason'], 'userDisabled');
    assert.deepEqual(logged(mark).map((entry) => entry.action), ['session.revoked']);
  });

  it('writes one keyMismatch event and one revocation for concurrent requests with the proof of another key', async () => {
    const { tokens } = await session();
    const mark = since();
    const replies = await Promise.all(Array.from({ length: 5 }, () => fetch(url('/me'), { headers: office.userHeaders('GET', '/me', tokens.accessToken, { key: newBrowserKey() }) })));
    assert.deepEqual(replies.map((reply) => reply.status), [401, 401, 401, 401, 401]);
    assert.equal((await stored(tokens))?.['revokeReason'], 'dpopKeyMismatch');
    assert.deepEqual(logged(mark).map((entry) => entry.action).sort(), ['auth.dpopRejected', 'session.revoked']);
    assert.deepEqual(dpopEvents(mark).map((entry) => entry.metadata), [{ reason: 'keyMismatch', source: 'api' }]);
  });

  it('writes one keyMismatch event and one revocation for concurrent refreshes with the proof of another key', async () => {
    const { tokens } = await session();
    const mark = since();
    const replies = await Promise.all(Array.from({ length: 5 }, () => refreshWith(tokens.refreshToken, signedFor(newBrowserKey(), 'POST', '/auth/refresh', { refreshToken: tokens.refreshToken }))));
    assert.deepEqual(replies.map((reply) => reply.status), [401, 401, 401, 401, 401]);
    assert.equal((await stored(tokens))?.['revokeReason'], 'dpopKeyMismatch');
    assert.deepEqual(logged(mark).map((entry) => entry.action).sort(), ['auth.dpopRejected', 'session.revoked']);
    assert.deepEqual(dpopEvents(mark).map((entry) => entry.metadata), [{ reason: 'keyMismatch', source: 'refresh' }]);
  });

  it('refuses a DPoP credential that is a store key or an API key, as any unknown token', async () => {
    const key = newBrowserKey();
    for (const secret of [`fc_sk_${'A'.repeat(43)}`, `fc_pk_${'A'.repeat(43)}`]) {
      const reply = await fetch(url('/me'), { headers: { authorization: `DPoP ${secret}`, dpop: signedFor(key, 'GET', '/me', { accessToken: secret }) } });
      assert.deepEqual(await errorOf(reply), [401, 'UNAUTHENTICATED'], secret.slice(0, 6));
    }
  });

  it('signs a HEAD request with htm HEAD: htm GET is refused', async () => {
    const { tokens } = await session();
    assert.equal((await fetch(url('/me'), { method: 'HEAD', headers: office.userHeaders('HEAD', '/me', tokens.accessToken) })).status, 200);
    const refused = await fetch(url('/me'), { method: 'HEAD', headers: office.userHeaders('GET', '/me', tokens.accessToken) });
    assert.equal(refused.status, 401);
    assert.equal(refused.headers.get('www-authenticate'), 'DPoP algs="ES256"');
  });
});

describe('POST /v1/auth/login: the proof', () => {
  it('refuses a login without a proof, whoever the user is, before anything about the user is read', async () => {
    const { id, name } = await addUser();
    const mark = since();
    for (const dpop of [undefined, 'junk']) {
      assert.deepEqual(await errorOf(await loginWith(name, dpop)), [401, 'INVALID_DPOP_PROOF']);
      // A wrong password and an unknown user get the same answer: no scrypt, no failure counted, no event.
      assert.deepEqual(await errorOf(await loginWith(name, dpop, 'a-wrong-password')), [401, 'INVALID_DPOP_PROOF']);
      assert.deepEqual(await errorOf(await loginWith('nobody-at-all', dpop)), [401, 'INVALID_DPOP_PROOF']);
    }
    assert.equal((await loginWith(name, undefined)).headers.get('www-authenticate'), 'DPoP algs="ES256"');
    assert.deepEqual([logged(mark), await sessions().countDocuments({ userId: id }), await credentials().findOne({ userId: id })], [[], 0, null]);
  });

  it('refuses a proof of the login that carries an ath or an rth, or is made for another URL or method', async () => {
    const { name } = await addUser();
    const key = newBrowserKey();
    const proofs = [
      signedFor(key, 'POST', '/auth/login', { accessToken: `fc_at_${'A'.repeat(43)}` }),
      signedFor(key, 'POST', '/auth/login', { refreshToken: `fc_rt_${'A'.repeat(43)}` }),
      signedFor(key, 'POST', '/auth/refresh'),
      signedFor(key, 'GET', '/auth/login'),
      signedFor(key, 'POST', '/auth/login', { iat: secondsNow() - 120 }),
    ];
    for (const proof of proofs) {
      assert.deepEqual(await errorOf(await loginWith(name, proof)), [401, 'INVALID_DPOP_PROOF']);
    }
    assert.equal((await loginWith(name, signedFor(key, 'POST', '/auth/login'))).status, 200);
  });

  it('binds the session to the key of the proof', async () => {
    const { name } = await addUser();
    const key = newBrowserKey();
    const response = await loginWith(name, signedFor(key, 'POST', '/auth/login'));
    const tokens = ((await response.json()) as { data: Tokens }).data;
    assert.equal((await stored(tokens))?.['jkt'], key.jkt);
    assert.equal(TEST_API_PUBLIC_BASE_URL, 'https://api.example.test/api');
  });
});

describe('POST /v1/auth/refresh: the proof', () => {
  it('refuses a proof without rth, with the rth of another token or with an ath, and does not rotate', async () => {
    const { id, tokens, key } = await session();
    const other = await session();
    const mark = since();
    const proofs = [
      undefined,
      'junk',
      signedFor(key, 'POST', '/auth/refresh'),
      signedFor(key, 'POST', '/auth/refresh', { refreshToken: other.tokens.refreshToken }),
      signedFor(key, 'POST', '/auth/refresh', { refreshToken: tokens.refreshToken, accessToken: tokens.accessToken }),
      signedFor(key, 'POST', '/auth/refresh', { accessToken: tokens.accessToken }),
    ];
    for (const proof of proofs) {
      assert.deepEqual(await errorOf(await refreshWith(tokens.refreshToken, proof)), [401, 'INVALID_DPOP_PROOF']);
    }
    assert.equal((await stored(tokens))?.['refreshTokenHash'] !== undefined && (await stored(tokens))?.['rotatedAt'], null);
    assert.deepEqual(dpopEvents(mark).map((entry) => [entry.actor.id?.toHexString(), entry.metadata?.['source']]), proofs.map(() => [id.toHexString(), 'refresh']));
    // The token is still good with a good proof.
    assert.equal((await refreshWith(tokens.refreshToken, signedFor(key, 'POST', '/auth/refresh', { refreshToken: tokens.refreshToken }))).status, 200);
  });

  it('answers a refused proof to an unknown or revoked token without any event', async () => {
    const { tokens } = await session();
    await office.call('POST', '/auth/logout', tokens.accessToken);
    const mark = since();
    assert.deepEqual(await errorOf(await refreshWith(tokens.refreshToken, 'junk')), [401, 'INVALID_DPOP_PROOF']);
    assert.deepEqual(await errorOf(await refreshWith(`fc_rt_${'A'.repeat(43)}`, 'junk')), [401, 'INVALID_DPOP_PROOF']);
    assert.deepEqual(await errorOf(await refreshWith('not a token', undefined)), [401, 'INVALID_DPOP_PROOF']);
    assert.deepEqual(logged(mark), []);
  });

  it('revokes the family when the current refresh token comes with another key, and does not rotate', async () => {
    const { tokens } = await session();
    const mark = since();
    const response = await refreshWith(tokens.refreshToken, signedFor(newBrowserKey(), 'POST', '/auth/refresh', { refreshToken: tokens.refreshToken }));
    assert.deepEqual(await errorOf(response), [401, 'UNAUTHENTICATED']);
    const after = await stored(tokens);
    assert.deepEqual([after?.['revokeReason'], after?.['rotatedAt'], after?.['previousRefreshHashes']], ['dpopKeyMismatch', null, []]);
    assert.deepEqual(logged(mark).map((entry) => [entry.action, entry.metadata]), [['session.revoked', { reason: 'dpopKeyMismatch' }], ['auth.dpopRejected', { reason: 'keyMismatch', source: 'refresh' }]]);
    assert.deepEqual(await errorOf(await office.call('GET', '/me', tokens.accessToken)), [401, 'UNAUTHENTICATED']);
  });

  it('gives a just-rotated token no grace with another key: the family is revoked and nothing is tolerated', async () => {
    const { tokens } = await session();
    const renewed = ((await (await office.call('POST', '/auth/refresh', undefined, { refreshToken: tokens.refreshToken })).json()) as { data: Tokens }).data;
    const mark = since();
    const response = await refreshWith(tokens.refreshToken, signedFor(newBrowserKey(), 'POST', '/auth/refresh', { refreshToken: tokens.refreshToken }));
    assert.deepEqual(await errorOf(response), [401, 'UNAUTHENTICATED']);
    assert.equal((await stored(renewed))?.['revokeReason'], 'dpopKeyMismatch');
    assert.deepEqual(logged(mark).map((entry) => entry.action), ['session.revoked', 'auth.dpopRejected']);
    assert.deepEqual(await errorOf(await office.call('GET', '/me', renewed.accessToken)), [401, 'UNAUTHENTICATED']);
  });

  it('still tolerates a retry of the latest rotated token within the grace, with the right key', async () => {
    const { tokens } = await session();
    const renewed = ((await (await office.call('POST', '/auth/refresh', undefined, { refreshToken: tokens.refreshToken })).json()) as { data: Tokens }).data;
    const mark = since();
    assert.deepEqual(await errorOf(await refreshWith(tokens.refreshToken, signedFor(office.keyOf(tokens.refreshToken), 'POST', '/auth/refresh', { refreshToken: tokens.refreshToken }))), [401, 'UNAUTHENTICATED']);
    assert.deepEqual(logged(mark).map((entry) => entry.action), ['auth.refreshRaceTolerated']);
    assert.equal((await office.call('GET', '/me', renewed.accessToken)).status, 200);
  });
});

describe('the cap of the proof events', () => {
  it('writes at most ten events an hour per user, but always the theft of a token', async () => {
    const { name, tokens } = await session();
    const mark = since();
    for (let i = 0; i < 12; i += 1) {
      await fetch(url('/me'), { headers: { authorization: `DPoP ${tokens.accessToken}`, dpop: 'junk' } });
    }
    assert.equal(dpopEvents(mark).length, 10);
    // The same user, another session, a stolen token: recorded beyond the cap.
    const second = await office.tokens(name);
    await fetch(url('/me'), { headers: office.userHeaders('GET', '/me', second.accessToken, { key: newBrowserKey() }) });
    assert.deepEqual(dpopEvents(mark).slice(10).map((entry) => entry.metadata), [{ reason: 'keyMismatch', source: 'api' }]);
    // The refusals on the refresh count in the same hourly cap.
    const again = await session();
    const refreshMark = since();
    for (let i = 0; i < 11; i += 1) {
      await refreshWith(again.tokens.refreshToken, 'junk');
    }
    assert.equal(dpopEvents(refreshMark).length, 10);
  });

  it('writes the event anyway when the counter fails, and logs it', async () => {
    const ctx2 = await openTestDatabases();
    const base = memoryRateLimiter();
    const failing = { ...base, consume: (bucket: string, key: string, limit: number) => (bucket === 'dpop-rejected:user' ? Promise.reject(new Error('down')) : base.consume(bucket, key, limit)) };
    const office2 = await startBackoffice(ctx2, { rateLimiter: failing });
    try {
      const tokens = await office2.tokens(userName(office2.cluster.groups[0]!.sa));
      await fetch(`${office2.app.baseUrl}/v1/me`, { headers: { authorization: `DPoP ${tokens.accessToken}`, dpop: 'junk' } });
      assert.deepEqual(office2.activity.entries.filter((entry) => entry.action === 'auth.dpopRejected').map((entry) => entry.metadata), [{ reason: 'malformed', source: 'api' }]);
      assert.deepEqual(office2.logEvents.filter((line) => line['level'] === 'error').map((line) => line['msg']), ['dpop rejection counter failed']);
    } finally {
      await office2.close();
      await ctx2.cleanup();
    }
  });
});

describe('the surfaces that do not use DPoP', () => {
  it('ignores a DPoP header on the requests of a store key and on /public/v1', async () => {
    const store = await world.activate(world.group(0).ownPlaceId);
    const plain = await world.asStore(store.key, 'GET', '/store-context');
    assert.deepEqual([plain.status, plain.body], [200, plain.body]);
    for (const dpop of ['junk', 'a.b.c', '']) {
      const reply = await world.asStore(store.key, 'GET', '/store-context', undefined, { dpop });
      assert.deepEqual([reply.status, reply.body], [plain.status, plain.body]);
    }
    const { secret } = await world.makeKey();
    const withKey = await world.asKey(secret, '/places');
    assert.equal(withKey.status, 200);
    assert.equal((await world.asKey(secret, '/places', { dpop: 'junk' })).status, 200);
    // And a store key is still not a user token: the user authentication never sees it.
    assert.deepEqual(await errorOf(await fetch(url('/me'), { headers: { authorization: `Bearer ${store.key}`, dpop: 'junk' } })), [403, 'FORBIDDEN']);
  });
});

describe('the failed authentications of /v1 from one address', () => {
  it('answers 429 after the per-IP limit of refused proofs', async () => {
    const own = await openTestDatabases();
    const limited = await startBackoffice(own, { env: { RATE_LIMIT_UNAUTHENTICATED_PER_IP: '3' } });
    try {
      const tokens = await limited.tokens(userName(limited.cluster.groups[0]!.sa));
      const statuses: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        const reply = await fetch(`${limited.app.baseUrl}/v1/me`, { headers: { authorization: `DPoP ${tokens.accessToken}`, dpop: 'junk' } });
        statuses.push(reply.status);
        if (reply.status === 429) {
          assert.ok(Number(reply.headers.get('retry-after')) >= 1);
        }
      }
      assert.deepEqual(statuses, [401, 401, 401, 429, 429]);
    } finally {
      await limited.close();
      await own.cleanup();
    }
  });
});
