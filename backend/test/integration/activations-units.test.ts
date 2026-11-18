import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import type { Response } from 'express';
import { MongoServerError, ObjectId } from 'mongodb';
import type { ClientSession } from 'mongodb';
import type { Databases } from '../../src/db/databases.ts';
import { createActivationsController, csvFileName } from '../../src/modules/activations/activations.controller.ts';
import { createActivationsRepository } from '../../src/modules/activations/activations.repository.ts';
import type { ActivationsRepository } from '../../src/modules/activations/activations.repository.ts';
import { createActivationsService } from '../../src/modules/activations/activations.service.ts';
import type { ActivationsService, Statement } from '../../src/modules/activations/activations.service.ts';
import { minimalCompany, toNewDocument } from '../../src/modules/dealers/dealer.mapper.ts';
import { DEFAULT_LIMITS } from '../../src/modules/activations/activations.engine.ts';
import { DEFAULT_PRICE_LIST } from '../../src/modules/settings/price-list.ts';
import { createSettingsRepository } from '../../src/modules/settings/settings.repository.ts';
import { AppError } from '../../src/shared/http/errors.ts';
import { readMirrorActivationCompanies, readMirrorActivationPlaces } from '../../src/shared/security/scope/group-mirror.ts';
import { memoryActivityLog } from '../helpers/activity.ts';
import { fixtureId, legacyGroup } from '../helpers/legacy-fixtures.ts';
import { insertCopies } from '../helpers/mirror.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { principalOf } from '../helpers/principal.ts';

let ctx: TestDatabases;
const activity = memoryActivityLog();
const client = { requestId: 'req', ip: null, userAgent: null } as never;
const psa = principalOf('PSA');
const dealer = fixtureId('user', 77);
const group = fixtureId('group', 1);
const may = (day: number) => new Date(Date.UTC(2026, 4, day, 10));

before(async () => {
  ctx = await openTestDatabases();
});
after(async () => ctx.cleanup());
beforeEach(async () => {
  for (const name of ['billingClosures', 'groups', 'places', 'companies', 'dealers']) {
    await ctx.databases.common().collection(name).deleteMany({});
  }
  await ctx.databases.common().collection('groups').insertOne(legacyGroup(1, { dealerId: dealer }));
  const company = { _id: fixtureId('company', 1), groupId: group, name: 'C', trash: false };
  await insertCopies(ctx.databases, 'companies', [company]);
  await insertCopies(ctx.databases, 'places', [1, 2, 3, 4].map((n) => ({ _id: fixtureId('place', n), groupId: group, companyId: company._id, name: `P${String(n)}`, plan: 'basic', insertDate: n <= 2 ? may(n + 1) : new Date(Date.UTC(2025, 5, n)), trash: false })));
  await ctx.databases.common().collection('dealers').insertOne(toNewDocument(dealer, minimalCompany('Rivenditore'), 'manual', null, new Date()));
  activity.entries.length = 0;
});

const build = (overrides: Partial<ActivationsRepository> = {}, limits = DEFAULT_LIMITS): ActivationsService =>
  createActivationsService({ repository: { ...createActivationsRepository(ctx.databases), ...overrides }, priceLists: { getPriceList: async () => ({ list: DEFAULT_PRICE_LIST, version: 'v' }) }, activityLog: activity, now: () => Date.UTC(2026, 10, 18), limits });
const conflict = (issue: string) => (error: unknown) => error instanceof AppError && error.code === 'CONFLICT' && error.details?.[0]?.issue === issue;

