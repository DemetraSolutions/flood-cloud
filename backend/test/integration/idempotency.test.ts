import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { ObjectId } from 'mongodb';
import { IDEMPOTENCY_IN_PROGRESS_MS, IDEMPOTENCY_TTL_MS, createIdempotencyStore, idempotent } from '../../src/shared/http/idempotency.ts';
import type { IdempotencyRequest } from '../../src/shared/http/idempotency.ts';
import { AppError } from '../../src/shared/http/errors.ts';
import { fixtureId } from '../helpers/legacy-fixtures.ts';
import { withHooks } from '../helpers/legacy-write.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { startPlacesWorld } from '../helpers/places.ts';
import type { PlacesWorld } from '../helpers/places.ts';

let ctx: TestDatabases;
let world: PlacesWorld;
const dealer = () => world.office.cluster.dealerA;
const psa = () => world.office.cluster.psa;
const body = (name: string) => ({ name, companyId: fixtureId('company', 1).toHexString(), address: { street: 's', postcode: 'p', city: 'c', province: 'MI', country: 'IT' } });
const send = (actor: ObjectId, method: string, path: string, payload: unknown, key?: string) =>
  world.as.call(actor, method, path, payload, key === undefined ? { 'x-none': '1' } : { 'idempotency-key': key });
const placesNamed = (name: string) => ctx.databases.common().collection('places').countDocuments({ name });
const keys = () => ctx.databases.common().collection('idempotencyKeys');

before(async () => {
  ctx = await openTestDatabases();
  world = await startPlacesWorld(ctx);
  await world.seedPlace(0, 100, 1);
});
after(async () => {
  await world.office.close();
  await ctx.cleanup();
});

describe('Idempotency-Key on the creations', () => {
  it('requires the header, as a UUID: 422 without it and with anything else', async () => {
    const missing = await world.office.call('POST', world.placePath(0), await world.as.tokenOf(dealer()), body('Idem none'));
    assert.deepEqual((await missing.json() as { error: { details: unknown } }).error.details, [{ field: 'Idempotency-Key', issue: 'required' }]);
    assert.equal(missing.status, 422);
    for (const key of ['abc', '1234', randomUUID().replaceAll('-', '')]) {
      const reply = await send(dealer(), 'POST', world.placePath(0), body('Idem none'), key);
      assert.deepEqual([reply.status, reply.body.error.details], [422, [{ field: 'Idempotency-Key', issue: 'format' }]], key);
    }
    assert.equal(await placesNamed('Idem none'), 0);
  });

  it('answers the same key and body with the same response and creates one place: status, body, Location and ETag', async () => {
    const key = randomUUID();
    const first = await send(dealer(), 'POST', world.placePath(0), body('Idem same'), key);
    const second = await send(dealer(), 'POST', world.placePath(0), body('Idem same'), key.toUpperCase());
    assert.deepEqual([first.status, second.status], [201, 201]);
    assert.deepEqual(second.body, first.body);
    assert.deepEqual([second.headers.get('location'), second.headers.get('etag')], [first.headers.get('location'), first.headers.get('etag')]);
    assert.equal(await placesNamed('Idem same'), 1);
    const [record] = await keys().find({ key }).toArray();
    assert.equal(record!['state'], 'done');
    assert.ok((record!['expiresAt'] as Date).getTime() - Date.now() > IDEMPOTENCY_TTL_MS - 60_000);
    assert.ok(!JSON.stringify(record).includes('fixture-integration-secret'));
  });

  it('answers 409 for the same key with another body, and creates nothing', async () => {
    const key = randomUUID();
    assert.equal((await send(dealer(), 'POST', world.placePath(0), body('Idem a'), key)).status, 201);
    const other = await send(dealer(), 'POST', world.placePath(0), body('Idem b'), key);
    assert.deepEqual([other.status, other.body.error.code, other.body.error.details], [409, 'CONFLICT', [{ field: 'Idempotency-Key', issue: 'reused' }]]);
    assert.equal(await placesNamed('Idem b'), 0);
  });

  it('scopes the keys per user and per route', async () => {
    const key = randomUUID();
    const mine = await send(dealer(), 'POST', world.placePath(0), body('Idem scope'), key);
    const theirs = await send(psa(), 'POST', world.placePath(0), body('Idem scope'), key);
    assert.notEqual(theirs.body.data.id, mine.body.data.id);
    const route = await send(dealer(), 'POST', world.placePath(0, `/${mine.body.data.id}/duplicate`), undefined, key);
    assert.equal(route.status, 201);
    assert.notEqual(route.body.data.id, mine.body.data.id);
  });

  it('replays a duplication, and releases the key of a request that failed so it can be sent again', async () => {
    const key = randomUUID();
    const path = world.placePath(0, `/${fixtureId('place', 100).toHexString()}/duplicate`);
    const first = await send(dealer(), 'POST', path, undefined, key);
    const second = await send(dealer(), 'POST', path, undefined, key);
    assert.deepEqual([first.status, second.status, second.body, second.headers.get('location')], [201, 201, first.body, first.headers.get('location')]);
    assert.equal(await ctx.databases.common().collection('places').countDocuments({ name: 'Bar Roma (Copy)' }), 1);
    const missing = world.placePath(0, `/${new ObjectId().toHexString()}/duplicate`);
    const failed = randomUUID();
    assert.equal((await send(dealer(), 'POST', missing, undefined, failed)).status, 404);
    assert.equal((await send(dealer(), 'POST', missing, undefined, failed)).status, 404);
    assert.equal(await keys().countDocuments({ key: failed }), 0);
  });

  it('makes the creation of a company idempotent as well', async () => {
    const key = randomUUID();
    const company = { name: 'Idem Co', vatNumber: '00743110157', address: { street: 's', postcode: 'p', city: 'c', province: 'MI', country: 'IT' } };
    const first = await send(world.group(0).sa, 'POST', world.path(0), company, key);
    const second = await send(world.group(0).sa, 'POST', world.path(0), company, key);
    assert.deepEqual([first.status, second.status, second.body], [201, 201, first.body]);
    assert.equal(await ctx.databases.common().collection('companies').countDocuments({ name: 'Idem Co' }), 1);
    assert.equal((await world.as.call(world.group(0).sa, 'POST', world.path(0), { ...company, vatNumber: '00905811006' }, { 'x-none': '1' })).status, 201);
    const bare = await world.office.call('POST', world.path(0), await world.as.tokenOf(world.group(0).sa), company);
    assert.equal(bare.status, 422);
  });

  it('lets one of two simultaneous requests with the same key create the place', async () => {
    const key = randomUUID();
    const replies = await Promise.all([1, 2, 3].map(() => send(dealer(), 'POST', world.placePath(0), body('Idem race'), key)));
    assert.equal(await placesNamed('Idem race'), 1);
    assert.ok(replies.some((reply) => reply.status === 201));
    assert.ok(replies.every((reply) => reply.status === 201 || reply.status === 409));
  });
});

