import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Double, Int32, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { expectedCopy, sameDocument } from '../../src/shared/legacy-write/copy-rule.ts';
import { versionOf } from '../../src/shared/legacy-write/version.ts';
import { fixtureId } from '../helpers/legacy-fixtures.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { PRICE_LIST } from '../helpers/place-fixtures.ts';
import { startPlacesWorld } from '../helpers/places.ts';
import type { PlacesWorld } from '../helpers/places.ts';
import { TEST_VERSION_KEY } from '../helpers/version-key.ts';

let ctx: TestDatabases;
let world: PlacesWorld;
const call = (...args: Parameters<PlacesWorld['as']['call']>) => world.as.call(...args);
const failure = (reply: Awaited<ReturnType<typeof call>>) => world.as.failure(reply);
const hex = (id: ObjectId) => id.toHexString();
const P = (n: number): ObjectId => fixtureId('place', n);
const psa = () => world.office.cluster.psa;
const dealer = () => world.office.cluster.dealerA;
const sa = () => world.group(0).sa;
const ca = () => world.group(0).ca;
const pa = () => world.group(0).pa;
const issues = (...details: Array<[string, string]>) => ({ status: 422, code: 'VALIDATION_ERROR', details: details.map(([field, issue]) => ({ field, issue })) });
const path = (id: ObjectId, rest = '') => world.placePath(0, `/${hex(id)}${rest}`);
const groupDb = () => ctx.databases.group(world.group(0).groupId, 'cluster0');
const TEMPLATE = new ObjectId();
const OTHER_TEMPLATE = new ObjectId();
const CATEGORY = new ObjectId();
const stored = async (id: ObjectId): Promise<Document> => (await world.storedPlace(0, id))!;
const tagOf = async (id: ObjectId): Promise<Record<string, string>> => ({ 'if-match': (await call(psa(), 'GET', path(id))).headers.get('etag')! });
const current = async (id: ObjectId) => (await call(psa(), 'GET', path(id))).body.data;
const put = async (actor: ObjectId, id: ObjectId, segment: string, body: unknown, headers?: Record<string, string>) => call(actor, 'PUT', path(id, `/${segment}`), body, headers ?? (await tagOf(id)));
const patch = async (actor: ObjectId, id: ObjectId, body: unknown, headers?: Record<string, string>) => call(actor, 'PATCH', path(id), body, headers ?? (await tagOf(id)));
/** A stored value with its BSON numbers as plain numbers, to compare the content. */
const js = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

before(async () => {
  ctx = await openTestDatabases();
  world = await startPlacesWorld(ctx);
  await world.seed(0, 20);
  await world.seedPlace(0, 100, 1);
  await world.seedPlace(0, 101, 1);
  await world.seedPlace(0, 102, 20);
  await groupDb().collection('email_templates').insertMany([{ _id: TEMPLATE, name: 'T', text: '', html: '' }, { _id: OTHER_TEMPLATE, name: 'U', text: '', html: '' }]);
  await groupDb().collection('products_categories').insertOne({ _id: CATEGORY, name: 'Bevande', trash: false });
  await ctx.databases.common().collection('groups').updateOne({ _id: world.group(0).groupId }, { $set: { 'settings.languages': ['it', 'en', 'de'] } });
});
after(async () => {
  await world.office.close();
  await ctx.cleanup();
});

/** One settings tab: how its `PUT` is reached, what a test changes in the block a `GET` returns, and what the stored document must show afterwards. */
interface Case {
  readonly block: string;
  readonly segment: string;
  readonly change: (block: any) => void;
  readonly check: (document: Document, before: Document) => void;
}

