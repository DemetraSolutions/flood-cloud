import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { StatusOutcome } from '../../src/providers/types.ts';
import { createArubaRig, live, TEST_PASSWORD } from '../helpers/aruba.ts';
import type { ArubaRig } from '../helpers/aruba.ts';
import type { Reply } from '../helpers/fake-aruba.ts';
import { T0 } from '../helpers/world.ts';

const DETAIL = 'GET /api/v2/invoices-out/detail';
const NOTIFICATIONS = 'GET /api/v2/invoices-out/notifications';
const SIGNIN = 'POST /auth/signin';
const FILE = 'IT01234567890_abcde.xml';
const MINUTE = 60_000;

const detail = (status: string, extra: Record<string, unknown> = {}): Reply => ({ json: { filename: FILE, idSdi: '123', invoices: [{ status, statusDescription: '' }], sdiErrors: [], ...extra } });
const b64 = (xml: string): string => Buffer.from(xml, 'utf8').toString('base64');
const ns = (code: string, description: string): string => `<NotificaScarto><ListaErrori><Errore><Codice>${code}</Codice><Descrizione>${description}</Descrizione></Errore></ListaErrori></NotificaScarto>`;

describe('Aruba: status', () => {
  let rig: ArubaRig;
  const status = (providerId = FILE): Promise<StatusOutcome> => rig.adapter.status(rig.account, providerId, live());

  beforeEach(async () => {
    rig = await createArubaRig({ deps: { timeouts: { upload: 300, request: 300 } } });
  });
  afterEach(async () => {
    await rig.close();
  });

  it('asks for the detail of the file by its encoded name, without the file, with the token', async () => {
    rig.fake.route(DETAIL, detail('Consegnata'));
    assert.deepEqual(await status(), { kind: 'status', status: 'delivered' });
    const [hit] = rig.fake.hits(DETAIL);
    assert.equal(hit?.rawQuery, `filename=${FILE}&includeFile=false`);
    assert.equal(hit?.headers['authorization'], 'Bearer access-token-1');
  });

  it('translates every state, in any case and spacing', async () => {
    const table: Array<[string, string]> = [
      ['Presa in carico', 'takingCharge'],
      ['Inviata', 'sent'],
      ['Scartata', 'rejected'],
      ['Non consegnata', 'notDelivered'],
      ['Recapito impossibile', 'deliveryImpossible'],
      ['Consegnata', 'delivered'],
      ['Accettata', 'accepted'],
      ['Rifiutata', 'refused'],
      ['Decorrenza termini', 'effectiveDate'],
      ['Errore elaborazione', 'processingError'],
      ['  CONSEGNATA ', 'delivered'],
      ['recapito   IMPOSSIBILE', 'deliveryImpossible'],
    ];
    rig.fake.route(NOTIFICATIONS, { json: { notifications: [] } });
    for (const [text, normalized] of table) {
      rig.fake.route(DETAIL, detail(text));
      const outcome = await status();
      assert.equal(outcome.kind === 'status' ? outcome.status : outcome.kind, normalized, text);
      rig.clock.advance(10_000);
    }
  });

  it('treats an unknown state (Ricevuta, a new one, none) as sent and logs each once', async () => {
    for (const text of ['Ricevuta', 'Ricevuta', 'Boh', '', 'Ricevuta']) {
      rig.fake.route(DETAIL, { json: { invoices: [text === '' ? {} : { status: text }] } });
      assert.deepEqual(await status(), { kind: 'status', status: 'sent' });
    }
    assert.equal(rig.log.messages('warn').length, 3, 'ricevuta, boh and the empty one');
    assert.deepEqual(
      rig.log.entries().filter((entry) => entry['level'] === 'warn').map((entry) => entry['state']),
      ['ricevuta', 'boh', ''],
    );
  });

  it('remembers only a bounded number of unknown states', async () => {
    for (let index = 0; index < 60; index += 1) {
      rig.fake.route(DETAIL, { json: { invoices: [{ status: `nuovo ${index}` }] } });
      await status();
    }
    assert.equal(rig.log.messages('warn').length, 50);
  });

  describe('a rejection', () => {
    it('takes the reasons from the sdiErrors of the detail when they are well-formed (no notification asked)', async () => {
      rig.fake.route(DETAIL, detail('Scartata', { sdiErrors: [{ code: '00404', description: 'Fattura duplicata' }] }));
      assert.deepEqual(await status(), { kind: 'status', status: 'rejected', sdiErrors: [{ code: '00404', description: 'Fattura duplicata' }] });
      assert.equal(rig.fake.hits(NOTIFICATIONS).length, 0);
    });

    it('otherwise reads the NS notification: base64 XML, the first NS only, entities decoded', async () => {
      rig.fake.route(DETAIL, detail('Scartata', { sdiErrors: [{ unexpected: true }, 'text'] }));
      rig.fake.route(NOTIFICATIONS, { json: { notifications: [{ docType: 'RC', file: b64(ns('1', 'no')) }, { docType: 'ns', file: b64(ns('00400', 'Natura &amp; coerenza')) }, { docType: 'NS', file: b64(ns('2', 'second')) }] } });
      assert.deepEqual(await status(), { kind: 'status', status: 'rejected', sdiErrors: [{ code: '00400', description: 'Natura & coerenza' }] });
      assert.equal(rig.fake.hits(NOTIFICATIONS)[0]?.rawQuery, `filename=${FILE}`);
    });

    it('spaces the notification downloads by their own limiter (6 s plus jitter), apart from the status limiter', async () => {
      rig.fake.route(DETAIL, detail('Scartata'));
      rig.fake.route(NOTIFICATIONS, { json: { notifications: [{ docType: 'NS', file: b64(ns('1', 'a')) }] } });
      await status();
      assert.equal(rig.limiters.gate('ip:aruba:notifications', { minIntervalMs: 6000, jitterMs: 1500, maxPerHour: null, maxPerYear: null }, rig.clock.now()).at - rig.clock.now(), 6000);
      assert.equal(rig.limiters.gate('ip:aruba:status', { minIntervalMs: 0, jitterMs: 0, maxPerHour: null, maxPerYear: null }, rig.clock.now()).at, rig.clock.now(), 'the status limiter is the engine\'s');
      const before = rig.clock.waits.length;
      await status();
      assert.deepEqual(rig.clock.waits.slice(before), [6000]);
    });

    it('asks the account to come back when the notifications limiter is busy for long, and when Aruba limits or refuses the token', async () => {
      rig.fake.route(DETAIL, detail('Scartata'));
      await rig.limiters.coolDown('ip:aruba:notifications', T0 + 5 * MINUTE);
      assert.deepEqual(await status(), { kind: 'retry', scope: 'account', afterMs: 5 * MINUTE, code: 'NOTIFICATIONS_LIMITED' });
      rig.clock.advance(6 * MINUTE);
      rig.fake.route(NOTIFICATIONS, { status: 429 });
      assert.deepEqual(await status(), { kind: 'retry', scope: 'account', afterMs: 65_000, code: 'HTTP_429' });
      assert.ok(rig.limiters.gate('ip:aruba:notifications', { minIntervalMs: 0, jitterMs: 0, maxPerHour: null, maxPerYear: null }, rig.clock.now()).at >= rig.clock.now() + 64_000);
    });

    it('gives up the wait for the notifications when the signal fires', async () => {
      rig.fake.route(DETAIL, detail('Scartata'));
      await rig.limiters.consume('ip:aruba:notifications', { minIntervalMs: 6000, jitterMs: 0, maxPerHour: null, maxPerYear: null }, rig.clock.now());
      const outcome = await rig.adapter.status(rig.account, FILE, AbortSignal.abort());
      assert.equal(outcome.kind, 'retry');
    });

    it('hands a sign-in or token problem of the notification call back as a retry', async () => {
      rig.fake.route(DETAIL, detail('Scartata'));
      rig.fake.route(NOTIFICATIONS, { status: 401 });
      assert.deepEqual(await status(), { kind: 'retry', scope: 'account', afterMs: MINUTE, code: 'HTTP_401' });
    });

    it('still reports the rejection, without reasons, when the notification cannot be read', async () => {
      rig.fake.route(DETAIL, detail('Scartata'));
      const unreadable: Reply[] = [
        { status: 500 },
        { text: 'not json' },
        { json: { notifications: 'x' } },
        { json: { notifications: [{ docType: 'RC', file: 'x' }, 'text', { docType: 'NS' }, { docType: 'NS', file: 7 }] } },
        { json: { notifications: [{ docType: 'NS', file: 'A'.repeat(1_400_000) }] } },
        { destroy: true },
      ];
      for (const reply of unreadable) {
        rig.fake.route(NOTIFICATIONS, reply);
        rig.clock.advance(10_000);
        assert.deepEqual(await status(), { kind: 'status', status: 'rejected', sdiErrors: [] }, JSON.stringify(reply).slice(0, 60));
      }
      assert.equal(rig.log.messages('warn').length, unreadable.length);
    });

    it('a notification that lists nothing gives no reasons', async () => {
      rig.fake.route(DETAIL, detail('Scartata'));
      rig.fake.route(NOTIFICATIONS, { json: { notifications: [{ docType: 'NS', file: b64('<NotificaScarto/>') }] } });
      assert.deepEqual(await status(), { kind: 'status', status: 'rejected', sdiErrors: [] });
    });
  });

  describe('a processing error', () => {
    it('takes the FATRSM code and the quoted SdI codes from the status description', async () => {
      rig.fake.route(DETAIL, { json: { invoices: [{ status: 'Errore elaborazione', statusDescription: 'FATRSM212 - Errore: 00400 - Natura non coerente' }] } });
      assert.deepEqual(await status(), {
        kind: 'status',
        status: 'processingError',
        sdiErrors: [
          { code: 'FATRSM212', description: 'FATRSM212 - Errore: 00400 - Natura non coerente' },
          { code: '00400', description: 'Natura non coerente' },
        ],
      });
    });

    it('keeps the description when it has no code, and no reasons when it has no description', async () => {
      rig.fake.route(DETAIL, { json: { invoices: [{ status: 'Errore elaborazione', statusDescription: 'Errore generico' }] } });
      assert.deepEqual(await status(), { kind: 'status', status: 'processingError', sdiErrors: [{ code: 'ARUBA', description: 'Errore generico' }] });
      rig.fake.route(DETAIL, { json: { invoices: [{ status: 'Errore elaborazione' }] } });
      assert.deepEqual(await status(), { kind: 'status', status: 'processingError', sdiErrors: [] });
    });
  });

  describe('what is not an answer about the file', () => {
    it('404, an empty body, no invoice and a non-object invoice are "the provider does not know the file"', async () => {
      rig.fake.route(DETAIL, { status: 404, text: 'Not found' });
      assert.deepEqual(await status(), { kind: 'notFound' });
      for (const reply of [{ text: '' }, { text: '  \n' }, { json: {} }, { json: { invoices: [] } }, { json: { invoices: ['x'] } }, { json: { invoices: 'x' } }]) {
        rig.fake.route(DETAIL, reply);
        assert.deepEqual(await status(), { kind: 'notFound' }, JSON.stringify(reply));
      }
    });

    it('429 asks the whole IP to wait; 5xx and a network failure too; malformed answers likewise', async () => {
      rig.fake.route(DETAIL, { status: 429 });
      assert.deepEqual(await status(), { kind: 'retry', scope: 'ip', afterMs: 65_000, code: 'HTTP_429' });
      rig.fake.route(DETAIL, { status: 503 });
      assert.deepEqual(await status(), { kind: 'retry', scope: 'ip', afterMs: 60_000, code: 'HTTP_503' });
      rig.fake.route(DETAIL, { destroy: true });
      assert.deepEqual(await status(), { kind: 'retry', scope: 'ip', afterMs: 60_000, code: 'NETWORK_NETWORK' });
      rig.fake.route(DETAIL, { hang: true });
      assert.deepEqual(await status(), { kind: 'retry', scope: 'ip', afterMs: 60_000, code: 'NETWORK_TIMEOUT' });
      for (const reply of [{ text: '<html>' }, { json: ['x'] }, { json: 5 }]) {
        rig.fake.route(DETAIL, reply);
        assert.deepEqual(await status(), { kind: 'retry', scope: 'ip', afterMs: 60_000, code: 'MALFORMED' });
      }
    });

    it('another client error is a retry of this account in ten minutes', async () => {
      rig.fake.route(DETAIL, { status: 403 });
      assert.deepEqual(await status(), { kind: 'retry', scope: 'account', afterMs: 10 * MINUTE, code: 'HTTP_403' });
    });

    it('401 drops the token and asks the account to wait a minute; the next call signs in again', async () => {
      rig.fake.route(DETAIL, [{ status: 401 }, detail('Inviata')]);
      assert.deepEqual(await status(), { kind: 'retry', scope: 'account', afterMs: MINUTE, code: 'HTTP_401' });
      rig.clock.advance(70_000);
      assert.deepEqual(await status(), { kind: 'status', status: 'sent' });
      assert.equal(rig.fake.hits(SIGNIN).length, 2);
    });

    it('a sign-in refusal is handed back as is', async () => {
      rig.fake.route(SIGNIN, { status: 400 });
      assert.deepEqual(await status(), { kind: 'retry', scope: 'account', afterMs: 5 * MINUTE, code: 'AUTH_INVALID_GRANT' });
    });
  });

  it('never puts an unsafe stored file name in a URL: it asks nothing and says the file is unknown', async () => {
    for (const unsafe of ['', 'a b', '../x', 'a?includeFile=true', 'a&b', 'a/b', 'x'.repeat(101), '%2e%2e', 'é']) {
      assert.deepEqual(await status(unsafe), { kind: 'notFound' }, unsafe);
    }
    assert.equal(rig.fake.requests.length, 0);
    assert.equal(rig.log.messages('warn').length, 9);
  });

  it('never writes a token, the password or a response body in the log', async () => {
    rig.fake.route(DETAIL, [{ status: 500, text: 'body-with-details' }, { json: { invoices: [{ status: 'Mai vista', statusDescription: 'dettaglio-segreto' }] } }]);
    await status();
    await status();
    assert.doesNotMatch(rig.log.lines.join('\n'), new RegExp(`${TEST_PASSWORD}|access-token|body-with-details|dettaglio-segreto`));
  });
});
