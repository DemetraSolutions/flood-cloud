import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { startBackoffice } from '../helpers/backoffice.ts';
import type { Backoffice } from '../helpers/backoffice.ts';
import { fixtureId, legacyGroup } from '../helpers/legacy-fixtures.ts';
import { insertCopies } from '../helpers/mirror.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { actors } from '../helpers/users.ts';
import { memoryRateLimiter } from '../helpers/activity.ts';
import { createActivationsRoutes } from '../../src/modules/activations/activations.routes.ts';
import { createSettingsRoutes } from '../../src/modules/settings/settings.routes.ts';
import { createDealersRoutes } from '../../src/modules/dealers/dealers.routes.ts';
import { createRateLimitRules } from '../../src/shared/security/rate-limit/rules.ts';
import { testConfig } from '../helpers/app.ts';
import { createActivationsService } from '../../src/modules/activations/activations.service.ts';
import { createActivationsRepository } from '../../src/modules/activations/activations.repository.ts';
import { DEFAULT_LIMITS } from '../../src/modules/activations/activations.engine.ts';
import { DEFAULT_PRICE_LIST } from '../../src/modules/settings/price-list.ts';
import { principalOf } from '../helpers/principal.ts';
import { minimalCompany, toNewDocument } from '../../src/modules/dealers/dealer.mapper.ts';

let ctx: TestDatabases;
let office: Backoffice;
let as: ReturnType<typeof actors>;
const call = (...args: Parameters<typeof as.call>) => as.call(...args);
const failure = (reply: Awaited<ReturnType<typeof call>>) => as.failure(reply);
const common = () => ctx.databases.common();
const psa = () => office.cluster.psa;
const dealerA = () => office.cluster.dealerA;
const dealerB = () => office.cluster.dealerB;
const strongTag = /^"[A-Za-z0-9_-]{43}"$/;
const MAY = (day: number) => new Date(Date.UTC(2026, 4, day, 10));
const gid = (n: number) => fixtureId('group', n);
let seq = 1000;
const id = (kind: 'company' | 'place') => fixtureId(kind, seq++);
const ids: Record<string, ObjectId> = {};

function company(group: ObjectId, name: string, extra: Document = {}): Document {
  return { _id: id('company'), groupId: group, name, trash: false, status: true, ...extra };
}
function place(group: ObjectId, companyId: ObjectId | undefined, name: string, insertDate: Date | undefined, extra: Document = {}): Document {
  return { _id: id('place'), groupId: group, companyId, name, plan: 'basic', trash: false, status: true, devices: [{ type: 'cash' }], insertDate, ...extra };
}

/** The data of the scenario: the activity month is May 2026 (invoice June 2026), the renewal base is the park before 2026. */
async function seed(): Promise<void> {
  const { groups } = office.cluster;
  await common().collection('billingClosures').deleteMany({});
  await common().collection('settings').deleteMany({});
  await common().collection('dealers').deleteMany({});
  await common().collection('companies').deleteMany({});
  await common().collection('places').deleteMany({});
  await common().collection('groups').deleteMany({ _id: { $in: [gid(101), gid(102), gid(103), gid(104)] } });
  await common().collection('dealers').insertMany([
    toNewDocument(dealerA(), minimalCompany('Rivenditore Alfa'), 'manual', null, new Date()),
    toNewDocument(dealerB(), minimalCompany('Beta Distribuzione'), 'manual', null, new Date()),
  ]);
  const names = ['Gruppo A1', 'Gruppo A2', 'Gruppo B1', 'Gruppo B2'];
  for (const [index, group] of groups.entries()) {
    await common().collection('groups').updateOne({ _id: group.groupId }, { $set: { name: names[index], status: true, trash: false, demo: false, 'settings.tobaccosGamesMonopoly': index === 2 } });
  }
  await common().collection('groups').insertMany([
    legacyGroup(101, { name: 'Gruppo Orfano', dealerId: null }),
    legacyGroup(102, { name: 'Gruppo Demo', dealerId: dealerA(), demo: true }),
    legacyGroup(103, { name: 'Gruppo Cestino', dealerId: dealerA(), trash: true }),
    legacyGroup(104, { name: 'Gruppo Sospeso', dealerId: dealerA(), status: false }),
  ]);
  const [a1, a2, b1, b2] = groups.map((group) => group.groupId) as [ObjectId, ObjectId, ObjectId, ObjectId];
  const cA1 = company(a1, 'Azienda A1', { fattura_elettronica: { hub: 'Aruba', username: 'secret-user' } });
  const cA2 = company(a2, 'Azienda A2');
  const cB1 = company(b1, 'Azienda B1');
  const cB2 = company(b2, 'Azienda B2', { status: false });
  const cNone = company(gid(101), 'Azienda Orfana');
  const cTrashed = company(a1, 'Azienda Cestino', { trash: true });
  const cSusp = company(gid(104), 'Azienda Sospesa');
  const cForeign = company(b1, 'Azienda di un altro gruppo');
  const cDemo = company(gid(102), 'Azienda Demo');
  const cGone = company(gid(103), 'Azienda Gruppo Cestino');
  await insertCopies(ctx.databases, 'companies', [cA1, cA2, cB1, cB2, cNone, cTrashed, cSusp, cForeign, cDemo, cGone]);
  const c = (document: Document) => document['_id'] as ObjectId;
  const P: Record<string, Document> = {
    p1: place(a1, c(cA1), 'Negozio 1', MAY(10), { devices: [{ type: 'desk' }, { type: 'desk' }, { type: 'kiosk' }], integrations: { floodPay: { status: true, apiKey: 'must-not-leave' }, qodeup: { status: true } } }),
    p2: place(a1, c(cA1), 'Negozio 2', new Date('2025-03-05T10:00:00Z'), { plan: 'advanced' }),
    p3: place(a1, c(cA1), 'Negozio 3', new Date('2025-12-31T22:59:59Z')),
    p4: place(a2, c(cA2), 'Negozio 4', new Date('2026-05-31T21:59:59.999Z'), { plan: 'professional' }),
    p5: place(a2, c(cA2), 'Negozio 5', new Date('2026-05-31T22:00:00Z')),
    p6: place(b1, c(cB1), 'Negozio 6', MAY(1), { plan: 'enterprice', devices: [{ type: 'desk' }], tgm: { status: true } }),
    p7: place(b1, c(cB1), 'Negozio 7', new Date('2024-02-01T10:00:00Z'), { expirationDate: new Date('2025-01-01T00:00:00Z') }),
    p8: place(b2, c(cB2), 'Negozio 8', MAY(20), { plan: 'desk-secondary' }),
    p9: place(gid(101), c(cNone), 'Negozio 9', undefined, { _id: ObjectId.createFromTime(Math.floor(MAY(15).getTime() / 1000)) }),
    p10: place(a1, undefined, 'Senza azienda', MAY(11)),
    p11: place(a1, c(cTrashed), 'Azienda nel cestino', MAY(12)),
    p12: place(a1, c(cA1), 'Nel cestino', MAY(13), { trash: true }),
    p13: place(gid(102), c(cDemo), 'In un gruppo demo', MAY(14)),
    p14: place(gid(103), c(cGone), 'In un gruppo nel cestino', MAY(14)),
    p15: place(gid(104), c(cSusp), 'Negozio sospeso', MAY(16)),
    p16: place(b1, c(cForeign) /* a second company of b1 */, 'Cross', MAY(17)),
    p17: place(a2, c(cB1), 'Azienda di un altro gruppo', MAY(18)),
  };
  await insertCopies(ctx.databases, 'places', Object.values(P));
  for (const [name, document] of Object.entries(P)) {
    ids[name] = document['_id'] as ObjectId;
  }
}

