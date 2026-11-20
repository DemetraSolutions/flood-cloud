import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Int32, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { fixtureId } from '../helpers/legacy-fixtures.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { startPlacesWorld } from '../helpers/places.ts';
import type { PlacesWorld } from '../helpers/places.ts';

// The new legacy fields of a place: the settings of the rooms (`tables`), the MultiSafepay data of the devices and the MultiSafepay integration.
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
const notAllowed = (...fields: string[]) => ({ status: 403, code: 'FORBIDDEN', details: fields.map((field) => ({ field, issue: 'notAllowed' })) });
const path = (id: ObjectId, rest = '') => world.placePath(0, `/${hex(id)}${rest}`);
const stored = async (id: ObjectId): Promise<Document> => (await world.storedPlace(0, id))!;
const tagOf = async (id: ObjectId): Promise<Record<string, string>> => ({ 'if-match': (await call(psa(), 'GET', path(id))).headers.get('etag')! });
const current = async (id: ObjectId) => (await call(psa(), 'GET', path(id))).body.data;
const put = async (actor: ObjectId, id: ObjectId, segment: string, body: unknown) => call(actor, 'PUT', path(id, `/${segment}`), body, await tagOf(id));
const patch = async (actor: ObjectId, id: ObjectId, body: unknown) => call(actor, 'PATCH', path(id), body, await tagOf(id));
const newPlace = (name: string): Document => ({ name, companyId: hex(fixtureId('company', 1)), address: { street: 'Via Roma 1', postcode: '20100', city: 'Milano', province: 'MI', country: 'IT' } });
const js = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

before(async () => {
  ctx = await openTestDatabases();
  world = await startPlacesWorld(ctx);
  await world.seed(0, 20);
});
after(async () => {
  await world.office.close();
  await ctx.cleanup();
});

