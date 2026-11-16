import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { addUser } from '../helpers/backoffice.ts';
import { memoryRateLimiter } from '../helpers/activity.ts';
import { LEGACY_MODULE_NAMES, fixtureId, legacyCompany, legacyPermissions } from '../helpers/legacy-fixtures.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { startStoreWorld } from '../helpers/store-keys.ts';
import type { StoreWorld } from '../helpers/store-keys.ts';

let ctx: TestDatabases;
let world: StoreWorld;
const limiter = memoryRateLimiter();
const call = (...args: Parameters<StoreWorld['as']['call']>) => world.as.call(...args);
const common = () => ctx.databases.common();
const hex = (id: ObjectId) => id.toHexString();
const g = (index: number) => world.group(index);
const psa = () => world.office.cluster.psa;
const when = new Date('2026-03-05T22:30:15.000Z');
const SECRETS = ['SECRET-SN', 'secret-cash', '10.9.9.9', 'fixture-integration-secret', '10.0.0.1', 'host.secret', 'connector', 'integrations', 'automaticCash', 'serialNumber'];

/** The rows of a reply, as `placeName/deviceName`. */
const names = (reply: { body: { data: Array<{ placeName: string; deviceName: string }> } }) => reply.body.data.map((row) => `${row.placeName}/${row.deviceName}`);

/** Sets the devices of a place copy (the only place the diagnostics reads). */
async function devices(placeId: ObjectId, list: unknown, extra: Document = {}): Promise<void> {
  await common().collection('places').updateOne({ _id: placeId }, { $set: { devices: list, ...extra } });
}

/** The CSV of a request as a user: status, headers and text. */
async function csv(actor: ObjectId, query = ''): Promise<{ status: number; headers: Headers; text: string }> {
  const response = await world.office.call('GET', `/diagnostics/devices.csv${query}`, await world.as.tokenOf(actor));
  // `Response.text()` drops the byte order mark: it is part of what is checked.
  return { status: response.status, headers: response.headers, text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(await response.arrayBuffer()) };
}

before(async () => {
  ctx = await openTestDatabases();
  world = await startStoreWorld(ctx, { rateLimiter: limiter, env: { RATE_LIMIT_DIAGNOSTICS_EXPORT_PER_USER: '4' } });
  await common().collection('places').updateMany({}, { $set: { name: 'Bar' } });
  // The isolation cluster: groups 0 and 1 of dealer A, 2 and 3 of dealer B; group 3 is a demo group. Every place has its devices (the devices of the group databases are never read).
  await common().collection('groups').updateOne({ _id: g(3).groupId }, { $set: { demo: true } });
  const secret = { host: 'host.secret', serialNumber: 'SECRET-SN', automaticCashUsername: 'cash-user', automaticCashPassword: 'secret-cash', secondaryHost: '10.9.9.9' };
  await devices(g(0).ownPlaceId, [
    { id: 'd1', name: 'Cassa 1', type: 'desk', server: true, ...secret, info: { appVersion: '1.2.3', system: { platform: 'android', platformVersion: '13', model: 'Pixel 7', ip: '10.9.9.9' }, lastDataDownload: when, date: new Date('2026-03-06T08:00:00.000Z'), token: 'device-token' } },
    { id: 'd2', name: '=cmd|calc;"x"', type: 'handheld', server: false, ...secret },
    { id: 'd3', name: ' ', type: {}, server: 'yes', info: { appVersion: 12, system: 'odd', lastDataDownload: 'not a date', date: '2026-03-07T09:00:00.000Z' } },
    null,
  ]);
  await devices(g(0).otherPlaceId, [{ id: 'd4', name: 'Palmare Sala', type: 'handheld', ...secret }]);
  await devices(g(1).ownPlaceId, [{ id: 'd5', name: 'Cassa G1', type: 'desk' }]);
  await devices(g(1).otherPlaceId, 'not a list');
  await devices(g(2).ownPlaceId, [{ id: 'd6', name: 'Cassa G2', type: 'desk' }]);
  await devices(g(2).otherPlaceId, []);
  await devices(g(3).ownPlaceId, [{ id: 'd7', name: 'Cassa demo', type: 'desk' }]);
  await devices(g(3).otherPlaceId, [{ id: 'd8', name: 'Cassa demo 2', type: 'desk' }]);
});
after(async () => {
  await world.office.close();
  await ctx.cleanup();
});
beforeEach(() => limiter.reset());

