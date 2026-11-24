import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startBackoffice, userName } from '../helpers/backoffice.ts';
import type { Backoffice } from '../helpers/backoffice.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { startStoreWorld } from '../helpers/store-keys.ts';
import type { StoreWorld } from '../helpers/store-keys.ts';

const APP = 'https://backoffice.example.com';
let ctx: TestDatabases;
let office: Backoffice;
let world: StoreWorld;
const events = (log: { entries: Array<{ action: string }> }) => log.entries.filter((entry) => entry.action === 'request.nonBrowser') as unknown as Array<{ actor: { id: { toHexString(): string } }; metadata: Record<string, unknown> }>;
const BROWSER = { origin: APP, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' };
const body = async (response: Response) => JSON.parse(JSON.stringify(await response.json()), (key, value) => (['accessToken', 'refreshToken', 'accessTokenExpiresAt', 'refreshTokenExpiresAt', 'sessionId'].includes(key) ? 'x' : value));

before(async () => {
  ctx = await openTestDatabases();
  world = await startStoreWorld(ctx, { env: { REQUEST_ORIGIN_SIGNAL: 'on', CORS_ALLOWED_ORIGINS: APP } });
  office = world.office;
});
after(async () => {
  await office.close();
  await ctx.cleanup();
});
beforeEach(async () => {
  office.activity.entries.length = 0;
  await ctx.databases.common().collection<{ _id: string }>('rateLimits').deleteMany({ _id: { $regex: '^non-browser' } });
});

describe('the non-browser signal on login and refresh', () => {
  it('records a successful login and refresh made without Origin (source login, then refresh), once a day per user and reason, and the response never changes', async () => {
    const name = userName(office.cluster.psa);
    const plain = await office.login(name);
    assert.equal(plain.status, 200);
    const afterLogin = events(office.activity);
    assert.deepEqual(afterLogin.map((e) => [e.actor.id.toHexString(), e.metadata['reason'], e.metadata['source']]), [[office.cluster.psa.toHexString(), 'noOrigin', 'login']]);
    const tokens = (await plain.clone().json()) as { data: { refreshToken: string } };
    const refreshed = await office.call('POST', '/auth/refresh', undefined, { refreshToken: tokens.data.refreshToken });
    assert.equal(refreshed.status, 200);
    // The same reason of the same user already counted today: the refresh adds nothing; a foreign Origin is another reason, seen at the refresh.
    assert.equal(events(office.activity).length, 1);
    const next = (await refreshed.json()) as { data: { refreshToken: string } };
    const foreign = await office.call('POST', '/auth/refresh', undefined, { refreshToken: next.data.refreshToken }, { origin: 'https://evil.example' });
    assert.equal(foreign.status, 200);
    assert.deepEqual(events(office.activity).map((e) => [e.metadata['reason'], e.metadata['source']]), [['noOrigin', 'login'], ['foreignOrigin', 'refresh']]);
  });

  it('answers the same whether the signal fires or not: body and headers of a login are identical', async () => {
    const name = userName(office.cluster.dealerA);
    const first = await office.login(name);
    assert.equal(events(office.activity).length, 1, 'the first script login is reported');
    const second = await office.login(name);
    assert.equal(events(office.activity).length, 1, 'the second one is not (once a day)');
    assert.deepEqual([first.status, second.status], [200, 200]);
    assert.deepEqual(await body(first), await body(second));
    assert.deepEqual([...first.headers.keys()].sort(), [...second.headers.keys()].sort());
  });

  it('records nothing for a browser login and refresh', async () => {
    const login = await office.login(userName(office.cluster.dealerB), undefined, BROWSER);
    const { data } = (await login.json()) as { data: { refreshToken: string } };
    assert.equal((await office.call('POST', '/auth/refresh', undefined, { refreshToken: data.refreshToken }, BROWSER)).status, 200);
    assert.deepEqual(events(office.activity), []);
  });

  it('records nothing for a failed login (wrong password, unknown user, locked account) and the answers do not tell them apart', async () => {
    const wrong = await office.login(userName(office.cluster.psa), 'not-the-password');
    const unknown = await office.login('nobody-at-all', 'not-the-password');
    assert.deepEqual([wrong.status, unknown.status], [401, 401]);
    assert.deepEqual(await wrong.json(), await unknown.json());
    const badRefresh = await office.call('POST', '/auth/refresh', undefined, { refreshToken: `fc_rt_${'a'.repeat(43)}` });
    assert.equal(badRefresh.status, 401);
    assert.deepEqual(events(office.activity), []);
  });

  it('never evaluates the exchange of an activation code: it always comes from a server', async () => {
    const place = office.cluster.groups[0]!.ownPlaceId;
    const code = await world.codeFor(place);
    office.activity.entries.length = 0;
    const done = await world.exchange(code);
    assert.equal(done.status, 201);
    assert.deepEqual(events(office.activity), []);
    // Nor a request made with the store key.
    assert.equal((await world.asStore(done.body.data.key, 'GET', '/store-context')).status, 200);
    assert.deepEqual(events(office.activity), []);
  });
});
