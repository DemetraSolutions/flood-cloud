import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatDecimal } from '../../src/invoice/decimal.ts';
import type { Decimal } from '../../src/invoice/decimal.ts';
import { mapQueueRecord } from '../../src/invoice/from-queue.ts';
import type { MappingResult } from '../../src/invoice/from-queue.ts';
import type { FatturaElettronica, FatturaElettronicaSemplificata } from '../../src/invoice/model.ts';
import { baseRecord, fixtures, withValues } from '../fixtures/records.ts';
import type { RecordData } from '../fixtures/records.ts';

const TRANSMITTER = { IdPaese: 'IT', IdCodice: '01879020517' };
const GENERAL = 'FatturaElettronicaBody.DatiGenerali';
const DOCUMENT = `${GENERAL}.DatiGeneraliDocumento`;
const SELLER = 'FatturaElettronicaHeader.CedentePrestatore';
const BUYER = 'FatturaElettronicaHeader.CessionarioCommittente';
const TRANSMISSION = 'FatturaElettronicaHeader.DatiTrasmissione';

function map(record: unknown, timeZone?: string): MappingResult {
  return mapQueueRecord(record, timeZone === undefined ? { transmitter: TRANSMITTER } : { transmitter: TRANSMITTER, timeZone });
}

function ordinary(record: unknown): FatturaElettronica {
  const result = map(record);
  assert.ok(result.ok, `expected a model, got ${JSON.stringify(result.ok ? [] : result.issues)}`);
  assert.notEqual(result.model.versione, 'FSM10');
  return result.model as FatturaElettronica;
}

function simplified(record: unknown): FatturaElettronicaSemplificata {
  const result = map(record);
  assert.ok(result.ok);
  assert.equal(result.model.versione, 'FSM10');
  return result.model as FatturaElettronicaSemplificata;
}

function problems(record: unknown): string[] {
  const result = map(record);
  assert.equal(result.ok, false, 'expected problems');
  return result.ok ? [] : result.issues.map((issue) => `${issue.path}:${issue.issue}`).sort();
}

function show(value: Decimal | undefined): string | undefined {
  return value === undefined ? undefined : formatDecimal(value, 2, 8);
}

function change(values: Record<string, unknown>): RecordData {
  return withValues(baseRecord(), values);
}

describe('mapQueueRecord: the base invoice', () => {
  it('maps a private customer with a recipient code', () => {
    const model = ordinary(baseRecord());
    const header = model.FatturaElettronicaHeader;
    assert.equal(model.versione, 'FPR12');
    assert.deepEqual(header.DatiTrasmissione, {
      IdTrasmittente: TRANSMITTER,
      ProgressivoInvio: '7',
      FormatoTrasmissione: 'FPR12',
      CodiceDestinatario: 'ABCDEFG',
    });
    assert.deepEqual(header.CedentePrestatore.DatiAnagrafici, {
      IdFiscaleIVA: { IdPaese: 'IT', IdCodice: '01234567890' },
      CodiceFiscale: '01234567890',
      Anagrafica: { Denominazione: 'Bar Esempio S.r.l.' },
      RegimeFiscale: 'RF01',
    });
    assert.deepEqual(header.CedentePrestatore.Sede, { Indirizzo: 'Via Roma 1', CAP: '00100', Comune: 'Roma', Provincia: 'RM', Nazione: 'IT' });
    assert.deepEqual(header.CessionarioCommittente, {
      DatiAnagrafici: { CodiceFiscale: 'RSSMRA80A01H501U', Anagrafica: { Nome: 'Mario', Cognome: 'Rossi' } },
      Sede: { Indirizzo: 'Via Milano 10', CAP: '20100', Comune: 'Milano', Provincia: 'MI', Nazione: 'IT' },
    });
    const document = model.FatturaElettronicaBody.DatiGenerali.DatiGeneraliDocumento;
    assert.deepEqual({ ...document, ImportoTotaleDocumento: show(document.ImportoTotaleDocumento) }, {
      TipoDocumento: 'TD01',
      Divisa: 'EUR',
      Data: '2026-11-27',
      Numero: '42',
      ImportoTotaleDocumento: '3.00',
    });
  });

  it('computes lines and summaries so that the SdI checks pass', () => {
    const goods = ordinary(baseRecord()).FatturaElettronicaBody.DatiBeniServizi;
    assert.deepEqual(
      goods.DettaglioLinee.map((line) => [line.NumeroLinea, line.Descrizione, show(line.Quantita), show(line.PrezzoUnitario), show(line.PrezzoTotale), show(line.AliquotaIVA)]),
      [
        [1, 'Caffè espresso', '2.00', '0.81967213', '1.63934426', '22.00'],
        [2, 'Cornetto', '1.00', '0.90909091', '0.90909091', '10.00'],
      ],
    );
    assert.deepEqual(
      goods.DatiRiepilogo.map((row) => [show(row.AliquotaIVA), show(row.ImponibileImporto), show(row.Imposta), row.EsigibilitaIVA]),
      [
        ['22.00', '1.64', '0.36', 'I'],
        ['10.00', '0.91', '0.09', 'I'],
      ],
    );
  });

  it('returns no warnings for clean text', () => {
    const result = map(baseRecord());
    assert.ok(result.ok);
    assert.deepEqual(result.warnings, []);
  });

  it('reports a record that is not an object, and the fields of the wrong type, without throwing', () => {
    assert.deepEqual(problems('x'), ['record:invalid']);
    assert.ok(problems(change({ total: 'abc' })).includes('total:invalid'));
  });

  it('is deterministic', () => {
    assert.deepEqual(map(baseRecord()), map(baseRecord()));
  });

  it('never puts a value of the record in an issue', () => {
    const result = map(change({ 'counterpart.name': 'Zzyzxname', 'counterpart.code': 'not a code ZZ', 'counterpart.postcode': 'Zzyzxcap' }));
    assert.equal(result.ok, false);
    assert.ok(!JSON.stringify(result).includes('Zzyzx'));
    assert.ok(!JSON.stringify(result).includes('not a code'));
  });
});

describe('mapQueueRecord: format and transmission', () => {
  it('uses the transmitter of the options, or the company one when both its parts are set', () => {
    assert.deepEqual(ordinary(baseRecord()).FatturaElettronicaHeader.DatiTrasmissione.IdTrasmittente, TRANSMITTER);
    const own = ordinary(fixtures['seller-with-register-entry']?.());
    assert.deepEqual(own.FatturaElettronicaHeader.DatiTrasmissione.IdTrasmittente, { IdPaese: 'IT', IdCodice: '09999999999' });
    const half = ordinary(change({ 'company.fattura_elettronica.IdTrasmittente_paese': 'IT' }));
    assert.deepEqual(half.FatturaElettronicaHeader.DatiTrasmissione.IdTrasmittente, TRANSMITTER);
  });

  it('refuses a transmitter that is not valid', () => {
    const result = mapQueueRecord(baseRecord(), { transmitter: { IdPaese: 'ITA', IdCodice: '' } });
    assert.equal(result.ok, false);
    assert.deepEqual(result.ok ? [] : result.issues.map((issue) => `${issue.path}:${issue.issue}`), [`${TRANSMISSION}.IdTrasmittente.IdPaese:invalid`, `${TRANSMISSION}.IdTrasmittente.IdCodice:missing`]);
  });

  it('defaults to FPR12 and accepts FPA12; any other format is unsupported', () => {
    assert.equal(ordinary(change({ 'counterpart.fattura_elettronica.formato_trasmissione': '' })).versione, 'FPR12');
    assert.equal(ordinary(fixtures['public-administration-split-payment']?.()).versione, 'FPA12');
    assert.deepEqual(problems(change({ 'counterpart.fattura_elettronica.formato_trasmissione': 'FPX99' })), ['counterpart.fattura_elettronica.formato_trasmissione:unsupported']);
  });

  it('builds a simplified invoice for TD07, TD08 and TD09, whatever the counterpart format', () => {
    for (const type of ['TD07', 'TD08', 'TD09']) {
      assert.equal(simplified(change({ 'fattura_elettronica.tipo': type, 'counterpart.fattura_elettronica.formato_trasmissione': 'FPA12' })).versione, 'FSM10');
    }
  });

  it('requires a known document type', () => {
    assert.deepEqual(problems(change({ 'fattura_elettronica.tipo': undefined })), [`${DOCUMENT}.TipoDocumento:missing`]);
    assert.deepEqual(problems(change({ 'fattura_elettronica.tipo': 'TD99' })), [`${DOCUMENT}.TipoDocumento:invalid`]);
    assert.equal(ordinary(change({ 'fattura_elettronica.tipo': 'td04' })).FatturaElettronicaBody.DatiGenerali.DatiGeneraliDocumento.TipoDocumento, 'TD04');
  });

  it('requires a progressive that is a valid identifier', () => {
    assert.deepEqual(problems(change({ 'fattura_elettronica.progressivo_invio': undefined })), [`${TRANSMISSION}.ProgressivoInvio:missing`]);
    assert.deepEqual(problems(change({ 'fattura_elettronica.progressivo_invio': 12345678901 })), [`${TRANSMISSION}.ProgressivoInvio:invalid`]);
  });
});