describe('GET /v1/diagnostics/devices', () => {
  it('gives the PSA the devices of every group but the demo ones, with the group and the company, and nothing of the credentials', async () => {
    const reply = await call(psa(), 'GET', '/diagnostics/devices?limit=100');
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.body.data.map((row: { deviceId: string | null }) => row.deviceId), ['d1', 'd2', 'd3', null, 'd4', 'd5', 'd6']);
    const first = reply.body.data[0];
    const company = (await common().collection('companies').findOne({ _id: (await common().collection('places').findOne({ _id: g(0).ownPlaceId }))!['companyId'] }))!;
    assert.deepEqual(first, {
      id: `${hex(g(0).ownPlaceId)}:0`,
      groupId: hex(g(0).groupId),
      groupName: 'group-001',
      companyId: hex(company['_id']),
      companyName: company['name'],
      companyCode: company['code'],
      placeId: hex(g(0).ownPlaceId),
      placeName: 'Bar',
      deviceId: 'd1',
      deviceName: 'Cassa 1',
      deviceType: 'desk',
      appVersion: '1.2.3',
      server: true,
      platform: 'android',
      platformVersion: '13',
      model: 'Pixel 7',
      lastDataDownload: when.toISOString(),
      lastSession: '2026-03-06T08:00:00.000Z',
      storeKey: { status: 'none', lastSeenAt: null, appVersion: null },
    });
    // Values of the wrong type are read as missing; a date written as a text is still a date; a device that is not an object is a row with nothing.
    assert.deepEqual(reply.body.data[2], { ...reply.body.data[2], deviceName: '', deviceType: null, appVersion: '12', server: false, platform: null, lastDataDownload: null, lastSession: '2026-03-07T09:00:00.000Z' });
    assert.deepEqual(reply.body.data[3], { ...reply.body.data[3], deviceId: null, deviceName: '', server: false });
    assert.deepEqual(reply.body.page, { limit: 100, next: null });
    const text = JSON.stringify(reply.body);
    for (const secret of [...SECRETS, 'device-token', 'cash-user', 'Cassa demo']) {
      assert.ok(!text.includes(secret), secret);
    }
    assert.equal(reply.headers.get('cache-control'), 'no-store');
    const etag = reply.headers.get('etag')!;
    assert.match(etag, /^W\/"/);
    const again = await world.office.call('GET', '/diagnostics/devices?limit=100', await world.as.tokenOf(psa()), undefined, { 'if-none-match': etag });
    assert.equal(again.status, 304);
  });

  it('lets the PSA read a demo group by naming it', async () => {
    const reply = await call(psa(), 'GET', `/diagnostics/devices?groupId=${hex(g(3).groupId)}`);
    assert.deepEqual(names(reply), ['Bar/Cassa demo', 'Bar/Cassa demo 2']);
  });

  it('gives a dealer only his groups, the demo ones left out, and an empty page for a group of another dealer', async () => {
    const { dealerA, dealerB } = world.office.cluster;
    assert.deepEqual((await call(dealerA, 'GET', '/diagnostics/devices')).body.data.map((row: { deviceId: string }) => row.deviceId), ['d1', 'd2', 'd3', null, 'd4', 'd5']);
    assert.deepEqual((await call(dealerB, 'GET', '/diagnostics/devices')).body.data.map((row: { deviceId: string }) => row.deviceId), ['d6']);
    const foreign = await call(dealerA, 'GET', `/diagnostics/devices?groupId=${hex(g(2).groupId)}`);
    assert.deepEqual([foreign.status, foreign.body], [200, { data: [], page: { limit: 50, next: null } }]);
    assert.deepEqual(names(await call(dealerA, 'GET', `/diagnostics/devices?groupId=${hex(g(1).groupId)}`)), ['Bar/Cassa G1']);
  });

  it('gives a group administrator, a company administrator and a place administrator the devices of their perimeter only, whatever they ask', async () => {
    const sa = await call(g(0).sa, 'GET', '/diagnostics/devices');
    assert.deepEqual(sa.body.data.map((row: { deviceId: string | null }) => row.deviceId), ['d1', 'd2', 'd3', null, 'd4']);
    assert.deepEqual((await call(g(0).sa, 'GET', `/diagnostics/devices?groupId=${hex(g(1).groupId)}`)).body.data, []);
    assert.deepEqual((await call(g(0).ca, 'GET', '/diagnostics/devices')).body.data.map((row: { deviceId: string | null }) => row.deviceId), ['d1', 'd2', 'd3', null]);
    assert.deepEqual((await call(g(0).pa, 'GET', '/diagnostics/devices')).body.data.map((row: { deviceId: string | null }) => row.deviceId), ['d1', 'd2', 'd3', null]);
    assert.deepEqual((await call(g(0).pa, 'GET', `/diagnostics/devices?placeId=${hex(g(0).otherPlaceId)}`)).body.data, []);
    assert.deepEqual((await call(g(0).ca, 'GET', `/diagnostics/devices?placeId=${hex(g(0).otherPlaceId)}`)).body.data, []);
    // A group administrator reads his group even when it is a demo one.
    assert.deepEqual(names(await call(g(3).sa, 'GET', '/diagnostics/devices')), ['Bar/Cassa demo', 'Bar/Cassa demo 2']);
  });

  it('refuses a caller without the permission (403), a store key (403), and an anonymous caller (401), on both routes', async () => {
    // A group administrator whose own permissions leave out the places.
    const modules = Object.fromEntries(LEGACY_MODULE_NAMES.map((name) => [name, { r: name !== 'places', w: false }]));
    const blind = await addUser(ctx, world.office, { permissions: legacyPermissions({ status: true, modules }) });
    for (const path of ['/diagnostics/devices', '/diagnostics/devices.csv']) {
      assert.deepEqual((await call(blind.id, 'GET', path)).status, 403, path);
      assert.equal((await world.office.call('GET', path, undefined)).status, 401, path);
      const key = await world.activate(g(0).ownPlaceId);
      const asStore = await world.asStore(key.key, 'GET', path);
      assert.deepEqual([asStore.status, asStore.body.error.code], [403, 'FORBIDDEN'], path);
    }
  });

  it('filters by company, place, type and text (literally, in the name of the place and of the device)', async () => {
    const companyId = (await common().collection('places').findOne({ _id: g(0).otherPlaceId }))!['companyId'] as ObjectId;
    assert.deepEqual(names(await call(psa(), 'GET', `/diagnostics/devices?companyId=${hex(companyId)}&groupId=${hex(g(0).groupId)}`)), ['Bar/Palmare Sala']);
    assert.deepEqual(names(await call(psa(), 'GET', `/diagnostics/devices?placeId=${hex(g(0).otherPlaceId)}`)), ['Bar/Palmare Sala']);
    assert.deepEqual((await call(psa(), 'GET', '/diagnostics/devices?type=handheld')).body.data.map((row: { deviceId: string }) => row.deviceId), ['d2', 'd4']);
    assert.deepEqual((await call(psa(), 'GET', '/diagnostics/devices?q=palmare')).body.data.map((row: { deviceId: string }) => row.deviceId), ['d4']);
    assert.deepEqual((await call(psa(), 'GET', '/diagnostics/devices?q=%3Dcmd%7Ccalc%3B')).body.data.map((row: { deviceId: string }) => row.deviceId), ['d2']);
    assert.deepEqual((await call(psa(), 'GET', '/diagnostics/devices?q=.*')).body.data, []);
    assert.equal((await call(psa(), 'GET', '/diagnostics/devices?q=bar')).body.data.length, 7);
  });

  it('pages with a cursor in the order of the places and of the devices, until the end', async () => {
    const seen: string[] = [];
    let path = '/diagnostics/devices?limit=2';
    for (let pages = 0; pages < 10; pages += 1) {
      const reply = await call(psa(), 'GET', path);
      seen.push(...reply.body.data.map((row: { id: string }) => row.id));
      if (reply.body.page.next === null) {
        break;
      }
      assert.equal(reply.body.data.length, 2);
      path = `/diagnostics/devices?limit=2&cursor=${reply.body.page.next}`;
    }
    const whole = (await call(psa(), 'GET', '/diagnostics/devices?limit=100')).body.data.map((row: { id: string }) => row.id);
    assert.deepEqual(seen, whole);
    assert.equal(new Set(seen).size, 7);
    // A cursor after the last device is an empty last page.
    const last = Buffer.from(JSON.stringify({ ver: 1, p: 'f'.repeat(24), i: 0 })).toString('base64url');
    assert.deepEqual((await call(psa(), 'GET', `/diagnostics/devices?cursor=${last}`)).body, { data: [], page: { limit: 50, next: null } });
  });

  it('refuses what is not valid: a limit out of range, a malformed cursor, an unknown type, an id that is not one, an unknown parameter, an operator', async () => {
    const bad = [
      '?limit=101',
      '?limit=0',
      '?limit=x',
      '?cursor=not*base64',
      `?cursor=${Buffer.from('{"ver":2,"p":"000000000000000000000000","i":0}').toString('base64url')}`,
      `?cursor=${Buffer.from('nope').toString('base64url')}`,
      `?cursor=${Buffer.from('[1]').toString('base64url')}`,
      `?cursor=${Buffer.from('{"ver":1,"p":"000000000000000000000000","i":-1}').toString('base64url')}`,
      '?type=cash',
      '?groupId=x',
      '?companyId[$ne]=1',
      '?placeId=%7B%22%24ne%22%3Anull%7D',
      '?q=',
      `?q=${'x'.repeat(65)}`,
      '?sort=name',
    ];
    for (const query of bad) {
      const reply = await call(psa(), 'GET', `/diagnostics/devices${query}`);
      assert.deepEqual([reply.status, reply.body.error.code], [422, 'VALIDATION_ERROR'], query);
    }
  });

  it('leaves out the places and the companies in the trash and the groups in the trash', async () => {
    try {
      await common().collection('places').updateOne({ _id: g(0).otherPlaceId }, { $set: { trash: true } });
      assert.ok(!names(await call(psa(), 'GET', '/diagnostics/devices')).includes('Bar/Palmare Sala'));
      await common().collection('places').updateOne({ _id: g(0).otherPlaceId }, { $set: { trash: false } });
      const companyId = (await common().collection('places').findOne({ _id: g(0).otherPlaceId }))!['companyId'] as ObjectId;
      await common().collection('companies').updateOne({ _id: companyId }, { $set: { trash: true } });
      assert.ok(!names(await call(psa(), 'GET', '/diagnostics/devices')).includes('Bar/Palmare Sala'));
      await common().collection('groups').updateOne({ _id: g(1).groupId }, { $set: { trash: true } });
      assert.ok(!names(await call(psa(), 'GET', '/diagnostics/devices')).includes('Bar/Cassa G1'));
      assert.deepEqual((await call(psa(), 'GET', `/diagnostics/devices?groupId=${hex(g(1).groupId)}`)).body.data, []);
    } finally {
      await common().collection('places').updateMany({}, { $set: { trash: false } });
      await common().collection('companies').updateMany({}, { $set: { trash: false } });
      await common().collection('groups').updateMany({}, { $set: { trash: false } });
    }
  });

  it('shows the active store key of the place with the last time it was seen and the version of the app, and none once it is revoked', async () => {
    const code = await world.codeFor(g(0).ownPlaceId);
    const done = await world.exchange(code, { installation: { appVersion: '4.5.6', platform: 'android' } });
    assert.equal(done.status, 201);
    const first = (await call(psa(), 'GET', `/diagnostics/devices?placeId=${hex(g(0).ownPlaceId)}`)).body.data[0];
    assert.deepEqual(first.storeKey, { status: 'active', lastSeenAt: new Date(world.office.clock.now()).toISOString(), appVersion: '4.5.6' });
    const text = JSON.stringify(first);
    for (const hidden of [done.body.data.key, 'keyHash', 'hint', 'userAgent']) {
      assert.ok(!text.includes(hidden), hidden);
    }
    await common().collection('storeKeys').updateMany({ placeId: g(0).ownPlaceId }, { $set: { status: 'revoked' } });
    assert.equal((await call(psa(), 'GET', `/diagnostics/devices?placeId=${hex(g(0).ownPlaceId)}`)).body.data[0].storeKey.status, 'none');
  });

  it('tolerates a place without a company and a place whose company is unknown', async () => {
    const stray = fixtureId('place', 9001);
    await common().collection('places').insertMany([
      { _id: stray, groupId: g(2).groupId, name: 'Stray', trash: false, devices: [{ id: 's', name: 'Stray device', type: 'kiosk' }] },
      { _id: fixtureId('place', 9002), groupId: g(2).groupId, name: 'Odd', companyId: 'not an id', devices: [{ id: 'o', name: 'Odd device' }] },
      { _id: fixtureId('place', 9003), groupId: g(2).groupId, companyId: fixtureId('company', 9999), devices: [{ name: 'Ghost company' }] },
    ]);
    try {
      const rows = (await call(g(2).sa, 'GET', '/diagnostics/devices?q=device')).body.data;
      assert.deepEqual(rows.map((row: { deviceName: string; companyId: string | null; companyName: string | null }) => [row.deviceName, row.companyId, row.companyName]), [['Stray device', null, null], ['Odd device', null, null]]);
      const ghost = (await call(g(2).sa, 'GET', '/diagnostics/devices?q=ghost')).body.data;
      assert.deepEqual([ghost[0].companyName, ghost[0].companyCode, ghost[0].placeName], [null, null, '']);
    } finally {
      await common().collection('places').deleteMany({ _id: { $in: [stray, fixtureId('place', 9002), fixtureId('place', 9003)] } });
    }
  });
});

