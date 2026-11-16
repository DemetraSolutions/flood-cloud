import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import type { Response } from 'express';
import { AppError } from '../../src/shared/http/errors.ts';
import { countMirrorDevices, readMirrorDevices, trashedCompanyIds } from '../../src/shared/security/scope/group-mirror.ts';
import { deviceCountPipeline, deviceRowsPipeline } from '../../src/shared/security/scope/mirror-devices.ts';
import type { DeviceRowsQuery } from '../../src/shared/security/scope/mirror-devices.ts';
import { csvFileName, createDiagnosticsController } from '../../src/modules/diagnostics/diagnostics.controller.ts';
import { CSV_BOM, csvCell, csvLines } from '../../src/modules/diagnostics/diagnostics.csv.ts';
import { decodeDeviceCursor, encodeDeviceCursor } from '../../src/modules/diagnostics/diagnostics.cursor.ts';
import { toDeviceRow } from '../../src/modules/diagnostics/diagnostics.mapper.ts';
import type { DeviceRowView } from '../../src/modules/diagnostics/diagnostics.mapper.ts';
import { createDiagnosticsRepository } from '../../src/modules/diagnostics/diagnostics.repository.ts';
import { createDiagnosticsService } from '../../src/modules/diagnostics/diagnostics.service.ts';
import { createStoreKeysRepository, MAX_KEY_SUMMARY_PLACES } from '../../src/modules/store-keys/store-keys.repository.ts';
import { fixtureId } from '../helpers/legacy-fixtures.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { principalOf } from '../helpers/principal.ts';

let ctx: TestDatabases;
const g1 = fixtureId('group', 1);
const g2 = fixtureId('group', 2);

before(async () => {
  ctx = await openTestDatabases();
});
after(async () => ctx.cleanup());

const row = (overrides: Partial<DeviceRowView> = {}): DeviceRowView => ({
  id: 'p:0',
  groupId: 'g',
  groupName: 'G',
  companyId: null,
  companyName: null,
  companyCode: null,
  placeId: 'p',
  placeName: 'P',
  deviceId: null,
  deviceName: 'D',
  deviceType: null,
  appVersion: null,
  server: false,
  platform: null,
  platformVersion: null,
  model: null,
  lastDataDownload: null,
  lastSession: null,
  storeKey: { status: 'none', lastSeenAt: null, appVersion: null },
  ...overrides,
});

describe('the CSV', () => {
  it('neutralises what a spreadsheet reads as a formula, and quotes what holds the separator, a quotation mark or a line break', () => {
    for (const start of ['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx']) {
      assert.ok(csvCell(start).startsWith(start.startsWith('\r') ? '"\'\r' : "'"), JSON.stringify(start));
    }
    assert.equal(csvCell('=1+1'), "'=1+1");
    assert.equal(csvCell('a;b'), '"a;b"');
    assert.equal(csvCell('say "hi"'), '"say ""hi"""');
    assert.equal(csvCell('line\nbreak'), '"line\nbreak"');
    assert.equal(csvCell('=a;"b"'), '"\'=a;""b"""');
    assert.equal(csvCell('plain'), 'plain');
    assert.equal(csvCell(''), '');
    assert.equal(CSV_BOM, '﻿');
  });

  it('writes the dates in the Italian time zone, the key of the place and the digits of a code with the prefix of the legacy file', () => {
    const [line] = csvLines([
      row({ companyCode: '0123', lastDataDownload: '2026-07-01T10:00:00.000Z', lastSession: '2026-12-31T23:30:00.000Z', server: true, storeKey: { status: 'active', lastSeenAt: '2026-01-02T03:04:05.000Z', appVersion: '1.0' } }),
    ]).split('\r\n');
    assert.equal(line, 'G;;_0123;P;D;;;Sì;;;;01-07-2026 12:00:00;01-01-2027 00:30:00;Attiva;02-01-2026 04:04:05;1.0');
    assert.equal(csvLines([row()]), 'G;;;P;D;;;No;;;;;;Nessuna;;\r\n');
    assert.equal(csvLines([]), '');
  });
});

