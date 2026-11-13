import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { createGcsStorage, OBJECT_CACHE_CONTROL, STORAGE_BASE_URL } from '../../src/integrations/gcs/gcs-storage.ts';
import { MAX_ATTEMPTS, REQUEST_TIMEOUT_MS, requestWithRetry } from '../../src/integrations/gcs/http.ts';
import { createMediaStorage, StorageError } from '../../src/integrations/gcs/index.ts';
import { OAUTH_TOKEN_URL, parseServiceAccount, signAssertion, STORAGE_SCOPE } from '../../src/integrations/gcs/service-account.ts';
import { createMetadataTokenProvider, createServiceAccountTokenProvider, METADATA_TOKEN_URL } from '../../src/integrations/gcs/token-provider.ts';
import type { TokenProvider } from '../../src/integrations/gcs/token-provider.ts';
import { credentialsFile, parseRelated, startFakeGcs, testKeyPair } from '../helpers/fake-gcs.ts';
import type { FakeGcs } from '../helpers/fake-gcs.ts';

const noSleep = { sleep: async () => {}, random: () => 0.5 };
const BYTES = Buffer.from('the-bytes-of-an-image');
const fixedToken: TokenProvider = { token: async () => 'token-1', invalidate: () => {} };

async function withFake(work: (fake: FakeGcs) => Promise<void>): Promise<void> {
  const fake = await startFakeGcs();
  try {
    await work(fake);
  } finally {
    await fake.close();
  }
}

const storageOf = (fake: FakeGcs, extra: Record<string, unknown> = {}) => createGcsStorage({ bucket: 'media-bucket', tokens: fixedToken, baseUrl: fake.baseUrl, ...noSleep, ...extra });

describe('storage error', () => {
  it('says what failed and nothing else', () => {
    assert.equal(new StorageError('upload', 'status', 503).message, 'Storage upload failed: status (HTTP 503)');
    assert.equal(new StorageError('token', 'auth').message, 'Storage token failed: auth');
    assert.equal(new StorageError('upload', 'timeout').status, null);
  });
});