before(async () => {
  ctx = await openTestDatabases();
  office = await startBackoffice(ctx);
  as = actors(office);
});
after(async () => {
  await office.close();
  await ctx.cleanup();
});
beforeEach(async () => {
  await seed();
  office.activity.entries.length = 0;
});

const summary = async (actor: ObjectId, month: string, query = '') => call(actor, 'GET', `/activations?month=${month}${query}`);
const rowOf = (reply: Awaited<ReturnType<typeof call>>, name: string) => reply.body.data.find((row: { dealer: { name: string } }) => row.dealer.name === name);

describe('GET /v1/activations of an open month', () => {
  it('prices the activations of the month before, with the months left of the year, and the instalment of the renewals', async () => {
    const reply = await summary(psa(), '2026-06');
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.body.data.map((row: { dealer: { name: string } }) => row.dealer.name), ['Beta Distribuzione', 'Rivenditore Alfa', 'Senza rivenditore']);
    // Dealer A: p1 (basic 2000 + desk 500 + kiosk 1500 + aruba 0 + floodPay 1500 + api 500 = 6000, 7 months), p4 (professional, unpriced: 0), p15 of the suspended group (2000 x 7), p10/p11 anomalies.
    const alfa = rowOf(reply, 'Rivenditore Alfa');
    assert.deepEqual(alfa.activations, { activityMonth: '2026-05', places: 3, monthlyCents: 8000, amountCents: 56000, projection12Cents: 96000 });
    assert.deepEqual(alfa.renewals, { year: 2026, places: 2, annualCents: 60000, instalmentCents: 5000, frozen: false });
    assert.equal(alfa.totalCents, 56000 + 5000);
    assert.equal(alfa.anomalies, 3, 'the place with no company, the one with a trashed company, and the one with a company of another group');
    assert.equal(alfa.status, 'open');
    // Dealer B: p6 (enterprice 4000 + desk 0 + tobaccos 1300, 7 months); p8 (desk-secondary 500) in a disabled company, 7 months.
    const beta = rowOf(reply, 'Beta Distribuzione');
    assert.deepEqual([beta.activations.places, beta.activations.amountCents, beta.renewals.instalmentCents, beta.anomalies], [3, (5300 + 500 + 2000) * 7, 2000, 0]);
    const none = rowOf(reply, 'Senza rivenditore');
    assert.deepEqual([none.dealer.id, none.activations.amountCents, none.renewals.places], [null, 2000 * 7, 0]);
    assert.deepEqual(reply.body.renewalBase, { year: 2026, frozen: false });
    assert.equal(reply.body.status, 'open');
    assert.equal(reply.body.totals.totalCents, reply.body.data.reduce((sum: number, row: { totalCents: number }) => sum + row.totalCents, 0));
    assert.deepEqual(Object.keys(reply.body.totals.activations).sort(), ['amountCents', 'monthlyCents', 'places', 'projection12Cents']);
  });

  it('reads January from the December before: the activation month of the year before pays nothing, and the park includes it', async () => {
    const reply = await summary(psa(), '2026-01');
    const alfa = rowOf(reply, 'Rivenditore Alfa');
    assert.deepEqual([alfa.activations.activityMonth, alfa.activations.places, alfa.activations.amountCents, alfa.activations.monthlyCents], ['2025-12', 1, 0, 2000]);
    assert.equal(alfa.renewals.places, 2);
  });

  it('draws the turn of a month at midnight in Rome', async () => {
    const june = await call(psa(), 'GET', '/activations/statements/' + dealerA().toHexString() + '?month=2026-07&section=activations');
    assert.deepEqual(june.body.data.map((line: { placeName: string }) => line.placeName), ['Negozio 5']);
    const may = await call(psa(), 'GET', '/activations/statements/' + dealerA().toHexString() + '?month=2026-06&section=activations');
    assert.ok(may.body.data.some((line: { placeName: string }) => line.placeName === 'Negozio 4'));
    assert.ok(!may.body.data.some((line: { placeName: string }) => line.placeName === 'Negozio 5'));
  });

  it('narrows to one dealer, and 404s an unknown one', async () => {
    const one = await summary(psa(), '2026-06', `&dealerId=${dealerB().toHexString()}`);
    assert.deepEqual(one.body.data.map((row: { dealer: { name: string } }) => row.dealer.name), ['Beta Distribuzione']);
    assert.deepEqual((await summary(psa(), '2026-06', '&dealerId=none')).body.data.map((row: { dealer: { id: string | null } }) => row.dealer.id), [null]);
    assert.equal(failure(await summary(psa(), '2026-06', `&dealerId=${fixtureId('user', 9999).toHexString()}`)).status, 404);
    const empty = await summary(psa(), '2026-03', `&dealerId=${dealerA().toHexString()}`);
    assert.deepEqual([empty.body.data.length, empty.body.data[0].activations.places, empty.body.data[0].renewals.places], [1, 0, 2]);
  });

  it('rejects bad parameters with 422 and no login with 401', async () => {
    for (const query of ['', '?month=2026-13', '?month=2019-12', '?month=2026-06&x=1', '?month=2026-06&dealerId=zz', '?month=2026-06&dealerId=NONE']) {
      assert.equal((await call(psa(), 'GET', `/activations${query}`)).status, 422, query);
    }
    assert.equal((await office.call('GET', '/activations?month=2026-06', undefined)).status, 401);
  });
});

describe('who may read', () => {
  it('shows a dealer only his own row, and refuses another dealer or none with 403', async () => {
    const own = await summary(dealerA(), '2026-06');
    assert.deepEqual(own.body.data.map((row: { dealer: { name: string } }) => row.dealer.name), ['Rivenditore Alfa']);
    assert.equal((await summary(dealerA(), '2026-06', `&dealerId=${dealerA().toHexString()}`)).status, 200);
    for (const other of [`&dealerId=${dealerB().toHexString()}`, '&dealerId=none']) {
      assert.deepEqual(failure(await summary(dealerA(), '2026-06', other)), { status: 403, code: 'FORBIDDEN', details: undefined });
    }
    const empty = await summary(dealerB(), '2026-03');
    assert.equal(empty.body.data.length, 1);
    for (const path of [`/activations/statements/${dealerB().toHexString()}?month=2026-06&section=activations`, '/activations/statements/none?month=2026-06&section=renewals', `/activations/statements/${dealerB().toHexString()}.csv?month=2026-06&section=activations`]) {
      assert.equal((await call(dealerA(), 'GET', path)).status, 403, path);
    }
    assert.equal((await call(dealerA(), 'GET', `/activations/statements/${dealerA().toHexString()}?month=2026-06&section=activations`)).status, 200);
  });

  it('refuses every role below a dealer, and every write to a dealer', async () => {
    const [g] = office.cluster.groups;
    for (const actor of [g!.sa, g!.ca, g!.pa]) {
      assert.equal((await summary(actor, '2026-06')).status, 403);
    }
    for (const [method, path] of [['PUT', '/activations/renewal-bases/2026'], ['DELETE', '/activations/renewal-bases/2026'], ['PUT', '/activations/closures/2026-06'], ['DELETE', '/activations/closures/2026-06'], ['GET', '/settings/price-list'], ['GET', `/dealers/${dealerA().toHexString()}/price-overrides`]] as const) {
      assert.equal((await call(dealerA(), method, path)).status, 403, path);
      assert.equal((await call(g!.sa, method, path)).status, 403, path);
    }
  });
});

