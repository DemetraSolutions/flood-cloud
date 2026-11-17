import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { AppError } from '../../src/shared/http/errors.ts';
import { createCountriesRepository } from '../../src/modules/countries/countries.repository.ts';
import { readCountryUsage } from '../../src/shared/security/scope/group-mirror.ts';
import { createCountriesService } from '../../src/modules/countries/countries.service.ts';
import { principalOf } from '../helpers/principal.ts';
import { withHooks } from '../helpers/legacy-write.ts';
import type { Hook } from '../helpers/legacy-write.ts';
import { memoryLogger } from '../helpers/app.ts';
import { MongoServerError } from 'mongodb';
import { startBackoffice } from '../helpers/backoffice.ts';
import { fixtureId, legacyCountry } from '../helpers/legacy-fixtures.ts';
import { insertCopies } from '../helpers/mirror.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { startStoreWorld } from '../helpers/store-keys.ts';
import type { StoreWorld } from '../helpers/store-keys.ts';
import { actors } from '../helpers/users.ts';
import { ACTION_CATALOG } from '../../src/shared/activity-log/catalog.ts';
import type { ActivityEntry } from '../../src/shared/activity-log/activity-log.ts';

let ctx: TestDatabases;
let world: StoreWorld;
const call = (...args: Parameters<StoreWorld['as']['call']>) => world.as.call(...args);
const failure = (reply: Awaited<ReturnType<typeof call>>) => world.as.failure(reply);
const psa = () => world.office.cluster.psa;
const countries = () => ctx.databases.common().collection('countries');
const stored = (code: string): Promise<Document | null> => countries().findOne({ code });
const strongTag = /^"[A-Za-z0-9_-]{43}"$/;
const IFMATCH = (etag: string) => ({ 'if-match': etag });
const events = (): ActivityEntry[] => world.office.activity.entries.filter((entry) => /^country/.test(entry.action));

/** The ETag of a country, as a client reads it. */
async function etagOf(code: string): Promise<string> {
  const reply = await call(psa(), 'GET', `/countries/${code}`);
  assert.equal(reply.status, 200);
  return reply.headers.get('etag')!;
}

/** The copies a test makes with `use`, as opposed to the ones of the seeded cluster (the store key tests need those). */
const USERS = { name: /^(companies|places)-\d+$/ };

/** The three countries every test starts from, in the shape of the legacy (with keys the backend does not know). */
async function resetCountries(): Promise<void> {
  await countries().deleteMany({});
  await countries().insertMany([
    legacyCountry(1, { code: 'IT', name: 'Italia', areas: [{ code: 'MI', name: 'Milano', extra: 1 }, { code: 'RM', name: 'Roma' }], note: 'kept' }),
    legacyCountry(2, { code: 'DE', name: 'Germania', areas: [] }),
    legacyCountry(3, { code: 'FR', name: 'Francia', areas: 'none' }),
  ]);
  const common = ctx.databases.common();
  await common.collection('companies').deleteMany(USERS);
  await common.collection('places').deleteMany(USERS);
  world.office.activity.entries.length = 0;
}

/** Companies and places in the copies, of the given country and province (`trash` as given), with ids `base`, `base + 1`…: nothing but what the usage read looks at. */
async function use(kind: 'companies' | 'places', base: number, count: number, countryCode: string, countryAreaCode: string, trash = false): Promise<ObjectId[]> {
  const documents = Array.from({ length: count }, (_value, index) => ({ _id: fixtureId(kind === 'companies' ? 'company' : 'place', base + index), groupId: world.group(index % 2).groupId, name: `${kind}-${String(base + index)}`, countryCode, countryAreaCode, trash }));
  await insertCopies(ctx.databases, kind, documents);
  return documents.map((document) => document._id);
}

before(async () => {
  ctx = await openTestDatabases();
  world = await startStoreWorld(ctx);
});
after(async () => {
  await world.office.close();
  await ctx.cleanup();
});
beforeEach(resetCountries);

