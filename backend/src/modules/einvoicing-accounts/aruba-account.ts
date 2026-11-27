import { createHmac } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { canonicalJson } from '../../shared/http/etag.ts';
import type { StoredCredential } from '../../shared/security/credential-cipher.ts';

/** The hub of the account of the platform: every company that has no dealer of its own sends its invoices through it. */
export const PLATFORM_HUB = 'aruba';

/** Where an Aruba account lives: on a dealer (`common.dealers.<id>.integrations.aruba`) or on the platform (`common.settings`, key `INTEGRATIONS`, `value.aruba`). */
export type AccountTarget = { readonly kind: 'dealer'; readonly dealerId: ObjectId } | { readonly kind: 'platform' };

/**
 * The hub a target stands for, the value of `fattura_elettronica.hub` of the companies that send through it.
 *
 * @param target The account.
 * @returns `aruba` for the platform, `aruba__<dealer id>` for a dealer.
 */
export function hubOf(target: AccountTarget): string {
  return target.kind === 'platform' ? PLATFORM_HUB : `${PLATFORM_HUB}__${target.dealerId.toHexString()}`;
}

/** An Aruba account as stored. The password is the ciphertext: only the e-invoicing worker, which has the key, reads it back. */
export interface ArubaAccount {
  readonly enabled: boolean;
  /** Printable ASCII without spaces, 1 to 100 characters. */
  readonly username: string;
  readonly password: StoredCredential;
  /** Uploads per hour the account may make (1 to 1000). */
  readonly maxPerHour: number;
  /** Uploads per year the account may make (1 to 100 000 000), `null` for no annual ceiling. */
  readonly maxPerYear: number | null;
  readonly updatedAt: Date;
  readonly updatedBy: ObjectId;
}

/** What the API shows of an account: never the password, the ciphertext, its tag or its IV. */
export type ArubaAccountView =
  | { readonly hub: string; readonly configured: false }
  | {
      readonly hub: string;
      readonly configured: true;
      readonly enabled: boolean;
      readonly username: string;
      readonly passwordSet: true;
      readonly maxPerHour: number;
      readonly maxPerYear: number | null;
      readonly updatedAt: string;
    };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const isStoredCredential = (value: unknown): value is StoredCredential =>
  isRecord(value) && value['v'] === 2 && typeof value['kid'] === 'string' && typeof value['epk'] === 'string' && typeof value['iv'] === 'string' && typeof value['tag'] === 'string' && typeof value['data'] === 'string';

/**
 * Reads a stored account defensively: a value that does not have the shape (never written by this server) is the same as no account.
 *
 * @param raw What the database holds under `aruba`.
 * @returns The account, or `null` when there is none (or it is damaged).
 */
export function arubaAccountOf(raw: unknown): ArubaAccount | null {
  if (
    !isRecord(raw) ||
    typeof raw['enabled'] !== 'boolean' ||
    typeof raw['username'] !== 'string' ||
    !isStoredCredential(raw['password']) ||
    !Number.isInteger(raw['maxPerHour']) ||
    !(raw['maxPerYear'] === null || Number.isInteger(raw['maxPerYear'])) ||
    !(raw['updatedAt'] instanceof Date) ||
    !(raw['updatedBy'] instanceof ObjectId)
  ) {
    return null;
  }
  return raw as unknown as ArubaAccount;
}

/**
 * The representation of an account for the API.
 *
 * @param target Where the account lives.
 * @param account The account, `null` when there is none.
 */
export function viewOf(target: AccountTarget, account: ArubaAccount | null): ArubaAccountView {
  const hub = hubOf(target);
  if (account === null) {
    return { hub, configured: false };
  }
  return { hub, configured: true, enabled: account.enabled, username: account.username, passwordSet: true, maxPerHour: account.maxPerHour, maxPerYear: account.maxPerYear, updatedAt: account.updatedAt.toISOString() };
}

/**
 * The version of an account (the `ETag` of the response, the `If-Match` of the next write): HMAC-SHA256 with the secret key of the server, in base64url, of the canonical JSON of what the API shows plus the IV of
 * the ciphertext, so that a new password changes the version while the ciphertext itself never leaves the server.
 *
 * @param target Where the account lives.
 * @param account The account, `null` when there is none.
 * @param key The secret key of the HMAC (`VERSION_HMAC_KEY`).
 * @returns The version, 43 characters.
 */
export function versionOf(target: AccountTarget, account: ArubaAccount | null, key: Buffer): string {
  const hub = hubOf(target);
  const subject =
    account === null
      ? { kind: 'arubaAccount', hub, configured: false }
      : { kind: 'arubaAccount', hub, enabled: account.enabled, username: account.username, maxPerHour: account.maxPerHour, maxPerYear: account.maxPerYear, passwordIv: account.password.iv, updatedAt: account.updatedAt.toISOString() };
  return createHmac('sha256', key).update(canonicalJson(subject)).digest('base64url');
}