describe('the limits of a computation', () => {
  it('reads the places in batches, and refuses a window with more places than the limit', async () => {
    const batched = build({}, { ...DEFAULT_LIMITS, batch: 1 });
    const statement = await batched.statement(principalOf('PSA'), dealer, { month: '2026-06', section: 'activations' });
    assert.equal(statement.lines.length, 2);
    await assert.rejects(build({}, { ...DEFAULT_LIMITS, maxPlaces: 1 }).statement(psa, dealer, { month: '2026-06', section: 'activations' }), /more than 1 places/);
  });

  it('answers 409 tooManyLines when a dealer has more lines than a statement or a closure holds, whatever the way in', async () => {
    const small = build({}, { ...DEFAULT_LIMITS, maxLines: 1 });
    await assert.rejects(small.statement(psa, dealer, { month: '2026-06', section: 'activations' }), conflict('tooManyLines'));
    await assert.rejects(small.statement(psa, dealer, { month: '2026-06', section: 'renewals' }), conflict('tooManyLines'));
    await assert.rejects(small.freezeBase(psa, { year: 2026 }, client), conflict('tooManyLines'));
    await build().freezeBase(psa, { year: 2026 }, client);
    await assert.rejects(small.closeMonth(psa, { month: '2026-06' }, client), conflict('tooManyLines'));
    const summary = await small.summary(psa, { month: '2026-06' });
    assert.equal(summary.rows[0]!.activations.places, 2, 'a summary needs no lines');
  });

  it('reads nothing when the dealer has no group', async () => {
    const none = await build().summary(principalOf('D', { userId: fixtureId('user', 1234) }), { month: '2026-06' });
    assert.deepEqual([none.rows.length, none.rows[0]!.activations.places], [1, 0]);
  });
});

describe('the closures when something happens meanwhile', () => {
  const real = createActivationsRepository;
  it('answers 409 when the base is frozen, or the month closed, by somebody else between the check and the write', async () => {
    const repository = real(ctx.databases);
    await assert.rejects(build({ hasClosure: (kind, period, session) => (session === undefined ? repository.hasClosure(kind, period) : Promise.resolve(true)) }).freezeBase(psa, { year: 2026 }, client), conflict('alreadyFrozen'));
    await assert.rejects(build({ insertClosures: async () => false }).freezeBase(psa, { year: 2026 }, client), conflict('alreadyFrozen'));
    await assert.rejects(build({ lockYear: async () => false }).freezeBase(psa, { year: 2026 }, client), conflict('alreadyFrozen'));
    assert.equal(await ctx.databases.common().collection('billingClosures').countDocuments({}), 0);
    await build().freezeBase(psa, { year: 2026 }, client);
    await assert.rejects(build({ hasClosure: (kind, period, session) => (session === undefined ? repository.hasClosure(kind, period) : Promise.resolve(true)) }).closeMonth(psa, { month: '2026-06' }, client), conflict('alreadyClosed'));
    await assert.rejects(build({ insertClosures: async () => false }).closeMonth(psa, { month: '2026-06' }, client), conflict('alreadyClosed'));
    await assert.rejects(build({ readClosures: (query, lines, max, session) => (session === undefined ? repository.readClosures(query, lines, max) : Promise.resolve([])) }).closeMonth(psa, { month: '2026-06' }, client), conflict('baseNotFrozen'));
    await assert.rejects(build({ hasClosedMonthIn: async () => true }).unfreezeBase(psa, { year: 2026 }, client), conflict('monthClosed'));
    await assert.rejects(build({ lockYear: async () => false }).unfreezeBase(psa, { year: 2026 }, client), conflict('notFrozen'));
    await assert.rejects(build({ lockYear: async () => false }).reopenMonth(psa, { month: '2026-06' }, client), conflict('notClosed'));
    await assert.rejects(build({ lockYear: async () => false }).closeMonth(psa, { month: '2026-06' }, client), conflict('alreadyClosed'));
  });
});

