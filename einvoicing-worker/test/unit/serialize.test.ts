import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decimal } from '../../src/invoice/decimal.ts';
import type { Decimal } from '../../src/invoice/decimal.ts';
import type { FatturaElettronica, FatturaElettronicaSemplificata } from '../../src/invoice/model.ts';
import { NAMESPACE_ORDINARY, NAMESPACE_SIMPLIFIED, serialize } from '../../src/invoice/serialize.ts';
import { SCHEMAS, validateAgainstSchema } from '../helpers/xsd.ts';

const money = (units: bigint, scale = 2): Decimal => decimal(units, scale);
const address = { Indirizzo: 'Via Prova 1', CAP: '00100', Comune: 'Roma', Nazione: 'IT' };

function minimal(): FatturaElettronica {
  return {
    versione: 'FPR12',
    FatturaElettronicaHeader: {
      DatiTrasmissione: { IdTrasmittente: { IdPaese: 'IT', IdCodice: '01879020517' }, ProgressivoInvio: '1', FormatoTrasmissione: 'FPR12', CodiceDestinatario: '0000000' },
      CedentePrestatore: {
        DatiAnagrafici: { IdFiscaleIVA: { IdPaese: 'IT', IdCodice: '01234567890' }, Anagrafica: { Denominazione: 'Seller' }, RegimeFiscale: 'RF01' },
        Sede: address,
      },
      CessionarioCommittente: { DatiAnagrafici: { CodiceFiscale: 'RSSMRA80A01H501U', Anagrafica: { Nome: 'Mario', Cognome: 'Rossi' } }, Sede: address },
    },
    FatturaElettronicaBody: {
      DatiGenerali: { DatiGeneraliDocumento: { TipoDocumento: 'TD01', Divisa: 'EUR', Data: '2026-11-27', Numero: '1' } },
      DatiBeniServizi: {
        DettaglioLinee: [{ NumeroLinea: 1, Descrizione: 'Item', PrezzoUnitario: money(1000n), PrezzoTotale: money(1000n), AliquotaIVA: money(2200n) }],
        DatiRiepilogo: [{ AliquotaIVA: money(2200n), ImponibileImporto: money(1000n), Imposta: money(220n) }],
      },
    },
  };
}