describe('the statements', () => {
  const path = (dealer: ObjectId | 'none', query: string) => `/activations/statements/${dealer === 'none' ? 'none' : dealer.toHexString()}${query}`;

  it('lists the lines of the activations with items, flags, prices and totals, and no credential', async () => {
    const reply = await call(psa(), 'GET', path(dealerA(), '?month=2026-06&section=activations'));
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.body.data.map((line: { placeName: string }) => line.placeName), ['Negozio 1', 'Negozio 4', 'Negozio sospeso']);
    const [first, second, third] = reply.body.data;
    assert.deepEqual(first.items.map((item: { key: string }) => item.key), ['plan:basic', 'extraDesk', 'kiosk', 'arubaEInvoicing', 'floodPay', 'api']);
    assert.deepEqual([first.monthlyCents, first.months, first.amountCents, first.projection12Cents, first.flags, first.activatedAt], [6000, 7, 42000, 72000, [], MAY(10).toISOString()]);
    assert.deepEqual([second.plan, second.flags, second.items[0], second.amountCents], ['professional', ['unpricedPlan'], { key: 'plan:professional', quantity: 1, unitCents: null, amountCents: 0 }, 0]);
    assert.deepEqual(third.flags, ['groupSuspended']);
    assert.deepEqual(reply.body.totals, { places: 3, monthlyCents: 8000, amountCents: 56000, projection12Cents: 96000, anomalies: 3 });
    assert.deepEqual(reply.body.prices.plans.basic, 2000);
    assert.deepEqual(reply.body.dealer, { id: dealerA().toHexString(), name: 'Rivenditore Alfa' });
    assert.deepEqual([reply.body.status, reply.body.renewalBase, reply.body.page], ['open', { year: 2026, frozen: false }, { limit: 50, next: null }]);
    assert.ok(!JSON.stringify(reply.body).includes('must-not-leave') && !JSON.stringify(reply.body).includes('secret-user'));
  });

  it('lists the park for the renewals with the instalment as the amount, flags of expiry, disabled company, date from the id', async () => {
    const renewals = await call(psa(), 'GET', path(dealerB(), '?month=2026-06&section=renewals'));
    assert.deepEqual(renewals.body.data.map((line: { placeName: string; flags: string[]; months: number; amountCents: number }) => [line.placeName, line.flags, line.months, line.amountCents]), [['Negozio 7', ['expired'], 1, 2000]]);
    assert.deepEqual(renewals.body.totals, { places: 1, annualCents: 24000, instalmentCents: 2000, anomalies: 0, amountCents: 2000, projection12Cents: 24000 });
    const disabled = await call(psa(), 'GET', path(dealerB(), '?month=2026-06&section=activations'));
    assert.deepEqual(disabled.body.data.map((line: { flags: string[] }) => line.flags), [[], [], ['companyDisabled']]);
    const none = await call(psa(), 'GET', path('none', '?month=2026-06&section=activations'));
    assert.deepEqual(none.body.data[0].flags, ['activationDateFromId']);
    assert.equal(none.body.data[0].activatedAt, new Date(Math.floor(MAY(15).getTime() / 1000) * 1000).toISOString());
  });

  it('pages with an opaque cursor in a stable order, and refuses a cursor it did not issue', async () => {
    const first = await call(psa(), 'GET', path(dealerA(), '?month=2026-06&section=activations&limit=2'));
    assert.deepEqual([first.body.data.length, first.body.page.limit, typeof first.body.page.next], [2, 2, 'string']);
    const second = await call(psa(), 'GET', path(dealerA(), `?month=2026-06&section=activations&limit=2&cursor=${first.body.page.next}`));
    assert.deepEqual([second.body.data.map((line: { placeName: string }) => line.placeName), second.body.page.next], [['Negozio sospeso'], null]);
    for (const cursor of ['!!', 'e30', Buffer.from('[]').toString('base64url'), Buffer.from('nope').toString('base64url'), Buffer.from(JSON.stringify({ ver: 2, g: '', c: '', p: '', i: 'a'.repeat(24) })).toString('base64url'), Buffer.from(JSON.stringify({ ver: 1, g: '', c: '', p: '', i: 'zz' })).toString('base64url'), Buffer.from('null').toString('base64url')]) {
      assert.deepEqual(failure(await call(psa(), 'GET', path(dealerA(), `?month=2026-06&section=activations&cursor=${cursor}`))), { status: 422, code: 'VALIDATION_ERROR', details: [{ field: 'cursor', issue: 'format' }] }, cursor);
    }
    for (const query of ['?month=2026-06', '?month=2026-06&section=x', '?month=2026-06&section=activations&limit=101', '?month=2026-06&section=activations&limit=0', '?month=2026-06&section=activations&z=1']) {
      assert.equal((await call(psa(), 'GET', path(dealerA(), query))).status, 422, query);
    }
    assert.equal((await call(psa(), 'GET', '/activations/statements/zz?month=2026-06&section=activations')).status, 422);
    assert.equal((await call(psa(), 'GET', path(fixtureId('user', 9998), '?month=2026-06&section=activations'))).status, 404);
  });

  it('exports the same lines as CSV, with the protections of the diagnostics', async () => {
    await place0();
    const response = await office.call('GET', `/activations/statements/${dealerA().toHexString()}.csv?month=2026-06&section=activations`, (await as.tokenOf(psa())));
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type')!, /^text\/csv/);
    assert.match(response.headers.get('content-disposition')!, /^attachment; filename="attivazioni_2026-06_activations_[0-9a-f]{24}\.csv"$/);
    const text = await response.text();
    assert.ok(text.startsWith('Rivenditore;Gruppo;Azienda;Punto vendita;Attivato il;Piano;Dettaglio voci;Canone mensile;Mesi;Importo;Proiezione 12 mesi;Segnalazioni\r\n'));
    const lines = text.trim().split('\r\n');
    assert.equal(lines.length, 5);
    const first = lines.find((line) => line.includes(';Negozio 1;'))!;
    assert.ok(first.startsWith('Rivenditore Alfa;Gruppo A1;Azienda A1;Negozio 1;10-05-2026;basic;'));
    assert.ok(first.includes('plan:basic 20,00, extraDesk 5,00, kiosk 15,00, arubaEInvoicing 0,00, floodPay 15,00, api (qodeup) 5,00;60,00;7;420,00;720,00;'));
    assert.ok(lines.some((line) => line.endsWith(';Piano senza prezzo')));
    assert.ok(lines.some((line) => line.includes("'=SUM(A1)")), 'a name that starts like a formula is made text');
    const empty = await office.call('GET', `/activations/statements/${dealerA().toHexString()}.csv?month=2026-02&section=activations`, await as.tokenOf(psa()));
    assert.equal((await empty.text()).trim().split('\r\n').length, 1);
    assert.equal((await office.call('GET', `/activations/statements/${dealerA().toHexString()}.csv?month=2026-02`, await as.tokenOf(psa()))).status, 422);
  });
});

