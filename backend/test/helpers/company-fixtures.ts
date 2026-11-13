import { Double, Int32 } from 'mongodb';
import type { Document, ObjectId } from 'mongodb';
import { ECOMMERCE_FLAGS } from '../../src/shared/legacy-write/company-paths.ts';
import { legacyCompany } from './legacy-fixtures.ts';

/** A published valid Italian VAT number (a large company's, not personal data) and an IBAN from the standard's own examples. */
export const VAT = '01114601006';
export const IBAN = 'IT60X0542811101000000123456';

/** The flags of `settings.ecommerce` as the legacy writes them: alternately on and off, so a swapped key shows. */
export function ecommerceFlags(): Document {
  return Object.fromEntries(ECOMMERCE_FLAGS.map((key, index) => [key, index % 2 === 0]));
}

/** The domain value of {@link ecommerceFlags}. */
export function ecommerceFlagsDomain(): Record<string, boolean> {
  return Object.fromEntries(ECOMMERCE_FLAGS.map((key, index) => [key, index % 2 === 0]));
}

/**
 * A complete company as the legacy backoffice writes it (`doc/Tasks.md` area 6, analysis §1): every key of every block with its exact BSON type
 * (`Int32` and `Double` explicit), plus keys the backend does not know at the top level, inside `fattura_elettronica`, `settings.global`,
 * `settings.ecommerce`, `settings` itself, `medias.images` and `medias`.
 *
 * @param n Ordinal of the company.
 * @param groupId Group of the company.
 * @param overrides Fields to add or change.
 */
export function fullLegacyCompany(n: number, groupId: ObjectId, overrides: Document = {}): Document {
  return legacyCompany(n, groupId, {
    name: 'Acme S.r.l.',
    code: VAT,
    code2: VAT,
    address: 'Via Roma 1',
    postcode: '20100',
    city: 'Milano',
    countryAreaCode: 'MI',
    countryCode: 'IT',
    email: 'info@acme.example',
    telephone: '+39 02 1234567',
    currencyCode: 'EUR',
    invoicesPS: 'prefix',
    invoicesPSValues: [
      { name: 'FE', cash: true },
      { name: 'NC', cash: false },
    ],
    fattura_elettronica: {
      hub: 'aruba',
      IdTrasmittente_paese: 'IT',
      IdTrasmittente_codice: '01879020517',
      codice_eori: '',
      email: 'pec@acme.example',
      codice_destinatario: 'ABC1234',
      albo_professionale: '',
      ap_numero_iscrizione: '',
      ap_provincia: '',
      ap_data_iscrizione: '',
      rea_ufficio: 'MI',
      rea_numero: '123456',
      rea_capitale_sociale: '10000.5',
      rea_soci: 'SU',
      rea_liquidazione: 'LN',
      regime_fiscale: 'RF01',
      unknownEInvoicing: { keep: [1, 2] },
    },
    ticketsSuppliers: [{ id: 'tsupplier1', name: 'Pasti', cuts: [new Double(5), new Int32(10), null] }],
    banks: [{ id: 'bank1', name: 'Main', iban: IBAN, abi: '05428', cab: '11101', bic: '', default: true }],
    settings: {
      global: { enableLoginSignup: true, showPrivacyPage: true, showTermsPage: false, discountLines: true, lastInvoiceNumber: new Int32(120), unknownGlobal: 'keep' },
      api: { cerved: true, unknownApi: 1 },
      ecommerce: {
        ...ecommerceFlags(),
        listId: 'pricelist1',
        minAmount: { EUR: { code: 'EUR', value: new Double(25.5) }, USD: { code: 'USD', value: new Int32(30) } },
        showProductRemainingQuantity: new Int32(3),
        unknownEcommerce: true,
      },
      unknownSettings: { keep: true },
    },
    medias: {
      images: {
        internalFileName: 'logo.png',
        externalUrl: 'https://example.test/logo.png',
        customersAppLogoLight: {
          _id: 'f00d',
          dirname: '/media/image',
          basename: 'light.png',
          extension: 'png',
          filename: 'light',
          mimetype: 'image/png',
          filectime: new Double(1_700_000_000_000),
          mmThumb: {},
          type: 'image',
          title: 'Light',
          alt: 'Light logo',
        },
        customersAppLogoDark: null,
        unknownImage: 1,
      },
      unknownMedia: 1,
    },
    status: true,
    trash: false,
    expirationDate: new Date('2030-01-01T00:00:00.000Z'),
    futureKey: { nested: [1, 2, 3] },
    ...overrides,
  });
}