describe('GET /v1/countries/{countryCode}', () => {
  it('gives one country with its areas and a strong ETag to every authenticated user, whatever the case of the code', async () => {
    for (const actor of [psa(), world.office.cluster.dealerA, world.group(0).sa, world.group(0).ca, world.group(0).pa]) {
      const reply = await call(actor, 'GET', '/countries/IT');
      assert.equal(reply.status, 200);
      assert.deepEqual(reply.body.data, { code: 'IT', name: 'Italia', areas: [{ code: 'MI', name: 'Milano' }, { code: 'RM', name: 'Roma' }] });
      assert.match(reply.headers.get('etag')!, strongTag);
    }
    assert.deepEqual((await call(psa(), 'GET', '/countries/it')).body.data.code, 'IT');
    assert.deepEqual((await call(psa(), 'GET', '/countries/FR')).body.data, { code: 'FR', name: 'Francia', areas: [] });
  });

  it('answers 404 to a country that does not exist, 422 to a code that is not two letters and 401 without a login', async () => {
    assert.deepEqual(failure(await call(psa(), 'GET', '/countries/ZZ')), { status: 404, code: 'NOT_FOUND', details: undefined });
    for (const code of ['I', 'ITA', '1A', 'I%20']) {
      const reply = await call(psa(), 'GET', `/countries/${code}`);
      assert.deepEqual([reply.status, reply.body.error.details[0].field], [422, 'countryCode'], code);
    }
    assert.equal((await world.office.call('GET', '/countries/IT', undefined)).status, 401);
  });

  it('changes version when the legacy changes an owned field, and keeps it when it changes a date or a key it owns nothing of', async () => {
    const first = await etagOf('IT');
    await countries().updateOne({ code: 'IT' }, { $set: { updateDate: new Date(), note: 'other' } });
    assert.equal(await etagOf('IT'), first);
    await countries().updateOne({ code: 'IT' }, { $set: { 'areas.1.name': 'Roma Capitale' } });
    const second = await etagOf('IT');
    assert.notEqual(second, first);
    await countries().updateOne({ code: 'IT' }, { $set: { name: 'Italia!' } });
    assert.notEqual(await etagOf('IT'), second);
  });

  it('leaves GET /v1/countries as it was: the same list for everybody, with a weak ETag that follows the writes', async () => {
    const before = await call(psa(), 'GET', '/countries');
    assert.deepEqual(before.body.data.map((country: { code: string }) => country.code), ['FR', 'DE', 'IT']);
    assert.match(before.headers.get('etag')!, /^W\//);
    assert.deepEqual(before.body.page, { limit: 3, next: null });
    assert.equal((await call(world.group(0).sa, 'GET', '/countries')).status, 200);
    assert.equal((await call(psa(), 'POST', '/countries', { code: 'XX', name: 'Atlantide' })).status, 201);
    const after = await call(psa(), 'GET', '/countries');
    assert.deepEqual(after.body.data.map((country: { code: string }) => country.code), ['XX', 'FR', 'DE', 'IT']);
    assert.notEqual(after.headers.get('etag'), before.headers.get('etag'));
  });
});

describe('who may write', () => {
  it('refuses every write to a dealer, a group administrator, a company administrator and a place administrator, and changes nothing', async () => {
    const etag = await etagOf('IT');
    const writes: Array<[string, string, unknown?, Record<string, string>?]> = [
      ['POST', '/countries', { code: 'XX', name: 'Atlantide' }],
      ['PATCH', '/countries/IT', { name: 'Altro' }, IFMATCH(etag)],
      ['DELETE', '/countries/DE', undefined, IFMATCH(await etagOf('DE'))],
      ['POST', '/countries/IT/areas', { code: 'TO', name: 'Torino' }, IFMATCH(etag)],
      ['PATCH', '/countries/IT/areas/MI', { name: 'Altro' }, IFMATCH(etag)],
      ['DELETE', '/countries/IT/areas/MI', undefined, IFMATCH(etag)],
    ];
    const snapshot = JSON.stringify(await countries().find({}).sort({ code: 1 }).toArray());
    for (const actor of [world.office.cluster.dealerA, world.group(0).sa, world.group(0).ca, world.group(0).pa]) {
      for (const [method, path, body, headers] of writes) {
        assert.deepEqual(failure(await call(actor, method, path, body, headers)), { status: 403, code: 'FORBIDDEN', details: undefined }, `${method} ${path}`);
      }
    }
    assert.equal(JSON.stringify(await countries().find({}).sort({ code: 1 }).toArray()), snapshot);
    assert.deepEqual(events(), []);
  });

  it('refuses every write to the server of a point of sale with its key, and every call without a login', async () => {
    const key = await world.activate(world.group(0).ownPlaceId);
    const etag = await etagOf('IT');
    for (const [method, path, body, headers] of [
      ['GET', '/countries/IT'],
      ['POST', '/countries', { code: 'XX', name: 'Atlantide' }],
      ['PATCH', '/countries/IT', { name: 'Altro' }, IFMATCH(etag)],
      ['DELETE', '/countries/DE', undefined, IFMATCH(etag)],
      ['POST', '/countries/IT/areas', { code: 'TO', name: 'Torino' }, IFMATCH(etag)],
      ['PATCH', '/countries/IT/areas/MI', { name: 'Altro' }, IFMATCH(etag)],
      ['DELETE', '/countries/IT/areas/MI', undefined, IFMATCH(etag)],
    ] as Array<[string, string, unknown?, Record<string, string>?]>) {
      const reply = await world.asStore(key.key, method, path, body, headers);
      assert.equal(reply.status, 403, `${method} ${path}`);
      assert.equal((await world.office.call(method, path, undefined, body, headers)).status, 401, `${method} ${path}`);
    }
    assert.equal(await countries().countDocuments({ code: 'XX' }), 0);
  });

  it('has no write on the public surface', async () => {
    for (const method of ['POST', 'PATCH', 'DELETE']) {
      const reply = await fetch(`${world.office.app.baseUrl}/public/v1/countries/IT`, { method, headers: { 'x-api-key': 'fc_pk_unknown' } });
      assert.ok([401, 404].includes(reply.status), String(reply.status));
    }
  });
});

describe('POST /v1/countries', () => {
  it('creates a country in the shape of the legacy, with the code made uppercase and the name trimmed, and gives its Location and ETag', async () => {
    const reply = await call(psa(), 'POST', '/countries', { code: ' xx ', name: '  Atlantide  ' });
    assert.equal(reply.status, 201);
    assert.deepEqual(reply.body.data, { code: 'XX', name: 'Atlantide', areas: [] });
    assert.ok(reply.headers.get('location')!.endsWith('/v1/countries/XX'));
    assert.match(reply.headers.get('etag')!, strongTag);
    assert.equal(reply.headers.get('etag'), await etagOf('XX'));
    const document = (await stored('XX'))!;
    assert.deepEqual(Object.keys(document), ['_id', 'code', 'name', 'areas', 'insertDate', 'updateDate']);
    assert.ok(document['_id'] instanceof ObjectId);
    assert.deepEqual([document['code'], document['name'], document['areas']], ['XX', 'Atlantide', []]);
    assert.ok(document['insertDate'] instanceof Date && Math.abs(document['insertDate'].getTime() - Date.now()) < 60_000);
    assert.strictEqual(document['updateDate'], null);
    const [entry] = events();
    assert.deepEqual([events().length, entry!.action, entry!.category, entry!.outcome, entry!.resource, entry!.metadata, entry!.actor.id?.toHexString(), entry!.groupId], [1, 'country.created', 'data', 'success', { type: 'country', id: 'XX' }, { countryCode: 'XX' }, psa().toHexString(), undefined]);
    assert.deepEqual(entry!.changes?.map((change) => change.field).sort(), ['code', 'name']);
  });

  it('refuses a code that exists, in any case, with a 409 that names the field, and creates nothing', async () => {
    for (const code of ['IT', 'it', ' It ']) {
      assert.deepEqual(failure(await call(psa(), 'POST', '/countries', { code, name: 'Doppio' })), { status: 409, code: 'CONFLICT', details: [{ field: 'code', issue: 'taken' }] });
    }
    assert.equal(await countries().countDocuments({ code: 'IT' }), 1);
    assert.deepEqual(events(), []);
  });

  it('refuses every body that is not a code of two letters and a name of 1 to 100 characters without control characters', async () => {
    const bad: Array<[unknown, Array<[string, string]>]> = [
      [{ name: 'A' }, [['code', 'required']]],
      [{ code: 'XX' }, [['name', 'required']]],
      [{ code: 'X', name: 'A' }, [['code', 'minLength']]],
      [{ code: 'XXX', name: 'A' }, [['code', 'maxLength']]],
      [{ code: 'X1', name: 'A' }, [['code', 'pattern']]],
      [{ code: 'ßß', name: 'A' }, [['code', 'pattern']]],
      [{ code: 5, name: 'A' }, [['code', 'type']]],
      [{ code: 'XX', name: '' }, [['name', 'minLength']]],
      [{ code: 'XX', name: '   ' }, [['name', 'minLength']]],
      [{ code: 'XX', name: 'x'.repeat(101) }, [['name', 'maxLength']]],
      [{ code: 'XX', name: 'a\u0007b' }, [['name', 'format']]],
      [{ code: 'XX', name: 'a\nb' }, [['name', 'format']]],
      [{ code: 'XX', name: 'a\u0085b' }, [['name', 'format']]],
      [{ code: 'XX', name: 'a\u202Eb' }, [['name', 'format']]],
      [{ code: 'XX', name: 'a\u200Bb' }, [['name', 'format']]],
      [{ code: 'XX', name: 'a\uFEFFb' }, [['name', 'format']]],
      [{ code: 'XX', name: 'a\u2028b' }, [['name', 'format']]],
      [{ code: 'XX', name: 'a\u2029b' }, [['name', 'format']]],
      [{ code: 'XX', name: 7 }, [['name', 'type']]],
      [{ code: 'XX', name: 'A', areas: [] }, [['areas', 'unknown']]],
      [{ code: 'XX', name: 'A', $set: 1 }, [['$set'.replace('$set', '(key)'), 'forbiddenKey']]],
      [[], [['(body)', 'type']]],
    ];
    for (const [body, details] of bad) {
      const reply = await call(psa(), 'POST', '/countries', body);
      assert.equal(reply.status, 422, JSON.stringify(body));
      assert.deepEqual(reply.body.error.details.map((detail: { field: string; issue: string }) => [detail.field, detail.issue]), details, JSON.stringify(body));
    }
    assert.equal(await countries().countDocuments({ code: 'XX' }), 0);
    assert.equal((await call(psa(), 'POST', '/countries', { code: 'XX', name: 'x'.repeat(100) })).status, 201);
  });

  it('refuses a body over its limit', async () => {
    assert.equal((await call(psa(), 'POST', '/countries', { code: 'XX', name: 'x'.repeat(5000) })).status, 413);
  });

  it('removes its own document and answers 409 when a competitor created the same code at the same time', async () => {
    const databases = withHooks(ctx.databases, {
      common: { countries: { insertOne: async (run) => { const result = await run(); await countries().insertOne({ _id: new ObjectId(), code: 'QQ', name: 'Rivale', areas: [] }); return result; } } },
    });
    const repository = createCountriesRepository(databases, memoryLogger().logger);
    assert.equal(await repository.insert({ _id: new ObjectId(), code: 'QQ', name: 'Mio', areas: [], insertDate: new Date(), updateDate: null }), 'taken');
    assert.deepEqual((await countries().find({ code: 'QQ' }).toArray()).map((document) => document['name']), ['Rivale']);
  });
});

describe('PATCH /v1/countries/{countryCode}', () => {
  it('changes the name only, sets updateDate, keeps every other key and area, and gives the new ETag', async () => {
    const etag = await etagOf('IT');
    const reply = await call(psa(), 'PATCH', '/countries/IT', { name: '  Repubblica Italiana ' }, IFMATCH(etag));
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.body.data, { code: 'IT', name: 'Repubblica Italiana', areas: [{ code: 'MI', name: 'Milano' }, { code: 'RM', name: 'Roma' }] });
    assert.notEqual(reply.headers.get('etag'), etag);
    assert.equal(reply.headers.get('etag'), await etagOf('IT'));
    const document = (await stored('IT'))!;
    assert.deepEqual([document['code'], document['name'], document['note'], document['areas']], ['IT', 'Repubblica Italiana', 'kept', [{ code: 'MI', name: 'Milano', extra: 1 }, { code: 'RM', name: 'Roma' }]]);
    assert.ok(document['updateDate'] instanceof Date && document['updateDate'].getTime() > Date.now() - 60_000);
    const [entry] = events();
    assert.deepEqual([entry!.action, entry!.resource, entry!.metadata, entry!.changes?.map((change) => [change.field, change.before, change.after])], ['country.updated', { type: 'country', id: 'IT' }, { countryCode: 'IT' }, [['name', 'Italia', 'Repubblica Italiana']]]);
  });

  it('writes and records nothing for the name it already has', async () => {
    const etag = await etagOf('IT');
    const updateDate = (await stored('IT'))!['updateDate'];
    const reply = await call(psa(), 'PATCH', '/countries/IT', { name: 'Italia' }, IFMATCH(etag));
    assert.deepEqual([reply.status, reply.headers.get('etag')], [200, etag]);
    assert.deepEqual((await stored('IT'))!['updateDate'], updateDate);
    assert.deepEqual(events(), []);
  });

  it('answers 412 to a version that is no longer the current one, and does not write', async () => {
    const stale = await etagOf('IT');
    assert.equal((await call(psa(), 'PATCH', '/countries/IT', { name: 'Prima' }, IFMATCH(stale))).status, 200);
    assert.deepEqual(failure(await call(psa(), 'PATCH', '/countries/IT', { name: 'Seconda' }, IFMATCH(stale))), { status: 412, code: 'PRECONDITION_FAILED', details: undefined });
    assert.equal((await stored('IT'))!['name'], 'Prima');
    // A change of the legacy counts too.
    const read = await etagOf('IT');
    await countries().updateOne({ code: 'IT' }, { $set: { name: 'Legacy' } });
    assert.equal((await call(psa(), 'PATCH', '/countries/IT', { name: 'Terza' }, IFMATCH(read))).status, 412);
    assert.equal(events().length, 1);
  });

  it('asks for If-Match: a missing header and a header that is not a strong tag are refused with 422', async () => {
    assert.deepEqual(failure(await call(psa(), 'PATCH', '/countries/IT', { name: 'X' })), { status: 422, code: 'VALIDATION_ERROR', details: [{ field: 'If-Match', issue: 'required' }] });
    for (const header of ['*', 'W/"abc"', '"short"']) {
      assert.deepEqual(failure(await call(psa(), 'PATCH', '/countries/IT', { name: 'X' }, IFMATCH(header))), { status: 422, code: 'VALIDATION_ERROR', details: [{ field: 'If-Match', issue: 'format' }] }, header);
    }
  });

  it('never changes the code: a code in the body is refused with 422 whatever it holds, and so is any other key', async () => {
    const etag = await etagOf('IT');
    for (const [body, details] of [
      [{ name: 'X', code: 'XX' }, [['code', 'immutable']]],
      [{ name: 'X', code: 'IT' }, [['code', 'immutable']]],
      [{ name: 'X', code: 5 }, [['code', 'type']]],
      [{ name: 'X', areas: [] }, [['areas', 'unknown']]],
      [{}, [['name', 'required']]],
      [{ name: '' }, [['name', 'minLength']]],
    ] as Array<[unknown, Array<[string, string]>]>) {
      const reply = await call(psa(), 'PATCH', '/countries/IT', body, IFMATCH(etag));
      assert.equal(reply.status, 422, JSON.stringify(body));
      assert.deepEqual(reply.body.error.details.map((detail: { field: string; issue: string }) => [detail.field, detail.issue]), details, JSON.stringify(body));
    }
    assert.equal((await stored('IT'))!['name'], 'Italia');
  });

  it('answers 404 to a country that does not exist, and 422 to a bad code in the path', async () => {
    const etag = await etagOf('IT');
    assert.equal((await call(psa(), 'PATCH', '/countries/ZZ', { name: 'X' }, IFMATCH(etag))).status, 404);
    assert.equal((await call(psa(), 'PATCH', '/countries/ZZZ', { name: 'X' }, IFMATCH(etag))).status, 422);
  });
});

