import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DatiRiepilogo, DettaglioLinee, InvoiceModel } from '../../src/invoice/model.ts';
import { checkSdi } from '../../src/validation/sdi-checks.ts';
import type { ValidationIssue } from '../../src/validation/issue.ts';
import { change, d, ordinary, simplified } from '../helpers/models.ts';
import { reportedPath } from '../helpers/mutations.ts';

const CONTEXT = { sendDate: '2026-11-27' };
const BODY = 'FatturaElettronicaBody';
const DOC = `${BODY}.DatiGenerali.DatiGeneraliDocumento`;
const GOODS = `${BODY}.DatiBeniServizi`;
const HEADER = 'FatturaElettronicaHeader';
const T = `${HEADER}.DatiTrasmissione`;

function issuesOf(model: InvoiceModel, code: string): ValidationIssue[] {
  return checkSdi(model, CONTEXT).filter((found) => found.code === code);
}

/** Asserts that the check fires (once, at `path`) on `bad` and is silent on `good`. */
function expectCheck(code: string, path: string, bad: InvoiceModel, good: InvoiceModel, severity: 'error' | 'warning' = 'error'): void {
  const found = issuesOf(bad, code);
  assert.deepEqual(found.map((issue) => issue.path), [reportedPath(path)], `${code} on the bad model`);
  assert.equal(found[0]?.severity, severity);
  assert.deepEqual(issuesOf(good, code), [], `${code} on the good model`);
}

function line(values: Partial<DettaglioLinee> = {}): DettaglioLinee {
  return { NumeroLinea: 1, Descrizione: 'Prodotto', PrezzoUnitario: d('100.00'), PrezzoTotale: d('100.00'), AliquotaIVA: d('22.00'), ...values };
}

function summary(values: Partial<DatiRiepilogo> = {}): DatiRiepilogo {
  return { AliquotaIVA: d('22.00'), ImponibileImporto: d('100.00'), Imposta: d('22.00'), ...values };
}

/** The base ordinary invoice with its lines and summaries replaced, and no document total (so no TOTAL warning). */
function withGoods(lines: readonly DettaglioLinee[], summaries: readonly DatiRiepilogo[], extra: Record<string, unknown> = {}) {
  return change(ordinary(), {
    [`${GOODS}.DettaglioLinee`]: lines,
    [`${GOODS}.DatiRiepilogo`]: summaries,
    [`${DOC}.ImportoTotaleDocumento`]: undefined,
    ...extra,
  });
}

function simplifiedGoods(blocks: unknown, extra: Record<string, unknown> = {}) {
  return change(simplified(), { [`${BODY}.DatiBeniServizi`]: blocks, ...extra });
}

