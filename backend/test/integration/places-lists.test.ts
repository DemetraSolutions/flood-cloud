import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Double, Int32, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { expectedCopy, sameDocument } from '../../src/shared/legacy-write/copy-rule.ts';
import { fixtureId } from '../helpers/legacy-fixtures.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { PRICE_LIST } from '../helpers/place-fixtures.ts';
import { startPlacesWorld } from '../helpers/places.ts';
import type { PlacesWorld } from '../helpers/places.ts';

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
const stored = async (id: ObjectId): Promise<Document> => (await world.storedPlace(0, id))!;
const tagOf = async (id: ObjectId): Promise<Record<string, string>> => ({ 'if-match': (await call(psa(), 'GET', path(id))).headers.get('etag')! });
const current = async (id: ObjectId) => (await call(psa(), 'GET', path(id))).body.data;
const put = async (actor: ObjectId, id: ObjectId, segment: string, body: unknown, headers?: Record<string, string>) => call(actor, 'PUT', path(id, `/${segment}`), body, headers ?? (await tagOf(id)));
const patch = async (actor: ObjectId, id: ObjectId, body: unknown, headers?: Record<string, string>) => call(actor, 'PATCH', path(id), body, headers ?? (await tagOf(id)));
/** A stored value with its BSON numbers as plain numbers, to compare the content. */
const js = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const CATEGORY = new ObjectId();
const OTHER_CATEGORY = new ObjectId();
const LEGACY_ID = /^[0-9a-z]{7}\d+$/;
/** A place of the plan: a device a POS keeps the `info` and the `status` of. */
const seed = (n: number, overrides: Document = {}) => world.seedPlace(0, n, 1, overrides);
/** The ids of the items of a list of the representation. */
const ids = (items: Array<{ id: string }>) => items.map((item) => item.id);

before(async () => {
  ctx = await openTestDatabases();
  world = await startPlacesWorld(ctx);
  await world.seed(0, 20);
  await ctx.databases.common().collection('groups').updateOne(
    { _id: world.group(0).groupId },
    { $set: { taxes: [{ id: 'tax1', value: 22, department: 1, description: 'IVA 22%', natura: null }], productsFavorites: [{ id: 'fav1', name: 'Preferiti', favorites: [] }] } },
  );
  await groupDb().collection('products_categories').insertMany([{ _id: CATEGORY, name: 'Bevande', trash: false }, { _id: OTHER_CATEGORY, name: 'Dolci', trash: false }]);
});
after(async () => {
  await world.office.close();
  await ctx.cleanup();
});

