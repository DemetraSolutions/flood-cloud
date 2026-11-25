import { createHash, createPublicKey, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { AppError } from '../http/errors.ts';
import { safeEqual } from './compare.ts';

/** Maximum length of the `DPoP` header value, in characters. */
export const DPOP_MAX_HEADER_LENGTH = 2048;

/** Maximum distance in seconds between the `iat` of a proof and the server clock. */
export const DPOP_MAX_SKEW_SECONDS = 60;

/** Value of the `WWW-Authenticate` header sent with every `INVALID_DPOP_PROOF`. */
export const DPOP_WWW_AUTHENTICATE = 'DPoP algs="ES256"';

/** A public EC P-256 key in JWK form, restricted to the members that take part in the RFC 7638 thumbprint. */
export interface DpopJwk {
  readonly kty: 'EC';
  readonly crv: 'P-256';
  readonly x: string;
  readonly y: string;
}

/** What the server expects from the proof of one request. */
export interface DpopExpectations {
  /** HTTP method of the request (`htm`). */
  readonly method: string;
  /** Exact URL of the request without query (`htu`), see {@link expectedHtu}. */
  readonly htu: string;
  /** Server clock, in whole seconds since the epoch. */
  readonly nowSeconds: number;
  /** Access token the proof must be bound to (`ath`); when absent the proof must not carry `ath`. */
  readonly accessToken?: string;
  /** Refresh token the proof must be bound to (`rth`); when absent the proof must not carry `rth`. */
  readonly refreshToken?: string;
}

/** Internal reason of a rejected proof; never sent to the client. */
export type DpopRejection = 'malformed' | 'signature' | 'claims' | 'clockSkew';

/** Outcome of {@link verifyDpopProof}. */
export type DpopResult =
  | { readonly ok: true; readonly proof: { readonly jkt: string; readonly jti: string; readonly iat: number } }
  | { readonly ok: false; readonly reason: DpopRejection };

const SEGMENT = /^[A-Za-z0-9_-]+$/;

/** Whether a string is the canonical unpadded base64url encoding of its decoded bytes (no stray padding bits). */
function isCanonical(value: string): boolean {
  return Buffer.from(value, 'base64url').toString('base64url') === value;
}
const JTI = /^[A-Za-z0-9_-]{16,64}$/;
const JOSE_KEYS = ['typ', 'alg', 'jwk'];
const JWK_KEYS = ['kty', 'crv', 'x', 'y'];
const PAYLOAD_KEYS = new Set(['htm', 'htu', 'iat', 'jti', 'ath', 'rth']);
const REJECT_MALFORMED: DpopResult = Object.freeze({ ok: false, reason: 'malformed' });
const REJECT_SIGNATURE: DpopResult = Object.freeze({ ok: false, reason: 'signature' });
const REJECT_CLAIMS: DpopResult = Object.freeze({ ok: false, reason: 'claims' });
const REJECT_SKEW: DpopResult = Object.freeze({ ok: false, reason: 'clockSkew' });

/**
 * Computes the value of the `ath` and `rth` claims: the unpadded base64url SHA-256 of the UTF-8 token.
 *
 * @param token Access or refresh token.
 * @returns The base64url digest.
 */
export function dpopTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url');
}

/**
 * Computes the RFC 7638 thumbprint of an EC P-256 public key: the unpadded base64url SHA-256 of the
 * canonical JSON `{"crv":…,"kty":"EC","x":…,"y":…}` (members in lexicographic order, no spaces).
 *
 * @param jwk The public key.
 * @returns The thumbprint, used as `jkt`.
 */
export function jwkThumbprint(jwk: DpopJwk): string {
  const canonical = `{"crv":${JSON.stringify(jwk.crv)},"kty":${JSON.stringify(jwk.kty)},"x":${JSON.stringify(jwk.x)},"y":${JSON.stringify(jwk.y)}}`;
  return createHash('sha256').update(canonical, 'utf8').digest('base64url');
}

/**
 * Builds the `htu` a proof must carry: the public base URL plus the raw path of the request, cut at the
 * first `?`. No decoding and no normalization: the comparison is exact.
 *
 * @param baseUrl Normalized public base URL (`API_PUBLIC_BASE_URL`, no trailing slash).
 * @param originalUrl `req.originalUrl`, path and query.
 * @returns The expected `htu`.
 */
export function expectedHtu(baseUrl: string, originalUrl: string): string {
  const query = originalUrl.indexOf('?');
  return baseUrl + (query === -1 ? originalUrl : originalUrl.slice(0, query));
}

/**
 * Builds the error for a missing or rejected proof: `401 INVALID_DPOP_PROOF` with a fixed message and
 * `WWW-Authenticate: DPoP algs="ES256"`. It never says which check failed.
 *
 * @returns The error to throw.
 */
export function invalidDpopProof(): AppError {
  return new AppError('INVALID_DPOP_PROOF', { headers: { 'WWW-Authenticate': DPOP_WWW_AUTHENTICATE } });
}