describe('transmission checks', () => {
  const pa = ordinary('public-administration-split-payment');

  it('00427: the recipient code length must fit the format (6 for FPA12, 7 for the others)', () => {
    assert.equal(pa.FatturaElettronicaHeader.DatiTrasmissione.CodiceDestinatario.length, 6);
    expectCheck('00427', `${T}.CodiceDestinatario`, change(pa, { [`${T}.CodiceDestinatario`]: 'UF12345' }), pa);
    expectCheck('00427', `${T}.CodiceDestinatario`, change(ordinary(), { [`${T}.CodiceDestinatario`]: 'ABCDEF' }), ordinary());
    assert.deepEqual(issuesOf(change(ordinary(), { [`${T}.CodiceDestinatario`]: '0000000' }), '00427'), []);
    expectCheck('00427', `${T}.CodiceDestinatario`, change(simplified(), { [`${T}.CodiceDestinatario`]: 'ABCDEF' }), simplified());
  });

  it('00428: the transmission format must equal the versione attribute', () => {
    expectCheck('00428', `${T}.FormatoTrasmissione`, change(ordinary(), { versione: 'FPA12' }), ordinary());
    expectCheck('00428', `${T}.FormatoTrasmissione`, change(ordinary(), { [`${T}.FormatoTrasmissione`]: 'FPA12' }), ordinary());
  });

  it('00313: XXXXXXX only towards a buyer with a foreign VAT identifier', () => {
    const foreign = ordinary('foreign-buyer');
    assert.equal(foreign.FatturaElettronicaHeader.DatiTrasmissione.CodiceDestinatario, 'XXXXXXX');
    expectCheck('00313', `${T}.CodiceDestinatario`, change(foreign, { [`${HEADER}.CessionarioCommittente.DatiAnagrafici.IdFiscaleIVA.IdPaese`]: 'IT' }), foreign);
    expectCheck('00313', `${T}.CodiceDestinatario`, change(foreign, { [`${HEADER}.CessionarioCommittente.DatiAnagrafici.IdFiscaleIVA`]: undefined }), foreign);
    assert.deepEqual(issuesOf(ordinary(), '00313'), []);
  });

  it('00330: the PEC is only for code 0000000, never a SdI mailbox, never for the public administration', () => {
    const pec = `${T}.PECDestinatario`;
    const withPec = change(ordinary(), { [`${T}.CodiceDestinatario`]: '0000000', [pec]: 'mario@pec.example.it' });
    assert.deepEqual(issuesOf(withPec, '00330'), []);
    assert.deepEqual(issuesOf(ordinary('private-pec'), '00330'), []);
    expectCheck('00330', pec, change(withPec, { [pec]: 'SDI01@pec.fatturapa.it' }), withPec);
    expectCheck('00330', pec, change(withPec, { [pec]: 'sdi@pec.fatturapa.it' }), withPec);
    assert.deepEqual(issuesOf(change(withPec, { [pec]: 'sdi01@pec.fatturapa.it.example.it' }), '00330'), []);
    expectCheck('00330', pec, change(withPec, { [`${T}.CodiceDestinatario`]: 'ABCDEFG' }), withPec);
    const publicBody = change(pa, { [pec]: 'ufficio@pec.example.it' });
    assert.equal(issuesOf(publicBody, '00330').length, 2, 'both the code and the format rule fire');
  });
});

