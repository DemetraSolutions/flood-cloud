/** Path segment of the contacts under `/v1/groups/{groupId}`. */
export const CONTACTS_SEGMENT = 'contacts';

/** Limits of the server (`doc/API.md`, "Contatti e gruppi di contatti"). */
export const CONTACT_LIMITS = Object.freeze({
  phones: 10,
  emails: 10,
  supplierPriceLists: 50,
  cards: 20,
  services: 200,
  code: 64,
  name: 100,
  companyName: 200,
  taxCode: 32,
  notes: 2000,
  cardCode: 64,
  administrationReference: 20,
  pointsDelta: 1_000_000,
  pointsReason: 200,
});

/** The kinds of contact the list is divided in, in the order of its tabs. */
export const CONTACT_KINDS = ['customers', 'suppliers', 'others', 'all'] as const;

/** A kind of contact (the `kind` query parameter of the list). */
export type ContactKind = (typeof CONTACT_KINDS)[number];

/** The kind of the first tab. */
export const DEFAULT_KIND: ContactKind = 'customers';

/** Transmission formats of the e-invoice (`FPR12` is the default). */
export const TRANSMISSION_FORMATS = ['FPR12', 'FPA12'] as const;

/** Channels an e-invoice reaches a contact on (`CD` is the default). */
export const E_INVOICE_CHANNELS = ['CD', 'PEC'] as const;

/** Payment terms of the e-invoice. */
export const PAYMENT_TERMS = ['TP01', 'TP02', 'TP03'] as const;

/** Payment methods of the e-invoice, `MP01` to `MP23`. */
export const PAYMENT_METHODS: readonly string[] = Object.freeze(
  Array.from({ length: 23 }, (_, index) => `MP${String(index + 1).padStart(2, '0')}`),
);

/** Tax regimes of the e-invoice (`RF03` was repealed). */
export const TAX_REGIMES: readonly string[] = Object.freeze([
  'RF01',
  'RF02',
  ...Array.from({ length: 16 }, (_, index) => `RF${String(index + 4).padStart(2, '0')}`),
]);

/** An address as the server returns it. */
export interface ContactAddress {
  readonly street: string;
  readonly postcode: string;
  readonly city: string;
  /** ISO alpha-2 code of a country of the platform. */
  readonly countryCode: string | null;
  /** Code of a province of the country. */
  readonly areaCode: string | null;
}

/** The personal data of a contact. */
export interface ContactPerson {
  readonly firstName: string;
  readonly lastName: string;
  readonly taxCode: string;
  /** `YYYY-MM-DD`. */
  readonly birthDate: string | null;
  readonly address: ContactAddress;
  readonly phones: readonly string[];
  readonly emails: readonly string[];
  readonly discountPercent: number | null;
  readonly associatedCompanyId: string | null;
}

/** A price list a supplier gives (the products that name the supplier refer to it). */
export interface SupplierPriceList {
  readonly id: string;
  readonly name: string;
  readonly favorite: boolean;
}

/** The company data of a contact. */
export interface ContactCompany {
  readonly name: string;
  readonly vatNumber: string;
  readonly taxCode: string;
  readonly address: ContactAddress;
  readonly phones: readonly string[];
  readonly emails: readonly string[];
  readonly faxes: readonly string[];
  readonly discountPercent: number | null;
  readonly supplierPriceLists: readonly SupplierPriceList[];
}

/** The e-invoicing data of a contact. */
export interface ContactEInvoicing {
  readonly transmissionFormat: string;
  readonly channel: string;
  readonly recipientCode: string | null;
  readonly pec: string | null;
  readonly paymentTerms: string | null;
  readonly paymentMethod: string | null;
  readonly taxRegime: string | null;
  readonly administrationReference: string | null;
  readonly splitPayment: boolean;
  readonly requirePurchaseOrderData: boolean;
}

/**
 * What a contact shows of an advanced card (the one that has its code): its type, state, credit and
 * points. For a user without `fidelity:read` every field is `null` (the contact only says that the
 * code is an advanced card).
 */
