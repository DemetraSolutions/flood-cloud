import { numberIssue, numberOrNull, numberText, textOrNull } from '../groups/catalogs/catalog-fields';
import {
  Contact,
  CONTACT_LIMITS,
  ContactAddress,
  ContactKind,
} from './contact.types';

/** An address in the form: every field is a text, `''` for none. */
export interface AddressModel {
  street: string;
  postcode: string;
  city: string;
  countryCode: string;
  areaCode: string;
}

/** The personal data in the form. */
export interface PersonModel {
  firstName: string;
  lastName: string;
  taxCode: string;
  birthDate: string;
  address: AddressModel;
  phones: string[];
  emails: string[];
  discountPercent: string;
  associatedCompanyId: string;
}

/** A price list of a supplier in the form (`id` is `''` for one that is new). */
export interface SupplierListRow {
  id: string;
  name: string;
  favorite: boolean;
}

/** The company data in the form. */
export interface CompanyModel {
  name: string;
  vatNumber: string;
  taxCode: string;
  address: AddressModel;
  phones: string[];
  emails: string[];
  faxes: string[];
  discountPercent: string;
  supplierPriceLists: SupplierListRow[];
}

/** The e-invoicing data in the form. */
export interface EInvoicingModel {
  transmissionFormat: string;
  channel: string;
  recipientCode: string;
  pec: string;
  paymentTerms: string;
  paymentMethod: string;
  taxRegime: string;
  administrationReference: string;
  splitPayment: boolean;
  requirePurchaseOrderData: boolean;
}

/** A service with a custom duration in the form (`HH:mm`). */
export interface ServiceRow {
  productId: string;
  duration: string;
}

/** The whole form of a contact. The balance of a card is not part of it: it is never written. */
export interface ContactModel {
  code: string;
  customer: boolean;
  supplier: boolean;
  contactGroupId: string;
  priceListId: string;
  notes: string;
  person: PersonModel;
  company: CompanyModel;
  eInvoicing: EInvoicingModel;
  /** The codes of the loyalty cards. */
  cards: string[];
  services: ServiceRow[];
  account: { email: string; phone: string };
}

/** What decides which fields the body has. */
export interface BodyContext {
  /** The group has the `services` feature: only then the body has `services`. */
  readonly services: boolean;
}

function addressModel(address: ContactAddress | undefined): AddressModel {
  return {
    street: address?.street ?? '',
    postcode: address?.postcode ?? '',
    city: address?.city ?? '',
    countryCode: address?.countryCode ?? '',
    areaCode: address?.areaCode ?? '',
  };
}

/**
 * The form of a contact.
 *
 * @param item The contact as the server has it; `null` for a new one.
 * @param kind For a new contact, the tab of the list it was opened from: it decides whether it
 *   starts as a customer or as a supplier.
 */