describe('PUT …/devices', () => {
  it('adds a device with the legacy id and the keys of the old backoffice, creates its status once, and leaves the other devices and what the POS keeps in them byte for byte', async () => {
    await seed(200);
    const before = await stored(P(200));
    const reply = await put(psa(), P(200), 'devices', { items: (await current(P(200))).devices.items.concat([{ name: 'Palmare 2', type: 'handheld' }]) });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const items = reply.body.data.devices.items;
    assert.equal(items.length, 3);
    assert.match(items[2].id, LEGACY_ID);
    assert.deepEqual([items[2].name, items[2].type, items[2].server, items[2].driver, items[2].host, items[2].printStations, items[2].automaticCashPasswordSet], ['Palmare 2', 'handheld', false, '', '', [], false]);
    const after = await stored(P(200));
    const devices = after['devices'] as Document[];
    // The two devices that existed are the very same documents (the exact types and the POS data included).
    assert.ok(sameDocument({ v: (before['devices'] as Document[])[0] }, { v: devices[0] }));
    assert.ok(sameDocument({ v: (before['devices'] as Document[])[1] }, { v: devices[1] }));
    // The new one has the keys of the form, in its order, and the status of a new device (the POS keeps it from then on).
    assert.deepEqual(Object.keys(devices[2]!).slice(0, 5), ['id', 'server', 'type', 'name', 'driver']);
    assert.deepEqual([devices[2]!['id'], devices[2]!['status'], devices[2]!['name'], devices[2]!['printStations']], [items[2].id, { busy: false, userName: '' }, 'Palmare 2', []]);
    assert.ok(!('info' in devices[2]!) && !('__index' in devices[2]!) && !('__printStationsLabels' in devices[2]!));
    assert.ok(sameDocument(expectedCopy(after, world.group(0).groupId), (await world.copyOfPlace(P(200)))!));
    // The activity log names the block and carries no value.
    const entry = world.office.activity.entries.at(-1)!;
    assert.deepEqual([entry.action, entry.changes], ['place.updated', [{ field: 'devices', redacted: true }]]);
  });

  it('is not late after a write of the POS to devices[i].info: no 412, and the new info survives the save', async () => {
    await seed(201);
    const tag = await tagOf(P(201));
    const read = (await current(P(201))).devices.items;
    await groupDb().collection('places').updateOne({ _id: P(201) }, { $set: { 'devices.0.info': { appVersion: '9.9.9', date: new Date('2026-06-01T00:00:00.000Z'), battery: new Double(0.25) }, updateDate: new Date() } });
    const reply = await call(psa(), 'PUT', path(P(201), '/devices'), { items: read.map((device: Document) => ({ ...device, name: device['id'] === 'device1' ? 'Cassa principale' : device['name'] })) }, tag);
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const devices = (await stored(P(201)))['devices'] as Document[];
    assert.equal(devices[0]!['name'], 'Cassa principale');
    assert.deepEqual([(devices[0]!['info'] as Document)['appVersion'], (devices[0]!['info'] as Document)['battery'] instanceof Double], ['9.9.9', true]);
    // Nothing of the item that was not changed is written again: its exact types stay, and so does the key nobody owns.
    assert.equal(devices[0]!['host'], '10.0.0.5');
  });

  it('sends back what the GET returns without writing anything, and keeps the keys nobody owns of every device', async () => {
    await seed(202, { devices: [{ id: 'd1', type: 'desk', name: 'Cassa', mysteryKey: { keep: [1] }, info: { a: 1 } }] });
    const read = await current(P(202));
    const tag = await tagOf(P(202));
    const before = await stored(P(202));
    const reply = await call(psa(), 'PUT', path(P(202), '/devices'), read.devices, tag);
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(reply.headers.get('etag'), tag['if-match']);
    assert.ok(sameDocument(before, await stored(P(202))), 'nothing written');
    // A real change keeps the key nobody owns.
    const renamed = await put(psa(), P(202), 'devices', { items: [{ ...read.devices.items[0], name: 'Cassa 1' }] });
    assert.equal(renamed.status, 200);
    assert.deepEqual(js(((await stored(P(202)))['devices'] as Document[])[0]), { id: 'd1', type: 'desk', name: 'Cassa 1', mysteryKey: { keep: [1] }, info: { a: 1 } });
  });

  it('removes devices (the legacy lets it), refuses to remove a busy one, and refuses ids it does not know or that repeat', async () => {
    await seed(203, { devices: [{ id: 'd1', type: 'desk', name: 'A', status: { busy: false, userName: '' } }, { id: 'd2', type: 'desk', name: 'B', status: { busy: true, userName: 'u' } }, { id: 'd3', type: 'desk', name: 'C' }] });
    const read = (await current(P(203))).devices.items;
    assert.deepEqual(failure(await put(psa(), P(203), 'devices', { items: [read[0], read[2]] })), { status: 409, code: 'CONFLICT', details: [{ field: 'devices.items', issue: 'busy' }] });
    assert.equal((await put(psa(), P(203), 'devices', { items: [read[1], read[2]] })).status, 200);
    assert.deepEqual(ids((await current(P(203))).devices.items), ['d2', 'd3']);
    assert.equal((await put(psa(), P(203), 'devices', { items: [read[1], read[2]] })).status, 200, 'sending the same list again is not a change');
    assert.equal((await put(psa(), P(203), 'devices', { items: [read[1]] })).status, 200, 'a device the POS has not written a status of is removed');
    assert.equal((await put(psa(), P(203), 'devices', { items: [read[1], read[2]] })).status, 422, 'the one removed is not known any more');
    assert.deepEqual(failure(await put(psa(), P(203), 'devices', { items: [{ id: 'nope', name: 'X' }] })), issues(['devices.items.0.id', 'incorrect']));
    assert.deepEqual(failure(await put(psa(), P(203), 'devices', { items: [read[1], { ...read[1] }] })), issues(['devices.items.1.id', 'incorrect']));
    assert.equal((await put(psa(), P(203), 'devices', { items: [] })).status, 409);
    assert.equal((await stored(P(203)))['devices'].length, 1);
  });

  it('writes the credentials of a device but never returns, logs or reports them: a text sets, null clears, leaving it out keeps', async () => {
    await seed(204);
    const mark = world.office.activity.entries.length;
    const read = (await current(P(204))).devices.items;
    assert.equal(read[1].automaticCashPasswordSet, false);
    const set = await put(psa(), P(204), 'devices', { items: [read[0], { ...read[1], automaticCashUsername: 'cash-user', automaticCashPassword: 'cash-pass-123' }] }); // gitleaks:allow (fake test value)
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.deepEqual([set.body.data.devices.items[1].automaticCashUsernameSet, set.body.data.devices.items[1].automaticCashPasswordSet], [true, true]);
    let device = ((await stored(P(204)))['devices'] as Document[])[1]!;
    assert.deepEqual([device['automaticCashUsername'], device['automaticCashPassword']], ['cash-user', 'cash-pass-123']); // gitleaks:allow (fake test value)
    // Left out: kept.
    assert.equal((await put(psa(), P(204), 'devices', { items: [read[0], { ...set.body.data.devices.items[1], name: 'Palmare 1' }] })).status, 200);
    device = ((await stored(P(204)))['devices'] as Document[])[1]!;
    assert.deepEqual([device['name'], device['automaticCashPassword']], ['Palmare 1', 'cash-pass-123']); // gitleaks:allow (fake test value)
    // Sent back as the flags the GET returns: ignored, whatever they say.
    assert.equal((await put(psa(), P(204), 'devices', { items: [read[0], { ...set.body.data.devices.items[1], automaticCashPasswordSet: false }] })).status, 200);
    assert.equal((((await stored(P(204)))['devices'] as Document[])[1]!)['automaticCashPassword'], 'cash-pass-123'); // gitleaks:allow (fake test value)
    // `null` and the empty text clear it.
    const cleared = await put(psa(), P(204), 'devices', { items: [read[0], { ...set.body.data.devices.items[1], automaticCashPassword: null, automaticCashUsername: '' }] });
    assert.deepEqual([cleared.body.data.devices.items[1].automaticCashUsernameSet, cleared.body.data.devices.items[1].automaticCashPasswordSet], [false, false]);
    device = ((await stored(P(204)))['devices'] as Document[])[1]!;
    assert.deepEqual([device['automaticCashUsername'], device['automaticCashPassword']], [null, null]);
    const everything = JSON.stringify([set.body, cleared.body, world.office.activity.entries.slice(mark), world.office.logEvents]);
    for (const secret of ['cash-user', 'cash-pass-123', 'fixture-device-secret', 'fixture-user']) {
      assert.ok(!everything.includes(secret), secret);
    }
    // A value that is too long is refused without echoing it.
    const refused = failure(await put(psa(), P(204), 'devices', { items: [{ ...read[0], automaticCashPassword: 'x'.repeat(101) }] }));
    assert.deepEqual(refused, issues(['items.0.automaticCashPassword', 'maxLength']));
  });

  it('checks the name, the kind of device the plan has, the single server, the references and the drivers where they change', async () => {
    await seed(205, { plan: 'basic', devices: [{ id: 'd1', type: 'desk', name: 'Cassa', server: true, driver: 'legacy-driver' }, { id: 'd2', type: 'kiosk', name: 'Kiosk' }, { id: 'd3', type: 'selfordering', name: 'Old selfordering' }] });
    // A historical driver and a kind of another plan sent back unchanged are accepted.
    const first = (await current(P(205))).devices.items;
    assert.equal((await put(psa(), P(205), 'devices', { items: [{ ...first[0], host: '10.1.1.1' }, first[1], first[2]] })).status, 200);
    const read = (await current(P(205))).devices.items;
    const [cassa, kiosk, old] = read;
    assert.deepEqual(failure(await put(psa(), P(205), 'devices', { items: [cassa, { ...kiosk, name: '  ' }, old] })), issues(['devices.items.1.name', 'required']));
    assert.deepEqual(failure(await put(psa(), P(205), 'devices', { items: [cassa, { ...kiosk, name: 'cassa' }, old] })), issues(['devices.items.1.name', 'taken']));
    assert.deepEqual(failure(await put(psa(), P(205), 'devices', { items: [cassa, kiosk, old, { name: 'Palmare', type: 'handheld' }] })), issues(['devices.items.3.type', 'incorrect']));
    assert.deepEqual(failure(await put(psa(), P(205), 'devices', { items: [cassa, kiosk, old, { name: 'Banco', type: 'desk' }, { name: 'Banco 2', type: 'unknown' }] })), issues(['devices.items.4.type', 'enum'], ['devices.items.4.type', 'incorrect']));
    assert.equal((await put(psa(), P(205), 'devices', { items: [cassa, kiosk, old, { name: 'Banco', type: 'desk' }] })).status, 200);
    assert.deepEqual(failure(await put(psa(), P(205), 'devices', { items: [cassa, { ...kiosk, server: true }, old] })), issues(['devices.items.1.server', 'incorrect']));
    assert.deepEqual(failure(await put(psa(), P(205), 'devices', { items: [{ ...cassa, driver: 'nope', secondaryDriver: 'EPSON-EPOS-PRINT', automaticCashDriver: 'CASHDRO-7' }, kiosk, old] })), issues(['devices.items.0.driver', 'enum']));
    assert.deepEqual(failure(await put(psa(), P(205), 'devices', { items: [{ ...cassa, externalDisplayId: 'd1' }, kiosk, old] })), issues(['devices.items.0.externalDisplayId', 'incorrect']));
    assert.deepEqual(failure(await put(psa(), P(205), 'devices', { items: [{ ...cassa, secondaryCompanyPrinterId: 'd2' }, kiosk, old] })), issues(['devices.items.0.secondaryCompanyPrinterId', 'incorrect']));
    assert.deepEqual(failure(await put(psa(), P(205), 'devices', { items: [{ ...cassa, printStations: ['ps-none'] }, kiosk, old] })), issues(['devices.items.0.printStations.0', 'incorrect']));
    assert.deepEqual(failure(await put(psa(), P(205), 'devices', { items: [{ ...cassa, favoritesId: 'fav-none' }, kiosk, old] })), issues(['devices.items.0.favoritesId', 'incorrect']));
    assert.deepEqual(failure(await put(psa(), P(205), 'devices', { items: [{ ...cassa, host: 'x'.repeat(256) }, kiosk, old] })), issues(['items.0.host', 'maxLength']));
    assert.deepEqual(failure(await put(psa(), P(205), 'devices', { items: [{ ...cassa, unknownKey: 1 }, kiosk, old] })), issues(['items.0.unknownKey', 'unknown']));
  });

  it('keeps the names of the referenced devices and of the favorites list next to the references, and a plan with every kind of device', async () => {
    await seed(206, { plan: 'advanced', devices: [{ id: 'd1', type: 'desk', name: 'Cassa' }, { id: 'd2', type: 'external-display', name: 'Display' }, { id: 'd3', type: 'tgm', name: 'Tabacchi' }] });
    const read = (await current(P(206))).devices.items;
    const reply = await put(psa(), P(206), 'devices', { items: [{ ...read[0], externalDisplayId: 'd2', secondaryCompanyPrinterId: 'd3', favoritesId: 'fav1' }, read[1], read[2]] });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const device = ((await stored(P(206)))['devices'] as Document[])[0]!;
    assert.deepEqual([device['externalDisplayId'], device['externalDisplayName'], device['secondaryCompanyPrinterName'], device['favoritesId'], device['favoritesGroupName']], ['d2', 'Display', 'Tabacchi', 'fav1', 'Preferiti']);
    // Removing the references clears the names; a list without a favorites reference never reads the group.
    const cleared = await put(psa(), P(206), 'devices', { items: [{ ...reply.body.data.devices.items[0], externalDisplayId: '', favoritesId: '' }, read[1], read[2]] });
    assert.equal(cleared.status, 200);
    const again = ((await stored(P(206)))['devices'] as Document[])[0]!;
    assert.deepEqual([again['externalDisplayName'], again['favoritesGroupName'], again['secondaryCompanyPrinterName']], ['', '', 'Tabacchi']);
  });

  it('is the place’s to write: a place administrator for his own, a company administrator for his company, the rest 404; If-Match is required and a stale one is 412', async () => {
    await seed(207);
    const own = world.group(0).ownPlaceId;
    const ownRead = (await call(psa(), 'GET', path(own))).body.data;
    // The own place of the fixtures has devices without an id: its list is read only, the block sent back as it is is nothing.
    assert.equal(ownRead.devices.editable, false);
    const own1 = await put(pa(), own, 'devices', ownRead.devices);
    assert.equal(own1.status, 200, JSON.stringify(own1.body));
    assert.equal((await put(sa(), P(207), 'devices', { items: (await current(P(207))).devices.items })).status, 200);
    assert.equal((await put(ca(), P(207), 'devices', { items: (await current(P(207))).devices.items })).status, 200);
    assert.equal(failure(await put(pa(), P(207), 'devices', { items: [] })).status, 404);
    await world.seedPlace(0, 209, 20);
    assert.equal(failure(await put(ca(), P(209), 'devices', { items: [] })).status, 404, 'a place of another company');
    assert.deepEqual(failure(await call(psa(), 'PUT', path(P(207), '/devices'), { items: [] })), issues(['If-Match', 'required']));
    const stale = await tagOf(P(207));
    await groupDb().collection('places').updateOne({ _id: P(207) }, { $set: { name: 'Changed by the legacy' } });
    assert.equal(failure(await call(psa(), 'PUT', path(P(207), '/devices'), { items: (await current(P(207))).devices.items }, stale)).status, 412);
    assert.ok(world.office.activity.entries.some((entry) => entry.action === 'place.updated'));
  });

  it('refuses what the schema refuses, and saves the devices together with another block through the unique PATCH', async () => {
    await seed(208);
    assert.deepEqual(failure(await put(psa(), P(208), 'devices', {})), issues(['items', 'required']));
    assert.deepEqual(failure(await put(psa(), P(208), 'devices', { items: 'x' })), issues(['items', 'type']));
    assert.deepEqual(failure(await put(psa(), P(208), 'devices', { items: Array.from({ length: 101 }, () => ({})) })), issues(['items', 'tooMany']));
    assert.deepEqual(failure(await put(psa(), P(208), 'devices', { items: [{ id: 'bad id' }] })), issues(['items.0.id', 'pattern']));
    assert.deepEqual(failure(await put(psa(), P(208), 'devices', { items: [{ name: 'x', printStations: ['a', 'a'] }] })), issues(['items.0.printStations.1', 'incorrect']));
    assert.deepEqual(failure(await put(psa(), P(208), 'devices', { items: [{ name: 'x' }], extra: 1 })), issues(['extra', 'unknown']));
    const read = (await current(P(208))).devices.items;
    const reply = await patch(psa(), P(208), { name: 'Both', devices: { items: [{ ...read[0], name: 'Cassa 1' }, read[1]] } });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.deepEqual([reply.body.data.name, reply.body.data.devices.items[0].name], ['Both', 'Cassa 1']);
    assert.deepEqual(world.office.activity.entries.at(-1)!.changes!.map((change) => change.field).sort(), ['devices', 'name']);
  });
});

