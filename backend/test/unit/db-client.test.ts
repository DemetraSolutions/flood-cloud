import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMongoClient, MONGO_APP_NAME } from '../../src/db/client.ts';
import { Secret } from '../../src/shared/security/secret.ts';

describe('createMongoClient', () => {
  it('applies the required options without connecting', async () => {
    const client = createMongoClient({
      mongodbUri: new Secret('mongodb://127.0.0.1:1/?directConnection=true'),
      mongodbServerSelectionTimeoutMs: 1500,
      mongodbMaxPoolSize: 7,
    });
    try {
      const options = client.options;
      assert.equal(options.appName, MONGO_APP_NAME);
      assert.equal(options.appName, 'flood-cloud-backend');
      assert.equal(options.retryWrites, true);
      assert.equal(options.writeConcern.w, 'majority');
      assert.equal(options.readPreference.mode, 'primary');
      assert.equal(options.serverSelectionTimeoutMS, 1500);
      assert.equal(options.connectTimeoutMS, 1500);
      assert.equal(options.maxPoolSize, 7);
    } finally {
      await client.close();
    }
  });

  it('accepts a read preference', async () => {
    const client = createMongoClient(
      {
        mongodbUri: new Secret('mongodb://127.0.0.1:1/?directConnection=true'),
        mongodbServerSelectionTimeoutMs: 1500,
        mongodbMaxPoolSize: 2,
      },
      { readPreference: 'secondaryPreferred' },
    );
    try {
      assert.equal(client.options.readPreference.mode, 'secondaryPreferred');
    } finally {
      await client.close();
    }
  });

  describe('in production', () => {
    const production = (uri: string) => ({
      mongodbUri: new Secret(uri),
      mongodbServerSelectionTimeoutMs: 1500,
      mongodbMaxPoolSize: 2,
      appEnv: 'production' as const,
    });

    it('accepts a client with TLS and full verification', async () => {
      const client = createMongoClient(production('mongodb://127.0.0.1:1/?tls=true'));
      await client.close();
    });

    it('refuses a client without TLS or with weakened verification, without echoing the URI', () => {
      for (const query of ['', '?tls=false', '?tls=true&tlsInsecure=true', '?tls=true&tlsAllowInvalidCertificates=true', '?tls=true&tlsAllowInvalidHostnames=true']) {
        const uri = `mongodb://user:pw-secret@127.0.0.1:1/${query}`;
        assert.throws(
          () => createMongoClient(production(uri)),
          (error: Error) => /TLS/.test(error.message) && !error.message.includes('pw-secret'),
          query,
        );
      }
    });

    it('does not check TLS outside production', async () => {
      const client = createMongoClient({ ...production('mongodb://127.0.0.1:1/'), appEnv: 'development' });
      await client.close();
    });
  });
});