export function toModel(item: Contact | null, kind: ContactKind = 'customers'): ContactModel {
  const person = item?.person;
  const company = item?.company;
  const invoicing = item?.eInvoicing;
  return {
    code: item?.code ?? '',
    customer: item?.customer ?? (kind === 'customers' || kind === 'all'),
    supplier: item?.supplier ?? kind === 'suppliers',
    contactGroupId: item?.contactGroupId ?? '',
    priceListId: item?.priceListId ?? '',
    notes: item?.notes ?? '',
    person: {
      firstName: person?.firstName ?? '',
      lastName: person?.lastName ?? '',
      taxCode: person?.taxCode ?? '',
      birthDate: person?.birthDate ?? '',
      address: addressModel(person?.address),
      phones: [...(person?.phones ?? [])],
      emails: [...(person?.emails ?? [])],
      discountPercent: numberText(person?.discountPercent ?? null),
      associatedCompanyId: person?.associatedCompanyId ?? '',
    },
    company: {
      name: company?.name ?? '',
      vatNumber: company?.vatNumber ?? '',
      taxCode: company?.taxCode ?? '',
      address: addressModel(company?.address),
      phones: [...(company?.phones ?? [])],
      emails: [...(company?.emails ?? [])],
      faxes: [...(company?.faxes ?? [])],
      discountPercent: numberText(company?.discountPercent ?? null),
      supplierPriceLists: (company?.supplierPriceLists ?? []).map((list) => ({ ...list })),
    },
    eInvoicing: {
      transmissionFormat: invoicing?.transmissionFormat ?? 'FPR12',
      channel: invoicing?.channel ?? 'CD',
      recipientCode: invoicing?.recipientCode ?? '',
      pec: invoicing?.pec ?? '',
      paymentTerms: invoicing?.paymentTerms ?? '',
      paymentMethod: invoicing?.paymentMethod ?? '',
      taxRegime: invoicing?.taxRegime ?? '',
      administrationReference: invoicing?.administrationReference ?? '',
      splitPayment: invoicing?.splitPayment ?? false,
      requirePurchaseOrderData: invoicing?.requirePurchaseOrderData ?? false,
    },
    cards: (item?.fidelityCards ?? []).map((card) => card.code),
    services: (item?.services ?? []).map((service) => ({
      productId: service.productId,
      duration: service.duration ?? '',
    })),
    account: { email: item?.account.email ?? '', phone: item?.account.phone ?? '' },
  };
}

/** The filled entries of a list of texts, trimmed. */
function filled(values: readonly string[]): string[] {
  return values.map((value) => value.trim()).filter((value) => value !== '');
}

function addressBody(address: AddressModel): Record<string, unknown> {
  return {
    street: address.street.trim(),
    postcode: address.postcode.trim(),
    city: address.city.trim(),
    countryCode: textOrNull(address.countryCode),
    areaCode: textOrNull(address.areaCode),
  };
}

/** The body of the whole contact as the server would have it (the base of the creation and of the comparison). */
function payload(model: ContactModel, ctx: BodyContext): Record<string, unknown> {
  const { person, company, eInvoicing: invoicing } = model;
  return {
    code: model.code.trim(),
    customer: model.customer,
    supplier: model.supplier,
    contactGroupId: textOrNull(model.contactGroupId),
    priceListId: textOrNull(model.priceListId),
    notes: textOrNull(model.notes),
    person: {
      firstName: person.firstName.trim(),
      lastName: person.lastName.trim(),
      taxCode: person.taxCode.trim(),
      birthDate: textOrNull(person.birthDate),
      address: addressBody(person.address),
      phones: filled(person.phones),
      emails: filled(person.emails),
      discountPercent: numberOrNull(person.discountPercent),
      associatedCompanyId: textOrNull(person.associatedCompanyId),
    },
    company: {
      name: company.name.trim(),
      vatNumber: company.vatNumber.trim(),
      taxCode: company.taxCode.trim(),
      address: addressBody(company.address),
      phones: filled(company.phones),
      emails: filled(company.emails),
      faxes: filled(company.faxes),
      discountPercent: numberOrNull(company.discountPercent),
      supplierPriceLists: company.supplierPriceLists.map((list) => ({
        ...(list.id === '' ? {} : { id: list.id }),
        name: list.name.trim(),
        favorite: list.favorite,
      })),
    },
    eInvoicing: {
      transmissionFormat: invoicing.transmissionFormat,
      channel: invoicing.channel,
      recipientCode: textOrNull(invoicing.recipientCode),
      pec: textOrNull(invoicing.pec),
      paymentTerms: textOrNull(invoicing.paymentTerms),
      paymentMethod: textOrNull(invoicing.paymentMethod),
      taxRegime: textOrNull(invoicing.taxRegime),
      administrationReference: textOrNull(invoicing.administrationReference),
      splitPayment: invoicing.splitPayment,
      requirePurchaseOrderData: invoicing.requirePurchaseOrderData,
    },
    account: { email: textOrNull(model.account.email), phone: textOrNull(model.account.phone) },
    // Only the codes: the balance is never written.
    fidelityCards: filled(model.cards).map((code) => ({ code })),
    ...(ctx.services
      ? {
          services: model.services.map((service) => ({
            productId: service.productId,
            duration: service.duration,
          })),
        }
      : {}),
  };
}