describe('mapQueueRecord: recipient', () => {
  const recipient = (values: Record<string, unknown>): { code: string; pec: string | undefined } => {
    const header = ordinary(change(values)).FatturaElettronicaHeader.DatiTrasmissione;
    return { code: header.CodiceDestinatario, pec: header.PECDestinatario };
  };
  const path = `${TRANSMISSION}.CodiceDestinatario`;

  it('writes a recipient code in upper case without spaces', () => {
    assert.deepEqual(recipient({ 'counterpart.fattura_elettronica.codice_destinatario': ' ab cd 123 ' }), { code: 'ABCD123', pec: undefined });
  });

  it('checks the length of the code against the format (check 00427)', () => {
    assert.deepEqual(problems(change({ 'counterpart.fattura_elettronica.codice_destinatario': 'ABC12' })), [`${path}:invalid`]);
    assert.deepEqual(problems(change({ 'counterpart.fattura_elettronica.formato_trasmissione': 'FPA12' })), [`${path}:invalid`]);
    assert.ok(map(change({ 'counterpart.fattura_elettronica.formato_trasmissione': 'FPA12', 'counterpart.fattura_elettronica.codice_destinatario': 'UF1234' })).ok);
  });

  it('uses the PEC with the code 0000000', () => {
    const pec = { 'counterpart.fattura_elettronica.identificativo': 'PEC', 'counterpart.fattura_elettronica.pec': ' a@pec.example.it ' };
    assert.deepEqual(recipient(pec), { code: '0000000', pec: 'a@pec.example.it' });
    assert.deepEqual(problems(change({ ...pec, 'counterpart.fattura_elettronica.pec': 'not an address' })), [`${TRANSMISSION}.PECDestinatario:invalid`]);
    assert.deepEqual(problems(change({ ...pec, 'counterpart.fattura_elettronica.pec': `${'a'.repeat(250)}@pec.example.it` })), [`${TRANSMISSION}.PECDestinatario:invalid`]);
  });

  it('writes 0000000 when the channel is unknown, 999999 for the public administration and XXXXXXX abroad', () => {
    assert.deepEqual(recipient({ 'counterpart.fattura_elettronica.identificativo': '', 'counterpart.fattura_elettronica.codice_destinatario': '' }), { code: '0000000', pec: undefined });
    assert.equal(ordinary(fixtures['foreign-buyer']?.()).FatturaElettronicaHeader.DatiTrasmissione.CodiceDestinatario, 'XXXXXXX');
    const pa = { 'counterpart.fattura_elettronica.formato_trasmissione': 'FPA12', 'counterpart.fattura_elettronica.identificativo': '', 'counterpart.fattura_elettronica.codice_destinatario': '' };
    assert.deepEqual(recipient(pa), { code: '999999', pec: undefined });
    assert.deepEqual(recipient({ ...pa, 'counterpart.fattura_elettronica.identificativo': 'PEC', 'counterpart.fattura_elettronica.pec': 'a@pec.example.it' }), { code: '999999', pec: undefined });
  });

  it('an empty code on the code channel falls back to the default', () => {
    assert.deepEqual(recipient({ 'counterpart.fattura_elettronica.codice_destinatario': '' }), { code: '0000000', pec: undefined });
  });
});

describe('mapQueueRecord: seller', () => {
  it('strips the IT prefix of the VAT number, only at the start', () => {
    assert.equal(ordinary(change({ 'company.code': ' it 0123 4567890 ' })).FatturaElettronicaHeader.CedentePrestatore.DatiAnagrafici.IdFiscaleIVA.IdCodice, '01234567890');
    assert.equal(ordinary(change({ 'company.code': '0123ITX4567' })).FatturaElettronicaHeader.CedentePrestatore.DatiAnagrafici.IdFiscaleIVA.IdCodice, '0123ITX4567');
    assert.equal(ordinary(change({ 'company.code': 'IT' })).FatturaElettronicaHeader.CedentePrestatore.DatiAnagrafici.IdFiscaleIVA.IdCodice, 'IT');
  });

  it('omits the fiscal code when empty', () => {
    assert.equal(ordinary(change({ 'company.code2': '' })).FatturaElettronicaHeader.CedentePrestatore.DatiAnagrafici.CodiceFiscale, undefined);
  });

  it('reports what is missing or wrong', () => {
    const data = `${SELLER}.DatiAnagrafici`;
    assert.deepEqual(
      problems(change({ 'company.code': '', 'company.name': ' ', 'company.fattura_elettronica.regime_fiscale': '' })),
      [`${data}.Anagrafica.Denominazione:missing`, `${data}.IdFiscaleIVA.IdCodice:missing`, `${data}.RegimeFiscale:invalid`].sort().map((entry) => (entry.endsWith('RegimeFiscale:invalid') ? `${data}.RegimeFiscale:missing` : entry)).sort(),
    );
    assert.deepEqual(problems(change({ 'company.fattura_elettronica.regime_fiscale': 'RF03' })), [`${data}.RegimeFiscale:invalid`]);
    assert.deepEqual(problems(change({ 'company.code2': 'ab' })), [`${data}.CodiceFiscale:invalid`]);
  });

  it('checks the address: Italian postcode of five digits, province of two letters, required parts', () => {
    assert.deepEqual(problems(change({ 'company.postcode': '123' })), [`${SELLER}.Sede.CAP:invalid`]);
    assert.deepEqual(problems(change({ 'company.countryAreaCode': 'Roma' })), [`${SELLER}.Sede.Provincia:invalid`]);
    assert.deepEqual(problems(change({ 'company.address': '', 'company.city': '', 'company.postcode': '' })), [`${SELLER}.Sede.CAP:missing`, `${SELLER}.Sede.Comune:missing`, `${SELLER}.Sede.Indirizzo:missing`]);
    assert.equal(ordinary(change({ 'company.countryAreaCode': '' })).FatturaElettronicaHeader.CedentePrestatore.Sede.Provincia, undefined);
  });

  it('maps the company register entry', () => {
    const rea = ordinary(fixtures['seller-with-register-entry']?.()).FatturaElettronicaHeader.CedentePrestatore.IscrizioneREA;
    assert.deepEqual({ ...rea, CapitaleSociale: show(rea?.CapitaleSociale) }, { Ufficio: 'RM', NumeroREA: '123456', CapitaleSociale: '10000.00', SocioUnico: 'SU', StatoLiquidazione: 'LN' });
  });

  it('needs the office and the liquidation state when there is a register number; the capital and the partners are optional', () => {
    const rea = (values: Record<string, unknown>): Record<string, unknown> => ({
      'company.fattura_elettronica.rea_numero': '99',
      'company.fattura_elettronica.rea_ufficio': 'MI',
      'company.fattura_elettronica.rea_liquidazione': 'LS',
      ...values,
    });
    const entry = ordinary(change(rea({}))).FatturaElettronicaHeader.CedentePrestatore.IscrizioneREA;
    assert.deepEqual(entry, { Ufficio: 'MI', NumeroREA: '99', StatoLiquidazione: 'LS' });
    const path = `${SELLER}.IscrizioneREA`;
    assert.deepEqual(problems(change(rea({ 'company.fattura_elettronica.rea_ufficio': '', 'company.fattura_elettronica.rea_liquidazione': '' }))), [`${path}.StatoLiquidazione:missing`, `${path}.Ufficio:missing`]);
    assert.deepEqual(problems(change(rea({ 'company.fattura_elettronica.rea_liquidazione': 'XX', 'company.fattura_elettronica.rea_soci': 'ZZ' }))), [`${path}.SocioUnico:invalid`, `${path}.StatoLiquidazione:invalid`]);
  });
});