describe('the cursor', () => {
  it('round-trips a position and refuses everything else', () => {
    const after = { placeId: new ObjectId(), index: 7 };
    assert.deepEqual(decodeDeviceCursor(encodeDeviceCursor(after)), after);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const bad = ['', 'a b', '%%', Buffer.from('{').toString('base64url'), encode(null), encode([]), encode({ ver: 1, p: 'x', i: 0 }), encode({ ver: 1, p: 'a'.repeat(24), i: 1.5 }), encode({ ver: 1, p: 'a'.repeat(24), i: '1' }), encode({ ver: 1, p: 'a'.repeat(24), i: 0, extra: 1 }), encode({ ver: 1, p: 'A'.repeat(24), i: 0 })];
    for (const raw of bad) {
      assert.throws(() => decodeDeviceCursor(raw), (error: unknown) => error instanceof AppError && error.code === 'VALIDATION_ERROR', raw);
    }
  });
});

describe('the mapper', () => {
  it('reads every value with its type and cuts the long ones', () => {
    const placeId = new ObjectId();
    const groupId = new ObjectId();
    const mapped = toDeviceRow(
      { _id: placeId, groupId, index: 3n as unknown as number, placeName: 5, company: { name: ' Acme ', code: 1234 }, deviceName: 'x'.repeat(300), appVersion: ' ', platform: Number.NaN, lastDataDownload: 1_700_000_000_000, lastSession: {}, server: 1 },
      new Map(),
      new Map(),
    );
    assert.deepEqual([mapped.id, mapped.groupName, mapped.placeName, mapped.companyName, mapped.companyCode, mapped.deviceName.length, mapped.appVersion, mapped.platform, mapped.lastDataDownload, mapped.lastSession, mapped.server], [`${placeId.toHexString()}:3`, '', '5', 'Acme', '1234', 200, null, null, '2023-11-14T22:13:20.000Z', null, false]);
  });
});

