import { Double, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { LEGACY_DATE } from './product-catalog.ts';

/**
 * A complete contact as the legacy backoffice writes it (every key of an insert), with the keys the backend never touches (`account.password` and `account.tokens`, the denormalized `cGroup` and `associatedCompany`, an unknown
 * `legacyExtra`). `overrides` replace keys; a key given as `undefined` is missing from the stored document (the driver would write `null`).
 *
 * @param overrides The keys to change.
 */
export function legacyContact(overrides: Document = {}): Document {
  const document: Document = {
    _id: new ObjectId(),
    customer: true,
    supplier: false,
    contactCode: 'K-1',
    cGroupId: null,
    cGroup: { name: 'copia spuria' },
    listId: null,
    note: null,
    name: 'Mario',
    surname: 'Rossi',
    code: 'RSSMRA80A01F205X',
    birthDate: new Date('1980-01-01T00:00:00.000Z'),
    address: 'Via Roma 1',
    postcode: '20100',
    city: 'Milano',
    countryCode: 'IT',
    countryAreaCode: 'MI',
    telephone: ['+39 02 123456'],
    email: ['mario@example.test'],
    discount: new Double(10),
    associatedCompanyId: null,
    associatedCompany: { name: 'copia spuria' },
    companyName: '',
    companyCode: '',
    companyCode2: '',
    companyAddress: '',
    companyPostcode: '',
    companyCity: '',
    companyCountryCode: '',
    companyCountryAreaCode: '',
    companyTelephone: [],
    companyEmail: [],
    companyFax: [],
    companyDiscount: null,
    companyLists: [],
    fattura_elettronica: {
      formato_trasmissione: 'FPR12',
      identificativo: 'CD',
      codice_destinatario: '',
      pec: '',
      condizioni_pagamento: '',
      modalita_pagamento: '',
      regime_fiscale: '',
      riferimento_amministrazione: '',
      split_payment: false,
      richiedi_dati_ordine_acquisto: false,
    },
    fidelities: [{ code: 'CARD-1', points: 120 }],
    services: [],
    account: { email: 'mario.account@example.test', telephone: '+39 333 1234567', password: 'legacy-dead-password-hash', tokens: [{ token: 'legacy-dead-token' }] },
    legacyExtra: { keep: true },
    trash: false,
    insertDate: LEGACY_DATE,
    updateDate: LEGACY_DATE,
    ...overrides,
  };
  return Object.fromEntries(Object.entries(document).filter(([, value]) => value !== undefined));
}

/** A company contact (a customer or a supplier with a company name and nothing personal), as the legacy stores it. */
export const legacyCompany = (overrides: Document = {}): Document =>
  legacyContact({ name: '', surname: '', code: '', birthDate: null, address: '', postcode: '', city: '', countryCode: '', countryAreaCode: '', telephone: [], email: [], discount: null, companyName: 'Acme Srl', companyCode: 'IT01234567890', fidelities: [], account: undefined, ...overrides });