describe('requestWithRetry', () => {
  it('returns a non transient answer at once, 4xx included, with the attempt number', async () => {
    const calls: string[] = [];
    const send = async (url: string) => {
      calls.push(url);
      return new Response(null, { status: 404 });
    };
    const { response, attempts } = await requestWithRetry({ fetch: send as typeof fetch, ...noSleep }, 'upload', 'http://x.test/a', { method: 'GET' });
    assert.equal(response.status, 404);
    assert.equal(attempts, 1);
    assert.equal(calls.length, 1);
  });

  it('retries 429 and 5xx and network errors, waiting longer each time with jitter, then succeeds', async () => {
    const answers: Array<number | Error> = [503, new Error('reset'), 200];
    const waits: number[] = [];
    const send = async () => {
      const next = answers.shift()!;
      if (next instanceof Error) {
        throw next;
      }
      return new Response(null, { status: next });
    };
    const { response, attempts } = await requestWithRetry({ fetch: send as typeof fetch, sleep: async (ms) => void waits.push(ms), random: () => 1 }, 'upload', 'http://x.test/a', {});
    assert.equal(response.status, 200);
    assert.equal(attempts, 3);
    assert.deepEqual(waits, [250, 500]);
    const jittered: number[] = [];
    await requestWithRetry({ fetch: (async () => new Response(null, { status: 429 })) as typeof fetch, sleep: async (ms) => void jittered.push(ms), random: () => 0 }, 'upload', 'http://x.test/a', {}).catch(() => undefined);
    assert.deepEqual(jittered, [125, 250]);
  });

  it('gives up after the last attempt with the reason of the last failure', async () => {
    const status = (code: number) => (async () => new Response(null, { status: code })) as typeof fetch;
    await assert.rejects(() => requestWithRetry({ fetch: status(500), ...noSleep }, 'upload', 'http://x.test/a', {}), (error: unknown) => error instanceof StorageError && error.reason === 'status' && error.status === 500);
    let calls = 0;
    const failing = (async () => {
      calls += 1;
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await assert.rejects(() => requestWithRetry({ fetch: failing, ...noSleep }, 'delete', 'http://x.test/a', {}), (error: unknown) => error instanceof StorageError && error.reason === 'network' && error.operation === 'delete');
    assert.equal(calls, MAX_ATTEMPTS);
    const odd = (async () => Promise.reject('not an error object')) as typeof fetch;
    await assert.rejects(() => requestWithRetry({ fetch: odd, ...noSleep }, 'upload', 'http://x.test/a', {}), (error: unknown) => error instanceof StorageError && error.reason === 'network');
  });

  it('uses the real fetch and timer by default and times out a request that never answers', async () => {
    await withFake(async (fake) => {
      fake.intercept = () => ({ hang: true });
      await assert.rejects(
        () => requestWithRetry({ timeoutMs: 30, sleep: async () => {} }, 'upload', `${fake.baseUrl}/x`, { method: 'GET' }),
        (error: unknown) => error instanceof StorageError && error.reason === 'timeout',
      );
      assert.equal(fake.requests.length, MAX_ATTEMPTS);
      fake.intercept = () => ({ status: 200 });
      const { response } = await requestWithRetry({ random: () => 0 }, 'upload', `${fake.baseUrl}/x`, {});
      assert.equal(response.status, 200);
      fake.intercept = (request) => (request.headers['x-try'] === undefined ? { status: 503 } : undefined);
      let delayed = false;
      await requestWithRetry({}, 'upload', `${fake.baseUrl}/x`, {}).catch(() => (delayed = true));
      assert.equal(delayed, true, 'three 503 answers with the real timer and the default jitter end in an error');
    });
    assert.equal(REQUEST_TIMEOUT_MS, 15_000);
  });
});

describe('service account', () => {
  it('reads the identity from a credentials file and ignores everything else, token_uri included', () => {
    const { privatePem } = testKeyPair();
    const account = parseServiceAccount(credentialsFile(privatePem, { private_key_id: 'x', project_id: 'p' }));
    assert.equal(account.clientEmail, 'uploader@project.iam.gserviceaccount.example');
    assert.equal(account.privateKey.type, 'private');
    assert.equal(JSON.stringify(account).includes('PRIVATE KEY'), false, 'the key object cannot be printed');
  });

  it('refuses a file that is not a usable service account, without echoing anything', () => {
    const { privatePem } = testKeyPair();
    const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    for (const text of [
      'not json',
      'null',
      '[]',
      credentialsFile(privatePem, { type: 'authorized_user' }),
      credentialsFile(privatePem, { client_email: 'nobody' }),
      credentialsFile(privatePem, { client_email: 5 }),
      credentialsFile(privatePem, { private_key: 5 }),
      credentialsFile('-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n'), // gitleaks:allow (fake test value)
      credentialsFile(ec),
    ]) {
      assert.throws(() => parseServiceAccount(text), (error: unknown) => error instanceof StorageError && error.reason === 'configuration' && !error.message.includes('PRIVATE'));
    }
  });

  it('signs an RS256 JWT with the claims of the storage scope and a lifetime of one hour', () => {
    const { privatePem, publicKey } = testKeyPair();
    const jwt = signAssertion(parseServiceAccount(credentialsFile(privatePem)), 1_700_000_000);
    const [header, claims, signature] = jwt.split('.') as [string, string, string];
    assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString()), { alg: 'RS256', typ: 'JWT' });
    assert.deepEqual(JSON.parse(Buffer.from(claims, 'base64url').toString()), {
      iss: 'uploader@project.iam.gserviceaccount.example',
      scope: STORAGE_SCOPE,
      aud: OAUTH_TOKEN_URL,
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    });
    assert.equal(createPrivateKey(privatePem).asymmetricKeyType, 'rsa');
    void publicKey;
    assert.ok(signature.length > 100);
  });
});

