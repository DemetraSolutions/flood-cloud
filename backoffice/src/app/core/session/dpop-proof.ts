import { inject, Service } from '@angular/core';
import { defer, Observable } from 'rxjs';
import { ServerClock } from './server-clock';

/** Random bytes of the `jti` claim. */
const JTI_BYTES = 32;

/** What a proof is bound to. */
export interface DpopProofInput {
  /** HTTP method of the request (`htm`). */
  readonly method: string;
  /** Absolute URL of the request; query and fragment are dropped (`htu`). */
  readonly url: string;
  /** Access token the request carries: adds `ath`. */
  readonly accessToken?: string | null;
  /** Refresh token in the body of `POST /v1/auth/refresh`: adds `rth`. */
  readonly refreshToken?: string | null;
  /** Issue time in epoch seconds (`iat`), aligned with the server clock. */
  readonly issuedAt: number;
}

/** Base64url (RFC 4648 section 5) without padding. */
export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

const encoder = new TextEncoder();

function encodeJson(value: object): string {
  return base64url(encoder.encode(JSON.stringify(value)));
}

/** `base64url(SHA-256(value))`, the format of the `ath` and `rth` claims. */
async function digest(value: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}

/**
 * Builds a DPoP proof (a compact JWS signed with ES256) for one request. The private key is only
 * used to sign and never leaves the `CryptoKey`; nothing is logged.
 *
 * @param keyPair Key pair of the session (the public half goes in the JOSE header).
 * @param input Request and tokens the proof is bound to.
 * @returns The compact JWS for the `DPoP` header.
 */
export async function createDpopProof(
  keyPair: CryptoKeyPair,
  input: DpopProofInput,
): Promise<string> {
  const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  const header = encodeJson({ typ: 'dpop+jwt', alg: 'ES256', jwk: { kty, crv, x, y } });
  const { origin, pathname } = new URL(input.url);
  const payload = encodeJson({
    htm: input.method,
    htu: origin + pathname,
    iat: input.issuedAt,
    jti: base64url(crypto.getRandomValues(new Uint8Array(JTI_BYTES))),
    ...(input.accessToken ? { ath: await digest(input.accessToken) } : {}),
    ...(input.refreshToken ? { rth: await digest(input.refreshToken) } : {}),
  });
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    keyPair.privateKey,
    encoder.encode(signingInput),
  );
  return `${signingInput}.${base64url(new Uint8Array(signature))}`;
}

/**
 * Produces the proofs of the API requests. Every subscription builds a new proof (new `jti`,
 * `iat` from the aligned server clock), so a request repeated after a refresh never reuses one.
 */
@Service()
export class DpopProofs {
  private readonly clock = inject(ServerClock);

  /**
   * Cold observable of a fresh proof, signed on subscription.
   *
   * @param keyPair Key pair of the session.
   * @param input Request data; `issuedAt` is filled from the server clock.
   */
  proof(keyPair: CryptoKeyPair, input: Omit<DpopProofInput, 'issuedAt'>): Observable<string> {
    return defer(() => createDpopProof(keyPair, { ...input, issuedAt: this.clock.nowSeconds() }));
  }
}
