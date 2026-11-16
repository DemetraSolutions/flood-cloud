import { Double, Int32, Long, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { ECOMMERCE_FLAGS, E_INVOICING_KEYS, MEDIA_IMAGE_KEYS } from './company-paths.ts';
import { InvalidWriteInputError } from './errors.ts';
import { WEEK_DAYS } from './place-paths.ts';
import { LIST_PATHS } from './place-lists.ts';
import { SETTING_FIELDS, DEPRECATED_ROOMS_PATHS } from './place-settings.ts';

/** Largest `settings.global.lastInvoiceNumber` (the largest Int32): the legacy writes it as an Int32. */
export const MAX_INVOICE_NUMBER = 2_147_483_647;

/**
 * The fields of a company that the write service owns at the top level of the document: the registry data and the state. The rest of what it owns
 * (`COMPANIES_OWNED_FIELDS` minus `trash` and `updateDate`) is {@link CompanyBlockFields}.
 */
export interface CompanyFields {
  /** Name of the company. */
  readonly name: string;
  /** Legacy `code`: the VAT number. */
  readonly code: string;
  /** Legacy `code2`: the fiscal code. */
  readonly code2: string;
  readonly address: string;
  readonly postcode: string;
  readonly city: string;
  /** Province code. */
  readonly countryAreaCode: string;
  /** ISO 3166-1 alpha-2 country code. */
  readonly countryCode: string;
  /** ISO 4217 currency code. */
  readonly currencyCode: string;
  readonly email: string | null;
  readonly telephone: string | null;
  /** Whether the company is enabled. */
  readonly status: boolean;
  /** End of the license, or `null` for none. */
  readonly expirationDate: Date | null;
}

/**
 * The top-level fields of a place that the write service owns: the registry data, the license and the state. The rest of what it owns
 * (`PLACES_OWNED_FIELDS` minus `trash` and `updateDate`) is {@link PlaceBlockFields}.
 */
export interface PlaceFields {
  readonly name: string;
  readonly address: string;
  readonly postcode: string;
  readonly city: string;
  /** Province code. */
  readonly countryAreaCode: string;
  /** ISO 3166-1 alpha-2 country code. */
  readonly countryCode: string;
  /** Name of the contact person. */
  readonly contact: string | null;
  readonly email: string | null;
  readonly telephone: string | null;
  /** The company of the place: it must exist in the same group and not be in the trash. */
  readonly companyId: ObjectId;
  /** Id of the price list of the sales (a key of the price lists of the group). */
  readonly listId: string | null;
  /** Id of the price list of the e-commerce. */
  readonly ecommerceListId: string | null;
  /** Legacy `invoicePS`, written as given (`false` or `null` when not set up). */
  readonly invoicePS: string | boolean | null;
  /** IANA time zone. */
  readonly timezone: string;
  /** The plan of the license as stored (`basic`, `advanced`, `enterprice`, `tgm-secondary`, `desk-secondary`, or a historical value the service leaves as it is). */
  readonly plan: string;
  /** Whether the place is enabled. */
  readonly status: boolean;
  /** End of the license, or `null` for none. */
  readonly expirationDate: Date | null;
}

/**
 * The other owned fields of a place, by their legacy dotted path: the enabled price lists (`general.priceLists`) and the
 * opening and delivery hours (`openingTime.weekGeneric`, `openingTime.daySpecial`, `delivery.time.weekGeneric`, `delivery.time.daySpecial`), each a whole value. Each is checked
 * by its own kind ({@link PLACE_FIELD_KINDS}): the values are exactly what is stored, never a whole block.
 */
export interface PlaceBlockFields {
  readonly [path: string]: unknown;
}

/**
 * The other owned fields of a company, by their legacy dotted path: `invoicesPS`, the arrays `invoicesPSValues`, `banks` and `ticketsSuppliers` (each a whole
 * value), and the keys of the blocks one by one (`fattura_elettronica.hub`, `settings.global.lastInvoiceNumber`, `settings.ecommerce.minAmount`,
 * `medias.images.externalUrl`…; `COMPANIES_OWNED_FIELDS` lists them all). Each is checked by its own kind ({@link COMPANY_FIELD_KINDS}): the
 * values are exactly what is stored, never a whole block.
 */
export interface CompanyBlockFields {
  readonly [path: string]: unknown;
}

/** Fields of a new company: only the name is required, the others take the defaults of {@link newCompanyDocument}. */
export type NewCompanyFields = Pick<CompanyFields, 'name'> & Partial<CompanyFields> & CompanyBlockFields;

/** The changes of an update of a company: any of the owned fields, at least one. */
export type CompanyChanges = Partial<CompanyFields> & CompanyBlockFields;

/** Fields of a new place: the name and the company are required, the others take the defaults of {@link newPlaceDocument}. */
export type NewPlaceFields = Pick<PlaceFields, 'name' | 'companyId'> & Partial<PlaceFields> & PlaceBlockFields & {
  /** Name of the first storage of the place, `Deposito 1` by default. */
  readonly storageName?: string;
};

/** The changes of an update of a place: any of the owned fields, at least one. */
export type PlaceChanges = Partial<PlaceFields> & PlaceBlockFields;

/** How the value of a field is checked. */
type FieldKind =
  | 'name'
  | 'text'
  | 'textOrNull'
  | 'boolean'
  | 'dateOrNull'
  | 'objectId'
  | 'flagOrTextOrNull'
  | 'amount'
  | 'invoiceNumberOrNull'
  | 'positionOrNull'
  | 'minAmount'
  | 'invoiceSeries'
  | 'banks'
  | 'suppliers'
  | 'logoOrNull'
  | 'priceLists'
  | 'itemList'
  | 'weekHours'
  | 'specialDays'
  | 'setting';

/** Kind of every field of a company: the registry data, the whole values and every owned key of the blocks, by dotted path. */
export const COMPANY_FIELD_KINDS: Readonly<Record<string, FieldKind>> = Object.freeze({
  name: 'name',
  code: 'text',
  code2: 'text',
  address: 'text',
  postcode: 'text',
  city: 'text',
  countryAreaCode: 'text',
  countryCode: 'text',
  currencyCode: 'text',
  email: 'textOrNull',
  telephone: 'textOrNull',
  status: 'boolean',
  expirationDate: 'dateOrNull',
  invoicesPS: 'positionOrNull',
  invoicesPSValues: 'invoiceSeries',
  banks: 'banks',
  ticketsSuppliers: 'suppliers',
  ...Object.fromEntries(E_INVOICING_KEYS.map((key) => [`fattura_elettronica.${key}`, 'text' as const])),
  'settings.global.enableLoginSignup': 'boolean',
  'settings.global.showPrivacyPage': 'boolean',
  'settings.global.showTermsPage': 'boolean',
  'settings.global.discountLines': 'boolean',
  'settings.global.lastInvoiceNumber': 'invoiceNumberOrNull',
  'settings.api.cerved': 'boolean',
  ...Object.fromEntries(ECOMMERCE_FLAGS.map((key) => [`settings.ecommerce.${key}`, 'boolean' as const])),
  'settings.ecommerce.listId': 'text',
  'settings.ecommerce.minAmount': 'minAmount',
  'settings.ecommerce.showProductRemainingQuantity': 'amount',
  ...Object.fromEntries(MEDIA_IMAGE_KEYS.map((key) => [`medias.images.${key}`, key.startsWith('customersAppLogo') ? ('logoOrNull' as const) : ('text' as const)])),
});

/** Kind of every field of a place: the top-level ones and every owned leaf path of the blocks, by dotted path. */
export const PLACE_FIELD_KINDS: Readonly<Record<string, FieldKind>> = Object.freeze({
  name: 'name',
  address: 'text',
  postcode: 'text',
  city: 'text',
  countryAreaCode: 'text',
  countryCode: 'text',
  contact: 'textOrNull',
  email: 'textOrNull',
  telephone: 'textOrNull',
  companyId: 'objectId',
  listId: 'textOrNull',
  ecommerceListId: 'textOrNull',
  invoicePS: 'flagOrTextOrNull',
  timezone: 'text',
  plan: 'text',
  status: 'boolean',
  expirationDate: 'dateOrNull',
  'general.priceLists': 'priceLists',
  'openingTime.weekGeneric': 'weekHours',
  'openingTime.daySpecial': 'specialDays',
  'delivery.time.weekGeneric': 'weekHours',
  'delivery.time.daySpecial': 'specialDays',
  // The settings of step 7B: a value of the shape the schemas give (checked loosely here), the images as descriptors.
  ...Object.fromEntries(SETTING_FIELDS.filter((field) => field.readOnly !== true).map((field) => [field.legacy, field.kind.t === 'logo' ? ('logoOrNull' as const) : ('setting' as const)])),
  // The lists of items (step 7F): the fragments of the items, which the write lays over the stored ones inside the transaction.
  ...Object.fromEntries(LIST_PATHS.map((path) => [path, 'itemList' as const])),
  ...Object.fromEntries(DEPRECATED_ROOMS_PATHS.map((path) => [path, 'setting' as const])),
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

type Shape = Readonly<Record<string, 'string' | 'boolean' | 'numbers' | 'stringOrNull'>>;

/** Whether a value is an object with exactly the given keys, each of the given type (`numbers`: a list of numbers, `null` allowed as an element). */
function hasShape(value: unknown, shape: Shape): boolean {
  if (!isPlainObject(value)) {
    return false;
  }
  const keys = Object.keys(shape);
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => {
      const item = value[key];
      if (shape[key] === 'stringOrNull') {
        return item === null || typeof item === 'string';
      }
      return shape[key] === 'numbers' ? Array.isArray(item) && item.every((cut) => cut === null || (typeof cut === 'number' && Number.isFinite(cut) && cut >= 0)) : typeof item === shape[key];
    })
  );
}

/** The keys of a logo descriptor, in the order the legacy Media Manager writes them. */
const LOGO_DESCRIPTOR_KEYS = ['_id', 'dirname', 'basename', 'extension', 'filename', 'mimetype', 'filectime', 'mmThumb', 'type', 'title', 'alt'] as const;

/**
 * Whether a value is the descriptor of a logo as the legacy stores it: exactly the eleven keys in order, `_id` the hexadecimal string of an id, `filectime` a finite number or a
 * double, `mmThumb` an empty object, `type` `image`, the rest text.
 */
function isLogoDescriptor(value: unknown): boolean {
  if (!isPlainObject(value) || Object.keys(value).join() !== LOGO_DESCRIPTOR_KEYS.join()) {
    return false;
  }
  const created = value['filectime'];
  const mmThumb = value['mmThumb'];
  return (
    typeof value['_id'] === 'string' &&
    /^[0-9a-f]{24}$/.test(value['_id']) &&
    (created instanceof Double ? Number.isFinite(created.value) : typeof created === 'number' && Number.isFinite(created)) &&
    isPlainObject(mmThumb) &&
    Object.keys(mmThumb).length === 0 &&
    value['type'] === 'image' &&
    (['dirname', 'basename', 'extension', 'filename', 'mimetype', 'title', 'alt'] as const).every((key) => typeof value[key] === 'string')
  );
}

const listOf = (shape: Shape) => (value: unknown): boolean => Array.isArray(value) && value.every((item) => hasShape(item, shape));

/** Most time slots of one day, and most special days of a place, that a write accepts. */
export const MAX_DAY_SLOTS = 8;
export const MAX_SPECIAL_DAYS = 400;

/** A key of the special days: `YYYY-MM-DD`. */
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** Whether a value is the hours of one day: the flag (`active` for a day of the week, `closed` for a special day) and at most {@link MAX_DAY_SLOTS} slots `{ start, end }` of text. */
function isDayHours(value: unknown, flag: 'active' | 'closed'): boolean {
  if (!isPlainObject(value) || Object.keys(value).length !== 2 || typeof value[flag] !== 'boolean') {
    return false;
  }
  const slots = value['values'];
  return Array.isArray(slots) && slots.length <= MAX_DAY_SLOTS && slots.every((slot) => hasShape(slot, { start: 'string', end: 'string' }));
}

/** Most elements of a list and keys of a map of a settings value, and its deepest nesting. */
const MAX_SETTING_ITEMS = 500;
const MAX_SETTING_DEPTH = 6;

/**
 * Whether a value is one a settings key can hold: `null`, a boolean, a finite number, a text of at most 5000 characters, an `ObjectId`, a date, a BSON number kept from the stored document, or a list or plain object of such values (at most
 * {@link MAX_SETTING_ITEMS} elements, six levels deep) without a key that is an operator (`$…`) or a path (`a.b`).
 */
function isSettingValue(value: unknown, depth = 0): boolean {
  if (value === null || typeof value === 'boolean' || value instanceof ObjectId || value instanceof Date) {
    return true;
  }
  if (value instanceof Int32 || value instanceof Double || value instanceof Long) {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (typeof value === 'string') {
    return value.length <= 5000;
  }
  if (depth >= MAX_SETTING_DEPTH) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length <= MAX_SETTING_ITEMS && value.every((item) => isSettingValue(item, depth + 1));
  }
  return isPlainObject(value) && Object.keys(value).length <= MAX_SETTING_ITEMS && Object.entries(value).every(([key, item]) => !key.startsWith('$') && !key.includes('.') && isSettingValue(item, depth + 1));
}

const CHECKS: Readonly<Record<FieldKind, (value: unknown) => boolean>> = {
  setting: (value) => isSettingValue(value),
  // The fragments of a list: items that are objects with an id, of values a settings key can hold.
  itemList: (value) => Array.isArray(value) && value.length <= MAX_SETTING_ITEMS && value.every((item) => isPlainObject(item) && isSettingValue(item)),
  name: (value) => typeof value === 'string' && value.trim() !== '',
  text: (value) => typeof value === 'string',
  textOrNull: (value) => value === null || typeof value === 'string',
  boolean: (value) => typeof value === 'boolean',
  dateOrNull: (value) => value === null || (value instanceof Date && !Number.isNaN(value.getTime())),
  objectId: (value) => value instanceof ObjectId,
  flagOrTextOrNull: (value) => value === null || typeof value === 'string' || typeof value === 'boolean',
  amount: (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0,
  invoiceNumberOrNull: (value) => value === null || (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_INVOICE_NUMBER),
  positionOrNull: (value) => value === null || value === 'prefix' || value === 'suffix',
  // The minimum orders by currency: only the keys that are operators are refused (a legacy key the backend keeps untouched is not judged).
  minAmount: (value) => isPlainObject(value) && Object.keys(value).every((key) => !key.startsWith('$')),
  invoiceSeries: listOf({ name: 'string', cash: 'boolean' }),
  banks: listOf({ id: 'string', name: 'string', iban: 'string', abi: 'string', cab: 'string', bic: 'string', default: 'boolean' }),
  suppliers: listOf({ id: 'string', name: 'string', cuts: 'numbers' }),
  logoOrNull: (value) => value === null || isLogoDescriptor(value),
  priceLists: listOf({ id: 'string', allYouCanEat: 'boolean', ayceCode1: 'stringOrNull', ayceCode2: 'stringOrNull' }),
  // The seven days of the week, each complete; the keys the document has besides them are the caller's to keep (the codec merges them).
  weekHours: (value) => isPlainObject(value) && WEEK_DAYS.every((day) => isDayHours(value[day], 'active')),
  // The special days by date; a key that is not a date is a key of the document the caller keeps, and is not judged (an operator never is acceptable).
  specialDays: (value) =>
    isPlainObject(value) &&
    Object.keys(value).filter((key) => DAY_KEY.test(key)).length <= MAX_SPECIAL_DAYS &&
    Object.entries(value).every(([key, hours]) => !key.startsWith('$') && (!DAY_KEY.test(key) || isDayHours(hours, 'closed'))),
};

/**
 * Checks the fields of a write against the allowlist and the kind of each one, and returns them as a new plain object: nothing of
 * the input object itself is ever written (no prototype keys, no unknown keys). A field set to `undefined` counts as absent.
 *
 * @param kinds Allowlist with the kind of each field.
 * @param input The fields of the write.
 * @returns The validated fields, in the order of the input.
 * @throws {InvalidWriteInputError} If the input is not an object, a key is not in the allowlist or a value is not of the right kind.
 */
export function checkFields(kinds: Readonly<Record<string, FieldKind>>, input: unknown): Document {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new InvalidWriteInputError('The fields of a write must be an object');
  }
  const checked: Document = {};
  for (const [field, value] of Object.entries(input)) {
    if (value === undefined) {
      continue;
    }
    if (!Object.hasOwn(kinds, field)) {
      throw new InvalidWriteInputError('Field not allowed in a write', field);
    }
    if (!CHECKS[kinds[field] as FieldKind](value)) {
      throw new InvalidWriteInputError('Invalid value for a field', field);
    }
    checked[field] = value;
  }
  return checked;
}

/**
 * Checks the fields of an update: at least one, all in the allowlist.
 *
 * @param kinds Allowlist with the kind of each field.
 * @param input The fields to change.
 * @returns The validated fields.
 * @throws {InvalidWriteInputError} As {@link checkFields}, or if there is nothing to change.
 */
export function checkChanges(kinds: Readonly<Record<string, FieldKind>>, input: unknown): Document {
  const checked = checkFields(kinds, input);
  if (Object.keys(checked).length === 0) {
    throw new InvalidWriteInputError('An update must change at least one field');
  }
  return checked;
}

/**
 * Checks that a value is an `ObjectId`.
 *
 * @param value The value.
 * @param field Name reported in the error.
 * @returns The same value, typed.
 * @throws {InvalidWriteInputError} If it is not an `ObjectId`.
 */
export function checkObjectId(value: unknown, field: string): ObjectId {
  if (!(value instanceof ObjectId)) {
    throw new InvalidWriteInputError('Not an ObjectId', field);
  }
  return value;
}

/**
 * Checks that the fields a creation cannot do without are present.
 *
 * @param checked Fields already validated by {@link checkFields}.
 * @param required Names of the required fields.
 * @throws {InvalidWriteInputError} Naming the first missing field.
 */
export function requireFields(checked: Document, required: readonly string[]): void {
  for (const field of required) {
    if (!Object.hasOwn(checked, field)) {
      throw new InvalidWriteInputError('Required field missing', field);
    }
  }
}
