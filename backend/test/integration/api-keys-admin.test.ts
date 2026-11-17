import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { fixtureId } from '../helpers/legacy-fixtures.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { sha256, startKeysWorld } from '../helpers/api-keys.ts';
import type { KeysWorld } from '../helpers/api-keys.ts';

let ctx: TestDatabases;
let world: KeysWorld;
const call = (...args: Parameters<KeysWorld['as']['call']>) => world.as.call(...args);
const failure = (reply: Awaited<ReturnType<typeof call>>) => world.as.failure(reply);
const common = () => ctx.databases.common();
const psa = () => world.office.cluster.psa;
const dealer = () => world.office.cluster.dealerA;
const g = (index = 0) => world.group(index);
const keys = () => common().collection('apiKeys');
const hex = (id: ObjectId) => id.toHexString();
const body = (overrides: Record<string, unknown> = {}) => ({ name: 'Webshop', permissions: ['places:read'], ...overrides });
const denied = { status: 403, code: 'FORBIDDEN', details: undefined };
const notFound = { status: 404, code: 'NOT_FOUND', details: undefined };
const company = (n: number) => fixtureId('company', n);
const place = (n: number) => fixtureId('place', n);

before(async () => {
  ctx = await openTestDatabases();
  world = await startKeysWorld(ctx);
});
after(async () => {
  await world.office.close();
  await ctx.cleanup();
});
beforeEach(async () => {
  await keys().deleteMany({});
  await common().collection('apiUsage').deleteMany({});
  await common().collection('groups').updateMany({}, { $unset: { publicApi: '' } });
  await common().collection('places').updateMany({}, { $set: { trash: false } });
  await common().collection('companies').updateMany({}, { $set: { trash: false } });
  world.office.activity.entries.length = 0;
});