/** The body of a creation: everything the user filled in. */
export function createBody(model: ContactModel, ctx: BodyContext): Record<string, unknown> {
  return payload(model, ctx);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The leaves of an object that differ from the other one; a list that differs is taken whole. */
function changes(now: Record<string, unknown>, before: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(now)) {
    const prior = before[key];
    if (isObject(value)) {
      const nested = changes(value, prior as Record<string, unknown>);
      if (Object.keys(nested).length > 0) {
        body[key] = nested;
      }
    } else if (JSON.stringify(value) !== JSON.stringify(prior)) {
      body[key] = value;
    }
  }
  return body;
}

/**
 * The body of a modification: only the fields that changed (the objects field by field, a list
 * that changed whole, the cards as codes). An empty body means nothing changed.
 *
 * @param model The form.
 * @param before The form as the contact was read (or saved).
 */
export function patchBody(model: ContactModel, before: ContactModel, ctx: BodyContext): Record<string, unknown> {
  return changes(payload(model, ctx), payload(before, ctx));
}

/** Whether a new contact's form differs from the empty one. */
export function modelChanged(model: ContactModel, original: ContactModel): boolean {
  return JSON.stringify(model) !== JSON.stringify(original);
}

/** Control characters other than the tab, refused in a line of text. */
const CONTROL = /[\u0000-\u001F\u007F]/;
/** Control characters other than the line breaks and the tab, refused in the notes. */
const NOTES_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const PHONE = /^[0-9 +()-]+$/;
const RECIPIENT_CODE = /^[A-Z0-9]{6,7}$/;
const DURATION = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A line of text of at most `max` characters without control characters; empty is fine. */
export function lineIssue(text: string, max: number): 'maxLength' | 'pattern' | undefined {
  const value = text.trim();
  if (value.length > max) {
    return 'maxLength';
  }
  return CONTROL.test(value) ? 'pattern' : undefined;
}

/**
 * The code of a loyalty card: one line of at most 64 characters, never only dots, and no `|` in a new code (the server refuses them; a saved code that has one is left alone, as the file import uses `|` as separator).
 *
 * @param text The code.
 * @param saved Whether the contact already has this code.
 */
export function cardCodeIssue(
  text: string,
  saved = false,
): 'maxLength' | 'pattern' | 'format' | 'pipe' | undefined {
  if (/^\.+$/.test(text.trim())) {
    return 'format';
  }
  return !saved && text.includes('|') ? 'pipe' : lineIssue(text, CONTACT_LIMITS.cardCode);
}

/** The notes: at most 2000 characters, line breaks allowed. */
export function notesIssue(text: string): 'maxLength' | 'pattern' | undefined {
  const value = text.trim();
  if (value.length > CONTACT_LIMITS.notes) {
    return 'maxLength';
  }
  return NOTES_CONTROL.test(value) ? 'pattern' : undefined;
}

/** An e-mail address: empty is fine. */
export function emailIssue(text: string): 'format' | 'maxLength' | undefined {
  const value = text.trim();
  if (value === '') {
    return undefined;
  }
  if (value.length > 254) {
    return 'maxLength';
  }
  return EMAIL.test(value) ? undefined : 'format';
}

/** A phone or fax number as the server takes it for the account: digits, spaces and `+ ( ) -`, with a digit. */
export function phoneIssue(text: string): 'format' | 'maxLength' | undefined {
  const value = text.trim();
  if (value === '') {
    return undefined;
  }
  if (value.length > 32) {
    return 'maxLength';
  }
  return PHONE.test(value) && /\d/.test(value) ? undefined : 'format';
}