/** Adds a place of dealer A activated in May whose name starts like a formula. */
async function place0(): Promise<void> {
  const [a1] = office.cluster.groups;
  const company0 = (await common().collection('companies').findOne({ groupId: a1!.groupId, trash: false }))!;
  await insertCopies(ctx.databases, 'places', [place(a1!.groupId, company0['_id'] as ObjectId, '=SUM(A1)', MAY(19))]);
}

describe('freezing the renewal base and closing a month', () => {
  const put = (path: string) => call(psa(), 'PUT', path);
  const del = (path: string) => call(psa(), 'DELETE', path);

  it('refuses to close a month before the base is frozen, in the future, twice, and to freeze twice or an empty year', async () => {
    assert.deepEqual(failure(await put('/activations/closures/2026-06')).details, [{ field: 'month', issue: 'baseNotFrozen' }]);
    assert.deepEqual(failure(await put('/activations/closures/2099-01')).details, [{ field: 'month', issue: 'monthInFuture' }]);
    assert.deepEqual(failure(await put('/activations/renewal-bases/2021')).details, [{ field: 'year', issue: 'empty' }]);
    assert.deepEqual(failure(await del('/activations/renewal-bases/2026')).details, [{ field: 'year', issue: 'notFrozen' }]);
    assert.deepEqual(failure(await del('/activations/closures/2026-06')).details, [{ field: 'month', issue: 'notClosed' }]);
    const frozen = await put('/activations/renewal-bases/2026');
    assert.deepEqual([frozen.status, frozen.body.data.period, frozen.body.data.dealers, frozen.body.data.lines], [200, '2026', 2, 3]);
    assert.deepEqual(failure(await put('/activations/renewal-bases/2026')).details, [{ field: 'year', issue: 'alreadyFrozen' }]);
    assert.equal((await put('/activations/closures/2099-01')).status, 409);
    const closed = await put('/activations/closures/2026-06');
    assert.deepEqual([closed.status, closed.body.data.period, closed.body.data.dealers, closed.body.data.lines], [200, '2026-06', 3, 7]);
    assert.deepEqual(failure(await put('/activations/closures/2026-06')).details, [{ field: 'month', issue: 'alreadyClosed' }]);
    assert.deepEqual(failure(await del('/activations/renewal-bases/2026')).details, [{ field: 'year', issue: 'monthClosed' }]);
    assert.equal((await del('/activations/closures/2026-06')).status, 204);
    assert.equal((await del('/activations/renewal-bases/2026')).status, 204);
    assert.equal(await common().collection('billingClosures').countDocuments({}), 0);
    assert.deepEqual(office.activity.entries.map((entry) => entry.action), ['activations.renewalBaseFrozen', 'activations.monthClosed', 'activations.monthReopened', 'activations.renewalBaseUnfrozen']);
    assert.deepEqual(office.activity.entries[1]!.metadata, { period: '2026-06', dealers: 3, lines: 7 });
  });

  it('keeps a closed month and a frozen base as they were when the data and the prices change afterwards', async () => {
    await put('/activations/renewal-bases/2026');
    await put('/activations/closures/2026-06');
    const before = await summary(psa(), '2026-06');
    const statement = await call(psa(), 'GET', `/activations/statements/${dealerA().toHexString()}?month=2026-06&section=activations`);
    const park = await call(psa(), 'GET', `/activations/statements/${dealerA().toHexString()}?month=2026-06&section=renewals`);
    assert.equal(before.body.status, 'closed');
    assert.deepEqual(before.body.renewalBase, { year: 2026, frozen: true });
    assert.ok(before.body.data.every((row: { status: string }) => row.status === 'closed'));
    // Everything changes: prices, overrides, devices, a new place and a new dealer with places.
    const list = await call(psa(), 'GET', '/settings/price-list');
    const next = { plans: { ...list.body.data.plans, basic: 9999 }, services: { ...list.body.data.services, kiosk: 1 } };
    assert.equal((await call(psa(), 'PUT', '/settings/price-list', next, { 'if-match': list.headers.get('etag')! })).status, 200);
    await common().collection('places').updateMany({}, { $set: { plan: 'enterprice' } });
    await common().collection('places').insertOne(place(office.cluster.groups[0]!.groupId, (await common().collection('companies').findOne({ name: 'Azienda A1' }))!['_id'] as ObjectId, 'Nuovo', MAY(21)));
    await common().collection('groups').updateOne({ _id: gid(101) }, { $set: { dealerId: dealerB() } });
    const after = await summary(psa(), '2026-06');
    assert.deepEqual(after.body, before.body);
    assert.deepEqual((await call(psa(), 'GET', `/activations/statements/${dealerA().toHexString()}?month=2026-06&section=activations`)).body, statement.body);
    assert.deepEqual((await call(psa(), 'GET', `/activations/statements/${dealerA().toHexString()}?month=2026-06&section=renewals`)).body, park.body);
    assert.equal(statement.body.prices.plans.basic, 2000);
    // A dealer that appears later is not part of the closure.
    assert.deepEqual((await summary(dealerB(), '2026-06')).body.data.length, 1);
    // A dealer without a document in a closed month is shown with zeros.
    await common().collection('billingClosures').deleteMany({ kind: 'month', dealerId: dealerB() });
    const zero = await summary(dealerB(), '2026-06');
    assert.deepEqual([zero.body.data[0].status, zero.body.data[0].activations.places, zero.body.data[0].renewals.places], ['closed', 0, 0]);
    // Reopened, it is live again, with the new prices.
    await del('/activations/closures/2026-06');
    assert.equal((await summary(psa(), '2026-06')).body.status, 'open');
  });

  it('lets a base be unfrozen when no month is closed, and refuses a body', async () => {
    await put('/activations/renewal-bases/2026');
    assert.equal((await call(psa(), 'PUT', '/activations/closures/2026-06', { a: 1 })).status, 422);
    assert.equal((await call(psa(), 'PUT', '/activations/closures/2026-06', [])).status, 422);
    assert.equal((await call(psa(), 'PUT', '/activations/closures/2026-06', {})).status, 200);
    assert.equal((await call(psa(), 'PUT', '/activations/closures/2026-07', {})).status, 200);
    for (const path of ['/activations/closures/2026-13', '/activations/closures/x', '/activations/renewal-bases/2019', '/activations/renewal-bases/2101', '/activations/renewal-bases/20x6']) {
      assert.equal((await put(path)).status, 422, path);
    }
  });

  it('freezes the base with the lines and prices, readable live while the month is open', async () => {
    await put('/activations/renewal-bases/2026');
    const frozen = await common().collection('billingClosures').find({ kind: 'renewalBase' }).sort({ dealerName: 1 }).toArray();
    assert.deepEqual(frozen.map((document) => [document['dealerName'], document['period'], document['renewals'].lines.length, document['activations'].lines.length]), [['Beta Distribuzione', '2026', 1, 0], ['Rivenditore Alfa', '2026', 2, 0]]);
    // The frozen park is what a statement shows now, whatever happens to the places.
    await common().collection('places').deleteMany({});
    const reply = await call(psa(), 'GET', `/activations/statements/${dealerA().toHexString()}?month=2026-08&section=renewals`);
    assert.equal(reply.body.data.length, 2);
    assert.equal(reply.body.renewalBase.frozen, true);
    assert.equal((await summary(psa(), '2026-08')).body.data.find((row: { dealer: { name: string } }) => row.dealer.name === 'Rivenditore Alfa').renewals.frozen, true);
  });
});

