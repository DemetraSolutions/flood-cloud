import { isDeepStrictEqual } from 'node:util';
import { Double, Int32, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { CONTACTS_OWNED_FIELDS } from '../../db/collections.ts';
import { flagOf, isRecord, numberOf, recordsOf, textOf, valueAt } from '../groups/catalogs/kit.ts';
import { TAX_REGIMES } from '../companies/validators.ts';
import { ENCRYPTED } from '../group-lookup/lookup.repository.ts';
import { entityVersion } from '../product-catalog/entity.service.ts';
import { idOf } from '../products/products.mapper.ts';

/** The transmission formats of the Italian e-invoice a contact may have; the first is the default. */
export const TRANSMISSION_FORMATS = Object.freeze(['FPR12', 'FPA12'] as const);

/** The channels an e-invoice reaches a contact on (`CD`: the recipient code, `PEC`: the certified e-mail); the first is the default. */
export const E_INVOICE_CHANNELS = Object.freeze(['CD', 'PEC'] as const);

/** The payment terms of the Italian e-invoice (`CondizioniPagamento`). */
export const PAYMENT_TERMS = Object.freeze(['TP01', 'TP02', 'TP03'] as const);

/** The payment methods of the Italian e-invoice (`ModalitaPagamento`, `MP01` to `MP23`). */
export const PAYMENT_METHODS = Object.freeze(Array.from({ length: 23 }, (_, index) => `MP${String(index + 1).padStart(2, '0')}`) as readonly string[]);

/** The longest administration reference of an e-invoice. */
export const MAX_ADMINISTRATION_REFERENCE = 20;

/** A postal address as the API shows it. */
export interface AddressData {
  readonly street: string;
  readonly postcode: string;
  readonly city: string;
  /** ISO alpha-2 code of a country of the platform, `null` for none. */
  readonly countryCode: string | null;
  /** Code of a province (an area of the country), `null` for none. */
  readonly areaCode: string | null;
}

/** The personal data of a contact. */
export interface PersonData {
  readonly firstName: string;
  readonly lastName: string;
  /** The personal fiscal code, upper case. */
  readonly taxCode: string;
  /** `YYYY-MM-DD`. */
  readonly birthDate: string | null;
  readonly address: AddressData;
  readonly phones: readonly string[];
  readonly emails: readonly string[];
  readonly discountPercent: number | null;
  /** The company contact (of the same group) the person works for. */
  readonly associatedCompanyId: string | null;
}

/** A price list a supplier gives, which the products that name the supplier refer to. */
export interface SupplierPriceList {
  readonly id: string;
  readonly name: string;
  readonly favorite: boolean;
}

/** The company data of a contact. */
export interface CompanyData {
  readonly name: string;
  readonly vatNumber: string;
  readonly taxCode: string;
  readonly address: AddressData;
  readonly phones: readonly string[];
  readonly emails: readonly string[];
  readonly faxes: readonly string[];
  readonly discountPercent: number | null;
  readonly supplierPriceLists: readonly SupplierPriceList[];
}

/** The e-invoicing data of a contact. */
export interface EInvoicingData {
  readonly transmissionFormat: (typeof TRANSMISSION_FORMATS)[number];
  readonly channel: (typeof E_INVOICE_CHANNELS)[number];
  readonly recipientCode: string | null;
  readonly pec: string | null;
  readonly paymentTerms: string | null;
  readonly paymentMethod: string | null;
  readonly taxRegime: string | null;
  readonly administrationReference: string | null;
  readonly splitPayment: boolean;
  readonly requirePurchaseOrderData: boolean;
}

/** A service product with the duration this contact is given for it. */
export interface ContactService {
  readonly productId: string;
  /** `HH:mm`; `null` when the stored value is not one. */
  readonly duration: string | null;
}

/** A loyalty card of a contact. */
export interface FidelityCard {
  readonly code: string;
  /** The balance: moved by the sales and by the adjustments, never by a write of the contact. */
  readonly points: number;
}

/** What the API writes of a contact (every field of a creation and a modification, as read back): `fidelityCards` and the calculated fields are not part of it. */
export interface ContactData {
  readonly code: string;
  readonly customer: boolean;
  readonly supplier: boolean;
  readonly contactGroupId: string | null;
  readonly priceListId: string | null;
  readonly notes: string | null;
  readonly person: PersonData;
  readonly company: CompanyData;
  readonly eInvoicing: EInvoicingData;
  readonly services: readonly ContactService[];
  readonly account: { readonly email: string | null; readonly phone: string | null };
}

const ENCRYPTED_TEXT = new RegExp(ENCRYPTED);

/**
 * Whether a stored value is a text in the legacy encrypted format (`<ciphertext hex>$<iv hex>`): it is shown as `''` and is never overwritten by a request that sends `''`.
 *
 * @param raw The stored value.
 */
export function isEncrypted(raw: unknown): boolean {
  return typeof raw === 'string' && ENCRYPTED_TEXT.test(raw.trim());
}

/**
 * A stored personal text in clear: trimmed, `''` when it is missing, is not a text or is in the legacy encrypted format (`<ciphertext hex>$<iv hex>`), which this backend never decrypts (the key is not ours).
 *
 * @param raw The stored value.
 */
export function clearText(raw: unknown): string {
  const text = textOf(raw)?.trim() ?? '';
  return ENCRYPTED_TEXT.test(text) ? '' : text;
}

/** A stored list of personal texts: the ones in clear and not empty, whatever else the list holds. */
export function clearList(raw: unknown): string[] {
  return (Array.isArray(raw) ? (raw as unknown[]) : []).map(clearText).filter((text) => text !== '');
}

const orNull = (text: string): string | null => (text === '' ? null : text);

/** A stored percentage: a finite number from 0 to 100, `null` otherwise. */
function percentOf(raw: unknown): number | null {
  const value = numberOf(raw);
  return value !== null && value >= 0 && value <= 100 ? value : null;
}

/** A stored birth date as `YYYY-MM-DD`: a valid `Date`, or the text of an ISO date or date-time; `null` otherwise. */
export function birthDateOf(raw: unknown): string | null {
  const date = raw instanceof Date ? raw : typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(raw) ? new Date(raw) : null;
  return date === null || Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

/** `HH:mm` (the schema also refuses `00:00`: a duration is from `00:01` to `23:59`). */
export const DURATION = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/** The choice a stored text makes among a closed list: the text when it is one of them, `fallback` otherwise. */
function choiceOf<T extends string>(raw: unknown, allowed: readonly T[], fallback: T | null): T | null {
  return typeof raw === 'string' && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

/** How one field of the API is read from and written to the document. */
interface FieldSpec {
  /** Dotted path of the API field. */
  readonly key: string;
  /** Dotted path of the document field. */
  readonly doc: string;
  /** The API value a stored value stands for (tolerant: it never throws). */
  readonly read: (raw: unknown) => unknown;
  /** The stored value of an API value, `undefined` when the document has no such key (a null account). */
  readonly store: (value: never) => unknown;
  /** The API value a new contact has. */
  readonly empty: unknown;
}

const spec = <V>(key: string, doc: string, read: (raw: unknown) => V, store: (value: V) => unknown, empty: V): FieldSpec => ({ key, doc, read, store: store as (value: never) => unknown, empty });
const textField = (key: string, doc: string): FieldSpec => spec<string>(key, doc, clearText, (value) => value, '');
const nullableText = (key: string, doc: string): FieldSpec => spec<string | null>(key, doc, (raw) => orNull(clearText(raw)), (value) => value ?? '', null);
/** A text that is `null` when there is none (the price list, the note). */
const nullField = (key: string, doc: string): FieldSpec => spec<string | null>(key, doc, (raw) => orNull(clearText(raw)), (value) => value, null);
const listField = (key: string, doc: string): FieldSpec => spec<readonly string[]>(key, doc, clearList, (value) => [...value], []);
const flag = (key: string, doc: string): FieldSpec => spec<boolean>(key, doc, flagOf, (value) => value, false);
const referenceField = (key: string, doc: string): FieldSpec => spec<string | null>(key, doc, idOf, (value) => (value === null ? null : ObjectId.createFromHexString(value)), null);
const percentField = (key: string, doc: string): FieldSpec => spec<number | null>(key, doc, percentOf, (value) => (value === null ? null : new Double(value)), null);
const choice = <T extends string>(key: string, doc: string, allowed: readonly T[], fallback: T | null): FieldSpec => spec<T | null>(key, doc, (raw) => choiceOf(raw, allowed, fallback), (value) => value ?? '', fallback);
/** A leaf of the account: a text, or no key at all (the unique indexes of the legacy forbid an empty value twice). */
const accountField = (key: string, doc: string): FieldSpec => spec<string | null>(key, doc, (raw) => orNull(clearText(raw)), (value) => value ?? undefined, null);

const addressFields = (prefix: string, doc: { street: string; postcode: string; city: string; country: string; area: string }): FieldSpec[] => [
  textField(`${prefix}.street`, doc.street),
  textField(`${prefix}.postcode`, doc.postcode),
  textField(`${prefix}.city`, doc.city),
  nullableText(`${prefix}.countryCode`, doc.country),
  nullableText(`${prefix}.areaCode`, doc.area),
];

const PRICE_LISTS = spec<readonly SupplierPriceList[]>(
  'company.supplierPriceLists',
  'companyLists',
  (raw) => recordsOf(raw).flatMap((item) => (clearText(item['id']) === '' ? [] : [{ id: clearText(item['id']), name: clearText(item['name']), favorite: flagOf(item['favorite']) }])),
  (value) => value.map((list) => ({ id: list.id, name: list.name, favorite: list.favorite })),
  [],
);

const SERVICES = spec<readonly ContactService[]>(
  'services',
  'services',
  (raw) =>
    recordsOf(raw).flatMap((item) => {
      const productId = idOf(item['id']);
      return productId === null ? [] : [{ productId, duration: typeof item['time'] === 'string' && DURATION.test(item['time']) ? item['time'] : null }];
    }),
  (value) => value.map((service) => ({ id: ObjectId.createFromHexString(service.productId), time: service.duration as string })),
  [],
);

/**
 * Every field of the API a write of a contact sets, with its place in the document: the order is the one of the legacy form. `fidelityCards` (written element by element) and the calculated fields are not here.
 * The leaves of `fattura_elettronica` and of `account` are fields of their own: the two containers are owned leaf by leaf.
 */
export const CONTACT_FIELDS: readonly FieldSpec[] = Object.freeze([
  textField('code', 'contactCode'),
  flag('customer', 'customer'),
  flag('supplier', 'supplier'),
  referenceField('contactGroupId', 'cGroupId'),
  nullField('priceListId', 'listId'),
  nullField('notes', 'note'),
  textField('person.firstName', 'name'),
  textField('person.lastName', 'surname'),
  textField('person.taxCode', 'code'),
  spec<string | null>('person.birthDate', 'birthDate', birthDateOf, (value) => (value === null ? null : new Date(`${value}T00:00:00.000Z`)), null),
  ...addressFields('person.address', { street: 'address', postcode: 'postcode', city: 'city', country: 'countryCode', area: 'countryAreaCode' }),
  listField('person.phones', 'telephone'),
  listField('person.emails', 'email'),
  percentField('person.discountPercent', 'discount'),
  referenceField('person.associatedCompanyId', 'associatedCompanyId'),
  textField('company.name', 'companyName'),
  textField('company.vatNumber', 'companyCode'),
  textField('company.taxCode', 'companyCode2'),
  ...addressFields('company.address', { street: 'companyAddress', postcode: 'companyPostcode', city: 'companyCity', country: 'companyCountryCode', area: 'companyCountryAreaCode' }),
  listField('company.phones', 'companyTelephone'),
  listField('company.emails', 'companyEmail'),
  listField('company.faxes', 'companyFax'),
  percentField('company.discountPercent', 'companyDiscount'),
  PRICE_LISTS,
  choice('eInvoicing.transmissionFormat', 'fattura_elettronica.formato_trasmissione', TRANSMISSION_FORMATS, TRANSMISSION_FORMATS[0]),
  choice('eInvoicing.channel', 'fattura_elettronica.identificativo', E_INVOICE_CHANNELS, E_INVOICE_CHANNELS[0]),
  nullableText('eInvoicing.recipientCode', 'fattura_elettronica.codice_destinatario'),
  nullableText('eInvoicing.pec', 'fattura_elettronica.pec'),
  choice('eInvoicing.paymentTerms', 'fattura_elettronica.condizioni_pagamento', PAYMENT_TERMS, null),
  choice('eInvoicing.paymentMethod', 'fattura_elettronica.modalita_pagamento', PAYMENT_METHODS, null),
  choice('eInvoicing.taxRegime', 'fattura_elettronica.regime_fiscale', TAX_REGIMES, null),
  nullableText('eInvoicing.administrationReference', 'fattura_elettronica.riferimento_amministrazione'),
  flag('eInvoicing.splitPayment', 'fattura_elettronica.split_payment'),
  flag('eInvoicing.requirePurchaseOrderData', 'fattura_elettronica.richiedi_dati_ordine_acquisto'),
  SERVICES,
  accountField('account.email', 'account.email'),
  accountField('account.phone', 'account.telephone'),
]);

/** The containers of the document that are owned leaf by leaf: a write of a leaf below a container that is not an object replaces the whole container. */
export const CONTACT_CONTAINERS: readonly string[] = Object.freeze(['fattura_elettronica', 'account']);

/** Sets a value at a dotted path of a plain object, creating the objects on the way. */
function putAt(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  let current = target;
  for (const segment of segments.slice(0, -1)) {
    current[segment] = isRecord(current[segment]) ? { ...(current[segment] as Record<string, unknown>) } : {};
    current = current[segment] as Record<string, unknown>;
  }
  current[segments[segments.length - 1]!] = value;
}

/**
 * The data of a stored contact, read tolerantly: a field of the wrong type is its empty value, a personal text in the legacy encrypted format is empty, and nothing throws.
 *
 * @param document The stored contact.
 */
export function contactData(document: Document): ContactData {
  const data: Record<string, unknown> = {};
  for (const field of CONTACT_FIELDS) {
    putAt(data, field.key, field.read(valueAt(document, field.doc)));
  }
  return data as unknown as ContactData;
}

/**
 * The loyalty cards of a stored contact: every element that has a text `code`, with its balance (a number, `0` when it is not one).
 *
 * @param raw The stored `fidelities`.
 */
export function cardsOf(raw: unknown): FidelityCard[] {
  return recordsOf(raw).flatMap((item) => (clearText(item['code']) === '' ? [] : [{ code: clearText(item['code']), points: numberOf(item['points']) ?? 0 }]));
}

/**
 * The name a contact is shown under, the rule of `lookup/customers`: the company name when it has one, else the first name and the surname; `null` when it has none.
 *
 * @param company The company name, in clear.
 * @param firstName The first name, in clear.
 * @param lastName The surname, in clear.
 */
export function displayNameOf(company: string, firstName: string, lastName: string): string | null {
  return orNull(company) ?? orNull(`${firstName} ${lastName}`.trim());
}

/** The stored value of every field for a new contact: what each field has when nothing is said. */
function blankValues(): Document {
  const document: Document = {};
  for (const field of CONTACT_FIELDS) {
    const stored = field.store(field.empty as never);
    if (stored !== undefined) {
      putAt(document, field.doc, stored);
    }
  }
  return document;
}

/**
 * A new contact before the request is applied: every field empty or at its default (the e-invoice is `FPR12` on the recipient code channel), no card, no service, not in the trash. The account has no key until it is
 * given (the unique indexes of the legacy forbid an empty value twice).
 *
 * @param input The new id and the instant of the creation.
 */
export function blankContact(input: { readonly id: ObjectId; readonly now: Date }): Document {
  return { _id: input.id, ...blankValues(), fidelities: [], services: [], trash: false, insertDate: input.now, updateDate: input.now };
}

/** The number a stored value is: the `Int32` and `Double` the writes use are the plain numbers a read gives. */
function plainOf(value: unknown): unknown {
  return value instanceof Int32 || value instanceof Double ? value.valueOf() : value;
}

/**
 * Whether two stored values are the same: `ObjectId`s by value, lists and objects member by member, numbers written as `Int32` or `Double` by their value, everything else as `isDeepStrictEqual` says.
 *
 * @param left A value.
 * @param right Another value.
 */
export function sameStored(left: unknown, right: unknown): boolean {
  const a = plainOf(left);
  const b = plainOf(right);
  if (a instanceof ObjectId || b instanceof ObjectId) {
    return a instanceof ObjectId && b instanceof ObjectId && a.equals(b);
  }
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((item, index) => sameStored(item, b[index]));
  }
  if (isRecord(a)) {
    return isRecord(b) && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((key) => Object.hasOwn(b, key) && sameStored(a[key], b[key]));
  }
  return isDeepStrictEqual(a, b);
}

/**
 * The stored contact with its cards reduced to their codes: the balance moves with every sale and every adjustment and must not change the version.
 *
 * @param document The stored contact.
 */
function withoutBalances(document: Document): Document {
  return { ...document, fidelities: cardsOf(document['fidelities']).map((card) => ({ code: card.code })) };
}

/**
 * The version of a stored contact, the `ETag` of the reads and the `If-Match` of the writes: HMAC-SHA256 with the secret key of the server of the id and of every field the backend writes, with the cards reduced to
 * their codes (a sale or an adjustment of the points does not change it, and a change of anything else the contact owns does).
 *
 * @param document The stored contact, read with every owned field.
 * @param key The secret key of the HMAC (`VERSION_HMAC_KEY`).
 */
export function contactVersion(document: Document, key: Buffer): string {
  return entityVersion(withoutBalances(document), CONTACTS_OWNED_FIELDS, key);
}

/**
 * What the activity log reads of a contact to tell which fields a write changed: the data and the codes of the cards, never the balance. Only the names of the fields that differ are kept by the log
 * (the data are personal and are never recorded), so this object is compared and thrown away.
 *
 * @param document The stored contact.
 */
export function contactComparable(document: Document): Record<string, unknown> {
  const data = contactData(document);
  return { ...data, fidelityCards: cardsOf(document['fidelities']).map((card) => card.code), trashed: document['trash'] === true };
}