/** Decodes a base64url segment as a JSON plain object read through own properties only, or `undefined`. */
function parseObject(segment: string): Record<string, unknown> | undefined {
  let value: unknown;
  try {
    // Handling, not swallowing: invalid JSON is a rejection reason ("malformed"), not an error to propagate.
    value = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

/** Own member of a parsed object (never inherited, so `__proto__` tricks read nothing). */
function own(object: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

/** Whether the own keys of an object are exactly the given set. */
function hasExactKeys(object: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(object);
  return present.length === keys.length && keys.every((key) => Object.hasOwn(object, key));
}

/** Whether a value is a base64url string that decodes to exactly 32 bytes. */
function isCoordinate(value: unknown): value is string {
  return typeof value === 'string' && SEGMENT.test(value) && isCanonical(value) && Buffer.from(value, 'base64url').length === 32;
}

/** Validates the `jwk` member of the JOSE header and builds the public key; `undefined` when not acceptable. */
function readKey(raw: unknown): { jwk: DpopJwk; key: KeyObject } | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const jwk = raw as Record<string, unknown>;
  if (!hasExactKeys(jwk, JWK_KEYS)) {
    return undefined;
  }
  const { kty, crv, x, y } = jwk;
  if (kty !== 'EC' || crv !== 'P-256' || !isCoordinate(x) || !isCoordinate(y)) {
    return undefined;
  }
  try {
    // Handling, not swallowing: a point that is not on the curve is a rejection reason ("malformed").
    return { jwk: { kty, crv, x, y }, key: createPublicKey({ key: { kty, crv, x, y }, format: 'jwk' }) };
  } catch {
    return undefined;
  }
}

/** Checks a token binding claim: present and equal to the hash of the expected token, or absent when none is expected. */
function bindingMatches(claim: unknown, token: string | undefined): boolean {
  if (token === undefined) {
    return claim === undefined;
  }
  return typeof claim === 'string' && safeEqual(claim, dpopTokenHash(token));
}

/**
 * Verifies a DPoP proof (RFC 9449) with a strict allowlist and `node:crypto` only. Order of the checks:
 * malformed, signature, claims, clock skew. It never throws: failures of the JSON, key or signature
 * primitives are mapped to a rejection reason (that is handling, not swallowing).
 *
 * @param header Raw value of the `DPoP` header, if any.
 * @param expected What the request must prove: method, `htu`, clock and the tokens the proof is bound to.
 * @returns The key thumbprint, `jti` and `iat` of a valid proof, or the internal rejection reason.
 */
export function verifyDpopProof(header: string | undefined, expected: DpopExpectations): DpopResult {
  if (header === undefined || header === '' || header.length > DPOP_MAX_HEADER_LENGTH || header.includes(',')) {
    return REJECT_MALFORMED;
  }
  const segments = header.split('.');
  if (segments.length !== 3 || !segments.every((segment) => SEGMENT.test(segment) && isCanonical(segment))) {
    return REJECT_MALFORMED;
  }
  const [encodedHeader, encodedPayload, encodedSignature] = segments as [string, string, string];
  const jose = parseObject(encodedHeader);
  const payload = parseObject(encodedPayload);
  const signature = Buffer.from(encodedSignature, 'base64url');
  if (jose === undefined || payload === undefined || signature.length !== 64) {
    return REJECT_MALFORMED;
  }
  if (!hasExactKeys(jose, JOSE_KEYS) || own(jose, 'typ') !== 'dpop+jwt' || own(jose, 'alg') !== 'ES256') {
    return REJECT_MALFORMED;
  }
  const publicKey = readKey(own(jose, 'jwk'));
  if (publicKey === undefined) {
    return REJECT_MALFORMED;
  }
  const signed = Buffer.from(`${encodedHeader}.${encodedPayload}`, 'ascii');
  if (!verify('sha256', signed, { key: publicKey.key, dsaEncoding: 'ieee-p1363' }, signature)) {
    return REJECT_SIGNATURE;
  }
  if (!Object.keys(payload).every((key) => PAYLOAD_KEYS.has(key))) {
    return REJECT_CLAIMS;
  }
  const htm = own(payload, 'htm');
  const htu = own(payload, 'htu');
  const iat = own(payload, 'iat');
  const jti = own(payload, 'jti');
  if (
    htm !== expected.method ||
    htu !== expected.htu ||
    typeof iat !== 'number' ||
    !Number.isSafeInteger(iat) ||
    typeof jti !== 'string' ||
    !JTI.test(jti) ||
    !bindingMatches(own(payload, 'ath'), expected.accessToken) ||
    !bindingMatches(own(payload, 'rth'), expected.refreshToken)
  ) {
    return REJECT_CLAIMS;
  }
  if (Math.abs(expected.nowSeconds - iat) > DPOP_MAX_SKEW_SECONDS) {
    return REJECT_SKEW;
  }
  return { ok: true, proof: { jkt: jwkThumbprint(publicKey.jwk), jti, iat } };
}