describe('the price list and the overrides', () => {
  it('serves the default list with a strong ETag, replaces it with If-Match, and records the change', async () => {
    const read = await call(psa(), 'GET', '/settings/price-list');
    assert.equal(read.status, 200);
    assert.match(read.headers.get('etag')!, strongTag);
    assert.deepEqual(read.body.data.services, { extraDesk: 500, kiosk: 1500, api: 500, tobaccos: 1300, reservationWidget: 1000, floodPay: 1500, arubaEInvoicing: 0, reserveWithGoogle: 0, bizerba: 0 });
    const body = { plans: { basic: 2500, professional: 2700 }, services: read.body.data.services };
    const written = await call(psa(), 'PUT', '/settings/price-list', body, { 'if-match': read.headers.get('etag')! });
    assert.equal(written.status, 200);
    assert.notEqual(written.headers.get('etag'), read.headers.get('etag'));
    assert.deepEqual(written.body.data.plans, { basic: 2500, professional: 2700 });
    assert.deepEqual(failure(await call(psa(), 'PUT', '/settings/price-list', body, { 'if-match': read.headers.get('etag')! })).code, 'PRECONDITION_FAILED');
    const same = await call(psa(), 'PUT', '/settings/price-list', body, { 'if-match': written.headers.get('etag')! });
    assert.equal(same.headers.get('etag'), written.headers.get('etag'));
    assert.deepEqual(office.activity.entries.map((entry) => entry.action), ['priceList.updated']);
    assert.equal(await common().collection('settings').countDocuments({}), 1);
    // The new price list is what the open months use, and the plan that had none is now priced.
    const lines = await call(psa(), 'GET', `/activations/statements/${dealerA().toHexString()}?month=2026-06&section=activations`);
    assert.deepEqual(lines.body.data[1].flags, []);
    assert.equal(lines.body.data[1].monthlyCents, 2700);
  });

  it('refuses a bad list with 422 on the fields, a missing or malformed If-Match, and a concurrent first save with 412', async () => {
    const etag = (await call(psa(), 'GET', '/settings/price-list')).headers.get('etag')!;
    const ok = { plans: {}, services: { extraDesk: 0, kiosk: 0, api: 0, tobaccos: 0, reservationWidget: 0, floodPay: 0, arubaEInvoicing: 0, reserveWithGoogle: 0, bizerba: 0 } };
    const put = (body: unknown, headers: Record<string, string> = { 'if-match': etag }) => call(psa(), 'PUT', '/settings/price-list', body, headers);
    const fields = async (body: unknown) => (failure(await put(body)).details as Array<{ field: string }>).map((detail) => detail.field);
    assert.deepEqual(await fields({ ...ok, plans: { 'bad key': 1 } }), ['plans.(key)']);
    assert.deepEqual(await fields({ ...ok, plans: { basic: -1 } }), ['plans.basic']);
    assert.deepEqual(await fields({ ...ok, plans: { basic: 10_000_001 } }), ['plans.basic']);
    assert.deepEqual(await fields({ ...ok, plans: { basic: 1.5 } }), ['plans.basic']);
    assert.deepEqual(await fields({ ...ok, services: { ...ok.services, kiosk: '5' } }), ['services.kiosk']);
    assert.deepEqual(await fields({ ...ok, services: { extraDesk: 0 } }).then((list) => list.length), 8);
    assert.deepEqual(await fields({ ...ok, services: { ...ok.services, gold: 1 } }), ['services.gold']);
    assert.deepEqual(await fields({ ...ok, extra: 1 }), ['extra']);
    assert.equal((await fields({ ...ok, plans: Object.fromEntries(Array.from({ length: 31 }, (_v, index) => [`p${String(index)}`, 1])) })).length, 1);
    assert.equal((await put(ok, {})).status, 422);
    assert.equal((await put(ok, { 'if-match': 'W/"x"' })).status, 422);
    assert.equal((await put(ok, { 'if-match': `"${'A'.repeat(43)}"` })).status, 412);
    assert.equal((await call(psa(), 'PUT', '/settings/price-list', undefined, { 'if-match': etag })).status, 422);
    assert.equal(await common().collection('settings').countDocuments({}), 0);
  });

  it('keeps overrides per dealer, key by key, with the effective prices and a version', async () => {
    const url = `/dealers/${dealerA().toHexString()}/price-overrides`;
    const read = await call(psa(), 'GET', url);
    assert.deepEqual([read.status, read.body.data.overrides, read.body.data.effective.plans.basic], [200, {}, 2000]);
    assert.match(read.headers.get('etag')!, strongTag);
    const written = await call(psa(), 'PUT', url, { plans: { basic: 1000, professional: 100 }, services: { kiosk: 0 } }, { 'if-match': read.headers.get('etag')! });
    assert.deepEqual(written.body.data.overrides, { plans: { basic: 1000, professional: 100 }, services: { kiosk: 0 } });
    assert.deepEqual([written.body.data.effective.plans.advanced, written.body.data.effective.plans.basic, written.body.data.effective.services.kiosk, written.body.data.effective.services.api], [3000, 1000, 0, 500]);
    assert.equal(failure(await call(psa(), 'PUT', url, {}, { 'if-match': read.headers.get('etag')! })).status, 412);
    // The dealer's places are priced with the override, the other dealer's are not.
    const mine = await call(psa(), 'GET', `/activations/statements/${dealerA().toHexString()}?month=2026-06&section=activations`);
    assert.deepEqual([mine.body.data[0].monthlyCents, mine.body.data[1].monthlyCents, mine.body.prices.plans.basic], [3500, 100, 1000]);
    const theirs = await call(psa(), 'GET', `/activations/statements/${dealerB().toHexString()}?month=2026-06&section=activations`);
    assert.equal(theirs.body.prices.plans.basic, 2000);
    assert.equal((await call(psa(), 'PUT', url, { plans: { basic: 1000, professional: 100 }, services: { kiosk: 0 } }, { 'if-match': written.headers.get('etag')! })).headers.get('etag'), written.headers.get('etag'));
    const cleared = await call(psa(), 'PUT', url, {}, { 'if-match': written.headers.get('etag')! });
    assert.deepEqual(cleared.body.data.overrides, {});
    assert.equal((await common().collection('dealers').findOne({ _id: dealerA() }))!['priceOverrides'], undefined);
    assert.deepEqual(office.activity.entries.map((entry) => entry.action), ['dealer.priceOverridesUpdated', 'dealer.priceOverridesUpdated']);
    for (const bad of [{ services: { gold: 1 } }, { plans: { 'x y': 1 } }, { plans: { a: -1 } }, { other: 1 }]) {
      assert.equal((await call(psa(), 'PUT', url, bad, { 'if-match': cleared.headers.get('etag')! })).status, 422);
    }
    assert.equal((await call(psa(), 'GET', `/dealers/${fixtureId('user', 7777).toHexString()}/price-overrides`)).status, 404);
    assert.equal((await call(psa(), 'PUT', `/dealers/${fixtureId('user', 7777).toHexString()}/price-overrides`, {}, { 'if-match': cleared.headers.get('etag')! })).status, 404);
    assert.equal((await call(psa(), 'GET', '/dealers/zz/price-overrides')).status, 422);
  });
});