describe('mapQueueRecord: buyer', () => {
  it('needs a known customer type', () => {
    assert.deepEqual(problems(change({ customerType: undefined })), ['customerType:missing']);
    assert.deepEqual(problems(change({ customerType: 3 })), ['customerType:invalid']);
  });

  it('identifies a private customer by fiscal code, with name and surname apart', () => {
    assert.deepEqual(problems(change({ 'counterpart.code': '' })), [`${BUYER}.DatiAnagrafici.CodiceFiscale:missing`]);
    assert.deepEqual(problems(change({ 'counterpart.code': 'abc' })), [`${BUYER}.DatiAnagrafici.CodiceFiscale:invalid`]);
    assert.deepEqual(problems(change({ 'counterpart.name': '', 'counterpart.surname': '' })), [`${BUYER}.DatiAnagrafici.Anagrafica.Cognome:missing`, `${BUYER}.DatiAnagrafici.Anagrafica.Nome:missing`]);
  });

  it('identifies a company by VAT number and fiscal code, normalizing ITA and the IT prefix', () => {
    const buyer = ordinary(fixtures['company-buyer']?.()).FatturaElettronicaHeader.CessionarioCommittente;
    assert.deepEqual(buyer.DatiAnagrafici, {
      IdFiscaleIVA: { IdPaese: 'IT', IdCodice: '09876543210' },
      CodiceFiscale: '09876543210',
      Anagrafica: { Denominazione: 'Cliente Esempio S.p.A.' },
    });
    assert.deepEqual(buyer.Sede, { Indirizzo: 'Corso Italia 5', CAP: '10100', Comune: 'Torino', Provincia: 'TO', Nazione: 'IT' });
  });

  it('identifies a public administration by fiscal code only, or by VAT number when there is none', () => {
    const pa = ordinary(fixtures['public-administration-split-payment']?.()).FatturaElettronicaHeader.CessionarioCommittente;
    assert.deepEqual(pa.DatiAnagrafici.IdFiscaleIVA, undefined);
    assert.equal(pa.DatiAnagrafici.CodiceFiscale, '80012345678');
    const noFiscalCode = ordinary(withValues(fixtures['public-administration-split-payment']?.() as RecordData, { 'counterpart.companyCode2': '' }));
    assert.deepEqual(noFiscalCode.FatturaElettronicaHeader.CessionarioCommittente.DatiAnagrafici.IdFiscaleIVA, { IdPaese: 'IT', IdCodice: '09876543210' });
  });

  it('writes a foreign company with its country, no province and a placeholder postcode', () => {
    const buyer = ordinary(fixtures['foreign-buyer']?.()).FatturaElettronicaHeader.CessionarioCommittente;
    assert.deepEqual(buyer.DatiAnagrafici.IdFiscaleIVA, { IdPaese: 'DE', IdCodice: '123456789' });
    assert.equal(buyer.DatiAnagrafici.CodiceFiscale, undefined);
    assert.deepEqual(buyer.Sede, { Indirizzo: 'Unter den Linden 1', CAP: '00000', Comune: 'Berlin', Nazione: 'DE' });
  });

  it('keeps a five-digit postcode abroad', () => {
    const buyer = ordinary(withValues(fixtures['foreign-buyer']?.() as RecordData, { 'counterpart.companyPostcode': '10115' })).FatturaElettronicaHeader.CessionarioCommittente;
    assert.equal(buyer.Sede.CAP, '10115');
  });

  it('needs at least one fiscal identifier and a valid country', () => {
    const company = { customerType: 2, 'counterpart.companyName': 'X Srl', 'counterpart.companyAddress': 'Via 1', 'counterpart.companyPostcode': '10100', 'counterpart.companyCity': 'Torino', 'counterpart.companyCountryCode': 'IT' };
    assert.deepEqual(problems(change(company)), [`${BUYER}.DatiAnagrafici.IdFiscaleIVA:missing`]);
    assert.deepEqual(problems(change({ ...company, 'counterpart.companyCode': '123', 'counterpart.companyCountryCode': '' })), [`${BUYER}.DatiAnagrafici.IdFiscaleIVA.IdPaese:missing`, `${BUYER}.Sede.Nazione:missing`]);
    assert.deepEqual(problems(change({ ...company, 'counterpart.companyCode': '123', 'counterpart.companyCountryCode': 'DEU' })), [`${BUYER}.DatiAnagrafici.IdFiscaleIVA.IdPaese:invalid`, `${BUYER}.Sede.Nazione:invalid`]);
  });

  it('rejects an Italian buyer without a valid Italian postcode', () => {
    assert.deepEqual(problems(change({ 'counterpart.postcode': 'D-1' })), [`${BUYER}.Sede.CAP:invalid`]);
  });
});

describe('mapQueueRecord: document data', () => {
  it('composes the number with the section as prefix or suffix', () => {
    const numero = (values: Record<string, unknown>): string => ordinary(change(values)).FatturaElettronicaBody.DatiGenerali.DatiGeneraliDocumento.Numero;
    assert.equal(numero({ prefixSuffix: 'A/', 'company.invoicesPS': 'prefix' }), 'A/42');
    assert.equal(numero({ prefixSuffix: '/B', 'company.invoicesPS': 'suffix' }), '42/B');
    assert.equal(numero({ prefixSuffix: 'A/', 'company.invoicesPS': null }), '42');
    assert.equal(numero({ number: '7' }), '7');
  });

  it('checks the number', () => {
    assert.deepEqual(problems(change({ number: undefined })), [`${DOCUMENT}.Numero:missing`]);
    assert.deepEqual(problems(change({ number: 'x1' })), [`${DOCUMENT}.Numero:invalid`]);
    assert.deepEqual(problems(change({ prefixSuffix: 'a very long section name', 'company.invoicesPS': 'prefix' })), [`${DOCUMENT}.Numero:invalid`]);
    assert.deepEqual(problems(change({ prefixSuffix: 'à', 'company.invoicesPS': 'suffix' })), [`${DOCUMENT}.Numero:invalid`]);
  });

  it('checks the date and the currency', () => {
    assert.deepEqual(problems(change({ date: undefined })), [`${DOCUMENT}.Data:missing`]);
    assert.deepEqual(problems(change({ date: '1969-12-31' })), [`${DOCUMENT}.Data:invalid`]);
    assert.deepEqual(problems(change({ 'company.currencyCode': 'euro' })), [`${DOCUMENT}.Divisa:invalid`]);
    assert.deepEqual(problems(change({ 'company.currencyCode': undefined })), [`${DOCUMENT}.Divisa:missing`]);
  });

  it('writes the calendar day of the Italian time zone, or of the one given', () => {
    const date = (timeZone?: string): string => {
      const result = map(change({ date: '2026-12-31T23:30:00.000Z' }), timeZone);
      assert.ok(result.ok && result.model.versione !== 'FSM10');
      return (result.model as FatturaElettronica).FatturaElettronicaBody.DatiGenerali.DatiGeneraliDocumento.Data;
    };
    assert.equal(date(), '2027-01-01');
    assert.equal(date('UTC'), '2026-12-31');
    assert.throws(() => map(baseRecord(), 'Not/AZone'), RangeError);
  });

  it('needs the total of the document', () => {
    assert.deepEqual(problems(change({ total: undefined })), [`${DOCUMENT}.ImportoTotaleDocumento:missing`]);
    assert.equal(show(ordinary(change({ total: 12.345 })).FatturaElettronicaBody.DatiGenerali.DatiGeneraliDocumento.ImportoTotaleDocumento), '12.35');
  });

  it('splits the note in blocks of at most 200 characters instead of cutting it', () => {
    const note = 'parola '.repeat(80).trim();
    const reasons = ordinary(change({ note })).FatturaElettronicaBody.DatiGenerali.DatiGeneraliDocumento.Causale;
    assert.ok(reasons !== undefined && reasons.length === 3);
    assert.ok(reasons.every((reason) => reason.length <= 200));
    assert.equal(reasons.join(' '), note);
    assert.equal(ordinary(change({ note: 'Reso' })).FatturaElettronicaBody.DatiGenerali.DatiGeneraliDocumento.Causale?.[0], 'Reso');
  });
});

