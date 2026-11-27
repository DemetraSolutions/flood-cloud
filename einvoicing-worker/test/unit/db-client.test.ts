import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createMongoClient, MONGO_APP_NAME } from '../../src/db/client.ts';
import { Secret } from '../../src/secret.ts';

describe('createMongoClient', () => {
  it('builds a not yet connected client named after the worker', () => {
    const client = createMongoClient({ mongodbUri: new Secret('mongodb://127.0.0.1:27017/?directConnection=true'), appEnv: 'development' });
    assert.equal(client.options.appName, MONGO_APP_NAME);
    assert.equal(client.options.readPreference.mode, 'primary');
  });

  it('accepts TLS URIs in production', () => {
    createMongoClient({ mongodbUri: new Secret('mongodb://h:27017/?tls=true'), appEnv: 'production' });
    createMongoClient({ mongodbUri: new Secret('mongodb+srv://u:p@cluster.example.net/'), appEnv: 'production' });
  });

  it('refuses in production a client without TLS or with weakened checks', () => {
    for (const uri of ['mongodb://h:27017/', 'mongodb://h:27017/?tls=true&tlsInsecure=true']) {
      assert.throws(() => createMongoClient({ mongodbUri: new Secret(uri), appEnv: 'production' }), /TLS/);
    }
  });
});
