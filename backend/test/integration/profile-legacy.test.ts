import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { indexUnion, listIndexInfo } from '../../src/tools/profile-legacy/indexes.ts';
import type { IndexInfo } from '../../src/tools/profile-legacy/indexes.ts';
import { countDuplicates } from '../../src/tools/profile-legacy/duplicates.ts';
import { hasCollection } from '../../src/tools/profile-legacy/read.ts';
import { profileLegacy } from '../../src/tools/profile-legacy/profile.ts';
import type { LegacyProfile } from '../../src/tools/profile-legacy/profile.ts';
import { fixtureId, legacyCompany, legacyGroup, legacyUser, seedLegacyCluster } from '../helpers/legacy-fixtures.ts';
import type { SeededCluster } from '../helpers/legacy-fixtures.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';

const TOOL_DIR = fileURLToPath(new URL('../../src/tools/profile-legacy', import.meta.url));

describe('profileLegacy on a seeded legacy cluster (real MongoDB)', () => {
  let ctx: TestDatabases;
  let seeded: SeededCluster;
  let report: LegacyProfile;
  const fixedNow = new Date('2030-05-06T07:08:09.000Z');

  before(async () => {
    ctx = await openTestDatabases();
    seeded = await seedLegacyCluster(ctx.databases, { anomalies: true, extraIndexes: true });
    report = await profileLegacy(ctx.databases, { appEnv: 'development', now: () => fixedNow });
  });
  after(async () => {
    await ctx.cleanup();
  });

  it('describes the cluster', () => {
    assert.equal(report.generatedAt, '2030-05-06T07:08:09.000Z');
    assert.equal(report.appEnv, 'development');
    assert.match(report.serverVersion, /^\d+\.\d+\.\d+/);
    assert.equal(seeded.groupIds.length, 2);
    const { other, ...counts } = report.databases;
    assert.deepEqual(counts, { commonPresent: true, groupDatabases: 4, groupsWithoutDatabase: 2, databasesWithoutGroup: 2 });
    assert.deepEqual(Object.keys(other).sort(), ['flite_common', 'other', 'queue']);
  });

  it('reports progress every N group databases', async () => {
    const steps: Array<[number, number]> = [];
    await profileLegacy(ctx.databases, { appEnv: 'development', progressEvery: 2, onProgress: (done, total) => steps.push([done, total]) });
    assert.deepEqual(steps, [
      [2, 4],
      [4, 4],
    ]);
  });

  it('defaults the clock', async () => {
    const again = await profileLegacy(ctx.databases, { appEnv: 'development' });
    assert.ok(Math.abs(Date.parse(again.generatedAt) - Date.now()) < 60_000);
  });

  it('inventories fields, enums and booleans', () => {
    const users = report.collections.users.fields;
    assert.equal(users.documents, 16);
    assert.deepEqual(users.enums['role']?.values, { '<rare>': 3, CA: 3, E: 3, PA: 3, SA: 3 });
    assert.deepEqual(users.enums['settings.language'], { distinct: 1, nonString: 0, values: { it: 16 } });
    assert.deepEqual(users.booleans['trash'], { true: 1, false: 15, other: 0 });
    assert.equal(users.fields['tokens[].token']?.types['string'], 30);
    assert.equal(users.fields['permissions.apps.cash.status']?.types['bool'], 16);
    const groups = report.collections.groups.fields;
    assert.deepEqual(groups.enums['plan'], { distinct: 1, nonString: 1, values: { basic: 3 } });
    assert.deepEqual(groups.enums['warehouseRules.*.type'], { distinct: 1, nonString: 0, values: { D: 4 } });
    assert.deepEqual(groups.booleans['settings.cash'], { true: 2, false: 0, other: 0 });
    assert.equal(groups.fields['priceLists.<key>.name']?.docs, 4);
    assert.equal(report.collections.countries.fields.documents, 2);
    const places = report.collections.places;
    assert.equal(places.fields.documents, 7);
    assert.equal(places.databasesWithCollection, 3);
    assert.deepEqual(places.fields.enums['devices[].type'], { distinct: 2, nonString: 0, values: { cash: 7, printer: 7 } });
    assert.deepEqual(places.fields.enums['plan']?.values, { basic: 7 });
    assert.equal(report.collections.companies.fields.documents, 12);
    assert.equal(report.collections.companies.databasesWithCollection, 3);
  });

  it('classifies passwords, pins, personal data and tokens by format only', () => {
    assert.deepEqual(report.checks.password, {
      hmacSha512Hex: 11,
      missingOrNull: 1,
      other: 4,
      otherLengths: { '0': 1, '1-7': 0, '8-16': 1, '17-64': 1, '65+': 1, nonString: 0 },
    });
    assert.deepEqual(report.checks.pin, { missingOrNull: 1, numeric4to8: 14, other: 1 });
    assert.deepEqual(report.checks.personalData.users['email'], { encryptedLegacy: 1, plain: 14, empty: 0, missingOrNull: 1, otherType: 0 });
    assert.deepEqual(report.checks.personalData.users['telephone'], { encryptedLegacy: 1, plain: 14, empty: 0, missingOrNull: 0, otherType: 1 });
    assert.deepEqual(report.checks.personalData.users['surname'], { encryptedLegacy: 0, plain: 15, empty: 1, missingOrNull: 0, otherType: 0 });
    assert.deepEqual(report.checks.personalData.groupsApiKey, { encryptedLegacy: 1, plain: 2, empty: 0, missingOrNull: 1, otherType: 0 });
    assert.deepEqual(report.checks.personalData.groupsIntegrationApiKeys, { encryptedLegacy: 1, plain: 2, empty: 0, missingOrNull: 2, otherType: 0 });
    assert.deepEqual(report.checks.tokens, { lengths: { '0': 1, '1-5': 12, '6-10': 1, '>10': 1, missingOrNotArray: 1 }, stringElements: 2 });
  });

  it('checks role coherence, references and groupId consistency', () => {
    assert.deepEqual(report.checks.roleScope['PA'], { users: 3, withGroupId: 3, withCompanyId: 3, withPlaceId: 3, withPlacesId: 3 });
    assert.deepEqual(Object.keys(report.checks.roleScope).sort(), ['<missing>', '<other>', 'CA', 'D', 'E', 'PA', 'PSA', 'SA']);
    const refs = report.checks.references;
    assert.deepEqual(refs['users.groupId'], {
      kinds: { objectId: 11, hexString: 1, otherString: 1, null: 3, missing: 0, otherType: 0 },
      orphans: 1,
      unverifiable: 0,
    });
    assert.equal(refs['users.companyId'].unverifiable, 1);
    assert.equal(refs['users.placesId'].kinds.missing, 1);
    assert.equal(refs['users.dealerId'].orphans, 1);
    assert.equal(refs['groups.dealerId'].orphans, 1);
    assert.deepEqual(refs['places.companyId'].orphans, 2);
    assert.deepEqual(refs['companies.groupId'], { objectId: 10, hexString: 1, otherString: 0, null: 0, missing: 1, otherType: 0 });
    assert.deepEqual(report.checks.groupIdVsDatabase, {
      companies: { match: 9, mismatch: 1, missing: 1, notObjectId: 1 },
      places: { match: 5, mismatch: 1, missing: 0, notObjectId: 1 },
    });
  });

  it('counts duplicates on the server', () => {
    assert.deepEqual(report.checks.duplicates.users.userNameExact, { duplicateValues: 0, documentsInvolved: 0 });
    assert.deepEqual(report.checks.duplicates.users.userNameCaseInsensitive, { duplicateValues: 1, documentsInvolved: 3 });
    assert.deepEqual(report.checks.duplicates.users.userNameCaseInsensitiveNotTrashed, { duplicateValues: 1, documentsInvolved: 2 });
    assert.deepEqual(report.checks.duplicates.users.email, { duplicateValues: 0, documentsInvolved: 0 });
    assert.deepEqual(report.checks.duplicates.companyCode, {
      perGroup: { duplicateValues: 2, documentsInvolved: 5, groupsWithDuplicates: 1 },
      global: { duplicateValues: 2, documentsInvolved: 7, valuesSpanningGroups: 2 },
    });
  });

  it('reports the indexes of every profiled collection', () => {
    const byName = (indexes: IndexInfo[]) => new Map(indexes.map((index) => [index.name, index]));
    assert.equal(byName(report.collections.users.indexes).get('avatar_unique')?.unique, true);
    assert.equal(byName(report.collections.users.indexes).get('avatar_unique')?.sparse, true);
    assert.equal(byName(report.collections.countries.indexes).get('insertDate_ttl')?.expireAfterSeconds, 3600);
    const partial = report.collections.companies.indexes.find((index) => index.name === 'code_partial');
    assert.equal(partial?.hasPartialFilter, true);
    assert.equal(partial?.databases, 3);
  });
});

