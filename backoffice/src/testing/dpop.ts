import { Provider, Service } from '@angular/core';
import { Observable, of } from 'rxjs';
import {
  DPOP_KEY_RECORDS,
  DpopKeys,
  DpopKeyRecord,
  DpopKeyRecords,
} from '../app/core/session/dpop-key-store';
import { DpopProofs } from '../app/core/session/dpop-proof';

/** In-memory {@link DpopKeyRecords}: IndexedDB stand-in that can be made to fail. */
export class MemoryKeyRecords implements DpopKeyRecords {
  readonly map = new Map<string, DpopKeyRecord>();
  /** Methods that reject while set. */
  failing = new Set<'get' | 'put' | 'delete' | 'all'>();

  private guard(method: 'get' | 'put' | 'delete' | 'all'): Promise<void> {
    return this.failing.has(method)
      ? Promise.reject(new Error(`${method} failed`))
      : Promise.resolve();
  }

  async get(sessionId: string): Promise<DpopKeyRecord | undefined> {
    await this.guard('get');
    return this.map.get(sessionId);
  }

  async put(record: DpopKeyRecord): Promise<void> {
    await this.guard('put');
    this.map.set(record.sessionId, record);
  }

  async delete(sessionId: string): Promise<void> {
    await this.guard('delete');
    this.map.delete(sessionId);
  }

  async all(): Promise<DpopKeyRecord[]> {
    await this.guard('all');
    return [...this.map.values()];
  }
}

/** One key pair for the whole run (generated at import): a real one per test is slow and its timing varies. */
export const sharedKeyPair: CryptoKeyPair = await crypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' },
  false,
  ['sign', 'verify'],
);

/** Key store whose `generate()` resolves from the shared pair, in microtasks only. */
@Service()
export class FakeDpopKeys extends DpopKeys {
  override async generate(): Promise<CryptoKeyPair> {
    await Promise.resolve();
    this.keyPair = sharedKeyPair;
    return sharedKeyPair;
  }
}

/** Proofs that are not signed and arrive synchronously, so API specs can flush right away. */
@Service()
export class FakeDpopProofs extends DpopProofs {
  override proof(): Observable<string> {
    return of('fake.dpop.proof');
  }
}

/** Providers replacing IndexedDB and the proof signing in specs that are not about DPoP. */
export function provideDpopTesting(records = new MemoryKeyRecords()): Provider[] {
  return [
    { provide: DPOP_KEY_RECORDS, useValue: records },
    { provide: DpopProofs, useClass: FakeDpopProofs },
    { provide: DpopKeys, useClass: FakeDpopKeys },
  ];
}

/** Decoded parts of a compact DPoP proof. */
export interface DecodedProof {
  readonly header: Record<string, unknown>;
  readonly claims: Record<string, unknown>;
}

function decodePart(part: string): Record<string, unknown> {
  return JSON.parse(atob(part.replaceAll('-', '+').replaceAll('_', '/'))) as Record<
    string,
    unknown
  >;
}

/** Decodes the header and the payload of a compact JWS (no verification). */
export function decodeProof(proof: string): DecodedProof {
  const [header, payload] = proof.split('.');
  return { header: decodePart(header), claims: decodePart(payload) };
}

/** Verifies the ES256 signature of a proof against a public key. */
export async function verifyProof(proof: string, publicKey: CryptoKey): Promise<boolean> {
  const [header, payload, signature] = proof.split('.');
  const bytes = Uint8Array.from(atob(signature.replaceAll('-', '+').replaceAll('_', '/')), (c) =>
    c.charCodeAt(0),
  );
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    bytes,
    new TextEncoder().encode(`${header}.${payload}`),
  );
}

/** `base64url(SHA-256(value))`, as the `ath` and `rth` claims. */
export async function sha256Base64url(value: string): Promise<string> {
  const hash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  );
  return btoa(String.fromCharCode(...hash))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}