describe('DELETE /v1/countries/{countryCode}', () => {
  it('deletes a country that nobody uses, with 204 and no body, and records it', async () => {
    const reply = await call(psa(), 'DELETE', '/countries/DE', undefined, IFMATCH(await etagOf('DE')));
    assert.deepEqual([reply.status, reply.body], [204, undefined]);
    assert.equal(await stored('DE'), null);
    assert.equal(await countries().countDocuments({}), 2);
    const [entry] = events();
    assert.deepEqual([entry!.action, entry!.resource, entry!.metadata, entry!.changes?.map((change) => change.field).sort()], ['country.deleted', { type: 'country', id: 'DE' }, { countryCode: 'DE' }, ['code', 'name']]);
    assert.equal((await call(psa(), 'GET', '/countries/DE')).status, 404);
  });

  it('refuses with 409 inUse while a company or a place uses the country, trashed ones included, and lists at most 20 ids of each kind', async () => {
    await use('companies', 700, 1, 'DE', '', true);
    await use('places', 800, 1, 'DE', '');
    const reply = await call(psa(), 'DELETE', '/countries/DE', undefined, IFMATCH(await etagOf('DE')));
    assert.deepEqual(failure(reply), {
      status: 409,
      code: 'CONFLICT',
      details: [
        { field: `companies.${fixtureId('company', 700).toHexString()}`, issue: 'inUse' },
        { field: `places.${fixtureId('place', 800).toHexString()}`, issue: 'inUse' },
      ],
    });
    assert.ok(await stored('DE'));
    const many = await use('companies', 900, 25, 'DE', '');
    const capped = failure(await call(psa(), 'DELETE', '/countries/DE', undefined, IFMATCH(await etagOf('DE'))));
    const fields = (capped.details as Array<{ field: string }>).map((detail) => detail.field);
    assert.deepEqual([fields.filter((field) => field.startsWith('companies.')).length, fields.filter((field) => field.startsWith('places.')).length], [20, 1]);
    assert.equal(fields.includes(`companies.${many[24]!.toHexString()}`), false);
    assert.deepEqual(events(), []);
  });

  it('refuses for a place alone and for a company alone, and lets go when the users are of another country', async () => {
    await use('places', 800, 2, 'DE', 'XX');
    assert.equal((await call(psa(), 'DELETE', '/countries/DE', undefined, IFMATCH(await etagOf('DE')))).status, 409);
    await ctx.databases.common().collection('places').deleteMany(USERS);
    await use('companies', 700, 1, 'DE', 'XX');
    assert.equal((await call(psa(), 'DELETE', '/countries/DE', undefined, IFMATCH(await etagOf('DE')))).status, 409);
    await ctx.databases.common().collection('companies').deleteMany(USERS);
    await use('companies', 700, 1, 'FR', '');
    assert.equal((await call(psa(), 'DELETE', '/countries/DE', undefined, IFMATCH(await etagOf('DE')))).status, 204);
  });

  it('answers 412 to a stale version, 404 to a country that does not exist and 422 without If-Match', async () => {
    const stale = await etagOf('DE');
    await countries().updateOne({ code: 'DE' }, { $set: { name: 'Deutschland' } });
    assert.equal((await call(psa(), 'DELETE', '/countries/DE', undefined, IFMATCH(stale))).status, 412);
    assert.equal((await call(psa(), 'DELETE', '/countries/ZZ', undefined, IFMATCH(stale))).status, 404);
    assert.deepEqual(failure(await call(psa(), 'DELETE', '/countries/DE')), { status: 422, code: 'VALIDATION_ERROR', details: [{ field: 'If-Match', issue: 'required' }] });
    assert.ok(await stored('DE'));
  });
});

