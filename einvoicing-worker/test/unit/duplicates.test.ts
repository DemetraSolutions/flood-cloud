import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkDuplicate, duplicateKeyOf } from '../../src/validation/duplicates.ts';
import { change, ordinary, simplified } from '../helpers/models.ts';

const DOC = 'FatturaElettronicaBody.DatiGenerali.DatiGeneraliDocumento';
const SELLER = 'FatturaElettronicaHeader.CedentePrestatore.DatiAnagrafici.IdFiscaleIVA';

describe('duplicateKeyOf (Elenco dei controlli, pages 12 to 14)', () => {
  it('is made of the seller, the number, the year and the credit-note class', () => {
    assert.equal(duplicateKeyOf(ordinary()), JSON.stringify(['IT01234567897', '42', '2026', 'other']));
  });

  it('is the same for two invoices of the same seller, number and year, whatever the day', () => {
    assert.equal(duplicateKeyOf(change(ordinary(), { [`${DOC}.Data`]: '2026-01-02' })), duplicateKeyOf(ordinary()));
  });

  it('differs by seller, number or year', () => {
    const base = duplicateKeyOf(ordinary());
    assert.notEqual(duplicateKeyOf(change(ordinary(), { [`${SELLER}.IdCodice`]: '09876543217' })), base);
    assert.notEqual(duplicateKeyOf(change(ordinary(), { [`${SELLER}.IdPaese`]: 'DE' })), base);
    assert.notEqual(duplicateKeyOf(change(ordinary(), { [`${DOC}.Numero`]: '43' })), base);
    assert.notEqual(duplicateKeyOf(change(ordinary(), { [`${DOC}.Data`]: '2025-11-27' })), base);
  });

  it('keeps credit notes apart from every other type, and treats all other types alike', () => {
    const type = (value: string) => duplicateKeyOf(change(ordinary(), { [`${DOC}.TipoDocumento`]: value }));
    assert.notEqual(type('TD04'), type('TD01'));
    assert.equal(type('TD01'), type('TD02'));
    assert.equal(type('TD04'), type('TD04'));
  });

  it('uses the full date when Art73 is SI, and the buyer when the invoice is issued by the buyer', () => {
    const full = duplicateKeyOf(ordinary(), { art73: true });
    assert.equal(full, JSON.stringify(['IT01234567897', '42', '2026-11-27', 'other']));
    assert.notEqual(duplicateKeyOf(change(ordinary(), { [`${DOC}.Data`]: '2026-11-28' }), { art73: true }), full);
    const company = ordinary('company-buyer');
    assert.equal(duplicateKeyOf(company, { issuedByBuyer: true }), JSON.stringify(['IT09876543217', 'A/42', '2026', 'other']));
    assert.equal(duplicateKeyOf(ordinary(), { issuedByBuyer: true }), JSON.stringify(['', '42', '2026', 'other']), 'a buyer with only a fiscal code has no VAT identifier');
  });

  it('works on the simplified format too', () => {
    assert.equal(duplicateKeyOf(simplified()), JSON.stringify(['IT01234567897', '42', '2026', 'other']));
    assert.equal(duplicateKeyOf(simplified(), { issuedByBuyer: true }), JSON.stringify(['IT09876543217', '42', '2026', 'other']));
  });
});

describe('checkDuplicate', () => {
  it('asks the lookup with the key and reports 00404 for a duplicate', async () => {
    const keys: string[] = [];
    const found = await checkDuplicate(ordinary(), async (key) => {
      keys.push(key);
      return 'duplicate';
    });
    assert.deepEqual(keys, [duplicateKeyOf(ordinary())]);
    assert.deepEqual(found, {
      code: '00404',
      path: 'FatturaElettronicaBody[0].DatiGenerali.DatiGeneraliDocumento.Numero',
      severity: 'error',
      message: 'Fattura già trasmessa (stesso emittente, numero e anno)',
    });
  });

  it('returns nothing for a new invoice and passes the options on', async () => {
    const keys: string[] = [];
    assert.equal(await checkDuplicate(ordinary(), async (key) => (keys.push(key), 'unique'), { art73: true }), undefined);
    assert.deepEqual(keys, [duplicateKeyOf(ordinary(), { art73: true })]);
  });

  it('does not swallow a failure of the lookup', async () => {
    await assert.rejects(checkDuplicate(ordinary(), async () => Promise.reject(new Error('history unavailable'))), /history unavailable/);
  });
});
