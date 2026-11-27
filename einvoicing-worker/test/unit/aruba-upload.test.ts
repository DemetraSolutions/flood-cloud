import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { freePort } from '../helpers/env.ts';
import { createArubaRig, live, TEST_PASSWORD, testFile } from '../helpers/aruba.ts';
import type { ArubaRig } from '../helpers/aruba.ts';
import type { Reply } from '../helpers/fake-aruba.ts';
import { tokenReply } from '../helpers/fake-aruba.ts';

const UPLOAD = 'POST /services/invoice/upload';
const SIGNIN = 'POST /auth/signin';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const SELLER_A = 'IT01234567890';
const SELLER_B = 'IT01879020517';

describe('Aruba: upload', () => {
  let rig: ArubaRig;
  const upload = (values = {}) => rig.adapter.upload(rig.account, testFile(values), live());
  const answer = (errorCode: string, extra: Record<string, unknown> = {}): Reply => ({ json: { errorCode, errorDescription: `description of ${errorCode}`, uploadFileName: '', ...extra } });

  beforeEach(async () => {
    rig = await createArubaRig({ deps: { timeouts: { upload: 300, request: 300 } } });
  });
  afterEach(async () => {
    await rig.close();
  });

  it('sends the file as base64 in the documented JSON with the token, and takes the file name as the provider id', async () => {
    rig.fake.route(UPLOAD, answer('0000', { uploadFileName: 'IT01234567890_abcde.xml.p7m' }));
    assert.deepEqual(await upload(), { kind: 'accepted', providerId: 'IT01234567890_abcde.xml.p7m' });
    const [hit] = rig.fake.hits(UPLOAD);
    assert.equal(hit?.headers['authorization'], 'Bearer access-token-1');
    assert.equal(hit?.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(hit?.body ?? ''), { dataFile: Buffer.from('<xml>fattura &amp; ç</xml>', 'utf8').toString('base64'), credential: '', domain: '', senderPIVA: '', skipExtraSchema: false, dryRun: false });
    assert.equal(hit?.rawQuery, '');
  });

  it('treats an accepted answer without a usable file name as maybe sent (the engine then looks it up)', async () => {
    for (const uploadFileName of [undefined, '', 'has space.xml', 'a/b.xml', 42, 'x'.repeat(101)]) {
      rig.fake.route(UPLOAD, answer('0000', { uploadFileName }));
      assert.deepEqual(await upload(), { kind: 'maybeSent' }, String(uploadFileName));
    }
    assert.ok(rig.log.messages('warn').every((message) => message === 'Aruba accepted the file without a usable file name: it will be looked up'));
  });

  it('0034 (already sent recently) is maybe sent', async () => {
    rig.fake.route(UPLOAD, answer('0034'));
    assert.deepEqual(await upload(), { kind: 'maybeSent' });
  });

  it('maps every other documented code', async () => {
    const expected: Array<[string, unknown]> = [
      ['0093', { kind: 'retry', scope: 'seller', afterMs: HOUR, code: 'ARUBA_0093' }],
      ['0001', { kind: 'maybeSent' }],
      ['0013', { kind: 'maybeSent' }],
      ['0095', { kind: 'retry', scope: 'document', afterMs: 15 * MINUTE, code: 'ARUBA_0095' }],
      ['0012', { kind: 'retry', scope: 'document', afterMs: MINUTE, code: 'ARUBA_0012' }],
      ['0097', { kind: 'retry', scope: 'account', afterMs: 6 * HOUR, code: 'ARUBA_0097' }],
    ];
    for (const [code, outcome] of expected) {
      rig.fake.route(UPLOAD, answer(code));
      rig.clock.advance(70_000);
      assert.deepEqual(await upload(), outcome, code);
    }
    assert.deepEqual(rig.log.messages('error'), ['the Aruba storage of the account is full: nothing can be sent']);
  });

  it('0012 and 401 pause the account for a minute without escalating: a document retry plus a hold on the account limiter', async () => {
    const held = (): number => rig.limiters.gate('account:aruba:upload', { minIntervalMs: 0, jitterMs: 0, maxPerHour: null, maxPerYear: null }, rig.clock.now()).at - rig.clock.now();
    rig.fake.route(UPLOAD, answer('0012'));
    assert.equal((await upload()).kind, 'retry');
    assert.equal(held(), MINUTE);
    rig.clock.advance(2 * MINUTE);
    rig.fake.route(UPLOAD, { status: 401 });
    assert.deepEqual(await upload(), { kind: 'retry', scope: 'document', afterMs: MINUTE, code: 'HTTP_401' });
    assert.equal(held(), MINUTE);
    assert.equal(rig.limiters.gate('account:aruba:upload', { minIntervalMs: 0, jitterMs: 0, maxPerHour: null, maxPerYear: null }, rig.clock.now()).reason, 'cooldown');
  });

  it('0012 drops the token: the next upload signs in again, with the refresh token', async () => {
    rig.fake.route(UPLOAD, [answer('0012'), answer('0000', { uploadFileName: 'ok.xml' })]);
    await upload();
    rig.clock.advance(70_000);
    rig.fake.route(SIGNIN, tokenReply('access-token-2'));
    assert.deepEqual(await upload(), { kind: 'accepted', providerId: 'ok.xml' });
    assert.equal(rig.fake.hits(UPLOAD)[1]?.headers['authorization'], 'Bearer access-token-2');
    assert.equal(new URLSearchParams(rig.fake.hits(SIGNIN)[1]?.body).get('grant_type'), 'refresh_token');
  });

  it('rejects for good the codes that no retry can fix, with the cleaned description', async () => {
    for (const code of ['0002', '0033', '0092', '0094', '0096', '0098', '4242']) {
      rig.fake.route(UPLOAD, answer(code, { errorDescription: `00400 - Natura\u0000non\u0007coerente ${'x'.repeat(2000)}` }));
      const outcome = await upload();
      assert.equal(outcome.kind, 'rejected', code);
      assert.ok(outcome.kind === 'rejected' && outcome.code === code && outcome.description.startsWith('00400 - Natura non coerente xxx') && outcome.description.length === 1000);
    }
    rig.fake.route(UPLOAD, { json: {} });
    assert.deepEqual(await upload(), { kind: 'rejected', code: '', description: '' });
  });

  describe('anti-tappo: 429 and the undocumented 0099 are the tier rate limit', () => {
    it('the first limited seller waits 62 minutes, alone; a different seller right after blocks the account', async () => {
      rig.fake.route(UPLOAD, { status: 429 });
      assert.deepEqual(await upload({ sellerVat: SELLER_A }), { kind: 'retry', scope: 'seller', afterMs: 62 * MINUTE, code: 'HTTP_429' });
      assert.deepEqual(await upload({ sellerVat: SELLER_B }), { kind: 'retry', scope: 'account', afterMs: 10 * MINUTE, code: 'HTTP_429' });
      assert.deepEqual(rig.log.messages('warn'), ['two different sellers were limited in a row: the account backs off']);
    });

    it('the same seller twice in a row stays a seller matter', async () => {
      rig.fake.route(UPLOAD, answer('0099'));
      for (let times = 0; times < 3; times += 1) {
        assert.deepEqual(await upload({ sellerVat: SELLER_A }), { kind: 'retry', scope: 'seller', afterMs: 62 * MINUTE, code: 'ARUBA_0099' });
      }
    });

    it('code 0099 and HTTP 429 count as the same thing', async () => {
      rig.fake.route(UPLOAD, [answer('0099'), { status: 429 }]);
      await upload({ sellerVat: SELLER_A });
      const second = await upload({ sellerVat: SELLER_B });
      assert.equal(second.kind === 'retry' ? second.scope : '', 'account');
    });

    it('an accepted upload resets the count: the next limited seller is a first one again', async () => {
      rig.fake.route(UPLOAD, [{ status: 429 }, answer('0000', { uploadFileName: 'ok.xml' }), { status: 429 }]);
      await upload({ sellerVat: SELLER_A });
      assert.equal((await upload({ sellerVat: SELLER_B })).kind, 'accepted');
      const third = await upload({ sellerVat: SELLER_B });
      assert.equal(third.kind === 'retry' ? third.scope : '', 'seller');
    });

    it('a failure of another kind does not reset it, and forgetting the hub clears it', async () => {
      rig.fake.route(UPLOAD, [{ status: 429 }, answer('0001'), { status: 429 }, { status: 429 }]);
      const scopeOf = (outcome: Awaited<ReturnType<typeof upload>>): string => (outcome.kind === 'retry' ? outcome.scope : outcome.kind);
      assert.equal(scopeOf(await upload({ sellerVat: SELLER_A })), 'seller');
      assert.equal(scopeOf(await upload({ sellerVat: SELLER_B })), 'maybeSent');
      assert.equal(scopeOf(await upload({ sellerVat: SELLER_B })), 'account');
      rig.adapter.forget('aruba');
      rig.clock.advance(70_000);
      assert.equal(scopeOf(await upload({ sellerVat: SELLER_B })), 'seller');
      rig.adapter.forget('never-seen');
    });

    it('is kept per hub', async () => {
      rig.accounts.set('aruba__0123456789abcdef01234567', { ...rig.account, hub: 'aruba__0123456789abcdef01234567' });
      rig.fake.route(UPLOAD, { status: 429 });
      await upload({ sellerVat: SELLER_A });
      rig.clock.advance(70_000);
      const other = await rig.adapter.upload({ ...rig.account, hub: 'aruba__0123456789abcdef01234567' }, testFile({ sellerVat: SELLER_B }), live());
      assert.equal(other.kind === 'retry' ? other.scope : '', 'seller', 'a limit met on another hub says nothing about this one');
    });
  });

  it('other HTTP statuses: 5xx may come after Aruba took the file (maybe sent), 401 drops the token, any other 4xx is a rejection', async () => {
    for (const status of [500, 502, 504]) {
      rig.fake.route(UPLOAD, { status, text: 'html error page' });
      assert.deepEqual(await upload(), { kind: 'maybeSent' }, String(status));
    }
    rig.fake.route(UPLOAD, { status: 401 });
    assert.deepEqual(await upload(), { kind: 'retry', scope: 'document', afterMs: MINUTE, code: 'HTTP_401' });
  });

  it('HTTP 408, 409, 425 and any status that is not plainly a wrong request leave the outcome unknown; only 400, 403, 404, 413, 415 refuse for good', async () => {
    for (const status of [408, 409, 425, 405, 410, 422, 204, 302]) {
      rig.fake.route(UPLOAD, { status, text: 'x' });
      assert.deepEqual(await upload(), { kind: 'maybeSent' }, String(status));
    }
    for (const status of [400, 403, 404, 413, 415]) {
      rig.fake.route(UPLOAD, { status, text: 'x' });
      assert.deepEqual(await upload(), { kind: 'rejected', code: `HTTP_${status}`, description: `Aruba ha rifiutato la richiesta (HTTP ${status})` }, String(status));
    }
  });

  it('an abort while waiting for the sign-in turn is a short document retry: neither the IP nor the account is held back', async () => {
    const aborted = new AbortController();
    const impatient = await createArubaRig({ deps: { sleep: async () => aborted.abort() } });
    try {
      impatient.fake.route(UPLOAD, answer('0000', { uploadFileName: 'ok.xml' }));
      await impatient.adapter.upload(impatient.account, testFile(), live());
      impatient.adapter.forget('aruba');
      impatient.clock.advance(58_000);
      assert.deepEqual(await impatient.adapter.upload(impatient.account, testFile(), aborted.signal), { kind: 'retry', scope: 'document', afterMs: 1000, code: 'ABORTED' });
      assert.equal(impatient.fake.hits(UPLOAD).length, 1);
    } finally {
      await impatient.close();
    }
  });

  it('an unreadable 200 may have been taken: maybe sent', async () => {
    for (const reply of [{ text: '<html>' }, { json: ['x'] }, { text: '' }]) {
      rig.fake.route(UPLOAD, reply);
      assert.deepEqual(await upload(), { kind: 'maybeSent' });
    }
  });

  it('a timeout, a cut connection, an oversized answer or an abort after the request left are maybe sent', async () => {
    rig.fake.route(UPLOAD, { hang: true });
    assert.deepEqual(await upload(), { kind: 'maybeSent' });
    rig.fake.route(UPLOAD, { destroy: true });
    assert.deepEqual(await upload(), { kind: 'maybeSent' });
    rig.fake.route(UPLOAD, { text: 'x'.repeat(70_000) });
    assert.deepEqual(await upload(), { kind: 'maybeSent' });
    assert.deepEqual(await rig.adapter.upload(rig.account, testFile(), AbortSignal.abort()), { kind: 'maybeSent' });
  });

  it('only a connection that never opened is proof the file did not leave: retry on the IP in a minute', async () => {
    const port = await freePort();
    const closed = await createArubaRig({ deps: { hosts: { auth: rig.fake.origin, ws: `http://127.0.0.1:${port}` } } });
    try {
      assert.deepEqual(await closed.adapter.upload(closed.account, testFile(), live()), { kind: 'retry', scope: 'ip', afterMs: MINUTE, code: 'CONNECT' });
    } finally {
      await closed.close();
    }
  });

  it('hands the sign-in problems back as retries and sends nothing', async () => {
    rig.fake.route(SIGNIN, { status: 400 });
    assert.deepEqual(await upload(), { kind: 'retry', scope: 'account', afterMs: 5 * MINUTE, code: 'AUTH_INVALID_GRANT' });
    assert.equal(rig.fake.hits(UPLOAD).length, 0);
  });

  it('never writes the password, the token or the file in the log', async () => {
    rig.fake.route(UPLOAD, [answer('0097'), { status: 500, text: 'fattura' }, { text: 'x' }, answer('0000', { uploadFileName: 'bad name' })]);
    for (let times = 0; times < 4; times += 1) {
      await upload();
    }
    assert.doesNotMatch(rig.log.lines.join('\n'), new RegExp(`${TEST_PASSWORD}|access-token|fattura`));
  });
});