describe('mapQueueRecord: lines', () => {
  const line = (values: Record<string, unknown> = {}, qt: unknown = 1): Record<string, unknown> => ({
    name: { it: 'Articolo' },
    qt,
    price: { price: 10, tax: 22, taxData: { id: 't', value: 22, description: '', natura: '' }, discount: 0, ...values },
  });
  const lines = (...entries: unknown[]): RecordData => change({ records: entries });

  it('skips the lines without a positive quantity and numbers the rest from 1', () => {
    const goods = ordinary(lines(line({}, 0), line({}, 2), line({}, -1), line({}, 3))).FatturaElettronicaBody.DatiBeniServizi.DettaglioLinee;
    assert.deepEqual(goods.map((entry) => [entry.NumeroLinea, show(entry.Quantita)]), [[1, '2.00'], [2, '3.00']]);
    assert.deepEqual(problems(lines(line({}, 0))), ['FatturaElettronicaBody.DatiBeniServizi.DettaglioLinee:missing']);
    assert.deepEqual(problems(lines()), ['FatturaElettronicaBody.DatiBeniServizi.DettaglioLinee:missing']);
  });

  it('reports the data a line lacks', () => {
    assert.deepEqual(problems(lines({ name: { it: ' ' }, qt: 1, price: {} })), ['records[0].name:missing', 'records[0].price.price:missing', 'records[0].price.tax:missing', 'FatturaElettronicaBody.DatiBeniServizi.DettaglioLinee:missing'].sort());
    assert.deepEqual(problems(lines({ name: { it: 'x' }, price: { price: 1, tax: 22 } })), ['records[0].qt:missing', 'FatturaElettronicaBody.DatiBeniServizi.DettaglioLinee:missing'].sort());
  });

  it('reports a line that lacks only its price, or only its rate', () => {
    assert.deepEqual(problems(lines({ name: { it: 'x' }, qt: 1, price: { tax: 22 } })), ['FatturaElettronicaBody.DatiBeniServizi.DettaglioLinee:missing', 'records[0].price.price:missing']);
    assert.deepEqual(problems(lines({ name: { it: 'x' }, qt: 1, price: { price: 3 } })), ['FatturaElettronicaBody.DatiBeniServizi.DettaglioLinee:missing', 'records[0].price.tax:missing']);
  });

  it('refuses a rate that is not a percentage (check 00424) and a discount out of range', () => {
    assert.deepEqual(problems(lines(line({ tax: 0.22 }))), ['records[0].price.tax:invalid']);
    assert.deepEqual(problems(lines(line({ tax: 101 }))), ['records[0].price.tax:invalid']);
    assert.deepEqual(problems(lines(line({ tax: -1 }))), ['records[0].price.tax:invalid']);
    assert.deepEqual(problems(lines(line({ discount: 101 }))), ['records[0].price.discount:invalid']);
    assert.deepEqual(problems(lines(line({ discount: -1 }))), ['records[0].price.discount:invalid']);
    assert.ok(map(lines(line({ tax: 100 }))).ok);
    assert.ok(map(lines(line({ tax: 1 }))).ok);
  });

  it('writes the nature only with a zero rate, which then requires a valid one', () => {
    const zero = (natura: string): Record<string, unknown> => ({ tax: 0, taxData: { id: 'z', value: 0, description: 'Norma', natura } });
    assert.equal(ordinary(lines(line(zero(' n4 ')))).FatturaElettronicaBody.DatiBeniServizi.DettaglioLinee[0]?.Natura, 'N4');
    assert.deepEqual(problems(lines(line(zero('')))), ['records[0].price.taxData.natura:missing']);
    assert.deepEqual(problems(lines(line(zero('N9')))), ['records[0].price.taxData.natura:invalid']);
    const taxed = ordinary(lines(line({ taxData: { id: 'a', value: 22, description: 'ignored', natura: 'N4' } }))).FatturaElettronicaBody.DatiBeniServizi;
    assert.equal(taxed.DettaglioLinee[0]?.Natura, undefined);
    assert.equal(taxed.DatiRiepilogo[0]?.Natura, undefined);
    assert.equal(taxed.DatiRiepilogo[0]?.RiferimentoNormativo, undefined);
  });

  it('groups by rate and nature and takes the legal reference of a zero rate from the tax data', () => {
    const riepilogo = ordinary(fixtures['zero-rate-with-nature']?.()).FatturaElettronicaBody.DatiBeniServizi.DatiRiepilogo;
    assert.deepEqual(riepilogo.map((row) => [show(row.AliquotaIVA), row.Natura, show(row.ImponibileImporto), show(row.Imposta), row.RiferimentoNormativo]), [
      ['0.00', 'N4', '12.00', '0.00', 'Esente art. 10 n. 20 DPR 633/72'],
      ['22.00', undefined, '1.50', '0.33', undefined],
    ]);
    const merged = ordinary(
      lines(
        line({ tax: 0, taxData: { id: 'z', value: 0, description: '', natura: 'N4' } }),
        line({ tax: 0, taxData: { id: 'z', value: 0, description: 'Primo', natura: 'N4' } }),
        line({ tax: 0, taxData: { id: 'z', value: 0, description: 'Secondo', natura: 'N4' } }),
        line({ tax: 0, taxData: { id: 'z', value: 0, description: '', natura: 'N2.2' } }),
      ),
    ).FatturaElettronicaBody.DatiBeniServizi.DatiRiepilogo;
    assert.deepEqual(merged.map((row) => [row.Natura, show(row.ImponibileImporto), row.RiferimentoNormativo]), [['N4', '30.00', 'Primo'], ['N2.2', '10.00', undefined]]);
  });

  it('bakes the line discount into the unit price and rounds like the SdI', () => {
    const detail = ordinary(lines(line({ price: 10.333333, discount: 5 }, 3))).FatturaElettronicaBody.DatiBeniServizi.DettaglioLinee[0];
    assert.equal(show(detail?.PrezzoUnitario), '9.81666635');
    assert.equal(show(detail?.PrezzoTotale), '29.44999905');
    assert.equal(detail?.ScontoMaggiorazione, undefined);
  });

  it('carries the additional management data of a line', () => {
    const detail = ordinary(fixtures['optional-blocks']?.()).FatturaElettronicaBody.DatiBeniServizi.DettaglioLinee[0];
    assert.deepEqual(detail?.AltriDatiGestionali, [{ TipoDato: 'ORDINE', RiferimentoTesto: 'Rif. 12', RiferimentoData: '2026-11-01' }]);
    const sparse = ordinary(lines({ ...line(), XML: { AltriDatiGestionali: [{ TipoDato: '' }, { TipoDato: 'SOLOTIPO' }] } }));
    assert.deepEqual(sparse.FatturaElettronicaBody.DatiBeniServizi.DettaglioLinee[0]?.AltriDatiGestionali, [{ TipoDato: 'SOLOTIPO' }]);
    assert.deepEqual(problems(lines({ ...line(), XML: { AltriDatiGestionali: [{ TipoDato: 'TOOLONGTYPE1' }] } })), ['records[0].XML.AltriDatiGestionali[0].TipoDato:invalid']);
  });

  it('turns the lines of a full meal into one line at 10%', () => {
    const goods = ordinary(fixtures['full-meal']?.()).FatturaElettronicaBody.DatiBeniServizi;
    assert.deepEqual(goods.DettaglioLinee.map((entry) => [entry.Descrizione, show(entry.Quantita), show(entry.PrezzoUnitario), show(entry.PrezzoTotale), show(entry.AliquotaIVA)]), [['Pasto completo', '3.00', '30.00', '90.00', '10.00']]);
    assert.deepEqual(goods.DatiRiepilogo.map((row) => [show(row.ImponibileImporto), show(row.Imposta)]), [['90.00', '9.00']]);
  });

  it('counts a full meal without quantity, or with zero, as one meal', () => {
    for (const quantity of [undefined, 0]) {
      const goods = ordinary(change({ 'sale.fullMeal': { status: true, quantity }, totalTaxableWithoutDiscount: 90 })).FatturaElettronicaBody.DatiBeniServizi;
      assert.equal(show(goods.DettaglioLinee[0]?.Quantita), '1.00');
      assert.equal(show(goods.DettaglioLinee[0]?.PrezzoUnitario), '90.00');
    }
  });

  it('reports a full meal that cannot be priced', () => {
    assert.deepEqual(problems(change({ 'sale.fullMeal': { status: true, quantity: 2 }, totalTaxableWithoutDiscount: undefined })), ['totalTaxableWithoutDiscount:missing', 'FatturaElettronicaBody.DatiBeniServizi.DettaglioLinee:missing'].sort());
    assert.deepEqual(problems(change({ 'sale.fullMeal': { status: true, quantity: -2 }, totalTaxableWithoutDiscount: 5 })), ['sale.fullMeal.quantity:invalid', 'FatturaElettronicaBody.DatiBeniServizi.DettaglioLinee:missing'].sort());
  });
});

