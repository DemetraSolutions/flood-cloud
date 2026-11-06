import { listQueryShape } from '../../shared/http/list.ts';
import { SUPPORTED_LANGUAGES } from '../me/me.schemas.ts';
import { email, enumOf, nullable, object, objectId, optional, personName, phone, string } from '../../shared/validation/schema.ts';
import type { Infer } from '../../shared/validation/schema.ts';
import { usernameSchema } from '../users/users.schemas.ts';
import { DEALERS_LIST } from './dealers.list.ts';

const code = (max: number) => string({ min: 1, max, trim: true, pattern: /^[A-Za-z0-9]+$/ });

/** The parts of an address a request may carry; which ones are required is decided on the final address. */
const addressShape = {
  street: optional(personName(200)),
  postcode: optional(string({ min: 1, max: 16, trim: true, pattern: /^[A-Za-z0-9 -]+$/ })),
  city: optional(personName(100)),
  province: optional(nullable(code(8))),
  countryCode: optional(string({ min: 2, max: 2, trim: true, pattern: /^[A-Za-z]{2}$/ })),
};

/**
 * Company fields common to the creation and the modification. `vatNumber`, `fiscalCode` and `sdiCode`
 * are checked here only for their alphabet and length; the rules that depend on the country come after the merge.
 */
const optionalCompanyShape = {
  vatNumber: optional(nullable(code(30))),
  fiscalCode: optional(nullable(code(30))),
  address: optional(nullable(object(addressShape))),
  pec: optional(nullable(email())),
  sdiCode: optional(nullable(code(7))),
  email: optional(nullable(email())),
  phone: optional(nullable(phone())),
};

/** Body of the creation (`POST /v1/dealers`): the company data and the `D` user created with it. The role is always `D`, the group none. */
export const createDealerBody = object({
  company: object({ businessName: personName(200), ...optionalCompanyShape }),
  user: object({
    username: usernameSchema(),
    password: string({ max: 1024, normalize: false }),
    firstName: optional(nullable(personName(100))),
    lastName: optional(nullable(personName(100))),
    email: optional(nullable(email())),
    phone: optional(nullable(phone())),
    language: optional(enumOf(SUPPORTED_LANGUAGES)),
  }),
});

/** Validated body of the creation of a dealer. */
export type CreateDealerBody = Infer<typeof createDealerBody>;

/** Body of the modification (`PATCH /v1/dealers/{dealerId}`, JSON Merge Patch): the company fields only. */
export const patchDealerBody = object({ businessName: optional(personName(200)), ...optionalCompanyShape });

/** Validated body of the modification of a dealer. */
export type PatchDealerBody = Infer<typeof patchDealerBody>;

/** Path parameters of the routes on one dealer. */
export const dealerParams = object({ dealerId: objectId() });

/** Query of `GET /v1/dealers`: the standard list parameters. */
export const dealersQuery = object({ ...listQueryShape(DEALERS_LIST) });

/** Validated query of the dealer list. */
export type DealersQuery = Infer<typeof dealersQuery>;
