import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { InvalidWriteInputError } from './errors.ts';

/** The fields of a company that the write service owns: the registry data and the state (`COMPANIES_OWNED_FIELDS` minus `trash` and `updateDate`). */
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

/** The fields of a place that the write service owns: the registry data and the state (`PLACES_OWNED_FIELDS` minus `trash` and `updateDate`). */
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
  /** Whether the place is enabled. */
  readonly status: boolean;
  /** End of the license, or `null` for none. */
  readonly expirationDate: Date | null;
}

/** Fields of a new company: only the name is required, the others take the defaults of {@link newCompanyDocument}. */
export type NewCompanyFields = Pick<CompanyFields, 'name'> & Partial<CompanyFields>;

/** Fields of a new place: the name and the company are required, the others take the defaults of {@link newPlaceDocument}. */
export type NewPlaceFields = Pick<PlaceFields, 'name' | 'companyId'> & Partial<PlaceFields> & {
  /** Name of the first storage of the place, `Deposito 1` by default. */
  readonly storageName?: string;
};

/** How the value of a field is checked. */
type FieldKind = 'name' | 'text' | 'textOrNull' | 'boolean' | 'dateOrNull' | 'objectId' | 'flagOrTextOrNull';

/** Kind of every field of a company. */
export const COMPANY_FIELD_KINDS: Readonly<Record<keyof CompanyFields, FieldKind>> = Object.freeze({
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
});

/** Kind of every field of a place. */
export const PLACE_FIELD_KINDS: Readonly<Record<keyof PlaceFields, FieldKind>> = Object.freeze({
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
  status: 'boolean',
  expirationDate: 'dateOrNull',
});

const CHECKS: Readonly<Record<FieldKind, (value: unknown) => boolean>> = {
  name: (value) => typeof value === 'string' && value.trim() !== '',
  text: (value) => typeof value === 'string',
  textOrNull: (value) => value === null || typeof value === 'string',
  boolean: (value) => typeof value === 'boolean',
  dateOrNull: (value) => value === null || (value instanceof Date && !Number.isNaN(value.getTime())),
  objectId: (value) => value instanceof ObjectId,
  flagOrTextOrNull: (value) => value === null || typeof value === 'string' || typeof value === 'boolean',
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