describe('the refusals of the new routes', () => {
  const overrides = () => `/dealers/${dealerA().toHexString()}/price-overrides`;
  const noServices = { plans: {}, services: { extraDesk: 0, kiosk: 0, api: 0, tobaccos: 0, reservationWidget: 0, floodPay: 0, arubaEInvoicing: 0, reserveWithGoogle: 0, bizerba: 0 } };

  it('refuses every write and read of the price list, the overrides, the bases and the closures to a dealer, an SA, a CA and a PA, and changes nothing', async () => {
    const [g] = office.cluster.groups;
    const etag = (await call(psa(), 'GET', '/settings/price-list')).headers.get('etag')!;
    const routes: Array<[string, string, unknown?]> = [
      ['GET', '/settings/price-list'],
      ['PUT', '/settings/price-list', noServices],
      ['GET', overrides()],
      ['PUT', overrides(), {}],
      ['PUT', '/activations/renewal-bases/2026'],
      ['DELETE', '/activations/renewal-bases/2026'],
      ['PUT', '/activations/closures/2026-06'],
      ['DELETE', '/activations/closures/2026-06'],
    ];
    for (const actor of [dealerA(), g!.sa, g!.ca, g!.pa]) {
      for (const [method, path, body] of routes) {
        assert.deepEqual(failure(await call(actor, method, path, body, { 'if-match': etag })), { status: 403, code: 'FORBIDDEN', details: undefined }, `${method} ${path}`);
      }
    }
    assert.equal(await common().collection('settings').countDocuments({}), 0);
    assert.equal(await common().collection('billingClosures').countDocuments({}), 0);
    assert.equal((await common().collection('dealers').findOne({ _id: dealerA() }))!['priceOverrides'], undefined);
  });

  it('refuses hostile plan keys on both writes with 422', async () => {
    const list = (await call(psa(), 'GET', '/settings/price-list')).headers.get('etag')!;
    const own = (await call(psa(), 'GET', overrides())).headers.get('etag')!;
    for (const key of ['__proto__', 'constructor', 'prototype', '$gt', 'a.b', '$where']) {
      const plans = { [key]: 1 };
      const listReply = await call(psa(), 'PUT', '/settings/price-list', { ...noServices, plans }, { 'if-match': list });
      const overrideReply = await call(psa(), 'PUT', overrides(), { plans }, { 'if-match': own });
      assert.deepEqual([listReply.status, overrideReply.status], [422, 422], key);
      assert.ok(!JSON.stringify([listReply.body, overrideReply.body]).includes(key.replace('$', '')) || key === 'constructor' || key === 'prototype', 'a hostile key is not echoed');
    }
    assert.equal(await common().collection('settings').countDocuments({}), 0);
  });

  it('answers a real 429 when the writes or the exports of a user exceed their limit', async () => {
    const other = await openTestDatabases();
    const limited = await startBackoffice(other, { env: { RATE_LIMIT_ACTIVATIONS_ADMIN_PER_USER: '2', RATE_LIMIT_ACTIVATIONS_EXPORT_PER_USER: '1' }, rateLimiter: memoryRateLimiter() });
    try {
      const mine = actors(limited);
      const writes = [];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        writes.push((await mine.call(limited.cluster.psa, 'PUT', '/activations/closures/2026-06')).status);
      }
      assert.deepEqual(writes, [409, 409, 429]);
      const path = `/activations/statements/${limited.cluster.dealerA.toHexString()}.csv?month=2026-06&section=activations`;
      const first = await limited.call('GET', path, await mine.tokenOf(limited.cluster.psa));
      const second = await limited.call('GET', path, await mine.tokenOf(limited.cluster.psa));
      assert.deepEqual([first.status, second.status], [200, 429]);
      assert.ok(second.headers.get('retry-after') !== null);
    } finally {
      await limited.close();
      await other.cleanup();
    }
  });

  it('keeps a dealer to his own data in every statement and CSV: none is refused, and a closed month, a frozen base and an open month show no other dealer', async () => {
    const own = dealerA().toHexString();
    assert.equal((await call(dealerA(), 'GET', '/activations/statements/none.csv?month=2026-06&section=activations')).status, 403);
    await call(psa(), 'PUT', '/activations/renewal-bases/2026');
    const names = (reply: Awaited<ReturnType<typeof call>>) => JSON.stringify(reply.body);
    // A frozen base with the month still open.
    for (const section of ['activations', 'renewals']) {
      const statement = await call(dealerA(), 'GET', `/activations/statements/${own}?month=2026-06&section=${section}`);
      assert.equal(statement.status, 200);
      assert.ok(statement.body.data.length > 0 && !/Negozio [678]|Gruppo B|Beta/.test(names(statement)), section);
      const csv = await office.call('GET', `/activations/statements/${own}.csv?month=2026-06&section=${section}`, await as.tokenOf(dealerA()));
      assert.ok(!/Negozio [678]|Gruppo B|Beta/.test(await csv.text()), `${section} csv`);
    }
    // The closed month, served from the closures.
    await call(psa(), 'PUT', '/activations/closures/2026-06');
    for (const section of ['activations', 'renewals']) {
      const statement = await call(dealerA(), 'GET', `/activations/statements/${own}?month=2026-06&section=${section}`);
      assert.equal(statement.body.status, 'closed');
      assert.ok(statement.body.data.length > 0 && !/Negozio [678]|Gruppo B|Beta/.test(names(statement)), section);
      const csv = await office.call('GET', `/activations/statements/${own}.csv?month=2026-06&section=${section}`, await as.tokenOf(dealerA()));
      assert.ok(!/Negozio [678]|Gruppo B|Beta/.test(await csv.text()), `${section} csv`);
      assert.equal((await call(dealerA(), 'GET', `/activations/statements/${dealerB().toHexString()}?month=2026-06&section=${section}`)).status, 403);
    }
    assert.deepEqual((await summary(dealerA(), '2026-06')).body.data.map((row: { dealer: { name: string } }) => row.dealer.name), ['Rivenditore Alfa']);
  });

  it('opens none of the new routes to a store key or on the public surface: they are user routes with no store opt-in, which the default-deny tests of the route builder refuse to a store key and to the public surface', () => {
    const rules = createRateLimitRules(testConfig());
    const stub = new Proxy({}, { get: () => () => undefined }) as never;
    const routes = [...createActivationsRoutes(stub, rules), ...createSettingsRoutes(stub, rules), ...createDealersRoutes(stub, rules).filter((route) => route.path.endsWith('/price-overrides'))];
    assert.equal(routes.length, 13);
    for (const route of routes) {
      assert.equal(route.auth.kind, 'user', route.path);
      assert.ok(!('store' in route.auth), route.path);
      assert.ok(['activations:read', 'activations:manage'].includes((route.auth as { permission: string }).permission), route.path);
    }
  });
});

