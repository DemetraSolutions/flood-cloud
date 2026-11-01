import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSafeTestDatabaseName,
  assertSafeTestUri,
  dropDatabasesWithPrefix,
  openTestDatabase,
  openTestDatabases,
  testMongoUri,
  TEST_URI_VARIABLE,
} from '../helpers/mongo.ts';

describe('test suite guard', () => {
  it('accepts local plain URIs', () => {
    for (const uri of [
      'mongodb://127.0.0.1:27027/?directConnection=true',
      'mongodb://localhost/?directConnection=true',
      'mongodb://localhost:27017,127.0.0.1:27018/db?replicaSet=rs0&directConnection=true',
      'mongodb://[::1]:27017/?directConnection=true',
      'mongodb://[::1]/?directConnection=true',
    ]) {
      assert.doesNotThrow(() => assertSafeTestUri(uri), uri);
    }
  });

  it('refuses SRV, other schemes, credentials and remote hosts without repeating the URI', () => {
    const cases: Array<[string, RegExp]> = [
      ['mongodb+srv://cluster0.example.mongodb.net', /SRV/],
      ['http://localhost', /must start with mongodb:\/\//],
      ['mongodb://user:secretpw@127.0.0.1', /credentials/],
      ['mongodb://cluster0.example.net:27017', /localhost/],
      ['mongodb://127.0.0.1,db.example.net', /localhost/],
      ['mongodb://127.0.0.1.evil.example/', /localhost/],
      ['mongodb://', /localhost/],
      ['mongodb://127.0.0.1:27027', /directConnection=true/],
      ['mongodb://127.0.0.1:27027/?directConnection=false', /directConnection=true/],
      ['mongodb://127.0.0.1:27027/?replicaSet=rs0', /directConnection=true/],
    ];
    for (const [uri, message] of cases) {
      assert.throws(() => assertSafeTestUri(uri), (error: Error) => message.test(error.message) && !error.message.includes('secretpw') && !error.message.includes('example'), uri);
    }
  });

  it('accepts only throw-away database names', () => {
    for (const name of [
      'flood_cloud_test_0123456789ab',
      'flood_cloud_test_0123456789ab_development_common',
      'flood_cloud_test_0123456789ab_production_0123456789abcdef01234567',
    ]) {
      assert.doesNotThrow(() => assertSafeTestDatabaseName(name), name);
    }
    for (const name of [
      'development_common',
      'production_common',
      'development_0123456789abcdef01234567',
      'flood_cloud_test_',
      'flood_cloud_test_xyz',
      'flood_cloud_test_0123456789ab_staging_common',
      'flood_cloud_test_0123456789ab_development_other',
      'xflood_cloud_test_0123456789ab',
      'admin',
    ]) {
      assert.throws(() => assertSafeTestDatabaseName(name), /Refusing database/, name);
    }
  });

  it('fails clearly when the URI variable is missing or empty, and validates it when present', () => {
    assert.throws(() => testMongoUri({}), (error: Error) => error.message.includes(TEST_URI_VARIABLE) && /docker compose/.test(error.message));
    assert.throws(() => testMongoUri({ [TEST_URI_VARIABLE]: '' }), /is not set/);
    assert.throws(() => testMongoUri({ [TEST_URI_VARIABLE]: 'mongodb+srv://x.example.net' }), /SRV/);
    assert.equal(testMongoUri({ [TEST_URI_VARIABLE]: 'mongodb://127.0.0.1:27027/?directConnection=true' }), 'mongodb://127.0.0.1:27027/?directConnection=true');
  });
});

describe('disposable databases (real MongoDB)', () => {
  it('openTestDatabase creates a random database and drop removes it', async () => {
    const test = await openTestDatabase();
    assert.match(test.name, /^flood_cloud_test_[0-9a-f]{12}$/);
    await test.db.collection('c').insertOne({ x: 1 });
    const probe = await openTestDatabase();
    try {
      const listed = async () => (await probe.client.db().admin().listDatabases({ nameOnly: true })).databases.map((d) => d.name);
      assert.ok((await listed()).includes(test.name));
      await test.drop();
      assert.ok(!(await listed()).includes(test.name));
    } finally {
      await probe.drop();
    }
  });

  it('openTestDatabases cleans up everything under its prefix and nothing else', async () => {
    const mine = await openTestDatabases();
    const other = await openTestDatabases('production');
    try {
      await mine.databases.common().collection('c').insertOne({ x: 1 });
      await other.databases.common().collection('c').insertOne({ x: 1 });
      const names = async () => (await mine.client.db().admin().listDatabases({ nameOnly: true })).databases.map((d) => d.name);
      assert.ok((await names()).includes(`${mine.prefix}development_common`));
      await dropDatabasesWithPrefix(mine.client, mine.prefix);
      const after = await names();
      assert.ok(!after.includes(`${mine.prefix}development_common`));
      assert.ok(after.includes(`${other.prefix}production_common`));
    } finally {
      await mine.cleanup();
      await other.cleanup();
    }
  });
});