describe('the repository', () => {
  const expired = new MongoServerError({ message: 'operation exceeded time limit', code: 50, codeName: 'MaxTimeMSExpired' });
  const failing = (error: Error): Databases => {
    const reject = () => Promise.reject(error);
    const cursor = { toArray: reject, [Symbol.asyncIterator]: () => ({ next: reject }) };
    return { common: () => ({ collection: () => ({ find: () => cursor, countDocuments: reject, insertMany: reject }) }) } as unknown as Databases;
  };
  const aborted = {} as ClientSession;

  it('answers 503 when a read exceeds its time limit, and lets any other failure through', async () => {
    const repository = createActivationsRepository(failing(expired));
    for (const read of [() => repository.readGroups({ kind: 'all' }, 5), () => repository.readDealers([dealer]), () => repository.readClosures({ kind: 'month', period: '2026-06' }, false, 5), () => repository.hasClosure('month', '2026-06'), () => repository.hasClosedMonthIn(2026), () => repository.readPlaces({ from: null, to: new Date() }, null, null, 5)]) {
      await assert.rejects(read(), (error: unknown) => error instanceof AppError && error.code === 'SERVICE_UNAVAILABLE');
    }
    const other = createActivationsRepository(failing(new Error('network')));
    await assert.rejects(other.hasClosure('month', '2026-06'), /network/);
    await assert.rejects(other.insertClosures([], aborted), /network/);
    const duplicate = createActivationsRepository(failing(Object.assign(new Error('dup'), { code: 11000 })));
    assert.equal(await duplicate.insertClosures([], aborted), false);
  });

  it('fails closed on more groups or closure documents than the limit, rather than truncating', async () => {
    const repository = createActivationsRepository(ctx.databases);
    await ctx.databases.common().collection('groups').insertOne(legacyGroup(2, { dealerId: dealer }));
    await assert.rejects(repository.readGroups({ kind: 'dealer', id: dealer }, 1), /more than 1 groups/);
    assert.equal((await repository.readGroups({ kind: 'dealer', id: dealer }, 2)).length, 2);
    await build().freezeBase(psa, { year: 2026 }, client);
    await build().closeMonth(psa, { month: '2026-06' }, client).catch(() => undefined);
    await ctx.databases.common().collection('billingClosures').updateOne({}, { $set: { dealerId: null } });
    await assert.rejects(repository.readClosures({ kind: 'renewalBase', period: '2026' }, false, 0), /more than 0 closure documents/);
  });

  it('reads the groups of the dealers by their kind, with no credential projected', async () => {
    const repository = createActivationsRepository(ctx.databases);
    await ctx.databases.common().collection('groups').insertOne(legacyGroup(3, { dealerId: 'not an id' }));
    const none = await repository.readGroups({ kind: 'none' }, 10);
    assert.deepEqual(none.map((found) => found.dealerId), [null]);
    const [mine] = await repository.readGroups({ kind: 'dealer', id: dealer }, 10);
    assert.deepEqual(Object.keys(mine!).sort(), ['dealerId', 'id', 'name', 'suspended', 'switches']);
    assert.deepEqual(mine!.switches, { tobaccos: false, statManager: false });
    await ctx.databases.common().collection('groups').updateOne({ _id: fixtureId('group', 1) }, { $set: { settings: null } });
    assert.deepEqual((await repository.readGroups({ kind: 'dealer', id: dealer }, 10))[0]!.switches, { tobaccos: false, statManager: false });
    await ctx.databases.common().collection('groups').updateOne({ _id: fixtureId('group', 1) }, { $set: { settings: { tobaccosGamesMonopoly: true, integrations: { statmanager: { status: true } } } } });
    assert.deepEqual((await repository.readGroups({ kind: 'dealer', id: dealer }, 10))[0]!.switches, { tobaccos: true, statManager: true });
  });

  it('reads dealers in chunks and tolerates damaged overrides', async () => {
    const repository = createActivationsRepository(ctx.databases);
    await ctx.databases.common().collection('dealers').updateOne({ _id: dealer }, { $set: { businessName: 'Ragione\nSociale' } });
    await ctx.databases.common().collection('dealers').updateOne({ _id: dealer }, { $set: { priceOverrides: { plans: { basic: 1 }, services: 'x' } } }, { bypassDocumentValidation: true });
    const found = await repository.readDealers([dealer, fixtureId('user', 5)]);
    assert.deepEqual([...found], [[dealer.toHexString(), { name: 'Ragione Sociale', overrides: { plans: { basic: 1 } } }]]);
    assert.equal((await repository.readDealers([])).size, 0);
  });

  it('refuses a read of the places it cannot make safely', async () => {
    const window = { from: null, to: new Date() };
    const read = (...args: Parameters<typeof readMirrorActivationPlaces> extends [unknown, ...infer R] ? R : never) => readMirrorActivationPlaces(ctx.databases, ...args);
    await assert.rejects(read({ from: null, to: new Date('x') }, null, null, 5), /window/);
    await assert.rejects(read({ from: new Date('x'), to: new Date() }, null, null, 5), /window/);
    await assert.rejects(read({ from: 'x' as never, to: new Date() }, null, null, 5), /window/);
    await assert.rejects(read(window, [], null, 5), /group ids/);
    await assert.rejects(read(window, ['x' as never], null, 5), /group ids/);
    await assert.rejects(read(window, null, 'x' as never, 5), /position/);
    for (const limit of [0, 1.5, 1001]) {
      await assert.rejects(read(window, null, null, limit), /limit/);
    }
    assert.equal((await read(window, [group], null, 2)).length, 2);
    assert.equal((await read(window, [group], fixtureId('place', 2), 2)).length, 2);
    await assert.rejects(readMirrorActivationCompanies(ctx.databases, []), /company ids/);
    await assert.rejects(readMirrorActivationCompanies(ctx.databases, ['x' as never]), /company ids/);
    await assert.rejects(readMirrorActivationCompanies(ctx.databases, Array.from({ length: 1001 }, () => new ObjectId())), /company ids/);
    assert.deepEqual((await readMirrorActivationCompanies(ctx.databases, [fixtureId('company', 1)])).map((company) => Object.keys(company).sort()), [['_id', 'groupId', 'name', 'trash']]);
  });
});

