import type { ListConfig } from '../../shared/http/list.ts';
import { listQueryShape } from '../../shared/http/list.ts';
import { array, boolean, email, enumOf, integer, integerString, nullable, number, object, objectId, optional, phone, refine, string, transform } from '../../shared/validation/schema.ts';
import type { Infer } from '../../shared/validation/schema.ts';
import { alpha2, checkedText, emptyAsNull, upperIf } from '../companies/companies.schemas.ts';
import { TAX_REGIMES, isValidCalendarDate, isValidRecipientCode } from '../companies/validators.ts';
import { SAFE_ID } from '../groups/catalogs/kit.ts';
import { contactName } from '../group-lookup/lookup.repository.ts';
import { atLeastOne } from '../product-catalog/entity.schemas.ts';
import { hexId } from '../products/products.schemas.ts';
import { DURATION, E_INVOICE_CHANNELS, MAX_ADMINISTRATION_REFERENCE, PAYMENT_METHODS, PAYMENT_TERMS, TRANSMISSION_FORMATS } from './contacts.document.ts';

/** Largest body of a write of a contact: the data of a person and of a company, ten phones and e-mails each, fifty supplier price lists and two hundred services fit with a wide margin. */
export const CONTACT_BODY_LIMIT = '64kb';

/** Largest body of a points adjustment: a number and a short reason. */
export const POINTS_BODY_LIMIT = '4kb';

/** Largest page of a list of contacts. */
export const MAX_CONTACTS_PAGE = 100;

/** The limits of the lists of a contact. */
export const CONTACT_LIMITS = Object.freeze({ phones: 10, emails: 10, supplierPriceLists: 50, cards: 20, services: 200 } as const);

/** The kinds of contact a list can be narrowed to: the customers, the suppliers, the ones that are neither (the legacy "generic" contacts) or all. */
export const CONTACT_KINDS = Object.freeze(['customers', 'suppliers', 'others', 'all'] as const);

/** Largest points adjustment, up or down. */
export const MAX_POINTS_DELTA = 1_000_000;

/**
 * How the contacts are sorted: by the display name (the company name, else name and surname: the default), by surname, by company name or by the date of the last change. The search `q` is not a list search: the service
 * looks for it in the names and as the exact code, tax code, VAT number, card or e-mail, so there are no search fields.
 */
export const CONTACTS_LIST: ListConfig = Object.freeze({
  sorts: Object.freeze({
    displayName: Object.freeze({ field: 'companyName', kind: 'string' as const, expression: contactName() }),
    lastName: Object.freeze({ field: 'surname', kind: 'string' as const }),
    companyName: Object.freeze({ field: 'companyName', kind: 'string' as const }),
    updatedAt: Object.freeze({ field: 'updateDate', kind: 'date' as const }),
  }),
  defaultSort: 'displayName',
  searchFields: Object.freeze([]),
});

/** A text of one line: no control character. */
export const LINE = /^[^\u0000-\u001F\u007F]*$/;

/** A text that may have several lines: no control character but the line breaks and the tab. */
const TEXT = /^[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]*$/;

const line = (max: number) => string({ max, trim: true, pattern: LINE });
const upper = (max: number) => transform(line(max), (value) => value.toUpperCase(), 'format');
/** The `true`/`false` of a query string. */
export const flag = () => transform(enumOf(['true', 'false']), (value) => value === 'true', 'enum');
/** A percentage of 0 to 100 with at most two decimals. */
export const percent = () => transform(number({ min: 0, max: 100 }), (value) => (Math.round(value * 100) / 100 === value ? value : undefined), 'format');

const address = () =>
  object({
    street: optional(line(150)),
    postcode: optional(line(20)),
    city: optional(line(100)),
    countryCode: optional(emptyAsNull(nullable(alpha2()))),
    areaCode: optional(emptyAsNull(nullable(string({ min: 1, max: 10, trim: true, pattern: LINE })))),
  });

const phones = () => array(string({ min: 1, max: 64, trim: true, pattern: LINE }), { max: CONTACT_LIMITS.phones, unique: true });
const emails = () => array(email(), { max: CONTACT_LIMITS.emails, unique: true });

/** The price lists a supplier gives: an id (the server makes one for a new list), a name, at most one favorite, no id twice. */
const supplierPriceLists = () =>
  refine(
    array(object({ id: optional(string({ min: 1, max: 64, pattern: SAFE_ID })), name: string({ min: 1, max: 100, trim: true, pattern: LINE }), favorite: optional(boolean()) }), { max: CONTACT_LIMITS.supplierPriceLists }),
    (value) => [
      ...value.flatMap((item, index) => (item.id !== undefined && value.findIndex((other) => other.id === item.id) !== index ? [`${String(index)}.id`] : [])),
      ...value.flatMap((item, index) => (item.favorite === true && value.findIndex((other) => other.favorite === true) !== index ? [`${String(index)}.favorite`] : [])),
    ],
    'incorrect',
  );

/**
 * The code of a loyalty card: one to 64 characters of one line, never only dots (`.` and `..` are no path segment a URL can carry). A **new** code (`trim: true`, the body of a write) has no `|` either: the XLSX workbook of
 * the contacts separates the codes of a cell with it. The code in a path (`trim: false`) is read as it is stored, so a legacy code with a `|` can still be reached.
 */
export const cardCode = (trim: boolean) =>
  transform(string({ min: 1, max: 64, trim, pattern: LINE }), (value) => (/^\.+$/.test(value) || (trim && value.includes('|')) ? undefined : value), 'format');