describe('token providers', () => {
  it('reads the token of the metadata server with the Metadata-Flavor header and keeps it until 60 seconds before it expires', async () => {
    await withFake(async (fake) => {
      let now = 1_000_000;
      const tokens = createMetadataTokenProvider({ url: fake.metadataUrl, now: () => now, ...noSleep });
      assert.equal(await tokens.token(), 'token-1');
      assert.equal(fake.requests[0]?.headers['metadata-flavor'], 'Google');
      now += 3_539_000;
      assert.equal(await tokens.token(), 'token-1', 'still valid 61 seconds before the expiry');
      now += 1_000;
      assert.equal(await tokens.token(), 'token-2', 'renewed inside the last minute');
      assert.equal(fake.requests.length, 2);
    });
    assert.equal(METADATA_TOKEN_URL, 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token');
  });

  it('exchanges a signed JWT, verified with the public key, and shares one fetch between concurrent callers', async () => {
    await withFake(async (fake) => {
      const { privatePem, publicKey } = testKeyPair();
      fake.publicKey = publicKey;
      fake.tokenDelayMs = 40;
      const tokens = createServiceAccountTokenProvider(parseServiceAccount(credentialsFile(privatePem)), { url: fake.tokenUrl, now: () => 1_700_000_000_000, ...noSleep });
      const results = await Promise.all([tokens.token(), tokens.token(), tokens.token()]);
      assert.deepEqual(results, ['token-1', 'token-1', 'token-1']);
      assert.equal(fake.requests.length, 1, 'one in-flight refresh');
      const form = new URLSearchParams(fake.requests[0]!.body.toString());
      assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
      assert.equal(fake.requests[0]!.headers['content-type'], 'application/x-www-form-urlencoded');
      assert.deepEqual(fake.claims[0], { iss: 'uploader@project.iam.gserviceaccount.example', scope: STORAGE_SCOPE, aud: OAUTH_TOKEN_URL, iat: 1_700_000_000, exp: 1_700_003_600 });
      assert.equal(await tokens.token(), 'token-1', 'cached');
      assert.equal(fake.requests.length, 1);
    });
  });

  it('does not remember a failed fetch: the next caller tries again', async () => {
    await withFake(async (fake) => {
      const { privatePem, publicKey } = testKeyPair();
      fake.publicKey = publicKey;
      const tokens = createServiceAccountTokenProvider(parseServiceAccount(credentialsFile(privatePem)), { url: fake.tokenUrl, ...noSleep });
      fake.intercept = () => ({ status: 400 });
      await assert.rejects(() => tokens.token(), (error: unknown) => error instanceof StorageError && error.reason === 'auth' && error.status === 400);
      fake.intercept = null;
      assert.equal(await tokens.token(), 'token-1');
    });
  });

  it('rejects an answer that is not a token', async () => {
    await withFake(async (fake) => {
      const tokens = createMetadataTokenProvider({ url: fake.metadataUrl, ...noSleep });
      for (const raw of ['not json', '{}', '{"access_token":"","expires_in":10}', '{"access_token":"t","expires_in":"10"}', '{"access_token":"t","expires_in":0}', 'null']) {
        fake.intercept = () => ({ raw });
        await assert.rejects(() => tokens.token(), (error: unknown) => error instanceof StorageError && error.reason === 'malformed', raw);
      }
    });
  });

  it('uses the real endpoints, the real clock and the real timer by default', async () => {
    const urls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 });
    }) as typeof fetch;
    try {
      const { privatePem } = testKeyPair();
      await createMetadataTokenProvider().token();
      await createServiceAccountTokenProvider(parseServiceAccount(credentialsFile(privatePem))).token();
    } finally {
      globalThis.fetch = original;
    }
    assert.deepEqual(urls, [METADATA_TOKEN_URL, OAUTH_TOKEN_URL]);
  });
});