const CASES: readonly Case[] = [
  {
    block: 'cashSettings',
    segment: 'settings/cash',
    change: (b) => Object.assign(b, { fastLogin: true, chargeDocumentQt: 3, totalRounding: 0.05, operatingTime: '03:30', customDiscount: '5;10', workshiftNames: ['Pranzo', 'Cena'], localWarehouseOutOfStock: 'alert', receiptsCancellation: 'sync', advancedReportLogs: true }),
    check: (d) => {
      const general = d['general'] as Document;
      assert.deepEqual([general['fastLogin'], general['operatingTime'], general['customDiscount'], general['workshiftNames'], general['localWarehouseOutOfStock'], general['receiptsCancellation'], general['unknownGeneral']], [true, '03:30', '5;10', ['Pranzo', 'Cena'], 'alert', 'sync', 'keep']);
      assert.ok(general['chargeDocumentQt'] instanceof Int32 && general['chargeDocumentQt'].value === 3);
      assert.ok(general['totalRounding'] instanceof Double && general['totalRounding'].value === 0.05);
      assert.equal((d['advancedReport'] as Document)['logs'], true);
      assert.deepEqual((general['priceLists'] as Document[]).length, 1);
    },
  },
  {
    block: 'printing',
    segment: 'settings/printing',
    change: (b) => {
      b.receipt.noFiscalTaxes = true;
      b.receipt.invoiceQt = 2;
      b.receipt.noFiscalBottomText = 'Grazie';
      b.prebilling.titleFontSize = '2-2';
      b.ordering.numberFontSize = '3-3';
      b.ordering.productsSorting = 'alphabetical';
      b.ordering.tableText = 'Tavolo';
      b.ordering.productsCode = true;
    },
    check: (d) => {
      const [receipt, prebilling, ordering] = ['receipt', 'prebilling', 'ordering'].map((key) => d[key] as Document);
      assert.deepEqual([receipt!['noFiscalTaxes'], receipt!['noFiscalBottomText'], receipt!['unknownReceipt'], prebilling!['titleFontSize'], ordering!['numberFontSize'], ordering!['productsSorting'], ordering!['tableText'], ordering!['productsCode']], [true, 'Grazie', 'keep', '2-2', '3-3', 'alphabetical', 'Tavolo', true]);
      assert.ok(receipt!['invoiceQt'] instanceof Int32 && receipt!['invoiceQt'].value === 2);
      // The historical keys of the ordering stay.
      assert.deepEqual([ordering!['fontSize'], ordering!['sequentialNumber']], ['1-1', true]);
    },
  },
  {
    block: 'payments',
    segment: 'settings/payments',
    change: (b) => {
      b.defaultType = 'electronic';
      b.cheque = true;
      b.paymentTypes.push({ name: 'Carta', cash: false, electronic: true, cheque: false, tickets: false, electronicInvoiceMode: 'MP08' });
    },
    check: (d) => {
      const payments = d['payments'] as Document;
      assert.deepEqual([payments['defaultType'], payments['cheque'], payments['paymentDiscountAuto']], ['electronic', true, false]);
      const types = d['paymentTypes'] as Document[];
      assert.equal(types.length, 2);
      assert.equal(types[0]!['id'], 'pt1');
      assert.match(types[1]!['id'] as string, /^[0-9a-z]{7}\d+$/);
      assert.deepEqual(types[1]!['fattura_elettronica'], { ModalitaPagamento: 'MP08' });
      assert.deepEqual(types[0]!['fattura_elettronica'], { ModalitaPagamento: 'MP01' });
    },
  },
  {
    block: 'tables',
    segment: 'settings/tables',
    change: (b) => Object.assign(b, { exitsNumber: 7, halfPortionValue: 3, tipValues: [{ type: 'p', value: 10 }, { type: 'v', value: 2.5 }], tableGroups: { status: true, name: true, autoCreateFirst: false } }),
    check: (d) => {
      const rooms = d['roomsSettings'] as Document;
      assert.ok(rooms['exitsNumber'] instanceof Int32 && rooms['exitsNumber'].value === 7);
      assert.deepEqual(js(rooms['tipValues']), [{ type: 'p', value: 10 }, { type: 'v', value: 2.5 }]);
      // The copy of the ordering flag is the one of the ordering block (off in the fixture), whatever the groups had.
      assert.deepEqual(rooms['tableGroups'], { status: true, name: true, autoCreateFirst: false, mergeProductsPrint: false });
      assert.equal(rooms['tableGroupName'], true);
      // The reservations and the keys of other writers are not touched.
      assert.deepEqual([(rooms['reservation'] as Document)['suspendedToday'], (rooms['reservation'] as Document)['unknownReservation'] instanceof Int32], [true, true]);
    },
  },
  {
    block: 'reservations',
    segment: 'settings/reservations',
    change: (b) => {
      Object.assign(b, { status: true, step: 1800000, untilHours: '17:30', suspendedToday: false, timeBlocks: [{ weekDays: [1, 2], start: '09:00', end: '12:00' }] });
      Object.assign(b.webWidget, { status: true, color: '#112233', brightness: 'dark' });
      Object.assign(b.emailNotification, { status: true, to: 'owner@example.test', templateId: hex(TEMPLATE), subject: 'Nuova' });
      b.emailChangeStatus.templateId = hex(OTHER_TEMPLATE);
    },
    check: (d) => {
      const reservation = (d['roomsSettings'] as Document)['reservation'] as Document;
      assert.deepEqual([reservation['status'], reservation['untilHours'], reservation['suspendedToday'], js(reservation['timeBlocks'])], [true, '17:30', false, [{ weekDays: [1, 2], start: '09:00', end: '12:00' }]]);
      assert.ok(reservation['step'] instanceof Int32 && reservation['step'].value === 1800000);
      assert.deepEqual(reservation['webWidget'], { status: true, color: '#112233', brightness: 'dark' });
      const notification = reservation['emailNotification'] as Document;
      assert.ok((notification['templateId'] as ObjectId).equals(TEMPLATE));
      assert.deepEqual([notification['to'], notification['subject']], ['owner@example.test', 'Nuova']);
      assert.ok(((reservation['emailChangeStatus'] as Document)['templateId'] as ObjectId).equals(OTHER_TEMPLATE));
      assert.equal(reservation['unknownReservation'] instanceof Int32, true);
    },
  },
  {
    block: 'delivery',
    segment: 'settings/delivery',
    change: (b) => {
      Object.assign(b.takeAway, { status: true, autoOrderingTime: 15, deliveryListId: PRICE_LIST, sendOrderOnSave: 'always', shippingCosts: [{ taxed: 2.5, toKm: 5 }] });
      Object.assign(b, { radius: 3.5, lat: 45.5, lng: 9.2, minAmount: { EUR: 12, USD: 3 } });
    },
    check: (d) => {
      const take = d['deliveryTakeAway'] as Document;
      assert.deepEqual([take['status'], take['deliveryListId'], take['takeAwayListId'], take['sendOrderOnSave'], js(take['shippingCosts']), take['unknownTake'] instanceof Int32], [true, PRICE_LIST, '', 'always', [{ taxed: 2.5, toKm: 5 }], true]);
      assert.ok(take['autoOrderingTime'] instanceof Int32);
      const delivery = d['delivery'] as Document;
      assert.ok(delivery['radius'] instanceof Double && delivery['radius'].value === 3.5);
      const minimum = delivery['minAmount'] as Document;
      assert.deepEqual([(minimum['EUR'] as Document)['code'], js((minimum['USD'] as Document)['value'])], ['EUR', 3]);
      assert.ok((minimum['EUR'] as Document)['value'] instanceof Int32);
      // The hours of the delivery (step 7A) are not touched, and the deprecated copies follow the block.
      assert.equal(Object.keys((delivery['time'] as { weekGeneric: object }).weekGeneric).length, 7);
      const rooms = d['roomsSettings'] as Document;
      assert.deepEqual([rooms['delivery'], rooms['deliveryAutoOrderingTime'] instanceof Int32 && rooms['deliveryAutoOrderingTime'].value, rooms['deliverySendPrebillingOnSave']], [true, 15, false]);
    },
  },
  {
    block: 'selfOrdering',
    segment: 'settings/self-ordering',
    change: (b) => {
      Object.assign(b, { status: true, fixedMessage: 'Benvenuti', additionalInfoLabel: 'Info' });
      b.priceListsConfig = { [PRICE_LIST]: { roundTime: 30, roundMaxProducts: 5, totalMaxProducts: null, variants: true, freeVariants: false, tableAutoClose: true, productsCategories: [{ _id: hex(CATEGORY), roundMaxProducts: 2, totalMaxProducts: null, position: 1, purchasable: true }] } };
    },
    check: (d) => {
      const self = d['selfOrdering'] as Document;
      assert.deepEqual([self['status'], self['fixedMessage'], self['unknownSelfOrdering'] instanceof Int32], [true, 'Benvenuti', true]);
      const config = (self['priceListsConfig'] as Document)[PRICE_LIST] as Document;
      assert.deepEqual([config['roundTime'] instanceof Int32, config['totalMaxProducts'], config['tableAutoClose'], (config['productsCategories'] as Document[])[0]!['_id']], [true, null, true, hex(CATEGORY)]);
    },
  },
  {
    block: 'kiosk',
    segment: 'settings/kiosk',
    change: (b) => {
      Object.assign(b, { mode: 'catalog', listId: PRICE_LIST, upsellingCategoryId: hex(CATEGORY), productsCategories: [{ _id: hex(CATEGORY), position: 1 }], backgroundColor: '#000000', idleTimeAlert: 30, hidePhotos: true });
      b.titleText = { it: 'Ciao', en: 'Hi' };
    },
    check: (d) => {
      const kiosk = d['kiosk'] as Document;
      assert.deepEqual([kiosk['mode'], kiosk['listId'], kiosk['upsellingCategoryId'], js(kiosk['productsCategories']), kiosk['backgroundColor'], kiosk['hidePhotos'], kiosk['titleText'], kiosk['subTitleText']], ['catalog', PRICE_LIST, hex(CATEGORY), [{ _id: hex(CATEGORY), position: 1 }], '#000000', true, { it: 'Ciao', en: 'Hi' }, { it: '' }]);
      assert.ok(kiosk['idleTimeAlert'] instanceof Int32);
      assert.equal(JSON.stringify(kiosk['unknownKiosk']), JSON.stringify({ keep: [1] }));
    },
  },
  {
    block: 'appointments',
    segment: 'settings/appointments',
    change: (b) => Object.assign(b, { staffChoice: true, step: 30, maxDaily: 12, type: 'multiple', email: { templateId: hex(TEMPLATE), from: 'info@example.test', subject: 'Conferma' } }),
    check: (d) => {
      const appointment = d['appointment'] as Document;
      assert.deepEqual([appointment['staffChoice'], appointment['type'], appointment['webWidgetStatus'], appointment['unknownAppointment'] instanceof Int32], [true, 'multiple', false, true]);
      assert.ok(appointment['step'] instanceof Int32 && appointment['maxDaily'] instanceof Int32);
      const email = appointment['email'] as Document;
      assert.ok((email['templateId'] as ObjectId).equals(TEMPLATE));
      assert.deepEqual([email['from'], email['subject']], ['info@example.test', 'Conferma']);
    },
  },
  {
    block: 'externalDisplay',
    segment: 'settings/external-display',
    change: (b) => Object.assign(b, { tips: true, backgroundColor: '#000000' }),
    check: (d) => assert.deepEqual([(d['externalDisplay'] as Document)['tips'], (d['externalDisplay'] as Document)['backgroundColor'], (d['externalDisplay'] as Document)['textColor'], Number((d['externalDisplay'] as Document)['unknownDisplay'])], [true, '#000000', '#F8F9FA', 1]),
  },
  {
    block: 'fidelity',
    segment: 'settings/fidelity',
    change: (b) => Object.assign(b, { type: 'advanced', showPoints: true }),
    check: (d) => assert.deepEqual([(d['fidelity'] as Document)['type'], (d['fidelity'] as Document)['showPoints']], ['advanced', true]),
  },
  {
    block: 'tobacco',
    segment: 'settings/tobacco',
    change: (b) => Object.assign(b, { status: true, companyId: hex(fixtureId('company', 1)), placeId: hex(P(101)), printProductsOnReceipt: true, winningsManagement: false }),
    check: (d) => {
      const tgm = d['tgm'] as Document;
      assert.deepEqual([tgm['status'], tgm['printProductsOnReceipt'], tgm['winningsManagement'], Number(tgm['unknownTgm'])], [true, true, false, 1]);
      assert.ok((tgm['companyId'] as ObjectId).equals(fixtureId('company', 1)) && (tgm['placeId'] as ObjectId).equals(P(101)));
    },
  },
  {
    block: 'media',
    segment: 'media',
    change: (b) => Object.assign(b, { externalUrl: 'https://example.test/bar.png', internalFileName: 'logo.png', externalUrlLogo: 'https://example.test/l.png' }),
    check: (d) => {
      const images = (d['medias'] as { images: Document }).images;
      assert.deepEqual([images['externalUrl'], images['internalFileName'], images['externalUrlLogo'], images['logoLight'], Number(images['unknownImage'])], ['https://example.test/bar.png', 'logo.png', 'https://example.test/l.png', null, 1]);
    },
  },
];