describe('the areas of a country', () => {
  it('adds an area with the version of the country: 201, the updated country, the Location of the area, a new ETag, and the other areas and keys untouched', async () => {
    const etag = await etagOf('IT');
    const reply = await call(psa(), 'POST', '/countries/IT/areas', { code: ' to', name: 'Torino' }, IFMATCH(etag));
    assert.equal(reply.status, 201);
    assert.deepEqual(reply.body.data.areas, [{ code: 'MI', name: 'Milano' }, { code: 'RM', name: 'Roma' }, { code: 'TO', name: 'Torino' }]);
    assert.ok(reply.headers.get('location')!.endsWith('/v1/countries/IT/areas/TO'));
    assert.notEqual(reply.headers.get('etag'), etag);
    assert.equal(reply.headers.get('etag'), await etagOf('IT'));
    const document = (await stored('IT'))!;
    assert.deepEqual(document['areas'], [{ code: 'MI', name: 'Milano', extra: 1 }, { code: 'RM', name: 'Roma' }, { code: 'TO', name: 'Torino' }]);
    assert.deepEqual([document['note'], document['name']], ['kept', 'Italia']);
    assert.ok(document['updateDate'] instanceof Date);
    const [entry] = events();
    assert.deepEqual([entry!.action, entry!.resource, entry!.metadata, entry!.changes?.map((change) => change.field).sort()], ['countryArea.created', { type: 'countryArea', id: 'IT-TO' }, { countryCode: 'IT', areaCode: 'TO' }, ['code', 'name']]);
  });

  it('gives a list to a country whose areas is not one (the legacy has them), and adds to an empty list', async () => {
    assert.equal((await call(psa(), 'POST', '/countries/FR/areas', { code: 'PA', name: 'Parigi' }, IFMATCH(await etagOf('FR')))).status, 201);
    assert.deepEqual((await stored('FR'))!['areas'], [{ code: 'PA', name: 'Parigi' }]);
    assert.equal((await call(psa(), 'POST', '/countries/DE/areas', { code: 'BE', name: 'Berlino' }, IFMATCH(await etagOf('DE')))).status, 201);
    assert.deepEqual((await stored('DE'))!['areas'], [{ code: 'BE', name: 'Berlino' }]);
    await countries().updateOne({ code: 'DE' }, { $unset: { areas: '' } });
    assert.equal((await call(psa(), 'POST', '/countries/DE/areas', { code: 'BW', name: 'Baden' }, IFMATCH(await etagOf('DE')))).status, 201);
    assert.deepEqual((await stored('DE'))!['areas'], [{ code: 'BW', name: 'Baden' }]);
  });

  it('refuses a code the country already has with a 409 that names the field, and a code, a name or a key that is not valid with 422', async () => {
    const etag = await etagOf('IT');
    for (const code of ['MI', 'mi']) {
      assert.deepEqual(failure(await call(psa(), 'POST', '/countries/IT/areas', { code, name: 'Doppio' }, IFMATCH(etag))), { status: 409, code: 'CONFLICT', details: [{ field: 'code', issue: 'taken' }] });
    }
    assert.equal((await call(psa(), 'POST', '/countries/DE/areas', { code: 'MI', name: 'Altro paese' }, IFMATCH(await etagOf('DE')))).status, 201);
    for (const body of [{ code: 'M', name: 'A' }, { code: 'MI1', name: 'A' }, { code: 'TO', name: '' }, { code: 'TO' }, { code: 'TO', name: 'A', extra: 1 }]) {
      assert.equal((await call(psa(), 'POST', '/countries/IT/areas', body, IFMATCH(etag))).status, 422, JSON.stringify(body));
    }
    assert.equal(((await stored('IT'))!['areas'] as unknown[]).length, 2);
  });

  it('answers 412 to a stale version, 404 to a country that does not exist and 422 without If-Match', async () => {
    const stale = await etagOf('IT');
    await countries().updateOne({ code: 'IT' }, { $set: { name: 'Altro' } });
    assert.equal((await call(psa(), 'POST', '/countries/IT/areas', { code: 'TO', name: 'Torino' }, IFMATCH(stale))).status, 412);
    assert.equal((await call(psa(), 'POST', '/countries/ZZ/areas', { code: 'TO', name: 'Torino' }, IFMATCH(stale))).status, 404);
    assert.equal((await call(psa(), 'POST', '/countries/IT/areas', { code: 'TO', name: 'Torino' })).status, 422);
    assert.equal(((await stored('IT'))!['areas'] as unknown[]).length, 2);
  });

  it('changes the name of an area only: the code, the other areas and the other keys of the area stay', async () => {
    const etag = await etagOf('IT');
    const reply = await call(psa(), 'PATCH', '/countries/IT/areas/mi', { name: ' Milano città ' }, IFMATCH(etag));
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.body.data.areas, [{ code: 'MI', name: 'Milano città' }, { code: 'RM', name: 'Roma' }]);
    assert.notEqual(reply.headers.get('etag'), etag);
    assert.deepEqual((await stored('IT'))!['areas'], [{ code: 'MI', name: 'Milano città', extra: 1 }, { code: 'RM', name: 'Roma' }]);
    const [entry] = events();
    assert.deepEqual([entry!.action, entry!.resource, entry!.metadata, entry!.changes?.map((change) => [change.field, change.before, change.after])], ['countryArea.updated', { type: 'countryArea', id: 'IT-MI' }, { countryCode: 'IT', areaCode: 'MI' }, [['name', 'Milano', 'Milano città']]]);
  });

  it('writes and records nothing for the name an area already has, refuses a code in the body, and answers 404, 412 and 422 where they belong', async () => {
    const etag = await etagOf('IT');
    const same = await call(psa(), 'PATCH', '/countries/IT/areas/RM', { name: 'Roma' }, IFMATCH(etag));
    assert.deepEqual([same.status, same.headers.get('etag'), events().length], [200, etag, 0]);
    const immutable = await call(psa(), 'PATCH', '/countries/IT/areas/RM', { name: 'X', code: 'XX' }, IFMATCH(etag));
    assert.deepEqual([immutable.status, immutable.body.error.details], [422, [{ field: 'code', issue: 'immutable' }]]);
    assert.equal((await call(psa(), 'PATCH', '/countries/IT/areas/ZZ', { name: 'X' }, IFMATCH(etag))).status, 404);
    assert.equal((await call(psa(), 'PATCH', '/countries/ZZ/areas/MI', { name: 'X' }, IFMATCH(etag))).status, 404);
    assert.equal((await call(psa(), 'PATCH', '/countries/IT/areas/MIL', { name: 'X' }, IFMATCH(etag))).status, 422);
    assert.equal((await call(psa(), 'PATCH', '/countries/IT/areas/RM', { name: 'X' })).status, 422);
    await countries().updateOne({ code: 'IT' }, { $set: { name: 'Altro' } });
    assert.equal((await call(psa(), 'PATCH', '/countries/IT/areas/RM', { name: 'X' }, IFMATCH(etag))).status, 412);
    assert.deepEqual(events(), []);
  });

  it('removes an area that nobody uses and gives the country back, with its new ETag', async () => {
    const etag = await etagOf('IT');
    const reply = await call(psa(), 'DELETE', '/countries/IT/areas/MI', undefined, IFMATCH(etag));
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.body.data, { code: 'IT', name: 'Italia', areas: [{ code: 'RM', name: 'Roma' }] });
    assert.notEqual(reply.headers.get('etag'), etag);
    assert.deepEqual((await stored('IT'))!['areas'], [{ code: 'RM', name: 'Roma' }]);
    const [entry] = events();
    assert.deepEqual([entry!.action, entry!.resource, entry!.metadata, entry!.changes?.map((change) => change.field).sort()], ['countryArea.deleted', { type: 'countryArea', id: 'IT-MI' }, { countryCode: 'IT', areaCode: 'MI' }, ['code', 'name']]);
  });

  it('refuses with 409 inUse while a company or a place has the country and the area (trashed ones included), and lets go of an area only others in the country use', async () => {
    await countries().updateOne({ code: 'DE' }, { $set: { areas: [{ code: 'BE', name: 'Berlino' }, { code: 'BW', name: 'Baden' }] } });
    await use('companies', 700, 1, 'DE', 'BE', true);
    await use('places', 800, 1, 'DE', 'BE');
    await use('companies', 710, 3, 'DE', 'BW');
    await use('companies', 720, 1, 'IT', 'BE');
    await ctx.databases.common().collection('companies').deleteMany({ countryAreaCode: 'BW' });
    const refused = failure(await call(psa(), 'DELETE', '/countries/DE/areas/BE', undefined, IFMATCH(await etagOf('DE'))));
    assert.deepEqual(refused, {
      status: 409,
      code: 'CONFLICT',
      details: [
        { field: `companies.${fixtureId('company', 700).toHexString()}`, issue: 'inUse' },
        { field: `places.${fixtureId('place', 800).toHexString()}`, issue: 'inUse' },
      ],
    });
    assert.equal(((await stored('DE'))!['areas'] as unknown[]).length, 2);
    // Companies of the same country in another province, or of another country with that province, do not matter.
    assert.equal((await call(psa(), 'DELETE', '/countries/DE/areas/BW', undefined, IFMATCH(await etagOf('DE')))).status, 200);
    assert.deepEqual(events().map((entry) => entry.action), ['countryArea.deleted']);
  });

  it('answers 404 to an area or a country that does not exist, 412 to a stale version and 422 without If-Match', async () => {
    const etag = await etagOf('IT');
    assert.equal((await call(psa(), 'DELETE', '/countries/IT/areas/ZZ', undefined, IFMATCH(etag))).status, 404);
    assert.equal((await call(psa(), 'DELETE', '/countries/ZZ/areas/MI', undefined, IFMATCH(etag))).status, 404);
    assert.equal((await call(psa(), 'DELETE', '/countries/IT/areas/MI')).status, 422);
    await countries().updateOne({ code: 'IT' }, { $set: { name: 'Altro' } });
    assert.equal((await call(psa(), 'DELETE', '/countries/IT/areas/MI', undefined, IFMATCH(etag))).status, 412);
    assert.equal(((await stored('IT'))!['areas'] as unknown[]).length, 2);
  });

  it('lets two requests with the same version that add the same code end with one 201 and one refusal, and no duplicate', async () => {
    const etag = await etagOf('DE');
    const replies = await Promise.all([
      call(psa(), 'POST', '/countries/DE/areas', { code: 'BE', name: 'Berlino' }, IFMATCH(etag)),
      call(psa(), 'POST', '/countries/DE/areas', { code: 'BE', name: 'Berlino due' }, IFMATCH(etag)),
    ]);
    assert.deepEqual(replies.map((reply) => reply.status).sort(), [201, replies.map((reply) => reply.status).includes(409) ? 409 : 412]);
    assert.equal(((await stored('DE'))!['areas'] as unknown[]).length, 1);
  });
});