/** The codes of the loyalty cards: one to 64 characters, none twice. The balance is not a field: it is never written (`unknown`). */
const fidelityCards = () =>
  refine(
    array(object({ code: cardCode(true) }), { max: CONTACT_LIMITS.cards }),
    (value) => value.flatMap((item, index) => (value.findIndex((other) => other.code === item.code) === index ? [] : [`${String(index)}.code`])),
    'incorrect',
  );

/** The services a contact has a duration for: a service product and the duration, `HH:mm` from `00:01`, no product twice. */
const services = () =>
  refine(
    array(object({ productId: hexId(), duration: transform(string({ min: 5, max: 5, pattern: DURATION }), (value) => (value === '00:00' ? undefined : value), 'format') }), { max: CONTACT_LIMITS.services }),
    (value) => value.flatMap((item, index) => (value.findIndex((other) => other.productId === item.productId) === index ? [] : [`${String(index)}.productId`])),
    'incorrect',
  );

/** The fields of the company data of a write: the supplier price lists are the only ones a public body leaves out. */
export function companyShape() {
  return {
    name: optional(line(200)),
    vatNumber: optional(upper(32)),
    taxCode: optional(upper(32)),
    address: optional(address()),
    phones: optional(phones()),
    emails: optional(emails()),
    faxes: optional(phones()),
    discountPercent: optional(nullable(percent())),
    supplierPriceLists: optional(supplierPriceLists()),
  };
}

/** What a creation and a modification have in common: every field optional (the rule that a contact has a name or a company name is the service's). */
export function contactShape() {
  return {
    code: optional(line(64)),
    customer: optional(boolean()),
    supplier: optional(boolean()),
    contactGroupId: optional(nullable(hexId())),
    priceListId: optional(nullable(string({ min: 1, max: 64, pattern: SAFE_ID }))),
    notes: optional(emptyAsNull(nullable(string({ max: 2000, trim: true, pattern: TEXT })))),
    person: optional(
      object({
        firstName: optional(line(100)),
        lastName: optional(line(100)),
        taxCode: optional(upper(32)),
        birthDate: optional(nullable(transform(string({ min: 10, max: 10 }), (value) => (isValidCalendarDate(value) ? value : undefined), 'format'))),
        address: optional(address()),
        phones: optional(phones()),
        emails: optional(emails()),
        discountPercent: optional(nullable(percent())),
        associatedCompanyId: optional(nullable(hexId())),
      }),
    ),
    company: optional(object(companyShape())),
    eInvoicing: optional(
      object({
        transmissionFormat: optional(enumOf(TRANSMISSION_FORMATS)),
        channel: optional(enumOf(E_INVOICE_CHANNELS)),
        recipientCode: optional(checkedText(20, upperIf(isValidRecipientCode))),
        pec: optional(emptyAsNull(nullable(email()))),
        paymentTerms: optional(nullable(enumOf(PAYMENT_TERMS))),
        paymentMethod: optional(nullable(enumOf(PAYMENT_METHODS))),
        taxRegime: optional(nullable(enumOf(TAX_REGIMES))),
        administrationReference: optional(emptyAsNull(nullable(string({ max: MAX_ADMINISTRATION_REFERENCE, trim: true, pattern: LINE })))),
        splitPayment: optional(boolean()),
        requirePurchaseOrderData: optional(boolean()),
      }),
    ),
    account: optional(object({ email: optional(emptyAsNull(nullable(email()))), phone: optional(emptyAsNull(nullable(phone()))) })),
    fidelityCards: optional(fidelityCards()),
    services: optional(services()),
  };
}

/** Body of `POST /v1/groups/{groupId}/contacts`: every field optional, nothing else accepted. */
export const createContactBody = object(contactShape());

/** Validated body of a creation. */
export type CreateContactBody = Infer<typeof createContactBody>;

/** Body of `PATCH /v1/groups/{groupId}/contacts/{id}`: any of the fields, at least one (`required` on the body otherwise); the objects `person`, `company`, `eInvoicing` and `account` and the addresses are merged field by field. */
export const patchContactBody = atLeastOne(object(contactShape()));

/** Validated body of a modification. */
export type PatchContactBody = Infer<typeof patchContactBody>;

/** The fields every write has, for the code that reads them without caring whether it is a creation or a modification. */
export type ContactBody = CreateContactBody | PatchContactBody;

/** Query of the list of the contacts: the standard parameters (a page of at most 100, a search of at most 100 characters), the kind (`all` by default), the group of contacts and `trashed` (`false` by default). */
export const contactsQuery = object({
  ...listQueryShape(CONTACTS_LIST),
  limit: optional(integerString({ min: 1, max: MAX_CONTACTS_PAGE })),
  q: optional(string({ min: 1, max: 100, trim: true })),
  kind: optional(enumOf(CONTACT_KINDS)),
  contactGroupId: optional(hexId()),
  trashed: optional(flag()),
});

/** The validated query of the list of contacts. */
export type ContactsQuery = Infer<typeof contactsQuery>;

/** Path parameters of the routes on one contact; the group was already verified by the route. */
export const contactParams = object({ contactId: objectId() }, { allowUnknown: true });

/** Path parameters of the points adjustment: the contact and the code of its card. */
export const cardParams = object({ contactId: objectId(), code: cardCode(false) }, { allowUnknown: true });

/** Body of the points adjustment: a whole number of points, not zero, up or down, and a short reason. */
export const pointsAdjustmentBody = object({
  delta: transform(integer({ min: -MAX_POINTS_DELTA, max: MAX_POINTS_DELTA }), (value) => (value === 0 ? undefined : value), 'incorrect'),
  reason: optional(string({ min: 1, max: 200, trim: true, pattern: LINE })),
});

/** Validated body of a points adjustment. */
export type PointsAdjustmentBody = Infer<typeof pointsAdjustmentBody>;