describe('PUT …/devices: other plans and damaged documents', () => {
  it('gives only the desk to the plans the old backoffice has no other kind of device for, and adds the first device to a place that has no list', async () => {
    await seed(236, { plan: 'enterprice' });
    assert.deepEqual(failure(await put(psa(), P(236), 'devices', { items: [...(await current(P(236))).devices.items, { name: 'Palmare nuovo', type: 'handheld' }] })), issues(['devices.items.2.type', 'incorrect']));
    await groupDb().collection('places').updateOne({ _id: P(236) }, { $unset: { devices: '' } });
    assert.deepEqual((await current(P(236))).devices.items, []);
    assert.equal((await put(psa(), P(236), 'devices', { items: [{ name: 'Cassa', type: 'desk', server: true }] })).status, 200);
    assert.equal(((await stored(P(236)))['devices'] as Document[]).length, 1);
    await groupDb().collection('places').updateOne({ _id: P(236) }, { $set: { devices: 'broken' } });
    assert.equal(failure(await put(psa(), P(236), 'devices', { items: [{ name: 'Cassa 2', type: 'desk' }] })).status, 409);
  });
});

describe('PUT …/print-stations', () => {
  it('adds a station and a production center with the keys of the form, and checks the driver, the host, the categories and the stations', async () => {
    await seed(210);
    const before = await stored(P(210));
    const read = (await current(P(210))).printStations;
    const station = { name: 'Bar', driver: 'ESCPOS', host: '10.0.0.7', pulseNumber: 2, summaryCategoriesIds: [hex(CATEGORY)], summaryPrintStationsIds: [] };
    const reply = await put(psa(), P(210), 'print-stations', { stations: [...read.stations, station], productionCenters: [...read.productionCenters, { name: 'Pizzeria', capacity: 20 }] });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const after = await stored(P(210));
    const [existing, added] = after['printStations'] as Document[];
    // The station that existed is the very same document (its `Int32` and its unknown driver included).
    assert.deepEqual(existing, { id: 'ps1', name: 'Cucina', driver: 'epson', host: '10.0.0.6', pulseNumber: new Int32(1) });
    assert.ok(sameDocument({ v: existing }, { v: (before['printStations'] as Document[])[0] }));
    assert.match(added!['id'] as string, LEGACY_ID);
    assert.deepEqual(Object.keys(added!), ['id', 'name', 'driver', 'host', 'pulseNumber', 'pulseNumberSecondary', 'upsideDown', 'exitsCut', 'summaryCategoriesIds', 'summaryPrintStationsIds']);
    assert.deepEqual(js([added!['name'], added!['pulseNumber'], added!['pulseNumberSecondary'], added!['summaryCategoriesIds']]), ['Bar', 2, null, [hex(CATEGORY)]]);
    assert.ok(added!['pulseNumber'] instanceof Int32 && added!['pulseNumberSecondary'] === null);
    const centers = after['productionCenter'] as Document[];
    assert.deepEqual(centers.map((center) => [center['name'], center['capacity']]).map(([name, capacity]) => [name, Number(capacity)]), [['Forno', 5], ['Pizzeria', 20]]);
    assert.deepEqual(reply.body.data.printStations.stations.map((item: Document) => item['name']), ['Cucina', 'Bar']);
    // A summary may point at another station of the place, or at a category of the group, but not at itself, at nothing, or at another group's.
    const now = reply.body.data.printStations;
    const second = { ...now.stations[1], summaryPrintStationsIds: ['ps1'], summaryCategoriesIds: [hex(CATEGORY), hex(OTHER_CATEGORY)] };
    assert.equal((await put(psa(), P(210), 'print-stations', { ...now, stations: [now.stations[0], second] })).status, 200);
    for (const [change, field] of [
      [{ summaryPrintStationsIds: [now.stations[1].id] }, 'summaryPrintStationsIds.0'],
      [{ summaryPrintStationsIds: ['ghost'] }, 'summaryPrintStationsIds.0'],
      [{ summaryCategoriesIds: [hex(new ObjectId())] }, 'summaryCategoriesIds.0'],
    ] as const) {
      assert.deepEqual(failure(await put(psa(), P(210), 'print-stations', { ...now, stations: [now.stations[0], { ...second, ...change }] })), issues([`printStations.stations.1.${field}`, 'incorrect']), field);
    }
    assert.deepEqual(failure(await put(psa(), P(210), 'print-stations', { ...now, stations: [{ name: '', driver: '', host: '' }] })), issues(['printStations.stations.0.driver', 'required'], ['printStations.stations.0.name', 'required'], ['printStations.stations.0.host', 'required']));
    assert.deepEqual(failure(await put(psa(), P(210), 'print-stations', { ...now, stations: [{ name: 'X', driver: 'WRONG', host: 'h' }] })), issues(['printStations.stations.0.driver', 'enum']));
    assert.deepEqual(failure(await put(psa(), P(210), 'print-stations', { ...now, productionCenters: [{ name: ' ', capacity: 1 }] })), issues(['printStations.productionCenters.0.name', 'required']));
    assert.deepEqual(failure(await put(psa(), P(210), 'print-stations', { ...now, productionCenters: [{ name: 'A', capacity: -1 }] })), issues(['productionCenters.0.capacity', 'minimum']));
    assert.deepEqual(failure(await put(psa(), P(210), 'print-stations', { stations: [] })), issues(['productionCenters', 'required']));
  });
});

