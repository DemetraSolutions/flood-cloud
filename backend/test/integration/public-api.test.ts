import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { fixtureId } from '../helpers/legacy-fixtures.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { sha256, startKeysWorld, unknownKey } from '../helpers/api-keys.ts';
import type { KeysWorld, MadeKey } from '../helpers/api-keys.ts';
import { memoryRateLimiter } from '../helpers/activity.ts';
import { createRateLimiter } from '../../src/shared/security/rate-limit/rate-limiter.ts';

const ORIGIN = 'https://shop.example.com';
let ctx: TestDatabases;
let world: KeysWorld;
let original: { places: ObjectId[]; companies: ObjectId[] };
const common = () => ctx.databases.common();
const g = (index = 0) => world.group(index);
const hex = (id: ObjectId) => id.toHexString();
const company = (n: number) => fixtureId('company', n);
const place = (n: number) => fixtureId('place', n);
const asKey = (...args: Parameters<KeysWorld['asKey']>) => world.asKey(...args);
const unauthenticated = { error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

before(async () => {
  ctx = await openTestDatabases();
  world = await startKeysWorld(ctx, { env: { CORS_ALLOWED_ORIGINS: ORIGIN } });
  const ids = async (name: 'places' | 'companies') => (await common().collection(name).find({}, { projection: { _id: 1 } }).toArray()).map((document) => document['_id'] as ObjectId);
  original = { places: await ids('places'), companies: await ids('companies') };
});
after(async () => {
  await world.office.close();
  await ctx.cleanup();
});
beforeEach(async () => {
  await common().collection('apiKeys').deleteMany({});
  await common().collection('apiUsage').deleteMany({});
  await common().collection('groups').updateMany({}, { $unset: { publicApi: '' }, $set: { status: true, trash: false } });
  await common().collection('places').deleteMany({ _id: { $nin: original.places } });
  await common().collection('companies').deleteMany({ _id: { $nin: original.companies } });
  await common().collection('places').updateMany({}, { $set: { trash: false } });
  await common().collection('companies').updateMany({}, { $set: { trash: false } });
  world.office.activity.entries.length = 0;
  world.office.logEvents.length = 0;
});

describe('the authentication of the public surface', () => {
  it('lets a valid key in, through the header X-Api-Key alone', async () => {
    const { secret } = await world.makeKey();
    const reply = await asKey(secret, '/me');
    assert.equal(reply.status, 200);
    assert.ok(!JSON.stringify(reply.body).includes(secret));
  });

  it('answers every reason of refusal with the same 401, the same body and no hint of which check failed', async () => {
    const { id, secret } = await world.makeKey();
    const revoked = await world.makeKey();
    assert.equal((await world.as.call(world.office.cluster.psa, 'POST', world.keysPath(0, `/${revoked.id}/revoke`))).status, 200);
    const expiring = await world.makeKey(0, { expiresAt: new Date(world.office.clock.now() + 3600_000).toISOString() });
    const replies: Array<[string, Awaited<ReturnType<typeof asKey>>]> = [];
    replies.push(['no header', await asKey(undefined, '/me')]);
    replies.push(['empty header', await asKey('', '/me')]);
    replies.push(['unknown key', await asKey(unknownKey(), '/me')]);
    replies.push(['wrong prefix', await asKey(secret.replace('fc_pk_', 'fc_sk_'), '/me')]);
    replies.push(['too short', await asKey(secret.slice(0, 20), '/me')]);
    replies.push(['too long', await asKey(`${secret}A`, '/me')]);
    replies.push(['bad alphabet', await asKey(`${secret.slice(0, -1)}!`, '/me')]);
    replies.push(['revoked', await asKey(revoked.secret, '/me')]);
    // The key is fine until its expiry, and refused from it on, the very instant included.
    assert.equal((await asKey(expiring.secret, '/me')).status, 200);
    await common().collection('apiKeys').updateOne({ _id: new ObjectId(expiring.id) }, { $set: { expiresAt: new Date(world.office.clock.now() + 1) } });
    assert.equal((await asKey(expiring.secret, '/me')).status, 200);
    await common().collection('apiKeys').updateOne({ _id: new ObjectId(expiring.id) }, { $set: { expiresAt: new Date(world.office.clock.now()) } });
    replies.push(['expired', await asKey(expiring.secret, '/me')]);
    await world.setPublicApi(0, { enabled: false });
    replies.push(['group switched off', await asKey(secret, '/me')]);
    await world.setPublicApi(0, null);
    replies.push(['group without the setting', await asKey(secret, '/me')]);
    await world.setPublicApi(0, { enabled: 'yes' });
    replies.push(['group with a malformed setting', await asKey(secret, '/me')]);
    await world.setPublicApi(0, { enabled: true });
    await common().collection('groups').updateOne({ _id: g().groupId }, { $set: { trash: true } });
    replies.push(['group in the trash', await asKey(secret, '/me')]);
    await common().collection('groups').updateOne({ _id: g().groupId }, { $set: { trash: false, status: false } });
    replies.push(['group suspended', await asKey(secret, '/me')]);
    await common().collection('groups').updateOne({ _id: g().groupId }, { $set: { status: true } });
    // A key whose group does not exist (any more).
    const orphan = unknownKey();
    const stored = (await world.storedKey(id))!;
    await common().collection('apiKeys').insertOne({ ...stored, _id: new ObjectId(), groupId: fixtureId('group', 998), hash: sha256(orphan) });
    replies.push(['group deleted', await asKey(orphan, '/me')]);
    for (const [reason, reply] of replies) {
      assert.equal(reply.status, 401, reason);
      assert.deepEqual(reply.body, unauthenticated, reason);
      assert.equal(reply.headers.get('www-authenticate'), null, reason);
    }
    assert.equal(replies.length, 15);
    // Back to normal: nothing was changed by the refusals.
    assert.equal((await asKey(secret, '/me')).status, 200);
    assert.equal((await world.storedKey(id))!['status'], 'active');
  });

  it('reads the key from nowhere but the header: not the query, not a cookie, not Authorization, not another header', async () => {
    const { secret } = await world.makeKey();
    for (const [path, headers] of [
      [`/me?apiKey=${secret}`, {}],
      [`/me?api_key=${secret}`, {}],
      [`/me?key=${secret}&X-Api-Key=${secret}`, {}],
      ['/me', { cookie: `X-Api-Key=${secret}; apiKey=${secret}` }],
      ['/me', { authorization: `Bearer ${secret}` }],
      ['/me', { authorization: `ApiKey ${secret}` }],
      ['/me', { 'x-api-key-2': secret, 'api-key': secret, 'x-auth-token': secret }],
    ] as const) {
      const reply = await asKey(undefined, path, { ...headers });
      assert.deepEqual([reply.status, reply.body], [401, unauthenticated], path);
    }
    // The header wins and the query is only ignored: a valid key is not refused for what else the request says.
    assert.equal((await asKey(secret, `/me?apiKey=${unknownKey()}`)).status, 422);
  });

  it('refuses a header that is repeated', async () => {
    const { secret } = await world.makeKey();
    const response = await fetch(`${world.office.app.baseUrl}/public/v1/me`, { headers: new Headers([['x-api-key', secret], ['x-api-key', secret]]) });
    assert.equal(response.status, 401);
  });

  it('never accepts a user token or a store key, whatever the header', async () => {
    const { accessToken } = await world.office.tokens('user-002');
    const store = await world.activate(g().ownPlaceId);
    for (const credential of [accessToken, store.key]) {
      for (const headers of [{ authorization: `Bearer ${credential}` }, { 'x-api-key': credential }, { authorization: credential, 'x-api-key': credential }]) {
        for (const path of ['/me', '/places', '/companies', '/price-lists', '/taxes', '/currencies', '/measure-units']) {
          const reply = await asKey(undefined, path, headers);
          assert.deepEqual([reply.status, reply.body], [401, unauthenticated], `${path} ${Object.keys(headers).join()}`);
        }
      }
    }
    assert.equal((await world.asStore(store.key, 'GET', '/store-context')).status, 200);
  });

  it('is never accepted on /v1: a key does not log in, is not a Bearer token and does not reach any route', async () => {
    const { secret } = await world.makeKey();
    const group = hex(g().groupId);
    for (const path of ['/me', '/store-context', `/groups/${group}`, `/groups/${group}/api-keys`, `/groups/${group}/places`, `/groups/${group}/companies`]) {
      for (const headers of [{ authorization: `Bearer ${secret}` }, { 'x-api-key': secret }, { authorization: `Bearer ${secret}`, 'x-api-key': secret }]) {
        const response = await fetch(`${world.office.app.baseUrl}/v1${path}`, { headers });
        assert.equal(response.status, 401, `${path} ${Object.keys(headers).join()}`);
        assert.deepEqual(await response.json(), unauthenticated);
      }
    }
    const created = await world.office.call('POST', '/auth/login', undefined, { username: secret, password: secret });
    assert.equal(created.status, 401);
    const refreshed = await world.office.call('POST', '/auth/refresh', undefined, { refreshToken: secret });
    assert.ok([401, 422].includes(refreshed.status));
  });

  it('gives no CORS header at all, to a simple request or a preflight, whatever the origin', async () => {
    const { secret } = await world.makeKey();
    const base = `${world.office.app.baseUrl}/public/v1`;
    const responses = [
      await fetch(`${base}/me`, { headers: { origin: ORIGIN, 'x-api-key': secret } }),
      await fetch(`${base}/me`, { headers: { origin: 'https://evil.example', 'x-api-key': secret } }),
      await fetch(`${base}/me`, { headers: { origin: ORIGIN } }),
      await fetch(`${base}/me`, { method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-method': 'GET', 'access-control-request-headers': 'x-api-key' } }),
      await fetch(`${base}/unknown`, { method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-method': 'GET' } }),
      await fetch(`${base}/places`, { method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-method': 'GET', 'x-api-key': secret } }),
    ];
    for (const response of responses) {
      const names = [...response.headers.keys()].filter((name) => name.startsWith('access-control-'));
      assert.deepEqual(names, []);
      assert.ok(!(response.headers.get('vary') ?? '').toLowerCase().includes('origin'));
    }
    assert.deepEqual(responses.map((response) => response.status), [200, 200, 401, 405, 404, 405]);
    // The same origin does get its headers on the surface of the backoffice: the closing is the public surface's own.
    const v1 = await fetch(`${world.office.app.baseUrl}/v1/me`, { headers: { origin: ORIGIN } });
    assert.equal(v1.headers.get('access-control-allow-origin'), ORIGIN);
  });

  it('answers 404 to a route that does not exist, 405 to a method that is not for the route, and logs the key id and never the key', async () => {
    const { id, secret } = await world.makeKey();
    assert.equal((await asKey(secret, '/nope')).status, 404);
    assert.equal((await asKey(undefined, '/nope')).status, 404);
    const wrong = await asKey(secret, '/places', {}, 'POST');
    assert.deepEqual([wrong.status, wrong.headers.get('allow')], [405, 'GET, HEAD']);
    assert.equal((await asKey(secret, '/me')).status, 200);
    assert.equal((await asKey(unknownKey(), '/me')).status, 401);
    const logged = JSON.stringify(world.office.logEvents);
    assert.ok(!logged.includes(secret) && !logged.includes(secret.slice(6)), 'the key is in no log line');
    const access = world.office.logEvents.filter((event) => event['msg'] === 'request' && event['status'] === 200 && String(event['path']).startsWith('/public/v1/me'));
    assert.deepEqual(access.map((event) => event['keyId']), [id]);
    const refused = world.office.logEvents.filter((event) => event['msg'] === 'request' && event['status'] === 401 && String(event['path']).startsWith('/public/v1'));
    assert.ok(refused.length > 0 && refused.every((event) => !('keyId' in event)));
    assert.ok(!JSON.stringify(world.office.activity.entries).includes(secret));
  });

  it('counts the failed authentications in the per-IP limit, so a client that guesses is stopped even with a good key', async () => {
    const other = await openTestDatabases();
    const limited = await startKeysWorld(other, { env: { RATE_LIMIT_UNAUTHENTICATED_PUBLIC_PER_IP: '3' } });
    try {
      const { secret } = await limited.makeKey();
      assert.equal((await limited.asKey(secret, '/me')).status, 200);
      const statuses: number[] = [];
      for (let index = 0; index < 4; index += 1) {
        statuses.push((await limited.asKey(unknownKey(), '/me')).status);
      }
      assert.deepEqual(statuses, [401, 401, 401, 429]);
      const stopped = await limited.asKey(secret, '/me');
      assert.deepEqual([stopped.status, stopped.body.error.code, typeof stopped.headers.get('retry-after')], [429, 'RATE_LIMITED', 'string']);
    } finally {
      await limited.office.close();
      await other.cleanup();
    }
  });
});

describe('the permissions and the restrictions of a key', () => {
  it('is 403 where the key lacks the permission of the route, and /me needs none', async () => {
    const only = await world.makeKey(0, { permissions: ['places:read'] });
    assert.equal((await asKey(only.secret, '/places')).status, 200);
    assert.equal((await asKey(only.secret, `/places/${hex(place(1))}`)).status, 200);
    for (const path of ['/companies', `/companies/${hex(company(1))}`, '/price-lists', '/taxes', '/currencies', '/measure-units']) {
      const reply = await asKey(only.secret, path);
      assert.deepEqual([reply.status, reply.body.error.code], [403, 'FORBIDDEN'], path);
    }
    assert.equal((await asKey(only.secret, '/me')).status, 200);
    const catalog = await world.makeKey(0, { permissions: ['catalog:read'] });
    assert.deepEqual([(await asKey(catalog.secret, '/price-lists')).status, (await asKey(catalog.secret, '/taxes')).status, (await asKey(catalog.secret, '/currencies')).status, (await asKey(catalog.secret, '/measure-units')).status, (await asKey(catalog.secret, '/places')).status, (await asKey(catalog.secret, '/companies')).status], [200, 200, 200, 200, 403, 403]);
  });

  it('follows a change of the permissions at the next request', async () => {
    const { id, secret } = await world.makeKey(0, { permissions: ['places:read'] });
    assert.equal((await asKey(secret, '/companies')).status, 403);
    await world.as.call(world.office.cluster.psa, 'PATCH', world.keysPath(0, `/${id}`), { permissions: ['companies:read'] });
    assert.deepEqual([(await asKey(secret, '/companies')).status, (await asKey(secret, '/places')).status], [200, 403]);
  });

  it('ends at once when the key is revoked', async () => {
    const { id, secret } = await world.makeKey();
    assert.equal((await asKey(secret, '/me')).status, 200);
    await world.as.call(world.office.cluster.dealerA, 'POST', world.keysPath(0, `/${id}/revoke`));
    assert.deepEqual((await asKey(secret, '/me')).body, unauthenticated);
  });

  it('sees only the places and companies it is restricted to; any other is a 404', async () => {
    const onePlace = await world.makeKey(0, { restrictions: { placeIds: [hex(place(1))] } });
    assert.deepEqual((await asKey(onePlace.secret, '/places')).body.data.map((item: { id: string }) => item.id), [hex(place(1))]);
    assert.equal((await asKey(onePlace.secret, `/places/${hex(place(1))}`)).status, 200);
    assert.deepEqual((await asKey(onePlace.secret, `/places/${hex(place(2))}`)).body, { error: { code: 'NOT_FOUND', message: 'Not found' } });
    // The companies are the ones of its places.
    assert.deepEqual((await asKey(onePlace.secret, '/companies')).body.data.map((item: { id: string }) => item.id), [hex(company(1))]);
    assert.equal((await asKey(onePlace.secret, `/companies/${hex(company(1))}`)).status, 200);
    assert.equal((await asKey(onePlace.secret, `/companies/${hex(company(2))}`)).status, 404);

    const oneCompany = await world.makeKey(0, { restrictions: { companyIds: [hex(company(2))] } });
    assert.deepEqual((await asKey(oneCompany.secret, '/companies')).body.data.map((item: { id: string }) => item.id), [hex(company(2))]);
    assert.deepEqual((await asKey(oneCompany.secret, '/places')).body.data.map((item: { id: string }) => item.id), [hex(place(2))]);
    assert.equal((await asKey(oneCompany.secret, `/places/${hex(place(1))}`)).status, 404);
    assert.equal((await asKey(oneCompany.secret, `/companies/${hex(company(1))}`)).status, 404);

    // Both restrictions: the intersection.
    const both = await world.makeKey(0, { restrictions: { companyIds: [hex(company(1))], placeIds: [hex(place(2))] } });
    assert.deepEqual((await asKey(both.secret, '/places')).body.data, []);
    assert.deepEqual((await asKey(both.secret, '/companies')).body.data, []);
    assert.equal((await asKey(both.secret, `/places/${hex(place(2))}`)).status, 404);
    const bothFine = await world.makeKey(0, { restrictions: { companyIds: [hex(company(1)), hex(company(2))], placeIds: [hex(place(2))] } });
    assert.deepEqual((await asKey(bothFine.secret, '/places')).body.data.map((item: { id: string }) => item.id), [hex(place(2))]);
    assert.deepEqual((await asKey(bothFine.secret, '/companies')).body.data.map((item: { id: string }) => item.id), [hex(company(2))]);
  });

  it('follows a change of the restrictions at the next request, and hides a place that went to the trash or has no company', async () => {
    const { id, secret } = await world.makeKey(0, { restrictions: { placeIds: [hex(place(1)), hex(place(2))] } });
    assert.equal((await asKey(secret, '/places')).body.data.length, 2);
    await world.as.call(world.office.cluster.psa, 'PATCH', world.keysPath(0, `/${id}`), { restrictions: { placeIds: [hex(place(2))] } });
    assert.deepEqual((await asKey(secret, '/places')).body.data.map((item: { id: string }) => item.id), [hex(place(2))]);
    await common().collection('places').updateOne({ _id: place(2) }, { $set: { trash: true } });
    assert.deepEqual([(await asKey(secret, '/places')).body.data, (await asKey(secret, `/places/${hex(place(2))}`)).status, (await asKey(secret, '/companies')).body.data], [[], 404, []]);
    await common().collection('places').updateOne({ _id: place(2) }, { $set: { trash: false, companyId: null } });
    assert.equal((await asKey(secret, '/places')).body.data.length, 1);
    assert.deepEqual((await asKey(secret, '/companies')).body.data, []);
  });

  it('never reaches another group: the id of a place or a company of another group is a 404, and the lists show none', async () => {
    const { secret } = await world.makeKey(0);
    assert.deepEqual([(await asKey(secret, `/places/${hex(g(1).ownPlaceId)}`)).status, (await asKey(secret, `/companies/${hex(company(3))}`)).status], [404, 404]);
    const ids = [...(await asKey(secret, '/places')).body.data, ...(await asKey(secret, '/companies')).body.data].map((item: { id: string }) => item.id);
    assert.deepEqual(ids.sort(), [hex(place(1)), hex(place(2)), hex(company(1)), hex(company(2))].sort());
    const other = await world.makeKey(1);
    assert.deepEqual((await asKey(other.secret, '/places')).body.data.map((item: { id: string }) => item.id).sort(), [hex(place(3)), hex(place(4))]);
    assert.equal((await asKey(other.secret, `/places/${hex(place(1))}`)).status, 404);
    // A copy whose group is a list, or another group, is not seen either.
    await common().collection('places').updateOne({ _id: place(1) }, { $set: { groupId: [g(0).groupId, g(1).groupId] } });
    assert.deepEqual((await asKey(other.secret, '/places')).body.data.length, 2);
    assert.equal((await asKey(other.secret, `/places/${hex(place(1))}`)).status, 404);
    await common().collection('places').updateOne({ _id: place(1) }, { $set: { groupId: g(0).groupId } });
  });
});

describe('the public projections', () => {
  const FORBIDDEN = ['fixture-secret', 'fixture-user', 'fixture-device-secret', 'fixture-integration-secret', '10.0.0.5', '10.0.0.1', '10.0.0.6', 'connector.fixture', 'Mario Rossi', 'IT60X0542811101000000123456', 'pec@acme.example', 'ABC1234', '01879020517', 'bank1', 'groupId', 'openingTime', 'devices', 'integrations', 'platform', 'banks', 'fattura_elettronica', 'settings'];

  it('shows of a place only the fields of the allowlist, even when the document is full of secrets', async () => {
    const placeId = await world.seedPlace(0, 50, 1, { name: 'Bar Roma', status: true });
    const { secret } = await world.makeKey();
    const reply = await asKey(secret, `/places/${hex(placeId)}`);
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.body, {
      data: {
        id: hex(placeId),
        name: 'Bar Roma',
        companyId: hex(company(1)),
        address: { street: 'Via Roma 1', postcode: '20100', city: 'Milano', province: 'MI', country: 'IT' },
        phone: '+39 02 1234567',
        email: 'bar@example.test',
        status: 'active',
        timezone: 'Europe/Rome',
      },
    });
    const list = await asKey(secret, '/places');
    const text = JSON.stringify([reply.body, list.body]);
    for (const word of FORBIDDEN) {
      assert.ok(!text.includes(word), word);
    }
    const listed = (list.body.data as Array<Record<string, unknown>>).find((item) => item['id'] === hex(placeId))!;
    assert.deepEqual(listed, reply.body.data);
    for (const item of list.body.data as Array<Record<string, unknown>>) {
      assert.deepEqual(Object.keys(item).sort(), ['address', 'companyId', 'email', 'id', 'name', 'phone', 'status', 'timezone']);
      assert.deepEqual(Object.keys(item['address'] as object).sort(), ['city', 'country', 'postcode', 'province', 'street']);
    }
  });

  it('shows a place with missing or wrong values with nulls, never an error', async () => {
    const placeId = await world.seedPlace(0, 51, 1, { name: 7, status: 'yes', email: '', telephone: null, timezone: undefined, address: 3, companyId: 'oops' });
    const { secret } = await world.makeKey();
    const reply = await asKey(secret, `/places/${hex(placeId)}`);
    assert.deepEqual(reply.body.data, {
      id: hex(placeId),
      name: '',
      companyId: null,
      address: { street: null, postcode: '20100', city: 'Milano', province: 'MI', country: 'IT' },
      phone: null,
      email: null,
      status: 'disabled',
      timezone: null,
    });
  });

  it('shows a company with missing or wrong values with nulls, never an error', async () => {
    const companyId = await world.seed(0, 61, { name: 7, code: '', code2: null, email: 5, telephone: undefined, address: undefined });
    const { secret } = await world.makeKey();
    const reply = await asKey(secret, `/companies/${hex(companyId)}`);
    assert.deepEqual(reply.body.data, {
      id: hex(companyId),
      name: '',
      vatNumber: null,
      fiscalCode: null,
      address: { street: null, postcode: '20100', city: 'Milano', province: 'MI', country: 'IT' },
      email: null,
      phone: null,
    });
  });

  it('shows of a company only the fields of the allowlist: no bank, no IBAN, no invoicing, no setting', async () => {
    const companyId = await world.seed(0, 60, { name: 'Acme S.r.l.' });
    const { secret } = await world.makeKey();
    const reply = await asKey(secret, `/companies/${hex(companyId)}`);
    assert.deepEqual(reply.body, {
      data: {
        id: hex(companyId),
        name: 'Acme S.r.l.',
        vatNumber: '01114601006',
        fiscalCode: '01114601006',
        address: { street: 'Via Roma 1', postcode: '20100', city: 'Milano', province: 'MI', country: 'IT' },
        email: 'info@acme.example',
        phone: '+39 02 1234567',
      },
    });
    const list = await asKey(secret, '/companies');
    const text = JSON.stringify([reply.body, list.body]);
    for (const word of FORBIDDEN) {
      assert.ok(!text.includes(word), word);
    }
    for (const item of list.body.data as Array<Record<string, unknown>>) {
      assert.deepEqual(Object.keys(item).sort(), ['address', 'email', 'fiscalCode', 'id', 'name', 'phone', 'vatNumber']);
    }
  });

  it('shows the price lists and the tax rates of the group, public fields only', async () => {
    const { secret } = await world.makeKey();
    const lists = await asKey(secret, '/price-lists');
    assert.deepEqual(lists.body, { data: [{ id: hex(fixtureId('group', 900 + 1)), name: 'Listino 1', enabled: true, isDefault: true }] });
    const taxes = await asKey(secret, '/taxes');
    assert.deepEqual(taxes.body, { data: [{ id: 'tax-001', rate: 22, department: 1, description: null, vatNature: null }] });
    const other = await world.makeKey(1);
    assert.deepEqual((await asKey(other.secret, '/taxes')).body.data.map((tax: { id: string }) => tax.id), ['tax-002']);
    await common().collection('groups').updateOne({ _id: g().groupId }, { $set: { priceLists: {}, taxes: [] } });
    assert.deepEqual([(await asKey(secret, '/price-lists')).body, (await asKey(secret, '/taxes')).body], [{ data: [] }, { data: [] }]);
  });

  it('shows the currencies and the measure units of the group, public fields only, read tolerantly', async () => {
    const { secret } = await world.makeKey();
    const currencies = await asKey(secret, '/currencies');
    assert.deepEqual(currencies.body, { data: [{ code: 'EUR', symbol: '\u20ac' }, { code: 'USD', symbol: '$' }] });
    const units = await asKey(secret, '/measure-units');
    assert.deepEqual(units.body, { data: [{ id: 'unit-001', value: 'pz', name: 'pz' }] });
    for (const item of [...currencies.body.data, ...units.body.data] as Array<Record<string, unknown>>) {
      assert.ok(Object.keys(item).length <= 3);
    }
    const restricted = await world.makeKey(0, { permissions: ['catalog:read'], restrictions: { placeIds: [hex(place(1))] } });
    assert.deepEqual([(await asKey(restricted.secret, '/currencies')).body, (await asKey(restricted.secret, '/measure-units')).body], [currencies.body, units.body]);
    const other = await world.makeKey(1);
    assert.deepEqual((await asKey(other.secret, '/measure-units')).body.data.map((unit: { id: string }) => unit.id), ['unit-002']);
    await common().collection('groups').updateOne(
      { _id: g().groupId },
      { $set: { currencies: { USD: { code: 'USD', symbol: '$', extra: 1 }, GBP: { code: 'GBP', symbol: 7 }, XXX: 'bad' }, measureUnits: { a: { id: 'a', value: 3, secret: 'x' }, b: 'bad' } } },
    );
    const dirty = await asKey(secret, '/currencies');
    const dirtyUnits = await asKey(secret, '/measure-units');
    assert.deepEqual([dirty.status, dirtyUnits.status], [200, 200]);
    for (const item of dirty.body.data as Array<Record<string, unknown>>) {
      assert.deepEqual(Object.keys(item).sort(), ['code', 'symbol']);
    }
    for (const item of dirtyUnits.body.data as Array<Record<string, unknown>>) {
      assert.deepEqual(Object.keys(item).sort(), ['id', 'name', 'value']);
    }
    assert.ok(JSON.stringify(dirty.body).includes('"$"'));
    await common().collection('groups').updateOne({ _id: g().groupId }, { $set: { currencies: {}, measureUnits: {} } });
    assert.deepEqual([(await asKey(secret, '/currencies')).body, (await asKey(secret, '/measure-units')).body], [{ data: [] }, { data: [] }]);
  });

  it('pages the lists by name with a limit of at most 100', async () => {
    for (const [n, name] of [[70, 'Cafe A'], [71, 'Cafe B'], [72, 'Cafe C']] as const) {
      await world.seedPlace(0, n, 1, { name });
    }
    for (const [n, name] of [[70, 'Firm A'], [71, 'Firm B'], [72, 'Firm C']] as const) {
      await world.seed(0, n, { name });
    }
    const { secret } = await world.makeKey();
    for (const resource of ['places', 'companies']) {
      const first = await asKey(secret, `/${resource}?limit=2`);
      assert.deepEqual([first.body.data.length, first.body.page.limit, typeof first.body.page.next], [2, 2, 'string']);
      const second = await asKey(secret, `/${resource}?limit=2&cursor=${first.body.page.next as string}`);
      assert.equal(second.body.data.length, 2);
      const names = [...first.body.data, ...second.body.data].map((item: { name: string }) => item.name);
      assert.deepEqual(names, [...names].sort());
      const all = await asKey(secret, `/${resource}`);
      assert.deepEqual([all.body.data.length, all.body.page], [5, { limit: 50, next: null }]);
      assert.equal((await asKey(secret, `/${resource}?limit=100`)).status, 200);
      for (const query of ['limit=101', 'limit=0', 'limit=x', 'cursor=bad!', 'sort=name', 'q=a', 'status=active', 'groupId=1', 'limit=1&limit=2']) {
        const refused = await asKey(secret, `/${resource}?${query}`);
        assert.equal(refused.status, 422, `${resource} ${query}`);
      }
    }
    assert.equal((await asKey(secret, `/places/${hex(place(1))}?x=1`)).status, 422);
    assert.equal((await asKey(secret, '/places/not-an-id')).status, 422);
    assert.equal((await asKey(secret, '/companies/not-an-id')).status, 422);
    assert.equal((await asKey(secret, '/me?x=1')).status, 422);
    assert.equal((await asKey(secret, '/taxes?x=1')).status, 422);
    assert.equal((await asKey(secret, '/price-lists?x=1')).status, 422);
    assert.equal((await asKey(secret, '/currencies?x=1')).status, 422);
    assert.equal((await asKey(secret, '/measure-units?x=1')).status, 422);
  });

  it('answers HEAD like GET without a body', async () => {
    const { secret } = await world.makeKey();
    const reply = await world.office.publicCall('HEAD', '/me', secret);
    assert.deepEqual([reply.status, await reply.text()], [200, '']);
  });

  it('describes the key, its group, its limits and what it used today', async () => {
    const { id, secret } = await world.makeKey(0, { name: 'Webshop', permissions: ['places:read'], restrictions: { companyIds: [hex(company(1))] }, rateLimitPerMinute: 120, dailyQuota: 500 });
    const reply = await asKey(secret, '/me');
    assert.deepEqual(reply.body, {
      data: {
        key: { id, name: 'Webshop', prefix: secret.slice(0, 12), permissions: ['places:read'], restrictions: { companyIds: [hex(company(1))], placeIds: null }, expiresAt: null },
        group: { id: hex(g().groupId), name: 'group-001' },
        limits: { rateLimitPerMinute: 120, dailyQuota: 500, group: { rateLimitPerMinute: 120, dailyQuota: 20000 } },
        usageToday: { calls: 1 },
      },
    });
    assert.equal((await asKey(secret, '/me')).body.data.usageToday.calls, 2);
    assert.equal((await asKey(secret, '/places')).status, 200);
    assert.equal((await asKey(secret, '/me')).body.data.usageToday.calls, 4);
  });
});

describe('the cap of a group, for all its keys together', () => {
  it('limits the requests of the keys of a group per minute together, and not the keys of another group', async () => {
    const other = await openTestDatabases();
    const fresh = await startKeysWorld(other, { rateLimiter: memoryRateLimiter() });
    try {
      const one = await fresh.makeKey(0, { rateLimitPerMinute: 100 });
      const two = await fresh.makeKey(0, { rateLimitPerMinute: 100 });
      const elsewhere = await fresh.makeKey(1, { rateLimitPerMinute: 100 });
      await fresh.setPublicApi(0, { enabled: true, groupRateLimitPerMinute: 3 });
      await fresh.setPublicApi(1, { enabled: true, groupRateLimitPerMinute: 3 });
      const first = await fresh.asKey(one.secret, '/me');
      assert.deepEqual([first.status, first.headers.get('ratelimit-limit'), first.headers.get('ratelimit-remaining')], [200, '3', '2'], 'the tighter limit is the one shown');
      assert.equal((await fresh.asKey(two.secret, '/me')).status, 200);
      assert.equal((await fresh.asKey(one.secret, '/me')).status, 200);
      const over = await fresh.asKey(two.secret, '/me');
      assert.deepEqual([over.status, over.body.error.code, over.headers.get('ratelimit-limit'), over.headers.get('ratelimit-remaining'), over.headers.get('retry-after') !== null], [429, 'RATE_LIMITED', '3', '0', true]);
      assert.equal((await fresh.asKey(one.secret, '/me')).status, 429);
      assert.equal((await fresh.asKey(elsewhere.secret, '/me')).status, 200);
      const events = fresh.office.activity.entries.filter((entry) => entry.action === 'rateLimit.exceeded');
      assert.deepEqual(events.map((event) => [event.metadata, event.actor.kind, event.groupId]), [[{ bucket: 'public:group' }, 'apiKey', fresh.group(0).groupId]]);
    } finally {
      await fresh.office.close();
      await other.cleanup();
    }
  });

  it('limits the requests of the keys of a group per day together: QUOTA_EXCEEDED without a RateLimit header, and the quota of a key is the one the cap leaves', async () => {
    const other = await openTestDatabases();
    const real = await startKeysWorld(other, { rateLimiter: createRateLimiter(other.databases) });
    try {
      const one = await real.makeKey(0, { dailyQuota: 100 });
      const two = await real.makeKey(0, { dailyQuota: 100 });
      await real.setPublicApi(0, { enabled: true, groupDailyQuota: 3 });
      assert.deepEqual([(await real.asKey(one.secret, '/me')).status, (await real.asKey(two.secret, '/me')).status, (await real.asKey(one.secret, '/me')).status], [200, 200, 200]);
      const over = await real.asKey(two.secret, '/me');
      assert.deepEqual([over.status, over.body.error.code, over.headers.get('ratelimit-limit'), over.headers.get('retry-after') !== null], [429, 'QUOTA_EXCEEDED', null, true]);
      assert.deepEqual(real.office.activity.entries.filter((entry) => entry.action === 'rateLimit.exceeded').map((event) => event.metadata), [{ bucket: 'public:group-quota' }]);
      // A request the cap of the group refuses has used a unit of the daily quota of its key (the counters are separate increments, never undone).
      const used = (await real.asKey(one.secret, '/me')).status;
      assert.equal(used, 429);
      const counters = await other.databases.common().collection('rateLimits').find({ _id: /^public:(quota|group-quota):/ }).toArray();
      assert.deepEqual(counters.map((counter) => counter['count']).sort(), [2, 3, 5], 'the keys count 3 and 2, the group 5: a request the cap refuses has used a unit of its key');
    } finally {
      await real.office.close();
      await other.cleanup();
    }
  });

  it('does not let a key that has used up its own quota eat the per-minute capacity of the other keys of the group', async () => {
    const other = await openTestDatabases();
    const fresh = await startKeysWorld(other, { rateLimiter: memoryRateLimiter() });
    try {
      const spent = await fresh.makeKey(0, { dailyQuota: 1, rateLimitPerMinute: 100 });
      const healthy = await fresh.makeKey(0, { rateLimitPerMinute: 100 });
      await fresh.setPublicApi(0, { enabled: true, groupRateLimitPerMinute: 5 });
      const refused: number[] = [];
      for (let index = 0; index < 8; index += 1) {
        refused.push((await fresh.asKey(spent.secret, '/me')).status);
      }
      assert.deepEqual(refused, [200, 429, 429, 429, 429, 429, 429, 429]);
      const codes = (await fresh.asKey(spent.secret, '/me')).body.error.code;
      assert.equal(codes, 'QUOTA_EXCEEDED');
      // The group has used one request of its five per minute: the other key has the other four.
      const statuses: number[] = [];
      for (let index = 0; index < 5; index += 1) {
        statuses.push((await fresh.asKey(healthy.secret, '/me')).status);
      }
      assert.deepEqual(statuses, [200, 200, 200, 200, 429]);
    } finally {
      await fresh.office.close();
      await other.cleanup();
    }
  });

  it('shows the cap of the group in /me, the one of the group or the default of the platform', async () => {
    const { secret } = await world.makeKey(0);
    assert.deepEqual((await asKey(secret, '/me')).body.data.limits.group, { rateLimitPerMinute: 120, dailyQuota: 20000 });
    await world.setPublicApi(0, { enabled: true, groupRateLimitPerMinute: 500, groupDailyQuota: 9000 });
    assert.deepEqual((await asKey(secret, '/me')).body.data.limits.group, { rateLimitPerMinute: 500, dailyQuota: 9000 });
  });
});

describe('the failed authentications of the public surface', () => {
  it('count in a bucket of their own: what a client guesses on /public/v1 does not stop /v1, and the other way round', async () => {
    const other = await openTestDatabases();
    const limited = await startKeysWorld(other, { env: { RATE_LIMIT_UNAUTHENTICATED_PUBLIC_PER_IP: '2', RATE_LIMIT_UNAUTHENTICATED_PER_IP: '2' } });
    try {
      const { secret } = await limited.makeKey();
      assert.deepEqual([(await limited.asKey(unknownKey(), '/me')).status, (await limited.asKey(unknownKey(), '/me')).status, (await limited.asKey(secret, '/me')).status], [401, 401, 429]);
      // The offices behind the same address still reach /v1.
      assert.equal((await limited.office.login('user-002')).status, 200);
      assert.equal((await limited.office.call('GET', '/me', 'fc_at_x')).status, 401);
      assert.equal((await limited.office.call('GET', '/me', 'fc_at_x')).status, 401);
      assert.equal((await limited.office.call('GET', '/me', 'fc_at_x')).status, 429);
      assert.equal((await limited.asKey(secret, '/me')).status, 429);
    } finally {
      await limited.office.close();
      await other.cleanup();
    }
  });
});

describe('the limits of a key', () => {
  it('limits the requests of a key per minute with its own limit, shows RateLimit-* and records the first excess once', async () => {
    const { secret } = await world.makeKey(0, { rateLimitPerMinute: 3 });
    const first = await asKey(secret, '/me');
    assert.deepEqual([first.headers.get('ratelimit-limit'), first.headers.get('ratelimit-remaining'), typeof first.headers.get('ratelimit-reset')], ['3', '2', 'string']);
    await asKey(secret, '/me');
    const third = await asKey(secret, '/me');
    assert.equal(third.headers.get('ratelimit-remaining'), '0');
    for (let index = 0; index < 2; index += 1) {
      const over = await asKey(secret, '/me');
      assert.deepEqual([over.status, over.body.error.code, over.headers.get('ratelimit-remaining'), over.headers.get('retry-after') !== null], [429, 'RATE_LIMITED', '0', true]);
    }
    const events = world.office.activity.entries.filter((entry) => entry.action === 'rateLimit.exceeded');
    assert.equal(events.length, 1);
    assert.deepEqual([events[0]!.metadata, events[0]!.actor.kind, events[0]!.groupId, events[0]!.resource?.type], [{ bucket: 'public:key' }, 'apiKey', g().groupId, 'apiKey']);
    assert.ok(!JSON.stringify(events).includes(secret));
    // Another key of the same group has its own count.
    const another = await world.makeKey(0, { rateLimitPerMinute: 3 });
    assert.equal((await asKey(another.secret, '/me')).status, 200);
  });

  it('limits the requests of a key per day with its quota: 429 QUOTA_EXCEEDED, Retry-After until midnight UTC, counted in the window of the UTC day', async () => {
    const other = await openTestDatabases();
    const real = await startKeysWorld(other, { rateLimiter: createRateLimiter(other.databases) });
    try {
      const { id, secret } = await real.makeKey(0, { dailyQuota: 2 });
      assert.deepEqual([(await real.asKey(secret, '/me')).status, (await real.asKey(secret, '/me')).status], [200, 200]);
      const over = await real.asKey(secret, '/me');
      assert.deepEqual([over.status, over.body.error.code, over.body.error.message], [429, 'QUOTA_EXCEEDED', 'Quota exceeded']);
      const nowSeconds = Math.floor(Date.now() / 1000);
      const untilMidnight = 86_400 - (nowSeconds % 86_400);
      assert.ok(Math.abs(Number(over.headers.get('retry-after')) - untilMidnight) <= 2, `${over.headers.get('retry-after') ?? ''} ${String(untilMidnight)}`);
      assert.deepEqual([over.headers.get('ratelimit-limit'), over.headers.get('ratelimit-remaining'), over.headers.get('ratelimit-reset')], [null, null, null], 'no per-minute header on a refusal for the quota');
      assert.equal((await real.asKey(secret, '/places')).body.error.code, 'QUOTA_EXCEEDED');
      const events = real.office.activity.entries.filter((entry) => entry.action === 'rateLimit.exceeded');
      assert.deepEqual(events.map((event) => [event.metadata, event.actor.kind, event.actor.id?.toHexString()]), [[{ bucket: 'public:quota' }, 'apiKey', id]]);
      const today = await other.databases.common().collection('rateLimits').find({ _id: /^public:quota:/ }).toArray();
      assert.equal(today.length, 1);
      assert.equal(today[0]!['count'], 4);
    } finally {
      await real.office.close();
      await other.cleanup();
    }
  });

  it('counts a request refused by the per-minute limit against the minute and not the day', async () => {
    const other = await openTestDatabases();
    const limiter = memoryRateLimiter();
    const counted = await startKeysWorld(other, { rateLimiter: limiter });
    try {
      const { secret } = await counted.makeKey(0, { rateLimitPerMinute: 1, dailyQuota: 5 });
      assert.deepEqual([(await counted.asKey(secret, '/me')).status, (await counted.asKey(secret, '/me')).status, (await counted.asKey(secret, '/me')).status], [200, 429, 429]);
      const buckets = limiter.calls.filter((call) => call.bucket.startsWith('public:')).map((call) => [call.bucket, call.limit]);
      assert.deepEqual(buckets, [['public:key', 1], ['public:group', 120], ['public:quota', 5], ['public:group-quota', 20000], ['public:key', 1], ['public:key', 1]]);
    } finally {
      await counted.office.close();
      await other.cleanup();
    }
  });
});
