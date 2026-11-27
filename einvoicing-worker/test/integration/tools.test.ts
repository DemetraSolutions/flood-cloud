import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { createMongoClient } from '../../src/db/client.ts';
import { commonDatabaseName, queueDatabaseName } from '../../src/db/names.ts';
import { SHADOW_COLLECTION } from '../../src/shadow/reports.ts';
import type { ShadowReport } from '../../src/shadow/reports.ts';
import { currentCodeVersion } from '../../src/shadow/version.ts';
import { runInflight, formatInflight, MAX_LISTED } from '../../src/tools/inflight.ts';
import type { InflightReport } from '../../src/tools/inflight.ts';
import { formatSummary, MAX_RECORDS_PER_CODE, parseSince, runShadowReport, summarise } from '../../src/tools/shadow-report.ts';
import type { ToolProcess } from '../../src/tools/context.ts';
import { mongoEnv } from '../helpers/env.ts';
import { createWorld, T0 } from '../helpers/world.ts';
import type { World } from '../helpers/world.ts';

function toolProcess(env: Record<string, string | undefined>, argv: string[] = []) {
  const out: string[] = [];
  const err: string[] = [];
  const proc: ToolProcess = { env, argv, stdout: { write: (text) => out.push(text) }, stderr: { write: (text) => err.push(text) } };
  return { proc, out: () => out.join(''), err: () => err.join('') };
}