describe('PUT …/storages', () => {
  it('keeps the ids as ObjectIds, adds one with a new id, and applies the rules of the legacy: one cash storage, at most one for the e-commerce, at least one storage', async () => {
    await seed(220);
    const before = await stored(P(220));
    const read = (await current(P(220))).storages.items;
    assert.deepEqual(read, [{ id: hex(fixtureId('storage', 220)), name: 'Deposito 1', cash: true, ecommerce: false }]);
    const reply = await put(psa(), P(220), 'storages', { items: [read[0], { name: 'Magazzino web', ecommerce: true }] });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const storages = (await stored(P(220)))['storages'] as Document[];
    assert.ok(storages[0]!['id'] instanceof ObjectId && storages[0]!['id'].equals(fixtureId('storage', 220)));
    assert.ok(storages[1]!['id'] instanceof ObjectId && !storages[1]!['id'].equals(storages[0]!['id']));
    assert.deepEqual(Object.keys(storages[1]!), ['id', 'name', 'cash', 'ecommerce']);
    assert.deepEqual([storages[1]!['name'], storages[1]!['cash'], storages[1]!['ecommerce']], ['Magazzino web', false, true]);
    assert.ok(sameDocument({ v: (before['storages'] as Document[])[0] }, { v: storages[0] }));
    const now = reply.body.data.storages.items;
    // Another storage for the cash desk and the e-commerce moves the flag: the old one must be switched off in the same request.
    assert.deepEqual(failure(await put(psa(), P(220), 'storages', { items: [now[0], { ...now[1], cash: true }] })), issues(['storages.items', 'incorrect']));
    assert.deepEqual(failure(await put(psa(), P(220), 'storages', { items: [{ ...now[0], cash: false }, now[1]] })), issues(['storages.items', 'incorrect']));
    assert.deepEqual(failure(await put(psa(), P(220), 'storages', { items: [now[0], now[1], { name: 'Altro', ecommerce: true }] })), issues(['storages.items.2.ecommerce', 'incorrect']));
    assert.deepEqual(failure(await put(psa(), P(220), 'storages', { items: [] })), issues(['storages.items', 'required']));
    assert.deepEqual(failure(await put(psa(), P(220), 'storages', { items: [now[0], now[1], { name: 'Magazzino WEB' }] })), issues(['storages.items.2.name', 'taken']));
    assert.deepEqual(failure(await put(psa(), P(220), 'storages', { items: [now[0], { id: hex(new ObjectId()), name: 'Ghost' }] })), issues(['storages.items.1.id', 'incorrect']));
    assert.deepEqual(failure(await put(psa(), P(220), 'storages', { items: [{ ...now[0], id: 'zzz' }] })), issues(['items.0.id', 'pattern']));
    // Removing a storage is allowed (the references of the warehouse are not checked yet); moving the flags is one request.
    const moved = await put(psa(), P(220), 'storages', { items: [{ ...now[0], cash: false }, { ...now[1], cash: true, ecommerce: false }] });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    const removed = await put(psa(), P(220), 'storages', { items: [{ ...moved.body.data.storages.items[1], cash: true }] });
    assert.equal(removed.status, 200);
    assert.equal(((await stored(P(220)))['storages'] as Document[]).length, 1);
  });

  it('reads a place whose storages break the rules without failing, and saves it where the rules do not look', async () => {
    await seed(221, { storages: [{ id: fixtureId('storage', 221), name: 'A', cash: true, ecommerce: true }, { id: fixtureId('storage', 222), name: 'B', cash: true, ecommerce: true, legacyKey: 1 }] });
    const read = (await current(P(221))).storages;
    assert.equal(read.items.length, 2);
    assert.equal((await put(psa(), P(221), 'storages', read)).status, 200, 'unchanged');
    assert.equal(failure(await put(psa(), P(221), 'storages', { items: [read.items[0], { ...read.items[1], name: 'B2' }] })).status, 422);
    assert.equal((await put(psa(), P(221), 'storages', { items: [read.items[0], { ...read.items[1], cash: false, name: 'B2' }] })).status, 422);
    assert.equal((await put(psa(), P(221), 'storages', { items: [{ ...read.items[0], ecommerce: false }, { ...read.items[1], cash: false, name: 'B2' }] })).status, 200);
    assert.equal(js((((await stored(P(221)))['storages'] as Document[])[1]!)['legacyKey']), 1);
  });
});

