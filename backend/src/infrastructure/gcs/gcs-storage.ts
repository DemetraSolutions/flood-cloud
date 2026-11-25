import { createHash, randomBytes } from 'node:crypto';
import { requestWithRetry } from './http.ts';
import type { HttpOptions } from './http.ts';
import type { MediaStorage, StorageCallOptions } from './media-storage.ts';
import { StorageError } from './storage-error.ts';
import type { TokenProvider } from './token-provider.ts';

/** Base URL of the Google Cloud Storage JSON API. */
export const STORAGE_BASE_URL = 'https://storage.googleapis.com';

/** `Cache-Control` of every object: the names are unique and never reused, so a copy can be kept for a year. */
export const OBJECT_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/** Options of {@link createGcsStorage}. */
export interface GcsStorageOptions extends HttpOptions {
  /** Name of the bucket (validated at start-up). */
  readonly bucket: string;
  /** Gives the access token of every call. */
  readonly tokens: TokenProvider;
  /** Base URL of the API; the real one by default. Only a test overrides it, never the environment. */
  readonly baseUrl?: string;
}

/** The MD5 of the bytes, base64, in the form GCS uses for `md5Hash`. */
const md5Of = (body: Buffer): string => createHash('md5').update(body).digest('base64');

/** Reads the JSON body of an answer, `null` when it is not JSON or not an object. */
async function readObject(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await response.json();
    return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The Google Cloud Storage adapter, over `fetch`.
 *
 * An upload is a `multipart` upload (`uploadType=multipart`) so that the `Content-Type`, the `Cache-Control` and the `md5Hash` (GCS checks the body against it) become
 * the metadata of the object, with `ifGenerationMatch=0`: an existing object is never replaced. No compression is applied. It answers the generation of the object stored.
 * Every call has a timeout and is retried, with backoff and jitter, up to three attempts on connection errors, timeouts, `429` and `5xx`; a `401` invalidates the cached token
 * and is retried once with a new one. That makes an upload safe to repeat; the one doubtful case is a `412` after a retry (the first attempt may have been stored while its answer was
 * lost): it counts as a success only when the object exists with the same MD5 as the bytes being uploaded. A `412` at the first attempt is `exists`: the name is taken by another object.
 * Redirects are never followed. A removal is always conditional on the generation of the object this process stored.
 *
 * @param options Bucket, token provider and collaborators.
 * @returns The storage.
 */
export function createGcsStorage(options: GcsStorageOptions): MediaStorage {
  const base = options.baseUrl ?? STORAGE_BASE_URL;
  const bucket = encodeURIComponent(options.bucket);
  const objectUrl = (objectName: string): string => `${base}/storage/v1/b/${bucket}/o/${encodeURIComponent(objectName)}`;

  /** Sends one call with the token of the moment; a `401` drops the token and tries once more with a new one. */
  const call = async (operation: string, url: string, init: RequestInit, limits: StorageCallOptions) => {
    const send = async () =>
      requestWithRetry(options, operation, url, {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${await options.tokens.token()}` },
        ...(limits.signal === undefined ? {} : { signal: limits.signal }),
      });
    const first = await send();
    if (first.response.status !== 401) {
      return first;
    }
    await first.response.body?.cancel();
    options.tokens.invalidate();
    return send();
  };

  /** The generation and the MD5 of an existing object, `null` when it is missing or cannot be read. */
  const describe = async (objectName: string, call_: StorageCallOptions): Promise<{ generation: string; md5Hash: string } | null> => {
    const { response } = await call('upload', `${objectUrl(objectName)}?fields=generation,md5Hash`, { method: 'GET' }, call_);
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const found = await readObject(response);
    return typeof found?.['generation'] === 'string' && typeof found['md5Hash'] === 'string' ? { generation: found['generation'], md5Hash: found['md5Hash'] } : null;
  };

  const remove: MediaStorage['remove'] = async (objectName, generation, call_ = {}) => {
    const { response } = await call('delete', `${objectUrl(objectName)}?ifGenerationMatch=${encodeURIComponent(generation)}`, { method: 'DELETE' }, call_);
    await response.body?.cancel();
    // 404: already gone. 412: the object is another generation, so it is not the one this process stored: it is left alone.
    if (!response.ok && response.status !== 404 && response.status !== 412) {
      throw new StorageError('delete', 'status', response.status);
    }
  };

  return {
    upload: async (objectName, body, contentType, call_ = {}) => {
      const boundary = `flood-${randomBytes(16).toString('hex')}`;
      const md5Hash = md5Of(body);
      const metadata = JSON.stringify({ name: objectName, contentType, cacheControl: OBJECT_CACHE_CONTROL, md5Hash });
      const payload = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`),
        body,
        Buffer.from(`\r\n--${boundary}--`),
      ]);
      const url = `${base}/upload/storage/v1/b/${bucket}/o?uploadType=multipart&name=${encodeURIComponent(objectName)}&ifGenerationMatch=0&fields=generation`;
      const { response, attempts } = await call('upload', url, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: payload }, call_);
      if (response.ok) {
        const stored = await readObject(response);
        if (typeof stored?.['generation'] !== 'string') {
          throw new StorageError('upload', 'malformed');
        }
        return { generation: stored['generation'] };
      }
      await response.body?.cancel();
      if (response.status === 412 && attempts > 1) {
        const existing = await describe(objectName, call_);
        if (existing !== null && existing.md5Hash === md5Hash) {
          return { generation: existing.generation };
        }
      }
      throw new StorageError('upload', response.status === 412 ? 'exists' : 'status', response.status);
    },

    remove,

    removeIfSame: async (objectName, body, call_ = {}) => {
      const existing = await describe(objectName, call_);
      if (existing !== null && existing.md5Hash === md5Of(body)) {
        await remove(objectName, existing.generation, call_);
      }
    },
  };
}