describe('mapQueueRecord: document discount', () => {
  const detail = (record: RecordData) => ordinary(record).FatturaElettronicaBody;

  it('spreads the discount over the lines, in cascade, when the company asks for it', () => {
    const body = detail(fixtures['line-discount-and-spread-document-discount']?.() as RecordData);
    assert.equal(body.DatiGenerali.DatiGeneraliDocumento.ScontoMaggiorazione, undefined);
    assert.deepEqual(body.DatiBeniServizi.DettaglioLinee.map((entry) => entry.ScontoMaggiorazione?.map((block) => [block.Tipo, show(block.Percentuale), block.Importo])), [[['SC', '10.00', undefined]], [['SC', '10.00', undefined]]]);
    assert.deepEqual(body.DatiBeniServizi.DatiRiepilogo.map((row) => [show(row.ImponibileImporto), show(row.Imposta)]), [['26.50', '2.65'], ['15.12', '3.33']]);
  });

  const goodsLine = (price: number, tax: number, natura = '', description = ''): Record<string, unknown> => ({ name: { it: 'Merce' }, qt: 1, price: { price, tax, taxData: { natura, description } } });
  const adjustments = (record: RecordData) => ordinary(record).FatturaElettronicaBody.DatiBeniServizi.DettaglioLinee.filter((entry) => entry.Descrizione === 'Sconto' || entry.Descrizione === 'Maggiorazione');

  it('turns a discount that is not spread into one negative line per VAT summary, never a document-level block', () => {
    const body = detail(fixtures['document-discount-not-spread']?.() as RecordData);
    assert.equal(body.DatiGenerali.DatiGeneraliDocumento.ScontoMaggiorazione, undefined);
    assert.deepEqual(body.DatiBeniServizi.DettaglioLinee.map((entry) => [entry.NumeroLinea, entry.Descrizione, show(entry.Quantita), show(entry.PrezzoUnitario), show(entry.PrezzoTotale), show(entry.AliquotaIVA), entry.ScontoMaggiorazione]), [
      [1, 'Caffè espresso', '2.00', '0.81967213', '1.63934426', '22.00', undefined],
      [2, 'Cornetto', '1.00', '0.90909091', '0.90909091', '10.00', undefined],
      [3, 'Sconto', '1.00', '-0.19', '-0.19', '22.00', undefined],
      [4, 'Sconto', '1.00', '-0.11', '-0.11', '10.00', undefined],
    ]);
    assert.deepEqual(body.DatiBeniServizi.DatiRiepilogo.map((row) => [show(row.ImponibileImporto), show(row.Imposta)]), [['1.45', '0.32'], ['0.80', '0.08']]);
  });

  it('keeps ImportoTotaleDocumento within a cent of the sum of the summaries, for every fixture', () => {
    for (const [name, make] of Object.entries(fixtures)) {
      const result = map(make());
      assert.ok(result.ok, name);
      if (result.model.versione === 'FSM10') {
        continue;
      }
      const body = (result.model as FatturaElettronica).FatturaElettronicaBody;
      const sum = body.DatiBeniServizi.DatiRiepilogo.reduce((total, row) => total + row.ImponibileImporto.units + row.Imposta.units, 0n);
      const total = body.DatiGenerali.DatiGeneraliDocumento.ImportoTotaleDocumento?.units ?? 0n;
      assert.ok(sum - total <= 1n && total - sum <= 1n, `${name}: ${sum} against ${total}`);
    }
  });

  it('splits the amount by largest remainder, so the shares add up exactly, and gives a tie to the earlier summary', () => {
    const lines = [goodsLine(10, 22), goodsLine(10, 10)];
    const shares = (value: number): string[] => adjustments(change({ discountPercentage: 5, discountValue: value, records: lines })).map((entry) => show(entry.PrezzoTotale) as string);
    assert.deepEqual(shares(0.01), ['-0.01']);
    assert.deepEqual(shares(0.03), ['-0.02', '-0.01']);
    assert.deepEqual(shares(1), ['-0.50', '-0.50']);
    const three = adjustments(change({ discountPercentage: 5, discountValue: 1, records: [goodsLine(1, 22), goodsLine(1, 10), goodsLine(1, 4)] }));
    assert.deepEqual(three.map((entry) => show(entry.PrezzoTotale)), ['-0.34', '-0.33', '-0.33']);
  });

  it('uses the percentage of the goods when the record has no amount, and a surcharge adds positive lines', () => {
    const percent = adjustments(change({ discountPercentage: 5, discountValue: undefined }));
    assert.deepEqual(percent.map((entry) => show(entry.PrezzoTotale)), ['-0.08', '-0.05']);
    const surcharge = adjustments(change({ discountPercentage: 12.5, discountValue: 0, 'XML.FatturaElettronicaBody.DatiGenerali.DatiGeneraliDocumento.ScontoMaggiorazione.Tipo': 'mg' }));
    assert.deepEqual(surcharge.map((entry) => [entry.Descrizione, show(entry.PrezzoTotale)]), [['Maggiorazione', '0.21'], ['Maggiorazione', '0.11']]);
  });

  it('gives no line to a summary whose share is zero, and carries nature and legal reference', () => {
    const lines = [goodsLine(1000, 0, 'N4', 'Esente art. 10'), goodsLine(0.01, 22)];
    const result = adjustments(change({ discountPercentage: 1, discountValue: 0.5, records: lines }));
    assert.deepEqual(result.map((entry) => [show(entry.PrezzoTotale), entry.Natura, entry.AliquotaIVA.units]), [['-0.50', 'N4', 0n]]);
    const summary = ordinary(change({ discountPercentage: 1, discountValue: 0.5, records: lines })).FatturaElettronicaBody.DatiBeniServizi.DatiRiepilogo;
    assert.deepEqual(summary.map((row) => [row.Natura, show(row.ImponibileImporto), row.RiferimentoNormativo]), [['N4', '999.50', 'Esente art. 10'], [undefined, '0.01', undefined]]);
  });

  it('cannot allocate a discount over summaries that have no positive taxable amount', () => {
    assert.deepEqual(problems(change({ discountPercentage: 5, discountValue: 1, records: [goodsLine(0, 22)] })), ['discountValue:invalid']);
    assert.deepEqual(problems(change({ discountPercentage: 5, discountValue: 1, records: [goodsLine(10, 22), goodsLine(-20, 10)] })), ['discountValue:invalid']);
  });

  it('increases the lines for a spread surcharge', () => {
    const body = detail(change({ 'company.settings.global.discountLines': true, discountPercentage: 10, 'XML.FatturaElettronicaBody.DatiGenerali.DatiGeneraliDocumento.ScontoMaggiorazione.Tipo': 'MG' }));
    assert.equal(show(body.DatiBeniServizi.DettaglioLinee[1]?.PrezzoTotale), '1.00000000'.replace('1.00000000', '1.00'));
    assert.equal(body.DatiBeniServizi.DettaglioLinee[0]?.ScontoMaggiorazione?.[0]?.Tipo, 'MG');
  });

  it('counts a record without discount fields as having no discount', () => {
    assert.equal(detail(change({ discountPercentage: undefined, discountValue: undefined })).DatiBeniServizi.DettaglioLinee.length, 2);
  });

  it('ignores a percentage that rounds to zero and refuses one out of range or a bad type', () => {
    assert.equal(detail(change({ discountPercentage: 0.004 })).DatiBeniServizi.DettaglioLinee.length, 2);
    assert.deepEqual(problems(change({ discountPercentage: 150 })), ['discountPercentage:invalid']);
    assert.deepEqual(problems(change({ discountPercentage: -5 })), ['discountPercentage:invalid']);
    assert.deepEqual(problems(change({ discountPercentage: 5, 'XML.FatturaElettronicaBody.DatiGenerali.DatiGeneraliDocumento.ScontoMaggiorazione.Tipo': 'XX' })), ['XML.FatturaElettronicaBody.DatiGenerali.DatiGeneraliDocumento.ScontoMaggiorazione.Tipo:invalid']);
  });
});

