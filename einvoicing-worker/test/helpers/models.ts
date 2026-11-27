/**
 * Invoice models for the validator tests, built by the real mapper from the EI3 fixtures.
 *
 * The EI3 fixtures use invented fiscal identifiers that do not satisfy the official check digit (they exist to test
 * the mapping and the XSD, not the registry). The validator does check the digit, so {@link modelOf} replaces those
 * identifiers with synthetic ones that are checksum-valid. Everything here is invented data.
 */
import assert from 'node:assert/strict';
import { parseDecimal } from '../../src/invoice/decimal.ts';
import type { Decimal } from '../../src/invoice/decimal.ts';
import { mapQueueRecord } from '../../src/invoice/from-queue.ts';
import type { MappingWarning } from '../../src/invoice/from-queue.ts';
import type { FatturaElettronica, FatturaElettronicaSemplificata, InvoiceModel } from '../../src/invoice/model.ts';
import { fixtures } from '../fixtures/records.ts';

/** Transmitter used by the tests (valid VAT number). */
export const TRANSMITTER = { IdPaese: 'IT', IdCodice: '01879020517' };

/** Invented identifiers of the EI3 fixtures, mapped to checksum-valid invented ones. */
const VALID_IDS: Readonly<Record<string, string>> = {
  '01234567890': '01234567897',
  '09876543210': '09876543217',
  '80012345678': '80012345676',
};

function replaceIds(value: unknown): unknown {
  if (typeof value === 'string') {
    return VALID_IDS[value] ?? value;
  }
  if (Array.isArray(value)) {
    return value.map(replaceIds);
  }
  if (typeof value === 'object' && value !== null && !('units' in value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceIds(item)]));
  }
  return value;
}

/** A mapped fixture: the model (with valid synthetic identifiers) and the mapping warnings. */
export function mapped(name: string): { readonly model: InvoiceModel; readonly warnings: readonly MappingWarning[] } {
  const make = fixtures[name];
  assert.ok(make !== undefined, name);
  const result = mapQueueRecord(make(), { transmitter: TRANSMITTER });
  assert.ok(result.ok, `${name} does not map`);
  return { model: replaceIds(result.model) as InvoiceModel, warnings: result.warnings };
}

/** The model of a fixture. */
export function modelOf(name: string): InvoiceModel {
  return mapped(name).model;
}

/** An ordinary invoice (the base fixture: private buyer with a fiscal code, two lines, 22% and 10%). */
export function ordinary(name = 'private-recipient-code'): FatturaElettronica {
  const model = modelOf(name);
  assert.notEqual(model.versione, 'FSM10');
  return model as FatturaElettronica;
}

/** A simplified invoice (`TD08`, with the reference to the rectified invoice). */
export function simplified(name = 'simplified-td08-rectified'): FatturaElettronicaSemplificata {
  const model = modelOf(name);
  assert.equal(model.versione, 'FSM10');
  return model as FatturaElettronicaSemplificata;
}

/**
 * Clones a model and sets values by dotted path (`undefined` removes the key). Segments may be indexes; a path may
 * name a list element (`FatturaElettronicaBody.DatiBeniServizi.DettaglioLinee.0.Natura`).
 */
export function change<T extends InvoiceModel>(model: T, values: Readonly<Record<string, unknown>>): T {
  const copy = structuredClone(model) as unknown as Record<string, unknown>;
  for (const [path, value] of Object.entries(values)) {
    const keys = path.split('.');
    const last = keys.pop() as string;
    let target = copy;
    for (const key of keys) {
      const next = target[key];
      target = (typeof next === 'object' && next !== null ? next : (target[key] = {})) as Record<string, unknown>;
    }
    if (value === undefined) {
      delete target[last];
    } else {
      target[last] = value;
    }
  }
  return copy as unknown as T;
}

/** A decimal from its text (test shorthand). */
export function d(text: string): Decimal {
  const value = parseDecimal(text);
  assert.ok(value !== null, text);
  return value;
}