describe('concurrent freezes, closes and unfreezes of a year', () => {
  const statuses = async (...requests: Array<Promise<Awaited<ReturnType<typeof call>>>>) => (await Promise.all(requests)).map((reply) => reply.status).sort();
  const states = async () => ({
    base: await common().collection('billingClosures').countDocuments({ kind: 'renewalBase' }),
    month: await common().collection('billingClosures').countDocuments({ kind: 'month' }),
  });

  it('lets one of two freezes win, and one of two closes, leaving no duplicate', async () => {
    assert.deepEqual(await statuses(call(psa(), 'PUT', '/activations/renewal-bases/2026'), call(psa(), 'PUT', '/activations/renewal-bases/2026')), [200, 409]);
    assert.deepEqual(await states(), { base: 2, month: 0 });
    assert.deepEqual(await statuses(call(psa(), 'PUT', '/activations/closures/2026-06'), call(psa(), 'PUT', '/activations/closures/2026-06')), [200, 409]);
    assert.deepEqual(await states(), { base: 2, month: 3 });
    assert.deepEqual(await statuses(call(psa(), 'DELETE', '/activations/closures/2026-06'), call(psa(), 'DELETE', '/activations/closures/2026-06')), [204, 409]);
    assert.deepEqual(await statuses(call(psa(), 'DELETE', '/activations/renewal-bases/2026'), call(psa(), 'DELETE', '/activations/renewal-bases/2026')), [204, 409]);
    assert.ok(((await common().collection('settings').findOne({ key: 'BILLING_LOCK:2026' }))!['value'] as { counter: number }).counter === 4, 'every operation that succeeded incremented the lock of the year, and the ones that were refused rolled back');
  });

  it('never leaves a closed month without its base when a close and an unfreeze of the same year race', async () => {
    for (let round = 0; round < 6; round += 1) {
      await call(psa(), 'PUT', '/activations/renewal-bases/2026');
      const outcome = await statuses(call(psa(), 'PUT', '/activations/closures/2026-06'), call(psa(), 'DELETE', '/activations/renewal-bases/2026'));
      assert.ok(outcome[0] === 200 || outcome[0] === 204, `round ${String(round)}: ${outcome.join()}`);
      assert.equal(outcome[1], 409, `round ${String(round)}: exactly one of the two wins`);
      const { base, month } = await states();
      assert.ok(month === 0 || base > 0, `round ${String(round)}: a month is closed only on a frozen base`);
      await call(psa(), 'DELETE', '/activations/closures/2026-06');
      await call(psa(), 'DELETE', '/activations/renewal-bases/2026');
    }
  });

  it('refuses to freeze a year that has not begun, in Rome', async () => {
    const year = new Date().getUTCFullYear() + 1;
    assert.deepEqual(failure(await call(psa(), 'PUT', `/activations/renewal-bases/${String(year)}`)).details, [{ field: 'year', issue: 'yearInFuture' }]);
  });
});

describe('a dealer user with no document in the registry', () => {
  it('is a dealer for the PSA: found by id, named by his user name, with the default prices', async () => {
    await common().collection('dealers').deleteMany({});
    const reply = await summary(psa(), '2026-06', `&dealerId=${dealerA().toHexString()}`);
    assert.equal(reply.status, 200);
    assert.match(reply.body.data[0].dealer.name, /^user-/, 'the user name of the dealer');
    assert.equal((await call(psa(), 'GET', `/activations/statements/${dealerA().toHexString()}?month=2026-06&section=activations`)).status, 200);
    assert.equal((await summary(dealerA(), '2026-06')).body.data[0].dealer.name, reply.body.data[0].dealer.name);
    assert.equal((await call(psa(), 'GET', `/dealers/${dealerA().toHexString()}/price-overrides`)).status, 404, 'the overrides need the document of the registry');
  });
});

