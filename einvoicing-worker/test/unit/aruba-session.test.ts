import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { FencedError } from '../../src/limits/limiters.ts';
import type { Limiters } from '../../src/limits/limiters.ts';
import { createSessions } from '../../src/providers/aruba/session.ts';
import type { Authorization, Sessions } from '../../src/providers/aruba/session.ts';
import { ARUBA_LIMITS } from '../../src/providers/aruba/settings.ts';
import { createArubaRig, live, TEST_PASSWORD } from '../helpers/aruba.ts';
import type { ArubaRig } from '../helpers/aruba.ts';
import { tokenReply } from '../helpers/fake-aruba.ts';
import { T0 } from '../helpers/world.ts';

const SIGNIN = 'POST /auth/signin';
const MINUTE = 60_000;

describe('Aruba: sessions', () => {
  let rig: ArubaRig;
  let sessions: Sessions;

  const build = (overrides: Partial<Parameters<typeof createSessions>[0]> = {}): Sessions =>
    createSessions({
      hosts: rig.fake.hosts,
      fetch,
      registry: { get: async (hub, options) => (rig.reads.push({ hub, fresh: options?.fresh === true }), rig.accounts.get(hub)) },
      limiters: rig.limiters,
      rule: ARUBA_LIMITS.ip.auth,
      timeoutMs: 2000,
      logger: rig.log.logger,
      clock: rig.clock.now,
      sleep: rig.clock.sleep,
      ...overrides,
    });
  const token = (result: Authorization): string => {
    assert.equal(result.kind, 'token', JSON.stringify(result));
    return result.kind === 'token' ? result.token.reveal() : '';
  };

  beforeEach(async () => {
    rig = await createArubaRig();
    sessions = build();
  });
  afterEach(async () => {
    await rig.close();
  });

  it('signs in with the password, the credentials only in the form body, and reads the account fresh first', async () => {
    assert.equal(token(await sessions.authorize('aruba', live())), 'access-token-1');
    const [hit] = rig.fake.hits(SIGNIN);
    assert.equal(hit?.headers['content-type'], 'application/x-www-form-urlencoded');
    assert.deepEqual(Object.fromEntries(new URLSearchParams(hit?.body)), { grant_type: 'password', username: 'test-user', password: TEST_PASSWORD });
    assert.equal(hit?.rawQuery, '', 'nothing in the URL');
    assert.equal(hit?.headers['authorization'], undefined);
    assert.deepEqual(rig.reads, [{ hub: 'aruba', fresh: true }]);
  });

  it('reuses the token until five minutes before it expires, then refreshes it with the refresh token', async () => {
    await sessions.authorize('aruba', live());
    rig.clock.advance(1499 * 1000);
    assert.equal(token(await sessions.authorize('aruba', live())), 'access-token-1');
    assert.equal(rig.fake.hits(SIGNIN).length, 1);
    rig.fake.route(SIGNIN, tokenReply('access-token-2', 'refresh-token-2'));
    rig.clock.advance(2000);
    assert.equal(token(await sessions.authorize('aruba', live())), 'access-token-2');
    assert.deepEqual(Object.fromEntries(new URLSearchParams(rig.fake.hits(SIGNIN)[1]?.body)), { grant_type: 'refresh_token', refresh_token: 'refresh-token-1' });
    assert.ok(!rig.fake.hits(SIGNIN)[1]?.body.includes(TEST_PASSWORD), 'a refresh never carries the password');
  });

  it('spaces every sign-in, a refresh included, by the persistent per-IP limiter (65 s plus jitter)', async () => {
    await sessions.authorize('aruba', live());
    rig.clock.advance(1600 * 1000);
    await sessions.authorize('aruba', live());
    assert.deepEqual(rig.clock.waits, [], 'no wait: the minute has long passed');
    const gate = rig.limiters.gate('ip:aruba:auth', ARUBA_LIMITS.ip.auth, rig.clock.now());
    assert.deepEqual([gate.at - rig.clock.now(), gate.reason], [65_000, 'interval']);
  });

  it('waits for the limiter inside the call when it is a few seconds away, and hands the call back when it is far', async () => {
    await sessions.authorize('aruba', live());
    sessions.dropAccessToken('aruba');
    rig.clock.set(T0 + 60_000);
    assert.equal(token(await sessions.authorize('aruba', live())), 'access-token-1');
    assert.deepEqual(rig.clock.waits, [5_000], 'waited for the rest of the 65 seconds');
    sessions.dropAccessToken('aruba');
    rig.clock.set(T0 + 70_000);
    const early = await sessions.authorize('aruba', live());
    assert.deepEqual(early, { kind: 'wait', scope: 'ip', afterMs: 60_000, code: 'AUTH_LIMITED' }, 'a wait over ten seconds is handed back, not slept');
    assert.deepEqual(rig.clock.waits, [5_000], 'no call blocks for more than the cap');
    rig.clock.set(T0 + 130_000);
    assert.equal(token(await sessions.authorize('aruba', live())), 'access-token-1');
    await rig.limiters.coolDown('ip:aruba:auth', rig.clock.now() + 10 * MINUTE);
    sessions.dropAccessToken('aruba');
    const refused = await sessions.authorize('aruba', live());
    assert.equal(refused.kind, 'wait');
    assert.deepEqual(refused.kind === 'wait' ? [refused.scope, refused.code] : [], ['ip', 'AUTH_LIMITED']);
    assert.ok(refused.kind === 'wait' && refused.afterMs > 9 * MINUTE);
    assert.equal(rig.fake.hits(SIGNIN).length, 3, 'Aruba was not called while the limiter said no');
  });

  it('gives up the wait when the signal fires', async () => {
    await sessions.authorize('aruba', live());
    sessions.dropAccessToken('aruba');
    rig.clock.advance(58_000);
    const aborted = new AbortController();
    const impatient = build({ sleep: async () => aborted.abort() });
    assert.deepEqual(await impatient.authorize('aruba', aborted.signal), { kind: 'wait', scope: 'account', afterMs: 1000, code: 'ABORTED' });
    assert.equal(rig.fake.hits(SIGNIN).length, 1);
  });

  it('falls back to the password when the refresh token was refused or is too old', async () => {
    await sessions.authorize('aruba', live());
    rig.fake.route(SIGNIN, (request) => (new URLSearchParams(request.body).get('grant_type') === 'refresh_token' ? { status: 400, json: { error: 'invalid_grant' } } : tokenReply('access-token-3', 'refresh-token-3')));
    rig.clock.advance(1600 * 1000);
    assert.deepEqual(await sessions.authorize('aruba', live()), { kind: 'wait', scope: 'ip', afterMs: 65_000, code: 'AUTH_LIMITED' }, 'the password needs its own turn: handed back, not slept');
    rig.clock.advance(66_000);
    assert.equal(token(await sessions.authorize('aruba', live())), 'access-token-3');
    const grants = rig.fake.hits(SIGNIN).map((hit) => new URLSearchParams(hit.body).get('grant_type'));
    assert.deepEqual(grants, ['password', 'refresh_token', 'password']);
    rig.fake.route(SIGNIN, tokenReply('access-token-4', 'refresh-token-4'));
    rig.clock.advance(61 * MINUTE);
    assert.equal(token(await sessions.authorize('aruba', live())), 'access-token-4');
    assert.equal(new URLSearchParams(rig.fake.hits(SIGNIN)[3]?.body).get('grant_type'), 'password', 'the refresh token had lapsed: it is not even tried');
  });

  it('has no refresh token to use when Aruba gave none', async () => {
    rig.fake.route(SIGNIN, { json: { access_token: 'only-access', expires_in: 600 } });
    assert.equal(token(await sessions.authorize('aruba', live())), 'only-access');
    rig.clock.advance(400 * 1000);
    assert.equal(token(await sessions.authorize('aruba', live())), 'only-access');
    assert.equal(rig.fake.hits(SIGNIN).length, 2);
    assert.equal(new URLSearchParams(rig.fake.hits(SIGNIN)[1]?.body).get('grant_type'), 'password');
  });

  it('pauses the hub for five minutes when Aruba refuses the credentials, without calling Aruba meanwhile', async () => {
    rig.fake.route(SIGNIN, { status: 400, json: { error: 'invalid_grant' } });
    const first = await sessions.authorize('aruba', live());
    assert.deepEqual(first, { kind: 'wait', scope: 'account', afterMs: 5 * MINUTE, code: 'AUTH_INVALID_GRANT' });
    rig.clock.advance(2 * MINUTE);
    assert.deepEqual(await sessions.authorize('aruba', live()), { kind: 'wait', scope: 'account', afterMs: 3 * MINUTE, code: 'AUTH_INVALID_GRANT' });
    assert.equal(rig.fake.hits(SIGNIN).length, 1);
    rig.fake.route(SIGNIN, tokenReply('after-the-pause'));
    rig.clock.advance(3 * MINUTE + 1);
    assert.equal(token(await sessions.authorize('aruba', live())), 'after-the-pause');
    assert.deepEqual(rig.log.messages('error'), ['Aruba refused the credentials of the hub: it is paused until a person fixes the account']);
    assert.deepEqual(rig.log.entries().find((entry) => entry['level'] === 'error')?.['code'], 'invalid_grant');
    assert.doesNotMatch(rig.log.lines.join('\n'), new RegExp(TEST_PASSWORD));
  });

  it('steps the pause 5, 30, 120, 120 minutes on consecutive refusals and starts again from 5 after a successful sign-in', async () => {
    rig.fake.route(SIGNIN, { status: 400 });
    const pauses: number[] = [];
    for (let times = 0; times < 4; times += 1) {
      const result = await sessions.authorize('aruba', live());
      pauses.push(result.kind === 'wait' ? result.afterMs / MINUTE : -1);
      rig.clock.advance((pauses[times] as number) * MINUTE + 1);
    }
    assert.deepEqual(pauses, [5, 30, 120, 120]);
    rig.fake.route(SIGNIN, tokenReply());
    assert.equal(token(await sessions.authorize('aruba', live())), 'access-token-1');
    sessions.dropAccessToken('aruba');
    sessions.forget('aruba');
    rig.clock.advance(70_000);
    rig.fake.route(SIGNIN, { status: 400 });
    const again = await sessions.authorize('aruba', live());
    assert.equal(again.kind === 'wait' ? again.afterMs : 0, 5 * MINUTE);
  });

  it('keeps the pause across a restart (it is in the persistent limiters) and does not lift it when the hub is forgotten', async () => {
    rig.fake.route(SIGNIN, { status: 400 });
    await sessions.authorize('aruba', live());
    const restarted = build();
    rig.fake.route(SIGNIN, tokenReply());
    const result = await restarted.authorize('aruba', live());
    assert.deepEqual(result, { kind: 'wait', scope: 'account', afterMs: 5 * MINUTE, code: 'AUTH_INVALID_GRANT' });
    restarted.forget('aruba');
    assert.equal((await restarted.authorize('aruba', live())).kind, 'wait');
    assert.equal(rig.fake.hits(SIGNIN).length, 1, 'Aruba is not called while paused');
  });

  it('treats 401 on the sign-in as refused credentials too', async () => {
    rig.fake.route(SIGNIN, { status: 401 });
    assert.equal((await sessions.authorize('aruba', live())).kind, 'wait');
    assert.equal(rig.fake.hits(SIGNIN).length, 1);
  });

  it('on 429 asks the whole IP to wait and blocks the sign-in limiter for that long', async () => {
    rig.fake.route(SIGNIN, { status: 429 });
    assert.deepEqual(await sessions.authorize('aruba', live()), { kind: 'wait', scope: 'ip', afterMs: 65_000, code: 'AUTH_RATE_LIMITED' });
    assert.equal(rig.limiters.gate('ip:aruba:auth', ARUBA_LIMITS.ip.auth, rig.clock.now()).at, T0 + 65_000);
  });

  it('on a server error, an unreadable answer or a failed connection asks the IP to wait a minute, logging only hub and status', async () => {
    for (const reply of [{ status: 503, text: 'secret-body-that-must-not-be-logged' }, { json: { access_token: '', expires_in: 1800 } }, { json: { access_token: 'x', expires_in: 0 } }, { json: { access_token: 'x', expires_in: 'soon' } }, { text: 'not json' }, { json: ['x'] }, { destroy: true }]) {
      rig.fake.route(SIGNIN, reply);
      rig.clock.advance(70_000);
      assert.deepEqual(await sessions.authorize('aruba', live()), { kind: 'wait', scope: 'ip', afterMs: 60_000, code: 'AUTH_UNAVAILABLE' }, JSON.stringify(reply));
    }
    assert.doesNotMatch(rig.log.lines.join('\n'), /secret-body|access_token/);
  });

  it('shares one sign-in between concurrent calls for a hub', async () => {
    const results = await Promise.all([sessions.authorize('aruba', live()), sessions.authorize('aruba', live()), sessions.authorize('aruba', live())]);
    assert.deepEqual(results.map(token), ['access-token-1', 'access-token-1', 'access-token-1']);
    assert.equal(rig.fake.hits(SIGNIN).length, 1);
  });

  it('keeps hubs apart', async () => {
    rig.accounts.set('aruba__0123456789abcdef01234567', { ...rig.account, hub: 'aruba__0123456789abcdef01234567', username: 'other' });
    rig.fake.route(SIGNIN, (request) => tokenReply(`token-of-${new URLSearchParams(request.body).get('username')}`));
    assert.equal(token(await sessions.authorize('aruba', live())), 'token-of-test-user');
    rig.clock.advance(70_000);
    assert.equal(token(await sessions.authorize('aruba__0123456789abcdef01234567', live())), 'token-of-other');
  });

  it('does not sign in an account that is no longer usable', async () => {
    rig.accounts.delete('aruba');
    assert.deepEqual(await sessions.authorize('aruba', live()), { kind: 'wait', scope: 'account', afterMs: 60_000, code: 'ACCOUNT_UNUSABLE' });
    assert.equal(rig.fake.hits(SIGNIN).length, 0);
  });

  it('forgets everything of a hub, and never stores a token of a hub forgotten while it signed in', async () => {
    await sessions.authorize('aruba', live());
    sessions.forget('aruba');
    rig.clock.advance(70_000);
    assert.equal(token(await sessions.authorize('aruba', live())), 'access-token-1');
    assert.equal(rig.fake.hits(SIGNIN).length, 2);
    sessions.forget('aruba');
    rig.fake.route(SIGNIN, () => {
      sessions.forget('aruba');
      return tokenReply('stale');
    });
    rig.clock.advance(70_000);
    assert.deepEqual(await sessions.authorize('aruba', live()), { kind: 'wait', scope: 'account', afterMs: 1000, code: 'ACCOUNT_CHANGED' });
  });

  it('refuses tokens that are not printable ASCII of a sane length, and a non-positive or non-numeric lifetime, as a failed sign-in', async () => {
    const bad = ['has space', 'tab\there', 'ünïcode', 'x'.repeat(4097), '', 'new\nline'];
    for (const token of bad) {
      for (const reply of [{ json: { access_token: token, expires_in: 1800, refresh_token: 'r' } }, { json: { access_token: 'ok', expires_in: 1800, refresh_token: token } }]) {
        rig.fake.route(SIGNIN, reply);
        rig.clock.advance(70_000);
        assert.deepEqual(await sessions.authorize('aruba', live()), { kind: 'wait', scope: 'ip', afterMs: 60_000, code: 'AUTH_UNAVAILABLE' }, JSON.stringify(token).slice(0, 20));
      }
    }
    rig.fake.route(SIGNIN, { json: { access_token: 'x'.repeat(4096), expires_in: 1800, refresh_token: 'y'.repeat(4096) } });
    rig.clock.advance(70_000);
    assert.equal((await sessions.authorize('aruba', live())).kind, 'token', '4096 characters are accepted');
    assert.doesNotMatch(rig.log.lines.join('\n'), /ünïcode|has space/);
  });

  it('caps a lifetime at a day', async () => {
    rig.fake.route(SIGNIN, { json: { access_token: 'long-lived', expires_in: 10_000_000 } });
    assert.equal(token(await sessions.authorize('aruba', live())), 'long-lived');
    rig.clock.advance(86_000 * 1000);
    assert.equal(token(await sessions.authorize('aruba', live())), 'long-lived');
    assert.equal(rig.fake.hits(SIGNIN).length, 1);
    rig.clock.advance(200 * 1000);
    rig.fake.route(SIGNIN, tokenReply('renewed'));
    assert.equal(token(await sessions.authorize('aruba', live())), 'renewed');
  });

  it('keeps the original expiry of a refresh token that comes back unchanged, and extends a new one', async () => {
    await sessions.authorize('aruba', live());
    rig.clock.advance(1600 * 1000);
    await sessions.authorize('aruba', live());
    rig.clock.advance(1960 * 1000);
    await sessions.authorize('aruba', live());
    const grants = () => rig.fake.hits(SIGNIN).map((hit) => new URLSearchParams(hit.body).get('grant_type'));
    assert.deepEqual(grants(), ['password', 'refresh_token', 'password'], 'the same refresh token is still the one issued at the start: 59 minutes have passed');

    rig.fake.route(SIGNIN, (request) => tokenReply(`access-${rig.fake.requests.length}`, `refresh-${rig.fake.requests.length}`));
    rig.clock.advance(1600 * 1000);
    await sessions.authorize('aruba', live());
    rig.clock.advance(1600 * 1000);
    await sessions.authorize('aruba', live());
    rig.clock.advance(1600 * 1000);
    await sessions.authorize('aruba', live());
    assert.deepEqual(grants().slice(3), ['password', 'refresh_token', 'refresh_token'], 'the old refresh token had lapsed; each new one renews the validity');
  });

  it('drops only the access token: the refresh token is used next; dropping an unknown hub does nothing', async () => {
    sessions.dropAccessToken('nobody');
    await sessions.authorize('aruba', live());
    sessions.dropAccessToken('aruba');
    rig.clock.advance(70_000);
    rig.fake.route(SIGNIN, tokenReply('renewed'));
    assert.equal(token(await sessions.authorize('aruba', live())), 'renewed');
    assert.equal(new URLSearchParams(rig.fake.hits(SIGNIN)[1]?.body).get('grant_type'), 'refresh_token');
    sessions.forget('aruba');
    sessions.dropAccessToken('aruba');
  });

  it('lets a fencing error through: another instance owns the limiter', async () => {
    const fenced: Limiters = { ...rig.limiters, consume: async () => Promise.reject(new FencedError('limiter ip:aruba')) };
    await assert.rejects(build({ limiters: fenced }).authorize('aruba', live()), FencedError);
  });

  it('never writes a token, a password or a body in the log', async () => {
    await sessions.authorize('aruba', live());
    rig.fake.route(SIGNIN, { status: 500, text: 'refresh-token-1 access-token-1' });
    rig.clock.advance(1600 * 1000);
    await sessions.authorize('aruba', live());
    assert.doesNotMatch(rig.log.lines.join('\n'), /access-token|refresh-token|pw-secret/);
  });
});
