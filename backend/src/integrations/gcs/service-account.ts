import { createPrivateKey, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { StorageError } from './storage-error.ts';

/** The only endpoint a service-account JWT is exchanged at (and its `aud` claim). The `token_uri` of the credentials file is never used. */
export const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** The scope the adapter asks for: read and write of the objects, nothing of the buckets themselves. */
export const STORAGE_SCOPE = 'https://www.googleapis.com/auth/devstorage.read_write';

/** Lifetime of the signed assertion, the longest Google accepts. */
export const ASSERTION_LIFETIME_SECONDS = 3600;

/** The identity of a service account, checked and ready to sign. The private key is a key object: it can sign, it cannot be printed. */
export interface ServiceAccount {
  readonly clientEmail: string;
  readonly privateKey: KeyObject;
}

const base64url = (value: string | Buffer): string => Buffer.from(value).toString('base64url');

/**
 * Reads the text of a service-account credentials file. Only `type`, `client_email` and `private_key` are used; every other key, `token_uri` included,
 * is ignored. Nothing of the content is ever put in an error.
 *
 * @param text Content of the JSON file.
 * @returns The account.
 * @throws {StorageError} `configuration` when the text is not JSON, is not a service account, lacks an e-mail or a key, or the key is not an RSA private key of at least 2048 bits.
 */
export function parseServiceAccount(text: string): ServiceAccount {
  const fail = (): StorageError => new StorageError('startup', 'configuration');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw fail();
  }
  const file = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
  const { type, client_email: clientEmail, private_key: privateKeyText } = file;
  if (type !== 'service_account' || typeof clientEmail !== 'string' || !clientEmail.includes('@') || typeof privateKeyText !== 'string') {
    throw fail();
  }
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(privateKeyText);
  } catch {
    throw fail();
  }
  if (privateKey.asymmetricKeyType !== 'rsa' || privateKey.asymmetricKeyDetails!.modulusLength! < 2048) {
    throw fail();
  }
  return { clientEmail, privateKey };
}

/**
 * Signs the RS256 JWT a service account exchanges for an access token. The claims are the account, the storage scope, the fixed audience and a lifetime of one hour.
 *
 * @param account The account.
 * @param nowSeconds Current time in epoch seconds.
 * @returns The compact JWT. It is a credential: never log it.
 */
export function signAssertion(account: ServiceAccount, nowSeconds: number): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({ iss: account.clientEmail, scope: STORAGE_SCOPE, aud: OAUTH_TOKEN_URL, iat: nowSeconds, exp: nowSeconds + ASSERTION_LIFETIME_SECONDS }),
  );
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), account.privateKey);
  return `${header}.${claims}.${base64url(signature)}`;
}
