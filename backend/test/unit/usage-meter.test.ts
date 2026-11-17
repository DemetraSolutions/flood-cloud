import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { createUsageMeter, DEFAULT_MAX_USAGE_ENTRIES, MAX_ROW_ATTEMPTS } from '../../src/modules/api-keys/usage-meter.ts';
import type { UsageEvent } from '../../src/modules/api-keys/usage-meter.ts';
import type { UsageIncrement, UsageWriteResult } from '../../src/modules/api-keys/api-keys.types.ts';
import { memoryLogger } from '../helpers/app.ts';

const KEY = new ObjectId('0a0000000000000000000001');
const GROUP = new ObjectId('020000000000000000000001');
const event = (overrides: Partial<UsageEvent> = {}): UsageEvent => ({ keyId: KEY, groupId: GROUP, day: '2026-11-17', route: 'GET /public/v1/me', status: 200, ...overrides });

/** A repository that keeps what it is given, and fails or gives rows back when told to. */
function fakeRepository() {
  const batches: UsageIncrement[][] = [];
  const OK: UsageWriteResult = { failed: [], unacknowledged: false };
  const state: { failWith: unknown; result: (rows: readonly UsageIncrement[]) => UsageWriteResult; hold: ((rows: readonly UsageIncrement[]) => Promise<UsageWriteResult>) | undefined } = { failWith: undefined, result: () => OK, hold: undefined };
  return {
    batches,
    state,
    repository: {
      addUsage: (rows: readonly UsageIncrement[]): Promise<UsageWriteResult> => {
        batches.push(rows.map((row) => ({ ...row })));
        if (state.hold !== undefined) {
          const hold = state.hold;
          state.hold = undefined;
          return hold(rows);
        }
        return state.failWith === undefined ? Promise.resolve(state.result(rows)) : Promise.reject(state.failWith);
      },
    },
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const counts = (row: UsageIncrement) => [row.calls, row.errors4xx, row.errors5xx, row.rateLimited];
const refused = (rows: readonly UsageIncrement[], code: number | undefined): UsageWriteResult => ({ failed: rows.map((row) => ({ row, code })), unacknowledged: false });

describe('the usage meter', () => {
  it('aggregates the requests by key, day and route, and classifies the outcomes', async () => {
    const fake = fakeRepository();
    const meter = createUsageMeter({ repository: fake.repository, logger: memoryLogger().logger, flushIntervalMs: 1000 });
    for (const status of [200, 201, 304, 404, 422, 403, 429, 429, 429, 500, 503]) {
      meter.record(event({ status }));
    }
    meter.record(event({ route: 'GET /public/v1/places' }));
    meter.record(event({ day: '2026-11-18' }));
    meter.record(event({ keyId: new ObjectId('0a0000000000000000000002') }));
    assert.equal(fake.batches.length, 0, 'a request costs no write');
    await meter.flush();
    assert.equal(fake.batches.length, 1);
    const byRoute = new Map(fake.batches[0]!.map((row) => [`${row.keyId.toHexString().slice(-1)} ${row.day} ${row.route}`, row]));
    assert.equal(byRoute.size, 4);
    assert.deepEqual(counts(byRoute.get('1 2026-11-17 GET /public/v1/me')!), [11, 3, 2, 3]);
    assert.deepEqual(counts(byRoute.get('1 2026-11-17 GET /public/v1/places')!), [1, 0, 0, 0]);
    assert.deepEqual(counts(byRoute.get('1 2026-11-18 GET /public/v1/me')!), [1, 0, 0, 0]);
    assert.deepEqual(counts(byRoute.get('2 2026-11-17 GET /public/v1/me')!), [1, 0, 0, 0]);
    assert.deepEqual([byRoute.get('1 2026-11-17 GET /public/v1/me')!.groupId, byRoute.get('1 2026-11-17 GET /public/v1/me')!.keyId], [GROUP, KEY]);
    await meter.flush();
    assert.equal(fake.batches.length, 1, 'an empty flush does not write');
  });

  it('starts from zero after a write, so a request is never written twice', async () => {
    const fake = fakeRepository();
    const meter = createUsageMeter({ repository: fake.repository, logger: memoryLogger().logger, flushIntervalMs: 1000 });
    meter.record(event());
    await meter.flush();
    meter.record(event());
    await meter.flush();
    assert.deepEqual(fake.batches.map((batch) => batch.map(counts)), [[[1, 0, 0, 0]], [[1, 0, 0, 0]]]);
  });

  it('writes early when it holds the most rows it can, drops the rows beyond that and says so at the next write', async () => {
    const fake = fakeRepository();
    const logs = memoryLogger();
    const meter = createUsageMeter({ repository: fake.repository, logger: logs.logger, flushIntervalMs: 60_000, maxEntries: 3 });
    meter.record(event({ route: 'GET /a' }));
    meter.record(event({ route: 'GET /b' }));
    await tick();
    assert.equal(fake.batches.length, 0);
    meter.record(event({ route: 'GET /c' }));
    // The third row filled the memory: the write starts at once.
    await tick();
    assert.equal(fake.batches.length, 1);
    assert.deepEqual(fake.batches[0]!.map((row) => row.route).sort(), ['GET /a', 'GET /b', 'GET /c']);
    // The database is down: the next three rows fill the memory again and stay there.
    fake.state.failWith = new Error('down');
    for (const route of ['GET /d', 'GET /e', 'GET /f']) {
      meter.record(event({ route }));
    }
    await tick();
    assert.equal(fake.batches.length, 2);
    // A fourth distinct row has no room (and does not start a write); one that is already held is counted.
    meter.record(event({ route: 'GET /g' }));
    meter.record(event({ route: 'GET /d' }));
    await tick();
    assert.equal(fake.batches.length, 2);
    fake.state.failWith = undefined;
    await meter.flush();
    const last = fake.batches[fake.batches.length - 1]!;
    assert.deepEqual(last.map((row) => [row.route, row.calls]).sort(), [['GET /d', 2], ['GET /e', 1], ['GET /f', 1]]);
    assert.deepEqual(logs.events.filter((entry) => entry['msg'] === 'public API usage rows dropped: the memory of the meter was full').map((entry) => entry['dropped']), [1]);
    assert.equal(DEFAULT_MAX_USAGE_ENTRIES, 5000);
  });

  it('keeps what it could not write, logs the name of the error and writes it with the next block, without ever rejecting', async () => {
    const fake = fakeRepository();
    const logs = memoryLogger();
    const meter = createUsageMeter({ repository: fake.repository, logger: logs.logger, flushIntervalMs: 1000 });
    meter.record(event({ status: 429 }));
    fake.state.failWith = Object.assign(new Error('mongodb://user:secret@host is down'), { name: 'MongoNetworkError' });
    await meter.flush();
    fake.state.failWith = undefined;
    meter.record(event());
    meter.record(event({ route: 'GET /public/v1/taxes' }));
    await meter.flush();
    assert.deepEqual(
      fake.batches[fake.batches.length - 1]!.map((row) => [row.route, ...counts(row)]).sort(),
      [['GET /public/v1/me', 2, 0, 0, 1], ['GET /public/v1/taxes', 1, 0, 0, 0]],
    );
    const failures = logs.events.filter((entry) => entry['msg'] === 'writing the usage of the public API failed');
    assert.deepEqual(failures.map((entry) => [entry['errorName'], entry['rows']]), [['MongoNetworkError', 1]]);
    assert.ok(!JSON.stringify(logs.events).includes('secret'), 'the message of the error is never logged');
  });

  it('names an error that is not an Error by its type', async () => {
    const fake = fakeRepository();
    const logs = memoryLogger();
    const meter = createUsageMeter({ repository: fake.repository, logger: logs.logger, flushIntervalMs: 1000 });
    meter.record(event());
    fake.state.failWith = 'plain text';
    await meter.flush();
    assert.deepEqual(logs.events.map((entry) => entry['errorName']), ['string']);
  });

  it('writes again only the rows the repository gives back, and respects the limit of its memory while it does', async () => {
    const fake = fakeRepository();
    const logs = memoryLogger();
    const meter = createUsageMeter({ repository: fake.repository, logger: logs.logger, flushIntervalMs: 60_000, maxEntries: 2 });
    let finish!: (result: UsageWriteResult) => void;
    fake.state.hold = () => new Promise<UsageWriteResult>((resolve) => void (finish = resolve));
    meter.record(event({ route: 'GET /a' }));
    meter.record(event({ route: 'GET /b' }));
    await tick();
    // The block of `a` and `b` is being written; meanwhile the memory takes `a` again and `c`, and is full.
    meter.record(event({ route: 'GET /a' }));
    meter.record(event({ route: 'GET /c' }));
    // The write gives both rows back: `a` joins its newer count, `b` finds no room.
    finish({ failed: fake.batches[0]!.map((row) => ({ row, code: undefined })), unacknowledged: false });
    await meter.flush();
    const last = fake.batches[fake.batches.length - 1]!;
    assert.deepEqual(last.map((row) => [row.route, row.calls]).sort(), [['GET /a', 2], ['GET /c', 1]]);
    assert.deepEqual(logs.events.filter((entry) => entry['msg'] === 'public API usage rows dropped: the memory of the meter was full').map((entry) => entry['dropped']), [1]);
  });

  it('counts an aborted request as a call and as aborted, whatever the status it had', async () => {
    const fake = fakeRepository();
    const meter = createUsageMeter({ repository: fake.repository, logger: memoryLogger().logger, flushIntervalMs: 1000 });
    meter.record(event({ status: 200, aborted: true }));
    meter.record(event({ status: 500, aborted: true }));
    meter.record(event({ status: 200, aborted: false }));
    await meter.flush();
    assert.deepEqual(fake.batches[0]!.map((row) => [row.calls, row.errors4xx, row.errors5xx, row.rateLimited, row.aborted]), [[3, 0, 0, 0, 2]]);
  });

  it('drops at once, and logs, the rows the database refuses for a reason no attempt can cure, and keeps the others of the block', async () => {
    const fake = fakeRepository();
    const logs = memoryLogger();
    const meter = createUsageMeter({ repository: fake.repository, logger: logs.logger, flushIntervalMs: 1000 });
    meter.record(event({ route: 'GET /bad' }));
    meter.record(event({ route: 'GET /good' }));
    fake.state.result = (rows) => refused(rows.filter((row) => row.route === 'GET /bad'), 121);
    await meter.flush();
    fake.state.result = () => ({ failed: [], unacknowledged: false });
    await meter.flush();
    assert.equal(fake.batches.length, 1, 'nothing is written again');
    assert.deepEqual(logs.events.map((entry) => [entry['msg'], entry['rows'], entry['dropped'], entry['codes']]), [['the database refused rows of the usage of the public API', 1, 1, [121]]]);
    for (const code of [2, 9]) {
      meter.record(event());
      fake.state.result = (rows) => refused(rows, code);
      await meter.flush();
    }
    assert.deepEqual(logs.events.slice(1).map((entry) => [entry['dropped'], entry['codes']]), [[1, [2]], [1, [9]]]);
  });

  it('writes again a row the database refused for another reason, and drops it, logging each time, after the fifth refusal', async () => {
    const fake = fakeRepository();
    const logs = memoryLogger();
    const meter = createUsageMeter({ repository: fake.repository, logger: logs.logger, flushIntervalMs: 1000 });
    meter.record(event());
    fake.state.result = (rows) => refused(rows, undefined);
    for (let attempt = 0; attempt < MAX_ROW_ATTEMPTS + 2; attempt += 1) {
      await meter.flush();
    }
    assert.equal(fake.batches.length, MAX_ROW_ATTEMPTS);
    assert.deepEqual(logs.events.map((entry) => [entry['dropped'], entry['codes']]), [[0, [null]], [0, [null]], [0, [null]], [0, [null]], [1, [null]]]);
  });

  it('logs a write that the database applied without the confirmation asked, and does not write it again', async () => {
    const fake = fakeRepository();
    const logs = memoryLogger();
    const meter = createUsageMeter({ repository: fake.repository, logger: logs.logger, flushIntervalMs: 1000 });
    meter.record(event());
    fake.state.result = () => ({ failed: [], unacknowledged: true });
    await meter.flush();
    fake.state.result = () => ({ failed: [], unacknowledged: false });
    await meter.flush();
    assert.equal(fake.batches.length, 1);
    assert.deepEqual(logs.events.map((entry) => [entry['msg'], entry['rows']]), [['the usage of the public API was written without the confirmation asked: it is not written again', 1]]);
  });

  it('writes by itself every interval once started, and at stop writes what is left; it can be stopped twice or never started', async () => {
    const fake = fakeRepository();
    const meter = createUsageMeter({ repository: fake.repository, logger: memoryLogger().logger, flushIntervalMs: 15 });
    meter.start();
    meter.record(event());
    for (let attempt = 0; attempt < 100 && fake.batches.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(fake.batches.length, 1);
    meter.record(event({ route: 'GET /public/v1/taxes' }));
    await meter.stop();
    assert.deepEqual(fake.batches[fake.batches.length - 1]!.map((row) => row.route), ['GET /public/v1/taxes']);
    const before = fake.batches.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(fake.batches.length, before, 'stopped: no more ticks');
    await meter.stop();
    const never = createUsageMeter({ repository: fake.repository, logger: memoryLogger().logger, flushIntervalMs: 1000 });
    never.record(event());
    await never.stop();
    assert.equal(fake.batches.length, before + 1);
  });
});