describe('creating a key', () => {
  it('is for the PSA and the dealer of the group: 201 with the key and its secret, shown once', async () => {
    for (const actor of [psa(), dealer()]) {
      const reply = await call(actor, 'POST', world.keysPath(0), body());
      assert.equal(reply.status, 201);
      const { secret, ...item } = reply.body.data;
      assert.match(secret, /^fc_pk_[A-Za-z0-9_-]{43}$/);
      assert.deepEqual(item, {
        id: item.id,
        name: 'Webshop',
        prefix: secret.slice(0, 12),
        permissions: ['places:read'],
        restrictions: { companyIds: null, placeIds: null },
        rateLimitPerMinute: 60,
        dailyQuota: 10000,
        expiresAt: null,
        status: 'active',
        createdAt: new Date(world.office.clock.now()).toISOString(),
        createdBy: { id: hex(actor), role: actor.equals(psa()) ? 'PSA' : 'D' },
        lastUsedAt: null,
        revokedAt: null,
        revokedBy: null,
      });
      assert.equal(reply.headers.get('location'), `/v1${world.keysPath(0)}/${item.id}`);
      assert.equal(reply.headers.get('cache-control'), 'no-store');
      assert.equal(reply.headers.get('content-encoding'), null);
    }
  });

  it('stores only the hash and the prefix of the secret, and nothing else that could give it back', async () => {
    const reply = await call(psa(), 'POST', world.keysPath(0), body());
    const secret = reply.body.data.secret as string;
    const stored = (await world.storedKey(reply.body.data.id))!;
    assert.equal(stored['hash'], sha256(secret));
    assert.equal(stored['prefix'], secret.slice(0, 12));
    assert.ok(!JSON.stringify(stored).includes(secret.slice(6)), 'no part of the secret is stored');
    assert.deepEqual(Object.keys(stored).sort(), ['_id', 'createdAt', 'createdBy', 'dailyQuota', 'expiresAt', 'groupId', 'hash', 'lastUsedAt', 'name', 'permissions', 'prefix', 'rateLimitPerMinute', 'restrictions', 'revokedAt', 'revokedBy', 'status']);
    assert.deepEqual(stored['createdBy'], { userId: psa(), role: 'PSA' });
    assert.deepEqual(stored['groupId'], g().groupId);
  });

  it('gives every key another secret', async () => {
    const secrets = new Set<string>();
    for (let index = 0; index < 5; index += 1) {
      secrets.add((await call(psa(), 'POST', world.keysPath(0), body())).body.data.secret as string);
    }
    assert.equal(secrets.size, 5);
  });

  it('records apiKey.created with the name and the prefix, and never the secret', async () => {
    const reply = await call(dealer(), 'POST', world.keysPath(0), body({ name: 'Provider A' }));
    const events = world.office.activity.entries.filter((entry) => entry.action === 'apiKey.created');
    assert.equal(events.length, 1);
    const [event] = events;
    assert.deepEqual([event!.category, event!.outcome, event!.actor.kind, event!.actor.role, event!.resource], ['security', 'success', 'user', 'D', { type: 'apiKey', id: reply.body.data.id }]);
    assert.deepEqual(event!.groupId, g().groupId);
    assert.deepEqual(event!.metadata, { name: 'Provider A', keyHint: (reply.body.data.prefix as string).slice(6) });
    assert.ok(!JSON.stringify(world.office.activity.entries).includes(reply.body.data.secret as string));
  });

  it('refuses the roles that do not manage the keys of a group, the store key and a request without credentials', async () => {
    for (const actor of [g().sa, g().ca, g().pa]) {
      assert.deepEqual(failure(await call(actor, 'POST', world.keysPath(0), body())), denied, hex(actor));
    }
    // A user with the role E cannot even log in to the backoffice.
    assert.equal((await world.office.login('user-006')).status, 401);
    const store = await world.activate(g().ownPlaceId);
    assert.equal((await world.asStore(store.key, 'POST', world.keysPath(0), body())).status, 403);
    assert.equal((await world.asStore(store.key, 'GET', world.keysPath(0))).status, 403);
    assert.equal((await world.asStore(undefined, 'POST', world.keysPath(0), body())).status, 401);
    assert.equal(await keys().countDocuments(), 0);
  });

  it('is limited to the groups of the dealer: another dealer, another group, a malformed or an unknown id are a 404', async () => {
    assert.deepEqual(failure(await call(world.office.cluster.dealerB, 'POST', world.keysPath(0), body())), notFound);
    assert.deepEqual(failure(await call(dealer(), 'POST', world.keysPath(2), body())), notFound);
    assert.deepEqual(failure(await call(g().sa, 'POST', world.keysPath(1), body())), notFound);
    assert.deepEqual(failure(await call(psa(), 'POST', '/groups/xyz/api-keys', body())), notFound);
    assert.deepEqual(failure(await call(psa(), 'POST', `/groups/${hex(fixtureId('group', 999))}/api-keys`, body())), notFound);
    assert.equal(await keys().countDocuments(), 0);
  });

  it('gives the key the limits of its group, or the platform ones when the group has none', async () => {
    const platform = await call(dealer(), 'POST', world.keysPath(0), body());
    assert.deepEqual([platform.body.data.rateLimitPerMinute, platform.body.data.dailyQuota], [60, 10000]);
    await world.setPublicApi(0, { enabled: true, defaultRateLimitPerMinute: 120, defaultDailyQuota: 5000 });
    const own = await call(dealer(), 'POST', world.keysPath(0), body());
    assert.deepEqual([own.body.data.rateLimitPerMinute, own.body.data.dailyQuota], [120, 5000]);
  });

  it('takes the limits of the body from the PSA alone; from a dealer they are 403 notAllowed and nothing is created', async () => {
    const reply = await call(psa(), 'POST', world.keysPath(0), body({ rateLimitPerMinute: 600, dailyQuota: 1000000 }));
    assert.deepEqual([reply.status, reply.body.data.rateLimitPerMinute, reply.body.data.dailyQuota], [201, 600, 1000000]);
    await keys().deleteMany({});
    for (const limits of [{ rateLimitPerMinute: 10 }, { dailyQuota: 10 }, { rateLimitPerMinute: 10, dailyQuota: 10 }]) {
      const refused = await call(dealer(), 'POST', world.keysPath(0), body(limits));
      assert.equal(refused.status, 403);
      assert.deepEqual(refused.body.error.details, Object.keys(limits).map((field) => ({ field, issue: 'notAllowed' })));
    }
    assert.equal(await keys().countDocuments(), 0);
  });

  it('validates the limits, the name, the permissions and refuses every other field', async () => {
    const cases: Array<[Record<string, unknown>, string, string]> = [
      [{ rateLimitPerMinute: 0 }, 'rateLimitPerMinute', 'minimum'],
      [{ rateLimitPerMinute: 6001 }, 'rateLimitPerMinute', 'maximum'],
      [{ rateLimitPerMinute: 1.5 }, 'rateLimitPerMinute', 'type'],
      [{ dailyQuota: 0 }, 'dailyQuota', 'minimum'],
      [{ dailyQuota: 10_000_001 }, 'dailyQuota', 'maximum'],
      [{ name: '' }, 'name', 'minLength'],
      [{ name: 'x'.repeat(101) }, 'name', 'maxLength'],
      [{ name: 5 }, 'name', 'type'],
      [{ permissions: [] }, 'permissions', 'minLength'],
      [{ permissions: ['places:read', 'places:read'] }, 'permissions.1', 'incorrect'],
      [{ permissions: ['products:read'] }, 'permissions.0', 'enum'],
      [{ permissions: 'places:read' }, 'permissions', 'type'],
      [{ hash: 'a'.repeat(64) }, 'hash', 'unknown'],
      [{ status: 'revoked' }, 'status', 'unknown'],
      [{ groupId: hex(g(1).groupId) }, 'groupId', 'unknown'],
      [{ secret: 'fc_pk_x' }, 'secret', 'unknown'],
      [{ prefix: 'fc_pk_aaaaaa' }, 'prefix', 'unknown'],
      [{ expiresAt: 'tomorrow' }, 'expiresAt', 'format'],
      [{ restrictions: { companyIds: [] } }, 'restrictions.companyIds', 'minLength'],
      [{ restrictions: { companyIds: ['nope'] } }, 'restrictions.companyIds.0', 'format'],
      [{ restrictions: { other: [] } }, 'restrictions.other', 'unknown'],
      [{ restrictions: { $where: 1 } }, 'restrictions.(key)', 'forbiddenKey'],
    ];
    for (const [overrides, field, issue] of cases) {
      const reply = await call(psa(), 'POST', world.keysPath(0), body(overrides));
      assert.equal(reply.status, 422, field);
      assert.ok((reply.body.error.details as Array<{ field: string; issue: string }>).some((detail) => detail.field === field && detail.issue === issue), `${field} ${issue} in ${JSON.stringify(reply.body.error.details)}`);
    }
    const missing = await call(psa(), 'POST', world.keysPath(0), { permissions: ['places:read'] });
    assert.deepEqual(missing.body.error.details, [{ field: 'name', issue: 'required' }]);
    assert.equal(await keys().countDocuments(), 0);
  });

  it('takes an expiry in the future and within three years', async () => {
    const now = world.office.clock.now();
    const day = 86_400_000;
    const past = await call(psa(), 'POST', world.keysPath(0), body({ expiresAt: new Date(now - day).toISOString() }));
    assert.deepEqual([past.status, past.body.error.details], [422, [{ field: 'expiresAt', issue: 'minimum' }]]);
    const now2 = await call(psa(), 'POST', world.keysPath(0), body({ expiresAt: new Date(now).toISOString() }));
    assert.deepEqual([now2.status, now2.body.error.details], [422, [{ field: 'expiresAt', issue: 'minimum' }]]);
    const far = await call(psa(), 'POST', world.keysPath(0), body({ expiresAt: new Date(now + 3 * 365 * day + 1000).toISOString() }));
    assert.deepEqual([far.status, far.body.error.details], [422, [{ field: 'expiresAt', issue: 'maximum' }]]);
    const edge = new Date(now + 3 * 365 * day).toISOString();
    const ok = await call(psa(), 'POST', world.keysPath(0), body({ expiresAt: edge }));
    assert.deepEqual([ok.status, ok.body.data.expiresAt], [201, edge]);
    const none = await call(psa(), 'POST', world.keysPath(0), body({ expiresAt: null }));
    assert.deepEqual([none.status, none.body.data.expiresAt], [201, null]);
  });

  it('takes restrictions only on companies and places of the group, outside the trash, each once', async () => {
    const ok = await call(psa(), 'POST', world.keysPath(0), body({ restrictions: { companyIds: [hex(company(1))], placeIds: [hex(place(1)), hex(place(2))] } }));
    assert.equal(ok.status, 201);
    assert.deepEqual(ok.body.data.restrictions, { companyIds: [hex(company(1))], placeIds: [hex(place(1)), hex(place(2))] });
    assert.deepEqual((await world.storedKey(ok.body.data.id))!['restrictions'], { companyIds: [company(1)], placeIds: [place(1), place(2)] });
    const cases: Array<[Record<string, unknown>, Array<{ field: string; issue: string }>]> = [
      [{ companyIds: [hex(company(3))] }, [{ field: 'restrictions.companyIds.0', issue: 'incorrect' }]],
      [{ companyIds: [hex(fixtureId('company', 999))] }, [{ field: 'restrictions.companyIds.0', issue: 'incorrect' }]],
      [{ placeIds: [hex(place(1)), hex(place(3))] }, [{ field: 'restrictions.placeIds.1', issue: 'incorrect' }]],
      [{ placeIds: [hex(place(1)), hex(place(1))] }, [{ field: 'restrictions.placeIds.1', issue: 'incorrect' }]],
      [{ companyIds: [hex(company(4))], placeIds: [hex(place(4))] }, [{ field: 'restrictions.companyIds.0', issue: 'incorrect' }, { field: 'restrictions.placeIds.0', issue: 'incorrect' }]],
    ];
    for (const [restrictions, details] of cases) {
      const reply = await call(psa(), 'POST', world.keysPath(0), body({ restrictions }));
      assert.deepEqual([reply.status, reply.body.error.details], [422, details], JSON.stringify(restrictions));
    }
    await common().collection('places').updateOne({ _id: place(2) }, { $set: { trash: true } });
    await common().collection('companies').updateOne({ _id: company(2) }, { $set: { trash: true } });
    const trashed = await call(psa(), 'POST', world.keysPath(0), body({ restrictions: { companyIds: [hex(company(2))], placeIds: [hex(place(2))] } }));
    assert.equal(trashed.status, 422);
    assert.equal(await keys().countDocuments(), 1);
  });

  it('is capped at 50 keys that work in a group: the 51st is a 409, a revoked one does not count, another group is not affected', async () => {
    const now = new Date();
    const documents = Array.from({ length: 50 }, (_unused, index): Document => ({
      groupId: g().groupId,
      name: `Key ${String(index)}`,
      prefix: `fc_pk_${String(index).padStart(6, '0')}`,
      hash: sha256(`seed-${String(index)}`),
      permissions: ['places:read'],
      restrictions: { companyIds: null, placeIds: null },
      rateLimitPerMinute: 60,
      dailyQuota: 10000,
      expiresAt: null,
      status: 'active',
      revokedAt: null,
      revokedBy: null,
      createdAt: now,
      createdBy: { userId: psa(), role: 'PSA' },
      lastUsedAt: null,
    }));
    await keys().insertMany(documents);
    assert.deepEqual(failure(await call(psa(), 'POST', world.keysPath(0), body())), { status: 409, code: 'CONFLICT', details: undefined });
    assert.equal((await call(psa(), 'POST', world.keysPath(1), body())).status, 201);
    const first = (await keys().findOne({ groupId: g().groupId }))!;
    assert.equal((await call(psa(), 'POST', world.keysPath(0, `/${hex(first['_id'] as ObjectId)}/revoke`))).status, 200);
    assert.equal((await call(psa(), 'POST', world.keysPath(0), body())).status, 201);
    assert.equal((await call(psa(), 'POST', world.keysPath(0), body())).status, 409);
    // A key that has expired no longer counts: the group can make another.
    await keys().updateOne({ groupId: g().groupId, status: 'active' }, { $set: { expiresAt: new Date(world.office.clock.now() - 1) } });
    assert.equal((await call(psa(), 'POST', world.keysPath(0), body())).status, 201);
    assert.equal((await call(psa(), 'POST', world.keysPath(0), body())).status, 409);
  });

  it('does not take an Idempotency-Key: it is ignored, and every request makes a key', async () => {
    const headers = { 'idempotency-key': '7f1c2b34-5d6e-4f70-8a91-b2c3d4e5f607' }; // gitleaks:allow (fake test value)
    const first = await call(psa(), 'POST', world.keysPath(0), body(), headers);
    const second = await call(psa(), 'POST', world.keysPath(0), body(), headers);
    assert.deepEqual([first.status, second.status], [201, 201]);
    assert.notEqual(first.body.data.secret, second.body.data.secret);
    assert.equal(await keys().countDocuments(), 2);
  });

  it('answers 415 to a body that is not JSON, 413 to one that is too large and 422 to none', async () => {
    const token = await world.as.tokenOf(psa());
    const send = (init: RequestInit) => fetch(`${world.office.app.baseUrl}/v1${world.keysPath(0)}`, { method: 'POST', ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers as Record<string, string>) } });
    assert.equal((await send({ headers: { 'content-type': 'text/plain' }, body: 'x' })).status, 415);
    assert.equal((await send({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body({ name: 'x'.repeat(20000) })) })).status, 413);
    assert.equal((await send({ headers: { 'content-type': 'application/json' }, body: 'not json' })).status, 400);
    assert.equal((await send({ headers: {} })).status, 422);
  });
});

