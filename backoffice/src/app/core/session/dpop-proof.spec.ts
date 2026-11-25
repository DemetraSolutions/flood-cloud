import { TestBed } from '@angular/core/testing';
import { decodeProof, sha256Base64url, sharedKeyPair, verifyProof } from '../../../testing/dpop';
import { base64url, createDpopProof, DpopProofs } from './dpop-proof';
import { ServerClock } from './server-clock';

const URL_ABS = 'https://api.test/v1/things/42';

const sha256 = sha256Base64url;
const verifies = verifyProof;

describe('base64url', () => {
  it('uses the URL alphabet without padding', () => {
    expect(base64url(new Uint8Array([0xfb, 0xff, 0xfe]))).toBe('-__-');
    expect(base64url(new Uint8Array([1]))).toBe('AQ');
  });
});

describe('createDpopProof', () => {
  it('builds a signed proof with exactly the agreed header and claims', async () => {
    const proof = await createDpopProof(sharedKeyPair, {
      method: 'GET',
      url: URL_ABS,
      issuedAt: 1_700_000_000,
    });
    const jwk = await crypto.subtle.exportKey('jwk', sharedKeyPair.publicKey);
    expect(decodeProof(proof).header).toEqual({
      typ: 'dpop+jwt',
      alg: 'ES256',
      jwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y },
    });
    expect(Object.keys(decodeProof(proof).header['jwk'] as object)).toEqual([
      'kty',
      'crv',
      'x',
      'y',
    ]);
    const claims = decodeProof(proof).claims;
    expect(Object.keys(claims).sort()).toEqual(['htm', 'htu', 'iat', 'jti']);
    expect(claims).toMatchObject({ htm: 'GET', htu: URL_ABS, iat: 1_700_000_000 });
    expect(claims['jti']).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(proof).not.toMatch(/[=+/]/);
    expect(proof.split('.')[2]).toHaveLength(86); // 64 bytes: r || s
    expect(await verifies(proof, sharedKeyPair.publicKey)).toBe(true);
  });

  it('keeps only origin and path in htu', async () => {
    const proof = await createDpopProof(sharedKeyPair, {
      method: 'POST',
      url: 'https://api.test/v1/things?cursor=abc&x=1#frag',
      issuedAt: 1,
    });
    expect(decodeProof(proof).claims).toMatchObject({
      htm: 'POST',
      htu: 'https://api.test/v1/things',
    });
  });

  it('binds the access token with ath', async () => {
    const proof = await createDpopProof(sharedKeyPair, {
      method: 'GET',
      url: URL_ABS,
      accessToken: 'fc_at_1',
      issuedAt: 1,
    });
    const claims = decodeProof(proof).claims;
    expect(claims['ath']).toBe(await sha256('fc_at_1'));
    expect(claims).not.toHaveProperty('rth');
  });

  it('binds the refresh token with rth', async () => {
    const proof = await createDpopProof(sharedKeyPair, {
      method: 'POST',
      url: URL_ABS,
      refreshToken: 'fc_rt_1',
      issuedAt: 1,
    });
    const claims = decodeProof(proof).claims;
    expect(claims['rth']).toBe(await sha256('fc_rt_1'));
    expect(claims).not.toHaveProperty('ath');
  });

  it('has a different jti every time', async () => {
    const input = { method: 'GET', url: URL_ABS, issuedAt: 1 };
    const [a, b] = await Promise.all([
      createDpopProof(sharedKeyPair, input),
      createDpopProof(sharedKeyPair, input),
    ]);
    expect(decodeProof(a).claims['jti']).not.toBe(decodeProof(b).claims['jti']);
  });
});

describe('DpopProofs', () => {
  afterEach(() => vi.useRealTimers());

  it('signs on every subscription with the clock aligned to the server', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-24T10:00:00Z'));
    const clock = TestBed.inject(ServerClock);
    clock.observe('Tue, 24 Nov 2026 10:05:00 GMT');
    const proofs = TestBed.inject(DpopProofs);
    const proof$ = proofs.proof(sharedKeyPair, { method: 'GET', url: URL_ABS, accessToken: 'at' });
    const first = await new Promise<string>((resolve) => proof$.subscribe(resolve));
    vi.setSystemTime(new Date('2026-11-24T10:00:10Z'));
    const second = await new Promise<string>((resolve) => proof$.subscribe(resolve));
    const iat = (proof: string) => decodeProof(proof).claims['iat'];
    expect(iat(first)).toBe(Date.parse('2026-11-24T10:05:00Z') / 1000);
    expect(iat(second)).toBe(Date.parse('2026-11-24T10:05:10Z') / 1000);
    expect(decodeProof(first).claims['jti']).not.toBe(decodeProof(second).claims['jti']);
  });
});
