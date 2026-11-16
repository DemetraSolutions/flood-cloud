import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { startStoreWorld } from '../helpers/store-keys.ts';
import type { StoreWorld } from '../helpers/store-keys.ts';

let ctx: TestDatabases;
let world: StoreWorld;
const call = (...args: Parameters<StoreWorld['as']['call']>) => world.as.call(...args);
const failure = (reply: Awaited<ReturnType<typeof call>>) => world.as.failure(reply);
const hex = (id: ObjectId) => id.toHexString();
const sa = () => world.group(0).sa;
const base = () => `/groups/${hex(world.group(0).groupId)}/email-templates`;
const store = () => ctx.databases.group(world.group(0).groupId, 'cluster0').collection('email_templates');
const VERSION = `"${'a'.repeat(43)}"`;

before(async () => {
  ctx = await openTestDatabases();
  // A low per-user limit: this file is the one that exercises the 429 of the routes.
  world = await startStoreWorld(ctx, { env: { RATE_LIMIT_API_PER_USER: '40' } });
  await ctx.databases.common().collection('groups').updateOne({ _id: world.group(0).groupId }, { $set: { 'settings.email': true } });
});
after(async () => {
  await world.office.close();
  await ctx.cleanup();
});

describe('e-mail templates: rejections of security', () => {
  it('refuses a store key on every route, reading and writing, even with the feature on', async () => {
    const key = await world.activate(world.group(0).ownPlaceId);
    const id = hex(new ObjectId());
    for (const [method, path, body, headers] of [
      ['GET', base(), undefined, undefined],
      ['GET', `${base()}/${id}`, undefined, undefined],
      ['POST', base(), { name: 'x' }, { 'idempotency-key': crypto.randomUUID() }],
      ['PATCH', `${base()}/${id}`, { name: 'x' }, { 'if-match': VERSION }],
      ['DELETE', `${base()}/${id}`, undefined, undefined],
    ] as const) {
      const reply = await world.asStore(key.key, method, path, body, headers ? { ...headers } : undefined);
      assert.deepEqual([reply.status, reply.body.error.code], [403, 'FORBIDDEN'], `${method} ${path}`);
    }
    assert.equal(await store().countDocuments({}), 0);
  });

  it('refuses MongoDB operators and operator keys in the body, and in the path, without writing anything', async () => {
    const bodies: Array<[unknown, string, string]> = [
      [{ name: { $gt: '' } }, 'name', 'type'],
      [{ name: 'x', html: { $where: 'sleep(1000)' } }, 'html', 'type'],
      [{ name: 'x', text: { $ne: null } }, 'text', 'type'],
      [{ $set: { name: 'x' }, name: 'x' }, '$set', 'forbiddenKey'],
      [{ name: 'x', 'a.b': 1 }, 'a.b', 'forbiddenKey'],
    ];
    const created = await call(sa(), 'POST', base(), { name: 'Bersaglio', html: '<p>h</p>' });
    const id = created.body.data.id as string;
    for (const [body, field, issue] of bodies) {
      const reply = await call(sa(), 'POST', base(), JSON.parse(JSON.stringify(body)) as object);
      assert.equal(reply.status, 422, JSON.stringify(body));
      assert.equal(failure(reply).code, 'VALIDATION_ERROR');
      assert.ok(Array.isArray(failure(reply).details) && (failure(reply).details as unknown[]).length > 0, `${field} ${issue}`);
      const patch = await call(sa(), 'PATCH', `${base()}/${id}`, JSON.parse(JSON.stringify(body)) as object, { 'if-match': created.headers.get('etag')! });
      assert.equal(patch.status, 422, JSON.stringify(body));
    }
    const raw = await world.office.call('PATCH', `${base()}/${id}`, await world.as.tokenOf(sa()), undefined, { 'content-type': 'application/json', 'if-match': created.headers.get('etag')! });
    assert.equal(raw.status, 422);
    const proto = await fetch(`${world.office.app.baseUrl}/v1${base()}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await world.as.tokenOf(sa())}`, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: '{"name":"x","__proto__":{"admin":true},"constructor":{"prototype":{}}}',
    });
    assert.equal(proto.status, 422);
    for (const bad of ['%24ne', '%7B%24ne%3A1%7D', '%00', 'a'.repeat(24), `${hex(new ObjectId())}x`]) {
      for (const method of ['GET', 'DELETE'] as const) {
        const reply = await call(sa(), method, `${base()}/${bad}`);
        assert.ok([404, 422].includes(reply.status), `${method} ${bad}: ${String(reply.status)}`);
      }
    }
    assert.equal(await store().countDocuments({}), 1);
    const stored = (await store().findOne({ _id: new ObjectId(id) }))!;
    assert.deepEqual([stored['name'], stored['html']], ['Bersaglio', '<p>h</p>']);
    const query = await call(sa(), 'GET', `${base()}?q[$ne]=x&sort[$gt]=1`);
    assert.equal(query.status, 422);
    assert.equal((await call(sa(), 'GET', `${base()}?$where=1`)).status, 422);
  });

  it('answers 429 with Retry-After once the per-user limit of the API is exceeded, on the routes of the family', async () => {
    const actor = world.group(0).ca;
    let last = 0;
    let reply = await call(actor, 'GET', base());
    for (let i = 0; i < 60 && reply.status !== 429; i += 1) {
      reply = await call(actor, 'GET', base());
      last = i;
    }
    assert.equal(reply.status, 429, String(last));
    assert.equal(failure(reply).code, 'RATE_LIMITED');
    assert.ok(reply.headers.get('retry-after') !== null);
    assert.equal((await call(actor, 'POST', base(), { name: 'x' })).status, 429);
    assert.equal((await call(actor, 'DELETE', `${base()}/${hex(new ObjectId())}`)).status, 429);
    // Another user is not affected.
    assert.equal((await call(sa(), 'GET', base())).status, 200);
  });
});