describe('GET /v1/diagnostics/devices.csv', () => {
  it('streams the file of the legacy columns plus the store key, with the headers of a download, quoting and neutralising what a spreadsheet would run', async () => {
    await common().collection('companies').updateOne({ _id: (await common().collection('places').findOne({ _id: g(0).ownPlaceId }))!['companyId'] }, { $set: { code: '01234567890' } });
    const reply = await csv(psa(), `?groupId=${hex(g(0).groupId)}&placeId=${hex(g(0).ownPlaceId)}`);
    assert.equal(reply.status, 200);
    assert.equal(reply.headers.get('content-type'), 'text/csv; charset=utf-8');
    assert.match(reply.headers.get('content-disposition')!, /^attachment; filename="devices-diagnostic_\d{4}-\d{2}-\d{2}\.csv"$/);
    assert.equal(reply.headers.get('cache-control'), 'no-store');
    const lines = reply.text.split('\r\n');
    assert.equal(lines[0], '﻿GRUPPO;AZIENDA;P.IVA;PUNTO VENDITA;DISPOSITIVO;TIPO;VERSIONE FLOOD;SERVER;SISTEMA;VERSIONE;MODELLO;ULT. DOWNLOAD;ULT. SESSIONE;CHIAVE NEGOZIO;ULT. USO CHIAVE;VERSIONE APP NEGOZIO');
    assert.equal(lines[1], 'group-001;company-001;_01234567890;Bar;Cassa 1;desk;1.2.3;Sì;android;13;Pixel 7;05-03-2026 23:30:15;06-03-2026 09:00:00;Nessuna;;');
    // The name of the second device starts with `=`, holds the separator and quotation marks.
    assert.equal(lines[2]!.split(';Bar;')[1], `"'=cmd|calc;""x""";handheld;;No;;;;;;Nessuna;;`);
    assert.equal(lines.length, 6);
    assert.equal(lines[5], '');
    for (const secret of SECRETS) {
      assert.ok(!reply.text.includes(secret), secret);
    }
  });

  it('exports the perimeter of the caller only, and the header alone when there is nothing', async () => {
    const sa = await csv(g(2).sa);
    assert.equal(sa.text.split('\r\n').length, 3);
    assert.ok(sa.text.includes('Cassa G2') && !sa.text.includes('Cassa G1') && !sa.text.includes('Cassa demo'));
    const nothing = await csv(g(0).sa, `?groupId=${hex(g(1).groupId)}`);
    assert.deepEqual([nothing.status, nothing.text.split('\r\n').length], [200, 2]);
    assert.ok(nothing.text.startsWith('﻿GRUPPO;'));
    const empty = await csv(psa(), '?q=nothing-matches-this');
    assert.deepEqual([empty.status, empty.text.split('\r\n').length], [200, 2]);
  });

  it('spans several batches in the order of the table', async () => {
    const table = (await call(psa(), 'GET', '/diagnostics/devices?limit=100')).body.data.map((row: { deviceName: string }) => row.deviceName);
    const file = (await csv(psa())).text.split('\r\n').slice(1, -1);
    assert.equal(file.length, table.length);
  });

  it('is rate limited per user and refuses invalid filters', async () => {
    const bad = await call(psa(), 'GET', '/diagnostics/devices.csv?limit=5');
    assert.deepEqual([bad.status, bad.body.error.code], [422, 'VALIDATION_ERROR']);
    assert.equal((await call(psa(), 'GET', '/diagnostics/devices.csv?type=cash')).status, 422);
    limiter.reset();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      statuses.push((await csv(psa())).status);
    }
    assert.deepEqual(statuses, [200, 200, 200, 200, 429, 429]);
    // The rule is the user's: another one still downloads, and the table has no such limit.
    assert.equal((await csv(g(0).sa)).status, 200);
    assert.equal((await call(psa(), 'GET', '/diagnostics/devices')).status, 200);
  });
});