describe('profileLegacy on a production-shaped cluster (real MongoDB)', () => {
  it('shows the traits of the production profile', async () => {
    const ctx = await openTestDatabases();
    try {
      await seedLegacyCluster(ctx.databases, { groups: 3, productionShape: true });
      const report = await profileLegacy(ctx.databases, { appEnv: 'development' });
      assert.deepEqual(report.databases.groupDatabases, 5);
      assert.equal(report.databases.groupsWithoutDatabase, 1);
      assert.equal(report.databases.databasesWithoutGroup, 2);
      assert.ok(!('API' in report.checks.roleScope));
      assert.deepEqual(Object.keys(report.collections.users.indexes.map((index) => index.name).sort()), ['0', '1']);
      assert.equal(report.collections.users.indexes.find((index) => index.name === 'userName_1')?.unique, true);
      const duplicates = report.checks.duplicates;
      assert.equal(duplicates.users.userNameExact.duplicateValues, 0);
      assert.equal(duplicates.users.userNameCaseInsensitive.duplicateValues, 1);
      assert.equal(duplicates.users.email.duplicateValues, 1);
      assert.equal(duplicates.users.telephone.duplicateValues, 1);
      assert.ok(duplicates.companyCode.perGroup.groupsWithDuplicates >= 1);
      assert.ok(duplicates.companyCode.global.valuesSpanningGroups >= 1);
      assert.ok(report.checks.pin.missingOrNull >= 1 && report.checks.pin.other >= 2 && report.checks.pin.numeric4to8 > 0);
      assert.equal(report.checks.password.other, 0);
      assert.ok(report.checks.tokens.stringElements >= 3);
      assert.equal(report.checks.tokens.lengths['0'] >= 1 && report.checks.tokens.lengths['6-10'] >= 1, true);
      assert.ok(report.checks.roleScope['SA']!.withCompanyId >= 1 && report.checks.roleScope['E']!.withPlacesId >= 1);
      assert.ok(report.checks.roleScope['CA']!.withPlaceId >= 1);
      const places = report.collections.places.fields;
      assert.ok((places.enums['plan']?.distinct ?? 0) >= 5);
      assert.ok((places.enums['devices[].type']?.distinct ?? 0) >= 8);
      assert.deepEqual(report.collections.users.fields.enums['settings.language']?.values, { it: report.collections.users.fields.documents });
      assert.equal(report.checks.personalData.users['email']?.encryptedLegacy, 0);
      assert.ok((report.checks.personalData.users['email']?.empty ?? 0) >= 1);
      assert.ok((report.checks.personalData.users['telephone']?.missingOrNull ?? 0) >= 1);
      assert.equal(report.checks.groupIdVsDatabase.companies.mismatch + report.checks.groupIdVsDatabase.places.mismatch, 0);
      assert.equal(report.checks.references['places.companyId'].kinds.objectId > 0, true);
    } finally {
      await ctx.cleanup();
    }
  });
});

