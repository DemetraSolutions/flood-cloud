import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateSchema } from '../../src/validation/schema-validate.ts';
import { change, d, ordinary, rich, richSimplified, simplified } from '../helpers/models.ts';

const BODY = 'FatturaElettronicaBody';
const LINE = `${BODY}.DatiBeniServizi.DettaglioLinee`;

describe('validateSchema: reports', () => {
  it('a valid model has no issue', () => {
    assert.deepEqual(validateSchema(ordinary()), []);
    assert.deepEqual(validateSchema(simplified()), []);
    assert.deepEqual(validateSchema(rich()), []);
    assert.deepEqual(validateSchema(richSimplified()), []);
  });

  it('writes XSD paths with the indexes of lists and the [0] of the body', () => {
    const lines = [...ordinary().FatturaElettronicaBody.DatiBeniServizi.DettaglioLinee];
    const third = { ...lines[0], NumeroLinea: 3, Natura: 'N9' } as (typeof lines)[number];
    const model = change(ordinary(), { [LINE]: [...lines, { ...lines[1] }, third] });
    assert.deepEqual(validateSchema(model).map((found) => [found.code, found.path, found.severity]), [
      ['XSD', 'FatturaElettronicaBody[0].DatiBeniServizi.DettaglioLinee[3].Natura', 'error'],
    ]);
    const blocks = change(simplified(), { [`${BODY}.DatiBeniServizi.1.Descrizione`]: undefined });
    assert.deepEqual(validateSchema(blocks).map((found) => found.path), ['FatturaElettronicaBody[0].DatiBeniServizi[1].Descrizione']);
  });

  it('reports each rule with its own Italian message and never the value', () => {
    const secret = 'SEGRETO-9';
    const cases: ReadonlyArray<readonly [Record<string, unknown>, string]> = [
      [{ [`${BODY}.DatiGenerali.DatiGeneraliDocumento.Divisa`]: `${secret}x` }, 'Valore non conforme al formato richiesto'],
      [{ [`${BODY}.DatiGenerali.DatiGeneraliDocumento.Numero`]: 'x'.repeat(21) }, 'Valore non conforme al formato richiesto'],
      [{ [`${BODY}.DatiGenerali.DatiGeneraliDocumento.TipoDocumento`]: secret }, 'Lunghezza del valore non ammessa'],
      [{ [`${BODY}.DatiGenerali.DatiGeneraliDocumento.TipoDocumento`]: 'TD99' }, 'Valore non compreso tra quelli ammessi'],
      [{ [`${BODY}.DatiGenerali.DatiGeneraliDocumento.Data`]: `${secret}` }, 'Formato del valore non valido'],
      [{ [`${BODY}.DatiGenerali.DatiGeneraliDocumento.Data`]: '1960-01-01' }, 'Valore fuori dall’intervallo ammesso'],
      [{ [`${BODY}.DatiGenerali.DatiGeneraliDocumento.Numero`]: undefined }, 'Elemento obbligatorio mancante o vuoto'],
      [{ [`${BODY}.DatiGenerali.DatiGeneraliDocumento.Numero`]: `a\u0000${secret}` }, 'Carattere non ammesso in un documento XML'],
      [{ 'FatturaElettronicaHeader.CedentePrestatore.DatiAnagrafici.Anagrafica': { Nome: secret } }, 'Servono Denominazione, oppure Nome e Cognome insieme (mai entrambi)'],
    ];
    for (const [set, message] of cases) {
      const issues = validateSchema(change(ordinary(), set));
      assert.ok(issues.some((found) => found.message === message), `${message}: ${JSON.stringify(issues)}`);
      assert.ok(issues.every((found) => !found.message.includes(secret) && !found.path.includes(secret)));
    }
  });

  it('treats an empty text like an absent one: optional is skipped, mandatory is missing', () => {
    assert.deepEqual(validateSchema(change(ordinary(), { 'FatturaElettronicaHeader.CedentePrestatore.Sede.NumeroCivico': '' })), []);
    assert.deepEqual(validateSchema(change(ordinary(), { [`${BODY}.DatiGenerali.DatiGeneraliDocumento.Numero`]: '' })).map((found) => found.path), [
      'FatturaElettronicaBody[0].DatiGenerali.DatiGeneraliDocumento.Numero',
    ]);
  });

  it('checks amounts as they are written: extra decimals are rounded away, too many integer digits are not', () => {
    assert.deepEqual(validateSchema(change(rich(), { [`${BODY}.DatiGenerali.DatiGeneraliDocumento.ImportoTotaleDocumento`]: d('73.2049') })), []);
    assert.equal(validateSchema(change(rich(), { [`${BODY}.DatiGenerali.DatiGeneraliDocumento.ImportoTotaleDocumento`]: d('123456789012.00') })).length, 1);
  });

  it('requires at least one element in the lists that need one, and a payment detail in every payment', () => {
    assert.deepEqual(validateSchema(change(ordinary(), { [`${BODY}.DatiBeniServizi.DatiRiepilogo`]: [] })).map((found) => found.path), ['FatturaElettronicaBody[0].DatiBeniServizi.DatiRiepilogo']);
    assert.deepEqual(validateSchema(change(simplified(), { [`${BODY}.DatiBeniServizi`]: [] })).map((found) => found.path), ['FatturaElettronicaBody[0].DatiBeniServizi']);
  });

  it('a mandatory block with no content is missing even if the model holds an empty object', () => {
    const issues = validateSchema(change(simplified(), { [`${BODY}.DatiBeniServizi.0.DatiIVA`]: {} }));
    assert.deepEqual(issues.map((found) => found.path), ['FatturaElettronicaBody[0].DatiBeniServizi[0].DatiIVA']);
  });
});