describe('the list of the keys of a group', () => {
  it('shows the keys newest first with the page envelope, and never the hash or the secret', async () => {
    const created: string[] = [];
    for (const name of ['One', 'Two', 'Three']) {
      world.office.clock.advance(1000);
      created.unshift((await call(psa(), 'POST', world.keysPath(0), body({ name }))).body.data.id as string);
    }
    const reply = await call(dealer(), 'GET', world.keysPath(0));
    assert.equal(reply.status, 200);
    assert.deepEqual((reply.body.data as Array<{ id: string }>).map((item) => item.id), created);
    assert.deepEqual(reply.body.page, { limit: 50, next: null });
    const text = JSON.stringify(reply.body);
    for (const stored of await keys().find().toArray()) {
      assert.ok(!text.includes(stored['hash'] as string));
    }
    assert.ok(!text.includes('"secret"') && !text.includes('"hash"'));
    assert.deepEqual(Object.keys(reply.body.data[0]).sort(), ['createdAt', 'createdBy', 'dailyQuota', 'expiresAt', 'id', 'lastUsedAt', 'name', 'permissions', 'prefix', 'rateLimitPerMinute', 'restrictions', 'revokedAt', 'revokedBy', 'status']);
  });

  it('pages with a cursor, filters by status, and shows only the keys of the group', async () => {
    const ids: string[] = [];
    for (const name of ['A', 'B', 'C']) {
      world.office.clock.advance(1000);
      ids.unshift((await call(psa(), 'POST', world.keysPath(0), body({ name }))).body.data.id as string);
    }
    await call(psa(), 'POST', world.keysPath(1), body({ name: 'Elsewhere' }));
    const first = await call(psa(), 'GET', `${world.keysPath(0)}?limit=2`);
    assert.deepEqual([first.body.data.map((item: { id: string }) => item.id), first.body.page.limit, typeof first.body.page.next], [ids.slice(0, 2), 2, 'string']);
    const second = await call(psa(), 'GET', `${world.keysPath(0)}?limit=2&cursor=${first.body.page.next as string}`);
    assert.deepEqual([second.body.data.map((item: { id: string }) => item.id), second.body.page.next], [ids.slice(2), null]);
    await call(psa(), 'POST', world.keysPath(0, `/${ids[0]!}/revoke`));
    assert.deepEqual((await call(psa(), 'GET', `${world.keysPath(0)}?status=revoked`)).body.data.map((item: { id: string }) => item.id), [ids[0]]);
    assert.equal((await call(psa(), 'GET', `${world.keysPath(0)}?status=active`)).body.data.length, 2);
    assert.equal((await call(psa(), 'GET', `${world.keysPath(0)}?status=other`)).status, 422);
    assert.equal((await call(psa(), 'GET', `${world.keysPath(0)}?cursor=bad!`)).status, 422);
    assert.equal((await call(psa(), 'GET', `${world.keysPath(0)}?sort=name`)).status, 422);
    assert.equal((await call(psa(), 'GET', `${world.keysPath(0)}?limit=0`)).status, 422);
  });

  it('is for the PSA and the dealer, 403 for the others, 404 outside the perimeter', async () => {
    for (const actor of [g().sa, g().ca, g().pa]) {
      assert.deepEqual(failure(await call(actor, 'GET', world.keysPath(0))), denied);
    }
    assert.deepEqual(failure(await call(world.office.cluster.dealerB, 'GET', world.keysPath(0))), notFound);
    assert.equal((await call(dealer(), 'GET', world.keysPath(0))).status, 200);
  });
});