describe('Google Cloud Storage adapter: upload', () => {
  it('sends the object as a multipart upload that never overwrites, with the real type, the cache header and the bearer token', async () => {
    await withFake(async (fake) => {
      const stored = await storageOf(fake).upload('6501a1/media/image/xs/logo bar-1a2b3c4d.png', BYTES, 'image/png');
      assert.deepEqual(stored, { generation: '1' });
      const [request] = fake.requests;
      assert.equal(request?.method, 'POST');
      assert.equal(request?.path, '/upload/storage/v1/b/media-bucket/o');
      assert.equal(request?.query.get('uploadType'), 'multipart');
      assert.equal(request?.query.get('ifGenerationMatch'), '0');
      assert.equal(request?.query.get('name'), '6501a1/media/image/xs/logo bar-1a2b3c4d.png');
      assert.equal(request?.headers['authorization'], 'Bearer token-1');
      assert.equal(request?.headers['content-encoding'], undefined, 'no gzip');
      const { metadata, media, mediaType } = parseRelated(request!.body, String(request?.headers['content-type']));
      assert.deepEqual(metadata, { name: '6501a1/media/image/xs/logo bar-1a2b3c4d.png', contentType: 'image/png', cacheControl: OBJECT_CACHE_CONTROL, md5Hash: createHash('md5').update(BYTES).digest('base64') });
      assert.equal(request?.query.get('fields'), 'generation');
      assert.equal(mediaType, 'image/png');
      assert.ok(media.equals(BYTES));
      assert.equal(OBJECT_CACHE_CONTROL, 'public, max-age=31536000, immutable');
      assert.deepEqual([...fake.objects.keys()], ['6501a1/media/image/xs/logo bar-1a2b3c4d.png']);
    });
    assert.equal(STORAGE_BASE_URL, 'https://storage.googleapis.com');
  });

  it('defaults to the real base URL', async () => {
    const urls: string[] = [];
    const storage = createGcsStorage({ bucket: 'b', tokens: fixedToken, fetch: (async (url: string) => (urls.push(url), new Response('{"generation":"7"}', { status: 200 }))) as typeof fetch });
    await storage.upload('a/b.png', BYTES, 'image/png');
    assert.ok(urls[0]?.startsWith('https://storage.googleapis.com/upload/storage/v1/b/b/o?uploadType=multipart'));
  });

  it('retries a transient failure and succeeds', async () => {
    await withFake(async (fake) => {
      let failures = 2;
      fake.intercept = (request) => (request.method === 'POST' && failures-- > 0 ? { status: 503 } : undefined);
      await storageOf(fake).upload('g/a.png', BYTES, 'image/png');
      assert.equal(fake.requests.length, 3);
      assert.ok(fake.objects.has('g/a.png'));
    });
  });

  it('treats a 412 after a retry as success only when the object has the same size (the answer of the first attempt was lost)', async () => {
    await withFake(async (fake) => {
      let first = true;
      fake.intercept = (request) => {
        if (request.method === 'POST' && first) {
          first = false;
          return { storeThenDrop: true };
        }
        return undefined;
      };
      await storageOf(fake).upload('g/a.png', BYTES, 'image/png');
      assert.deepEqual(fake.requests.map((request) => request.method), ['POST', 'POST', 'GET']);
      assert.equal(fake.requests[2]?.path, '/storage/v1/b/media-bucket/o/g%2Fa.png');
      assert.equal(fake.requests[2]?.query.get('fields'), 'generation,md5Hash');
    });
  });

  it('refuses a 412 after a retry when the object is another one, or cannot be checked', async () => {
    for (const check of ['other size', 'same size', 'missing', 'broken', 'error']) {
      await withFake(async (fake) => {
        fake.objects.set('g/a.png', { bytes: check === 'same size' ? Buffer.alloc(BYTES.length, 1) : Buffer.from('other'), contentType: 'image/png', cacheControl: undefined });
        let posts = 0;
        fake.intercept = (request) => {
          if (request.method === 'POST') {
            posts += 1;
            return posts === 1 ? { status: 500 } : undefined;
          }
          return check === 'missing' ? { status: 404 } : check === 'broken' ? { raw: 'not json' } : check === 'error' ? { status: 403 } : undefined;
        };
        await assert.rejects(() => storageOf(fake).upload('g/a.png', BYTES, 'image/png'), (error: unknown) => error instanceof StorageError && error.reason === 'exists' && error.status === 412, check);
      });
    }
  });

  it('refuses a 412 on the first attempt: the name is taken and nothing is overwritten', async () => {
    await withFake(async (fake) => {
      fake.objects.set('g/a.png', { bytes: BYTES, contentType: 'image/png', cacheControl: undefined });
      await assert.rejects(() => storageOf(fake).upload('g/a.png', BYTES, 'image/png'), (error: unknown) => error instanceof StorageError && error.reason === 'exists');
      assert.equal(fake.requests.length, 1);
    });
  });

  it('maps the other failures to a StorageError without the URL, the token or the body', async () => {
    await withFake(async (fake) => {
      fake.intercept = () => ({ status: 403 });
      await assert.rejects(
        () => storageOf(fake).upload('g/a.png', BYTES, 'image/png'),
        (error: unknown) => error instanceof StorageError && error.reason === 'status' && error.status === 403 && !error.message.includes('token') && !error.message.includes('127.0.0.1'),
      );
      fake.intercept = () => ({ status: 500 });
      await assert.rejects(() => storageOf(fake).upload('g/a.png', BYTES, 'image/png'), (error: unknown) => error instanceof StorageError && error.status === 500);
      fake.intercept = () => ({ drop: true });
      await assert.rejects(() => storageOf(fake).upload('g/a.png', BYTES, 'image/png'), (error: unknown) => error instanceof StorageError && error.reason === 'network');
      fake.intercept = () => ({ hang: true });
      await assert.rejects(() => storageOf(fake, { timeoutMs: 30 }).upload('g/a.png', BYTES, 'image/png'), (error: unknown) => error instanceof StorageError && error.reason === 'timeout');
    });
  });

  it('fails with the error of the token provider when there is no token', async () => {
    await withFake(async (fake) => {
      const broken: TokenProvider = { token: async () => Promise.reject(new StorageError('token', 'auth', 400)), invalidate: () => {} };
      await assert.rejects(() => storageOf(fake, { tokens: broken }).upload('g/a.png', BYTES, 'image/png'), (error: unknown) => error instanceof StorageError && error.operation === 'token');
      assert.equal(fake.requests.length, 0);
    });
  });
});