describe('PUT …/rooms', () => {
  const room = { name: 'Sala nuova', tables: [{ name: 'T1', seats: 4 }, { name: 'T2', seats: 2 }] };

  it('adds a room with its tables and the default layout, keeps what the POS keeps in them, and refuses a save made on a copy older than a write of the POS', async () => {
    await seed(230);
    const before = await stored(P(230));
    const read = (await current(P(230))).rooms;
    assert.equal(read.items[0].tables[0].roomId, '');
    const reply = await put(psa(), P(230), 'rooms', { items: [...read.items, room] });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const rooms = (await stored(P(230)))['rooms'] as Document[];
    // The room that existed is the very same document (its `Int32` seats, its `__index` and its keys nobody owns included).
    assert.ok(sameDocument({ v: (before['rooms'] as Document[])[0] }, { v: rooms[0] }));
    const added = rooms[1]!;
    assert.match(added['id'] as string, LEGACY_ID);
    assert.deepEqual(Object.keys(added), ['id', 'name', 'listId', 'service', 'tax', 'deviceId', 'seatsRequest', 'seatsRequired', 'autoService', 'priceListsRequest', 'handheldVisibility', 'printStations', 'tables', 'view']);
    assert.deepEqual(js(added['view']), { type: 'grid', status: false, h: 8, w: 8 });
    const tables = added['tables'] as Document[];
    assert.deepEqual(Object.keys(tables[0]!), ['id', 'roomId', 'name', 'seats', 'userId', 'view']);
    assert.deepEqual(js([tables[0]!['roomId'], tables[0]!['name'], tables[0]!['seats'], tables[0]!['userId'], tables[0]!['view']]), [added['id'], 'T1', 4, '', { w: 1, h: 1, x: null, y: null, shape: 'rect' }]);
    assert.notEqual(tables[0]!['id'], tables[1]!['id']);
    assert.ok(sameDocument(expectedCopy(await stored(P(230)), world.group(0).groupId), (await world.copyOfPlace(P(230)))!));
    // A POS that rewrites the whole `rooms` array between the read and the save makes it a 412; the legacy is last-writer-wins, the POS is not allowed to be.
    const tag = await tagOf(P(230));
    await groupDb().collection('places').updateOne({ _id: P(230) }, { $set: { rooms: (await stored(P(230)))['rooms'], updateDate: new Date() }, $unset: {} });
    assert.equal((await call(psa(), 'PUT', path(P(230), '/rooms'), { items: [] }, tag)).status, 200, 'a rewrite with the same content is not a change');
    const stale = await tagOf(P(230));
    await groupDb().collection('places').updateOne({ _id: P(230) }, { $set: { 'rooms.1.view.subtables': { 'x-1': { x: 1, y: 1, w: 1, h: 1 } } } });
    assert.equal(failure(await call(psa(), 'PUT', path(P(230), '/rooms'), { items: (await current(P(230))).rooms.items }, stale)).status, 412);
  });

  it('keeps the subtables and the keys nobody owns of every room and table, and writes only the keys that changed', async () => {
    const subtables = { 'T1-1': { x: 2, y: 2, w: 1, h: 1 } };
    await seed(231, {
      rooms: [
        { id: 'r1', name: 'Sala', listId: '', service: new Double(10), tax: '', deviceId: '', tables: [{ id: 't1', roomId: 'r1', name: 'T1', seats: new Int32(4), userId: '', view: { x: 0, y: 0, w: 2, h: 1, shape: 'round', legacyView: 1 }, __index: 0, posKey: { keep: true } }], view: { type: 'grid', status: true, h: 6, w: 6, subtables }, __index: 0, __listName: 'Base', __printStationsLabels: [], posRoomKey: 7 },
        { id: 'r2', name: 'Sala senza layout', tables: [{ id: 't2', name: 'Solo', seats: new Int32(1) }] },
      ],
    });
    const read = (await current(P(231))).rooms;
    assert.deepEqual(read.items[0].view, { type: 'grid', status: true, h: 6, w: 6 });
    assert.deepEqual(read.items[0].tables[0].view, { w: 2, h: 1, x: 0, y: 0, shape: 'round' });
    assert.deepEqual(read.items[1].view, { type: 'grid', status: false, h: 8, w: 8 }, 'a room without layout reads as the defaults of the editor');
    const items = JSON.parse(JSON.stringify(read.items));
    items[0].view.status = false;
    items[0].tables[0].view.x = 1;
    items[0].tables[0].name = 'Tavolo 1';
    const reply = await put(psa(), P(231), 'rooms', { items });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const [one, two] = (await stored(P(231)))['rooms'] as Document[];
    assert.deepEqual(js((one!['view'] as Document)['subtables']), subtables);
    assert.deepEqual(js([(one!['view'] as Document)['status'], one!['posRoomKey'], one!['__index'], one!['__listName'], one!['service'] instanceof Double]), [false, 7, 0, 'Base', true]);
    const table = (one!['tables'] as Document[])[0]!;
    assert.deepEqual(js([table['name'], (table['view'] as Document)['x'], (table['view'] as Document)['legacyView'], table['posKey'], table['seats'] instanceof Int32, table['__index']]), ['Tavolo 1', 1, 1, { keep: true }, true, 0]);
    // The room without layout keeps having none: the default is what the read gives, not what is written.
    assert.ok(!('view' in two!) && !('roomId' in ((two!['tables'] as Document[])[0]!)));
    // A change of its layout writes the whole of it.
    const items2 = JSON.parse(JSON.stringify((await current(P(231))).rooms.items));
    items2[1].view.status = true;
    items2[1].tables[0].view.x = 0;
    items2[1].tables[0].view.y = 0;
    assert.equal((await put(psa(), P(231), 'rooms', { items: items2 })).status, 200);
    const [, second] = (await stored(P(231)))['rooms'] as Document[];
    assert.deepEqual(js(second!['view']), { type: 'grid', status: true, h: 8, w: 8 });
    assert.deepEqual(js((second!['tables'] as Document[])[0]!['view']), { w: 1, h: 1, x: 0, y: 0, shape: 'rect' });
    assert.equal((second!['tables'] as Document[])[0]!['roomId'], 'r2');
  });

  it('removes and reorders rooms and tables as the legacy does, and refuses the ids it does not know', async () => {
    await seed(232);
    const created = await put(psa(), P(232), 'rooms', { items: [{ name: 'A', tables: [{ name: '1' }, { name: '2' }, { name: '3' }] }, { name: 'B' }] });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const [a, b] = created.body.data.rooms.items;
    const reordered = await put(psa(), P(232), 'rooms', { items: [b, { ...a, tables: [a.tables[2], a.tables[0]] }] });
    assert.equal(reordered.status, 200);
    const rooms = (await stored(P(232)))['rooms'] as Document[];
    assert.deepEqual([rooms[0]!['name'], rooms[1]!['name'], (rooms[1]!['tables'] as Document[]).map((table) => table['name'])], ['B', 'A', ['3', '1']]);
    assert.deepEqual(failure(await put(psa(), P(232), 'rooms', { items: [{ id: 'ghost', name: 'C' }] })), issues(['rooms.items.0.id', 'incorrect']));
    assert.deepEqual(failure(await put(psa(), P(232), 'rooms', { items: [b, { ...a, tables: [{ id: 'ghost', name: 'x' }] }] })), issues(['rooms.items.1.tables.0.id', 'incorrect']));
    assert.equal((await put(psa(), P(232), 'rooms', { items: [] })).status, 200);
    assert.deepEqual((await stored(P(232)))['rooms'], []);
  });

  it('checks the names, the references and the layout where they change, and the limits', async () => {
    await seed(233, { devices: [{ id: 'd1', type: 'desk', name: 'Cassa' }, { id: 'd2', type: 'handheld', name: 'Palmare' }], printStations: [{ id: 'ps1', name: 'Cucina', driver: 'ESCPOS', host: 'h' }] });
    const base = { name: 'Sala', tables: [{ name: 'T1', view: { x: 0, y: 0, w: 2, h: 2 } }], view: { w: 4, h: 4 } };
    const ok = await put(psa(), P(233), 'rooms', { items: [{ ...base, listId: PRICE_LIST, tax: 'tax1', deviceId: 'd1', printStations: ['ps1'], service: 12.5 }] });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const [saved] = ok.body.data.rooms.items;
    assert.deepEqual([saved.listId, saved.tax, saved.deviceId, saved.printStations, saved.service], [PRICE_LIST, 'tax1', 'd1', ['ps1'], 12.5]);
    assert.ok(((await stored(P(233)))['rooms'] as Document[])[0]!['service'] instanceof Double);
    const attempt = async (room: Document, ...expected: Array<[string, string]>) => assert.deepEqual(failure(await put(psa(), P(233), 'rooms', { items: [{ ...saved, ...room }] })), issues(...expected), JSON.stringify(room));
    await attempt({ name: ' ' }, ['rooms.items.0.name', 'required']);
    await attempt({ listId: 'nope' }, ['rooms.items.0.listId', 'incorrect']);
    await attempt({ tax: 'nope' }, ['rooms.items.0.tax', 'incorrect']);
    await attempt({ deviceId: 'd2' }, ['rooms.items.0.deviceId', 'incorrect']);
    await attempt({ printStations: ['ghost'] }, ['rooms.items.0.printStations.0', 'incorrect']);
    await attempt({ view: { type: 'map', status: false, w: 4, h: 4 } }, ['rooms.items.0.view.type', 'enum']);
    await attempt({ view: { type: 'grid', status: true, w: 1, h: 4 } }, ['rooms.items.0.tables.0.view', 'incorrect']);
    await attempt({ tables: [{ ...saved.tables[0], view: { ...saved.tables[0].view, x: 3 } }] }, ['rooms.items.0.tables.0.view', 'incorrect']);
    await attempt({ tables: [saved.tables[0], { name: 't1' }] }, ['rooms.items.0.tables.1.name', 'taken']);
    await attempt({ tables: [{ ...saved.tables[0], name: '' }] }, ['rooms.items.0.tables.0.name', 'required']);
    await attempt({ tables: [{ ...saved.tables[0], view: { ...saved.tables[0].view, shape: 'star' } }] }, ['rooms.items.0.tables.0.view.shape', 'enum']);
    await attempt({ service: 101 }, ['items.0.service', 'maximum']);
    await attempt({ view: { w: 51 } }, ['items.0.view.w', 'maximum']);
    await attempt({ tables: Array.from({ length: 201 }, (_unused, index) => ({ name: `t${String(index)}` })) }, ['items.0.tables', 'tooMany']);
    assert.deepEqual(failure(await put(psa(), P(233), 'rooms', { items: [saved, { name: 'sala' }] })), issues(['rooms.items.1.name', 'taken']));
    // More than a thousand tables in all.
    const crowded = Array.from({ length: 6 }, (_unused, room) => ({ name: `Sala ${String(room)}`, tables: Array.from({ length: 200 }, (_item, table) => ({ name: `t${String(table)}` })) }));
    assert.deepEqual(failure(await put(psa(), P(233), 'rooms', { items: crowded })), issues(['rooms.items', 'tooMany']));
    assert.deepEqual(failure(await put(psa(), P(233), 'rooms', { items: Array.from({ length: 31 }, (_unused, index) => ({ name: `s${String(index)}` })) })), issues(['items', 'tooMany']));
  });

  it('accepts a body of the size of a place full of tables (the PUT of the rooms and the PATCH have the larger limit)', async () => {
    await seed(234);
    const big = Array.from({ length: 5 }, (_unused, room) => ({ name: `Sala ${String(room)}`, view: { w: 50, h: 50 }, tables: Array.from({ length: 190 }, (_item, table) => ({ name: `Tavolo numero ${String(table)}`, seats: 4, userId: hex(sa()), view: { x: table % 40, y: Math.floor(table / 40), w: 1, h: 1, shape: 'round' } })) }));
    const reply = await put(psa(), P(234), 'rooms', { items: big });
    assert.equal(reply.status, 200, JSON.stringify(reply.body).slice(0, 300));
    assert.equal(((await stored(P(234)))['rooms'] as Document[]).flatMap((one) => one['tables'] as Document[]).length, 950);
    const via = await patch(psa(), P(234), { rooms: { items: [{ ...reply.body.data.rooms.items[0], name: 'Sala uno' }, ...reply.body.data.rooms.items.slice(1)] } });
    assert.equal(via.status, 200, JSON.stringify(via.body).slice(0, 300));
    assert.equal(((await stored(P(234)))['rooms'] as Document[])[0]!['name'], 'Sala uno');
  });

  it('does not let a list with an item that has no id be written: read only, flagged, and a change is a 409 that writes nothing', async () => {
    await seed(235, {
      devices: [{ id: 'd1', type: 'desk', name: 'Cassa' }, { type: 'desk', name: 'Device without id' }],
      rooms: [{ id: 'r1', name: 'Sala', tables: [{ name: 'Table without id' }, { id: 't1', name: 'T1' }] }, { name: 'Room without id' }, 'junk'],
      storages: [{ id: fixtureId('storage', 235), name: 'A', cash: true, ecommerce: false }, { name: 'Storage without id', cash: false, ecommerce: false }],
      printStations: [{ name: 'Station without id', driver: 'ESCPOS', host: 'h' }],
      productionCenter: [{ name: 'Center without id', capacity: 1 }],
    });
    const read = await current(P(235));
    assert.deepEqual([read.devices.editable, read.rooms.editable, read.storages.editable, read.printStations.stationsEditable, read.printStations.productionCentersEditable], [false, false, false, false, false]);
    assert.deepEqual(read.devices.items.map((item: Document) => [item['id'], item['withoutId'], item['name']]), [['d1', undefined, 'Cassa'], ['', true, 'Device without id']]);
    assert.deepEqual(read.rooms.items.map((item: Document) => [item['id'], item['withoutId']]), [['r1', undefined], ['', true]]);
    assert.deepEqual(read.rooms.items[0].tables.map((item: Document) => [item['id'], item['withoutId'], item['name']]), [['', true, 'Table without id'], ['t1', undefined, 'T1']]);
    assert.deepEqual([read.storages.items[1].withoutId, read.printStations.stations[0].withoutId, read.printStations.productionCenters[0].withoutId], [true, true, true]);
    const before = await stored(P(235));
    // Sent back as it is, a block is nothing; a change is a 409 on the block with its name, and the document stays as it is.
    const blocks: Array<[string, string, (block: any) => void]> = [
      ['devices', 'devices', (block) => (block.items[0].name = 'Renamed')],
      ['rooms', 'rooms', (block) => (block.items[0].tables[1].name = 'Renamed')],
      ['storages', 'storages', (block) => (block.items[0].name = 'Renamed')],
      ['print-stations', 'printStations', (block) => (block.stations[0].name = 'Renamed')],
      ['print-stations', 'printStations', (block) => (block.productionCenters[0].name = 'Renamed')],
    ];
    for (const [segment, name, change] of blocks) {
      assert.equal((await put(psa(), P(235), segment, read[name])).status, 200, `${name} unchanged`);
      const changed = JSON.parse(JSON.stringify(read[name]));
      change(changed);
      const reply = failure(await put(psa(), P(235), segment, changed));
      assert.deepEqual([reply.status, reply.code, reply.details], [409, 'CONFLICT', [{ field: name, issue: 'incorrect' }]], name);
      const viaPatch = failure(await patch(psa(), P(235), { name: 'Not written', [name]: changed }));
      assert.deepEqual([viaPatch.status, viaPatch.details], [409, [{ field: name, issue: 'incorrect' }]], `${name} in the PATCH`);
    }
    assert.ok(sameDocument(before, await stored(P(235))), 'nothing written');
    // The rest of the place can still be saved, and the lists stay as they are.
    assert.equal((await patch(psa(), P(235), { name: 'Odd lists', devices: read.devices })).status, 200);
    const after = await stored(P(235));
    for (const key of ['devices', 'rooms', 'storages', 'printStations', 'productionCenter']) {
      assert.ok(sameDocument({ v: before[key] }, { v: after[key] }), key);
    }
    // A place whose lists are all right says so.
    assert.equal((await current(P(230))).devices.editable, true);
  });
});