describe('the operator commands', () => {
  let world: World;
  before(async () => {
    world = await createWorld();
  });
  after(async () => {
    await world.drop();
  });
  beforeEach(async () => {
    await world.reset();
    await world.client.db(commonDatabaseName(world.names)).collection(SHADOW_COLLECTION).deleteMany({});
  });

  const env = (overrides: Record<string, string | undefined> = {}) => mongoEnv({ DB_NAME_PREFIX: world.names.prefix, ...overrides });
  const reportsCollection = () => world.client.db(commonDatabaseName(world.names)).collection<ShadowReport>(SHADOW_COLLECTION);

  function report(values: Partial<ShadowReport> & { queueId?: ObjectId } = {}): ShadowReport {
    return {
      queueId: new ObjectId(),
      hub: 'aruba',
      groupId: null,
      documentType: 'TD01',
      number: '42',
      date: '2026-11-27',
      outcome: 'ok',
      issues: [],
      xmlBytes: 1000,
      xmlSha256: 'a'.repeat(64),
      codeVersion: 'v1',
      analysedAt: new Date(T0),
      ...values,
    };
  }

  describe('shadow:report', () => {
    async function seed(): Promise<void> {
      const error = (code: string) => ({ code, path: 'x', severity: 'error' as const });
      const rows: ShadowReport[] = [
        report({ queueId: new ObjectId('000000000000000000000001'), xmlBytes: 100 }),
        report({ queueId: new ObjectId('000000000000000000000002'), outcome: 'warnings', issues: [{ code: 'LINKED', path: 'y', severity: 'warning' }], xmlBytes: 200 }),
        report({ queueId: new ObjectId('000000000000000000000003'), hub: 'aruba__0123456789abcdef01234567', outcome: 'blocked', issues: [error('00404'), error('00404'), { code: 'LINKED', path: 'y', severity: 'warning' }], xmlBytes: null, xmlSha256: null }),
        report({ queueId: new ObjectId('000000000000000000000004'), outcome: 'blocked', issues: [error('00403')], number: null, date: null, documentType: null, xmlBytes: null, xmlSha256: null }),
        report({ queueId: new ObjectId('000000000000000000000005'), outcome: 'mappingFailed', issues: [error('MAPPING')], xmlBytes: null, xmlSha256: null, analysedAt: new Date(T0 - 10 * 86_400_000) }),
        report({ queueId: new ObjectId('000000000000000000000006'), codeVersion: 'v0', outcome: 'blocked', issues: [error('OLD')] }),
      ];
      await reportsCollection().insertMany(rows);
    }

    it('summarises the totals, hubs, issue codes, blocked records and sizes of a code version', async () => {
      await seed();
      const summary = await summarise(reportsCollection(), 'v1', undefined);
      assert.deepEqual(summary.byOutcome, { ok: 1, warnings: 1, blocked: 2, mappingFailed: 1 });
      assert.equal(summary.total, 5);
      assert.deepEqual(summary.byHub.map((row) => [row.hub, row.total, row.blocked]), [['aruba', 4, 1], ['aruba__0123456789abcdef01234567', 1, 1]]);
      assert.deepEqual(summary.topIssues.map((entry) => `${entry.code}:${entry.severity}:${entry.occurrences}`), ['00404:error:2', '00403:error:1', 'LINKED:warning:2', 'MAPPING:error:1'].sort((a, b) => Number(b.split(':')[2]) - Number(a.split(':')[2]) || a.localeCompare(b)));
      assert.deepEqual(summary.blocked.map((entry) => [entry.code, entry.records]), [['00403', 1], ['00404', 1], ['MAPPING', 1]]);
      assert.deepEqual(summary.blocked[1]?.examples, [{ queueId: '000000000000000000000003', hub: 'aruba__0123456789abcdef01234567', documentType: 'TD01', number: '42', date: '2026-11-27' }]);
      assert.deepEqual(summary.blocked[0]?.examples, [{ queueId: '000000000000000000000004', hub: 'aruba', documentType: null, number: null, date: null }]);
      assert.deepEqual(summary.size, { files: 2, maxBytes: 200, p95Bytes: 200 });
      assert.equal(summary.since, null);
      const since = await summarise(reportsCollection(), 'v1', new Date(T0 - 86_400_000));
      assert.equal(since.total, 4);
      assert.equal(since.since, new Date(T0 - 86_400_000).toISOString());
    });

    it('computes the 95th percentile by nearest rank and lists at most 20 records per code', async () => {
      await reportsCollection().insertMany(
        Array.from({ length: 30 }, (_, index) => report({ queueId: new ObjectId(), xmlBytes: (index + 1) * 10, outcome: 'blocked', issues: [{ code: '00404', path: 'x', severity: 'error' }] })),
      );
      const summary = await summarise(reportsCollection(), 'v1', undefined);
      assert.deepEqual(summary.size, { files: 30, maxBytes: 300, p95Bytes: 290 });
      assert.deepEqual([summary.blocked[0]?.records, summary.blocked[0]?.examples.length], [30, MAX_RECORDS_PER_CODE]);
      const ids = summary.blocked[0]?.examples.map((entry) => entry.queueId) ?? [];
      assert.deepEqual(ids, [...ids].sort(), 'the first ones by queue id');
    });

    it('prints plain text, without any customer datum beyond the document identity', async () => {
      await seed();
      const run = toolProcess(env({ BUILD_SHA: undefined }), ['--version', 'v1']);
      assert.equal(await runShadowReport(run.proc), 0);
      assert.equal(run.err(), '');
      const text = run.out();
      assert.match(text, /^Shadow report - code version v1\n/);
      assert.match(text, /Records analysed: 5\nBy outcome: ok 1, warnings 1, blocked 2, mappingFailed 1\n/);
      assert.match(text, /  aruba: total 4, ok 1, warnings 1, blocked 1, mappingFailed 1\n  aruba__0123456789abcdef01234567: total 1/);
      assert.match(text, /  00404 \(error\): 2\n/);
      assert.match(text, /  00404: 1 record\(s\)\n    000000000000000000000003 aruba__0123456789abcdef01234567 TD01 42 2026-11-27\n/);
      assert.match(text, /    000000000000000000000004 aruba - - -\n/);
      assert.match(text, /File size: max 200 bytes, p95 200 bytes \(2 files\)\n$/);
      assert.equal(formatSummary({ ...(await summarise(reportsCollection(), 'none', undefined)) }).includes('no file was built'), true);
    });

    it('prints JSON and filters by version and by --since (ISO date or duration)', async () => {
      await seed();
      const json = toolProcess(env(), ['--version', 'v1', '--json']);
      assert.equal(await runShadowReport(json.proc), 0);
      const parsed = JSON.parse(json.out()) as { total: number; codeVersion: string; since: null };
      assert.deepEqual([parsed.total, parsed.codeVersion, parsed.since], [5, 'v1', null]);
      const iso = toolProcess(env(), ['--version', 'v1', '--json', '--since', new Date(T0 - 86_400_000).toISOString()]);
      assert.equal(await runShadowReport(iso.proc), 0);
      assert.equal((JSON.parse(iso.out()) as { total: number }).total, 4);
      const duration = toolProcess(env(), ['--version', 'v1', '--json', '--since', '2d']);
      assert.equal(await runShadowReport(duration.proc, { clock: () => T0 }), 0);
      assert.equal((JSON.parse(duration.out()) as { total: number }).total, 4);
      const hours = toolProcess(env(), ['--version', 'v1', '--json', '--since', '1h']);
      assert.equal(await runShadowReport(hours.proc, { clock: () => T0 + 3_600_000 + 1 }), 0);
      assert.equal((JSON.parse(hours.out()) as { total: number }).total, 0);
      const dated = toolProcess(env(), ['--since', '2026-11-27']);
      assert.equal(await runShadowReport(dated.proc), 0);
      assert.match(dated.out(), /analysed since 2026-11-27T00:00:00.000Z/);
    });

    it('defaults to the version of this build, with BUILD_SHA', async () => {
      const version = currentCodeVersion('abc123');
      assert.match(version, /^\d+\.\d+\.\d+\+abc123$/);
      await reportsCollection().insertOne(report({ codeVersion: version }));
      const run = toolProcess(env({ BUILD_SHA: 'abc123' }));
      assert.equal(await runShadowReport(run.proc), 0);
      assert.match(run.out(), new RegExp(`code version ${version.replace('+', '\\+')}\\n`));
      assert.match(run.out(), /Records analysed: 1\n/);
    });

    it('refuses wrong options with exit code 2 and a bad configuration or an unreachable MongoDB with 1, never echoing a secret', async () => {
      for (const argv of [['--nope'], ['--version'], ['--since', 'yesterday'], ['--since', '2026-13-99x'], ['stray']]) {
        const run = toolProcess(env(), argv);
        assert.equal(await runShadowReport(run.proc), 2, argv.join(' '));
        assert.match(run.err(), /usage: shadow-report/);
        assert.equal(run.out(), '');
      }
      const bad = toolProcess({ APP_ENV: 'nope', MONGODB_URI: 'mongodb://user:topsecret@h/' });
      assert.equal(await runShadowReport(bad.proc), 1);
      assert.match(bad.err(), /invalid configuration:\n/);
      assert.doesNotMatch(bad.err(), /topsecret/);
      const down = toolProcess(env({ MONGODB_URI: 'mongodb://127.0.0.1:1/?directConnection=true' }));
      assert.equal(
        await runShadowReport(down.proc, {
          createClient: (config) => {
            const client = createMongoClient(config);
            client.connect = async () => {
              throw new Error('mongodb://user:topsecret@h/ refused');
            };
            return client;
          },
        }),
        1,
      );
      assert.equal(down.err(), 'MongoDB is not available (Error)\n');
    });

    it('reports a query that fails after connecting, without a stack or a message, and exits 1', async () => {
      const run = toolProcess(env());
      const code = await runShadowReport(run.proc, {
        createClient: (config) => {
          const client = createMongoClient(config);
          const real = client.db.bind(client);
          client.db = (name) => {
            if (name === 'admin') {
              return real(name);
            }
            throw Object.assign(new Error('mongodb://user:topsecret@h/ exploded'), { name: 'MongoServerError' });
          };
          return client;
        },
      });
      assert.equal(code, 1);
      assert.equal(run.err(), 'the report failed (MongoServerError)\n');
    });

    it('needs neither credentials nor a hub, whatever the mode of the deployment says', async () => {
      const run = toolProcess(env({ WORKER_MODE: 'send', WORKER_HUBS: 'aruba', WORKER_INSTANCE_ID: undefined }), ['--version', 'none']);
      assert.equal(await runShadowReport(run.proc), 0, run.err());
      const named = toolProcess(env({ WORKER_MODE: 'send', WORKER_HUBS: 'aruba', WORKER_INSTANCE_ID: 'pod-1' }), ['--version', 'none']);
      assert.equal(await runShadowReport(named.proc), 0, named.err());
    });

    it('parses --since', () => {
      assert.equal(parseSince('3h', 10_800_000)?.getTime(), 0);
      assert.equal(parseSince('1d', 86_400_000)?.getTime(), 0);
      assert.equal(parseSince('2026-11-27T10:00:00Z', 0)?.toISOString(), '2026-11-27T10:00:00.000Z');
      for (const bad of ['', 'x', '10', '1w', '2026-99-99', 'yesterday 2026-01-01']) {
        assert.equal(parseSince(bad, 0), undefined, bad);
      }
    });
  });

  describe('ops:inflight', () => {
    const queue = () => world.client.db(queueDatabaseName(world.names)).collection<Document>('documents');
    const NOW = T0;
    const later = new Date(NOW + 60_000);
    const earlier = new Date(NOW - 60_000);

    it('exits 0 and says so when nothing is being claimed, uploading or possibly sent, and counts the rest as information', async () => {
      await queue().insertMany([
        { sendStatus: 'sent', worker: { state: 'uploaded' }, sent: true, hubId: 'f.xml' },
        { sendStatus: 'validationError', worker: { state: 'failed' } },
        { worker: { state: 'review', attempts: 2, lastCode: 'X' }, hubId: 'f2.xml', sent: true },
        { worker: { state: 'claimed', leaseUntil: earlier } },
        { worker: { state: 'claimed' } },
        {},
      ]);
      const run = toolProcess(env());
      assert.equal(await runInflight(run.proc, { clock: () => NOW }), 0);
      const text = run.out();
      assert.match(text, /^In flight: claimed \(lease running\) 0, uploading 0, possibly sent \(review without hubId\) 0\n/);
      assert.match(text, /Information only: claimed with an expired lease 2, review in total 1\n/);
      assert.match(text, /History entry pending: 0\n/);
      assert.match(text, /By sendStatus:\n  \(none\): 4\n  sent: 1\n  validationError: 1\n/);
      assert.match(text, /Nothing is claimed, uploading or possibly sent: exit 0\n$/);
    });

    it('exits 1 for a claim with a running lease, an upload in progress or a review record without hubId, listing them', async () => {
      const claimed = new ObjectId();
      const uploading = new ObjectId();
      const stopped = new ObjectId();
      const pending = new ObjectId();
      await queue().insertMany([
        { _id: claimed, worker: { state: 'claimed', attempts: 1, leaseUntil: later }, company: { fattura_elettronica: { hub: 'aruba__0123456789abcdef01234567' } }, number: '5', date: '2026-11-27T10:00:00.000Z' },
        { _id: uploading, worker: { state: 'uploading', attempts: 3 }, company: { fattura_elettronica: { hub: 'aruba' } } },
        { _id: stopped, worker: { state: 'review', lastCode: 'FIND_INCOMPLETE', attempts: 2, leaseUntil: earlier }, company: { fattura_elettronica: { hub: 'aruba' } }, number: 7, prefixSuffix: 'A/', date: new Date(NOW), fattura_elettronica: { tipo: 'TD01' } },
        { _id: pending, sent: true, hubId: 'f.xml', worker: { historyPending: true } },
      ]);
      const text = toolProcess(env());
      assert.equal(await runInflight(text.proc, { clock: () => NOW }), 1);
      assert.match(text.out(), /^In flight: claimed \(lease running\) 1, uploading 1, possibly sent \(review without hubId\) 1\n/);
      assert.match(text.out(), new RegExp(`${claimed.toHexString()} aruba__0123456789abcdef01234567 claimed attempts 1 lease until ${later.toISOString()} code - - 5 2026-11-27\\n`));
      assert.match(text.out(), new RegExp(`${uploading.toHexString()} aruba uploading attempts 3`));
      assert.match(text.out(), new RegExp(`check them on the provider panel\\):\\n  ${stopped.toHexString()} aruba review attempts 2 lease until ${earlier.toISOString()} code FIND_INCOMPLETE TD01 A/7 2026-11-27\\n`));
      assert.match(text.out(), new RegExp(`History entry pending: 1\\n  ${pending.toHexString()} - - attempts -`));
      assert.match(text.out(), /Records are claimed, uploading or possibly sent: exit 1\n$/);
      const json = toolProcess(env(), ['--json']);
      assert.equal(await runInflight(json.proc, { clock: () => NOW }), 1);
      const parsed = JSON.parse(json.out()) as InflightReport;
      assert.deepEqual(parsed.counts, { activeClaimed: 1, parkedClaimed: 0, uploading: 1, review: 1, possiblySent: 1 });
      assert.deepEqual(parsed.records.map((entry) => entry.queueId), [claimed, uploading].map((id) => id.toHexString()));
      assert.deepEqual(parsed.possiblySent.map((entry) => entry.queueId), [stopped.toHexString()]);
      assert.equal(parsed.historyPending, 1);
      assert.equal(parsed.truncated, false);
      assert.equal(parsed.at, new Date(NOW).toISOString());
    });

    it('exits 1 for each of the three situations alone', async () => {
      for (const [doc, name] of [
        [{ worker: { state: 'claimed', leaseUntil: later } }, 'claimed'],
        [{ worker: { state: 'uploading' } }, 'uploading'],
        [{ worker: { state: 'review' } }, 'review without hubId'],
      ] as const) {
        await queue().deleteMany({});
        await queue().insertOne({ ...doc });
        assert.equal(await runInflight(toolProcess(env()).proc, { clock: () => NOW }), 1, name);
      }
    });

    it('uses the real clock by default', async () => {
      await queue().insertOne({ worker: { state: 'claimed', leaseUntil: new Date(Date.now() + 3_600_000) } });
      assert.equal(await runInflight(toolProcess(env()).proc), 1);
    });

    it('cuts the lists at 100 records and tells so', async () => {
      await queue().insertMany(Array.from({ length: MAX_LISTED + 1 }, () => ({ worker: { state: 'review' } })));
      const run = toolProcess(env());
      assert.equal(await runInflight(run.proc), 1);
      assert.match(run.out(), /possibly sent \(review without hubId\) 101\n/);
      assert.match(run.out(), /\(the lists are cut at 100 records\)\n/);
      assert.equal(run.out().split('\n').filter((line) => line.includes(' review attempts')).length, MAX_LISTED);
    });

    it('refuses wrong options and a bad configuration', async () => {
      const wrong = toolProcess(env(), ['--nope']);
      assert.equal(await runInflight(wrong.proc), 2);
      assert.match(wrong.err(), /usage: inflight/);
      const bad = toolProcess({});
      assert.equal(await runInflight(bad.proc), 1);
      assert.match(bad.err(), /APP_ENV is required/);
    });

    it('reports a query that fails after connecting, without a stack or a message, and exits 1', async () => {
      const run = toolProcess(env());
      const code = await runInflight(run.proc, {
        createClient: (config) => {
          const client = createMongoClient(config);
          const real = client.db.bind(client);
          client.db = (name) => {
            if (name === 'admin') {
              return real(name);
            }
            throw Object.assign(new Error('mongodb://user:topsecret@h/ exploded'), { name: 'MongoServerError' });
          };
          return client;
        },
      });
      assert.equal(code, 1);
      assert.equal(run.err(), 'the check failed (MongoServerError)\n');
      assert.equal(run.out(), '');
    });

    it('formats an empty report', () => {
      const counts = { activeClaimed: 0, parkedClaimed: 0, uploading: 0, review: 0, possiblySent: 0 };
      const text = formatInflight({ at: 'now', counts, records: [], possiblySent: [], historyPending: 0, historyPendingRecords: [], sendStatus: [], truncated: false });
      assert.match(text, /^In flight: claimed \(lease running\) 0, uploading 0, possibly sent \(review without hubId\) 0\nInformation only: claimed with an expired lease 0, review in total 0\n/);
      assert.match(text, /exit 0\n$/);
    });

    it('lists a record with an unusual shape without failing', async () => {
      await queue().insertOne({ worker: { state: 'review' }, number: { odd: true }, date: '2026-11-27T10:00:00Z', prefixSuffix: 3 });
      await queue().insertOne({ worker: { state: 'review', attempts: 'x' }, date: 5, number: 4, company: {}, fattura_elettronica: {} });
      const run = toolProcess(env(), ['--json']);
      assert.equal(await runInflight(run.proc), 1);
      const { possiblySent } = JSON.parse(run.out()) as InflightReport;
      assert.deepEqual(possiblySent.map((entry) => [entry.number, entry.date, entry.attempts]), [[null, '2026-11-27', null], ['4', null, null]]);
    });
  });
});