/**
 * An ordinary invoice that uses nearly every element of the model (register entry, titles, carrier, payment, linked
 * documents, discounts, causal), valid for the schema and for every check. It is the base of the mutation tests.
 */
export function rich(): FatturaElettronica {
  return change(ordinary('optional-blocks'), {
    'FatturaElettronicaHeader.DatiTrasmissione.CodiceDestinatario': '0000000',
    'FatturaElettronicaHeader.DatiTrasmissione.PECDestinatario': 'mario.rossi@pec.example.it',
    'FatturaElettronicaHeader.CedentePrestatore.DatiAnagrafici.Anagrafica': { Denominazione: 'Bar Esempio S.r.l.', Titolo: 'Dott.', CodEORI: 'IT12345678901234' },
    'FatturaElettronicaHeader.CedentePrestatore.Sede.NumeroCivico': '1/A',
    'FatturaElettronicaHeader.CedentePrestatore.IscrizioneREA': { Ufficio: 'RM', NumeroREA: '123456', CapitaleSociale: d('10000.00'), SocioUnico: 'SU', StatoLiquidazione: 'LN' },
    'FatturaElettronicaHeader.CedentePrestatore.RiferimentoAmministrazione': 'RIF-1',
    'FatturaElettronicaHeader.CessionarioCommittente.DatiAnagrafici.IdFiscaleIVA': { IdPaese: 'IT', IdCodice: '09876543217' },
    'FatturaElettronicaHeader.CessionarioCommittente.DatiAnagrafici.Anagrafica': { Nome: 'Mario', Cognome: 'Rossi', Titolo: 'Sig.', CodEORI: 'IT12345678901234' },
    'FatturaElettronicaBody.DatiGenerali.DatiGeneraliDocumento.ScontoMaggiorazione': [{ Tipo: 'SC', Importo: d('0.50') }],
    'FatturaElettronicaBody.DatiGenerali.DatiGeneraliDocumento.Causale': ['Prima nota', 'Seconda nota'],
    'FatturaElettronicaBody.DatiGenerali.DatiFattureCollegate': [{ IdDocumento: '41', Data: '2026-11-20', CodiceCUP: 'B11B20000010001', CodiceCIG: 'ZA12345678' }],
    'FatturaElettronicaBody.DatiGenerali.DatiTrasporto.DatiAnagraficiVettore': {
      IdFiscaleIVA: { IdPaese: 'IT', IdCodice: '01111111116' },
      CodiceFiscale: 'RSSMRA80A01H501U',
      Anagrafica: { Nome: 'Gino', Cognome: 'Bianchi' },
      NumeroLicenzaGuida: 'LIC123',
    },
    'FatturaElettronicaBody.DatiBeniServizi.DettaglioLinee.0.UnitaMisura': 'ORE',
    'FatturaElettronicaBody.DatiBeniServizi.DettaglioLinee.0.ScontoMaggiorazione': [{ Tipo: 'MG', Percentuale: d('0.00') }],
    'FatturaElettronicaBody.DatiPagamento.1': { CondizioniPagamento: 'TP01', DettaglioPagamento: [{ ModalitaPagamento: 'MP01', ImportoPagamento: d('1.00') }] },
  });
}

/** A simplified invoice that uses every element of the model, valid for the schema. */
export function richSimplified(): FatturaElettronicaSemplificata {
  return change(simplified(), {
    'FatturaElettronicaHeader.CedentePrestatore.Sede.NumeroCivico': '1/A',
    'FatturaElettronicaHeader.CedentePrestatore.IscrizioneREA': { Ufficio: 'RM', NumeroREA: '123456', CapitaleSociale: d('10000.00'), SocioUnico: 'SM', StatoLiquidazione: 'LS' },
    'FatturaElettronicaBody.DatiBeniServizi.1.DatiIVA': { Imposta: d('7.27'), Aliquota: d('10.00') },
    'FatturaElettronicaBody.DatiBeniServizi.1.RiferimentoNormativo': 'Rif. norma',
    'FatturaElettronicaBody.DatiBeniServizi.1.Natura': undefined,
  });
}
