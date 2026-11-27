import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Document } from 'mongodb';
import { reduceInvoiceXml } from '../../src/modules/sales/sales.invoice.xml.ts';

/** The domain checks of the partial FatturaPA object of the till (step VS5). */
const BANK = { id: 'b1', name: 'Banca Uno', iban: 'IT60X0542811101000000123456', abi: '05428', cab: '11101', bic: 'BPBAIT3B', default: true };
const company: Document = { name: 'Acme Spa', banks: [BANK, { name: 'x'.repeat(100), iban: 'IT00 0000 0000 0000 0000 0000 000', abi: 'x', cab: '', bic: 'bad!' }, 'junk', { iban: 'IT11 1111 1111 1111 1111 1111 111' }] };
const counterpart = (split = false): Document => ({ fattura_elettronica: { split_payment: split } });
const reduce = (body: Document, split = false) => reduceInvoiceXml({ FatturaElettronicaBody: body }, { company, counterpart: counterpart(split) });
const paths = (issues: { code: string; path: string }[]) => issues.map((issue) => `${issue.code}:${issue.path.replace('FatturaElettronicaBody.', '')}`);

describe('the XML of an invoice, checked by domain', () => {
  it('keeps the sections the invoice reads, whatever else the till sends, and says nothing when it is all right', () => {
    const result = reduceInvoiceXml(
      {
        FatturaElettronicaHeader: { Evil: 1 },
        FatturaElettronicaBody: {
          DatiGenerali: {
            DatiGeneraliDocumento: { Data: '2020-01-01', ScontoMaggiorazione: { Tipo: 'MG', Importo: 5 } },
            DatiOrdineAcquisto: { IdDocumento: 'ORD-1', Data: '2026-03-01', CodiceCIG: 'CIG1', Extra: 'x' },
            DatiTrasporto: {
              MezzoTrasporto: 'Van',
              NumeroColli: '3',
              PesoLordo: 12.5,
              PesoNetto: '10.25',
              DataOraRitiro: '2026-03-01T10:00:00',
              DataOraConsegna: '2026-03-02T10:00:00.5+01:00',
              DataInizioTrasporto: '2026-03-01',
              TipoResa: 'EXW',
              DatiAnagraficiVettore: { IdFiscaleIVA: { IdPaese: 'IT', IdCodice: '01234567890' }, Anagrafica: { Denominazione: 'Carrier' }, Secret: 1 },
              IndirizzoResa: { Indirizzo: 'Via 1', CAP: '20100', Comune: 'Milano', Provincia: 'MI', Nazione: 'IT', Hidden: true },
            },
          },
          DatiBeniServizi: { DatiRiepilogo: { EsigibilitaIVA: 'D', ImponibileImporto: '1' } },
          DatiPagamento: { CondizioniPagamento: 'TP02', DettaglioPagamento: [{ ModalitaPagamento: 'MP05', ImportoPagamento: '12.50', DataScadenzaPagamento: '2026-04-01', Other: 1 }], Other: 1 },
          DatiVeicoli: { Targa: 'AA000AA' },
        },
        Unknown: { a: 1 },
      },
      { company, counterpart: counterpart() },
    );
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.xml, {
      FatturaElettronicaBody: {
        DatiGenerali: {
          DatiGeneraliDocumento: { ScontoMaggiorazione: { Tipo: 'MG' } },
          DatiOrdineAcquisto: { IdDocumento: 'ORD-1', Data: '2026-03-01', CodiceCIG: 'CIG1' },
          DatiTrasporto: {
            DatiAnagraficiVettore: { IdFiscaleIVA: { IdPaese: 'IT', IdCodice: '01234567890' }, Anagrafica: { Denominazione: 'Carrier' } },
            MezzoTrasporto: 'Van',
            NumeroColli: '3',
            PesoLordo: 12.5,
            PesoNetto: '10.25',
            DataOraRitiro: '2026-03-01T10:00:00',
            DataInizioTrasporto: '2026-03-01',
            TipoResa: 'EXW',
            IndirizzoResa: { Indirizzo: 'Via 1', CAP: '20100', Comune: 'Milano', Provincia: 'MI', Nazione: 'IT' },
            DataOraConsegna: '2026-03-02T10:00:00.5+01:00',
          },
        },
        DatiBeniServizi: { DatiRiepilogo: { EsigibilitaIVA: 'D' } },
        DatiPagamento: { CondizioniPagamento: 'TP02', DettaglioPagamento: [{ Beneficiario: 'Acme Spa', ModalitaPagamento: 'MP05', DataScadenzaPagamento: '2026-04-01', ImportoPagamento: '12.50' }] },
      },
    });
  });

  it('keeps nothing, and reports nothing, for what is not there or is left blank', () => {
    for (const raw of [undefined, null, {}, { FatturaElettronicaBody: 'x' }, { FatturaElettronicaBody: { DatiVeicoli: {} } }, { FatturaElettronicaBody: { DatiGenerali: { DatiOrdineAcquisto: { IdDocumento: '', CodiceCIG: null, Data: undefined }, DatiTrasporto: 'x' } } }]) {
      assert.deepEqual(reduceInvoiceXml(raw, { company, counterpart: counterpart() }), { xml: null, issues: [] }, JSON.stringify(raw));
    }
  });

  it('drops and reports a value out of its domain: the codes of the standard, dates, numbers, characters and lengths', () => {
    const result = reduce({
      DatiGenerali: {
        DatiGeneraliDocumento: { ScontoMaggiorazione: { Tipo: 'XX' } },
        DatiOrdineAcquisto: { IdDocumento: 'a'.repeat(21), Data: '2026-02-30', CodiceCUP: 'a<b', CodiceCIG: 'a&b' },
        DatiTrasporto: {
          MezzoTrasporto: 'tab\there',
          CausaleTrasporto: 'okĀ',
          NumeroColli: 10_000,
          Descrizione: 5,
          PesoLordo: -1,
          PesoNetto: Infinity,
          UnitaMisuraPeso: 'x'.repeat(11),
          DataOraRitiro: 5,
          DataOraConsegna: '2026-13-01T10:00:00',
          DataInizioTrasporto: '01/03/2026',
          TipoResa: 'exw',
          IndirizzoResa: { CAP: '2010', Provincia: 'Milano', Nazione: 'it' },
          DatiAnagraficiVettore: { IdFiscaleIVA: { IdPaese: 'ITA' }, CodiceFiscale: 'short' },
        },
      },
      DatiBeniServizi: { DatiRiepilogo: { EsigibilitaIVA: 'X' } },
      DatiPagamento: { CondizioniPagamento: 'TP09', DettaglioPagamento: [{ ModalitaPagamento: 'MP24', ImportoPagamento: -5, DataScadenzaPagamento: 'soon' }, { ModalitaPagamento: 'MP23', ImportoPagamento: '1e9' }, { ImportoPagamento: 2e9 }, { ImportoPagamento: 1.5 }] },
    });
    assert.deepEqual(result.xml, { FatturaElettronicaBody: { DatiPagamento: { DettaglioPagamento: [{ Beneficiario: 'Acme Spa', ModalitaPagamento: 'MP23' }, { Beneficiario: 'Acme Spa', ImportoPagamento: 1.5 }] } } });
    assert.deepEqual(
      paths(result.issues).sort(),
      [
        'DatiGenerali.DatiGeneraliDocumento.ScontoMaggiorazione.Tipo',
        'DatiGenerali.DatiOrdineAcquisto.IdDocumento',
        'DatiGenerali.DatiOrdineAcquisto.Data',
        'DatiGenerali.DatiOrdineAcquisto.CodiceCUP',
        'DatiGenerali.DatiOrdineAcquisto.CodiceCIG',
        'DatiGenerali.DatiTrasporto.MezzoTrasporto',
        'DatiGenerali.DatiTrasporto.CausaleTrasporto',
        'DatiGenerali.DatiTrasporto.NumeroColli',
        'DatiGenerali.DatiTrasporto.Descrizione',
        'DatiGenerali.DatiTrasporto.PesoLordo',
        'DatiGenerali.DatiTrasporto.PesoNetto',
        'DatiGenerali.DatiTrasporto.UnitaMisuraPeso',
        'DatiGenerali.DatiTrasporto.DataOraRitiro',
        'DatiGenerali.DatiTrasporto.DataOraConsegna',
        'DatiGenerali.DatiTrasporto.DataInizioTrasporto',
        'DatiGenerali.DatiTrasporto.TipoResa',
        'DatiGenerali.DatiTrasporto.IndirizzoResa.CAP',
        'DatiGenerali.DatiTrasporto.IndirizzoResa.Provincia',
        'DatiGenerali.DatiTrasporto.IndirizzoResa.Nazione',
        'DatiGenerali.DatiTrasporto.DatiAnagraficiVettore.IdFiscaleIVA.IdPaese',
        'DatiGenerali.DatiTrasporto.DatiAnagraficiVettore.CodiceFiscale',
        'DatiBeniServizi.DatiRiepilogo.EsigibilitaIVA',
        'DatiPagamento.CondizioniPagamento',
        'DatiPagamento.DettaglioPagamento.0.ModalitaPagamento',
        'DatiPagamento.DettaglioPagamento.0.ImportoPagamento',
        'DatiPagamento.DettaglioPagamento.0.DataScadenzaPagamento',
        'DatiPagamento.DettaglioPagamento.1.ImportoPagamento',
        'DatiPagamento.DettaglioPagamento.2.ImportoPagamento',
      ]
        .map((entry) => `invoiceXmlInvalid:${entry}`)
        .sort(),
    );
    for (const bad of ['abc', true, 1.5, '12345678']) {
      assert.deepEqual(reduce({ DatiGenerali: { DatiTrasporto: { NumeroColli: bad } } }).issues.map((issue) => issue.code), ['invoiceXmlInvalid'], String(bad));
    }
    // Every code of the standard in the domain passes.
    for (const method of ['MP01', 'MP12', 'MP23']) {
      assert.equal(reduce({ DatiPagamento: { DettaglioPagamento: [{ ModalitaPagamento: method }] } }).issues.length, 0, method);
    }
    assert.equal(reduce({ DatiBeniServizi: { DatiRiepilogo: { EsigibilitaIVA: 'I' } } }).issues.length, 0);
  });

  it('keeps the split payment only for a customer that has it', () => {
    const body = { DatiBeniServizi: { DatiRiepilogo: { EsigibilitaIVA: 'S' } } };
    assert.deepEqual(reduce(body, true), { xml: { FatturaElettronicaBody: body }, issues: [] });
    assert.deepEqual(reduce(body, false), { xml: null, issues: [{ code: 'invoiceSplitPaymentDenied', path: 'FatturaElettronicaBody.DatiBeniServizi.DatiRiepilogo.EsigibilitaIVA' }] });
    assert.deepEqual(reduceInvoiceXml({ FatturaElettronicaBody: body }, { company, counterpart: {} }).issues.map((issue) => issue.code), ['invoiceSplitPaymentDenied']);
  });

  it('takes the bank data only from a bank of the company the IBAN names, and the beneficiary only from the company', () => {
    const own = reduce({ DatiPagamento: { DettaglioPagamento: [{ ModalitaPagamento: 'MP05', ImportoPagamento: 10, Beneficiario: 'Someone Else', IBAN: 'it60 x054 2811 1010 0000 0123 456', ABI: '99999', CAB: '99999', BIC: 'EVILBIC1', IstitutoFinanziario: 'Evil Bank' }] } });
    assert.deepEqual(own.issues, []);
    assert.deepEqual(own.xml!['FatturaElettronicaBody'].DatiPagamento.DettaglioPagamento, [
      { Beneficiario: 'Acme Spa', ModalitaPagamento: 'MP05', ImportoPagamento: 10, IBAN: BANK.iban, IstitutoFinanziario: 'Banca Uno', ABI: '05428', CAB: '11101', BIC: 'BPBAIT3B' },
    ]);
    // A bank with odd data gives only what is valid.
    const odd = reduce({ DatiPagamento: { DettaglioPagamento: [{ IBAN: 'it00 0000 0000 0000 0000 0000 000' }] } });
    assert.deepEqual(odd.xml!['FatturaElettronicaBody'].DatiPagamento.DettaglioPagamento, [{ Beneficiario: 'Acme Spa', IBAN: 'IT00000000000000000000000000'.slice(0, 27) }]);
    // An IBAN the company does not have: no bank data at all, and the payment stays.
    const foreign = reduce({ DatiPagamento: { DettaglioPagamento: [{ ModalitaPagamento: 'MP05', IBAN: 'DE89370400440532013000', ABI: '05428', BIC: 'BPBAIT3B', IstitutoFinanziario: 'Banca Uno' }, { IBAN: 'DE89370400440532013000' }] } });
    assert.deepEqual(paths(foreign.issues), ['invoiceIbanUnknown:DatiPagamento.DettaglioPagamento.0.IBAN', 'invoiceIbanUnknown:DatiPagamento.DettaglioPagamento.1.IBAN']);
    assert.deepEqual(foreign.xml!['FatturaElettronicaBody'].DatiPagamento.DettaglioPagamento, [{ Beneficiario: 'Acme Spa', ModalitaPagamento: 'MP05' }]);
    // A bank with nothing but its IBAN gives nothing else.
    const plain = reduce({ DatiPagamento: { DettaglioPagamento: [{ IBAN: 'IT11 1111 1111 1111 1111 1111 111' }] } });
    assert.deepEqual(plain.xml!['FatturaElettronicaBody'].DatiPagamento.DettaglioPagamento, [{ Beneficiario: 'Acme Spa', IBAN: 'IT1111111111111111111111111' }]);
    // Bank data with no IBAN are the till's word, never kept; and no company name or bank list does not break it.
    assert.equal(reduce({ DatiPagamento: { DettaglioPagamento: [{ ABI: '05428', BIC: 'BPBAIT3B' }] } }).xml, null);
    const bare = reduceInvoiceXml({ FatturaElettronicaBody: { DatiPagamento: { DettaglioPagamento: [{ ModalitaPagamento: 'MP05', IBAN: BANK.iban }] } } }, { company: {}, counterpart: {} });
    assert.deepEqual(bare.issues.map((issue) => issue.code), ['invoiceIbanUnknown']);
    assert.deepEqual(bare.xml!['FatturaElettronicaBody'].DatiPagamento.DettaglioPagamento, [{ Beneficiario: '', ModalitaPagamento: 'MP05' }]);
    // At most 20 payments, and a list that is not a list is nothing.
    assert.equal(reduce({ DatiPagamento: { DettaglioPagamento: Array.from({ length: 30 }, () => ({ ModalitaPagamento: 'MP05' })) } }).xml!['FatturaElettronicaBody'].DatiPagamento.DettaglioPagamento.length, 20);
    assert.equal(reduce({ DatiPagamento: { DettaglioPagamento: 'x' } }).xml, null);
  });
});