describe('the settings blocks: PUT, PATCH, exact types, keys of other writers', () => {
  for (const settings of CASES) {
    it(`${settings.block}: a PUT of the block as it is read changes nothing; a PUT with changes writes only its keys, in the form of the old backoffice, and the same changes in the PATCH are the same write`, async () => {
      const read = await call(psa(), 'GET', path(P(100)));
      const unchanged = await call(psa(), 'PUT', path(P(100), `/${settings.segment}`), read.body.data[settings.block], { 'if-match': read.headers.get('etag')! });
      assert.equal(unchanged.status, 200, JSON.stringify(unchanged.body));
      assert.equal(unchanged.headers.get('etag'), read.headers.get('etag'), 'nothing is written for a block sent back as it is');
      const before = await stored(P(100));
      const block = JSON.parse(JSON.stringify(read.body.data[settings.block]));
      settings.change(block);
      const reply = await put(psa(), P(100), settings.segment, block);
      assert.equal(reply.status, 200, JSON.stringify(reply.body));
      const after = await stored(P(100));
      settings.check(after, before);
      assert.equal(reply.headers.get('etag'), `"${versionOf('places', after, TEST_VERSION_KEY)}"`);
      assert.ok(sameDocument(expectedCopy(after, world.group(0).groupId), (await world.copyOfPlace(P(100)))!));
      // What the POS and the legacy own is byte for byte what it was.
      for (const key of ['devices', 'rooms', 'storages', 'integrations', 'server', 'connectorAddress', 'futureBlock', 'printStations']) {
        assert.ok(sameDocument({ v: before[key] }, { v: after[key] }), key);
      }
      // The block that was read back is the block that was sent (ids made by the server aside), and a second PUT of it is no change.
      const reread = await call(psa(), 'GET', path(P(100)));
      const again = await call(psa(), 'PUT', path(P(100), `/${settings.segment}`), reread.body.data[settings.block], { 'if-match': reread.headers.get('etag')! });
      assert.equal(again.headers.get('etag'), reread.headers.get('etag'));
      // The same changes through the unique PATCH, on another place of the same shape, write the same keys.
      const twin = await call(psa(), 'GET', path(P(101)));
      const twinBlock = JSON.parse(JSON.stringify(reread.body.data[settings.block]));
      if (settings.block === 'payments') {
        // The ids the server made for the first place are not ids of the twin: its new type is sent without one.
        twinBlock.paymentTypes = twinBlock.paymentTypes.map((type: { id: string }) => (type.id === 'pt1' ? type : { ...type, id: undefined }));
      }
      const patched = await call(psa(), 'PATCH', path(P(101)), { [settings.block]: twinBlock }, { 'if-match': twin.headers.get('etag')! });
      assert.equal(patched.status, 200, JSON.stringify(patched.body));
      settings.check(await stored(P(101)), before);
    });

    it(`${settings.block}: needs the version, refuses a stale one and the keys of other blocks, and is not reachable outside the perimeter`, async () => {
      const body = (await current(P(102)))[settings.block];
      assert.deepEqual(failure(await call(psa(), 'PUT', path(P(102), `/${settings.segment}`), body, {})), issues(['If-Match', 'required']));
      assert.equal(failure(await call(psa(), 'PUT', path(P(102), `/${settings.segment}`), body, { 'if-match': `"${'A'.repeat(43)}"` })).status, 412);
      assert.equal(failure(await put(psa(), P(102), settings.segment, { ...body, unknownKey: 1 })).status, 422);
      assert.equal(failure(await put(psa(), P(102), settings.segment, {})).status, 422);
      // A company administrator of company 1 and the place administrator do not reach a place of company 20; nobody reaches another group.
      for (const actor of [ca(), pa()]) {
        assert.equal(failure(await put(actor, P(102), settings.segment, body)).status, 404);
      }
      assert.equal(failure(await call(world.group(1).sa, 'PUT', world.placePath(0, `/${hex(P(102))}/${settings.segment}`), body, await tagOf(P(102)))).status, 404);
      assert.equal((await world.office.call('PUT', path(P(102), `/${settings.segment}`), undefined, body)).status, 401);
    });
  }

  it('lets a company administrator and the place administrator write every block of their places (the permission is the one to modify the place)', async () => {
    const own = world.group(0).ownPlaceId;
    for (const settings of CASES) {
      const read = await call(ca(), 'GET', path(P(101)));
      assert.equal((await call(ca(), 'PUT', path(P(101), `/${settings.segment}`), read.body.data[settings.block], { 'if-match': read.headers.get('etag')! })).status, 200, settings.block);
    }
    const own1 = await call(pa(), 'GET', path(own));
    assert.equal(own1.status, 200);
    assert.equal((await call(pa(), 'PUT', path(own, '/settings/fidelity'), { type: 'base', showPoints: false, showPointsCheckout: false, printDataOnFiscalReceipt: false, printDataOnReceipt: false }, { 'if-match': own1.headers.get('etag')! })).status, 200);
  });

  it('writes nothing for a modification that changes no setting, and names the changed blocks in the log without values', async () => {
    const mark = world.office.activity.entries.length;
    const read = await current(P(101));
    assert.equal((await patch(psa(), P(101), { kiosk: { mode: read.kiosk.mode }, cashSettings: { fastLogin: read.cashSettings.fastLogin } })).status, 200);
    assert.deepEqual(world.office.activity.entries.slice(mark).filter((entry) => entry.action === 'place.updated'), []);
    assert.equal((await patch(psa(), P(101), { kiosk: { hidePhotos: false, titleText: { it: 'Segreto-del-kiosk' } }, printing: { ordering: { tableText: 'Valore-segreto' } }, cashSettings: { fastLogin: false } })).status, 200);
    const [entry] = world.office.activity.entries.slice(mark).filter((item) => item.action === 'place.updated');
    assert.deepEqual(entry!.changes, [{ field: 'cashSettings', redacted: true }, { field: 'printing', redacted: true }, { field: 'kiosk', redacted: true }]);
    assert.ok(!JSON.stringify(entry).includes('segret'));
  });
});

