import crypto, { randomBytes, timingSafeEqual } from 'node:crypto';
import type { ScryptOptions } from 'node:crypto';

/** Asynchronous scrypt (libuv thread pool). Looks `crypto.scrypt` up at call time so tests can spy on it. */
function scryptAsync(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, options, (error, key) => (error === null ? resolve(key) : reject(error)));
  });
}

/** Current scrypt cost parameters (OWASP): N = 2^16, r = 8, p = 2. */
export const SCRYPT_PARAMS = Object.freeze({ N: 2 ** 16, r: 8, p: 2 });

/** Salt length in bytes for new hashes. */
const SALT_BYTES = 16;
/** Derived key length in bytes for new hashes. */
const KEY_BYTES = 32;
/** Extra memory granted to scrypt on top of the computed requirement. */
const MAXMEM_MARGIN = 16 * 1024 * 1024;

/** Upper bounds accepted from a stored record, so a tampered record cannot cause a denial of service. */
const LIMITS = Object.freeze({ N: 2 ** 20, r: 32, p: 16, cost: 2 ** 22, memory: 128 * 1024 * 1024 });
const SALT_RANGE = Object.freeze({ min: 8, max: 64 });
const KEY_RANGE = Object.freeze({ min: 16, max: 64 });

const INTEGER = /^[1-9][0-9]{0,9}$/;

interface ParsedHash {
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly salt: Buffer;
  readonly key: Buffer;
}

/**
 * The `maxmem` option: a generous upper bound with a margin. The real memory use is about
 * `128 * r * (N + p + 2)` bytes; this value is always above it.
 */
function maxmemFor(N: number, r: number, p: number): number {
  return 128 * N * r * p + MAXMEM_MARGIN;
}

/** Decodes strict base64url (canonical form only), or `null`. */
function decode(text: string): Buffer | null {
  const bytes = Buffer.from(text, 'base64url');
  return bytes.toString('base64url') === text ? bytes : null;
}

/**
 * Parses a stored hash and enforces the safety limits.
 *
 * @returns The parsed record or `null` when the format is unknown or the values are outside the limits.
 */
function parse(stored: unknown): ParsedHash | null {
  if (typeof stored !== 'string') {
    return null;
  }
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return null;
  }
  const [, nText, rText, pText, saltText, keyText] = parts as [string, string, string, string, string, string];
  if (![nText, rText, pText].every((text) => INTEGER.test(text))) {
    return null;
  }
  const N = Number(nText);
  const r = Number(rText);
  const p = Number(pText);
  const powerOfTwo = N >= 2 && (N & (N - 1)) === 0;
  if (!powerOfTwo || N > LIMITS.N || r > LIMITS.r || p > LIMITS.p || N * r * p > LIMITS.cost) {
    return null;
  }
  // Memory cap, and Node's own constraint N < 2^(16 * r), which would otherwise throw.
  if (128 * N * r > LIMITS.memory || (r <= 3 && N >= 2 ** (16 * r))) {
    return null;
  }
  const salt = decode(saltText);
  const key = decode(keyText);
  if (
    salt === null ||
    key === null ||
    salt.length < SALT_RANGE.min ||
    salt.length > SALT_RANGE.max ||
    key.length < KEY_RANGE.min ||
    key.length > KEY_RANGE.max
  ) {
    return null;
  }
  return { N, r, p, salt, key };
}

/**
 * Hashes a password with scrypt (asynchronous, on the libuv thread pool) and a fresh random salt.
 * The password is normalized to NFC first, so equivalent Unicode forms verify alike.
 *
 * @param password Plain-text password, already checked by the password policy.
 * @returns `scrypt$N$r$p$salt$hash` with salt and hash in base64url: the string to store.
 */
export async function hashPassword(password: string): Promise<string> {
  const { N, r, p } = SCRYPT_PARAMS;
  const salt = randomBytes(SALT_BYTES);
  const key = await scryptAsync(password.normalize('NFC'), salt, KEY_BYTES, { N, r, p, maxmem: maxmemFor(N, r, p) });
  return ['scrypt', N, r, p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

/**
 * Verifies a password against a stored hash in constant time, using the parameters recorded in it.
 * A malformed record, or one whose parameters exceed the safety limits (N > 2^20, r > 32, p > 16,
 * N·r·p > 2^22, more than 128 MiB of memory, N not a power of two, N >= 2^(16·r) which scrypt
 * refuses, unusual salt or key length), yields `false` without throwing and without computing the
 * stored record; a fake scrypt runs instead so the response time does not reveal a malformed record.
 * Only Node's `ERR_CRYPTO_INVALID_SCRYPT_PARAMS` is absorbed; any other error propagates.
 *
 * @param password Plain-text password to check.
 * @param stored Hash produced by {@link hashPassword}.
 * @returns `true` when the password matches.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const record = parse(stored);
  if (record === null) {
    await verifyDummyPassword(password);
    return false;
  }
  try {
    const actual = await derive(password, record);
    return timingSafeEqual(actual, record.key);
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ERR_CRYPTO_INVALID_SCRYPT_PARAMS') {
      await verifyDummyPassword(password);
      return false;
    }
    throw error;
  }
}

/** Derives the key of `password` with the parameters and salt of a parsed record. */
function derive(password: string, { N, r, p, salt, key }: ParsedHash): Promise<Buffer> {
  return scryptAsync(password.normalize('NFC'), salt, key.length, { N, r, p, maxmem: maxmemFor(N, r, p) });
}

let dummyHash: Promise<string> | undefined;

function dummy(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(24).toString('base64url'));
  return dummyHash;
}

/**
 * Computes the fake hash used by {@link verifyDummyPassword} now, so that the first failed login
 * after startup does not pay for it (and is not distinguishable by timing). Idempotent.
 *
 * @returns Resolves when the fake hash is ready.
 */
export async function warmUpDummyHash(): Promise<void> {
  await dummy();
}

/**
 * Runs one scrypt derivation with the current parameters against a precomputed fake hash, so that
 * every failure path that would not otherwise run scrypt costs the same as a real verification.
 *
 * @param password The password received in the request.
 * @returns Always `false`.
 */
export async function verifyDummyPassword(password: string): Promise<false> {
  const record = parse(await dummy()) as ParsedHash;
  await derive(password, record);
  return false;
}

/**
 * Tells whether a stored hash should be recomputed after a successful login.
 *
 * @param stored Stored hash.
 * @returns `true` when the format is not recognized or the parameters or lengths differ from the current ones.
 */
export function needsRehash(stored: string): boolean {
  const record = parse(stored);
  if (record === null) {
    return true;
  }
  const { N, r, p } = SCRYPT_PARAMS;
  return (
    record.N !== N ||
    record.r !== r ||
    record.p !== p ||
    record.salt.length !== SALT_BYTES ||
    record.key.length !== KEY_BYTES
  );
}