describe('roomsSettings: the idle time, the variants, the reasons', () => {
  it('reads the legacy defaults when the keys are missing, and the default when they are junk', async () => {
    await world.seedPlace(0, 400, 1);
    const missing = (await current(P(400))).tables;
    assert.deepEqual([missing.tableIdleMinutes, missing.variantsPerRow, missing.discountReasons, missing.deleteReasons, missing.reasonsFreeText], [30, true, [], [], true]);
    await world.seedPlace(0, 401, 1);
    await ctx.databases.group(world.group(0).groupId, 'cluster0').collection('places').updateOne(
      { _id: P(401) },
      { $set: { 'roomsSettings.tableIdleMinutes': 25, 'roomsSettings.variantsPerRow': 'no', 'roomsSettings.discountReasons': ['Amico', 5, null, 'Staff;Altro'], 'roomsSettings.deleteReasons': 'x', 'roomsSettings.reasonsFreeText': null } },
    );
    const junk = (await current(P(401))).tables;
    assert.deepEqual([junk.tableIdleMinutes, junk.variantsPerRow, junk.discountReasons, junk.deleteReasons, junk.reasonsFreeText], [30, true, ['Amico', 'Staff;Altro'], [], true]);
    // Stored as false, they are false.
    await ctx.databases.group(world.group(0).groupId, 'cluster0').collection('places').updateOne({ _id: P(401) }, { $set: { 'roomsSettings.variantsPerRow': false, 'roomsSettings.reasonsFreeText': false, 'roomsSettings.tableIdleMinutes': 15 } });
    const off = (await current(P(401))).tables;
    assert.deepEqual([off.variantsPerRow, off.reasonsFreeText, off.tableIdleMinutes], [false, false, 15]);
  });

  it('writes them at their legacy paths, keeps the keys nobody owns and the copy of the group, and returns what was written', async () => {
    await world.seedPlace(0, 402, 1);
    const before = await stored(P(402));
    const reply = await put(sa(), P(402), 'settings/tables', {
      ...(await current(P(402))).tables,
      tableIdleMinutes: 20,
      variantsPerRow: false,
      discountReasons: ['  Amico  ', 'Staff'],
      deleteReasons: ['Errore'],
      reasonsFreeText: false,
    });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const rooms = (await stored(P(402)))['roomsSettings'] as Document;
    assert.ok(rooms['tableIdleMinutes'] instanceof Int32 && rooms['tableIdleMinutes'].value === 20);
    assert.deepEqual([rooms['variantsPerRow'], rooms['discountReasons'], rooms['deleteReasons'], rooms['reasonsFreeText']], [false, ['Amico', 'Staff'], ['Errore'], false]);
    assert.deepEqual(js((rooms['reservation'] as Document)['unknownReservation']), js(((before['roomsSettings'] as Document)['reservation'] as Document)['unknownReservation']));
    assert.deepEqual(
      [reply.body.data.tables.tableIdleMinutes, reply.body.data.tables.variantsPerRow, reply.body.data.tables.discountReasons, reply.body.data.tables.reasonsFreeText],
      [20, false, ['Amico', 'Staff'], false],
    );
    // A PATCH with one of them writes only that key.
    assert.equal((await patch(sa(), P(402), { tables: { tableIdleMinutes: 15 } })).status, 200);
    const after = (await stored(P(402)))['roomsSettings'] as Document;
    assert.deepEqual([after['tableIdleMinutes'] instanceof Int32 ? after['tableIdleMinutes'].value : after['tableIdleMinutes'], after['discountReasons']], [15, ['Amico', 'Staff']]);
  });

  it('accepts only 15, 20 and 30 minutes, and reasons of 1 to 100 characters, without control characters or repeats, at most 50 a list', async () => {
    await world.seedPlace(0, 403, 1);
    const bad = async (tables: Document, ...expected: Array<[string, string]>) => assert.deepEqual(failure(await patch(sa(), P(403), { tables })), issues(...expected), JSON.stringify(tables).slice(0, 80));
    await bad({ tableIdleMinutes: 25 }, ['tables.tableIdleMinutes', 'enum']);
    await bad({ tableIdleMinutes: '15' }, ['tables.tableIdleMinutes', 'type']);
    await bad({ variantsPerRow: 'yes' }, ['tables.variantsPerRow', 'type']);
    await bad({ discountReasons: [''] }, ['tables.discountReasons.0', 'minLength']);
    await bad({ discountReasons: ['   '] }, ['tables.discountReasons.0', 'minLength']);
    await bad({ discountReasons: ['x'.repeat(101)] }, ['tables.discountReasons.0', 'maxLength']);
    await bad({ deleteReasons: ['ok\nno'] }, ['tables.deleteReasons.0', 'format']);
    await bad({ deleteReasons: ['Amico', 'amico '] }, ['tables.deleteReasons.1', 'incorrect']);
    await bad({ deleteReasons: Array.from({ length: 51 }, (_, index) => `Motivo ${String(index)}`) }, ['tables.deleteReasons', 'tooMany']);
    await bad({ discountReasons: ['Amico;Staff'] }, ['tables.discountReasons.0', 'format']);
    await bad({ discountReasons: 'Amico;Staff' }, ['tables.discountReasons', 'type']);
    assert.equal((await patch(sa(), P(403), { tables: { discountReasons: ['x'.repeat(100), 'Amico'], deleteReasons: Array.from({ length: 50 }, (_, index) => `Motivo ${String(index)}`), tableIdleMinutes: 30 } })).status, 200);
    assert.equal((await patch(sa(), P(403), { tables: { discountReasons: [] } })).status, 200);
    assert.deepEqual(((await stored(P(403)))['roomsSettings'] as Document)['discountReasons'], []);
  });

  it('gives a new place the defaults and a duplicate the values of its source', async () => {
    const created = await call(psa(), 'POST', world.placePath(0), newPlace('Nuovo'));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const rooms = (await stored(ObjectId.createFromHexString(created.body.data.id)))['roomsSettings'] as Document;
    assert.ok(rooms['tableIdleMinutes'] instanceof Int32 && rooms['tableIdleMinutes'].value === 30);
    assert.deepEqual([rooms['variantsPerRow'], rooms['discountReasons'], rooms['deleteReasons'], rooms['reasonsFreeText']], [true, [], [], true]);
    await world.seedPlace(0, 404, 1);
    assert.equal((await patch(sa(), P(404), { tables: { tableIdleMinutes: 15, variantsPerRow: false, discountReasons: ['Amico'], reasonsFreeText: false } })).status, 200);
    const copy = await call(psa(), 'POST', path(P(404), '/duplicate'));
    assert.equal(copy.status, 201, JSON.stringify(copy.body));
    assert.deepEqual(
      [copy.body.data.tables.tableIdleMinutes, copy.body.data.tables.variantsPerRow, copy.body.data.tables.discountReasons, copy.body.data.tables.reasonsFreeText],
      [15, false, ['Amico'], false],
    );
  });
});