describe('the settings blocks: the creation', () => {
  it('accepts the settings of every block in the creation and writes them over the template', async () => {
    const reply = await call(dealer(), 'POST', world.placePath(0), {
      name: 'Settings Create',
      companyId: hex(fixtureId('company', 1)),
      address: { street: 's', postcode: 'p', city: 'c', province: 'MI', country: 'IT' },
      kiosk: { mode: 'catalog', titleText: { it: 'Ciao' } },
      delivery: { takeAway: { status: true, autoOrderingTime: 20 }, minAmount: { EUR: 5 } },
      printing: { ordering: { mergeProductsPrint: true } },
      tables: { tableGroups: { status: true, name: true, autoCreateFirst: false } },
      payments: { paymentTypes: [{ name: 'Contanti', cash: true, electronic: false, cheque: false, tickets: false, electronicInvoiceMode: 'MP01' }] },
    });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    const document = await stored(ObjectId.createFromHexString(reply.body.data.id));
    const rooms = document['roomsSettings'] as Document;
    assert.deepEqual([(document['kiosk'] as Document)['mode'], (document['kiosk'] as Document)['titleText'], rooms['delivery'], rooms['tableGroups'], rooms['tableGroupName']], ['catalog', { it: 'Ciao' }, true, { status: true, name: true, autoCreateFirst: false, mergeProductsPrint: true }, true]);
    assert.equal(Number(rooms['deliveryAutoOrderingTime']), 20);
    assert.equal((document['paymentTypes'] as Document[])[0]!['name'], 'Contanti');
    assert.match((document['paymentTypes'] as Document[])[0]!['id'] as string, /^[0-9a-z]{7}\d+$/);
    assert.equal((document['ordering'] as Document)['mergeProductsPrint'], true);
    // Everything else is still the complete template.
    assert.equal(Object.keys(document['general'] as object).length, 31);
    assert.equal(Object.keys(document['ordering'] as object).length, 74);
  });
});