describe('the reads of the copies', () => {
  const scope = { kind: 'platform' } as const;
  const query = (overrides: Partial<DeviceRowsQuery> = {}): DeviceRowsQuery => ({ groups: { kind: 'include', ids: [g1] }, scope, trashedCompanyIds: [], ...overrides });

  it('refuse a read without groups, with ids that are not ids, or without a positive limit', async () => {
    const { databases } = ctx;
    await assert.rejects(readMirrorDevices(databases, query({ groups: { kind: 'include', ids: [] } }), null, 5), /group ids/);
    await assert.rejects(readMirrorDevices(databases, query({ groups: { kind: 'include', ids: ['x' as unknown as ObjectId] } }), null, 5), /group ids/);
    await assert.rejects(readMirrorDevices(databases, query(), null, 0), /positive limit/);
    await assert.rejects(countMirrorDevices(databases, query(), 1.5), /positive limit/);
    await assert.rejects(trashedCompanyIds(databases, { kind: 'include', ids: [] }, undefined, 5), /group ids/);
    await assert.rejects(trashedCompanyIds(databases, { kind: 'exclude', ids: ['x' as unknown as ObjectId] }, undefined, 5), /group ids/);
  });

  it('counts the rows up to the cap, and the trashed companies up to their maximum, also narrowed to one company', async () => {
    const { databases } = ctx;
    const places = databases.common().collection('places');
    await places.insertMany([
      { _id: fixtureId('place', 1), groupId: g1, name: 'A', devices: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] },
      { _id: fixtureId('place', 2), groupId: g2, name: 'B', devices: [{ name: 'd' }] },
    ]);
    assert.equal(await countMirrorDevices(databases, query(), 10), 3);
    assert.equal(await countMirrorDevices(databases, query({ groups: { kind: 'include', ids: [g1, g2] } }), 3), 4);
    assert.equal(await countMirrorDevices(databases, query({ groups: { kind: 'exclude', ids: [g1] } }), 3), 1);
    assert.equal(await countMirrorDevices(databases, query({ groups: { kind: 'exclude', ids: [] } }), 10), 4);
    assert.equal(await countMirrorDevices(databases, query({ type: 'desk' }), 3), 0);
    await databases.common().collection('companies').insertOne({ _id: fixtureId('company', 1), groupId: g1, trash: true });
    const only = { kind: 'include', ids: [g1] } as const;
    assert.deepEqual(await trashedCompanyIds(databases, only, undefined, 2), [fixtureId('company', 1)]);
    assert.deepEqual(await trashedCompanyIds(databases, { kind: 'exclude', ids: [g2] }, fixtureId('company', 1), 2), [fixtureId('company', 1)]);
    assert.deepEqual(await trashedCompanyIds(databases, only, fixtureId('company', 2), 2), []);
    await assert.rejects(trashedCompanyIds(databases, only, undefined, 1), /Too many/);
  });

  it('the repository stops when the perimeter is larger than it can read completely', async () => {
    const { databases } = ctx;
    await databases.common().collection('groups').insertMany([{ _id: g1, name: 'one' }, { _id: g2, name: 7 }]);
    const repository = createDiagnosticsRepository(databases);
    assert.deepEqual(await repository.groupIds({}), [g1, g2]);
    assert.deepEqual([...(await repository.groupNames([g1, g2]))], [[g1.toHexString(), 'one'], [g2.toHexString(), '']]);
    await assert.rejects(createDiagnosticsRepository(databases, { maxGroups: 2 }).groupIds({}), /Too many groups/);
    await databases.common().collection('companies').insertOne({ _id: fixtureId('company', 2), groupId: g2, trash: true });
    await assert.rejects(createDiagnosticsRepository(databases, { maxTrashedCompanies: 2 }).trashedCompanies({ kind: 'include', ids: [g1, g2] }, undefined), /Too many companies/);
    assert.equal((await repository.devices(query(), null, 10)).length, 3);
    assert.equal(await repository.countDevices(query(), 10), 3);
  });

  it('summarises the active keys of at most a maximum of places, and nothing of the key', async () => {
    const { databases } = ctx;
    const repository = createStoreKeysRepository(databases);
    await assert.rejects(repository.summariesOfPlaces([g1], Array.from({ length: MAX_KEY_SUMMARY_PLACES + 1 }, () => new ObjectId())), /Too many/);
    assert.deepEqual(await repository.summariesOfPlaces([g1], []), []);
  });

  it('does not resolve the company of a place from another group, in the table or in the file', async () => {
    const { databases } = ctx;
    await databases.common().collection('companies').insertMany([
      { _id: fixtureId('company', 71), groupId: g1, name: 'Mine', code: 'IT1' },
      { _id: fixtureId('company', 72), groupId: g2, name: 'Theirs', code: 'IT2' },
    ]);
    await databases.common().collection('places').insertMany([
      { _id: fixtureId('place', 71), groupId: g1, companyId: fixtureId('company', 71), name: 'Own', devices: [{ name: 'own' }] },
      { _id: fixtureId('place', 72), groupId: g1, companyId: fixtureId('company', 72), name: 'Stolen', devices: [{ name: 'stolen' }] },
    ]);
    const rows = await createDiagnosticsRepository(databases).devices(query({ placeId: undefined, q: 'o' }), null, 20);
    const byName = Object.fromEntries(rows.map((row) => [row['placeName'], row['company']?.['name'] ?? null]));
    assert.deepEqual([byName['Own'], byName['Stolen']], ['Mine', null]);
  });

  it('builds a pipeline of fixed shape: allowed stages only, one join to the companies of the same group, an allowlist of device fields, the perimeter in the first match', () => {
    const query0: DeviceRowsQuery = { groups: { kind: 'include', ids: [g1] }, scope: { kind: 'places', groupId: g1, placeIds: [fixtureId('place', 1)] }, trashedCompanyIds: [fixtureId('company', 1)], companyId: fixtureId('company', 2), placeId: fixtureId('place', 1), type: 'desk', q: 'a.b' };
    for (const pipeline of [deviceRowsPipeline(query0, { placeId: fixtureId('place', 1), index: 2 }, 10), deviceCountPipeline(query0, 5)]) {
      const operators = pipeline.map((stage) => Object.keys(stage)[0]);
      assert.ok(operators.every((name) => ['$match', '$project', '$sort', '$unwind', '$limit', '$lookup', '$count'].includes(name!)), operators.join());
      const text = JSON.stringify(pipeline);
      for (const forbidden of ['$unionWith', '$out', '$merge', '$function', '$where', '$accumulator', '$graphLookup', '"users"', '"groups"']) {
        assert.ok(!text.includes(forbidden), forbidden);
      }
      const first = JSON.stringify(pipeline[0]);
      assert.ok(first.includes('"$in"') && first.includes('"trash":{"$ne":true}') && first.includes('"$type":"objectId"') && first.includes('"$nin"'), first);
      assert.ok(first.includes(`"_id":{"$in":["${fixtureId('place', 1).toHexString()}"]}`), 'the perimeter of the caller is applied by the pipeline itself');
    }
    const rows = deviceRowsPipeline(query0, null, 10);
    assert.equal(rows.filter((stage) => '$lookup' in stage).length, 1);
    const lookup = rows.find((stage) => '$lookup' in stage)!['$lookup'] as { from: string; pipeline: Document[] };
    assert.equal(lookup.from, 'companies');
    assert.deepEqual(lookup.pipeline[1], { $project: { _id: 0, name: 1, code: 1 } });
    assert.deepEqual(Object.keys(rows[rows.length - 1]!['$project']).sort(), ['appVersion', 'company', 'companyId', 'deviceId', 'deviceName', 'deviceType', 'groupId', 'index', 'lastDataDownload', 'lastSession', 'model', 'placeName', 'platform', 'platformVersion', 'server']);
    const fields = Object.keys(rows.filter((stage) => '$project' in stage)[1]!['$project']).sort();
    assert.deepEqual(fields, ['__index', 'companyId', 'devices.id', 'devices.info.appVersion', 'devices.info.date', 'devices.info.lastDataDownload', 'devices.info.system.model', 'devices.info.system.platform', 'devices.info.system.platformVersion', 'devices.name', 'devices.server', 'devices.type', 'groupId', 'name']);
  });
});

