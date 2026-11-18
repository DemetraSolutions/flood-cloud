import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { createActivationsRepository } from '../../src/modules/activations/activations.repository.ts';
import { cleanName } from '../../src/modules/activations/activations.names.ts';
import { createActivationsService } from '../../src/modules/activations/activations.service.ts';
import { DEFAULT_LIMITS, activationTotalsOf, compute, renewalTotalsOf } from '../../src/modules/activations/activations.engine.ts';
import { csvLines } from '../../src/modules/activations/activations.csv.ts';
import { createDealersService } from '../../src/modules/dealers/dealers.service.ts';
import { createDealersRepository } from '../../src/modules/dealers/dealers.repository.ts';
import { minimalCompany, toNewDocument } from '../../src/modules/dealers/dealer.mapper.ts';
import { DEFAULT_PRICE_LIST } from '../../src/modules/settings/price-list.ts';
import { createSettingsRepository } from '../../src/modules/settings/settings.repository.ts';
import { createSettingsService } from '../../src/modules/settings/settings.service.ts';
import { AppError } from '../../src/shared/http/errors.ts';
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
const orphan = fixtureId('group', 2);
const key = Buffer.alloc(32, 3);
const old = (n: number) => new Date(Date.UTC(2025, 5, n));

before(async () => {
  ctx = await openTestDatabases();
});
after(async () => ctx.cleanup());
beforeEach(async () => {
  for (const name of ['billingClosures', 'groups', 'places', 'companies', 'dealers', 'settings']) {
    await ctx.databases.common().collection(name).deleteMany({});
  }
  // The dealer has no document in the registry, and the groups of the dealer and of nobody both have an old place.
  await ctx.databases.common().collection('groups').insertMany([legacyGroup(1, { dealerId: dealer }), legacyGroup(2, { dealerId: null })]);
  const companies = [{ _id: fixtureId('company', 1), groupId: group, name: 'C1', trash: false }, { _id: fixtureId('company', 2), groupId: orphan, name: 'C2', trash: false }];
  await insertCopies(ctx.databases, 'companies', companies);
  await insertCopies(ctx.databases, 'places', [
    { _id: fixtureId('place', 1), groupId: group, companyId: companies[0]!._id, name: 'P1', plan: 'basic', insertDate: old(1), trash: false },
    { _id: fixtureId('place', 2), groupId: orphan, companyId: companies[1]!._id, name: 'P2', plan: 'basic', insertDate: old(2), trash: false },
  ]);
  activity.entries.length = 0;
});

const service = () => createActivationsService({ repository: createActivationsRepository(ctx.databases), priceLists: { getPriceList: async () => ({ list: DEFAULT_PRICE_LIST, version: 'v' }) }, activityLog: activity, now: () => Date.UTC(2026, 10, 18) });

describe('the billing of dealers that are not in the registry or have no dealer', () => {
  it('names a dealer with no document by his id, freezes the park of the groups with no dealer, and shows it in the closed months and the statements', async () => {
    const billing = service();
    const live = await billing.summary(psa, { month: '2026-06' });
    assert.deepEqual(live.rows.map((row) => row.dealer.name).sort(), ['Senza rivenditore', dealer.toHexString()].sort());
    const frozen = await billing.freezeBase(psa, { year: 2026 }, client);
    assert.deepEqual([frozen.dealers, frozen.lines], [2, 2]);
    const summary = await billing.summary(psa, { month: '2026-06' });
    assert.deepEqual(summary.rows.map((row) => row.renewals.places), [1, 1]);
    const closed = await billing.closeMonth(psa, { month: '2026-06' }, client);
    assert.deepEqual([closed.dealers, closed.lines], [2, 0]);
    const names = (await billing.summary(psa, { month: '2026-06' })).rows.map((row) => row.dealer.name).sort();
    assert.deepEqual(names, ['Senza rivenditore', dealer.toHexString()].sort());
    // A dealer with a base but no document in the month, and a statement of a dealer that has nothing.
    await ctx.databases.common().collection('billingClosures').deleteMany({ kind: 'month', dealerId: null });
    const none = await billing.statementPage(psa, 'none', { month: '2026-06', section: 'renewals' });
    assert.deepEqual([none.lines.length, none.totals], [1, { places: 1, annualCents: 24000, instalmentCents: 2000, anomalies: 0 }]);
    await ctx.databases.common().collection('billingClosures').deleteMany({ kind: 'renewalBase', dealerId: null });
    const missing = await billing.statementPage(psa, 'none', { month: '2026-06', section: 'renewals' });
    assert.deepEqual([missing.lines.length, missing.totals.places, missing.prices.plans.basic], [0, 0, 2000]);
    await billing.reopenMonth(psa, { month: '2026-06' }, client);
    await billing.unfreezeBase(psa, { year: 2026 }, client);
    const livePark = await billing.statementPage(psa, 'none', { month: '2026-06', section: 'renewals' });
    assert.equal(livePark.lines.length, 1);
    await ctx.databases.common().collection('places').deleteMany({ groupId: orphan });
    const emptyPark = await billing.statementPage(psa, 'none', { month: '2026-06', section: 'renewals' });
    assert.deepEqual([emptyPark.lines.length, emptyPark.totals.places], [0, 0]);
  });
});