describe('Google Cloud Storage adapter: remove', () => {
  it('deletes an object by its encoded name and generation; an object that is already gone, or that is another generation, is left alone without an error', async () => {
    await withFake(async (fake) => {
      const storage = storageOf(fake);
      const { generation } = await storage.upload('g/a b.png', BYTES, 'image/png');
      await storage.remove('g/a b.png', 'not-that-generation');
      assert.equal(fake.objects.size, 1, 'a replaced generation is not touched (412)');
      await storage.remove('g/a b.png', generation);
      const deletes = fake.requests.filter((request) => request.method === 'DELETE');
      assert.equal(deletes[1]?.path, '/storage/v1/b/media-bucket/o/g%2Fa%20b.png');
      assert.equal(deletes[1]?.query.get('ifGenerationMatch'), generation);
      assert.equal(fake.objects.size, 0);
      await storage.remove('g/a b.png', generation);
      assert.equal(fake.requests.filter((request) => request.method === 'DELETE').length, 3, 'a missing object (404) is not an error');
    });
  });

  it('fails on any other status, after retrying the transient ones', async () => {
    await withFake(async (fake) => {
      fake.intercept = () => ({ status: 403 });
      await assert.rejects(() => storageOf(fake).remove('g/a.png', '1'), (error: unknown) => error instanceof StorageError && error.operation === 'delete' && error.status === 403);
      fake.intercept = () => ({ status: 503 });
      await assert.rejects(() => storageOf(fake).remove('g/a.png', '1'), (error: unknown) => error instanceof StorageError && error.status === 503);
    });
  });

  it('removes after an upload of unknown outcome only the very bytes that were sent', async () => {
    await withFake(async (fake) => {
      const storage = storageOf(fake);
      await storage.upload('g/a.png', BYTES, 'image/png');
      await storage.removeIfSame('g/a.png', Buffer.from('other bytes'));
      assert.equal(fake.objects.size, 1, 'another object with the name is never removed');
      await storage.removeIfSame('g/missing.png', BYTES);
      fake.intercept = (request) => (request.method === 'GET' ? { raw: '{"generation":5}' } : undefined);
      await storage.removeIfSame('g/a.png', BYTES);
      assert.equal(fake.objects.size, 1, 'an answer that cannot be read removes nothing');
      fake.intercept = null;
      await storage.removeIfSame('g/a.png', BYTES);
      assert.equal(fake.objects.size, 0);
    });
  });
});