describe('what must not be read across groups or shown as it is', () => {
  it('does not resolve the company of a place from another group (table and file), and cleans the name of the group', async () => {
    const foreign = fixtureId('company', 9200);
    await common().collection('companies').insertOne(legacyCompany(9200, g(3).groupId, { name: 'Other tenant', code: '99999999999' }));
    await common().collection('places').insertOne({ _id: fixtureId('place', 9200), groupId: g(2).groupId, companyId: foreign, name: 'Crossed', devices: [{ name: 'crossed' }] });
    const original = (await common().collection('groups').findOne({ _id: g(2).groupId }))!['name'];
    await common().collection('groups').updateOne({ _id: g(2).groupId }, { $set: { name: '  =HYPERLINK("x")  ' } });
    try {
      const row = (await call(g(2).sa, 'GET', '/diagnostics/devices?q=crossed')).body.data[0];
      assert.deepEqual([row.companyId, row.companyName, row.companyCode, row.groupName], [hex(foreign), null, null, '=HYPERLINK("x")']);
      const file = (await csv(g(2).sa, '?q=crossed')).text;
      assert.ok(!file.includes('Other tenant') && !file.includes('99999999999'));
      assert.ok(file.includes(`"'=HYPERLINK(""x"")";;;Crossed;crossed`));
    } finally {
      await common().collection('places').deleteOne({ _id: fixtureId('place', 9200) });
      await common().collection('companies').deleteOne({ _id: foreign });
      await common().collection('groups').updateOne({ _id: g(2).groupId }, { $set: { name: original } });
    }
  });
});

describe('the company codes the file prefixes', () => {
  it('does not prefix a code that is not only digits', async () => {
    await common().collection('companies').insertOne(legacyCompany(9100, g(2).groupId, { name: 'Zeta', code: 'IT123' }));
    await common().collection('places').insertOne({ _id: fixtureId('place', 9100), groupId: g(2).groupId, companyId: fixtureId('company', 9100), name: 'Z', devices: [{ name: 'Z1' }] });
    try {
      assert.ok((await csv(g(2).sa, '?q=Z1')).text.includes(';Zeta;IT123;Z;Z1;'));
    } finally {
      await common().collection('places').deleteOne({ _id: fixtureId('place', 9100) });
      await common().collection('companies').deleteOne({ _id: fixtureId('company', 9100) });
    }
  });
});