describe('the settings repository', () => {
  it('lets one of two first saves win, and turns any other failure into an error', async () => {
    const repository = createSettingsRepository(ctx.databases);
    await ctx.databases.common().collection('settings').deleteMany({});
    await ctx.databases.common().collection('settings').createIndex({ key: 1 }, { unique: true });
    const next = { plans: {}, services: DEFAULT_PRICE_LIST.services };
    assert.equal(await repository.replacePriceList(null, next, fixtureId('user', 1), new Date()), true);
    assert.equal(await repository.replacePriceList(null, next, fixtureId('user', 1), new Date()), false);
    const broken = createSettingsRepository({ common: () => ({ collection: () => ({ insertOne: () => Promise.reject(new Error('down')) }) }) } as unknown as Databases);
    await assert.rejects(broken.replacePriceList(null, next, fixtureId('user', 1), new Date()), /down/);
    const other = createSettingsRepository({ common: () => ({ collection: () => ({ insertOne: () => Promise.reject(new MongoServerError({ message: 'x', code: 13 })) }) }) } as unknown as Databases);
    await assert.rejects(other.replacePriceList(null, next, fixtureId('user', 1), new Date()), MongoServerError);
  });
});

describe('the controller', () => {
  const line = { groupId: group, groupName: 'G', companyId: group, companyName: 'C', placeId: group, placeName: 'P', activatedAt: new Date(), plan: null, items: [], monthlyCents: 0, months: 0, amountCents: 0, flags: [] };
  const statement: Statement = { dealer: { id: null, name: 'D' }, month: '2026-06', activityMonth: '2026-05', section: 'activations', status: 'open', renewalBase: { year: 2026, frozen: false }, totals: { places: 0, monthlyCents: 0, amountCents: 0, projection12Cents: 0, anomalies: 0 }, prices: DEFAULT_PRICE_LIST, lines: [line] };
  const locals = { auth: principalOf('PSA'), input: { params: { dealerId: 'none' }, query: { month: '2026-06', section: 'activations' } } };
  const leaving = (): Response => {
    const out = new Writable({ write(_chunk, _encoding, callback) { callback(); this.destroy(); } });
    return Object.assign(out, { locals, status: () => out, setHeader: () => out }) as unknown as Response;
  };
  const sink = (): Response => {
    const pass = new PassThrough();
    pass.resume();
    return Object.assign(pass, { locals, status: () => pass, setHeader: () => pass }) as unknown as Response;
  };
  const service = (export_: ActivationsService['statement']): ActivationsService => ({ statement: export_ }) as unknown as ActivationsService;

  it('stops quietly when the client goes away, lets other failures through, and allows one export at a time', async () => {
    const controller = createActivationsController(service(async () => statement));
    await controller.statementCsv({} as never, leaving(), () => undefined);
    const failing = createActivationsController(service(async () => { throw new Error('database down'); }));
    await assert.rejects(failing.statementCsv({} as never, sink(), () => undefined) as Promise<void>, /database down/);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = createActivationsController(service(async () => { await gate; return statement; }));
    const first = slow.statementCsv({} as never, sink(), () => undefined) as Promise<void>;
    await assert.rejects(slow.statementCsv({} as never, sink(), () => undefined) as Promise<void>, (error: unknown) => error instanceof AppError && error.code === 'RATE_LIMITED');
    release();
    await first;
    await (slow.statementCsv({} as never, sink(), () => undefined) as Promise<void>);
    assert.equal(csvFileName('2026-06', 'renewals', 'none'), 'attivazioni_2026-06_renewals_none.csv');
    assert.equal(csvFileName('2026-06', 'renewals', dealer), `attivazioni_2026-06_renewals_${dealer.toHexString()}.csv`);
  });
});