describe('createMediaStorage', () => {
  it('is null when the storage is disabled', async () => {
    assert.equal(await createMediaStorage({ kind: 'disabled' }), null);
  });

  it('uses the metadata server when asked to, and uploads with its token', async () => {
    await withFake(async (fake) => {
      const storage = await createMediaStorage({ kind: 'gcs', bucket: 'media-bucket', auth: { mode: 'metadata' } }, { urls: { storage: fake.baseUrl, token: fake.metadataUrl }, ...noSleep });
      await storage!.upload('g/a.png', BYTES, 'image/png');
      assert.equal(fake.requests[0]?.path, '/computeMetadata/v1/instance/service-accounts/default/token');
      assert.equal(fake.requests[1]?.headers['authorization'], 'Bearer token-1');
    });
  });

  it('reads the credentials file once at start-up and signs with it; the token_uri of the file is never called', async () => {
    await withFake(async (fake) => {
      const { privatePem, publicKey } = testKeyPair();
      fake.publicKey = publicKey;
      const paths: string[] = [];
      const storage = await createMediaStorage(
        { kind: 'gcs', bucket: 'media-bucket', auth: { mode: 'service-account-file', file: '/secrets/sa.json' } },
        { readFile: async (path) => (paths.push(path), credentialsFile(privatePem)), urls: { storage: fake.baseUrl, token: fake.tokenUrl }, now: () => 1_700_000_000_000, ...noSleep },
      );
      await storage!.upload('g/a.png', BYTES, 'image/png');
      await storage!.upload('g/b.png', BYTES, 'image/png');
      assert.deepEqual(paths, ['/secrets/sa.json']);
      assert.equal(fake.claims.length, 1, 'one exchange for two uploads');
      assert.equal(fake.claims[0]?.['aud'], OAUTH_TOKEN_URL);
      assert.equal(fake.requests.every((request) => !request.path.includes('never')), true);
    });
  });

  it('fails at start-up on a credentials file that cannot be read or used, without naming it', async () => {
    const media = { kind: 'gcs', bucket: 'media-bucket', auth: { mode: 'service-account-file', file: '/secrets/sa.json' } } as const;
    await assert.rejects(
      () => createMediaStorage(media, { readFile: async () => Promise.reject(new Error('ENOENT /secrets/sa.json')) }),
      (error: unknown) => error instanceof StorageError && error.reason === 'configuration' && !error.message.includes('secrets'),
    );
    await assert.rejects(() => createMediaStorage(media, { readFile: async () => '{}' }), (error: unknown) => error instanceof StorageError && error.reason === 'configuration');
  });

  it('reads the file with node:fs by default', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const directory = await mkdtemp(join(tmpdir(), 'gcs-'));
    try {
      const file = join(directory, 'sa.json');
      await writeFile(file, credentialsFile(testKeyPair().privatePem));
      assert.ok(await createMediaStorage({ kind: 'gcs', bucket: 'media-bucket', auth: { mode: 'service-account-file', file } }));
      await assert.rejects(() => createMediaStorage({ kind: 'gcs', bucket: 'media-bucket', auth: { mode: 'service-account-file', file: join(directory, 'missing.json') } }), (error: unknown) => error instanceof StorageError);
    } finally {
      await rm(directory, { recursive: true });
    }
  });
});