describe('the service', () => {
  const documents = (count: number): Document[] => Array.from({ length: count }, (_unused, index) => ({ _id: fixtureId('place', 1), groupId: g1, index, placeName: 'P', deviceName: `d${String(index)}` }));
  const make = (limits?: { maxExportRows?: number; batchRows?: number }, total = 7, available = 7) => {
    const calls: Array<{ after: unknown; limit: number }> = [];
    const groupFilters: unknown[] = [];
    const service = createDiagnosticsService({
      repository: {
        groupIds: async (filter) => {
          groupFilters.push(filter);
          return [g1];
        },
        groupNames: async () => new Map([[g1.toHexString(), 'G']]),
        trashedCompanies: async () => [],
        devices: async (_query, after, limit) => {
          calls.push({ after, limit });
          const from = after === null ? 0 : (after as { index: number }).index + 1;
          return documents(available).slice(from, from + limit);
        },
        countDevices: async () => total,
      },
      storeKeys: { summariesOfPlaces: async () => [] },
      ...(limits === undefined ? {} : { limits }),
    });
    return { service, calls, groupFilters };
  };
  const psa = principalOf('PSA');

  it('refuses an export of more rows than the limit before reading any row, and streams the others in batches', async () => {
    await assert.rejects(make({ maxExportRows: 6 }).service.export(psa, {}), (error: unknown) => error instanceof AppError && error.code === 'PAYLOAD_TOO_LARGE');
    const { service, calls } = make({ batchRows: 3 });
    const exported = await service.export(psa, {});
    assert.equal(exported.total, 7);
    assert.deepEqual(calls, []);
    const sizes: number[] = [];
    for await (const batch of exported.batches()) {
      sizes.push(batch.length);
    }
    assert.deepEqual(sizes, [3, 3, 1]);
  });

  it('never writes more rows than the limit, even when rows were added after the count', async () => {
    const { service } = make({ maxExportRows: 5, batchRows: 3 }, 4, 20);
    const sizes: number[] = [];
    for await (const batch of (await service.export(psa, {})).batches()) {
      sizes.push(batch.length);
    }
    assert.deepEqual(sizes, [3, 2]);
  });

  it('reads the platform as the groups to leave out, and the other roles as the groups of their perimeter', async () => {
    const { service, groupFilters } = make();
    await service.list(psa, {});
    assert.deepEqual(groupFilters, [{ $or: [{ demo: true }, { trash: true }] }]);
    await service.list(principalOf('SA', { groupId: g1 }), {});
    assert.equal(groupFilters.length, 2);
    await service.list(psa, { groupId: g1 });
    assert.equal(JSON.stringify(groupFilters[2]).includes('demo'), false);
  });

  it('answers an empty page and an empty export when the perimeter has no group', async () => {
    const service = createDiagnosticsService({
      repository: { groupIds: async () => [], groupNames: async () => new Map(), trashedCompanies: async () => [], devices: async () => [], countDevices: async () => 0 },
      storeKeys: { summariesOfPlaces: async () => [] },
    });
    const sa = principalOf('SA', { groupId: g1 });
    assert.deepEqual(await service.list(sa, {}), { items: [], page: { limit: 50, next: null } });
    const exported = await service.export(sa, {});
    assert.equal(exported.total, 0);
    assert.deepEqual(await Array.fromAsync(exported.batches()), []);
  });
});

