import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import type { Collection, Document } from 'mongodb';
import { documentSize, expectedCopy, hasCorrectGroupId, sameDocument } from '../../src/tools/sync-copies/documents.ts';
import { ISSUE_KINDS, createIssueSink, emptyIssueCounts } from '../../src/tools/sync-copies/issues.ts';
import { mergeById } from '../../src/tools/sync-copies/merge.ts';
import { assertSupportedServer, checkClusters } from '../../src/tools/sync-copies/prerequisites.ts';
import { MAX_DETAIL_LINES, exitCodeOf, formatReport } from '../../src/tools/sync-copies/report.ts';
import { emptyStats } from '../../src/tools/sync-copies/reconcile.ts';
import type { GroupSummary, SyncResult } from '../../src/tools/sync-copies/sync.ts';
import type { Databases } from '../../src/db/databases.ts';

const id = (n: number): ObjectId => ObjectId.createFromHexString(n.toString(16).padStart(24, '0'));

describe('documents', () => {
  const group = id(900);

  it('forces the group id: in place when the original has the field, last when it does not, never touching the original', () => {
    const original = { _id: id(1), a: 1, groupId: 'wrong', z: 2 };
    const copy = expectedCopy(original, group);
    assert.deepEqual(Object.keys(copy), ['_id', 'a', 'groupId', 'z']);
    assert.equal(copy['groupId'], group);
    assert.equal(original.groupId, 'wrong');
    assert.deepEqual(Object.keys(expectedCopy({ _id: id(1), a: 1 }, group)), ['_id', 'a', 'groupId']);
  });

  it('accepts only an ObjectId equal to the group', () => {
    assert.equal(hasCorrectGroupId({ groupId: group }, group), true);
    for (const groupId of [id(901), group.toHexString(), undefined, null, 5]) {
      assert.equal(hasCorrectGroupId({ groupId }, group), false, String(groupId));
    }
    assert.equal(hasCorrectGroupId({}, group), false);
  });

  it('compares the BSON bytes: type, value, field order and nesting all matter', () => {
    assert.equal(sameDocument({ a: 1, b: { c: [1, 2] } }, { a: 1, b: { c: [1, 2] } }), true);
    assert.equal(sameDocument({ a: 1, b: 2 }, { b: 2, a: 1 }), false);
    assert.equal(sameDocument({ a: 1 }, { a: '1' }), false);
    assert.equal(sameDocument({ a: 1 }, { a: 1.5 }), false);
    assert.equal(sameDocument({ a: [1, 2] }, { a: [2, 1] }), false);
    assert.equal(sameDocument({ a: { b: 1 } }, { a: { b: 2 } }), false);
    assert.equal(sameDocument({ a: 1 }, { a: 1, b: undefined }), true);
  });

  it('measures a document in BSON bytes', () => {
    assert.equal(documentSize({}), 5);
    assert.ok(documentSize({ a: 'x'.repeat(100) }) > 100);
  });
});

async function* from<T>(items: readonly T[], log?: string[], name = ''): AsyncGenerator<T, void, void> {
  try {
    for (const item of items) {
      yield item;
    }
  } finally {
    log?.push(`closed ${name}`);
  }
}

const doc = (n: number): { _id: ObjectId; n: number } => ({ _id: id(n), n });

async function collect<T extends { _id: ObjectId }>(a: readonly T[], b: readonly T[]): Promise<string[]> {
  const out: string[] = [];
  for await (const pair of mergeById(from(a), from(b))) {
    out.push(`${pair.original === null ? '-' : String(pair.original._id.toHexString().slice(-2))}|${pair.copy === null ? '-' : String(pair.copy._id.toHexString().slice(-2))}`);
  }
  return out;
}

