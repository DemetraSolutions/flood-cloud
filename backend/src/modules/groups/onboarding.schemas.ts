import { INVALID, array, boolean, email, enumOf, integer, isoDate, nullable, number, object, objectId, optional, personName, phone, string } from '../../shared/validation/schema.ts';
import type { Infer } from '../../shared/validation/schema.ts';
import { addressSchema, checkedText, emptyAsNull, required, upperIf } from '../companies/companies.schemas.ts';
import { isValidRecipientCode } from '../companies/validators.ts';
import { PLANS } from '../places/places.schemas.ts';
import { usernameSchema } from '../users/users.schemas.ts';
import { MAX_TAXES } from './catalogs/taxes.ts';
import { featuresShape } from './groups.schemas.ts';
import { endOfDayInRome } from './onboarding.documents.ts';
import type { Schema } from '../../shared/validation/schema.ts';

/** Body limit of the creation of a customer: a few kilobytes (the largest part is the list of tax rates). */
export const ONBOARDING_BODY_LIMIT = '32kb';

/** Longest password accepted in a request, in UTF-16 units (the policy then checks 12 to 128 code points). */
const MAX_PASSWORD_LENGTH = 1024;

/** A free text of the form: trimmed, at most `max` characters, `null` or `''` for none. */
const optionalText = (max: number) => optional(emptyAsNull(nullable(string({ min: 0, max, trim: true }))));

/** The e-invoicing data the form of a new customer asks for: the recipient code and the PEC (at least one of them for an Italian company, checked by the service),. */
const eInvoicing = object({
  recipientCode: optional(checkedText(7, upperIf(isValidRecipientCode))),
  pec: optional(emptyAsNull(nullable(email()))),
});

/** The address of the place when it is not the one of the company (the box "different data" of the form): the country is the one of the company. */
const placeAddress = object({
  street: string({ min: 1, max: 150, trim: true }),
  postcode: string({ min: 1, max: 20, trim: true }),
  city: string({ min: 1, max: 100, trim: true }),
  province: optional(string({ max: 10, trim: true })),
});

/** An expiration: an ISO 8601 date-time as it is, or a date alone, which stands for the end of that day in Italy (23:59:59 `Europe/Rome`). */
const expiration: Schema<Date, false> = {
  optional: false,
  parse: (value, path, context, depth) => {
    const parsed = isoDate().parse(value, path, context, depth);
    return parsed !== INVALID && typeof value === 'string' && value.length === 10 ? endOfDayInRome(parsed) : parsed;
  },
};

/**
 * Body of the creation of a customer (`POST /v1/groups`): the group, its first company, its first place, its administrator (SA) and the tax rates, each with its department, in the
 * fields of the form "Nuovo cliente" of the legacy. Nothing else is accepted: no role, permission, status, API key, cluster or id, and the group of every document is the new one.
 * Which values a role may choose (the dealer, the demo flag, the plan) is decided by the service, after the validation.
 */
export const createGroupBody = object({
  group: object({
    name: personName(200),
    /** The features of the group beyond the defaults (`cash` and `productsVariants` on): free for a PSA and a dealer. */
    features: optional(object(featuresShape)),
    /** A demo group: for the PSA only. */
    demo: optional(boolean()),
    /** The dealer of the group: for the PSA only (a dealer is always the dealer of his own groups). */
    dealerId: optional(objectId()),
  }),
  company: object({
    name: string({ min: 1, max: 150, trim: true }),
    vatNumber: string({ min: 1, max: 30, trim: true }),
    fiscalCode: optional(emptyAsNull(nullable(string({ max: 30, trim: true })))),
    address: addressSchema(required),
    email: optional(emptyAsNull(nullable(email()))),
    phone: optional(emptyAsNull(nullable(phone()))),
    eInvoicing: optional(eInvoicing),
  }),
  place: object({
    name: string({ min: 1, max: 150, trim: true }),
    address: optional(placeAddress),
    contactName: optionalText(100),
    email: optional(emptyAsNull(nullable(email()))),
    phone: optional(emptyAsNull(nullable(phone()))),
    plan: optional(enumOf(PLANS)),
    expirationDate: optional(expiration),
  }),
  user: object({
    username: usernameSchema(),
    password: string({ max: MAX_PASSWORD_LENGTH, normalize: false }),
    firstName: optional(nullable(personName(100))),
    lastName: optional(nullable(personName(100))),
    email: optional(nullable(email())),
    phone: optional(nullable(phone())),
  }),
  taxes: array(object({ rate: number({ min: 0, max: 100 }), department: integer({ min: 1, max: 99 }) }), { min: 1, max: MAX_TAXES }),
});

/** Validated body of the creation of a customer. */
export type CreateGroupBody = Infer<typeof createGroupBody>;