describe('the controller', () => {
  const body = { locals: { auth: principalOf('PSA'), input: { query: {} } } };
  /** A response that goes away after its first chunk, as a client that closes the connection. */
  function leavingResponse(): Response {
    const out = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
        this.destroy();
      },
    });
    return Object.assign(out, { ...body, status: () => out, setHeader: () => out }) as unknown as Response;
  }
  const sinkResponse = (): Response => {
    const sink = new PassThrough();
    sink.resume();
    return Object.assign(sink, { ...body, status: () => sink, setHeader: () => sink }) as unknown as Response;
  };
  const noRows = { list: async () => ({ items: [], page: { limit: 1, next: null } }), export: async () => ({ total: 0, batches: async function* () {} }) };

  it('stops quietly when the client goes away, and lets any other failure through', async () => {
    const service = createDiagnosticsService({
      repository: { groupIds: async () => [g1], groupNames: async () => new Map(), trashedCompanies: async () => [], devices: async () => [], countDevices: async () => 0 },
      storeKeys: { summariesOfPlaces: async () => [] },
    });
    const controller = createDiagnosticsController(service, () => Date.UTC(2026, 10, 16));
    await controller.devicesCsv({} as never, leavingResponse(), () => undefined);
    const failing = createDiagnosticsController({ list: service.list, export: async () => ({ total: 1, batches: async function* () { throw new Error('database down'); } }) }, () => 0);
    await assert.rejects(failing.devicesCsv({} as never, sinkResponse(), () => undefined) as Promise<void>, /database down/);
    assert.equal(csvFileName(new Date(Date.UTC(2026, 10, 16, 23, 0, 0))), 'devices-diagnostic_2026-11-16.csv');
  });

  it('allows one export at a time to a user, and frees the place when it ends or fails', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = createDiagnosticsController({ ...noRows, export: async () => ({ total: 1, batches: async function* () { await gate; yield []; } }) }, () => 0);
    const first = slow.devicesCsv({} as never, sinkResponse(), () => undefined) as Promise<void>;
    await assert.rejects(slow.devicesCsv({} as never, sinkResponse(), () => undefined) as Promise<void>, (error: unknown) => error instanceof AppError && error.code === 'RATE_LIMITED');
    release();
    await first;
    await (slow.devicesCsv({} as never, sinkResponse(), () => undefined) as Promise<void>);
  });

  it('stops an export that takes longer than its limit', async () => {
    const stuck = createDiagnosticsController({ ...noRows, export: async () => ({ total: 1, batches: async function* () { await new Promise((resolve) => setTimeout(resolve, 200)); } }) }, () => 0, 20);
    await assert.rejects(stuck.devicesCsv({} as never, sinkResponse(), () => undefined) as Promise<void>, (error: unknown) => (error as Error).name === 'TimeoutError' || (error as Error).name === 'AbortError');
  });
});