describe('document checks', () => {
  it('00403: the document date cannot be after the sending day', () => {
    expectCheck('00403', `${DOC}.Data`, change(ordinary(), { [`${DOC}.Data`]: '2026-11-28' }), ordinary());
    assert.deepEqual(issuesOf(change(ordinary(), { [`${DOC}.Data`]: '2026-11-27' }), '00403'), []);
    assert.deepEqual(issuesOf(change(ordinary(), { [`${DOC}.Data`]: '2020-01-01' }), '00403'), []);
    expectCheck('00403', `${DOC}.Data`, change(simplified(), { [`${DOC}.Data`]: '2027-01-01' }), simplified());
  });

  it('00417: the buyer needs a VAT number or a fiscal code', () => {
    const buyer = `${HEADER}.CessionarioCommittente.DatiAnagrafici`;
    expectCheck('00417', buyer, change(ordinary(), { [`${buyer}.CodiceFiscale`]: undefined }), ordinary());
    expectCheck('00417', buyer, change(ordinary('company-buyer'), { [`${buyer}.CodiceFiscale`]: undefined, [`${buyer}.IdFiscaleIVA`]: undefined }), ordinary('company-buyer'));
    const simple = `${HEADER}.CessionarioCommittente.IdentificativiFiscali`;
    expectCheck('00417', simple, change(simplified(), { [simple]: { IdFiscaleIVA: undefined } }), simplified());
  });

  it('00425: the number needs at least one digit', () => {
    expectCheck('00425', `${DOC}.Numero`, change(ordinary(), { [`${DOC}.Numero`]: 'ABC' }), ordinary());
    assert.deepEqual(issuesOf(change(ordinary(), { [`${DOC}.Numero`]: 'A/9' }), '00425'), []);
    expectCheck('00425', `${DOC}.Numero`, change(simplified(), { [`${DOC}.Numero`]: '-' }), simplified());
  });

  const seller = `${HEADER}.CedentePrestatore.DatiAnagrafici`;
  const buyer = `${HEADER}.CessionarioCommittente.DatiAnagrafici`;
  const sameParty = { [`${buyer}.IdFiscaleIVA`]: { IdPaese: 'IT', IdCodice: '01234567897' } };

  it('00471: no self invoice between the same VAT identifiers (TD16 to TD20, TD29); a fiscal-code-only buyer is left to the SdI', () => {
    for (const type of ['TD16', 'TD17', 'TD18', 'TD19', 'TD20', 'TD29']) {
      const bad = change(ordinary(), { [`${DOC}.TipoDocumento`]: type, ...sameParty });
      expectCheck('00471', `${seller}.IdFiscaleIVA`, bad, change(bad, { [`${buyer}.IdFiscaleIVA.IdCodice`]: '09876543217' }));
    }
    assert.deepEqual(issuesOf(change(ordinary(), { [`${DOC}.TipoDocumento`]: 'TD01', ...sameParty }), '00471'), []);
    assert.deepEqual(issuesOf(change(ordinary(), { [`${DOC}.TipoDocumento`]: 'TD16' }), '00471'), [], 'buyer with only a fiscal code');
    assert.deepEqual(issuesOf(change(ordinary(), { [`${DOC}.TipoDocumento`]: 'TD21', ...sameParty }), '00471'), []);
  });

  it('00472: TD21 needs the same seller and buyer', () => {
    const bad = change(ordinary(), { [`${DOC}.TipoDocumento`]: 'TD21', [`${buyer}.IdFiscaleIVA`]: { IdPaese: 'IT', IdCodice: '09876543217' } });
    expectCheck('00472', `${seller}.IdFiscaleIVA`, bad, change(bad, sameParty));
    assert.deepEqual(issuesOf(change(ordinary(), { [`${DOC}.TipoDocumento`]: 'TD21' }), '00472'), [], 'buyer with only a fiscal code');
    assert.deepEqual(issuesOf(change(bad, { [`${DOC}.TipoDocumento`]: 'TD01' }), '00472'), []);
  });

  it('00473: the seller country must suit the document type', () => {
    const country = `${seller}.IdFiscaleIVA.IdPaese`;
    for (const type of ['TD17', 'TD18', 'TD19', 'TD28']) {
      const italian = change(ordinary(), { [`${DOC}.TipoDocumento`]: type });
      expectCheck('00473', country, italian, change(italian, { [country]: 'DE' }));
    }
    const td29 = change(ordinary(), { [`${DOC}.TipoDocumento`]: 'TD29', [country]: 'DE' });
    expectCheck('00473', country, td29, change(td29, { [country]: 'IT' }));
    assert.deepEqual(issuesOf(change(ordinary(), { [`${DOC}.TipoDocumento`]: 'TD01', [country]: 'DE' }), '00473'), []);
  });

  it('00474: TD21 admits no line with a zero rate', () => {
    const zero = withGoods([line({ AliquotaIVA: d('0.00'), Natura: 'N4' })], [summary({ AliquotaIVA: d('0.00'), Natura: 'N4', Imposta: d('0.00') })], { [`${DOC}.TipoDocumento`]: 'TD21' });
    expectCheck('00474', `${GOODS}.DettaglioLinee[0].AliquotaIVA`, zero, withGoods([line()], [summary()], { [`${DOC}.TipoDocumento`]: 'TD21' }));
    assert.deepEqual(issuesOf(change(zero, { [`${DOC}.TipoDocumento`]: 'TD01' }), '00474'), []);
    const simple = simplifiedGoods([{ Descrizione: 'x', Importo: d('1.00'), DatiIVA: { Aliquota: d('0.00') }, Natura: 'N4' }], { [`${DOC}.TipoDocumento`]: 'TD21' });
    expectCheck('00474', `${GOODS}[0].DatiIVA.Aliquota`, simple, simplifiedGoods([{ Descrizione: 'x', Importo: d('1.00'), DatiIVA: { Imposta: d('0.20') } }], { [`${DOC}.TipoDocumento`]: 'TD21' }));
  });

  it('00475: these document types need the buyer VAT number', () => {
    for (const type of ['TD16', 'TD17', 'TD18', 'TD19', 'TD20', 'TD22', 'TD23', 'TD28', 'TD29']) {
      const bad = change(ordinary(), { [`${DOC}.TipoDocumento`]: type });
      expectCheck('00475', `${buyer}.IdFiscaleIVA`, bad, change(bad, { [`${buyer}.IdFiscaleIVA`]: { IdPaese: 'DE', IdCodice: '123456789' } }));
    }
    assert.deepEqual(issuesOf(change(ordinary(), { [`${DOC}.TipoDocumento`]: 'TD01' }), '00475'), []);
    assert.deepEqual(issuesOf(change(ordinary(), { [`${DOC}.TipoDocumento`]: 'TD21' }), '00475'), []);
  });

  it('00476: seller and buyer cannot both be outside Italy', () => {
    const path = `${buyer}.IdFiscaleIVA.IdPaese`;
    const foreignBoth = change(ordinary('foreign-buyer'), { [`${seller}.IdFiscaleIVA.IdPaese`]: 'FR' });
    expectCheck('00476', path, foreignBoth, ordinary('foreign-buyer'));
    assert.deepEqual(issuesOf(change(ordinary(), { [`${seller}.IdFiscaleIVA.IdPaese`]: 'FR' }), '00476'), [], 'foreign seller, buyer without VAT');
    assert.deepEqual(issuesOf(change(ordinary(), { [`${seller}.IdFiscaleIVA.IdPaese`]: 'FR', [`${buyer}.IdFiscaleIVA`]: { IdPaese: 'IT', IdCodice: '09876543217' } }), '00476'), []);
  });

  it('00418: a credit note cannot be dated before the invoice it refers to', () => {
    const base = ordinary('credit-note');
    const linked = (date: string) => change(base, { [`${BODY}.DatiGenerali.DatiFattureCollegate`]: [{ IdDocumento: '41', Data: date }, { IdDocumento: '40' }] });
    expectCheck('00418', `${DOC}.Data`, linked('2026-11-28'), linked('2026-11-27'));
    assert.deepEqual(issuesOf(linked('2026-11-01'), '00418'), []);
    assert.deepEqual(issuesOf(change(linked('2026-12-30'), { [`${DOC}.TipoDocumento`]: 'TD01' }), '00418'), []);
  });
});