describe('mapQueueRecord: split payment', () => {
  it('marks the summaries with S and the legal reference, except for the N6 natures', () => {
    const rows = ordinary(fixtures['public-administration-split-payment']?.()).FatturaElettronicaBody.DatiBeniServizi.DatiRiepilogo;
    assert.deepEqual(rows.map((row) => [row.EsigibilitaIVA, row.RiferimentoNormativo]), [['S', 'ex art 17-ter DPR 633/72'], ['S', 'ex art 17-ter DPR 633/72']]);
    const reverse = withValues(fixtures['zero-rate-with-nature']?.() as RecordData, {
      'records.0.price.taxData.natura': 'N6.3',
      'XML.FatturaElettronicaBody.DatiBeniServizi.DatiRiepilogo.EsigibilitaIVA': 'S',
    });
    const mixed = ordinary({ ...reverse, records: [{ name: { it: 'Lavori' }, qt: 1, price: { price: 5, tax: 0, taxData: { natura: 'N6.3', description: 'Inversione contabile' } } }, { name: { it: 'Caffè' }, qt: 1, price: { price: 1.5, tax: 22 } }] });
    assert.deepEqual(mixed.FatturaElettronicaBody.DatiBeniServizi.DatiRiepilogo.map((row) => [row.Natura, row.EsigibilitaIVA, row.RiferimentoNormativo]), [['N6.3', 'I', 'Inversione contabile'], [undefined, 'S', 'ex art 17-ter DPR 633/72']]);
  });
});