describe('the pure parts', () => {
  it('totals the buckets, with nothing for a dealer that has none', () => {
    const bucket = { dealerId: null, lines: [], overflow: false, places: 2, monthlyCents: 100, amountCents: 300, anomalies: 1 };
    assert.deepEqual(activationTotalsOf(bucket), { places: 2, monthlyCents: 100, amountCents: 300, projection12Cents: 1200, anomalies: 1 });
    assert.deepEqual(renewalTotalsOf(bucket), { places: 2, annualCents: 1200, instalmentCents: 100, anomalies: 1 });
    assert.deepEqual(activationTotalsOf(undefined), { places: 0, monthlyCents: 0, amountCents: 0, projection12Cents: 0, anomalies: 0 });
    assert.deepEqual(renewalTotalsOf(undefined), { places: 0, annualCents: 0, instalmentCents: 0, anomalies: 0 });
  });

  it('drops a place whose group is not an id, and cleans names', async () => {
    const place = { _id: fixtureId('place', 9), groupId: 'not an id', companyId: fixtureId('company', 1), name: 'x' };
    const buckets = await compute({ repository: { readPlaces: async () => [{ place, company: null }] }, groups: new Map(), groupIds: null, window: { from: null, to: new Date() }, section: 'renewals', pricesOf: () => DEFAULT_PRICE_LIST, now: new Date(), keepLines: false, limits: DEFAULT_LIMITS });
    assert.equal(buckets.size, 0);
    assert.equal(cleanName(7), '');
    assert.equal(cleanName(' a\u0000b '), 'a b');
  });

  it('writes the quantity of an item, and no plan, in the CSV', () => {
    const line = { groupId: group, groupName: 'G', companyId: group, companyName: 'C', placeId: group, placeName: 'P', activatedAt: new Date('2026-05-10T10:00:00Z'), plan: null, items: [{ key: 'plan:', quantity: 1, unitCents: null, amountCents: 0 }, { key: 'extraDesk', quantity: 3, unitCents: 500, amountCents: 1500 }], monthlyCents: 1500, months: 7, amountCents: 10500, flags: ['unpricedPlan', 'activationDateFromId', 'expired', 'groupSuspended', 'companyDisabled'] as const };
    assert.equal(csvLines('D', [line]), 'D;G;C;P;10-05-2026;;plan: -, extraDesk x3 15,00;15,00;7;105,00;180,00;Piano senza prezzo, Data di attivazione dall’id, Scaduto, Gruppo sospeso, Azienda disattivata\r\n');
  });
});