describe('mergeById', () => {
  it('pairs equal ids and keeps the order', async () => {
    assert.deepEqual(await collect([doc(1), doc(2), doc(3)], [doc(1), doc(2), doc(3)]), ['01|01', '02|02', '03|03']);
  });

  it('yields originals alone, copies alone and pairs in the order of the ids', async () => {
    assert.deepEqual(await collect([doc(1), doc(3), doc(5)], [doc(2), doc(3), doc(4), doc(6)]), ['01|-', '-|02', '03|03', '-|04', '05|-', '-|06']);
  });

  it('handles an empty side, or both', async () => {
    assert.deepEqual(await collect([], [doc(1), doc(2)]), ['-|01', '-|02']);
    assert.deepEqual(await collect([doc(1), doc(2)], []), ['01|-', '02|-']);
    assert.deepEqual(await collect([], []), []);
  });

  it('orders ids as bytes (the order of MongoDB), not as numbers', async () => {
    const low = ObjectId.createFromHexString('0000000000000000000000ff');
    const high = ObjectId.createFromHexString('000000000000000000000100');
    assert.deepEqual(await collect([{ _id: high }], [{ _id: low }]), ['-|ff', '00|-']);
  });

  it('closes both streams when the consumer stops early', async () => {
    const log: string[] = [];
    for await (const _pair of mergeById(from([doc(1), doc(2)], log, 'originals'), from([doc(1), doc(2)], log, 'copies'))) {
      break;
    }
    assert.deepEqual(log.sort(), ['closed copies', 'closed originals']);
  });

  it('closes both streams and rethrows when one of them fails', async () => {
    const log: string[] = [];
    async function* failing(): AsyncGenerator<{ _id: ObjectId }, void, void> {
      yield doc(1);
      throw new Error('cursor broke');
    }
    await assert.rejects(async () => {
      for await (const _pair of mergeById(failing(), from([doc(1), doc(2)], log, 'copies'))) {
        // consume
      }
    }, /cursor broke/);
    assert.deepEqual(log, ['closed copies']);
  });

  it('works with iterators that have no return method', async () => {
    const bare = (items: Array<{ _id: ObjectId }>): AsyncIterable<{ _id: ObjectId }> => ({
      [Symbol.asyncIterator]: () => {
        let index = 0;
        return { next: async () => (index < items.length ? { done: false, value: items[index++]! } : { done: true, value: undefined }) } as AsyncIterator<{ _id: ObjectId }>;
      },
    });
    const out: number[] = [];
    for await (const pair of mergeById(bare([doc(1)]), bare([doc(1)]))) {
      out.push(pair.original === null ? 0 : 1);
    }
    assert.deepEqual(out, [1]);
  });
});

describe('issue sink', () => {
  const NOW = new Date('2026-11-12T10:00:00.000Z');
  const run = id(7);
  const base = { collection: 'places', groupId: id(5), documentId: id(6), repaired: true } as const;

  it('counts without a collection (dry run) and writes nothing', async () => {
    const sink = createIssueSink(null, run, () => NOW);
    await sink.record({ ...base, kind: 'missingCopy' });
    await sink.record({ kind: 'databaseWithoutGroup', collection: null, groupId: null, documentId: null, repaired: false });
    await sink.flush();
    assert.equal(sink.totals().missingCopy, 1);
    assert.equal(sink.totals().databaseWithoutGroup, 1);
    assert.deepEqual(sink.groupHexes(), [id(5).toHexString()]);
    assert.equal(sink.ofGroup(id(5).toHexString()).missingCopy, 1);
    assert.deepEqual(sink.ofGroup('nope'), emptyIssueCounts());
  });

  it('buffers documents with ids only and writes a full batch at once, the rest on flush', async () => {
    const batches: Document[][] = [];
    const collection = { insertMany: async (documents: Document[]) => void batches.push(documents) } as unknown as Collection<Document>;
    const sink = createIssueSink(collection, run, () => NOW, 2);
    await sink.record({ ...base, kind: 'missingCopy' });
    assert.equal(batches.length, 0);
    await sink.record({ ...base, kind: 'extraCopy', repaired: false });
    assert.equal(batches.length, 1);
    await sink.record({ ...base, kind: 'nonObjectId', documentId: null });
    await sink.flush();
    await sink.flush();
    assert.deepEqual(batches.map((batch) => batch.length), [2, 1]);
    const [first] = batches[0]!;
    assert.deepEqual(Object.keys(first!).sort(), ['_id', 'collection', 'detectedAt', 'documentId', 'groupId', 'kind', 'repaired', 'runId']);
    assert.deepEqual({ ...first, _id: undefined }, { _id: undefined, runId: run, detectedAt: NOW, kind: 'missingCopy', collection: 'places', groupId: id(5), documentId: id(6), repaired: true });
    assert.equal(batches[1]![0]!['documentId'], null);
  });

  it('counts every kind', () => {
    assert.deepEqual(Object.keys(emptyIssueCounts()), [...ISSUE_KINDS]);
  });
});

describe('prerequisites', () => {
  it('accepts 4.4 or later on a replica set', () => {
    for (const version of ['4.4.0', '4.4.29', '5.0.1', '8.0.4', '10.0.0']) {
      assert.deepEqual(assertSupportedServer('c0', version, 'rs0'), { clusterId: 'c0', version, replicaSet: 'rs0' });
    }
  });

  it('refuses older or unreadable versions', () => {
    for (const version of ['3.6.23', '4.2.24', '4.3.0', 'garbage', '']) {
      assert.throws(() => assertSupportedServer('c0', version, 'rs0'), /Cluster c0: MongoDB .* is not supported, 4\.4 or later is required/, version);
    }
  });

  it('refuses a standalone server', () => {
    assert.throws(() => assertSupportedServer('c1', '8.0.4', null), /Cluster c1: MongoDB 8\.0\.4 is not a replica set/);
  });

  it('checks the clusters in order and stops at the first that fails', async () => {
    const asked: string[] = [];
    const databases = {
      serverVersion: async (cluster: string) => (asked.push(`v ${cluster}`), cluster === 'bad' ? '4.0.0' : '8.0.4'),
      replicaSetName: async (cluster: string) => (asked.push(`r ${cluster}`), 'rs'),
    } as unknown as Databases;
    assert.deepEqual((await checkClusters(databases, ['a', 'b'])).map((check) => check.clusterId), ['a', 'b']);
    await assert.rejects(checkClusters(databases, ['a', 'bad', 'c']), /Cluster bad/);
    assert.ok(!asked.includes('v c'));
  });
});