/** A discount: 0 to 100 with at most two decimals; empty is fine. */
export function discountIssue(text: string): 'type' | 'minimum' | 'maximum' | 'format' | undefined {
  const issue = numberIssue(text, { min: 0, max: 100, optional: true });
  if (issue !== undefined) {
    // `optional` never gives `required`.
    return issue as Exclude<typeof issue, 'required'>;
  }
  const value = Number(text);
  return text.trim() !== '' && Math.round(value * 100) / 100 !== value ? 'format' : undefined;
}

/** A birth date: `YYYY-MM-DD` and a day that exists; empty is fine. */
export function birthDateIssue(text: string): 'incorrect' | undefined {
  const value = text.trim();
  if (value === '') {
    return undefined;
  }
  const match = DATE.exec(value);
  if (match === null) {
    return 'incorrect';
  }
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? 'incorrect' : undefined;
}

/** The code of the recipient of the e-invoice: 6 or 7 letters or digits (upper case); empty is fine. */
export function recipientCodeIssue(text: string): 'format' | undefined {
  const value = text.trim();
  return value === '' || RECIPIENT_CODE.test(value.toUpperCase()) ? undefined : 'format';
}

/** A duration `HH:mm` from `00:01` to `23:59`. */
export function durationIssue(text: string): 'required' | 'incorrect' | undefined {
  if (text.trim() === '') {
    return 'required';
  }
  return DURATION.test(text) && text !== '00:00' ? undefined : 'incorrect';
}

/**
 * The issue of a list of texts: too many entries, an entry that is not valid or one that appears
 * twice.
 *
 * @param values The entries of the list.
 * @param max Most entries the server takes.
 * @param each Issue of one entry.
 * @param fold Whether two entries that differ only in case are the same one (the e-mail addresses are).
 */
export function listIssue(
  values: readonly string[],
  max: number,
  each: (text: string) => string | undefined,
  fold = true,
): 'tooMany' | 'incorrect' | undefined {
  const entries = filled(values);
  if (entries.length > max) {
    return 'tooMany';
  }
  const keys = entries.map((entry) => (fold ? entry.toLowerCase() : entry));
  const repeated = keys.some((key, index) => keys.indexOf(key) !== index);
  return repeated || entries.some((entry) => each(entry) !== undefined) ? 'incorrect' : undefined;
}

/** The issue of the price lists of a supplier: too many, a name missing or too long, or more than one favorite. */
export function supplierListsIssue(rows: readonly SupplierListRow[]): 'tooMany' | 'incorrect' | undefined {
  if (rows.length > CONTACT_LIMITS.supplierPriceLists) {
    return 'tooMany';
  }
  const wrongName = rows.some((row) => row.name.trim() === '' || lineIssue(row.name, CONTACT_LIMITS.name) !== undefined);
  return wrongName || rows.filter((row) => row.favorite).length > 1 ? 'incorrect' : undefined;
}

/** The issue of the services: too many, a product twice or a duration that is not valid. */
export function servicesIssue(rows: readonly ServiceRow[]): 'tooMany' | 'incorrect' | undefined {
  if (rows.length > CONTACT_LIMITS.services) {
    return 'tooMany';
  }
  const ids = rows.map((row) => row.productId);
  const repeated = ids.some((id, index) => ids.indexOf(id) !== index);
  return repeated || rows.some((row) => durationIssue(row.duration) !== undefined) ? 'incorrect' : undefined;
}

/** The issue of the codes of the cards: too many, one too long or one twice. */
export function cardsIssue(
  codes: readonly string[],
  saved: readonly string[] = [],
): 'tooMany' | 'incorrect' | undefined {
  return listIssue(codes, CONTACT_LIMITS.cards, (code) => cardCodeIssue(code, saved.includes(code)), false);
}