describe('mapQueueRecord: optional blocks', () => {
  const body = (values: Record<string, unknown>) => ordinary(change(values)).FatturaElettronicaBody;
  const general = 'XML.FatturaElettronicaBody.DatiGenerali';
  const orders = `${GENERAL}.DatiOrdineAcquisto`;
  const transport = `${GENERAL}.DatiTrasporto`;
  const payments = 'FatturaElettronicaBody.DatiPagamento';

  it('writes purchase orders only for a row with a CUP or a CIG, and requires its document id', () => {
    assert.equal(body({ [`${general}.DatiOrdineAcquisto`]: { IdDocumento: 'X' } }).DatiGenerali.DatiOrdineAcquisto, undefined);
    assert.deepEqual(body({ [`${general}.DatiOrdineAcquisto`]: [{ IdDocumento: 'X', Data: '2026-01-02', CodiceCUP: 'CUP1' }, { IdDocumento: 'Y', CodiceCIG: 'CIG1' }] }).DatiGenerali.DatiOrdineAcquisto, [
      { IdDocumento: 'X', Data: '2026-01-02', CodiceCUP: 'CUP1' },
      { IdDocumento: 'Y', CodiceCIG: 'CIG1' },
    ]);
    assert.deepEqual(problems(change({ [`${general}.DatiOrdineAcquisto`]: { CodiceCIG: 'CIG1' } })), [`${orders}[0].IdDocumento:missing`]);
    assert.deepEqual(problems(change({ [`${general}.DatiOrdineAcquisto`]: [{ IdDocumento: 'X', CodiceCIG: 'C'.repeat(16) }] })), [`${orders}[0].CodiceCIG:invalid`]);
  });

  it('writes the linked invoices that have a document id', () => {
    const linked = body({ [`${general}.DatiFattureCollegate`]: [{ IdDocumento: ' 41 ', Data: '2026-11-20' }, { Data: '2026-01-01' }, { IdDocumento: '42' }] }).DatiGenerali.DatiFattureCollegate;
    assert.deepEqual(linked, [{ IdDocumento: '41', Data: '2026-11-20' }, { IdDocumento: '42' }]);
    assert.deepEqual(problems(change({ [`${general}.DatiFattureCollegate`]: [{ IdDocumento: 'x'.repeat(21) }] })), [`${GENERAL}.DatiFattureCollegate[0].IdDocumento:invalid`]);
    assert.equal(ordinary(fixtures['credit-note']?.()).FatturaElettronicaBody.DatiGenerali.DatiFattureCollegate?.[0]?.IdDocumento, '41');
    assert.equal(ordinary(change({ type: 'credit-note', 'fattura_elettronica.tipo': 'TD04', fromDocumentId: 'abc' })).FatturaElettronicaBody.DatiGenerali.DatiFattureCollegate, undefined);
  });

  it('writes the whole transport block when the record has it', () => {
    const block = ordinary(fixtures['optional-blocks']?.()).FatturaElettronicaBody.DatiGenerali.DatiTrasporto;
    assert.deepEqual({ ...block, PesoLordo: show(block?.PesoLordo), PesoNetto: show(block?.PesoNetto) }, {
      DatiAnagraficiVettore: { IdFiscaleIVA: { IdPaese: 'IT', IdCodice: '01111111111' }, Anagrafica: { Denominazione: 'Corriere Veloce S.r.l.' } },
      MezzoTrasporto: 'Furgone',
      CausaleTrasporto: 'Vendita',
      NumeroColli: 2,
      Descrizione: 'Scatole',
      UnitaMisuraPeso: 'KG',
      PesoLordo: '12.50',
      PesoNetto: '11.00',
      DataOraRitiro: '2026-11-26T09:00:00.000Z',
      DataInizioTrasporto: '2026-11-26',
      TipoResa: 'EXW',
      IndirizzoResa: { Indirizzo: 'Via Napoli', NumeroCivico: '3', CAP: '80100', Comune: 'Napoli', Provincia: 'NA', Nazione: 'IT' },
      DataOraConsegna: '2026-11-27T15:30:00.000Z',
    });
    assert.equal(body({}).DatiGenerali.DatiTrasporto, undefined);
  });

  it('accepts a carrier that is a person, with title and EORI code', () => {
    const carrier = body({ [`${general}.DatiTrasporto`]: { DatiAnagraficiVettore: { IdFiscaleIVA: { IdPaese: 'it', IdCodice: '02' }, CodiceFiscale: 'rssmra80a01h501u', Anagrafica: { Nome: 'Gino', Cognome: 'Bianchi', Titolo: 'Sig.', CodEORI: 'IT12345678901234' }, NumeroLicenzaGuida: 'AB123' } } }).DatiGenerali.DatiTrasporto?.DatiAnagraficiVettore;
    assert.deepEqual(carrier, {
      IdFiscaleIVA: { IdPaese: 'IT', IdCodice: '02' },
      CodiceFiscale: 'RSSMRA80A01H501U',
      Anagrafica: { Nome: 'Gino', Cognome: 'Bianchi', Titolo: 'Sig.', CodEORI: 'IT12345678901234' },
      NumeroLicenzaGuida: 'AB123',
    });
  });

  it('reports an incomplete carrier, a wrong weight or number of packages, and a partial delivery address', () => {
    const carrier = `${transport}.DatiAnagraficiVettore`;
    assert.deepEqual(problems(change({ [`${general}.DatiTrasporto`]: { DatiAnagraficiVettore: { CodiceFiscale: 'RSSMRA80A01H501U' } } })), [`${carrier}.Anagrafica:missing`, `${carrier}.IdFiscaleIVA.IdCodice:missing`, `${carrier}.IdFiscaleIVA.IdPaese:missing`]);
    assert.deepEqual(problems(change({ [`${general}.DatiTrasporto`]: { DatiAnagraficiVettore: { IdFiscaleIVA: { IdPaese: 'IT', IdCodice: '1' }, Anagrafica: { Nome: 'Solo' } } } })), [`${carrier}.Anagrafica:missing`]);
    assert.deepEqual(problems(change({ [`${general}.DatiTrasporto`]: { DatiAnagraficiVettore: { IdFiscaleIVA: { IdPaese: 'IT', IdCodice: '1' }, Anagrafica: { Denominazione: 'X', Titolo: 'S', CodEORI: '1' }, CodiceFiscale: 'ab' } } })), [`${carrier}.Anagrafica.CodEORI:invalid`, `${carrier}.Anagrafica.Titolo:invalid`, `${carrier}.CodiceFiscale:invalid`]);
    assert.deepEqual(problems(change({ [`${general}.DatiTrasporto`]: { PesoLordo: -1, PesoNetto: 10000, NumeroColli: 1.5, TipoResa: 'EX' } })), [`${transport}.NumeroColli:invalid`, `${transport}.PesoLordo:invalid`, `${transport}.PesoNetto:invalid`, `${transport}.TipoResa:invalid`]);
    assert.deepEqual(problems(change({ [`${general}.DatiTrasporto`]: { NumeroColli: 0 } })), [`${transport}.NumeroColli:invalid`]);
    assert.deepEqual(problems(change({ [`${general}.DatiTrasporto`]: { NumeroColli: 10000 } })), [`${transport}.NumeroColli:invalid`]);
    assert.deepEqual(problems(change({ [`${general}.DatiTrasporto`]: { IndirizzoResa: { Comune: 'Napoli' } } })), [`${transport}.IndirizzoResa.Indirizzo:missing`, `${transport}.IndirizzoResa.Nazione:missing`]);
  });

  it('writes the rectified invoice of a simplified credit note, with date and elements required', () => {
    const rectified = simplified(fixtures['simplified-td08-rectified']?.()).FatturaElettronicaBody.DatiGenerali.DatiFatturaRettificata;
    assert.deepEqual(rectified, { NumeroFR: '40', DataFR: '2026-10-30', ElementiRettificati: 'Importo e aliquota' });
    assert.equal(simplified(change({ 'fattura_elettronica.tipo': 'TD07' })).FatturaElettronicaBody.DatiGenerali.DatiFatturaRettificata, undefined);
    assert.deepEqual(problems(change({ 'fattura_elettronica.tipo': 'TD08', [`${general}.DatiFatturaRettificata`]: { NumeroFR: '40' } })), [`${GENERAL}.DatiFatturaRettificata.DataFR:missing`, `${GENERAL}.DatiFatturaRettificata.ElementiRettificati:missing`]);
  });

  it('writes the payment data when there are conditions and at least one complete row', () => {
    const data = ordinary(fixtures['optional-blocks']?.()).FatturaElettronicaBody.DatiPagamento;
    assert.equal(data?.length, 1);
    assert.equal(data?.[0]?.CondizioniPagamento, 'TP02');
    assert.equal(data?.[0]?.DettaglioPagamento.length, 1);
    const detail = data?.[0]?.DettaglioPagamento[0];
    assert.deepEqual({ ...detail, ImportoPagamento: show(detail?.ImportoPagamento) }, {
      Beneficiario: 'Bar Esempio S.r.l.',
      ModalitaPagamento: 'MP05',
      DataScadenzaPagamento: '2026-12-27',
      ImportoPagamento: '73.20',
      IstitutoFinanziario: 'Banca Esempio',
      IBAN: 'IT60X0542811101000000123456',
      ABI: '05428',
      CAB: '11101',
      BIC: 'BEPIIT22XXX',
    });
  });

  it('omits the payment block without conditions or without rows, and reports a row with half of its data', () => {
    const rows = [{ ModalitaPagamento: 'MP01', ImportoPagamento: 1 }];
    assert.equal(body({ [`${general.replace('DatiGenerali', 'DatiPagamento')}`]: { DettaglioPagamento: rows } }).DatiPagamento, undefined);
    assert.equal(body({ [`${general.replace('DatiGenerali', 'DatiPagamento')}`]: { CondizioniPagamento: 'TP02' } }).DatiPagamento, undefined);
    assert.equal(body({ [`${general.replace('DatiGenerali', 'DatiPagamento')}`]: { CondizioniPagamento: 'tp02', DettaglioPagamento: rows } }).DatiPagamento?.[0]?.CondizioniPagamento, 'TP02');
    const path = 'XML.FatturaElettronicaBody.DatiPagamento';
    assert.deepEqual(problems(change({ [path]: { CondizioniPagamento: 'TP02', DettaglioPagamento: [{ ModalitaPagamento: 'MP01' }] } })), [`${payments}.DettaglioPagamento[0].ImportoPagamento:missing`]);
    assert.deepEqual(problems(change({ [path]: { CondizioniPagamento: 'TP02', DettaglioPagamento: [{ ImportoPagamento: 5 }] } })), [`${payments}.DettaglioPagamento[0].ModalitaPagamento:missing`]);
    assert.deepEqual(problems(change({ [path]: { CondizioniPagamento: 'TP02VERYLONG', DettaglioPagamento: rows } })), [`${payments}.CondizioniPagamento:invalid`]);
  });
});

