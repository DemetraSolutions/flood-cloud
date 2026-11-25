import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import {
  DPOP_MAX_HEADER_LENGTH,
  DPOP_MAX_SKEW_SECONDS,
  DPOP_WWW_AUTHENTICATE,
  dpopTokenHash,
  expectedHtu,
  invalidDpopProof,
  jwkThumbprint,
  verifyDpopProof,
} from '../../src/shared/security/dpop.ts';
import type { DpopExpectations, DpopJwk, DpopRejection } from '../../src/shared/security/dpop.ts';

const HTU = 'https://api.example.test/v1/items';
const NOW = 1_800_000_000;
const ACCESS = 'fc_at_access-token';
const REFRESH = 'fc_rt_refresh-token';
const JTI = 'abcdefghijklmnop0123';

interface Pair {
  readonly privateKey: KeyObject;
  readonly jwk: DpopJwk;
}

function newPair(curve: 'P-256' | 'P-384' = 'P-256'): Pair {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: curve });
  const jwk = publicKey.export({ format: 'jwk' });
  return { privateKey, jwk: jwk as DpopJwk };
}

const PAIR = newPair();
const OTHER = newPair();

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

function baseHeader(pair: Pair = PAIR): Record<string, unknown> {
  return { typ: 'dpop+jwt', alg: 'ES256', jwk: { kty: pair.jwk.kty, crv: pair.jwk.crv, x: pair.jwk.x, y: pair.jwk.y } };
}

function basePayload(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { htm: 'GET', htu: HTU, iat: NOW, jti: JTI, ...extra };
}