describe('the settings blocks: the rules of each', () => {
  it('derives the deprecated keys as the form does: the take-away copies, the table groups with the merge flag of the ordering', async () => {
    const id = P(101);
    const groups = (await current(id)).tables.tableGroups;
    assert.equal((await patch(psa(), id, { printing: { ordering: { mergeProductsPrint: true } } })).status, 200);
    let rooms = (await stored(id))['roomsSettings'] as Document;
    assert.deepEqual(rooms['tableGroups'], { ...groups, mergeProductsPrint: true });
    assert.equal(rooms['tableGroupName'], groups.name);
    assert.equal((await patch(psa(), id, { tables: { tableGroups: { status: false, name: false, autoCreateFirst: true } } })).status, 200);
    rooms = (await stored(id))['roomsSettings'] as Document;
    assert.deepEqual([rooms['tableGroups'], rooms['tableGroupName']], [{ status: false, name: false, autoCreateFirst: true, mergeProductsPrint: true }, false]);
    assert.equal((await patch(psa(), id, { printing: { ordering: { mergeProductsPrint: false } } })).status, 200);
    assert.deepEqual(((await stored(id))['roomsSettings'] as Document)['tableGroups'], { status: false, name: false, autoCreateFirst: true, mergeProductsPrint: false });
    assert.equal((await patch(psa(), id, { delivery: { takeAway: { autoOrderingTime: null, sendPrebillingOnSave: true } } })).status, 200);
    rooms = (await stored(id))['roomsSettings'] as Document;
    assert.deepEqual([rooms['deliveryAutoOrderingTime'], rooms['deliverySendPrebillingOnSave']], [null, true]);
  });

  it('reads the historical boolean of the table groups and replaces it with the object when the tables are written', async () => {
    await world.seedPlace(0, 110, 1, { roomsSettings: { tableGroups: true, exits: true } });
    assert.deepEqual((await current(P(110))).tables.tableGroups, { status: true, name: false, autoCreateFirst: false });
    assert.equal((await patch(psa(), P(110), { tables: { exits: false } })).status, 200);
    assert.equal(((await stored(P(110)))['roomsSettings'] as Document)['tableGroups'], true, 'untouched while the groups are not written');
    assert.equal((await patch(psa(), P(110), { printing: { ordering: { mergeProductsPrint: true } } })).status, 200);
    assert.deepEqual(((await stored(P(110)))['roomsSettings'] as Document)['tableGroups'], { status: true, name: false, autoCreateFirst: false, mergeProductsPrint: true });
  });

  it('writes the reservations even when the POS has written suspendedToday: a write of the POS to it is a 412, one to devices[i].info is not', async () => {
    const tag = await tagOf(P(101));
    await groupDb().collection('places').updateOne({ _id: P(101) }, { $set: { 'devices.0.info.os': 'by the POS', updateDate: new Date() } });
    assert.equal((await patch(psa(), P(101), { externalDisplay: { tips: true } }, tag)).status, 200);
    const late = await tagOf(P(101));
    await groupDb().collection('places').updateOne({ _id: P(101) }, { $set: { 'roomsSettings.reservation.suspendedToday': true } });
    const stale = await call(psa(), 'PUT', path(P(101), '/settings/reservations'), (await current(P(101))).reservations, late);
    assert.equal(stale.status, 412);
    // The suspension is writable by the new backend with a dotted write.
    assert.equal((await patch(psa(), P(101), { reservations: { suspendedToday: false } })).status, 200);
    assert.equal((((await stored(P(101)))['roomsSettings'] as Document)['reservation'] as Document)['suspendedToday'], false);
  });

  it('checks the e-mail templates in the group where they change: reservations and appointments', async () => {
    const missing = hex(new ObjectId());
    assert.deepEqual(failure(await patch(psa(), P(101), { reservations: { email: { templateId: missing }, emailRefusedStatus: { templateId: hex(TEMPLATE) } } })), issues(['reservations.email.templateId', 'incorrect']));
    assert.deepEqual(failure(await patch(psa(), P(101), { appointments: { email: { templateId: missing } } })), issues(['appointments.email.templateId', 'incorrect']));
    assert.equal((await patch(psa(), P(101), { appointments: { email: { templateId: null } } })).status, 200);
  });

  it('checks the price lists, the currencies and the categories where they change', async () => {
    assert.deepEqual(failure(await patch(psa(), P(101), { delivery: { takeAway: { takeAwayListId: 'nope' }, minAmount: { ZZZ: 1 } } })), issues(['delivery.takeAway.takeAwayListId', 'incorrect'], ['delivery.minAmount.ZZZ', 'incorrect']));
    assert.deepEqual(failure(await patch(psa(), P(101), { kiosk: { listId: 'nope', upsellingCategoryId: hex(new ObjectId()), productsCategories: [{ _id: hex(CATEGORY), position: 1 }, { _id: 'not-hex', position: null }] } })), issues(['kiosk.listId', 'incorrect'], ['kiosk.upsellingCategoryId', 'incorrect'], ['kiosk.productsCategories.1._id', 'incorrect']));
    assert.deepEqual(
      failure(await patch(psa(), P(101), { selfOrdering: { priceListsConfig: { nope: { roundTime: null, roundMaxProducts: null, totalMaxProducts: null, variants: false, freeVariants: false, tableAutoClose: false, productsCategories: [] }, [PRICE_LIST]: { roundTime: null, roundMaxProducts: null, totalMaxProducts: null, variants: false, freeVariants: false, tableAutoClose: false, productsCategories: [{ _id: hex(new ObjectId()), roundMaxProducts: null, totalMaxProducts: null, position: null, purchasable: false }] } } } })),
      issues(['selfOrdering.priceListsConfig.nope', 'incorrect'], [`selfOrdering.priceListsConfig.${PRICE_LIST}.productsCategories.0._id`, 'incorrect']),
    );
    // A currency the place already has is not judged again, and the currencies it has besides stay.
    assert.equal((await patch(psa(), P(101), { delivery: { minAmount: { USD: 4 } } })).status, 200);
    const minimum = ((await stored(P(101)))['delivery'] as Document)['minAmount'] as Document;
    assert.deepEqual(Object.keys(minimum).sort(), ['EUR', 'USD']);
  });

  it('keeps the languages of the kiosk the group does not have, and refuses a new language the group lacks', async () => {
    await groupDb().collection('places').updateOne({ _id: P(101) }, { $set: { 'kiosk.titleText': { it: 'Ciao', fr: 'Salut' } } });
    assert.deepEqual(failure(await patch(psa(), P(101), { kiosk: { titleText: { ru: 'x' } } })), issues(['kiosk.titleText.ru', 'incorrect']));
    assert.equal((await patch(psa(), P(101), { kiosk: { titleText: { de: 'Hallo', fr: 'Salut' } } })).status, 200);
    assert.deepEqual(((await stored(P(101)))['kiosk'] as Document)['titleText'], { it: 'Ciao', fr: 'Salut', de: 'Hallo' });
  });

  it('tolerates the object that 26 documents have as additionalInfo: read as none, kept unless the client changes it', async () => {
    await world.seedPlace(0, 111, 1, { selfOrdering: { status: false, fixedMessage: null, additionalInfoLabel: { it: 'Info' }, additionalInfo: { it: 'Dettagli' }, priceListsConfig: {} } });
    const read = await current(P(111));
    assert.deepEqual([read.selfOrdering.additionalInfo, read.selfOrdering.additionalInfoLabel], [null, null]);
    assert.equal((await put(psa(), P(111), 'settings/self-ordering', read.selfOrdering)).status, 200);
    assert.deepEqual(((await stored(P(111)))['selfOrdering'] as Document)['additionalInfo'], { it: 'Dettagli' });
    assert.equal((await patch(psa(), P(111), { selfOrdering: { additionalInfo: 'Testo' } })).status, 200);
    assert.equal(((await stored(P(111)))['selfOrdering'] as Document)['additionalInfo'], 'Testo');
  });

  it('keeps the ids of the payment types, gives the new ones an id of the legacy form and refuses an id the place does not have or a repeated one', async () => {
    const read = await current(P(101));
    const types = read.payments.paymentTypes;
    assert.equal(types[0].id, 'pt1');
    assert.deepEqual(failure(await patch(psa(), P(101), { payments: { paymentTypes: [...types, { id: 'forged', name: 'X', cash: true, electronic: false, cheque: false, tickets: false, electronicInvoiceMode: null }] } })), issues([`payments.paymentTypes.${String(types.length)}.id`, 'incorrect']));
    assert.deepEqual(failure(await patch(psa(), P(101), { payments: { paymentTypes: [types[0], types[0]] } })), issues(['payments.paymentTypes.1.id', 'incorrect']));
    const added = await patch(psa(), P(101), { payments: { paymentTypes: [{ ...types[0], name: 'Contanti 2' }, { name: 'Buoni', cash: false, electronic: false, cheque: false, tickets: true, electronicInvoiceMode: null }] } });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    assert.deepEqual(added.body.data.payments.paymentTypes.map((type: { id: string }) => type.id).slice(0, 1), ['pt1']);
    assert.match(added.body.data.payments.paymentTypes[1].id, /^[0-9a-z]{7}\d+$/);
  });

  it('reserves webWidgetStatus of the appointments to PSA and D, accepting the value the place has', async () => {
    const block = (await current(P(101))).appointments;
    assert.deepEqual(failure(await put(sa(), P(101), 'settings/appointments', { ...block, webWidgetStatus: true })), { status: 403, code: 'FORBIDDEN', details: [{ field: 'appointments.webWidgetStatus', issue: 'notAllowed' }] });
    assert.equal(failure(await put(ca(), P(101), 'settings/appointments', { ...block, webWidgetStatus: true })).status, 403);
    assert.equal((await put(sa(), P(101), 'settings/appointments', { ...block, staffChoice: true })).status, 200);
    assert.equal((await put(dealer(), P(101), 'settings/appointments', { ...block, staffChoice: true, webWidgetStatus: true })).body.data.appointments.webWidgetStatus, true);
    assert.equal((await put(sa(), P(101), 'settings/appointments', { ...(await current(P(101))).appointments, staffChoice: false })).status, 200);
  });

  it('checks the company and the place of the tobacco shop: of the group, the company inside the perimeter', async () => {
    assert.deepEqual(failure(await patch(psa(), P(101), { tobacco: { companyId: hex(fixtureId('company', 3)), placeId: hex(P(3)) } })), issues(['tobacco.companyId', 'incorrect'], ['tobacco.placeId', 'incorrect']));
    assert.deepEqual(failure(await patch(ca(), P(101), { tobacco: { companyId: hex(fixtureId('company', 2)) } })), issues(['tobacco.companyId', 'incorrect']));
    assert.deepEqual(failure(await patch(psa(), P(101), { tobacco: { placeId: hex(new ObjectId()) } })), issues(['tobacco.placeId', 'incorrect']));
    assert.equal((await patch(psa(), P(101), { tobacco: { companyId: null, placeId: null } })).status, 200);
  });

  it('judges the form of a time, a font size and a color only where the value changes: a historical value comes back unchanged, a new one is refused', async () => {
    await groupDb().collection('places').updateOne({ _id: P(101) }, { $set: { 'receipt.subtotalFontSize': '9-9', 'externalDisplay.backgroundColor': 'red', 'general.operatingTime': '9am', 'roomsSettings.reservation.timeBlocks': [{ weekDays: [1], start: '9', end: 'late' }] } });
    const read = await current(P(101));
    assert.deepEqual([read.printing.receipt.subtotalFontSize, read.externalDisplay.backgroundColor, read.cashSettings.operatingTime], ['1-1', '#8936F7', '9am']);
    // The font and the color are not in the representation as they are stored (a wrong form reads as the default), so only the time and the block come back unchanged.
    assert.equal((await put(psa(), P(101), 'settings/reservations', read.reservations)).status, 200);
    assert.equal((await patch(psa(), P(101), { cashSettings: { operatingTime: '9am', fastLogin: true } })).status, 200);
    assert.deepEqual(
      failure(await patch(psa(), P(101), { cashSettings: { operatingTime: '25:00' }, kiosk: { backgroundColor: 'red' }, printing: { receipt: { subtotalFontSize: '4-1' } }, reservations: { untilHours: '7pm', timeBlocks: [{ weekDays: [1], start: '9', end: '10:00' }] } })),
      issues(['cashSettings.operatingTime', 'pattern'], ['printing.receipt.subtotalFontSize', 'pattern'], ['reservations.untilHours', 'pattern'], ['kiosk.backgroundColor', 'pattern'], ['reservations.timeBlocks.0.start', 'pattern']),
    );
    assert.equal((await patch(psa(), P(101), { cashSettings: { operatingTime: null }, reservations: { timeBlocks: [] } })).status, 200);
  });

  it('lets a place administrator save every block of his own place, the tobacco shop and the appointments too, and refuses another company or place', async () => {
    const own = world.group(0).ownPlaceId;
    const company = hex(fixtureId('company', 1));
    for (const settings of CASES) {
      const read = await call(pa(), 'GET', path(own));
      const reply = await call(pa(), 'PUT', path(own, `/${settings.segment}`), read.body.data[settings.block], { 'if-match': read.headers.get('etag')! });
      assert.equal(reply.status, 200, `${settings.block} ${JSON.stringify(reply.body)}`);
    }
    // The company of his own place counts as inside his scope, and so does his own place; an unchanged value is always accepted.
    assert.equal((await patch(pa(), own, { tobacco: { status: true, companyId: company, placeId: hex(own) } })).status, 200);
    assert.equal((await patch(pa(), own, { tobacco: { companyId: company, printProductsOnReceipt: true } })).status, 200);
    assert.equal((await patch(pa(), own, { appointments: { staffChoice: true, email: { from: 'a@b.test' } } })).status, 200);
    assert.deepEqual(failure(await patch(pa(), own, { tobacco: { companyId: hex(fixtureId('company', 2)) } })), issues(['tobacco.companyId', 'incorrect']));
    assert.deepEqual(failure(await patch(pa(), own, { tobacco: { placeId: hex(P(101)) } })), issues(['tobacco.placeId', 'incorrect']));
    assert.equal((await patch(pa(), own, { tobacco: { companyId: null, placeId: null } })).status, 200);
    // A place administrator whose place has a company other than the one sent gets the refusal; the company administrator keeps his own companies.
    assert.equal((await patch(ca(), P(101), { tobacco: { companyId: company, placeId: hex(P(100)) } })).status, 200);
  });

  it('does not let a company that was refused answer questions: the rules that depend on the company use the one the place has, whether the company sent exists or not', async () => {
    const own = world.group(0).ownPlaceId;
    const answer = async (company: ObjectId) => failure(await patch(pa(), own, { companyId: hex(company), tobacco: { companyId: hex(company) }, media: { logoLight: { imageId: hex(new ObjectId()) } } }));
    const existing = await answer(fixtureId('company', 2));
    const missing = await answer(new ObjectId());
    assert.deepEqual(existing, missing);
    assert.deepEqual(existing.details, [{ field: 'companyId', issue: 'incorrect' }, { field: 'tobacco.companyId', issue: 'incorrect' }, { field: 'media.logoLight', issue: 'incorrect' }]);
  });

  it('does not accept a place in the trash for the tobacco shop, and keeps an unchanged value', async () => {
    const trashed = await world.seedPlace(0, 103, 1, { trash: true });
    assert.deepEqual(failure(await patch(psa(), P(101), { tobacco: { placeId: hex(trashed) } })), issues(['tobacco.placeId', 'incorrect']));
    await groupDb().collection('places').updateOne({ _id: P(101) }, { $set: { 'tgm.placeId': trashed } });
    assert.equal((await patch(psa(), P(101), { tobacco: { placeId: hex(trashed) } })).status, 200);
  });

  it('refuses what the schemas refuse, with the field and the reason, in the PATCH and in the PUT', async () => {
    assert.deepEqual(failure(await patch(psa(), P(101), { cashSettings: { operatingTime: '25:00' }, kiosk: { backgroundColor: 'red', titleText: { 'it.x': 'a' } } })), issues(['kiosk.titleText.(key)', 'forbiddenKey']));
    assert.deepEqual(failure(await patch(psa(), P(101), { delivery: { minAmount: { $ne: 1 } }, printing: { receipt: { subtotalFontSize: '9-9' } } })), issues(['delivery.minAmount.(key)', 'forbiddenKey']));
    assert.equal(failure(await patch(psa(), P(101), { tables: { tipValues: Array.from({ length: 30 }, () => ({ type: 'v', value: 1 })) } })).status, 422);
    assert.equal(failure(await patch(psa(), P(101), { integrations: { dojo: { status: 'yes' } } })).status, 422);
  });
});