describe('one key', () => {
  it('is read by the PSA and the dealer of its group, and is a 404 in any other group or for an unknown id', async () => {
    const { id } = (await call(psa(), 'POST', world.keysPath(0), body())).body.data;
    for (const actor of [psa(), dealer()]) {
      const reply = await call(actor, 'GET', world.keysPath(0, `/${id as string}`));
      assert.deepEqual([reply.status, reply.body.data.id, 'secret' in reply.body.data], [200, id, false]);
    }
    assert.deepEqual(failure(await call(psa(), 'GET', world.keysPath(1, `/${id as string}`))), notFound);
    assert.deepEqual(failure(await call(psa(), 'GET', world.keysPath(0, `/${hex(new ObjectId())}`))), notFound);
    assert.equal((await call(psa(), 'GET', world.keysPath(0, '/not-an-id'))).status, 422);
    assert.deepEqual(failure(await call(g().sa, 'GET', world.keysPath(0, `/${id as string}`))), denied);
  });
});

describe('changing a key', () => {
  const create = async (overrides: Record<string, unknown> = {}, actor = psa()) => (await call(actor, 'POST', world.keysPath(0), body(overrides))).body.data as { id: string; secret: string };
  const patch = (id: string, changes: unknown, actor = psa(), index = 0) => call(actor, 'PATCH', world.keysPath(index, `/${id}`), changes);

  it('changes the name, the permissions, the restrictions and the expiry, and records apiKey.updated with the names of the fields', async () => {
    const { id } = await create();
    world.office.activity.entries.length = 0;
    const expiresAt = new Date(world.office.clock.now() + 86_400_000).toISOString();
    const reply = await patch(id, { name: 'Renamed', permissions: ['places:read', 'catalog:read'], restrictions: { placeIds: [hex(place(1))] }, expiresAt }, dealer());
    assert.equal(reply.status, 200);
    assert.deepEqual([reply.body.data.name, reply.body.data.permissions, reply.body.data.restrictions, reply.body.data.expiresAt], ['Renamed', ['places:read', 'catalog:read'], { companyIds: null, placeIds: [hex(place(1))] }, expiresAt]);
    const events = world.office.activity.entries.filter((entry) => entry.action === 'apiKey.updated');
    assert.equal(events.length, 1);
    assert.deepEqual(events[0]!.metadata, { name: 'Renamed', keyHint: (reply.body.data.prefix as string).slice(6), fields: 'name,permissions,restrictions,expiresAt' });
    assert.deepEqual([events[0]!.actor.role, events[0]!.category], ['D', 'security']);
    const stored = (await world.storedKey(id))!;
    assert.deepEqual([stored['hash'] !== undefined, stored['status']], [true, 'active']);
  });

  it('changes only the restriction it names and removes one with null', async () => {
    const { id } = await create({ restrictions: { companyIds: [hex(company(1))], placeIds: [hex(place(1))] } });
    assert.deepEqual((await patch(id, { restrictions: { companyIds: [hex(company(2))] } })).body.data.restrictions, { companyIds: [hex(company(2))], placeIds: [hex(place(1))] });
    assert.deepEqual((await patch(id, { restrictions: { placeIds: null } })).body.data.restrictions, { companyIds: [hex(company(2))], placeIds: null });
    assert.deepEqual((await patch(id, { restrictions: { companyIds: null } })).body.data.restrictions, { companyIds: null, placeIds: null });
    assert.equal((await patch(id, { restrictions: { placeIds: [hex(place(3))] } })).status, 422);
  });

  it('removes the expiry with null and validates a new one', async () => {
    const { id } = await create({ expiresAt: new Date(world.office.clock.now() + 86_400_000).toISOString() });
    assert.equal((await patch(id, { expiresAt: new Date(world.office.clock.now() - 1000).toISOString() })).status, 422);
    assert.equal((await patch(id, { expiresAt: new Date(world.office.clock.now() + 4 * 365 * 86_400_000).toISOString() })).status, 422);
    assert.equal((await patch(id, { expiresAt: null })).body.data.expiresAt, null);
  });

  it('takes the limits from the PSA alone, and a dealer who sends one is 403 notAllowed even with the value it has', async () => {
    const { id } = await create();
    const changed = await patch(id, { rateLimitPerMinute: 300, dailyQuota: 20000 });
    assert.deepEqual([changed.status, changed.body.data.rateLimitPerMinute, changed.body.data.dailyQuota], [200, 300, 20000]);
    for (const limits of [{ rateLimitPerMinute: 10 }, { dailyQuota: 20000 }]) {
      const refused = await patch(id, limits, dealer());
      assert.equal(refused.status, 403);
      assert.deepEqual(refused.body.error.details, Object.keys(limits).map((field) => ({ field, issue: 'notAllowed' })));
    }
    assert.deepEqual([(await world.storedKey(id))!['rateLimitPerMinute'], (await world.storedKey(id))!['dailyQuota']], [300, 20000]);
    assert.equal((await patch(id, { rateLimitPerMinute: 0 })).status, 422);
  });

  it('writes and records nothing for a request that changes nothing', async () => {
    const { id } = await create({ restrictions: { placeIds: [hex(place(1))] } });
    world.office.activity.entries.length = 0;
    const before = await world.storedKey(id);
    const reply = await patch(id, { name: 'Webshop', permissions: ['places:read'], restrictions: { companyIds: null, placeIds: [hex(place(1))] }, expiresAt: null, rateLimitPerMinute: 60, dailyQuota: 10000 });
    assert.equal(reply.status, 200);
    assert.deepEqual(await world.storedKey(id), before);
    assert.equal(world.office.activity.entries.length, 0);
    assert.equal((await patch(id, { permissions: ['places:read'] })).status, 200);
    assert.equal(world.office.activity.entries.length, 0);
    // The same permissions in another order are the same permissions.
    const two = await create({ permissions: ['places:read', 'companies:read'] });
    assert.equal((await patch(two.id, { permissions: ['companies:read', 'places:read'] })).status, 200);
    assert.deepEqual((await world.storedKey(two.id))!['permissions'], ['places:read', 'companies:read']);
  });

  it('refuses an empty body, any field of the key that is not its to change, and a revoked key', async () => {
    const { id } = await create();
    assert.deepEqual((await patch(id, {})).body.error.details, [{ field: '(body)', issue: 'required' }]);
    for (const field of ['hash', 'prefix', 'status', 'groupId', 'secret', 'createdAt', 'lastUsedAt', 'revokedAt']) {
      const reply = await patch(id, { [field]: field === 'status' ? 'revoked' : 'x' });
      assert.deepEqual([reply.status, reply.body.error.details], [422, [{ field, issue: 'unknown' }]], field);
    }
    assert.equal((await call(psa(), 'POST', world.keysPath(0, `/${id}/revoke`))).status, 200);
    assert.deepEqual(failure(await patch(id, { name: 'Late' })), { status: 409, code: 'CONFLICT', details: undefined });
    assert.equal((await world.storedKey(id))!['name'], 'Webshop');
  });

  it('does not change a key whose time is over, not even to give it a new expiry: 409, like a revoked one', async () => {
    const { id } = await create({ expiresAt: new Date(world.office.clock.now() + 3600_000).toISOString() });
    assert.equal((await patch(id, { name: 'Still fine' })).status, 200);
    await keys().updateOne({ _id: new ObjectId(id) }, { $set: { expiresAt: new Date(world.office.clock.now()) } });
    for (const changes of [{ name: 'Late' }, { expiresAt: new Date(world.office.clock.now() + 86_400_000).toISOString() }, { expiresAt: null }, { permissions: ['catalog:read'] }]) {
      assert.deepEqual(failure(await patch(id, changes)), { status: 409, code: 'CONFLICT', details: undefined }, JSON.stringify(changes));
    }
    const stored = (await world.storedKey(id))!;
    assert.deepEqual([stored['name'], stored['expiresAt']], ['Still fine', new Date(world.office.clock.now())]);
  });

  it('is for the PSA and the dealer of the group, and a 404 for any other key', async () => {
    const { id } = await create();
    for (const actor of [g().sa, g().ca, g().pa]) {
      assert.deepEqual(failure(await patch(id, { name: 'X' }, actor)), denied);
    }
    assert.deepEqual(failure(await patch(id, { name: 'X' }, world.office.cluster.dealerB)), notFound);
    assert.deepEqual(failure(await patch(id, { name: 'X' }, psa(), 1)), notFound);
    assert.deepEqual(failure(await patch(hex(new ObjectId()), { name: 'X' })), notFound);
    assert.equal((await world.storedKey(id))!['name'], 'Webshop');
  });
});

