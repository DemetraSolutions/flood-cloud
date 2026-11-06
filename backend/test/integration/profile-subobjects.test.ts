import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Int32, Long, ObjectId } from 'mongodb';
import { main } from '../../src/tools/profile-legacy/main.ts';
import { normalizeSubobjectKey, profileSubobjects, MAX_SUBOBJECT_DEPTH } from '../../src/tools/profile-legacy/subobjects.ts';
import type { SubobjectsProfile } from '../../src/tools/profile-legacy/subobjects.ts';
import { mongoEnv, openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';

const SECRET_STRING = 'Secret-Value-XYZ';
const SECRET_NUMBER = 987654321;
const priceListId = new ObjectId().toHexString();
const otherPriceListId = new ObjectId().toHexString();
const recordId = new ObjectId();

function nested(levels: number): Record<string, unknown> {
  let value: Record<string, unknown> = { leaf: true };
  for (let level = 0; level < levels; level += 1) {
    value = { n: value };
  }
  return value;
}

describe('normalizeSubobjectKey', () => {
  it('replaces identifiers, codes, dates and days by placeholders', () => {
    assert.equal(normalizeSubobjectKey('priceLists', priceListId), '<id>');
    assert.equal(normalizeSubobjectKey('measureUnits', 'kg'), '<id>');
    assert.equal(normalizeSubobjectKey('warehouseRules', 'x'), '<id>');
    assert.equal(normalizeSubobjectKey('permissions.apps.cash.options.priceLists', 'x'), '<id>');
    assert.equal(normalizeSubobjectKey('fidelityCardRules', 'EUR'), '<code>');
    assert.equal(normalizeSubobjectKey('shiftTime.daySpecial', '2026-01-01'), '<date>');
    assert.equal(normalizeSubobjectKey('shiftTime.weeksGeneric[].days', '3'), '<day>');
    assert.equal(normalizeSubobjectKey('shiftTime.weekGeneric', '0'), '<day>');
    assert.equal(normalizeSubobjectKey('shiftTime.weekGeneric.days', '6'), '<day>');
  });

  it('shows only ISO currency codes and day numbers 0-6', () => {
    assert.equal(normalizeSubobjectKey('currencies', 'EUR'), 'EUR');
    assert.equal(normalizeSubobjectKey('currencies', 'eur'), '<code>');
    assert.equal(normalizeSubobjectKey('currencies', 'EURO'), '<code>');
    assert.equal(normalizeSubobjectKey('shiftTime.weeksGeneric[].days', '7'), '<key>');
    assert.equal(normalizeSubobjectKey('shiftTime.weekGeneric', 'Mon'), 'Mon');
  });

  it('keeps provider and field names and collapses anything else', () => {
    assert.equal(normalizeSubobjectKey('settings.integrations', 'satispay'), 'satispay');
    assert.equal(normalizeSubobjectKey('x', '_private'), '_private');
    assert.equal(normalizeSubobjectKey('x', 'g'.repeat(64)), 'g'.repeat(64));
    assert.equal(normalizeSubobjectKey('x', 'g'.repeat(65)), '<key>');
    assert.equal(normalizeSubobjectKey('x', 'with space'), '<key>');
    assert.equal(normalizeSubobjectKey('x', 'a.b'), '<key>');
    assert.equal(normalizeSubobjectKey('x', '1abc'), '<key>');
    assert.equal(normalizeSubobjectKey('x', priceListId), '<key>');
    assert.equal(normalizeSubobjectKey('x', 'deadbeefdeadbeef'), '<key>');
    assert.equal(normalizeSubobjectKey('x', 'user@example.com'), '<key>');
  });
});

describe('profileSubobjects (real MongoDB)', () => {
  let ctx: TestDatabases;
  let report: SubobjectsProfile;
  const now = new Date('2031-01-02T03:04:05.000Z');

  before(async () => {
    ctx = await openTestDatabases();
    const common = ctx.databases.common();
    await common.collection('users').insertMany([
      {
        userName: SECRET_STRING,
        permissions: {
          status: true,
          sales: { r: true, w: false },
          apps: {
            cash: {
              enabled: true,
              sub: { automaticCash: { enabled: false, mode: SECRET_STRING, limit: SECRET_NUMBER, extra: null } },
              options: { priceLists: { [priceListId]: true, [otherPriceListId]: false } },
            },
          },
        },
        settings: { theme: SECRET_STRING, pageSize: new Int32(25), big: Long.fromNumber(SECRET_NUMBER), ratio: 1.5 },
        shiftTime: {
          ststus: true,
          weekGeneric: { '0': { values: [SECRET_STRING] } },
          weeksGeneric: [{ days: { '1': { values: [{ from: SECRET_NUMBER }] }, '2': { values: [] } } }, { days: { '1': { values: [] }, '9': 1 } }],
          daySpecial: { '2026-05-06': { off: true }, '2026-05-07': { off: false } },
        },
      },
      { userName: SECRET_STRING, permissions: { status: false }, settings: null },
      { userName: SECRET_STRING },
    ]);
    await common.collection('groups').insertMany([
      {
        settings: { cash: true, integrations: { satispay: { enabled: true, apiKey: SECRET_STRING }, dojo: { enabled: false } }, stats: { sales: true } },
        priceLists: { [priceListId]: { name: SECRET_STRING, default: true }, [otherPriceListId]: { name: SECRET_STRING, default: false } },
        taxes: [{ rate: 22, label: SECRET_STRING }, { rate: 10 }],
        currencies: { EUR: { symbol: SECRET_STRING }, [`${SECRET_STRING}cur`]: { symbol: 'x' } },
        measureUnits: { [recordId.toHexString()]: { code: 'kg' } },
        warehouseRules: { [priceListId]: { type: 'x' } },
        fidelityCardRules: { EUR: { points: 1 }, other: { points: 2 } },
        fidelity: { cardsTypes: [{ name: 'a' }], prizeCatalogues: [{ prizes: [{ medias: [{ url: SECRET_STRING }] }] }] },
        productsFavorites: [recordId],
        promotions: [{ conditions: [{ all: true }], actions: [{ discount: 5 }] }],
        deep: nested(2),
      },
      { settings: { cash: false }, promotions: [] },
    ]);
    report = await profileSubobjects(common, { appEnv: 'development', now: () => now });
  });
  after(async () => {
    await ctx.cleanup();
  });

  it('describes the run and counts documents', () => {
    assert.equal(report.generatedAt, '2031-01-02T03:04:05.000Z');
    assert.equal(report.appEnv, 'development');
    assert.equal(report.focus, 'subobjects');
    assert.equal(report.collections.users.documents, 3);
    assert.equal(report.collections.groups.documents, 2);
    assert.deepEqual(Object.keys(report.collections.users.roots), ['permissions', 'settings', 'shiftTime']);
    assert.equal(report.collections.users.roots['permissions']!.documents, 2);
    assert.equal(report.collections.users.roots['settings']!.documents, 2);
    assert.equal(report.collections.users.roots['shiftTime']!.documents, 1);
  });

  it('lists every path, including rare ones, with docs, types and sorted keys', () => {
    const { paths } = report.collections.users.roots['permissions']!;
    assert.deepEqual(Object.keys(paths), [...Object.keys(paths)].sort());
    assert.deepEqual(paths['permissions.apps.cash.sub.automaticCash.mode'], { docs: 1, types: { string: 1 } });
    assert.deepEqual(paths['permissions.apps.cash.sub.automaticCash.limit'], { docs: 1, types: { int: 1 } });
    assert.deepEqual(paths['permissions.status'], { docs: 2, types: { bool: 2 }, flags: { true: 1, false: 1, null: 0 } });
    assert.deepEqual(paths['permissions.sales.r'], { docs: 1, types: { bool: 1 }, flags: { true: 1, false: 0, null: 0 } });
    assert.deepEqual(paths['permissions.apps.cash.sub.automaticCash.extra'], { docs: 1, types: { null: 1 }, flags: { true: 0, false: 0, null: 1 } });
    assert.deepEqual(paths['permissions'], { docs: 2, types: { object: 2 } });
  });

  it('normalizes dynamic keys, counting a document once and every occurrence by type', () => {
    const perm = report.collections.users.roots['permissions']!.paths;
    assert.deepEqual(perm['permissions.apps.cash.options.priceLists.<id>'], { docs: 1, types: { bool: 2 }, flags: { true: 1, false: 1, null: 0 } });
    const shift = report.collections.users.roots['shiftTime']!.paths;
    assert.deepEqual(shift['shiftTime.daySpecial.<date>.off'], { docs: 1, types: { bool: 2 }, flags: { true: 1, false: 1, null: 0 } });
    assert.deepEqual(shift['shiftTime.weeksGeneric[].days.<day>.values[]']!.types, { object: 1 });
    assert.equal(shift['shiftTime.weeksGeneric[].days.<day>']!.types['object'], 3);
    assert.equal(shift['shiftTime.weeksGeneric[].days.<key>']!.types['int'], 1);
    assert.deepEqual(shift['shiftTime.weekGeneric.<day>.values[]'], { docs: 1, types: { string: 1 } });
    assert.deepEqual(shift['shiftTime.ststus'], { docs: 1, types: { bool: 1 }, flags: { true: 1, false: 0, null: 0 } });
    assert.equal(shift['shiftTime.weeksGeneric[].days.<day>.values[].from']!.types['int'], 1);
    const sets = report.collections.users.roots['settings']!.paths;
    assert.deepEqual(sets['settings'], { docs: 2, types: { null: 1, object: 1 }, flags: { true: 0, false: 0, null: 1 } });
    assert.deepEqual(Object.keys(sets).filter((p) => p.startsWith('settings.')), ['settings.big', 'settings.pageSize', 'settings.ratio', 'settings.theme']);
    assert.deepEqual(sets['settings.big']!.types, { long: 1 });
    assert.deepEqual(sets['settings.ratio']!.types, { double: 1 });

    const groups = report.collections.groups.roots;
    assert.ok('priceLists.<id>.default' in groups['priceLists']!.paths);
    assert.deepEqual(groups['priceLists']!.paths['priceLists.<id>.default']!.flags, { true: 1, false: 1, null: 0 });
    assert.ok('currencies.EUR.symbol' in groups['currencies']!.paths);
    assert.ok('currencies.<code>.symbol' in groups['currencies']!.paths);
    assert.ok('fidelityCardRules.<code>.points' in groups['fidelityCardRules']!.paths);
    assert.ok('measureUnits.<id>.code' in groups['measureUnits']!.paths);
    assert.ok('warehouseRules.<id>.type' in groups['warehouseRules']!.paths);
    assert.ok('settings.integrations.satispay.enabled' in groups['settings']!.paths);
    assert.ok('settings.integrations.dojo.enabled' in groups['settings']!.paths);
    assert.ok('settings.stats.sales' in groups['settings']!.paths);
    assert.ok('fidelity.prizeCatalogues[].prizes[].medias[].url' in groups['fidelity']!.paths);
    assert.ok('promotions[].conditions[].all' in groups['promotions']!.paths);
    assert.deepEqual(groups['promotions']!.paths['promotions'], { docs: 2, types: { array: 2 } });
    assert.deepEqual(groups['productsFavorites']!.paths['productsFavorites[]'], { docs: 1, types: { objectId: 1 } });
    assert.deepEqual(groups['taxes']!.paths['taxes[].rate'], { docs: 1, types: { int: 2 } });
    assert.equal(groups['settings']!.documents, 2);
    assert.equal(groups['taxes']!.documents, 1);
  });

  it('never outputs a string value, number, id or key outside the roots', () => {
    const text = JSON.stringify(report);
    for (const forbidden of [SECRET_STRING, String(SECRET_NUMBER), priceListId, otherPriceListId, recordId.toHexString(), '2026-05', 'deep', 'userName']) {
      assert.ok(!text.includes(forbidden), forbidden);
    }
    assert.equal(report.collections.groups.roots['settings']!.truncated, false);
  });

  it('descends eight levels below the root and flags the cut', async () => {
    const small = await openTestDatabases();
    try {
      const common = small.databases.common();
      await common.collection('groups').insertOne({ settings: nested(MAX_SUBOBJECT_DEPTH - 1) });
      const shallow = await profileSubobjects(common, { appEnv: 'development' });
      const root = shallow.collections.groups.roots['settings']!;
      assert.equal(root.depthLimited, false);
      assert.ok(`settings${'.n'.repeat(MAX_SUBOBJECT_DEPTH - 1)}.leaf` in root.paths);
      await common.collection('groups').deleteMany({});
      await common.collection('groups').insertOne({ settings: nested(MAX_SUBOBJECT_DEPTH + 1) });
      const deep = await profileSubobjects(common, { appEnv: 'development' });
      const cut = deep.collections.groups.roots['settings']!;
      assert.equal(cut.depthLimited, true);
      assert.ok(!Object.keys(cut.paths).some((path) => path.endsWith('.leaf')));
      assert.equal(Object.keys(cut.paths).length, MAX_SUBOBJECT_DEPTH + 1);
    } finally {
      await small.cleanup();
    }
  });

  it('caps the distinct paths and says so', async () => {
    const small = await openTestDatabases();
    try {
      const common = small.databases.common();
      await common.collection('users').insertOne({ settings: { a: 1, b: 2, c: 3, d: 4 } });
      const capped = await profileSubobjects(common, { appEnv: 'development', maxPaths: 3 });
      const root = capped.collections.users.roots['settings']!;
      assert.equal(root.truncated, true);
      assert.deepEqual(Object.keys(root.paths), ['settings', 'settings.a', 'settings.b']);
    } finally {
      await small.cleanup();
    }
  });

  it('is empty on empty collections and defaults the clock', async () => {
    const empty = await openTestDatabases();
    try {
      const result = await profileSubobjects(empty.databases.common(), { appEnv: 'development' });
      assert.equal(result.collections.users.documents, 0);
      assert.deepEqual(result.collections.users.roots['permissions']!.paths, {});
      assert.ok(Date.now() - Date.parse(result.generatedAt) < 60_000);
    } finally {
      await empty.cleanup();
    }
  });
});

describe('profile:legacy --focus subobjects', () => {
  let dir: string;
  let ctx: TestDatabases;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'flood-subobjects-'));
    ctx = await openTestDatabases();
    await ctx.databases.common().collection('users').insertOne({ settings: { theme: SECRET_STRING } });
  });
  after(async () => {
    await ctx.cleanup();
    await rm(dir, { recursive: true, force: true });
  });
  const env = () => mongoEnv({ DB_NAME_PREFIX: ctx.prefix }) as Record<string, string>;
  const run = async (argv: string[], cwd: string, environment: Record<string, string> = env()) => {
    const info: string[] = [];
    const error: string[] = [];
    const code = await main(argv, { env: environment, cwd, loadEnvFile: () => undefined, info: (l) => info.push(l), error: (l) => error.push(l) });
    return { code, info, error };
  };

  it('writes legacy-subobjects-<env>-<timestamp>.json under backend/reports by default', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'flood-repo-'));
    try {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(join(repo, '.git'), { recursive: true });
      await mkdir(join(repo, 'backend'));
      const result = await run(['--focus', 'subobjects'], join(repo, 'backend'));
      assert.equal(result.code, 0, result.error.join());
      assert.deepEqual(result.error, ['Profiling sub-objects of development: common users and groups, read-only']);
      const [file] = await readdir(join(repo, 'backend', 'reports'));
      assert.match(file ?? '', /^legacy-subobjects-development-\d{8}T\d{9}Z\.json$/);
      const text = await readFile(join(repo, 'backend', 'reports', file ?? ''), 'utf8');
      assert.ok(!text.includes(SECRET_STRING));
      assert.equal((JSON.parse(text) as SubobjectsProfile).collections.users.roots['settings']!.documents, 1);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('keeps the environment guard and rejects other focus values', async () => {
    const mismatch = await run(['--focus', 'subobjects', '--env', 'production', '--out', join(dir, 'm.json')], dir);
    assert.equal(mismatch.code, 1);
    assert.match(mismatch.error.join(), /does not match/);
    for (const argv of [['--focus', 'everything'], ['--focus'], ['--focus', 'subobjects', '--focus', 'subobjects']]) {
      const bad = await run(argv, dir);
      assert.equal(bad.code, 1);
      assert.match(bad.error.join(), /Usage/);
    }
  });
});