describe('mapQueueRecord: simplified invoice', () => {
  it('writes the seller flat, the buyer in two blocks and one block of goods per VAT rate, tax included', () => {
    const model = simplified(fixtures['simplified-td07']?.());
    assert.equal(model.FatturaElettronicaHeader.DatiTrasmissione.FormatoTrasmissione, 'FSM10');
    assert.deepEqual(model.FatturaElettronicaHeader.CedentePrestatore, {
      IdFiscaleIVA: { IdPaese: 'IT', IdCodice: '01234567890' },
      CodiceFiscale: '01234567890',
      Denominazione: 'Bar Esempio S.r.l.',
      Sede: { Indirizzo: 'Via Roma 1', CAP: '00100', Comune: 'Roma', Provincia: 'RM', Nazione: 'IT' },
      RegimeFiscale: 'RF01',
    });
    assert.deepEqual(model.FatturaElettronicaHeader.CessionarioCommittente.IdentificativiFiscali, { CodiceFiscale: 'RSSMRA80A01H501U' });
    assert.deepEqual(model.FatturaElettronicaHeader.CessionarioCommittente.AltriDatiIdentificativi, {
      Nome: 'Mario',
      Cognome: 'Rossi',
      Sede: { Indirizzo: 'Via Milano 10', CAP: '20100', Comune: 'Milano', Provincia: 'MI', Nazione: 'IT' },
    });
    assert.deepEqual(model.FatturaElettronicaBody.DatiBeniServizi.map((block) => [block.Descrizione, show(block.Importo), show(block.DatiIVA.Aliquota), block.DatiIVA.Imposta]), [
      ['Caffè espresso', '2.00', '22.00', undefined],
      ['Cornetto', '1.00', '10.00', undefined],
    ]);
    assert.deepEqual(model.FatturaElettronicaBody.DatiGenerali.DatiGeneraliDocumento, { TipoDocumento: 'TD07', Divisa: 'EUR', Data: '2026-11-27', Numero: '42' });
  });

  it('spreads the document discount over the amounts, joins descriptions and keeps the nature', () => {
    const model = simplified(
      change({
        'fattura_elettronica.tipo': 'TD09',
        discountPercentage: 50,
        records: [
          { name: { it: 'Uno' }, qt: 1, price: { price: 10, tax: 0, taxData: { natura: 'N4', description: 'Esente' } } },
          { name: { it: 'Due' }, qt: 1, price: { price: 20, tax: 0, taxData: { natura: 'N4' } } },
          { name: { it: 'Uno' }, qt: 1, price: { price: 2, tax: 22 } },
        ],
      }),
    );
    assert.deepEqual(model.FatturaElettronicaBody.DatiBeniServizi.map((block) => [block.Descrizione, show(block.Importo), block.Natura, block.RiferimentoNormativo]), [
      ['Uno; Due', '15.00', 'N4', 'Esente'],
      ['Uno', '1.22', undefined, undefined],
    ]);
  });

  it('reports the same data problems as the ordinary format', () => {
    assert.deepEqual(problems(change({ 'fattura_elettronica.tipo': 'TD07', 'counterpart.code': '' })), [`${BUYER}.DatiAnagrafici.CodiceFiscale:missing`]);
  });
});

describe('mapQueueRecord: text', () => {
  it('writes a text outside the repertoire as ? and reports it as a warning, not as a problem', () => {
    const result = map(fixtures['texts-with-special-characters']?.());
    assert.ok(result.ok && result.model.versione !== 'FSM10');
    assert.deepEqual(result.warnings.map((warning) => `${warning.path}:${warning.warning}`).sort(), [`${DOCUMENT}.Causale:unrepresentable`, 'records[0].name:unrepresentable']);
    const model = result.model as FatturaElettronica;
    assert.equal(model.FatturaElettronicaHeader.CessionarioCommittente.DatiAnagrafici.Anagrafica && 'Cognome' in model.FatturaElettronicaHeader.CessionarioCommittente.DatiAnagrafici.Anagrafica ? model.FatturaElettronicaHeader.CessionarioCommittente.DatiAnagrafici.Anagrafica.Cognome : '', "D'Angelo-Skoda");
  });

  it('cuts a text at the limit of its field and reports it, keeping the identifiers intact', () => {
    const result = map(change({ 'company.name': 'N'.repeat(100) }));
    assert.ok(result.ok);
    assert.deepEqual(result.warnings, [{ path: `${SELLER}.DatiAnagrafici.Anagrafica.Denominazione`, warning: 'truncated' }]);
    assert.deepEqual(problems(change({ number: '1'.repeat(21) })), [`${DOCUMENT}.Numero:invalid`]);
  });
});

describe('mapQueueRecord: the linkedInvoice option (original of a credit note, read by the engine)', () => {
  const creditNote = (values: Record<string, unknown> = {}): RecordData => change({ type: 'credit-note', 'fattura_elettronica.tipo': 'TD04', fromDocumentId: 'abc', ...values });
  const linkedOf = (record: RecordData, linkedInvoice: { number: string; prefixSuffix: string; date: Date | null }) => {
    const result = mapQueueRecord(record, { transmitter: TRANSMITTER, linkedInvoice });
    assert.ok(result.ok, JSON.stringify(result.ok ? [] : result.issues));
    return (result.model as FatturaElettronica).FatturaElettronicaBody.DatiGenerali.DatiFattureCollegate;
  };

  it('writes the original with the company numbering and the date in the Rome time zone', () => {
    const original = { number: '12', prefixSuffix: 'A/', date: new Date('2026-11-20T23:30:00.000Z') };
    assert.deepEqual(linkedOf(creditNote(), original), [{ IdDocumento: '12', Data: '2026-11-21' }]);
    assert.deepEqual(linkedOf(creditNote({ 'company.invoicesPS': 'prefix' }), original), [{ IdDocumento: 'A/12', Data: '2026-11-21' }]);
    assert.deepEqual(linkedOf(creditNote({ 'company.invoicesPS': 'suffix', prefixSuffix: '' }), { ...original, prefixSuffix: '/B' }), [{ IdDocumento: '12/B', Data: '2026-11-21' }]);
  });

  it('leaves the date out when the original has none', () => {
    assert.deepEqual(linkedOf(creditNote(), { number: '12', prefixSuffix: '', date: null }), [{ IdDocumento: '12' }]);
  });

  it('lets what the user typed in the form win', () => {
    const typed = creditNote({ XML: { FatturaElettronicaBody: { DatiGenerali: { DatiFattureCollegate: [{ IdDocumento: '41', Data: '2026-11-20' }] } } } });
    assert.deepEqual(linkedOf(typed, { number: '12', prefixSuffix: '', date: null }), [{ IdDocumento: '41', Data: '2026-11-20' }]);
  });

  it('reports an original whose number cannot be written, without the value', () => {
    for (const number of ['', 'x1']) {
      const result = mapQueueRecord(creditNote(), { transmitter: TRANSMITTER, linkedInvoice: { number, prefixSuffix: '', date: null } });
      assert.equal(result.ok, false);
      assert.deepEqual(result.ok ? [] : result.issues.map((issue) => `${issue.path}:${issue.issue}`), [`${GENERAL}.DatiFattureCollegate[0].IdDocumento:${number === '' ? 'missing' : 'invalid'}`]);
    }
  });

  it('is ignored by the simplified format, and absent means no block', () => {
    const result = mapQueueRecord(creditNote({ 'fattura_elettronica.tipo': 'TD07' }), { transmitter: TRANSMITTER, linkedInvoice: { number: '12', prefixSuffix: '', date: null } });
    assert.ok(result.ok);
    assert.equal(result.model.versione, 'FSM10');
    assert.equal(ordinary(creditNote()).FatturaElettronicaBody.DatiGenerali.DatiFattureCollegate, undefined);
  });
});