describe('GET /v1/activations/lines, the detail of all the activations of a span', () => {
  const lines = (actor: ObjectId, query: string) => call(actor, 'GET', `/activations/lines?${query}`);
  const names = (reply: Awaited<ReturnType<typeof call>>) => reply.body.data.map((line: { placeName: string }) => line.placeName);

  it('lists every activation of the months, newest first, with dealer, items, devices and totals of the whole set', async () => {
    const reply = await lines(psa(), 'from=2026-05&to=2026-05');
    assert.equal(reply.status, 200);
    assert.deepEqual(names(reply), ['Negozio 4', 'Negozio 8', 'Cross', 'Negozio sospeso', 'Negozio 9', 'Negozio 1', 'Negozio 6']);
    assert.deepEqual([reply.body.from, reply.body.to, reply.body.page], ['2026-05', '2026-05', { limit: 50, next: null }]);
    assert.deepEqual(reply.body.totals, { places: 7, monthlyCents: 17800, amountCents: 124600, projection12Cents: 213600, anomalies: 3 });
    const first = reply.body.data.find((line: { placeName: string }) => line.placeName === 'Negozio 1');
    assert.deepEqual(first.dealer, { id: dealerA().toHexString(), name: 'Rivenditore Alfa' });
    assert.deepEqual([first.months, first.amountCents, first.projection12Cents, first.devices], [7, 42000, 72000, { desks: 2, kiosks: 1, handhelds: 0 }]);
    assert.deepEqual(first.items.find((item: { key: string }) => item.key === 'api'), { key: 'api', quantity: 1, unitCents: 500, amountCents: 500, providers: ['qodeup'] });
    assert.deepEqual(first.items.find((item: { key: string }) => item.key === 'arubaEInvoicing'), { key: 'arubaEInvoicing', quantity: 1, unitCents: 0, amountCents: 0 }, 'an active service that is free is an item');
    assert.equal(reply.body.data.find((line: { placeName: string }) => line.placeName === 'Negozio 9').dealer.id, null);
  });

  it('pages in a stable order with the same totals on every page', async () => {
    const seen: string[] = [];
    let cursor = '';
    for (let page = 0; page < 5; page += 1) {
      const reply = await lines(psa(), `from=2026-05&to=2026-05&limit=3${cursor}`);
      assert.deepEqual(reply.body.totals.places, 7);
      seen.push(...names(reply));
      if (reply.body.page.next === null) {
        break;
      }
      cursor = `&cursor=${reply.body.page.next}`;
    }
    assert.deepEqual(seen, ['Negozio 4', 'Negozio 8', 'Cross', 'Negozio sospeso', 'Negozio 9', 'Negozio 1', 'Negozio 6']);
    for (const bad of ['!!', 'e30', Buffer.from(JSON.stringify({ ver: 1, t: 'x', d: '', g: '', p: '', i: 'a'.repeat(24) })).toString('base64url'), Buffer.from('nope').toString('base64url'), Buffer.from('[]').toString('base64url'), Buffer.from(JSON.stringify({ ver: 1, t: 1, d: '', g: '', p: '', i: 'zz' })).toString('base64url')]) {
      assert.deepEqual(failure(await lines(psa(), `from=2026-05&to=2026-05&cursor=${bad}`)).details, [{ field: 'cursor', issue: 'format' }], bad);
    }
  });

  it('orders by date, then dealer, group and place, and by id when all are equal', async () => {
    const [a1] = office.cluster.groups;
    const same = MAY(25);
    const company0 = (await common().collection('companies').findOne({ groupId: a1!.groupId, trash: false }))!['_id'] as ObjectId;
    await insertCopies(ctx.databases, 'places', [place(a1!.groupId, company0, 'Gemello', same), place(a1!.groupId, company0, 'Gemello', same), place(a1!.groupId, company0, 'Altro', same)]);
    const reply = await lines(psa(), 'from=2026-05&to=2026-05&limit=4');
    assert.deepEqual(names(reply).slice(0, 4), ['Negozio 4', 'Altro', 'Gemello', 'Gemello']);
    const twins = reply.body.data.filter((line: { placeName: string }) => line.placeName === 'Gemello').map((line: { placeId: string }) => line.placeId);
    assert.deepEqual(twins, [...twins].sort());
  });

  it('draws the period at the months of Rome, and the date from the id inside and outside the range', async () => {
    assert.deepEqual(names(await lines(psa(), 'from=2026-06&to=2026-06')), ['Negozio 5']);
    assert.deepEqual(names(await lines(psa(), 'from=2025-12&to=2025-12')), ['Negozio 3']);
    const december = (await lines(psa(), 'from=2025-12&to=2025-12')).body.data[0];
    assert.deepEqual([december.months, december.amountCents, december.monthlyCents], [0, 0, 2000]);
    assert.deepEqual(names(await lines(psa(), 'from=2026-01&to=2026-04')), []);
    assert.ok(names(await lines(psa(), 'from=2026-05&to=2026-06')).includes('Negozio 9'), 'a date from the id inside');
    assert.ok(!names(await lines(psa(), 'from=2026-06&to=2026-07')).includes('Negozio 9'), 'and outside');
    assert.deepEqual(names(await lines(psa(), 'from=2025-12&to=2026-06')).length, 9);
  });

  it('filters by dealer for the PSA, none included, and keeps a dealer to his own lines', async () => {
    assert.deepEqual(names(await lines(psa(), `from=2026-05&to=2026-05&dealerId=${dealerB().toHexString()}`)), ['Negozio 8', 'Cross', 'Negozio 6']);
    const none = await lines(psa(), 'from=2026-05&to=2026-05&dealerId=none');
    assert.deepEqual([names(none), none.body.totals.places], [['Negozio 9'], 1]);
    assert.equal((await lines(psa(), `from=2026-05&to=2026-05&dealerId=${fixtureId('user', 9999).toHexString()}`)).status, 404);
    const own = await lines(dealerA(), 'from=2026-05&to=2026-05');
    assert.deepEqual([names(own), own.body.totals.places], [['Negozio 4', 'Negozio sospeso', 'Negozio 1'], 3]);
    assert.equal((await lines(dealerA(), `from=2026-05&to=2026-05&dealerId=${dealerA().toHexString()}`)).status, 200);
    for (const other of [`dealerId=${dealerB().toHexString()}`, 'dealerId=none']) {
      assert.equal((await lines(dealerA(), `from=2026-05&to=2026-05&${other}`)).status, 403, other);
    }
    assert.equal((await office.call('GET', `/activations/lines.csv?from=2026-05&to=2026-05&dealerId=none`, await as.tokenOf(dealerA()))).status, 403);
    const g = office.cluster.groups[0]!;
    for (const actor of [g.sa, g.ca, g.pa]) {
      assert.equal((await lines(actor, 'from=2026-05&to=2026-05')).status, 403);
    }
    assert.equal((await office.call('GET', '/activations/lines?from=2026-05&to=2026-05', undefined)).status, 401);
  });

  it('prices with the current prices of each dealer, whatever the closures say', async () => {
    await call(psa(), 'PUT', '/activations/renewal-bases/2026');
    await call(psa(), 'PUT', '/activations/closures/2026-06');
    const url = `/dealers/${dealerB().toHexString()}/price-overrides`;
    const etag = (await call(psa(), 'GET', url)).headers.get('etag')!;
    await call(psa(), 'PUT', url, { plans: { 'desk-secondary': 1000 } }, { 'if-match': etag });
    const reply = await lines(psa(), `from=2026-05&to=2026-05&dealerId=${dealerB().toHexString()}`);
    assert.equal(reply.body.data[0].monthlyCents, 1000);
  });

  it('refuses a span that is empty, longer than 24 months, malformed or missing, with 422 on the field', async () => {
    const field = async (query: string) => (failure(await lines(psa(), query)).details as Array<{ field: string }>).map((detail) => detail.field);
    assert.deepEqual(await field('from=2026-06&to=2026-05'), ['to']);
    assert.deepEqual(await field('from=2024-01&to=2026-01'), ['to']);
    assert.equal((await lines(psa(), 'from=2024-02&to=2026-01')).status, 200);
    assert.deepEqual(await field('to=2026-05'), ['from']);
    assert.deepEqual(await field('from=2026-05'), ['to']);
    for (const bad of ['from=2026-13&to=2026-14', 'from=2026-05&to=2026-05&x=1', 'from=2026-05&to=2026-05&limit=101', 'from=2019-12&to=2020-01', 'from=2026-05&to=2026-05&dealerId=zz']) {
      assert.equal((await lines(psa(), bad)).status, 422, bad);
    }
    assert.equal((await office.call('GET', '/activations/lines.csv?from=2026-06&to=2026-05', await as.tokenOf(psa()))).status, 422);
  });

  it('exports the same lines as CSV with the dealer of each line, and refuses more lines than the view holds', async () => {
    const response = await office.call('GET', '/activations/lines.csv?from=2026-05&to=2026-05', await as.tokenOf(psa()));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-disposition'), 'attachment; filename="attivazioni-dettaglio_2026-05_2026-05.csv"');
    const rows = (await response.text()).trim().split('\r\n');
    assert.equal(rows.length, 8);
    assert.deepEqual(new Set(rows.slice(1).map((row) => row.split(';')[0])), new Set(['Rivenditore Alfa', 'Beta Distribuzione', 'Senza rivenditore']));
    assert.ok(rows.some((row) => row.includes('api (qodeup) 5,00')));
    const limited = (maxLines: number) => createActivationsService({ repository: createActivationsRepository(ctx.databases), priceLists: { getPriceList: async () => ({ list: DEFAULT_PRICE_LIST, version: 'v' }) }, activityLog: office.activity, now: () => Date.UTC(2026, 10, 18), limits: { ...DEFAULT_LIMITS, maxLines } });
    const issue = (error: unknown) => error instanceof Error && (error as { details?: Array<{ issue: string }> }).details?.[0]?.issue === 'tooManyLines';
    await assert.rejects(limited(2).detail(principalOf('PSA'), { from: '2026-05', to: '2026-05' }), issue, 'a dealer over the limit');
    await assert.rejects(limited(3).detailPage(principalOf('PSA'), { from: '2026-05', to: '2026-05' }), issue, 'all the dealers together over the limit');
    assert.equal((await limited(7).detail(principalOf('PSA'), { from: '2026-05', to: '2026-05' })).entries.length, 7);
  });
});

describe('the devices and the providers in the lines of a closure', () => {
  it('keeps them in the stored lines, and still reads a closure written before they existed', async () => {
    await call(psa(), 'PUT', '/activations/renewal-bases/2026');
    await call(psa(), 'PUT', '/activations/closures/2026-06');
    const path = `/activations/statements/${dealerA().toHexString()}?month=2026-06&section=activations`;
    const closed = await call(psa(), 'GET', path);
    const first = closed.body.data.find((line: { placeName: string }) => line.placeName === 'Negozio 1');
    assert.deepEqual([first.devices, first.items.find((item: { key: string }) => item.key === 'api').providers], [{ desks: 2, kiosks: 1, handhelds: 0 }, ['qodeup']]);
    await common().collection('billingClosures').updateMany({ kind: 'month' }, { $unset: { 'activations.lines.$[].devices': '' } }, { bypassDocumentValidation: true });
    const older = await call(psa(), 'GET', path);
    assert.ok(older.body.data.length > 0 && older.body.data.every((line: { devices?: unknown }) => line.devices === undefined));
  });
});