describe('devices: the MultiSafepay data', () => {
  const terminals = [
    { terminalId: 'T-001', name: 'Cassa 1' },
    { terminalId: 'T_002', name: ' Cassa 2 ' },
  ];

  it('reads the defaults of a device that has none, and writes the flags and the terminals in the legacy shape, keeping the other keys of the device', async () => {
    await world.seedPlace(0, 410, 1);
    const read = (await current(P(410))).devices.items;
    assert.deepEqual([read[0].multisafepayAppStatus, read[0].multisafepayQrStatus, read[0].multisafepayTerminals], [false, false, []]);
    const device = (await stored(P(410)))['devices'] as Document[];
    const reply = await put(psa(), P(410), 'devices', { items: [{ ...read[0], multisafepayAppStatus: true, multisafepayQrStatus: true, multisafepayTerminals: terminals }, ...read.slice(1)] });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const after = ((await stored(P(410)))['devices'] as Document[])[0]!;
    assert.deepEqual([after['multisafepayAppStatus'], after['multisafepayQrStatus']], [true, true]);
    assert.deepEqual(js(after['multisafepayTerminals']), [{ terminalId: 'T-001', name: 'Cassa 1' }, { terminalId: 'T_002', name: 'Cassa 2' }]);
    assert.deepEqual([after['info'], after['status']], [device[0]!['info'], device[0]!['status']]);
    assert.deepEqual(reply.body.data.devices.items[0].multisafepayTerminals, [{ terminalId: 'T-001', name: 'Cassa 1' }, { terminalId: 'T_002', name: 'Cassa 2' }]);
    // The list is replaced as a whole, and cleared with [].
    assert.equal((await put(psa(), P(410), 'devices', { items: [{ ...reply.body.data.devices.items[0], multisafepayTerminals: [{ terminalId: 'X1', name: 'Solo' }] }, ...read.slice(1)] })).status, 200);
    assert.deepEqual(js((((await stored(P(410)))['devices'] as Document[])[0]!)['multisafepayTerminals']), [{ terminalId: 'X1', name: 'Solo' }]);
    assert.equal((await put(psa(), P(410), 'devices', { items: [{ ...read[0], multisafepayTerminals: [] }, ...read.slice(1)] })).status, 200);
    assert.deepEqual((((await stored(P(410)))['devices'] as Document[])[0]!)['multisafepayTerminals'], []);
  });

  it('keeps the single legacy fields a stored device has, and reads the terminals of a stored device tolerantly', async () => {
    await world.seedPlace(0, 411, 1);
    const read = (await current(P(411))).devices.items;
    const id = read[0].id as string;
    await ctx.databases.group(world.group(0).groupId, 'cluster0').collection('places').updateOne(
      { _id: P(411), 'devices.id': id },
      { $set: { 'devices.$.multisafepayTerminalId': 'OLD', 'devices.$.multisafepayName': 'Old', 'devices.$.multisafepayTerminals': [{ terminalId: 'A', name: '' }, { terminalId: '', name: 'x' }, 'broken', { name: 'no id' }, { terminalId: 5 }, { terminalId: 'B', name: 'Bar', extra: 1 }] } },
    );
    const tolerant = (await current(P(411))).devices.items[0];
    assert.deepEqual(tolerant.multisafepayTerminals, [{ terminalId: 'A', name: 'A' }, { terminalId: 'B', name: 'Bar' }]);
    assert.equal(tolerant.multisafepayTerminalId, undefined);
    // Saving the device again keeps the removed single fields as they are (they are not modelled, so never written nor removed).
    assert.equal((await put(psa(), P(411), 'devices', { items: [{ ...tolerant, name: 'Cassa X' }, ...read.slice(1)] })).status, 200);
    const after = ((await stored(P(411)))['devices'] as Document[])[0]!;
    assert.deepEqual([after['multisafepayTerminalId'], after['multisafepayName'], after['name']], ['OLD', 'Old', 'Cassa X']);
  });

  it('accepts at most 20 terminals of valid, unique identifiers and names', async () => {
    await world.seedPlace(0, 412, 1);
    const read = (await current(P(412))).devices.items;
    const send = (list: unknown) => put(psa(), P(412), 'devices', { items: [{ ...read[0], multisafepayTerminals: list }, ...read.slice(1)] });
    const bad = async (list: unknown, ...expected: Array<[string, string]>) => assert.deepEqual(failure(await send(list)), issues(...expected), JSON.stringify(list).slice(0, 80));
    await bad([{ terminalId: '', name: 'x' }], ['items.0.multisafepayTerminals.0.terminalId', 'minLength']);
    await bad([{ terminalId: 'a b', name: 'x' }], ['items.0.multisafepayTerminals.0.terminalId', 'pattern']);
    await bad([{ terminalId: 'a'.repeat(65), name: 'x' }], ['items.0.multisafepayTerminals.0.terminalId', 'maxLength']);
    await bad([{ terminalId: 'a', name: '' }], ['items.0.multisafepayTerminals.0.name', 'minLength']);
    await bad([{ terminalId: 'a', name: 'x'.repeat(101) }], ['items.0.multisafepayTerminals.0.name', 'maxLength']);
    await bad([{ terminalId: 'a', name: 'bad\tname' }], ['items.0.multisafepayTerminals.0.name', 'format']);
    await bad([{ terminalId: 'a' }], ['items.0.multisafepayTerminals.0.name', 'required']);
    await bad([{ terminalId: 'a', name: 'x', role: 'admin' }], ['items.0.multisafepayTerminals.0.role', 'unknown']);
    await bad([{ terminalId: 'a', name: 'x' }, { terminalId: 'b', name: 'y' }, { terminalId: 'a', name: 'z' }], ['items.0.multisafepayTerminals.2.terminalId', 'incorrect']);
    await bad(Array.from({ length: 21 }, (_, index) => ({ terminalId: `t${String(index)}`, name: 'x' })), ['items.0.multisafepayTerminals', 'tooMany']);
    await bad('T-1', ['items.0.multisafepayTerminals', 'type']);
    assert.equal((await send(Array.from({ length: 20 }, (_, index) => ({ terminalId: `t${String(index)}`, name: `Terminale ${String(index)}` })))).status, 200);
    // The same identifier on two devices is fine: unique inside a device only.
    assert.equal((await send([{ terminalId: 'T1', name: 'Uno' }])).status, 200);
    assert.equal((await put(psa(), P(412), 'devices', { items: [{ ...read[0], multisafepayTerminals: [{ terminalId: 'T1', name: 'Uno' }] }, { ...read[1] ?? { name: 'Secondo', type: 'desk' }, multisafepayTerminals: [{ terminalId: 'T1', name: 'Uno' }] }] })).status, 200);
  });
});