function full(): FatturaElettronica {
  const model = minimal();
  return {
    ...model,
    FatturaElettronicaHeader: {
      DatiTrasmissione: { ...model.FatturaElettronicaHeader.DatiTrasmissione, CodiceDestinatario: '0000000', PECDestinatario: 'a@pec.example.it' },
      CedentePrestatore: {
        DatiAnagrafici: {
          IdFiscaleIVA: { IdPaese: 'IT', IdCodice: '01234567890' },
          CodiceFiscale: 'RSSMRA80A01H501U',
          Anagrafica: { Nome: 'Gino', Cognome: 'Bianchi', Titolo: 'Dott.', CodEORI: 'IT12345678901234' },
          RegimeFiscale: 'RF19',
        },
        Sede: { ...address, NumeroCivico: '12', Provincia: 'RM' },
        IscrizioneREA: { Ufficio: 'RM', NumeroREA: '1', CapitaleSociale: money(1000000n), SocioUnico: 'SM', StatoLiquidazione: 'LS' },
        RiferimentoAmministrazione: 'REF',
      },
      CessionarioCommittente: { DatiAnagrafici: { IdFiscaleIVA: { IdPaese: 'DE', IdCodice: '123' }, Anagrafica: { Denominazione: 'Kunde & Söhne' } }, Sede: { ...address, CAP: '00000', Nazione: 'DE' } },
    },
    FatturaElettronicaBody: {
      DatiGenerali: {
        DatiGeneraliDocumento: {
          TipoDocumento: 'TD04',
          Divisa: 'EUR',
          Data: '2026-11-27',
          Numero: '1',
          ScontoMaggiorazione: [{ Tipo: 'MG', Importo: money(12345n, 3) }, { Tipo: 'SC', Percentuale: money(500n) }],
          ImportoTotaleDocumento: money(1220n),
          Causale: ['One', 'Two'],
        },
        DatiOrdineAcquisto: [{ IdDocumento: 'O1', Data: '2026-11-01', CodiceCUP: 'CUP', CodiceCIG: 'CIG' }],
        DatiFattureCollegate: [{ IdDocumento: '40' }],
        DatiTrasporto: {
          DatiAnagraficiVettore: { IdFiscaleIVA: { IdPaese: 'IT', IdCodice: '02' }, CodiceFiscale: 'RSSMRA80A01H501U', Anagrafica: { Denominazione: 'Carrier' }, NumeroLicenzaGuida: 'L1' },
          MezzoTrasporto: 'Van',
          CausaleTrasporto: 'Sale',
          NumeroColli: 3,
          Descrizione: 'Boxes',
          UnitaMisuraPeso: 'KG',
          PesoLordo: money(1250n),
          PesoNetto: money(1100n),
          DataOraRitiro: '2026-11-26T09:00:00.000Z',
          DataInizioTrasporto: '2026-11-26',
          TipoResa: 'EXW',
          IndirizzoResa: address,
          DataOraConsegna: '2026-11-27T15:30:00.000Z',
        },
      },
      DatiBeniServizi: {
        DettaglioLinee: [
          {
            NumeroLinea: 1,
            Descrizione: 'Item',
            Quantita: money(150n),
            UnitaMisura: 'PZ',
            PrezzoUnitario: money(1000n),
            ScontoMaggiorazione: [{ Tipo: 'SC', Percentuale: money(1000n) }],
            PrezzoTotale: money(1350n),
            AliquotaIVA: money(0n),
            Natura: 'N4',
            AltriDatiGestionali: [{ TipoDato: 'T', RiferimentoTesto: 'text', RiferimentoData: '2026-11-01' }, { TipoDato: 'U' }],
          },
        ],
        DatiRiepilogo: [{ AliquotaIVA: money(0n), Natura: 'N4', ImponibileImporto: money(1350n), Imposta: money(0n), EsigibilitaIVA: 'D', RiferimentoNormativo: 'Art. 10' }],
      },
      DatiPagamento: [
        {
          CondizioniPagamento: 'TP02',
          DettaglioPagamento: [
            { Beneficiario: 'Seller', ModalitaPagamento: 'MP05', DataScadenzaPagamento: '2026-12-27', ImportoPagamento: money(1220n), IstitutoFinanziario: 'Bank', IBAN: 'IT60X0542811101000000123456', ABI: '05428', CAB: '11101', BIC: 'BEPIIT22XXX' },
            { ModalitaPagamento: 'MP01', ImportoPagamento: money(1n) },
          ],
        },
      ],
    },
  };
}

describe('serialize: ordinary invoice', () => {
  it('writes the root with the namespace, the prefixes and the version, and unqualified children', () => {
    const xml = serialize(minimal());
    assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<p:FatturaElettronica '));
    assert.ok(xml.includes(`xmlns:p="${NAMESPACE_ORDINARY}"`));
    assert.ok(xml.includes('xmlns:ds="http://www.w3.org/2000/09/xmldsig#"'));
    assert.ok(xml.includes('xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"'));
    assert.ok(xml.includes(' versione="FPR12">'));
    assert.ok(xml.includes('\n  <FatturaElettronicaHeader>'));
    assert.ok(xml.endsWith('</p:FatturaElettronica>\n'));
    assert.ok(!xml.includes('xsi:schemaLocation'));
  });

  it('writes no empty element when nothing optional is present', () => {
    const xml = serialize(minimal());
    assert.ok(!/<(\w+)><\/\1>/.test(xml));
    assert.ok(!xml.includes('Natura') && !xml.includes('Causale') && !xml.includes('DatiPagamento'));
  });

  it('writes decimals with the digits of their type', () => {
    const xml = serialize(full());
    for (const fragment of [
      '<Quantita>1.50</Quantita>',
      '<PrezzoUnitario>10.00</PrezzoUnitario>',
      '<Importo>12.345</Importo>',
      '<Percentuale>5.00</Percentuale>',
      '<AliquotaIVA>0.00</AliquotaIVA>',
      '<PesoLordo>12.50</PesoLordo>',
      '<CapitaleSociale>10000.00</CapitaleSociale>',
      '<ImportoTotaleDocumento>12.20</ImportoTotaleDocumento>',
    ]) {
      assert.ok(xml.includes(fragment), fragment);
    }
  });

  it('follows the order of the XSD sequences and validates', async () => {
    const xml = serialize(full());
    const order = ['<DatiTrasmissione>', '<CedentePrestatore>', '<CessionarioCommittente>', '<DatiGeneraliDocumento>', '<DatiOrdineAcquisto>', '<DatiFattureCollegate>', '<DatiTrasporto>', '<DettaglioLinee>', '<DatiRiepilogo>', '<DatiPagamento>'];
    const positions = order.map((tag) => xml.indexOf(tag));
    assert.ok(positions.every((position, index) => position > (positions[index - 1] ?? -1)), positions.join(','));
    const result = await validateAgainstSchema(xml, SCHEMAS.FPR12);
    assert.equal(result.valid, true, result.output);
  });

  it('escapes special characters of the texts', () => {
    const xml = serialize(full());
    assert.ok(xml.includes('<Denominazione>Kunde &amp; Söhne</Denominazione>'));
  });

  it('is deterministic and refuses a text XML cannot hold', () => {
    assert.equal(serialize(full()), serialize(full()));
    const model = minimal();
    const broken: FatturaElettronica = { ...model, FatturaElettronicaBody: { ...model.FatturaElettronicaBody, DatiGenerali: { DatiGeneraliDocumento: { ...model.FatturaElettronicaBody.DatiGenerali.DatiGeneraliDocumento, Numero: 'a\u0000' } } } };
    assert.throws(() => serialize(broken), /not allowed in XML/);
  });

  it('writes a transport block that has no carrier, and one with no data at all disappears', () => {
    const model = full();
    const general = model.FatturaElettronicaBody.DatiGenerali;
    const withoutCarrier: FatturaElettronica = { ...model, FatturaElettronicaBody: { ...model.FatturaElettronicaBody, DatiGenerali: { ...general, DatiTrasporto: { MezzoTrasporto: 'Van' } } } };
    assert.ok(!serialize(withoutCarrier).includes('DatiAnagraficiVettore'));
    const empty: FatturaElettronica = { ...model, FatturaElettronicaBody: { ...model.FatturaElettronicaBody, DatiGenerali: { ...general, DatiTrasporto: {} } } };
    assert.ok(!serialize(empty).includes('DatiTrasporto'));
  });
});

