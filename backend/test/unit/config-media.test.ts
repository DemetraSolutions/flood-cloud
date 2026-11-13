import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, loadConfig } from '../../src/config.ts';
import { validEnv } from '../helpers/app.ts';

function reasonFor(env: Record<string, string | undefined>, variable: string): string | undefined {
  try {
    loadConfig(env);
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    return error.issues.find((issue) => issue.variable === variable)?.reason;
  }
  return undefined;
}

describe('media storage configuration', () => {
  it('is disabled by default, and the upload limit is 30 a minute', () => {
    for (const env of [validEnv(), validEnv({ MEDIA_STORAGE: '' }), validEnv({ MEDIA_STORAGE: 'disabled', GCS_MEDIA_BUCKET: 'ignored-when-disabled' })]) {
      const config = loadConfig(env);
      assert.deepEqual(config.media, { kind: 'disabled' });
      assert.equal(config.rateLimitMediaUploadPerUser, 30);
    }
    assert.equal(loadConfig(validEnv({ RATE_LIMIT_MEDIA_UPLOAD_PER_USER: '7' })).rateLimitMediaUploadPerUser, 7);
    const defaults = loadConfig(validEnv());
    assert.deepEqual([defaults.rateLimitMediaUploadPerUserDaily, defaults.rateLimitMediaUploadPerGroupDaily], [300, 2000]);
    const custom = loadConfig(validEnv({ RATE_LIMIT_MEDIA_UPLOAD_PER_USER_DAILY: '5', RATE_LIMIT_MEDIA_UPLOAD_PER_GROUP_DAILY: '1000000' }));
    assert.deepEqual([custom.rateLimitMediaUploadPerUserDaily, custom.rateLimitMediaUploadPerGroupDaily], [5, 1_000_000]);
    for (const variable of ['RATE_LIMIT_MEDIA_UPLOAD_PER_USER_DAILY', 'RATE_LIMIT_MEDIA_UPLOAD_PER_GROUP_DAILY']) {
      for (const bad of ['0', '1000001', 'x']) {
        assert.match(reasonFor(validEnv({ [variable]: bad }), variable) ?? '', /must be a decimal integer between 1 and 1000000/);
      }
    }
    for (const bad of ['0', '100001', 'x', '1.5']) {
      assert.match(reasonFor(validEnv({ RATE_LIMIT_MEDIA_UPLOAD_PER_USER: bad }), 'RATE_LIMIT_MEDIA_UPLOAD_PER_USER') ?? '', /must be a decimal integer between 1 and 100000/);
    }
  });

  it('reads a Google Cloud Storage bucket with the metadata server, and with a credentials file, deeply frozen', () => {
    const metadata = loadConfig(validEnv({ MEDIA_STORAGE: 'gcs', GCS_MEDIA_BUCKET: 'my-media_bucket.1', GCS_AUTH: 'metadata', GCS_SERVICE_ACCOUNT_FILE: '/ignored.json' })).media;
    assert.deepEqual(metadata, { kind: 'gcs', bucket: 'my-media_bucket.1', auth: { mode: 'metadata' } });
    const file = loadConfig(validEnv({ MEDIA_STORAGE: 'gcs', GCS_MEDIA_BUCKET: 'abc', GCS_AUTH: 'service-account-file', GCS_SERVICE_ACCOUNT_FILE: '/run/secrets/sa.json' })).media;
    assert.deepEqual(file, { kind: 'gcs', bucket: 'abc', auth: { mode: 'service-account-file', file: '/run/secrets/sa.json' } });
    assert.ok(Object.isFrozen(file) && Object.isFrozen(file.kind === 'gcs' ? file.auth : null));
  });

  it('refuses a value that is not usable, naming the variable and never the value', () => {
    assert.equal(reasonFor(validEnv({ MEDIA_STORAGE: 'local' }), 'MEDIA_STORAGE'), 'must be gcs or disabled');
    const gcs = { MEDIA_STORAGE: 'gcs', GCS_MEDIA_BUCKET: 'bucket', GCS_AUTH: 'metadata' };
    assert.match(reasonFor(validEnv({ ...gcs, GCS_MEDIA_BUCKET: undefined }), 'GCS_MEDIA_BUCKET') ?? '', /is required when MEDIA_STORAGE is gcs/);
    for (const bad of ['ab', 'UPPER', '-start', 'end-', 'with space', 'a'.repeat(64), 'ünï']) {
      assert.match(reasonFor(validEnv({ ...gcs, GCS_MEDIA_BUCKET: bad }), 'GCS_MEDIA_BUCKET') ?? '', /must be a bucket name/);
    }
    assert.match(reasonFor(validEnv({ ...gcs, GCS_AUTH: undefined }), 'GCS_AUTH') ?? '', /is required when MEDIA_STORAGE is gcs/);
    assert.equal(reasonFor(validEnv({ ...gcs, GCS_AUTH: 'key' }), 'GCS_AUTH'), 'must be metadata or service-account-file');
    assert.match(reasonFor(validEnv({ ...gcs, GCS_AUTH: 'service-account-file' }), 'GCS_SERVICE_ACCOUNT_FILE') ?? '', /is required/);
    assert.match(reasonFor(validEnv({ ...gcs, GCS_AUTH: 'service-account-file', GCS_SERVICE_ACCOUNT_FILE: 'a\0b' }), 'GCS_SERVICE_ACCOUNT_FILE') ?? '', /without NUL/);
    try {
      loadConfig(validEnv({ ...gcs, GCS_MEDIA_BUCKET: 'BAD BUCKET VALUE' }));
      assert.fail('expected a ConfigError');
    } catch (error) {
      assert.equal((error as Error).message.includes('BAD BUCKET VALUE'), false);
    }
  });
});