describe('the record of the idempotency keys', () => {
  const entry = (overrides: Partial<IdempotencyRequest> = {}): IdempotencyRequest => ({ principal: 'p', route: 'POST /x', key: randomUUID(), bodyHash: 'h', ...overrides });

  it('has a unique index on user, route and key and a TTL index', async () => {
    const indexes = await keys().indexes();
    const unique = indexes.find((index) => index.name === 'principal_1_route_1_key_1')!;
    assert.deepEqual([unique.unique, unique.key], [true, { principal: 1, route: 1, key: 1 }]);
    assert.equal(indexes.find((index) => index.name === 'expiresAt_1')!.expireAfterSeconds, 0);
  });

  it('says what a key stands for: new, busy while the first request runs, replay when it is done, mismatch for another body', async () => {
    const store = createIdempotencyStore(ctx.databases);
    const request = entry();
    const first = await store.begin(request);
    assert.equal(first.kind, 'new');
    assert.deepEqual(await store.begin(request), { kind: 'busy' });
    assert.deepEqual(await store.begin({ ...request, bodyHash: 'other' }), { kind: 'mismatch' });
    const response = { status: 201, body: { data: 1 }, location: '/a', etag: null };
    await store.complete((first as { id: ObjectId }).id, response);
    assert.deepEqual(await store.begin(request), { kind: 'replay', response });
    assert.deepEqual(await store.begin({ ...request, principal: 'q' }), { kind: 'new', id: (await keys().findOne({ principal: 'q', key: request.key }))!._id });
    await store.abandon((first as { id: ObjectId }).id);
    assert.equal((await store.begin(request)).kind, 'new');
  });

  it('frees a key whose time is over even before the index removes it, and a key that disappeared while it was looked up', async () => {
    let clock = Date.now();
    const store = createIdempotencyStore(ctx.databases, () => clock);
    const request = entry();
    await store.begin(request);
    clock += IDEMPOTENCY_IN_PROGRESS_MS + 1;
    assert.equal((await store.begin(request)).kind, 'new');
    const gone = entry();
    await store.begin(gone);
    let lost = false;
    const racing = createIdempotencyStore(withHooks(ctx.databases, { common: { idempotencyKeys: { findOne: async (call) => (lost ? call() : ((lost = true), (await keys().deleteMany({ key: gone.key })), null)) } } }));
    assert.equal((await racing.begin(gone)).kind, 'new');
  });

  it('lets an error that is not a duplicate key go', async () => {
    const broken = createIdempotencyStore(withHooks(ctx.databases, { common: { idempotencyKeys: { insertOne: async () => { throw new Error('boom'); } } } }));
    await assert.rejects(() => broken.begin(entry()), /boom/);
  });

  it('keeps nothing for a handler that answers with an error status or sends nothing, and keeps a replay without headers', async () => {
    const store = createIdempotencyStore(ctx.databases);
    const run = async (handler: (res: Response) => void, key: string) => {
      const sent: unknown[] = [];
      const res = {
        locals: { auth: { userId: fixtureId('user', 1) } },
        statusCode: 200,
        headers: {} as Record<string, string>,
        status(code: number) { this.statusCode = code; return this; },
        setHeader(name: string, value: string) { this.headers[name] = value; },
        getHeader(name: string) { return this.headers[name]; },
        json(payload: unknown) { sent.push(payload); return this; },
      };
      const req = { get: (name: string) => (name === 'idempotency-key' ? key : undefined), method: 'POST', baseUrl: '/v1', path: '/unit', body: { a: 1 } } as unknown as Request;
      await idempotent(store, (_req, response) => handler(response))(req, res as unknown as Response, () => undefined);
      return sent;
    };
    const failing = randomUUID();
    await run((res) => void res.status(400).json({ error: 1 }), failing);
    await run(() => undefined, failing);
    assert.equal(await keys().countDocuments({ key: failing }), 0);
    const ok = randomUUID();
    await run((res) => void res.status(201).json({ data: 1 }), ok);
    assert.deepEqual(await run(() => assert.fail('not run again'), ok), [{ data: 1 }]);
    await assert.rejects(() => run(() => { throw new AppError('NOT_FOUND'); }, randomUUID()), (error: unknown) => error instanceof AppError);
  });
});