describe('rates and natures (00400, 00401, 00424, 00445, 00429, 00430)', () => {
  const line0 = `${GOODS}.DettaglioLinee[0]`;
  const summary0 = `${GOODS}.DatiRiepilogo[0]`;

  it('00400 and 00401 on lines', () => {
    const zero = (natura?: string) => withGoods([line({ AliquotaIVA: d('0.00'), ...(natura === undefined ? {} : { Natura: natura }) })], [summary({ AliquotaIVA: d('0.00'), Natura: 'N4', Imposta: d('0.00') })]);
    expectCheck('00400', `${line0}.Natura`, zero(), zero('N4'));
    expectCheck('00401', `${line0}.Natura`, withGoods([line({ Natura: 'N4' })], [summary(), summary({ AliquotaIVA: d('0.00'), Natura: 'N4', Imposta: d('0.00') })]), withGoods([line()], [summary()]));
    assert.deepEqual(issuesOf(withGoods([line({ AliquotaIVA: d('0.004') })], [summary({ AliquotaIVA: d('0.00') })]), '00401'), [], 'a rate that is written as 0.00 is zero');
  });

  it('00429 and 00430 on summaries', () => {
    const zeroSummary = (natura?: string) => withGoods([line({ AliquotaIVA: d('0.00'), Natura: 'N4' })], [summary({ AliquotaIVA: d('0.00'), Imposta: d('0.00'), ...(natura === undefined ? {} : { Natura: natura }) })]);
    expectCheck('00429', `${summary0}.Natura`, zeroSummary(), zeroSummary('N4'));
    expectCheck('00430', `${summary0}.Natura`, withGoods([line()], [summary({ Natura: 'N4' })]), withGoods([line()], [summary()]));
  });

  it('00424: a rate must be a percentage (not 0.22)', () => {
    const rate = (value: string) => withGoods([line({ AliquotaIVA: d(value) })], [summary({ AliquotaIVA: d(value), ImponibileImporto: d('100.00'), Imposta: d('0.22') })]);
    assert.deepEqual(issuesOf(rate('0.22'), '00424').map((found) => found.path), [reportedPath(`${line0}.AliquotaIVA`), reportedPath(`${summary0}.AliquotaIVA`)], 'line and summary');
    assert.deepEqual(issuesOf(rate('22.00'), '00424'), []);
    assert.deepEqual(issuesOf(rate('1.00'), '00424'), []);
    assert.equal(issuesOf(rate('0.99'), '00424').length, 2);
    assert.deepEqual(issuesOf(rate('0.00'), '00424'), []);
    const simple = (aliquota: string) => simplifiedGoods([{ Descrizione: 'x', Importo: d('1.00'), DatiIVA: { Aliquota: d(aliquota) } }]);
    expectCheck('00424', `${GOODS}[0].DatiIVA.Aliquota`, simple('0.22'), simple('22.00'));
  });

  it('00445: the generic natures N2, N3 and N6 are no longer allowed', () => {
    for (const natura of ['N2', 'N3', 'N6']) {
      const bad = withGoods([line({ AliquotaIVA: d('0.00'), Natura: natura })], [summary({ AliquotaIVA: d('0.00'), Natura: natura, Imposta: d('0.00') })]);
      assert.deepEqual(issuesOf(bad, '00445').map((found) => found.path), [reportedPath(`${line0}.Natura`), reportedPath(`${summary0}.Natura`)]);
    }
    for (const natura of ['N2.1', 'N3.5', 'N6.1', 'N1', 'N7']) {
      assert.deepEqual(issuesOf(withGoods([line({ AliquotaIVA: d('0.00'), Natura: natura })], [summary({ AliquotaIVA: d('0.00'), Natura: natura, Imposta: d('0.00') })]), '00445'), [], natura);
    }
    const simple = (natura: string) => simplifiedGoods([{ Descrizione: 'x', Importo: d('1.00'), DatiIVA: { Aliquota: d('0.00') }, Natura: natura }]);
    expectCheck('00445', `${GOODS}[0].Natura`, simple('N2'), simple('N2.2'));
  });

  it('a simplified block with only the tax amount has no rate to check', () => {
    const only = simplifiedGoods([{ Descrizione: 'x', Importo: d('1.22'), DatiIVA: { Imposta: d('0.22') } }]);
    for (const code of ['00400', '00401', '00424']) {
      assert.deepEqual(issuesOf(only, code), []);
    }
  });

  it('00400 and 00401 on the blocks of a simplified invoice', () => {
    const block = (natura?: string) => simplifiedGoods([{ Descrizione: 'x', Importo: d('1.00'), DatiIVA: { Aliquota: d('0.00') }, ...(natura === undefined ? {} : { Natura: natura }) }]);
    expectCheck('00400', `${GOODS}[0].Natura`, block(), block('N4'));
    expectCheck('00401', `${GOODS}[0].Natura`, simplifiedGoods([{ Descrizione: 'x', Importo: d('1.22'), DatiIVA: { Aliquota: d('22.00') }, Natura: 'N4' }]), simplifiedGoods([{ Descrizione: 'x', Importo: d('1.22'), DatiIVA: { Aliquota: d('22.00') } }]));
  });
});