describe('serialize: simplified invoice', () => {
  function simplifiedModel(): FatturaElettronicaSemplificata {
    return {
      versione: 'FSM10',
      FatturaElettronicaHeader: {
        DatiTrasmissione: { IdTrasmittente: { IdPaese: 'IT', IdCodice: '01879020517' }, ProgressivoInvio: '1', FormatoTrasmissione: 'FSM10', CodiceDestinatario: '0000000', PECDestinatario: 'a@pec.example.it' },
        CedentePrestatore: {
          IdFiscaleIVA: { IdPaese: 'IT', IdCodice: '01234567890' },
          Nome: 'Gino',
          Cognome: 'Bianchi',
          Sede: address,
          IscrizioneREA: { Ufficio: 'RM', NumeroREA: '1', StatoLiquidazione: 'LN' },
          RegimeFiscale: 'RF01',
        },
        CessionarioCommittente: { IdentificativiFiscali: { IdFiscaleIVA: { IdPaese: 'IT', IdCodice: '09876543210' } } },
      },
      FatturaElettronicaBody: {
        DatiGenerali: { DatiGeneraliDocumento: { TipoDocumento: 'TD07', Divisa: 'EUR', Data: '2026-11-27', Numero: '1' } },
        DatiBeniServizi: [
          { Descrizione: 'Goods', Importo: money(1220n), DatiIVA: { Imposta: money(220n) } },
          { Descrizione: 'Exempt', Importo: money(500n), DatiIVA: { Aliquota: money(0n) }, Natura: 'N4', RiferimentoNormativo: 'Art. 10' },
        ],
      },
    };
  }

  it('writes the simplified root, the flat seller and the amounts', async () => {
    const xml = serialize(simplifiedModel());
    assert.ok(xml.includes('<p:FatturaElettronicaSemplificata '));
    assert.ok(xml.includes(`xmlns:p="${NAMESPACE_SIMPLIFIED}"`));
    assert.ok(xml.includes(' versione="FSM10">'));
    assert.ok(xml.includes('<Nome>Gino</Nome>'));
    assert.ok(!xml.includes('AltriDatiIdentificativi') && !xml.includes('DatiFatturaRettificata'));
    assert.ok(xml.includes('<Imposta>2.20</Imposta>'));
    const result = await validateAgainstSchema(xml, SCHEMAS.FSM10);
    assert.equal(result.valid, true, result.output);
  });
});
