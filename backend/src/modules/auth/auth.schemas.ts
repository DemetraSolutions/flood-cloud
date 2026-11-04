import { object, string } from '../../shared/validation/schema.ts';
import type { Infer } from '../../shared/validation/schema.ts';

/**
 * Hard cap on the strings the schema accepts. The login limit (1 to 1024 units) is enforced by the
 * service with `401 INVALID_CREDENTIALS`, not here with a 422, so oversized values never reveal
 * more than a wrong password does; this cap only bounds what is parsed.
 */
const PARSE_LIMIT = 4096;

/** Body of `POST /v1/auth/login`: strings kept exactly as sent (no trim, no normalization). */
export const loginBody = object({
  username: string({ max: PARSE_LIMIT, normalize: false }),
  password: string({ max: PARSE_LIMIT, normalize: false }),
});

/** Validated login body. */
export type LoginBody = Infer<typeof loginBody>;

/** Body of `POST /v1/auth/refresh`. The format of the token is checked by the service. */
export const refreshBody = object({
  refreshToken: string({ max: 256, normalize: false }),
});

/** Validated refresh body. */
export type RefreshBody = Infer<typeof refreshBody>;