describe('the writes of the settings and of the dealers when somebody wins the race', () => {
  const admin = principalOf('PSA');
  it('answers 412 when the price list or the overrides changed between the read and the write, and logs nothing then', async () => {
    const repository = createSettingsRepository(ctx.databases);
    const settings = createSettingsService({ repository, activityLog: activity, versionKey: key, now: () => 0 });
    const expected = (await settings.getPriceList()).version;
    const body = { plans: {}, services: DEFAULT_PRICE_LIST.services };
    const racing = createSettingsService({ repository: { ...repository, replacePriceList: async () => false }, activityLog: activity, versionKey: key, now: () => 0 });
    await assert.rejects(racing.replacePriceList(admin, expected, body, client), (error: unknown) => error instanceof AppError && error.status === 412);
    assert.equal(await repository.replacePriceList(DEFAULT_PRICE_LIST, body, dealer, new Date()), false, 'a stored value that is not the one read is not replaced');
    await settings.replacePriceList(admin, expected, body, { requestId: 'r', ip: '203.0.113.5', userAgent: null });
    assert.equal(activity.entries.length, 1);
    assert.deepEqual(activity.entries[0]!.ip, '203.0.113.5');
    const second = await settings.replacePriceList(admin, (await settings.getPriceList()).version, { plans: { x: 1 }, services: DEFAULT_PRICE_LIST.services }, client);
    assert.deepEqual(second.list.plans, { x: 1 });
    assert.equal('ip' in activity.entries[1]!, false);

    await ctx.databases.common().collection('dealers').insertOne(toNewDocument(dealer, minimalCompany('R'), 'manual', null, new Date()));
    const dealers = createDealersRepository(ctx.databases);
    const make = (repo = dealers) => createDealersService({ dealers: repo, users: { findSummaries: async () => new Map() }, usersService: {} as never, priceLists: settings, versionKey: key, activityLog: activity, now: () => 0 });
    const version = (await make().getPriceOverrides(dealer)).version;
    await assert.rejects(make({ ...dealers, replacePriceOverrides: async () => false }).replacePriceOverrides(admin, dealer, version, { services: { kiosk: 1 } }, client), (error: unknown) => error instanceof AppError && error.status === 412);
    await make().replacePriceOverrides(admin, dealer, version, { services: { kiosk: 1 } }, { requestId: 'r', ip: '203.0.113.5', userAgent: null });
    assert.equal(activity.entries.at(-1)!.ip, '203.0.113.5');
    const next = (await make().getPriceOverrides(dealer)).version;
    await make().replacePriceOverrides(admin, dealer, next, {}, client);
    assert.equal('ip' in activity.entries.at(-1)!, false);
    await assert.rejects(make().getPriceOverrides(new ObjectId()), (error: unknown) => error instanceof AppError && error.status === 404);
  });
});

describe('the perimeter of the caller', () => {
  it('refuses a caller that is neither the platform administrator nor a dealer, whatever the route said', async () => {
    const billing = service();
    for (const role of ['SA', 'CA', 'PA', 'E'] as const) {
      await assert.rejects(billing.summary(principalOf(role), { month: '2026-06' }), (error: unknown) => error instanceof AppError && error.status === 403, role);
      await assert.rejects(billing.statement(principalOf(role), 'none', { month: '2026-06', section: 'activations' }), (error: unknown) => error instanceof AppError && error.status === 403, role);
    }
  });

  it('names a dealer by his user name and cleans the plan of a line like a name', async () => {
    await ctx.databases.common().collection('users').insertOne({ _id: dealer, role: 'D', userName: 'dealer.user' });
    await ctx.databases.common().collection('places').updateOne({ _id: fixtureId('place', 1) }, { $set: { plan: 'ba\u0000sic', insertDate: new Date(Date.UTC(2026, 4, 5)) } });
    const billing = service();
    const summary = await billing.summary(psa, { month: '2026-06', dealerId: dealer });
    assert.equal(summary.rows[0]!.dealer.name, 'dealer.user');
    const statement = await billing.statement(psa, dealer, { month: '2026-06', section: 'activations' });
    assert.deepEqual([statement.lines[0]!.plan, statement.lines[0]!.items[0]!.key], ['ba sic', 'plan:ba sic']);
    assert.equal((await billing.summary(psa, { month: '2026-06' })).rows.some((row) => row.dealer.name === 'dealer.user'), true);
  });
});