describe('the writes of the countries in the activity log and under the rate limit', () => {
  it('records only metadata keys the catalog allows, for every action of the countries', async () => {
    const etag = await etagOf('DE');
    assert.equal((await call(psa(), 'POST', '/countries', { code: 'XX', name: 'Atlantide' })).status, 201);
    const added = await call(psa(), 'POST', '/countries/XX/areas', { code: 'AA', name: 'Alfa' }, IFMATCH(await etagOf('XX')));
    assert.equal((await call(psa(), 'PATCH', '/countries/XX/areas/AA', { name: 'Beta' }, IFMATCH(added.headers.get('etag')!))).status, 200);
    assert.equal((await call(psa(), 'PATCH', '/countries/XX', { name: 'Atlantide 2' }, IFMATCH(await etagOf('XX')))).status, 200);
    assert.equal((await call(psa(), 'DELETE', '/countries/XX/areas/AA', undefined, IFMATCH(await etagOf('XX')))).status, 200);
    assert.equal((await call(psa(), 'DELETE', '/countries/XX', undefined, IFMATCH(await etagOf('XX')))).status, 204);
    assert.equal((await call(psa(), 'DELETE', '/countries/DE', undefined, IFMATCH(etag))).status, 204);
    assert.deepEqual(events().map((entry) => entry.action), ['country.created', 'countryArea.created', 'countryArea.updated', 'country.updated', 'countryArea.deleted', 'country.deleted', 'country.deleted']);
    for (const entry of events()) {
      const definition = ACTION_CATALOG.get(entry.action)!;
      assert.deepEqual(definition.categories, ['data']);
      assert.ok(Object.keys(entry.metadata ?? {}).every((key) => definition.metadataKeys.includes(key)), entry.action);
    }
  });

  it('limits the writes of a user per minute, and not the reads', async () => {
    const other = await openTestDatabases();
    const limited = await startBackoffice(other, { env: { RATE_LIMIT_COUNTRIES_ADMIN_PER_USER: '3' } });
    try {
      const as = actors(limited);
      const statuses: number[] = [];
      for (const code of ['AA', 'BB', 'CC', 'DD']) {
        statuses.push((await as.call(limited.cluster.psa, 'POST', '/countries', { code, name: code })).status);
      }
      assert.deepEqual(statuses, [201, 201, 201, 429]);
      assert.equal((await as.call(limited.cluster.psa, 'GET', '/countries/AA')).status, 200);
    } finally {
      await limited.close();
      await other.cleanup();
    }
  });
});