export interface AdvancedCardInfo {
  readonly cardId: string | null;
  readonly cardType: { readonly id: string; readonly name: string | null } | null;
  readonly enabled: boolean | null;
  readonly balance: number | null;
  readonly totalPoints: number | null;
}

/**
 * A loyalty card of a contact: the points are read only (they change with the sales and the
 * adjustments). `advanced` is `null` for a simple card; for an advanced one the points of the
 * contact do not count (the card has its own balances).
 */
export interface FidelityCard {
  readonly code: string;
  readonly points: number;
  readonly advanced: AdvancedCardInfo | null;
}

/** A service product with the duration this contact is given for it. */
export interface ContactService {
  readonly productId: string;
  readonly duration: string | null;
}

/** A code, tax code or VAT number that other contacts use too (the save went through). */
export interface ContactWarning {
  /** `code`, `person.taxCode`, `company.vatNumber` or `company.taxCode`. */
  readonly field: string;
  readonly issue: 'duplicate';
  /** At most five contacts that use the value. */
  readonly contactIds: readonly string[];
  /** How many other contacts use it that are not named. */
  readonly others: number;
  /** The value the warning is about, added by the page from the saved contact (never sent by the server): the names of the other contacts are searched with it. */
  readonly value?: string;
}

/** A contact as the server returns it (detail and the answer of every write). */
export interface Contact {
  readonly id: string;
  readonly code: string;
  readonly customer: boolean;
  readonly supplier: boolean;
  readonly contactGroupId: string | null;
  readonly priceListId: string | null;
  readonly notes: string | null;
  readonly person: ContactPerson;
  readonly company: ContactCompany;
  readonly eInvoicing: ContactEInvoicing;
  readonly fidelityCards: readonly FidelityCard[];
  /** Only in a group that has the `services` feature. */
  readonly services?: readonly ContactService[];
  readonly account: { readonly email: string | null; readonly phone: string | null };
  readonly displayName: string | null;
  readonly trashed: boolean;
  readonly trashedAt: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  /** Only in the answers of reads, creations and modifications. */
  readonly warnings?: readonly ContactWarning[];
}

/** A row of the list of contacts: what is needed to find a contact and nothing else. */
export interface ContactRow {
  readonly id: string;
  readonly code: string;
  readonly customer: boolean;
  readonly supplier: boolean;
  readonly displayName: string | null;
  readonly person: { readonly firstName: string; readonly lastName: string };
  readonly company: { readonly name: string; readonly vatNumber: string };
  readonly email: string | null;
  readonly phone: string | null;
  readonly contactGroupId: string | null;
  readonly trashed: boolean;
  readonly trashedAt: string | null;
  readonly updatedAt: string | null;
}

/** What happened to a contact of the bulk move to the trash. */
export interface ContactTrashResult {
  readonly id: string;
  readonly outcome: 'trashed' | 'skipped';
  readonly issue?: 'notFound' | 'alreadyTrashed' | 'conflict';
}

/** Response of the bulk move to the trash: one result per requested id, in the order of the request. */
export interface ContactTrashResponse {
  readonly results: readonly ContactTrashResult[];
}

/** The balance of a card after a points adjustment. */
export interface PointsAdjustment {
  readonly code: string;
  readonly points: number;
}

/**
 * Router commands of the list of contacts, of one contact or of the page of a new one.
 *
 * @param groupId Group of the contacts.
 * @param contactId The contact; `null` for the page of a new one, omitted for the list.
 */
export function contactRoute(groupId: string, contactId?: string | null): string[] {
  const base = ['/groups', groupId, CONTACTS_SEGMENT];
  return contactId === undefined ? base : [...base, contactId === null ? 'new' : contactId];
}

/** The name to show for a contact: its display name, else its code, else a short id. */
export function contactLabel(row: {
  readonly id: string;
  readonly displayName: string | null;
  readonly code: string;
}): string {
  return row.displayName ?? (row.code !== '' ? row.code : `…${row.id.slice(-6)}`);
}