describe('summaries against lines', () => {
  it('00419: a summary for every rate used by the lines', () => {
    const lines = [line(), line({ NumeroLinea: 2, AliquotaIVA: d('10.00') })];
    const both = [summary(), summary({ AliquotaIVA: d('10.00') })];
    expectCheck('00419', `${GOODS}.DatiRiepilogo`, withGoods(lines, [summary()]), withGoods(lines, both));
    assert.deepEqual(issuesOf(withGoods([line(), line({ NumeroLinea: 2 })], [summary()]), '00419'), [], 'two lines, one rate');
    assert.deepEqual(issuesOf(withGoods([line(), line({ NumeroLinea: 2, AliquotaIVA: d('22.004') })], [summary()]), '00419'), [], 'rates are compared as written');
  });

  it('00443: every line rate must appear in a summary', () => {
    const lines = [line({ AliquotaIVA: d('22.00') })];
    expectCheck('00443', `${GOODS}.DettaglioLinee[0].AliquotaIVA`, withGoods(lines, [summary({ AliquotaIVA: d('10.00') })]), withGoods(lines, [summary()]));
  });

  it('00444: every line nature must appear in a summary', () => {
    const zero = (summaryNature: string) => withGoods([line({ AliquotaIVA: d('0.00'), Natura: 'N4' })], [summary({ AliquotaIVA: d('0.00'), Natura: summaryNature, Imposta: d('0.00') })]);
    expectCheck('00444', `${GOODS}.DettaglioLinee[0].Natura`, zero('N2.2'), zero('N4'));
    assert.deepEqual(issuesOf(withGoods([line()], [summary()]), '00444'), [], 'a line without nature is not compared');
  });

  it('00420: reverse charge (N6 and N6.x) is not compatible with split payment', () => {
    const make = (natura: string, chargeability: 'I' | 'S') => withGoods([line({ AliquotaIVA: d('0.00'), Natura: natura })], [summary({ AliquotaIVA: d('0.00'), Natura: natura, Imposta: d('0.00'), EsigibilitaIVA: chargeability })]);
    for (const natura of ['N6', 'N6.1', 'N6.9']) {
      expectCheck('00420', `${GOODS}.DatiRiepilogo[0].Natura`, make(natura, 'S'), make(natura, 'I'));
    }
    assert.deepEqual(issuesOf(make('N4', 'S'), '00420'), []);
    assert.deepEqual(issuesOf(withGoods([line()], [summary({ EsigibilitaIVA: 'S' })]), '00420'), []);
  });
});