describe('GET /v1/me and the permission countries:manage', () => {
  it('exposes the permission to the PSA only', async () => {
    for (const [actor, expected] of [[psa(), true], [world.office.cluster.dealerA, false], [world.group(0).sa, false], [world.group(0).ca, false], [world.group(0).pa, false]] as const) {
      const reply = await call(actor, 'GET', '/me');
      assert.equal((reply.body.data.permissions as string[]).includes('countries:manage'), expected);
    }
  });
});

describe('the writes under concurrency and under a competing delete (service over the real database)', () => {
  const key = Buffer.alloc(32, 7);
  const principal = principalOf('PSA');
  const client = { requestId: 'r1', ip: null, userAgent: null };

  const service = (hooks: Record<string, Hook> = {}) =>
    createCountriesService({ repository: createCountriesRepository(withHooks(ctx.databases, { common: { countries: hooks } }), memoryLogger().logger), activityLog: world.office.activity, versionKey: key, now: () => Date.now() });
  /** The version of a country, read without hooks. */
  const versionOf = async (code: string): Promise<string> => (await service().get(code)).version;
  /** A hook that lets a call run only once `parties` calls have arrived: every reader has read before any writer writes. */
  function barrier(parties: number): Hook {
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    return async (run) => {
      const result = await run();
      if (++arrived === parties) {
        release();
      }
      await gate;
      return result;
    };
  }
  const deleteFirst = (code: string): Hook => async (run) => {
    await countries().deleteMany({ code });
    return run();
  };

  it('keeps both areas when two requests with the same version add different codes: the list is pushed to, never rewritten', async () => {
    const racing = service({ findOne: barrier(2) });
    const expected = await versionOf('DE');
    const results = await Promise.allSettled([racing.addArea(principal, 'DE', expected, { code: 'BE', name: 'Berlino' }, client), racing.addArea(principal, 'DE', expected, { code: 'BW', name: 'Baden' }, client)]);
    assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'fulfilled']);
    assert.deepEqual(((await stored('DE'))!['areas'] as Array<{ code: string }>).map((area) => area.code).sort(), ['BE', 'BW']);
  });

  it('gives one success and one taken when two requests with the same version add the same code', async () => {
    const racing = service({ findOne: barrier(2) });
    const expected = await versionOf('DE');
    const results = await Promise.allSettled([racing.addArea(principal, 'DE', expected, { code: 'BE', name: 'Uno' }, client), racing.addArea(principal, 'DE', expected, { code: 'BE', name: 'Due' }, client)]);
    assert.deepEqual(results.map((result) => result.status).sort(), ['fulfilled', 'rejected']);
    const refused = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')!.reason as AppError;
    assert.deepEqual([refused.status, refused.details], [409, [{ field: 'code', issue: 'taken' }]]);
    assert.equal(((await stored('DE'))!['areas'] as unknown[]).length, 1);
  });

  it('answers 404 to every write whose country is deleted between the read and the write', async () => {
    const calls: Array<[string, (service: ReturnType<typeof createCountriesService>, expected: string) => Promise<unknown>, Record<string, Hook>, string?]> = [
      ['rename', (service, expected) => service.rename(principal, 'IT', expected, { name: 'Nuovo' }, client), { updateOne: deleteFirst('IT') }],
      ['remove', (service, expected) => service.remove(principal, 'DE', expected, client), { deleteOne: deleteFirst('DE') }, 'DE'],
      ['addArea', (service, expected) => service.addArea(principal, 'IT', expected, { code: 'TO', name: 'Torino' }, client), { updateOne: deleteFirst('IT') }],
      ['renameArea', (service, expected) => service.renameArea(principal, 'IT', 'MI', expected, { name: 'Nuovo' }, client), { updateOne: deleteFirst('IT') }],
      ['removeArea', (service, expected) => service.removeArea(principal, 'IT', 'MI', expected, client), { updateOne: deleteFirst('IT') }],
    ];
    for (const [name, run, hooks, code = 'IT'] of calls) {
      await resetCountries();
      const expected = await versionOf(code);
      await assert.rejects(run(service(hooks), expected), (error: unknown) => error instanceof AppError && error.status === 404, name);
    }
  });

  it('does not log a write that did not happen', async () => {
    await resetCountries();
    await assert.rejects(service({ updateOne: deleteFirst('IT') }).rename(principal, 'IT', await versionOf('IT'), { name: 'Nuovo' }, client));
    assert.deepEqual(events(), []);
  });

  it('gives one success and one 412 when two requests with the same version rename the same country, and the same area', async () => {
    const racing = service({ findOne: barrier(2) });
    const expected = await versionOf('DE');
    const renames = await Promise.allSettled([racing.rename(principal, 'DE', expected, { name: 'Uno' }, client), racing.rename(principal, 'DE', expected, { name: 'Due' }, client)]);
    assert.deepEqual(renames.map((result) => result.status).sort(), ['fulfilled', 'rejected']);
    assert.equal(((renames.find((result): result is PromiseRejectedResult => result.status === 'rejected')!).reason as AppError).status, 412);
    await resetCountries();
    const racingAreas = service({ findOne: barrier(2) });
    const areaVersion = await versionOf('IT');
    const areaRenames = await Promise.allSettled([racingAreas.renameArea(principal, 'IT', 'MI', areaVersion, { name: 'Uno' }, client), racingAreas.renameArea(principal, 'IT', 'MI', areaVersion, { name: 'Due' }, client)]);
    assert.deepEqual(areaRenames.map((result) => result.status).sort(), ['fulfilled', 'rejected']);
    assert.equal(((areaRenames.find((result): result is PromiseRejectedResult => result.status === 'rejected')!).reason as AppError).status, 412);
    await resetCountries();
    const racingRemoves = service({ findOne: barrier(2) });
    const removeVersion = await versionOf('IT');
    const removals = await Promise.allSettled([racingRemoves.removeArea(principal, 'IT', 'MI', removeVersion, client), racingRemoves.renameArea(principal, 'IT', 'MI', removeVersion, { name: 'Altro' }, client)]);
    assert.deepEqual(removals.map((result) => result.status).sort(), ['fulfilled', 'rejected']);
  });

  it('keeps a country when an area is added while it is being deleted (412), and does not log the deletion', async () => {
    const expected = await versionOf('DE');
    const addFirst: Hook = async (run) => {
      await countries().updateOne({ code: 'DE' }, { $set: { areas: [{ code: 'BE', name: 'Berlino' }] } });
      return run();
    };
    await assert.rejects(service({ deleteOne: addFirst }).remove(principal, 'DE', expected, client), (error: unknown) => error instanceof AppError && error.status === 412);
    assert.equal(((await stored('DE'))!['areas'] as unknown[]).length, 1);
    assert.deepEqual(events(), []);
  });

  it('refuses the deletion with 503, and deletes nothing, when the check of the use times out', async () => {
    const repository = createCountriesRepository(ctx.databases, memoryLogger().logger);
    const timedOut = createCountriesService({ repository: { ...repository, usageOf: () => Promise.reject(new AppError('SERVICE_UNAVAILABLE')) }, activityLog: world.office.activity, versionKey: key, now: () => Date.now() });
    await assert.rejects(timedOut.remove(principal, 'DE', await versionOf('DE'), client), (error: unknown) => error instanceof AppError && error.status === 503);
    await assert.rejects(timedOut.removeArea(principal, 'IT', 'MI', await versionOf('IT'), client), (error: unknown) => error instanceof AppError && error.status === 503);
    assert.ok(await stored('DE'));
    assert.deepEqual(events(), []);
  });

  it('turns an expired time limit of the use read into 503 and lets any other failure through', async () => {
    const failing = (error: Error) => ({ common: () => ({ collection: () => ({ find: () => ({ toArray: () => Promise.reject(error) }) }) }) }) as unknown as typeof ctx.databases;
    const expired = new MongoServerError({ message: 'operation exceeded time limit', code: 50, codeName: 'MaxTimeMSExpired' });
    await assert.rejects(readCountryUsage(failing(expired), 'IT', null, 20), (error: unknown) => error instanceof AppError && error.status === 503);
    await assert.rejects(readCountryUsage(failing(new Error('boom')), 'IT', null, 20), /boom/);
  });

  it('logs an error, and throws, when the removal of its own duplicate fails', async () => {
    const logs = memoryLogger();
    const repository = createCountriesRepository(
      withHooks(ctx.databases, {
        common: {
          countries: {
            insertOne: async (run) => {
              const result = await run();
              await countries().insertOne({ _id: new ObjectId(), code: 'QQ', name: 'Rivale', areas: [] });
              return result;
            },
            deleteOne: () => Promise.reject(new Error('delete failed')),
          },
        },
      }),
      logs.logger,
    );
    await assert.rejects(repository.insert({ _id: new ObjectId(), code: 'QQ', name: 'Mio', areas: [], insertDate: new Date(), updateDate: null }), /delete failed/);
    const entry = logs.events.find((event) => event['level'] === 'error')!;
    assert.match(String(entry['msg']), /compensating delete/);
    assert.equal(await countries().countDocuments({ code: 'QQ' }), 2);
  });
});