describe('Google Cloud Storage adapter: hardening', () => {
  it('drops the cached token on a 401 and retries once with a new one; a second 401 is an error', async () => {
    await withFake(async (fake) => {
      let invalidated = 0;
      let issued = 0;
      const tokens: TokenProvider = { token: async () => `token-${String(++issued)}`, invalidate: () => void (invalidated += 1) };
      let first = true;
      fake.intercept = (request) => {
        if (request.method === 'POST' && first) {
          first = false;
          return { status: 401 };
        }
        return undefined;
      };
      await storageOf(fake, { tokens }).upload('g/a.png', BYTES, 'image/png');
      assert.equal(invalidated, 1);
      assert.deepEqual(fake.requests.map((request) => request.headers['authorization']), ['Bearer token-1', 'Bearer token-2']);
      fake.intercept = () => ({ status: 401 });
      await assert.rejects(() => storageOf(fake, { tokens }).upload('g/b.png', BYTES, 'image/png'), (error: unknown) => error instanceof StorageError && error.status === 401);
      assert.equal(invalidated, 2, 'one invalidation per call, then the error');
    });
  });

  it('refuses a successful answer that has no generation (the outcome is unknown)', async () => {
    await withFake(async (fake) => {
      fake.intercept = () => ({ raw: '{}' });
      await assert.rejects(() => storageOf(fake).upload('g/a.png', BYTES, 'image/png'), (error: unknown) => error instanceof StorageError && error.reason === 'malformed');
      fake.intercept = () => ({ raw: '[1]' });
      await assert.rejects(() => storageOf(fake).upload('g/a.png', BYTES, 'image/png'), (error: unknown) => error instanceof StorageError && error.reason === 'malformed');
      fake.intercept = () => ({ raw: 'null' });
      await assert.rejects(() => storageOf(fake).upload('g/a.png', BYTES, 'image/png'), (error: unknown) => error instanceof StorageError && error.reason === 'malformed');
    });
  });

  it('never follows a redirect and stops retrying when the deadline of the operation has passed', async () => {
    const seen: Array<string | undefined> = [];
    const send = (async (_url: string, init: RequestInit) => {
      seen.push(init.redirect);
      throw new TypeError('redirected');
    }) as typeof fetch;
    await assert.rejects(() => requestWithRetry({ fetch: send, ...noSleep }, 'upload', 'http://x.test/a', {}), (error: unknown) => error instanceof StorageError && error.reason === 'network');
    assert.deepEqual(seen, ['error', 'error', 'error']);
    const expired = AbortSignal.abort();
    seen.length = 0;
    await assert.rejects(() => requestWithRetry({ fetch: send, ...noSleep }, 'upload', 'http://x.test/a', { signal: expired }), StorageError);
    assert.equal(seen.length, 1, 'no second attempt after the deadline');
  });

  it('stops an upload whose deadline fires while the provider hangs', async () => {
    await withFake(async (fake) => {
      fake.intercept = () => ({ hang: true });
      await assert.rejects(
        () => storageOf(fake).upload('g/a.png', BYTES, 'image/png', { signal: AbortSignal.timeout(40) }),
        (error: unknown) => error instanceof StorageError && error.reason === 'timeout',
      );
      assert.equal(fake.requests.length, 1);
    });
  });

  it('caches even a short-lived token, for half of its life, and forgets it on invalidate', async () => {
    await withFake(async (fake) => {
      fake.expiresIn = 50;
      let now = 0;
      const tokens = createMetadataTokenProvider({ url: fake.metadataUrl, now: () => now, ...noSleep });
      assert.equal(await tokens.token(), 'token-1');
      now = 24_000;
      assert.equal(await tokens.token(), 'token-1');
      now = 26_000;
      assert.equal(await tokens.token(), 'token-2');
      tokens.invalidate();
      assert.equal(await tokens.token(), 'token-3');
    });
  });

  it('refuses a service account whose RSA key is shorter than 2048 bits', () => {
    const small = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    assert.throws(() => parseServiceAccount(credentialsFile(small)), (error: unknown) => error instanceof StorageError && error.reason === 'configuration');
  });
});