describe('amounts: 00421, 00422, 00423 and the total', () => {
  it('00421: the tax is rate x taxable / 100 rounded half up to the cent, tolerance below one cent', () => {
    const tax = (taxable: string, rate: string, imposta: string) => withGoods([line()], [summary({ ImponibileImporto: d(taxable), AliquotaIVA: d(rate), Imposta: d(imposta) })]);
    const path = `${GOODS}.DatiRiepilogo[0].Imposta`;
    expectCheck('00421', path, tax('100.00', '22.00', '22.01'), tax('100.00', '22.00', '22.00'));
    expectCheck('00421', path, tax('100.00', '22.00', '21.99'), tax('100.00', '22.00', '22.00'));
    // 0.25 x 10 / 100 = 0.025: half up gives 0.03, so 0.02 is a cent short.
    expectCheck('00421', path, tax('0.25', '10.00', '0.02'), tax('0.25', '10.00', '0.03'));
    // Elenco p.24: a third decimal below 5 rounds down, 5 or more rounds up (6819.29 x 22 / 100 = 1500.2438; 6819.30 gives 1500.246).
    assert.equal(issuesOf(tax('6819.29', '22.00', '1500.24'), '00421').length, 0);
    assert.equal(issuesOf(tax('6819.29', '22.00', '1500.25'), '00421').length, 1);
    assert.equal(issuesOf(tax('6819.30', '22.00', '1500.25'), '00421').length, 0);
    assert.equal(issuesOf(tax('6819.30', '22.00', '1500.24'), '00421').length, 1);
    // Written values count: an Imposta of 22.0049 is written 22.00 (and one of 22.005 is written 22.01).
    assert.equal(issuesOf(tax('100.00', '22.00', '22.0049'), '00421').length, 0);
    assert.equal(issuesOf(tax('100.00', '22.00', '22.005'), '00421').length, 1);
  });

  it('00423: the line total, with the three worked examples of the Elenco (pages 28 to 30)', () => {
    const total = (lineValues: Partial<DettaglioLinee>) => withGoods([line({ Quantita: d('100.00'), PrezzoUnitario: d('500.00'), ...lineValues })], [summary()]);
    const path = `${GOODS}.DettaglioLinee[0].PrezzoTotale`;
    // Example 1: three discounts as amounts.
    const amounts = [{ Tipo: 'SC', Importo: d('10.05') }, { Tipo: 'SC', Importo: d('5.25') }, { Tipo: 'SC', Importo: d('4.70') }] as const;
    assert.deepEqual(issuesOf(total({ ScontoMaggiorazione: amounts, PrezzoTotale: d('48000.00') }), '00423'), []);
    assert.deepEqual(issuesOf(total({ ScontoMaggiorazione: amounts, PrezzoTotale: d('48000.0099') }), '00423'), [], 'difference of 0.0099 passes');
    expectCheck('00423', path, total({ ScontoMaggiorazione: amounts, PrezzoTotale: d('48000.01') }), total({ ScontoMaggiorazione: amounts, PrezzoTotale: d('48000.00') }));
    expectCheck('00423', path, total({ ScontoMaggiorazione: amounts, PrezzoTotale: d('47999.99') }), total({ ScontoMaggiorazione: amounts, PrezzoTotale: d('48000.00') }));
    // Example 2: three cascading percentages, exact result 42092.05875, 42092.05 and 42092.06 are admitted.
    const percentages = [{ Tipo: 'SC', Percentuale: d('8.50') }, { Tipo: 'SC', Percentuale: d('5.15') }, { Tipo: 'SC', Percentuale: d('3.00') }] as const;
    for (const value of ['42092.05875', '42092.05', '42092.06']) {
      assert.deepEqual(issuesOf(total({ ScontoMaggiorazione: percentages, PrezzoTotale: d(value) }), '00423'), [], value);
    }
    for (const value of ['42092.04', '42092.07']) {
      assert.equal(issuesOf(total({ ScontoMaggiorazione: percentages, PrezzoTotale: d(value) }), '00423').length, 1, value);
    }
    // Example 3: percentage, then a block with both (the amount counts), then an amount, then a percentage.
    const mixed = [
      { Tipo: 'SC', Percentuale: d('8.50') },
      { Tipo: 'SC', Percentuale: d('5.15'), Importo: d('23.56') },
      { Tipo: 'SC', Importo: d('15.00') },
      { Tipo: 'SC', Percentuale: d('2.00') },
    ] as const;
    assert.deepEqual(issuesOf(total({ ScontoMaggiorazione: mixed, PrezzoTotale: d('41056.12') }), '00423'), []);
    assert.equal(issuesOf(total({ ScontoMaggiorazione: mixed, PrezzoTotale: d('41056.13') }), '00423').length, 1);
  });

  it('00423: surcharges add, a missing quantity counts as one, a block without values counts as zero', () => {
    const one = (values: Partial<DettaglioLinee>) => withGoods([line({ PrezzoUnitario: d('10.00'), ...values })], [summary()]);
    assert.deepEqual(issuesOf(one({ ScontoMaggiorazione: [{ Tipo: 'MG', Importo: d('2.00') }], PrezzoTotale: d('12.00') }), '00423'), []);
    assert.deepEqual(issuesOf(one({ ScontoMaggiorazione: [{ Tipo: 'MG', Percentuale: d('10.00') }], PrezzoTotale: d('11.00') }), '00423'), []);
    assert.deepEqual(issuesOf(one({ PrezzoTotale: d('10.00') }), '00423'), []);
    assert.deepEqual(issuesOf(one({ Quantita: d('3.00'), PrezzoTotale: d('30.00') }), '00423'), []);
    assert.equal(issuesOf(one({ Quantita: d('3.00'), PrezzoTotale: d('10.00') }), '00423').length, 1);
    assert.deepEqual(issuesOf(one({ ScontoMaggiorazione: [{ Tipo: 'SC' }], PrezzoTotale: d('10.00') }), '00423'), []);
    assert.deepEqual(issuesOf(one({ PrezzoUnitario: d('-10.00'), PrezzoTotale: d('-10.00') }), '00423'), [], 'a negative line');
  });

  it('00422 edges: up to one cent passes, below one euro warns, from one euro it fails', () => {
    // Zero-rate lines keep Imposta at 0.00 whatever the taxable amount.
    const taxable = (value: string) =>
      withGoods([line({ AliquotaIVA: d('0.00'), Natura: 'N4' })], [summary({ AliquotaIVA: d('0.00'), Natura: 'N4', Imposta: d('0.00'), ImponibileImporto: d(value) })]);
    const path = `${GOODS}.DatiRiepilogo[0].ImponibileImporto`;
    for (const value of ['100.00', '100.01', '99.99']) {
      assert.deepEqual(issuesOf(taxable(value), '00422'), [], value);
    }
    for (const value of ['100.02', '99.98', '100.99', '99.01']) {
      expectCheck('00422', path, taxable(value), taxable('100.00'), 'warning');
    }
    for (const value of ['101.00', '99.00', '250.00']) {
      expectCheck('00422', path, taxable(value), taxable('100.00'), 'error');
    }
  });

  it('00422 sums the lines and the summaries of the same rate, and points at the goods block when no summary has it', () => {
    const lines = [line({ PrezzoTotale: d('60.00') }), line({ NumeroLinea: 2, PrezzoTotale: d('40.00') })];
    assert.deepEqual(issuesOf(withGoods(lines, [summary({ ImponibileImporto: d('70.00'), Imposta: d('15.40') }), summary({ ImponibileImporto: d('30.00'), Imposta: d('6.60') })]), '00422'), []);
    const orphan = withGoods([line(), line({ NumeroLinea: 2, AliquotaIVA: d('10.00'), PrezzoTotale: d('50.00') })], [summary()]);
    assert.deepEqual(issuesOf(orphan, '00422').map((found) => [found.path, found.severity]), [[reportedPath(GOODS), 'error']]);
  });

  it('TOTAL: the document total should equal the sum of taxable amounts and taxes (warning above one cent)', () => {
    const total = (value: string) => change(withGoods([line()], [summary()]), { [`${DOC}.ImportoTotaleDocumento`]: d(value) });
    const path = `${DOC}.ImportoTotaleDocumento`;
    expectCheck('TOTAL', path, total('122.02'), total('122.00'), 'warning');
    expectCheck('TOTAL', path, total('121.00'), total('122.00'), 'warning');
    assert.deepEqual(issuesOf(total('122.01'), 'TOTAL'), []);
    assert.deepEqual(issuesOf(total('121.99'), 'TOTAL'), []);
    assert.deepEqual(issuesOf(withGoods([line()], [summary()]), 'TOTAL'), [], 'no total, nothing to compare');
  });
});

