import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { dpopTokenHash, jwkThumbprint } from '../../src/shared/security/dpop.ts';
import type { DpopJwk } from '../../src/shared/security/dpop.ts';

/** The `API_PUBLIC_BASE_URL` of {@link validEnv}: the `htu` of a proof is this plus the path of the request. */
export const TEST_API_PUBLIC_BASE_URL = 'https://api.example.test/api';

/** A browser key of the tests: a P-256 pair, its public JWK and its thumbprint (what a session stores as `jkt`). */
export interface BrowserKey {
  readonly privateKey: KeyObject;
  readonly jwk: DpopJwk;
  readonly jkt: string;
}

/** Generates a fresh P-256 key, as the backoffice does at every login. */
export function newBrowserKey(): BrowserKey {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const { kty, crv, x, y } = publicKey.export({ format: 'jwk' });
  const jwk = { kty, crv, x, y } as DpopJwk;
  return { privateKey, jwk, jkt: jwkThumbprint(jwk) };
}

/** The claims of a proof: `iat`, `ath` and `rth` are given in clear (the hash is computed here), `null` or absent leaves the claim out. */
export interface ProofClaims {
  /** HTTP method of the request. */
  readonly method: string;
  /** Path of the request, as the server sees it (`/v1/me`), query allowed (it is cut). */
  readonly path: string;
  /** Seconds since the epoch. */
  readonly iat: number;
  /** Access token the proof is bound to (`ath`). */
  readonly accessToken?: string | undefined;
  /** Refresh token the proof is bound to (`rth`). */
  readonly refreshToken?: string | undefined;
  /** Full `htu` instead of the one built from the path (to forge a proof for another URL). */
  readonly htu?: string;
  readonly jti?: string;
}

/**
 * Signs a DPoP proof (ES256, IEEE P1363 signature) with `key`.
 *
 * @param key The browser key.
 * @param claims What the proof says.
 * @returns The value of the `DPoP` header.
 */
export function signProof(key: BrowserKey, claims: ProofClaims): string {
  const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: key.jwk };
  const query = claims.path.indexOf('?');
  const payload = {
    htm: claims.method,
    htu: claims.htu ?? TEST_API_PUBLIC_BASE_URL + (query === -1 ? claims.path : claims.path.slice(0, query)),
    iat: claims.iat,
    jti: claims.jti ?? randomBytes(24).toString('base64url'),
    ...(claims.accessToken === undefined ? {} : { ath: dpopTokenHash(claims.accessToken) }),
    ...(claims.refreshToken === undefined ? {} : { rth: dpopTokenHash(claims.refreshToken) }),
  };
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  const signingInput = `${encode(header)}.${encode(payload)}`;
  const signature = sign('sha256', Buffer.from(signingInput, 'ascii'), { key: key.privateKey, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${signature.toString('base64url')}`;
}