describe('integrations.multisafepay', () => {
  const FAKE_GROUP_KEY = 'fake-msp-terminal-group-key';
  const FAKE_SITE_KEY = 'fake-msp-website-key';
  const integrationOf = async (id: ObjectId): Promise<Document> => ((await stored(id))['integrations'] as Document)['multisafepay'] as Document;

  it('reads the defaults of a place that has no block, and completes the block with the defaults when a key is written', async () => {
    await world.seedPlace(0, 420, 1);
    const read = (await current(P(420))).integrations.multisafepay;
    assert.deepEqual(read, { status: false, terminalGroupId: null, terminalGroupApiKeySet: false, websiteApiKeySet: false, qrSecondsActive: 600, qrStatus: false });
    assert.equal((await patch(psa(), P(420), { integrations: { multisafepay: { qrStatus: true } } })).status, 200);
    assert.deepEqual(js(await integrationOf(P(420))), { status: false, terminalGroupId: null, terminalGroupApiKey: null, websiteApiKey: null, qrSecondsActive: 600, qrStatus: true });
  });

  it('writes the configuration in the legacy forms: trimmed identifier, null when empty, whole seconds in range', async () => {
    await world.seedPlace(0, 421, 1);
    const reply = await patch(psa(), P(421), { integrations: { multisafepay: { status: true, terminalGroupId: "  group-1  ", qrSecondsActive: 3600, qrStatus: true } } });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const block = await integrationOf(P(421));
    assert.deepEqual([block['status'], block['terminalGroupId'], block['qrStatus']], [true, 'group-1', true]);
    assert.ok(block['qrSecondsActive'] instanceof Int32 && block['qrSecondsActive'].value === 3600);
    assert.deepEqual([reply.body.data.integrations.multisafepay.terminalGroupId, reply.body.data.integrations.multisafepay.qrSecondsActive], ['group-1', 3600]);
    assert.equal((await patch(psa(), P(421), { integrations: { multisafepay: { terminalGroupId: '' } } })).status, 200);
    assert.equal((await integrationOf(P(421)))['terminalGroupId'], null);
    // The ends of the range, and what is out of it.
    for (const seconds of [60, 31_536_000]) {
      assert.equal((await patch(psa(), P(421), { integrations: { multisafepay: { qrSecondsActive: seconds } } })).status, 200, String(seconds));
    }
    for (const seconds of [59, 31_536_001]) {
      assert.equal(failure(await patch(psa(), P(421), { integrations: { multisafepay: { qrSecondsActive: seconds } } })).status, 422, String(seconds));
    }
    assert.deepEqual(failure(await patch(psa(), P(421), { integrations: { multisafepay: { qrSecondsActive: 600.5, terminalGroupId: 'x'.repeat(65), status: 'on' } } })).details, [
      { field: 'integrations.multisafepay.status', issue: 'type' },
      { field: 'integrations.multisafepay.terminalGroupId', issue: 'maxLength' },
      { field: 'integrations.multisafepay.qrSecondsActive', issue: 'type' },
    ]);
    // The identifier has the form of a terminal id.
    for (const id of ['a b', 'gr/1', 'è']) {
      assert.deepEqual(failure(await patch(psa(), P(421), { integrations: { multisafepay: { terminalGroupId: id } } })), issues(['integrations.multisafepay.terminalGroupId', 'pattern']), id);
    }
    // A stored value that is junk reads as the default.
    await ctx.databases.group(world.group(0).groupId, 'cluster0').collection('places').updateOne({ _id: P(421) }, { $set: { 'integrations.multisafepay.qrSecondsActive': 'soon', 'integrations.multisafepay.status': 'yes' } });
    const junk = (await current(P(421))).integrations.multisafepay;
    assert.deepEqual([junk.qrSecondsActive, junk.status], [600, false]);
  });

  it('keeps the two credentials write-only: never returned, logged or reported, kept when left out, cleared with null or the empty text', async () => {
    await world.seedPlace(0, 422, 1);
    const mark = world.office.activity.entries.length;
    const reply = await patch(psa(), P(422), { integrations: { multisafepay: { terminalGroupApiKey: FAKE_GROUP_KEY, websiteApiKey: FAKE_SITE_KEY } } });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const block = await integrationOf(P(422));
    assert.deepEqual([block['terminalGroupApiKey'], block['websiteApiKey']], [FAKE_GROUP_KEY, FAKE_SITE_KEY]);
    const sent = reply.body.data.integrations.multisafepay;
    assert.deepEqual([sent.terminalGroupApiKeySet, sent.websiteApiKeySet, 'terminalGroupApiKey' in sent, 'websiteApiKey' in sent], [true, true, false, false]);
    const everything = JSON.stringify([reply.body, (await call(psa(), 'GET', path(P(422)))).body, world.office.activity.entries.slice(mark), world.office.logEvents]);
    assert.ok(!everything.includes(FAKE_GROUP_KEY) && !everything.includes(FAKE_SITE_KEY));
    const entry = world.office.activity.entries.slice(mark).find((item) => item.action === 'place.updated')!;
    assert.deepEqual(entry.changes, [{ field: 'integrations', redacted: true }]);
    // The GET sent back with the flags (even lying ones) changes nothing; a key left out is kept.
    const read = (await current(P(422))).integrations;
    assert.equal((await put(psa(), P(422), 'integrations', { ...read, multisafepay: { ...read.multisafepay, status: true, websiteApiKeySet: false } })).status, 200);
    assert.deepEqual([(await integrationOf(P(422)))['terminalGroupApiKey'], (await integrationOf(P(422)))['websiteApiKey'], (await integrationOf(P(422)))['status']], [FAKE_GROUP_KEY, FAKE_SITE_KEY, true]);
    assert.equal((await patch(psa(), P(422), { integrations: { multisafepay: { terminalGroupApiKey: null, websiteApiKey: '' } } })).status, 200);
    assert.deepEqual([(await integrationOf(P(422)))['terminalGroupApiKey'], (await integrationOf(P(422)))['websiteApiKey']], [null, null]);
    assert.deepEqual([(await current(P(422))).integrations.multisafepay.terminalGroupApiKeySet, (await current(P(422))).integrations.multisafepay.websiteApiKeySet], [false, false]);
    // The form of a credential, without echoing it.
    const bad = failure(await patch(psa(), P(422), { integrations: { multisafepay: { websiteApiKey: ' has a space' } } }));
    assert.deepEqual(bad, issues(['integrations.multisafepay.websiteApiKey', 'pattern']));
    assert.ok(!JSON.stringify(bad).includes('has a space'));
  });

  it('gives the credentials and the switch to the PSA and the dealers alone, and the rest to every role that writes the place', async () => {
    await world.seedPlace(0, 423, 1);
    const own = world.group(0).ownPlaceId;
    const attempts: Array<[Document, string[]]> = [
      [{ terminalGroupApiKey: FAKE_GROUP_KEY }, ['integrations.multisafepay.terminalGroupApiKey']],
      [{ websiteApiKey: null }, ['integrations.multisafepay.websiteApiKey']],
      [{ terminalGroupApiKey: FAKE_GROUP_KEY, websiteApiKey: FAKE_SITE_KEY }, ['integrations.multisafepay.terminalGroupApiKey', 'integrations.multisafepay.websiteApiKey']],
      [{ status: true }, ['integrations.multisafepay.status']],
      [{ qrStatus: true }, ['integrations.multisafepay.qrStatus']],
    ];
    for (const actor of [sa(), ca()]) {
      for (const [multisafepay, fields] of attempts) {
        assert.deepEqual(failure(await patch(actor, P(423), { integrations: { multisafepay } })), notAllowed(...fields), JSON.stringify(fields));
      }
    }
    assert.deepEqual(failure(await patch(pa(), own, { integrations: { multisafepay: { websiteApiKey: FAKE_SITE_KEY } } })), notAllowed('integrations.multisafepay.websiteApiKey'));
    // A key left out is fine, and the configuration is theirs.
    assert.equal((await patch(sa(), P(423), { integrations: { multisafepay: { terminalGroupId: 'g-9', qrSecondsActive: 120 } } })).status, 200);
    assert.equal((await put(pa(), own, 'integrations', (await current(own)).integrations)).status, 200);
    for (const actor of [psa(), dealer()]) {
      assert.equal((await patch(actor, P(423), { integrations: { multisafepay: { status: true, qrStatus: true, websiteApiKey: FAKE_SITE_KEY } } })).status, 200);
    }
    assert.equal((await integrationOf(P(423)))['websiteApiKey'], FAKE_SITE_KEY);
  });

  it('is copied with its credentials by the duplicate, as the other payment integrations, and given to a new place off and empty', async () => {
    await world.seedPlace(0, 424, 1);
    assert.equal((await patch(psa(), P(424), { integrations: { multisafepay: { status: true, terminalGroupId: 'g-1', websiteApiKey: FAKE_SITE_KEY, terminalGroupApiKey: FAKE_GROUP_KEY } } })).status, 200);
    const copy = await call(psa(), 'POST', path(P(424), '/duplicate'));
    assert.equal(copy.status, 201, JSON.stringify(copy.body));
    const copied = await integrationOf(ObjectId.createFromHexString(copy.body.data.id));
    assert.deepEqual(js(copied), { status: true, terminalGroupId: 'g-1', terminalGroupApiKey: FAKE_GROUP_KEY, websiteApiKey: FAKE_SITE_KEY, qrSecondsActive: 600, qrStatus: false });
    assert.ok(!JSON.stringify(copy.body).includes(FAKE_SITE_KEY));
    const created = await call(psa(), 'POST', world.placePath(0), newPlace('Nuovo MSP'));
    assert.deepEqual(js(await integrationOf(ObjectId.createFromHexString(created.body.data.id))), { status: false, terminalGroupId: null, terminalGroupApiKey: null, websiteApiKey: null, qrSecondsActive: 600, qrStatus: false });
  });

  it('keeps the keys of the block nobody owns', async () => {
    await world.seedPlace(0, 425, 1, { integrations: { multisafepay: { status: false, terminalGroupId: null, terminalGroupApiKey: null, websiteApiKey: null, qrSecondsActive: new Int32(900), qrStatus: false, hasTerminalGroupApiKey: true, future: { a: 1 } } } });
    assert.equal((await patch(psa(), P(425), { integrations: { multisafepay: { qrStatus: true } } })).status, 200);
    const block = await integrationOf(P(425));
    assert.deepEqual([block['qrStatus'], block['hasTerminalGroupApiKey'], js(block['future'])], [true, true, { a: 1 }]);
    assert.equal((await current(P(425))).integrations.multisafepay.qrSecondsActive, 900);
    assert.equal('hasTerminalGroupApiKey' in (await current(P(425))).integrations.multisafepay, false);
  });
});