describe('revoking a key', () => {
  it('ends the key, keeps it in the list, records who and when, and is idempotent', async () => {
    const { id } = (await call(psa(), 'POST', world.keysPath(0), body())).body.data as { id: string };
    world.office.activity.entries.length = 0;
    world.office.clock.advance(5000);
    const at = new Date(world.office.clock.now()).toISOString();
    const first = await call(dealer(), 'POST', world.keysPath(0, `/${id}/revoke`));
    assert.deepEqual([first.status, first.body.data.status, first.body.data.revokedAt, first.body.data.revokedBy], [200, 'revoked', at, { id: hex(dealer()), role: 'D' }]);
    world.office.clock.advance(5000);
    const again = await call(psa(), 'POST', world.keysPath(0, `/${id}/revoke`));
    assert.deepEqual([again.status, again.body.data.revokedAt, again.body.data.revokedBy], [200, at, { id: hex(dealer()), role: 'D' }]);
    const events = world.office.activity.entries.filter((entry) => entry.action === 'apiKey.revoked');
    assert.equal(events.length, 1);
    assert.deepEqual(events[0]!.metadata, { name: 'Webshop', keyHint: (first.body.data.prefix as string).slice(6) });
    assert.deepEqual((await call(psa(), 'GET', world.keysPath(0))).body.data.map((item: { id: string; status: string }) => [item.id, item.status]), [[id, 'revoked']]);
    assert.equal(await keys().countDocuments(), 1);
  });

  it('is for the PSA and the dealer of the group, 404 for any other key, and takes no body', async () => {
    const { id } = (await call(psa(), 'POST', world.keysPath(0), body())).body.data as { id: string };
    for (const actor of [g().sa, g().ca, g().pa]) {
      assert.deepEqual(failure(await call(actor, 'POST', world.keysPath(0, `/${id}/revoke`))), denied);
    }
    assert.deepEqual(failure(await call(psa(), 'POST', world.keysPath(1, `/${id}/revoke`))), notFound);
    assert.deepEqual(failure(await call(psa(), 'POST', world.keysPath(0, `/${hex(new ObjectId())}/revoke`))), notFound);
    assert.equal((await call(psa(), 'POST', world.keysPath(0, `/${id}/revoke`), { reason: 'x' })).status, 422);
    assert.equal((await world.storedKey(id))!['status'], 'active');
    assert.equal((await call(psa(), 'POST', world.keysPath(0, `/${id}/revoke`), {})).status, 200);
  });

  it('is limited per user: the writes of the keys answer 429 over the threshold', async () => {
    const other = await openTestDatabases();
    const limited = await startKeysWorld(other, { env: { RATE_LIMIT_API_KEY_ADMIN_PER_USER: '2' } });
    try {
      const path = limited.keysPath(0);
      const statuses: number[] = [];
      for (let index = 0; index < 3; index += 1) {
        statuses.push((await limited.as.call(limited.office.cluster.psa, 'POST', path, body())).status);
      }
      assert.deepEqual(statuses, [201, 201, 429]);
      assert.equal((await limited.as.call(limited.office.cluster.psa, 'GET', path)).status, 200);
    } finally {
      await limited.office.close();
      await other.cleanup();
    }
  });
});

