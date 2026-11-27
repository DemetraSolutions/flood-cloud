import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { errorsFromDescription, errorsFromDetail, errorsFromNotification, MAX_SDI_ERRORS } from '../../src/providers/aruba/errors.ts';

const b64 = (xml: string): string => Buffer.from(xml, 'utf8').toString('base64');
const notification = (errors: string): string => `<?xml version="1.0"?><types:NotificaScarto xmlns:types="x"><IdentificativoSdI>1</IdentificativoSdI><ListaErrori>${errors}</ListaErrori></types:NotificaScarto>`;

describe('Aruba: the reasons of a rejection', () => {
  describe('from the status detail', () => {
    it('keeps the well-formed items, with the two usual spellings of the fields', () => {
      assert.deepEqual(
        errorsFromDetail([
          { code: '00404', description: 'Fattura duplicata' },
          { errorCode: 417, errorDescription: 'Identificativo errato' },
          { code: '00001' },
        ]),
        [
          { code: '00404', description: 'Fattura duplicata' },
          { code: '417', description: 'Identificativo errato' },
          { code: '00001', description: '' },
        ],
      );
    });

    it('drops what is not an object with a code, and anything that is not a list', () => {
      assert.deepEqual(errorsFromDetail(['text', null, 5, { description: 'no code' }, { code: '' }, [], { code: { nested: true } }]), []);
      for (const value of [undefined, null, 'x', 7, {}, { code: '1' }]) {
        assert.deepEqual(errorsFromDetail(value), []);
      }
    });

    it('cleans the text and keeps at most twenty', () => {
      const long = Array.from({ length: 30 }, (_, index) => ({ code: `0${index}`, description: 'a\u0000b\u001fc' }));
      const errors = errorsFromDetail(long);
      assert.equal(errors.length, MAX_SDI_ERRORS);
      assert.equal(errors[0]?.description, 'a b c');
      assert.equal(errorsFromDetail([{ code: 'c'.repeat(80), description: 'd'.repeat(2000) }])[0]?.code.length, 50);
      assert.equal(errorsFromDetail([{ code: 'c', description: 'd'.repeat(2000) }])[0]?.description.length, 1000);
    });
  });

  describe('from the description of a processing error', () => {
    it('takes the FATRSM code and the SdI codes it quotes', () => {
      assert.deepEqual(errorsFromDescription('FATRSM212 - Errore di validazione: 00400 - Natura non coerente; 00471: Altro dato'), [
        { code: 'FATRSM212', description: 'FATRSM212 - Errore di validazione: 00400 - Natura non coerente; 00471: Altro dato' },
        { code: '00400', description: 'Natura non coerente' },
        { code: '00471', description: 'Altro dato' },
      ]);
    });

    it('keeps the whole description under the code ARUBA when it has no code, and nothing when there is none', () => {
      assert.deepEqual(errorsFromDescription('Si e\u0000verificato un errore'), [{ code: 'ARUBA', description: 'Si e verificato un errore' }]);
      assert.deepEqual(errorsFromDescription('FATRSM001'), [{ code: 'FATRSM001', description: 'FATRSM001' }]);
      for (const value of [undefined, null, '', '   ', {}]) {
        assert.deepEqual(errorsFromDescription(value), []);
      }
    });

    it('keeps at most twenty reasons', () => {
      const text = Array.from({ length: 60 }, (_, index) => `${String(10_000 + index)} - e`).join(' ; ');
      assert.equal(errorsFromDescription(text).length, MAX_SDI_ERRORS);
    });
  });

  describe('from the SdI discard notification', () => {
    it('reads Codice and Descrizione of every Errore of the list', () => {
      const xml = notification('<Errore><Codice>00404</Codice><Descrizione>Fattura duplicata</Descrizione></Errore><Errore><Codice>00305</Codice><Descrizione>IdPaese non valido</Descrizione></Errore>');
      assert.deepEqual(errorsFromNotification(b64(xml)), [
        { code: '00404', description: 'Fattura duplicata' },
        { code: '00305', description: 'IdPaese non valido' },
      ]);
    });

    it('decodes the entities once, numeric ones included, and drops control characters', () => {
      const xml = notification('<Errore><Codice>00&#52;00</Codice><Descrizione>&lt;Natura&gt; &amp;lt; &quot;x&quot; &apos;y&apos; &#x41;&#66; &#1114112; &#xD800;&#0;z</Descrizione></Errore>');
      assert.deepEqual(errorsFromNotification(b64(xml)), [{ code: '00400', description: '<Natura> &lt; "x" \'y\' AB   z' }]);
    });

    it('skips an Errore with no code, takes a missing description as empty and ignores what is outside the list', () => {
      const xml = `<Errore><Codice>99999</Codice></Errore>${notification('<Errore><Descrizione>no code</Descrizione></Errore><Errore><Codice>00001</Codice></Errore>')}`;
      assert.deepEqual(errorsFromNotification(b64(xml)), [{ code: '00001', description: '' }]);
    });

    it('gives nothing for a file without a list, with an unclosed tag, or that is not XML at all', () => {
      assert.deepEqual(errorsFromNotification(b64('<NotificaScarto></NotificaScarto>')), []);
      assert.deepEqual(errorsFromNotification(b64('<ListaErrori><Errore><Codice>1</Codice>')), []);
      assert.deepEqual(errorsFromNotification(b64(notification('<Errore><Codice>1</Codice>'))), []);
      assert.deepEqual(errorsFromNotification(b64('not xml at all')), []);
      assert.deepEqual(errorsFromNotification(''), []);
    });

    it('stops at twenty errors', () => {
      const many = Array.from({ length: 40 }, (_, index) => `<Errore><Codice>${index}</Codice><Descrizione>d</Descrizione></Errore>`).join('');
      assert.equal(errorsFromNotification(b64(notification(many)))?.length, MAX_SDI_ERRORS);
    });

    it('refuses a file larger than one mebibyte, and takes one of exactly that size', () => {
      assert.equal(errorsFromNotification('A'.repeat(1_398_109)), undefined);
      const padding = ' '.repeat(1024 * 1024 - 400);
      const xml = `${notification('<Errore><Codice>1</Codice><Descrizione>d</Descrizione></Errore>')}${padding}`;
      assert.deepEqual(errorsFromNotification(b64(xml)), [{ code: '1', description: 'd' }]);
    });

    it('is not slowed down by many unclosed tags', () => {
      const started = Date.now();
      errorsFromNotification(b64(`<ListaErrori>${'<Errore><Codice>'.repeat(50_000)}</ListaErrori>`));
      assert.ok(Date.now() - started < 2000);
    });
  });
});
