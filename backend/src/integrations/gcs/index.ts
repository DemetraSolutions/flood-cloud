import { readFile } from 'node:fs/promises';
import type { MediaConfig } from '../../config.ts';
import { createGcsStorage } from './gcs-storage.ts';
import type { HttpOptions } from './http.ts';
import type { MediaStorage } from './media-storage.ts';
import { parseServiceAccount } from './service-account.ts';
import { StorageError } from './storage-error.ts';
import { createMetadataTokenProvider, createServiceAccountTokenProvider } from './token-provider.ts';
import type { Clock } from './token-provider.ts';

export type { MediaStorage } from './media-storage.ts';
export { StorageError } from './storage-error.ts';

/** Collaborators of {@link createMediaStorage} that a test replaces. */
export interface MediaStorageDeps extends HttpOptions {
  /** Reads the credentials file as text; `node:fs/promises` by default. */
  readonly readFile?: (path: string) => Promise<string>;
  /** Clock in epoch milliseconds. */
  readonly now?: Clock;
  /** Endpoints; the real ones by default. Only a test overrides them, never the environment. */
  readonly urls?: { readonly storage?: string; readonly token?: string };
}

/**
 * Builds the media storage from the configuration, at start-up. With a service-account file it is read once here and checked (a file that cannot be read or is not
 * a service account stops the server, never a request); with the metadata server nothing is called until the first upload.
 *
 * @param media The validated media settings.
 * @param deps Collaborators.
 * @returns The storage, or `null` when the media storage is disabled.
 * @throws {StorageError} `configuration` when the credentials file cannot be read or is not usable.
 */
export async function createMediaStorage(media: MediaConfig, deps: MediaStorageDeps = {}): Promise<MediaStorage | null> {
  if (media.kind === 'disabled') {
    return null;
  }
  const { readFile: read = (path: string) => readFile(path, 'utf8'), urls, ...http } = deps;
  const tokenOptions = { ...http, ...(urls?.token === undefined ? {} : { url: urls.token }) };
  let tokens;
  if (media.auth.mode === 'metadata') {
    tokens = createMetadataTokenProvider(tokenOptions);
  } else {
    let text: string;
    try {
      text = await read(media.auth.file);
    } catch {
      throw new StorageError('startup', 'configuration');
    }
    tokens = createServiceAccountTokenProvider(parseServiceAccount(text), tokenOptions);
  }
  return createGcsStorage({ ...http, bucket: media.bucket, tokens, ...(urls?.storage === undefined ? {} : { baseUrl: urls.storage }) });
}