describe('legacy data with codes in lower case', () => {
  beforeEach(async () => {
    await countries().insertMany([
      legacyCountry(20, { code: 'xx', name: 'Minuscolo', areas: [{ code: 'aa', name: 'Alfa' }, { code: 'Bb', name: 'Beta' }] }),
      legacyCountry(21, { code: 'yy', name: 'Senza uso', areas: [] }),
    ]);
  });

  it('finds a country stored in lower case, and refuses to create the same code again in any case', async () => {
    const reply = await call(psa(), 'GET', '/countries/XX');
    assert.deepEqual(reply.body.data, { code: 'XX', name: 'Minuscolo', areas: [{ code: 'aa', name: 'Alfa' }, { code: 'Bb', name: 'Beta' }] });
    for (const code of ['XX', 'xx', 'xX']) {
      assert.equal((await call(psa(), 'POST', '/countries', { code, name: 'Doppio' })).status, 409, code);
    }
    assert.equal(await countries().countDocuments({ code: { $in: ['XX', 'xx', 'Xx', 'xX'] } }), 1);
    assert.equal((await call(psa(), 'POST', '/countries', { code: 'zz', name: 'Nuovo' })).status, 201);
    assert.ok(await countries().findOne({ code: 'ZZ' }), 'new codes are stored in upper case');
  });

  it('renames and deletes a country and its areas stored in lower case, and refuses an area that exists in another case', async () => {
    assert.equal((await call(psa(), 'PATCH', '/countries/XX', { name: 'Nuovo' }, IFMATCH(await etagOf('XX')))).status, 200);
    assert.equal((await stored('xx'))!['name'], 'Nuovo');
    assert.equal((await call(psa(), 'POST', '/countries/XX/areas', { code: 'AA', name: 'Doppia' }, IFMATCH(await etagOf('XX')))).status, 409);
    assert.equal((await call(psa(), 'POST', '/countries/XX/areas', { code: 'BB', name: 'Doppia' }, IFMATCH(await etagOf('XX')))).status, 409);
    const renamed = await call(psa(), 'PATCH', '/countries/XX/areas/AA', { name: 'Alfa 2' }, IFMATCH(await etagOf('XX')));
    assert.deepEqual([renamed.status, renamed.body.data.areas[0]], [200, { code: 'aa', name: 'Alfa 2' }]);
    assert.equal((await call(psa(), 'PATCH', '/countries/XX/areas/BB', { name: 'Beta 2' }, IFMATCH(await etagOf('XX')))).status, 200);
    assert.equal((await call(psa(), 'DELETE', '/countries/XX/areas/AA', undefined, IFMATCH(await etagOf('XX')))).status, 200);
    assert.deepEqual(((await stored('xx'))!['areas'] as Array<{ code: string }>).map((area) => area.code), ['Bb']);
    assert.equal((await call(psa(), 'DELETE', '/countries/YY', undefined, IFMATCH(await etagOf('YY')))).status, 204);
    assert.equal(await stored('yy'), null);
  });

  it('counts companies and places that hold the codes in lower case as users of the country and of the area', async () => {
    await use('companies', 700, 1, 'xx', 'aa');
    await use('places', 800, 1, 'xX', 'bB');
    const country = failure(await call(psa(), 'DELETE', '/countries/XX', undefined, IFMATCH(await etagOf('XX'))));
    assert.deepEqual([country.status, (country.details as unknown[]).length], [409, 2]);
    assert.equal(failure(await call(psa(), 'DELETE', '/countries/XX/areas/AA', undefined, IFMATCH(await etagOf('XX')))).status, 409);
    assert.equal(failure(await call(psa(), 'DELETE', '/countries/XX/areas/BB', undefined, IFMATCH(await etagOf('XX')))).status, 409);
    assert.equal(((await stored('xx'))!['areas'] as unknown[]).length, 2);
  });

  it('writes a country and an area that have no name in the document, guarding on the absence', async () => {
    await countries().insertOne({ _id: new ObjectId(), code: 'NN', areas: [{ code: 'AA' }, { code: 'BB' }] });
    assert.deepEqual((await call(psa(), 'GET', '/countries/NN')).body.data, { code: 'NN', name: 'NN', areas: [{ code: 'AA', name: 'AA' }, { code: 'BB', name: 'BB' }] });
    assert.equal((await call(psa(), 'PATCH', '/countries/NN', { name: 'Senza nome' }, IFMATCH(await etagOf('NN')))).status, 200);
    assert.equal((await call(psa(), 'PATCH', '/countries/NN/areas/AA', { name: 'Prima' }, IFMATCH(await etagOf('NN')))).status, 200);
    assert.equal((await call(psa(), 'DELETE', '/countries/NN/areas/BB', undefined, IFMATCH(await etagOf('NN')))).status, 200);
    await countries().updateOne({ code: 'NN' }, { $unset: { name: '' } });
    assert.equal((await call(psa(), 'DELETE', '/countries/NN', undefined, IFMATCH(await etagOf('NN')))).status, 204);
    assert.equal(await stored('NN'), null);
  });
});