describe('profileLegacy on an empty cluster (real MongoDB)', () => {
  it('reports zeros and an absent common database', async () => {
    const ctx = await openTestDatabases();
    try {
      const report = await profileLegacy(ctx.databases, { appEnv: 'development' });
      assert.equal(report.databases.commonPresent, false);
      assert.equal(report.databases.groupDatabases, 0);
      assert.equal(report.collections.users.fields.documents, 0);
      assert.deepEqual(report.collections.users.indexes, []);
      assert.equal(report.collections.companies.databasesWithCollection, 0);
      assert.deepEqual(report.checks.duplicates.users.userNameExact, { duplicateValues: 0, documentsInvolved: 0 });
    } finally {
      await ctx.cleanup();
    }
  });
});

describe('read helpers (real MongoDB)', () => {
  it('detects missing collections, lists indexes and counts duplicates', async () => {
    const ctx = await openTestDatabases();
    try {
      const db = ctx.databases.common();
      assert.equal(await hasCollection(db, 'users'), false);
      assert.deepEqual(await listIndexInfo(db, db.collection('users')), []);
      await db.collection('users').insertMany([{ userName: ' Ann ' }, { userName: 'ann' }, { userName: '' }, { userName: '' }, { userName: 5 }]);
      assert.equal(await hasCollection(db, 'users'), true);
      assert.deepEqual(await countDuplicates(db.collection('users'), 'userName'), { duplicateValues: 0, documentsInvolved: 0 });
      assert.deepEqual(await countDuplicates(db.collection('users'), 'userName', { caseInsensitive: true }), {
        duplicateValues: 1,
        documentsInvolved: 2,
      });
      const union = indexUnion();
      union.add(await listIndexInfo(db, db.collection('users')));
      assert.equal(union.result()[0]?.name, '_id_');
    } finally {
      await ctx.cleanup();
    }
  });
});

