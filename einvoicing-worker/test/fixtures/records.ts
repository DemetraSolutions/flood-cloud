/**
 * Synthetic records of the legacy e-invoicing queue, for the mapper and XSD tests.
 *
 * Everything here is invented (names, codes, addresses): there is no real customer data. A fixture is the base
 * record (a private customer, `FPR12`, recipient code) with some values changed; `withValues` clones a record and
 * sets dotted paths (`undefined` removes the key), so a test states only what differs from the base.
 */

/** A queue record as plain data. */
export type RecordData = Record<string, unknown>;

/**
 * Clones a record and sets values by dotted path.
 *
 * @param base The record to start from (not modified).
 * @param values Dotted path to value; `undefined` removes the key.
 * @returns The modified copy.
 */
export function withValues(base: RecordData, values: Readonly<Record<string, unknown>>): RecordData {
  const copy = structuredClone(base);
  for (const [path, value] of Object.entries(values)) {
    const keys = path.split('.');
    const last = keys.pop() as string;
    let target: RecordData = copy;
    for (const key of keys) {
      const next = target[key];
      target = (typeof next === 'object' && next !== null ? next : (target[key] = {})) as RecordData;
    }
    if (value === undefined) {
      delete target[last];
    } else {
      target[last] = value;
    }
  }
  return copy;
}

const taxData22 = { id: 'tax-22', value: 22, description: '', natura: '' };
const taxData10 = { id: 'tax-10', value: 10, description: '', natura: '' };

/** The base record: private customer with an Italian fiscal code, two lines (22% and 10%), recipient code. */
export function baseRecord(): RecordData {
  return {
    _id: 'synthetic-0001',
    type: 'invoice',
    date: '2026-11-27T10:15:00.000Z',
    number: 42,
    prefixSuffix: '',
    note: '',
    customerType: 1,
    discountPercentage: 0,
    discountValue: 0,
    totalTaxableWithoutDiscount: 2.54,
    total: 3,
    records: [
      { name: { it: 'Caffè espresso' }, qt: 2, price: { price: 0.81967213, tax: 22, taxData: taxData22, discount: 0 } },
      { name: { it: 'Cornetto' }, qt: 1, price: { price: 0.90909091, tax: 10, taxData: taxData10, discount: 0 } },
    ],
    fattura_elettronica: { tipo: 'TD01', progressivo_invio: 7 },
    company: {
      code: 'IT01234567890',
      code2: '01234567890',
      name: 'Bar Esempio S.r.l.',
      address: 'Via Roma 1',
      postcode: '00100',
      city: 'Roma',
      countryAreaCode: 'RM',
      currencyCode: 'EUR',
      invoicesPS: null,
      settings: { global: { discountLines: false } },
      fattura_elettronica: {
        hub: 'aruba',
        IdTrasmittente_paese: '',
        IdTrasmittente_codice: '',
        regime_fiscale: 'RF01',
        rea_ufficio: '',
        rea_numero: '',
        rea_capitale_sociale: '',
        rea_soci: '',
        rea_liquidazione: '',
      },
    },
    counterpart: {
      name: 'Mario',
      surname: 'Rossi',
      code: 'rssmra80a01h501u',
      address: 'Via Milano 10',
      postcode: '20100',
      city: 'Milano',
      countryCode: 'IT',
      countryAreaCode: 'MI',
      fattura_elettronica: {
        formato_trasmissione: 'FPR12',
        identificativo: 'CD',
        codice_destinatario: 'abcdefg',
        pec: '',
        riferimento_amministrazione: '',
      },
    },
  };
}

const companyBuyer = {
  customerType: 2,
  'counterpart.companyName': 'Cliente Esempio S.p.A.',
  'counterpart.companyCode': 'it09876543210',
  'counterpart.companyCode2': '09876543210',
  'counterpart.companyAddress': 'Corso Italia 5',
  'counterpart.companyPostcode': '10100',
  'counterpart.companyCity': 'Torino',
  'counterpart.companyCountryCode': 'ITA',
  'counterpart.companyCountryAreaCode': 'to',
};