describe('the usage of a key', () => {
  const row = (keyId: string, day: string, route: string, counts: Partial<Record<'calls' | 'errors4xx' | 'errors5xx' | 'rateLimited' | 'aborted', number>> = {}): Document => ({
    keyId: new ObjectId(keyId),
    groupId: g().groupId,
    day,
    route,
    calls: 1,
    errors4xx: 0,
    errors5xx: 0,
    rateLimited: 0,
    aborted: 0,
    expireAt: new Date('2030-01-01T00:00:00.000Z'),
    ...counts,
  });
  const today = () => new Date(world.office.clock.now()).toISOString().slice(0, 10);
  const daysAgo = (days: number) => new Date(world.office.clock.now() - days * 86_400_000).toISOString().slice(0, 10);

  it('gives the daily rows per route with the totals, for the last 30 days by default', async () => {
    const { id } = (await call(psa(), 'POST', world.keysPath(0), body())).body.data as { id: string };
    await common().collection('apiUsage').insertMany([
      row(id, today(), 'GET /public/v1/places', { calls: 10, errors4xx: 2, rateLimited: 1, aborted: 3 }),
      row(id, today(), 'GET /public/v1/me', { calls: 5 }),
      row(id, daysAgo(29), 'GET /public/v1/places', { calls: 3, errors5xx: 1 }),
      row(id, daysAgo(30), 'GET /public/v1/places', { calls: 100 }),
      row(hex(new ObjectId()), today(), 'GET /public/v1/places', { calls: 1000 }),
    ]);
    const reply = await call(dealer(), 'GET', world.keysPath(0, `/${id}/usage`));
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.body.data, {
      keyId: id,
      from: daysAgo(29),
      to: today(),
      totals: { calls: 18, errors4xx: 2, errors5xx: 1, rateLimited: 1, aborted: 3 },
      rows: [
        { day: daysAgo(29), route: 'GET /public/v1/places', calls: 3, errors4xx: 0, errors5xx: 1, rateLimited: 0, aborted: 0 },
        { day: today(), route: 'GET /public/v1/me', calls: 5, errors4xx: 0, errors5xx: 0, rateLimited: 0, aborted: 0 },
        { day: today(), route: 'GET /public/v1/places', calls: 10, errors4xx: 2, errors5xx: 0, rateLimited: 1, aborted: 3 },
      ],
    });
  });

  it('takes a range, of at most 92 days, and gives an empty answer for a day with no use', async () => {
    const { id } = (await call(psa(), 'POST', world.keysPath(0), body())).body.data as { id: string };
    await common().collection('apiUsage').insertOne(row(id, '2026-03-10', 'GET /public/v1/me', { calls: 4 }));
    const usage = (query: string) => call(psa(), 'GET', world.keysPath(0, `/${id}/usage${query}`));
    const found = await usage('?from=2026-03-10&to=2026-03-10');
    assert.deepEqual([found.status, found.body.data.totals.calls, found.body.data.rows.length], [200, 4, 1]);
    const empty = await usage('?from=2026-03-11&to=2026-03-12');
    assert.deepEqual([empty.body.data.totals, empty.body.data.rows], [{ calls: 0, errors4xx: 0, errors5xx: 0, rateLimited: 0, aborted: 0 }, []]);
    assert.equal((await usage('?from=2026-01-01&to=2026-04-02')).status, 200);
    assert.deepEqual((await usage('?from=2026-01-01&to=2026-04-03')).body.error.details, [{ field: 'from', issue: 'maximum' }]);
    assert.deepEqual((await usage('?from=2026-03-12&to=2026-03-11')).body.error.details, [{ field: 'from', issue: 'incorrect' }]);
    assert.deepEqual((await usage('?from=2026-02-30')).body.error.details, [{ field: 'from', issue: 'format' }]);
    assert.deepEqual((await usage('?to=2026-13-01')).body.error.details, [{ field: 'to', issue: 'format' }]);
    assert.deepEqual((await usage('?from=2026-02-30&to=2026-13-01')).body.error.details, [{ field: 'to', issue: 'format' }, { field: 'from', issue: 'format' }]);
    assert.deepEqual((await usage('?from=abcdefghij')).body.error.details, [{ field: 'from', issue: 'pattern' }]);
    assert.equal((await usage('?other=1')).status, 422);
    const onlyTo = await usage('?to=2026-03-10');
    assert.deepEqual([onlyTo.body.data.from, onlyTo.body.data.to, onlyTo.body.data.totals.calls], ['2026-02-09', '2026-03-10', 4]);
    const onlyFrom = await usage('?from=2020-01-01');
    assert.equal(onlyFrom.status, 422);
  });

  it('is for the PSA and the dealer of the group, a 404 for a key of another group or an unknown one', async () => {
    const { id } = (await call(psa(), 'POST', world.keysPath(0), body())).body.data as { id: string };
    assert.deepEqual(failure(await call(g().sa, 'GET', world.keysPath(0, `/${id}/usage`))), denied);
    assert.deepEqual(failure(await call(psa(), 'GET', world.keysPath(1, `/${id}/usage`))), notFound);
    assert.deepEqual(failure(await call(psa(), 'GET', world.keysPath(0, `/${hex(new ObjectId())}/usage`))), notFound);
    assert.deepEqual(failure(await call(world.office.cluster.dealerB, 'GET', world.keysPath(0, `/${id}/usage`))), notFound);
  });
});