describe('the settings blocks: the images of the media block', () => {
  const image = async (overrides: Document = {}): Promise<ObjectId> => {
    const _id = new ObjectId();
    await groupDb().collection('files').insertOne({
      _id,
      groupId: world.group(0).groupId,
      basename: 'cover-1a2b3c4d.png',
      name: 'Cover',
      extension: 'png',
      dirname: '/media/image',
      type: 'image',
      mimetype: 'image/png',
      filectime: new Double(1_731_490_000_123),
      alt: 'Cover alt',
      title: 'Cover title',
      trash: false,
      insertDate: new Date('2024-11-13T10:00:00.000Z'),
      updateDate: new Date('2024-11-13T10:00:00.000Z'),
      ...overrides,
    });
    return _id;
  };

  it('sets a slot from an image of the group, with the descriptor of the legacy built from the stored file, and sends it back unchanged', async () => {
    const picked = await image();
    const reply = await patch(psa(), P(101), { media: { logoLight: { imageId: hex(picked) }, coverKiosk: null } });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const slot = (((await stored(P(101)))['medias'] as { images: Document }).images)['logoLight'] as Document;
    assert.deepEqual(Object.keys(slot), ['_id', 'dirname', 'basename', 'extension', 'filename', 'mimetype', 'filectime', 'mmThumb', 'type', 'title', 'alt']);
    assert.ok(slot['filectime'] instanceof Double && slot['mmThumb'] !== undefined);
    assert.equal(reply.body.data.media.logoLight.basename, 'cover-1a2b3c4d.png');
    const again = await call(psa(), 'PATCH', path(P(101)), { media: { logoLight: reply.body.data.media.logoLight } }, { 'if-match': reply.headers.get('etag')! });
    assert.equal(again.headers.get('etag'), reply.headers.get('etag'));
    assert.deepEqual(failure(await patch(psa(), P(101), { media: { logoKiosk: { ...reply.body.data.media.logoLight, basename: 'forged.png' } } })), issues(['media.logoKiosk', 'notAllowed']));
    assert.deepEqual(failure(await patch(psa(), P(101), { media: { coverLight: { imageId: hex(new ObjectId()) } } })), issues(['media.coverLight', 'incorrect']));
    assert.equal((await patch(psa(), P(101), { media: { logoLight: null } })).status, 200);
  });

  it('lets a company or place administrator use only the images of the company of the place', async () => {
    const own = await image({ companyId: fixtureId('company', 1) });
    const foreign = await image({ companyId: fixtureId('company', 2) });
    const none = await image();
    assert.equal((await patch(ca(), P(101), { media: { productPlaceholderKiosk: { imageId: hex(own) } } })).status, 200);
    for (const imageId of [foreign, none]) {
      assert.deepEqual(failure(await patch(ca(), P(101), { media: { logoKiosk: { imageId: hex(imageId) } } })), issues(['media.logoKiosk', 'incorrect']));
    }
    const mine = world.group(0).ownPlaceId;
    assert.equal((await patch(pa(), mine, { media: { logoLight: { imageId: hex(own) } } })).status, 200);
    assert.deepEqual(failure(await patch(pa(), mine, { media: { logoLight: { imageId: hex(foreign) } } })), issues(['media.logoLight', 'incorrect']));
    assert.equal((await patch(sa(), P(101), { media: { logoKiosk: { imageId: hex(foreign) } } })).status, 200);
  });
});