/** Builds a compact proof; header and payload are objects (or raw strings for hand-made segments). */
function proof(header: unknown, payload: unknown, key: KeyObject = PAIR.privateKey): string {
  const head = typeof header === 'string' ? header : b64(header);
  const body = typeof payload === 'string' ? payload : b64(payload);
  const signature = sign('sha256', Buffer.from(`${head}.${body}`, 'ascii'), { key, dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${signature.toString('base64url')}`;
}

const expected = (extra: Partial<DpopExpectations> = {}): DpopExpectations => ({ method: 'GET', htu: HTU, nowSeconds: NOW, ...extra });

function reason(header: string | undefined, exp: DpopExpectations = expected()): DpopRejection | 'ok' {
  const result = verifyDpopProof(header, exp);
  return result.ok ? 'ok' : result.reason;
}

describe('dpop helpers', () => {
  it('exposes the constants', () => {
    assert.equal(DPOP_MAX_HEADER_LENGTH, 2048);
    assert.equal(DPOP_MAX_SKEW_SECONDS, 60);
    assert.equal(DPOP_WWW_AUTHENTICATE, 'DPoP algs="ES256"');
  });

  it('hashes a token as unpadded base64url SHA-256', () => {
    const hash = dpopTokenHash('fc_at_é');
    assert.equal(hash, createHash('sha256').update(Buffer.from('fc_at_é', 'utf8')).digest().toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''));
    assert.match(hash, /^[A-Za-z0-9_-]{43}$/);
  });

  it('computes the RFC 7638 thumbprint over the canonical JSON', () => {
    const jwk = PAIR.jwk;
    const manual = `{"crv":"P-256","kty":"EC","x":"${jwk.x}","y":"${jwk.y}"}`;
    const expectedThumbprint = createHash('sha256').update(manual).digest('base64url');
    assert.equal(jwkThumbprint(jwk), expectedThumbprint);
    // Member order of the input does not matter.
    assert.equal(jwkThumbprint({ y: jwk.y, x: jwk.x, crv: 'P-256', kty: 'EC' }), expectedThumbprint);
  });

  it('computes the thumbprint of the RFC 7638 style fixed key', () => {
    const jwk: DpopJwk = { kty: 'EC', crv: 'P-256', x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU', y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0' };
    const manual = '{"crv":"P-256","kty":"EC","x":"f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU","y":"x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0"}';
    assert.equal(jwkThumbprint(jwk), createHash('sha256').update(manual).digest('base64url'));
    assert.equal(jwkThumbprint(jwk), 'oKIywvGUpTVTyxMQ3bwIIeQUudfr_CkLMjCE19ECD-U');
  });

  it('builds the expected htu from the base URL and the raw path, cut at the first question mark', () => {
    assert.equal(expectedHtu('https://api.example.test', '/v1/items'), 'https://api.example.test/v1/items');
    assert.equal(expectedHtu('https://api.example.test/api', '/v1/items?x=1?y=2'), 'https://api.example.test/api/v1/items');
    assert.equal(expectedHtu('https://api.example.test', '/v1/it%2Fems/?'), 'https://api.example.test/v1/it%2Fems/');
  });

  it('builds the fixed rejection error with the challenge header', () => {
    const error = invalidDpopProof();
    assert.equal(error.code, 'INVALID_DPOP_PROOF');
    assert.equal(error.status, 401);
    assert.equal(error.message, 'Invalid proof of possession');
    assert.deepEqual(error.headers, { 'WWW-Authenticate': 'DPoP algs="ES256"' });
  });
});

describe('verifyDpopProof accepts', () => {
  it('a proof with neither ath nor rth', () => {
    const result = verifyDpopProof(proof(baseHeader(), basePayload()), expected());
    assert.deepEqual(result, { ok: true, proof: { jkt: jwkThumbprint(PAIR.jwk), jti: JTI, iat: NOW } });
  });

  it('a proof bound to the access token', () => {
    assert.equal(reason(proof(baseHeader(), basePayload({ ath: dpopTokenHash(ACCESS) })), expected({ accessToken: ACCESS })), 'ok');
  });

  it('a proof bound to the refresh token', () => {
    const header = proof(baseHeader(), basePayload({ htm: 'POST', rth: dpopTokenHash(REFRESH) }));
    assert.equal(reason(header, expected({ method: 'POST', refreshToken: REFRESH })), 'ok');
  });

  it('iat at exactly plus and minus 60 seconds', () => {
    assert.equal(reason(proof(baseHeader(), basePayload({ iat: NOW + 60 }))), 'ok');
    assert.equal(reason(proof(baseHeader(), basePayload({ iat: NOW - 60 }))), 'ok');
  });
});

describe('verifyDpopProof rejects as malformed', () => {
  const good = proof(baseHeader(), basePayload());
  const [h, p, s] = good.split('.') as [string, string, string];

  it('a missing or empty header', () => {
    assert.equal(reason(undefined), 'malformed');
    assert.equal(reason(''), 'malformed');
  });

  it('a header longer than 2048 characters', () => {
    assert.equal(reason(proof(baseHeader(), basePayload({ nonce: 'n'.repeat(2100) }))), 'malformed');
    assert.equal(reason('a'.repeat(DPOP_MAX_HEADER_LENGTH + 1)), 'malformed');
  });

  it('a comma (duplicated header joined by Node)', () => {
    assert.equal(reason(`${good}, ${good}`), 'malformed');
  });

  it('two or four segments', () => {
    assert.equal(reason(`${h}.${p}`), 'malformed');
    assert.equal(reason(`${h}.${p}.${s}.${s}`), 'malformed');
  });

  it('padding, standard base64 characters and empty segments', () => {
    assert.equal(reason(`${h}=.${p}.${s}`), 'malformed');
    assert.equal(reason(`${h}.${p}.${s}=`), 'malformed');
    assert.equal(reason(`${h}.${p}+.${s}`), 'malformed');
    assert.equal(reason(`${h}..${s}`), 'malformed');
  });

  it('a header or payload that is not JSON', () => {
    assert.equal(reason(proof(Buffer.from('not json').toString('base64url'), basePayload())), 'malformed');
    assert.equal(reason(proof(baseHeader(), Buffer.from('{').toString('base64url'))), 'malformed');
  });

  it('a header or payload that is a JSON array or null', () => {
    assert.equal(reason(proof('W10', basePayload())), 'malformed');
    assert.equal(reason(proof(baseHeader(), 'W10')), 'malformed');
    assert.equal(reason(proof(b64(null), basePayload())), 'malformed');
    assert.equal(reason(proof(baseHeader(), b64(null))), 'malformed');
    assert.equal(reason(proof(b64('text'), basePayload())), 'malformed');
  });

  it('a DER signature or a signature of the wrong length', () => {
    const head = b64(baseHeader());
    const body = b64(basePayload());
    const der = sign('sha256', Buffer.from(`${head}.${body}`, 'ascii'), PAIR.privateKey);
    assert.equal(reason(`${head}.${body}.${der.toString('base64url')}`), 'malformed');
    assert.equal(reason(`${head}.${body}.${Buffer.alloc(63).toString('base64url')}`), 'malformed');
    assert.equal(reason(`${head}.${body}.${Buffer.alloc(65).toString('base64url')}`), 'malformed');
  });

  it('alg none, HS256, ES384 and RS256', () => {
    for (const alg of ['none', 'HS256', 'ES384', 'RS256']) {
      assert.equal(reason(proof({ ...baseHeader(), alg }, basePayload())), 'malformed', alg);
    }
  });

  it('a wrong typ', () => {
    assert.equal(reason(proof({ ...baseHeader(), typ: 'JWT' }, basePayload())), 'malformed');
  });

  it('a missing member of the JOSE header', () => {
    for (const key of ['typ', 'alg', 'jwk']) {
      const header = baseHeader();
      delete header[key];
      assert.equal(reason(proof(header, basePayload())), 'malformed', key);
    }
  });

  it('extra JOSE members: kid, jku, x5c, crit', () => {
    for (const [key, value] of [['kid', 'k'], ['jku', 'https://evil.test/jwks'], ['x5c', ['AA']], ['crit', ['b64']]] as const) {
      assert.equal(reason(proof({ ...baseHeader(), [key]: value }, basePayload())), 'malformed', key);
    }
  });

  it('a jwk that is missing, not an object or an array', () => {
    for (const jwk of [undefined, 'key', null, [PAIR.jwk]]) {
      assert.equal(reason(proof({ ...baseHeader(), jwk }, basePayload())), 'malformed');
    }
  });

  it('a jwk with the private member d, or with kid or use', () => {
    const { privateKey } = PAIR;
    const withD = { ...(privateKey.export({ format: 'jwk' }) as Record<string, string>) };
    assert.equal(reason(proof({ ...baseHeader(), jwk: withD }, basePayload())), 'malformed');
    for (const key of ['kid', 'use']) {
      assert.equal(reason(proof({ ...baseHeader(), jwk: { ...PAIR.jwk, [key]: 'x' } }, basePayload())), 'malformed', key);
    }
  });

  it('a jwk with a missing member', () => {
    for (const key of ['kty', 'crv', 'x', 'y']) {
      const jwk: Record<string, unknown> = { ...PAIR.jwk };
      delete jwk[key];
      assert.equal(reason(proof({ ...baseHeader(), jwk }, basePayload())), 'malformed', key);
    }
  });

  it('a jwk on P-384, of type RSA, with a non-string or oversized coordinate', () => {
    const p384 = newPair('P-384');
    assert.equal(reason(proof({ ...baseHeader(), jwk: { kty: 'EC', crv: 'P-384', x: p384.jwk.x, y: p384.jwk.y } }, basePayload())), 'malformed');
    assert.equal(reason(proof({ ...baseHeader(), jwk: { ...PAIR.jwk, kty: 'RSA' } }, basePayload())), 'malformed');
    assert.equal(reason(proof({ ...baseHeader(), jwk: { ...PAIR.jwk, x: 5 } }, basePayload())), 'malformed');
    assert.equal(reason(proof({ ...baseHeader(), jwk: { ...PAIR.jwk, y: `${PAIR.jwk.y}AA` } }, basePayload())), 'malformed');
  });

  it('a jwk with a coordinate of 31 bytes or with standard base64 characters', () => {
    const short = Buffer.from(PAIR.jwk.x, 'base64url').subarray(1).toString('base64url');
    assert.equal(reason(proof({ ...baseHeader(), jwk: { ...PAIR.jwk, x: short } }, basePayload())), 'malformed');
    assert.equal(reason(proof({ ...baseHeader(), jwk: { ...PAIR.jwk, x: 'a+'.repeat(21) + 'aa' } }, basePayload())), 'malformed');
  });

  it('a point that is not on the curve', () => {
    const jwk = { kty: 'EC', crv: 'P-256', x: PAIR.jwk.x, y: Buffer.alloc(32, 1).toString('base64url') };
    assert.equal(reason(proof({ ...baseHeader(), jwk }, basePayload())), 'malformed');
  });

  it('a __proto__ key in the header', () => {
    const head = `{"typ":"dpop+jwt","alg":"ES256","jwk":${JSON.stringify(baseHeader().jwk)},"__proto__":{"x":1}}`;
    assert.equal(reason(proof(Buffer.from(head).toString('base64url'), basePayload())), 'malformed');
  });
});

describe('verifyDpopProof rejects the signature', () => {
  it('a signature made with another key', () => {
    assert.equal(reason(proof(baseHeader(), basePayload(), OTHER.privateKey)), 'signature');
  });

  it('a payload changed after signing', () => {
    const [h, , s] = proof(baseHeader(), basePayload()).split('.') as [string, string, string];
    assert.equal(reason(`${h}.${b64(basePayload({ jti: 'zzzzzzzzzzzzzzzzzzzz' }))}.${s}`), 'signature');
  });

  it('wins over bad claims: a badly signed proof with a wrong htm is a signature failure', () => {
    assert.equal(reason(proof(baseHeader(), basePayload({ htm: 'POST' }), OTHER.privateKey)), 'signature');
  });
});

describe('verifyDpopProof rejects a non canonical base64url', () => {
  /** Changes the last character of a base64url string to one with non-zero padding bits, which decodes to the same bytes. */
  function nonCanonical(value: string): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = alphabet.indexOf(value.at(-1)!);
    const tweaked = alphabet[last + 1 === 64 ? last - 1 : last + 1]!;
    const changed = value.slice(0, -1) + tweaked;
    assert.deepEqual(Buffer.from(changed, 'base64url'), Buffer.from(value, 'base64url'));
    assert.notEqual(changed, value);
    return changed;
  }

  it('a segment whose last character carries padding bits', () => {
    const [h, p, s] = proof(baseHeader(), basePayload()).split('.') as [string, string, string];
    // 43 characters of a 64 byte signature: the last one has 4 spare bits.
    assert.equal(reason(`${h}.${p}.${nonCanonical(s)}`), 'malformed');
  });

  it('a coordinate of the key whose last character carries padding bits', () => {
    for (const member of ['x', 'y'] as const) {
      const header = baseHeader() as { jwk: Record<string, string> };
      header.jwk[member] = nonCanonical(header.jwk[member]!);
      assert.equal(reason(proof(header, basePayload())), 'malformed', member);
    }
  });
});

describe('verifyDpopProof rejects the claims', () => {
  it('a __proto__ key in the payload', () => {
    const body = `{"htm":"GET","htu":"${HTU}","iat":${NOW},"jti":"${JTI}","__proto__":{"x":1}}`;
    assert.equal(reason(proof(baseHeader(), Buffer.from(body).toString('base64url'))), 'claims');
  });

  it('an unknown claim', () => {
    assert.equal(reason(proof(baseHeader(), basePayload({ exp: NOW + 10 }))), 'claims');
  });

  it('a nonce, whatever its type: the server never issues one', () => {
    assert.equal(reason(proof(baseHeader(), basePayload({ nonce: 'server-nonce' }))), 'claims');
    assert.equal(reason(proof(baseHeader(), basePayload({ nonce: 5 }))), 'claims');
  });

  it('an htm that does not match, is missing or has another case', () => {
    assert.equal(reason(proof(baseHeader(), basePayload({ htm: 'POST' }))), 'claims');
    assert.equal(reason(proof(baseHeader(), basePayload({ htm: 'get' }))), 'claims');
    const payload = basePayload();
    delete payload['htm'];
    assert.equal(reason(proof(baseHeader(), payload)), 'claims');
  });

  it('an htu with another host, scheme, port, path, query or trailing slash', () => {
    for (const htu of [
      'https://evil.example.test/v1/items',
      'http://api.example.test/v1/items',
      'https://api.example.test:8443/v1/items',
      'https://api.example.test/v1/other',
      `${HTU}?x=1`,
      `${HTU}/`,
      42,
    ]) {
      assert.equal(reason(proof(baseHeader(), basePayload({ htu }))), 'claims', String(htu));
    }
  });

  it('an iat that is a float, a string, missing or not a safe integer', () => {
    assert.equal(reason(proof(baseHeader(), basePayload({ iat: NOW + 0.5 }))), 'claims');
    assert.equal(reason(proof(baseHeader(), basePayload({ iat: String(NOW) }))), 'claims');
    assert.equal(reason(proof(baseHeader(), basePayload({ iat: 2 ** 60 }))), 'claims');
    const payload = basePayload();
    delete payload['iat'];
    assert.equal(reason(proof(baseHeader(), payload)), 'claims');
  });

  it('a jti that is missing, short, long, with bad characters or not a string', () => {
    const payload = basePayload();
    delete payload['jti'];
    assert.equal(reason(proof(baseHeader(), payload)), 'claims');
    for (const jti of ['a'.repeat(15), 'a'.repeat(65), 'abcdefghijklmnop+/==', 'abcdefghijklmnop 123', 12345678901234567]) {
      assert.equal(reason(proof(baseHeader(), basePayload({ jti }))), 'claims', String(jti));
    }
  });

  it('an ath that is missing, wrong, in standard base64 or not a string when an access token is expected', () => {
    const exp = expected({ accessToken: ACCESS });
    assert.equal(reason(proof(baseHeader(), basePayload()), exp), 'claims');
    assert.equal(reason(proof(baseHeader(), basePayload({ ath: dpopTokenHash('another') })), exp), 'claims');
    const standard = createHash('sha256').update(ACCESS).digest('base64');
    assert.equal(reason(proof(baseHeader(), basePayload({ ath: `${standard}=` })), exp), 'claims');
    assert.equal(reason(proof(baseHeader(), basePayload({ ath: 7 })), exp), 'claims');
  });

  it('an ath present when no access token is expected', () => {
    assert.equal(reason(proof(baseHeader(), basePayload({ ath: dpopTokenHash(ACCESS) }))), 'claims');
  });

  it('an rth that is missing or wrong when a refresh token is expected', () => {
    const exp = expected({ refreshToken: REFRESH });
    assert.equal(reason(proof(baseHeader(), basePayload()), exp), 'claims');
    assert.equal(reason(proof(baseHeader(), basePayload({ rth: dpopTokenHash('another') })), exp), 'claims');
  });

  it('an rth present when no refresh token is expected', () => {
    assert.equal(reason(proof(baseHeader(), basePayload({ rth: dpopTokenHash(REFRESH) }))), 'claims');
  });

  it('an ath given where only an rth is expected', () => {
    const exp = expected({ refreshToken: REFRESH });
    assert.equal(reason(proof(baseHeader(), basePayload({ rth: dpopTokenHash(REFRESH), ath: dpopTokenHash(ACCESS) })), exp), 'claims');
  });
});

describe('verifyDpopProof rejects the clock skew', () => {
  it('an iat 61 seconds in the future or in the past', () => {
    assert.equal(reason(proof(baseHeader(), basePayload({ iat: NOW + 61 }))), 'clockSkew');
    assert.equal(reason(proof(baseHeader(), basePayload({ iat: NOW - 61 }))), 'clockSkew');
  });

  it('only after the claims are checked: a wrong htm with a stale iat is a claims failure', () => {
    assert.equal(reason(proof(baseHeader(), basePayload({ htm: 'POST', iat: NOW - 600 }))), 'claims');
  });
});
