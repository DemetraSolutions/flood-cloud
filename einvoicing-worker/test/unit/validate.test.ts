import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkFileSize, MAX_FILE_BYTES, validateInvoice } from '../../src/validation/validate.ts';
import { change, d, mapped, ordinary, simplified } from '../helpers/models.ts';
import { fixtures } from '../fixtures/records.ts';

const CONTEXT = { sendDate: '2026-11-27' };
const DOC = 'FatturaElettronicaBody.DatiGenerali.DatiGeneraliDocumento';

describe('validateInvoice', () => {
  for (const name of Object.keys(fixtures)) {
    it(`fixture "${name}": no error (and the mapping warnings come back as TEXT warnings only)`, () => {
      const { model, warnings } = mapped(name);
      const result = validateInvoice(model, { ...CONTEXT, mappingWarnings: warnings });
      assert.deepEqual(result.errors, []);
      assert.deepEqual(result.warnings.map((found) => found.code), warnings.map(() => 'TEXT'));
    });
  }

  it('collects the schema, SdI and fiscal identifier problems and splits errors from warnings', () => {
    const bad = change(ordinary(), {
      [`${DOC}.Divisa`]: 'euro',
      [`${DOC}.Data`]: '2026-12-01',
      'FatturaElettronicaHeader.CedentePrestatore.DatiAnagrafici.IdFiscaleIVA.IdCodice': '01234567890',
      [`${DOC}.ImportoTotaleDocumento`]: d('1.00'),
    });
    const result = validateInvoice(bad, CONTEXT);
    assert.deepEqual(result.errors.map((found) => found.code).sort(), ['00403', 'FISCAL_ID', 'XSD']);
    assert.deepEqual(result.warnings.map((found) => found.code), ['TOTAL']);
    assert.ok(result.errors.every((found) => found.severity === 'error'));
    assert.ok(result.warnings.every((found) => found.severity === 'warning'));
  });

  it('orders the issues by path, then code, deterministically', () => {
    const bad = change(ordinary(), { [`${DOC}.Divisa`]: 'euro', [`${DOC}.Numero`]: 'A', [`${DOC}.Data`]: '2026-12-01' });
    const first = validateInvoice(bad, CONTEXT);
    const second = validateInvoice(structuredClone(bad), CONTEXT);
    assert.deepEqual(first, second);
    const paths = first.errors.map((found) => found.path);
    assert.deepEqual(paths, [...paths].sort());
  });

  it('turns the mapping warnings into TEXT warnings that never carry the text', () => {
    const result = validateInvoice(ordinary(), {
      ...CONTEXT,
      mappingWarnings: [
        { path: 'FatturaElettronicaBody.DatiBeniServizi.DettaglioLinee.0.Descrizione', warning: 'unrepresentable' },
        { path: 'FatturaElettronicaBody.DatiGenerali.DatiGeneraliDocumento.Causale', warning: 'truncated' },
      ],
    });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings.map((found) => [found.code, found.path, found.message]), [
      ['TEXT', 'FatturaElettronicaBody.DatiBeniServizi.DettaglioLinee.0.Descrizione', 'Il testo conteneva caratteri non rappresentabili, sostituiti con ?'],
      ['TEXT', 'FatturaElettronicaBody.DatiGenerali.DatiGeneraliDocumento.Causale', 'Il testo è stato troncato al limite di lunghezza del campo'],
    ]);
  });

  it('validates a simplified invoice with the same entry point', () => {
    assert.deepEqual(validateInvoice(simplified(), CONTEXT), { errors: [], warnings: [] });
    const result = validateInvoice(change(simplified(), { 'FatturaElettronicaHeader.DatiTrasmissione.CodiceDestinatario': 'ABCDEF' }), CONTEXT);
    assert.deepEqual(result.errors.map((found) => found.code), ['00427', 'XSD']);
  });
});

describe('checkFileSize', () => {
  it('accepts a file up to 5 000 000 bytes and rejects one byte more', () => {
    assert.equal(MAX_FILE_BYTES, 5_000_000);
    assert.equal(checkFileSize('a'.repeat(5_000_000)), undefined);
    assert.deepEqual(checkFileSize('a'.repeat(5_000_001)), { code: 'SIZE', path: 'file', severity: 'error', message: 'Il file supera la dimensione massima di 5 MB' });
  });

  it('counts UTF-8 bytes, not characters', () => {
    assert.equal(checkFileSize('è'.repeat(2_500_001))?.code, 'SIZE');
    assert.equal(checkFileSize('è'.repeat(2_500_000)), undefined);
    assert.equal(checkFileSize('😀'.repeat(1_250_001))?.code, 'SIZE');
  });
});