describe('lists: ids that repeat, busy devices decided in the transaction, users of the tables, forbidden keys', () => {
  it('does not let a list with two items of the same id be written either (the write would merge them), tables of a room included', async () => {
    await seed(240, { devices: [{ id: 'd1', type: 'desk', name: 'A' }, { id: 'd1', type: 'desk', name: 'B', info: { keep: 1 } }], rooms: [{ id: 'r1', name: 'Sala', tables: [{ id: 't1', name: '1' }, { id: 't1', name: '2' }] }] });
    const read = await current(P(240));
    assert.deepEqual([read.devices.editable, read.rooms.editable, read.storages.editable], [false, false, true]);
    const before = await stored(P(240));
    const renamed = JSON.parse(JSON.stringify(read.devices));
    renamed.items[0].name = 'Renamed';
    assert.deepEqual(failure(await put(psa(), P(240), 'devices', renamed)).details, [{ field: 'devices', issue: 'incorrect' }]);
    const room = JSON.parse(JSON.stringify(read.rooms));
    room.items[0].name = 'Renamed';
    assert.equal(failure(await put(psa(), P(240), 'rooms', room)).status, 409);
    assert.ok(sameDocument(before, await stored(P(240))));
  });
});

describe('lists: users of the tables and forbidden keys', () => {
  it('assigns a table only to a user of the group who has the place, where it changes', async () => {
    await seed(242, { rooms: [{ id: 'r1', name: 'Sala', tables: [{ id: 't1', name: '1', userId: hex(new ObjectId()) }] }] });
    const read = (await current(P(242))).rooms;
    const withUser = (userId: string) => ({ items: [{ ...read.items[0], tables: [{ ...read.items[0].tables[0], userId }] }] });
    // The historical value sent back is accepted; a new one is checked.
    assert.equal((await put(psa(), P(242), 'rooms', read)).status, 200);
    assert.deepEqual(failure(await put(psa(), P(242), 'rooms', withUser(hex(new ObjectId())))), issues(['rooms.items.0.tables.0.userId', 'incorrect']));
    assert.deepEqual(failure(await put(psa(), P(242), 'rooms', withUser(hex(world.group(1).sa)))), issues(['rooms.items.0.tables.0.userId', 'incorrect']), 'a user of another group');
    assert.deepEqual(failure(await put(psa(), P(242), 'rooms', withUser('not-an-id'))), issues(['rooms.items.0.tables.0.userId', 'incorrect']));
    assert.equal((await put(psa(), P(242), 'rooms', withUser(hex(sa())))).status, 200, 'a group administrator reaches every place');
    assert.equal((await put(psa(), P(242), 'rooms', withUser(''))).status, 200);
  });

  it('refuses keys that are operators, paths or prototype names inside an item and inside the layout of a room or a table', async () => {
    await seed(243);
    const item = (extra: Document) => ({ items: [{ name: 'Sala', ...extra }] });
    for (const [body, field, issue] of [
      [item({ $set: { x: 1 } }), 'items.0.(key)', 'forbiddenKey'],
      [item({ 'a.b': 1 }), 'items.0.(key)', 'forbiddenKey'],
      [item({ view: { $gt: 1 } }), 'items.0.view.(key)', 'forbiddenKey'],
      [item({ view: { 'a.b': 1 } }), 'items.0.view.(key)', 'forbiddenKey'],
      [item({ tables: [{ name: 'T', view: { $ne: 1 } }] }), 'items.0.tables.0.view.(key)', 'forbiddenKey'],
      [item({ tables: [{ name: 'T', view: { x: 1, y: 1, w: 1, h: 1, shape: 'rect', subtables: {} } }] }), 'items.0.tables.0.view.subtables', 'unknown'],
      [item({ tables: [{ name: 'T', 'a.b': 1 }] }), 'items.0.tables.0.(key)', 'forbiddenKey'],
    ] as const) {
      assert.deepEqual(failure(await put(psa(), P(243), 'rooms', body)), issues([field, issue]), field);
    }
    const proto = JSON.parse('{ "items": [ { "name": "x", "__proto__": { "a": 1 } } ] }');
    assert.equal(failure(await put(psa(), P(243), 'rooms', proto)).status, 422);
    // Above a megabyte the body is refused before it is read.
    const huge = { items: [{ name: 'Sala', tables: [{ name: 'x'.repeat(1_100_000) }] }] };
    assert.equal((await world.office.call('PUT', path(P(243), '/rooms'), await world.as.tokenOf(psa()), huge, await tagOf(P(243)))).status, 413);
  });
});