describe('discounts and surcharges (00437, 00438)', () => {
  it('a block with a type but neither percentage nor amount is an error, at document and line level', () => {
    const doc = (block: unknown) => change(ordinary(), { [`${DOC}.ScontoMaggiorazione`]: [block] });
    expectCheck('00437', `${DOC}.ScontoMaggiorazione[0]`, doc({ Tipo: 'SC' }), doc({ Tipo: 'SC', Importo: d('1.00') }));
    assert.deepEqual(issuesOf(doc({ Tipo: 'SC', Percentuale: d('5.00') }), '00437'), []);
    const onLine = (block: unknown) => withGoods([line({ ScontoMaggiorazione: [block as never] })], [summary()]);
    expectCheck('00438', `${GOODS}.DettaglioLinee[0].ScontoMaggiorazione[0]`, onLine({ Tipo: 'MG' }), onLine({ Tipo: 'MG', Percentuale: d('5.00') }));
    assert.deepEqual(issuesOf(ordinary(), '00437'), []);
  });
});

describe('simplified invoices (00418, 00460)', () => {
  it('00418: a TD08 cannot be dated before the invoice it rectifies', () => {
    const rectified = (date: string) => change(simplified(), { [`${BODY}.DatiGenerali.DatiFatturaRettificata.DataFR`]: date });
    expectCheck('00418', `${DOC}.Data`, rectified('2026-11-28'), rectified('2026-11-27'));
    assert.deepEqual(issuesOf(change(rectified('2026-12-30'), { [`${DOC}.TipoDocumento`]: 'TD07' }), '00418'), []);
    assert.deepEqual(issuesOf(change(simplified(), { [`${BODY}.DatiGenerali.DatiFatturaRettificata`]: undefined }), '00418'), []);
  });

  it('00460: the total cannot exceed 400.00 euro unless rectifying or RF19 / RF20 (RF21 is an open point: not exempt)', () => {
    const blocks = (amounts: readonly string[]) => amounts.map((amount) => ({ Descrizione: 'x', Importo: d(amount), DatiIVA: { Aliquota: d('22.00') } }));
    const plain = (amounts: readonly string[], extra: Record<string, unknown> = {}) =>
      simplifiedGoods(blocks(amounts), { [`${BODY}.DatiGenerali.DatiFatturaRettificata`]: undefined, ...extra });
    expectCheck('00460', GOODS, plain(['400.01']), plain(['400.00']));
    expectCheck('00460', GOODS, plain(['200.00', '200.01']), plain(['200.00', '200.00']));
    assert.deepEqual(issuesOf(plain(['400.0049']), '00460'), [], 'amounts count as written');
    for (const regime of ['RF19', 'RF20']) {
      assert.deepEqual(issuesOf(plain(['500.00'], { [`${HEADER}.CedentePrestatore.RegimeFiscale`]: regime }), '00460'), [], regime);
    }
    assert.equal(issuesOf(plain(['500.00'], { [`${HEADER}.CedentePrestatore.RegimeFiscale`]: 'RF21' }), '00460').length, 1);
    assert.deepEqual(issuesOf(simplifiedGoods(blocks(['500.00'])), '00460'), [], 'rectifying invoice');
  });
});

describe('the fixtures', () => {
  it('a sound ordinary and a sound simplified invoice raise nothing', () => {
    assert.deepEqual(checkSdi(ordinary(), CONTEXT), []);
    assert.deepEqual(checkSdi(simplified(), CONTEXT), []);
  });
});