describe('profile report never contains personal data', () => {
  const PROTECTED_KEYS = new Set(['role', 'language', 'type', 'plan']);
  let counter = 0;

  /** Replaces every string by a unique sentinel, except the values of allowlisted enum fields. */
  function sentinelize(value: unknown, key = ''): unknown {
    if (typeof value === 'string') {
      counter += 1;
      return PROTECTED_KEYS.has(key) ? value : `SENTINEL-${counter}`;
    }
    if (Array.isArray(value)) {
      return value.map((item) => sentinelize(item, key));
    }
    if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sentinelize(v, k)]));
    }
    return value;
  }

  it('has no sentinel, id, e-mail or database name in the JSON', async () => {
    const ctx = await openTestDatabases();
    try {
      await seedLegacyCluster(ctx.databases, {
        anomalies: true,
        transform: (_collection, document) => sentinelize(document) as Document,
      });
      // Extra unknown fields with sentinels, also inside the sensitive subtrees.
      await ctx.databases.common().collection('users').insertOne(
        sentinelize(
          legacyUser(100, {
            _id: new ObjectId(),
            role: 'E',
            extra: { deep: { deeper: 'x', deepest: { cut: 'x' } } },
            tokens: [{ token: 'x', ips: ['x'] }],
          }),
        ) as Document,
      );
      await ctx.databases.common().collection('groups').insertOne(
        sentinelize(legacyGroup(100, { _id: new ObjectId(), settings: { email: { host: 'x' }, integrations: { a: { apiKey: 'x', status: 'x' } } } })) as Document,
      );
      const json = JSON.stringify(await profileLegacy(ctx.databases, { appEnv: 'development' }));
      assert.ok(!json.includes('SENTINEL'));
      assert.ok(!json.includes('example.test'));
      assert.ok(!json.includes(ctx.prefix));
      assert.ok(!/[0-9a-f]{24}/.test(json), 'no id-like text');
      assert.ok(!json.includes('@'));
    } finally {
      await ctx.cleanup();
    }
  });

  it('collapses map keys that look like VAT numbers, fiscal codes, hex strings and usernames', async () => {
    const ctx = await openTestDatabases();
    try {
      const keys = ['IT01234567890', 'RSSMRA80A01H501U', 'abcdef0123456789abcdef0123456789', 'mario.rossi'];
      const groups = [1, 2, 3].map((n) =>
        legacyGroup(n, { priceLists: Object.fromEntries(keys.map((key) => [key, { name: 'list' }])), settings: { integrations: Object.fromEntries(keys.map((key) => [key, { status: true }])) } }),
      );
      await ctx.databases.common().collection('groups').insertMany(groups);
      const report = await profileLegacy(ctx.databases, { appEnv: 'development' });
      const json = JSON.stringify(report);
      for (const key of [...keys, 'IT0123', 'RSSMRA', 'abcdef01']) {
        assert.ok(!json.includes(key), key);
      }
      assert.equal(report.collections.groups.fields.fields['priceLists.<key>.name']?.docs, 3);
    } finally {
      await ctx.cleanup();
    }
  });

  it('keeps the fixtures free of the identifiers it must not report', async () => {
    const ctx = await openTestDatabases();
    try {
      const seeded = await seedLegacyCluster(ctx.databases, { anomalies: true });
      const json = JSON.stringify(await profileLegacy(ctx.databases, { appEnv: 'development' }));
      for (const id of [...seeded.groupIds, seeded.dealerId, fixtureId('company', 1)]) {
        assert.ok(!json.includes(id.toHexString()));
      }
      for (const text of ['user-001', 'group-001', 'plain-text-pass', 'fixture-secret', 'Via Fixture', 'Bearer fixture']) {
        assert.ok(!json.includes(text), text);
      }
      assert.ok(!json.includes(legacyCompany(1, seeded.dealerId)['code'] as string));
    } finally {
      await ctx.cleanup();
    }
  });
});

describe('the tool is read-only by construction', () => {
  async function toolFiles(dir: string = TOOL_DIR): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map((entry) =>
        entry.isDirectory() ? toolFiles(join(dir, entry.name)) : Promise.resolve(entry.name.endsWith('.ts') ? [join(dir, entry.name)] : []),
      ),
    );
    return nested.flat();
  }

  it('uses no write, index, rename, collection-command or pipeline-output operation in its sources', async () => {
    const forbidden = [
      'insert',
      'update',
      'replace',
      'delete',
      'drop',
      'createindex',
      'bulkwrite',
      '$out',
      '$merge',
      'findoneand',
      'command(',
      'rename',
      'collmod',
      'createcollection',
    ];
    const files = await toolFiles();
    assert.ok(files.length >= 10);
    for (const file of files) {
      const source = (await readFile(file, 'utf8')).toLowerCase();
      for (const word of forbidden) {
        assert.ok(!source.includes(word), `${file} contains "${word}"`);
      }
    }
  });
});