function result(summaries: Record<string, Partial<Record<'companies' | 'places', Partial<ReturnType<typeof emptyStats>>>>>, issues: Array<[ObjectId | null, (typeof ISSUE_KINDS)[number]]> = [], errors = 0): Promise<SyncResult> {
  const sink = createIssueSink(null, id(1), () => new Date());
  const map = new Map<string, GroupSummary>(
    Object.entries(summaries).map(([hex, stats]) => [hex, { companies: { ...emptyStats(), ...stats.companies }, places: { ...emptyStats(), ...stats.places } }]),
  );
  return Promise.all(issues.map(([groupId, kind]) => sink.record({ kind, collection: null, groupId, documentId: null, repaired: false }))).then(() => ({
    checks: [{ clusterId: 'cluster0', version: '8.0.4', replicaSet: 'rs0' }],
    groupsExamined: map.size,
    groupsCopied: map.size,
    summaries: map,
    issues: sink,
    errors,
  }));
}

describe('report', () => {
  const hex = (n: number): string => id(n).toHexString();

  it('exits 2 only for a missing or different copy or an id collision, 1 for errors, 0 otherwise even with known data issues', async () => {
    assert.equal(exitCodeOf(await result({ [hex(1)]: { companies: { originals: 3, copies: 3 } } })), 0);
    for (const kind of ['missingCopy', 'differentCopy', 'idCollision'] as const) {
      assert.equal(exitCodeOf(await result({ [hex(1)]: {} }, [[id(1), kind]])), 2, kind);
    }
    for (const kind of ['extraCopy', 'groupIdMismatch', 'orphanCompany', 'invalidCopy', 'databaseWithoutGroup', 'nonObjectId'] as const) {
      assert.equal(exitCodeOf(await result({ [hex(1)]: { places: { extra: 1 } } }, [[id(1), kind]])), 0, kind);
    }
    assert.equal(exitCodeOf(await result({}, [[null, 'unknownCluster']])), 0);
    assert.equal(exitCodeOf(await result({ [hex(1)]: {} }, [[id(1), 'missingCopy']], 1)), 1);
  });

  it('prints totals, issue kinds and the groups with differences, never anything else', async () => {
    const lines = formatReport(
      await result({ [hex(2)]: { companies: { originals: 2, copies: 1, missing: 1, repaired: 1 } }, [hex(1)]: { places: { originals: 4, copies: 4 } } }, [[id(2), 'missingCopy'], [id(9), 'databaseWithoutGroup']]),
      { apply: true, appEnv: 'development' },
    );
    assert.deepEqual(lines, [
      'Cluster cluster0: MongoDB 8.0.4, replica set',
      'Applied on development: groups examined 2, with database 2, failed 0',
      'companies: originals 2, copies 1, missing 1, different 0, extra 0, repaired 1',
      'places: originals 4, copies 4, missing 0, different 0, extra 0, repaired 0',
      'Issues: missingCopy 1, databaseWithoutGroup 1',
      `  group ${hex(2)}: companies missing 1, different 0, extra 0; places missing 0, different 0, extra 0; issues missingCopy 1`,
      `  group ${hex(9)}: companies missing 0, different 0, extra 0; places missing 0, different 0, extra 0; issues databaseWithoutGroup 1`,
    ]);
  });

  it('says so for a dry run with nothing found', async () => {
    const lines = formatReport(await result({ [hex(1)]: {} }), { apply: false, appEnv: 'production' });
    assert.ok(lines[1]!.startsWith('Dry run on production, nothing written'));
    assert.ok(lines.includes('Issues: none'));
    assert.equal(lines.at(-1), 'Issues: none', 'nothing to repair, so no invitation to --apply');
    assert.equal(lines.filter((line) => line.startsWith('  group')).length, 0);
  });

  it('limits the detail to 50 lines and counts the rest', async () => {
    const summaries: Record<string, { places: { missing: number } }> = {};
    for (let n = 1; n <= MAX_DETAIL_LINES + 3; n += 1) {
      summaries[hex(n)] = { places: { missing: 1 } };
    }
    const lines = formatReport(await result(summaries), { apply: true, appEnv: 'development' });
    assert.equal(lines.filter((line) => line.startsWith('  group ')).length, MAX_DETAIL_LINES);
    assert.equal(lines.at(-1), '  ... and 3 more');
  });
});