/** Named fixtures: every one maps to a valid invoice. */
export const fixtures: Readonly<Record<string, () => RecordData>> = {
  'private-recipient-code': baseRecord,
  'private-pec': () =>
    withValues(baseRecord(), {
      'counterpart.fattura_elettronica.identificativo': 'PEC',
      'counterpart.fattura_elettronica.codice_destinatario': '',
      'counterpart.fattura_elettronica.pec': 'mario.rossi@pec.example.it',
    }),
  'private-no-code': () =>
    withValues(baseRecord(), { 'counterpart.fattura_elettronica.identificativo': '', 'counterpart.fattura_elettronica.codice_destinatario': '' }),
  'company-buyer': () => withValues(baseRecord(), { ...companyBuyer, 'company.invoicesPS': 'prefix', prefixSuffix: 'A/' }),
  'foreign-buyer': () =>
    withValues(baseRecord(), {
      ...companyBuyer,
      'counterpart.companyCode': 'DE123456789',
      'counterpart.companyCode2': '',
      'counterpart.companyCountryCode': 'DE',
      'counterpart.companyPostcode': 'D-10115',
      'counterpart.companyCity': 'Berlin',
      'counterpart.companyAddress': 'Unter den Linden 1',
      'counterpart.fattura_elettronica.identificativo': '',
      'counterpart.fattura_elettronica.codice_destinatario': '',
    }),
  'public-administration-split-payment': () =>
    withValues(baseRecord(), {
      ...companyBuyer,
      'counterpart.companyCode2': '80012345678',
      'counterpart.fattura_elettronica.formato_trasmissione': 'FPA12',
      'counterpart.fattura_elettronica.codice_destinatario': 'uf1234',
      'counterpart.fattura_elettronica.riferimento_amministrazione': 'RIF-2026/1',
      'company.invoicesPS': 'suffix',
      prefixSuffix: '/PA',
      XML: {
        FatturaElettronicaBody: {
          DatiGenerali: { DatiOrdineAcquisto: { IdDocumento: 'ORD-77', Data: '2026-10-01', CodiceCUP: 'B11B20000010001', CodiceCIG: 'ZA12345678' } },
          DatiBeniServizi: { DatiRiepilogo: { EsigibilitaIVA: 'S' } },
        },
      },
    }),
  'zero-rate-with-nature': () =>
    withValues(baseRecord(), {
      records: [
        { name: { it: 'Libro' }, qt: 1, price: { price: 12, tax: 0, taxData: { id: 'tax-0', value: 0, description: 'Esente art. 10 n. 20 DPR 633/72', natura: 'N4' }, discount: 0 } },
        { name: { it: 'Caffè' }, qt: 1, price: { price: 1.5, tax: 22, taxData: taxData22, discount: 0 } },
      ],
      total: 13.83,
    }),
  'line-discount-and-spread-document-discount': () =>
    withValues(baseRecord(), {
      'company.settings.global.discountLines': true,
      discountPercentage: 10,
      discountValue: 0.25,
      records: [
        { name: { it: 'Bistecca' }, qt: 3, price: { price: 10.333333, tax: 10, taxData: taxData10, discount: 5 } },
        { name: { it: 'Vino' }, qt: 2, price: { price: 8.4, tax: 22, taxData: taxData22, discount: 0 } },
      ],
      total: 47.6,
    }),
  'document-discount-not-spread': () => withValues(baseRecord(), { discountPercentage: 10, discountValue: 0.3, total: 2.65 }),
  'full-meal': () =>
    withValues(baseRecord(), {
      'sale.fullMeal': { status: true, quantity: 3 },
      totalTaxableWithoutDiscount: 90,
      total: 99,
    }),
  'credit-note': () =>
    withValues(baseRecord(), {
      type: 'credit-note',
      'fattura_elettronica.tipo': 'TD04',
      note: 'Reso merce',
      fromDocumentId: 'synthetic-0000',
      XML: { FatturaElettronicaBody: { DatiGenerali: { DatiFattureCollegate: [{ IdDocumento: '41', Data: '2026-11-20' }] } } },
    }),
  'simplified-td07': () =>
    withValues(baseRecord(), {
      'fattura_elettronica.tipo': 'TD07',
      'counterpart.fattura_elettronica.formato_trasmissione': 'FPA12',
      note: 'ignored by the simplified format',
    }),
  'simplified-td08-rectified': () =>
    withValues(baseRecord(), {
      ...companyBuyer,
      'fattura_elettronica.tipo': 'TD08',
      discountPercentage: 20,
      XML: { FatturaElettronicaBody: { DatiGenerali: { DatiFatturaRettificata: { NumeroFR: '40', DataFR: '2026-10-30', ElementiRettificati: 'Importo e aliquota' } } } },
    }),
  'seller-with-register-entry': () =>
    withValues(baseRecord(), {
      'company.fattura_elettronica.rea_ufficio': 'rm',
      'company.fattura_elettronica.rea_numero': '123456',
      'company.fattura_elettronica.rea_capitale_sociale': '10000.00',
      'company.fattura_elettronica.rea_soci': 'SU',
      'company.fattura_elettronica.rea_liquidazione': 'LN',
      'company.fattura_elettronica.IdTrasmittente_paese': 'IT',
      'company.fattura_elettronica.IdTrasmittente_codice': '09999999999',
    }),
  'optional-blocks': () =>
    withValues(baseRecord(), {
      records: [
        {
          name: { it: 'Consulenza' },
          qt: 1.5,
          price: { price: 40, tax: 22, taxData: taxData22, discount: 0 },
          XML: { AltriDatiGestionali: [{ TipoDato: 'ORDINE', RiferimentoTesto: 'Rif. 12', RiferimentoData: '2026-11-01' }] },
        },
      ],
      total: 73.2,
      XML: {
        FatturaElettronicaBody: {
          DatiGenerali: {
            DatiOrdineAcquisto: { IdDocumento: 'ORD-1', Data: '2026-11-02', CodiceCIG: 'ZA12345678' },
            DatiTrasporto: {
              DatiAnagraficiVettore: { IdFiscaleIVA: { IdPaese: 'IT', IdCodice: '01111111111' }, Anagrafica: { Denominazione: 'Corriere Veloce S.r.l.' } },
              MezzoTrasporto: 'Furgone',
              CausaleTrasporto: 'Vendita',
              NumeroColli: 2,
              Descrizione: 'Scatole',
              UnitaMisuraPeso: 'KG',
              PesoLordo: 12.5,
              PesoNetto: 11,
              DataOraRitiro: '2026-11-26T09:00:00.000Z',
              DataInizioTrasporto: '2026-11-26',
              TipoResa: 'exw',
              IndirizzoResa: { Indirizzo: 'Via Napoli', NumeroCivico: '3', CAP: '80100', Comune: 'Napoli', Provincia: 'NA', Nazione: 'IT' },
              DataOraConsegna: '2026-11-27T15:30:00.000Z',
            },
          },
          DatiPagamento: {
            CondizioniPagamento: 'TP02',
            DettaglioPagamento: [
              {
                Beneficiario: 'Bar Esempio S.r.l.',
                ModalitaPagamento: 'MP05',
                DataScadenzaPagamento: '2026-12-27',
                ImportoPagamento: 73.2,
                IstitutoFinanziario: 'Banca Esempio',
                IBAN: 'it60 x054 2811 1010 0000 0123 456',
                ABI: '05428',
                CAB: '11101',
                BIC: 'bepiit22xxx',
              },
              { ModalitaPagamento: '', ImportoPagamento: '' },
            ],
          },
        },
      },
    }),
  'texts-with-special-characters': () =>
    withValues(baseRecord(), {
      note: `Nota “con virgolette” & <tag> – “cliente” L'ordine è già stato pagato 😀. ${'Testo lungo con parole separate da spazi. '.repeat(10)}`,
      records: [
        { name: { it: 'Crème brûlée “della casa” & <specialità> 😀 – 5€' }, qt: 1, price: { price: 5, tax: 22, taxData: taxData22, discount: 0 } },
        { name: { it: `Spigola alla "Pescatora" d'asporto ${'x'.repeat(30)}` }, qt: 1, price: { price: 4, tax: 22, taxData: taxData22, discount: 0 } },
      ],
      'counterpart.name': 'José María',
      'counterpart.surname': "D'Angelo-Škoda",
      'counterpart.city': 'Sant’Angelo & Co',
      total: 10.98,
    }),
};
