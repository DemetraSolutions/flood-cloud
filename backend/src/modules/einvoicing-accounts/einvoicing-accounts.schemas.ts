import { boolean, integer, nullable, object, optional, string } from '../../shared/validation/schema.ts';
import type { Infer } from '../../shared/validation/schema.ts';

/** Body limit of the write of an account: a few hundred bytes. */
export const E_INVOICING_ACCOUNT_BODY_LIMIT = '4kb';

/** Printable ASCII without spaces: what an Aruba user name is made of. */
const USERNAME = /^[\x21-\x7e]+$/;

/** No control character of any kind (C0, DEL, C1). */
const NO_CONTROL = /^[^\u0000-\u001F\u007F-\u009F]+$/;

/**
 * Body of the write of an Aruba account (`PUT .../integrations/aruba`): the whole account but the password, which is optional (absent keeps the stored one, and is required while the account does not exist).
 * Nothing else is accepted. The password is never trimmed nor normalized.
 */
export const arubaAccountBody = object({
  enabled: boolean(),
  username: string({ min: 1, max: 100, pattern: USERNAME, normalize: false }),
  password: optional(string({ min: 1, max: 256, pattern: NO_CONTROL, normalize: false })),
  maxPerHour: integer({ min: 1, max: 1000 }),
  maxPerYear: nullable(integer({ min: 1, max: 100_000_000 })),
});

/** Validated body of the write of an Aruba account. */
export type ArubaAccountBody = Infer<typeof arubaAccountBody>;
