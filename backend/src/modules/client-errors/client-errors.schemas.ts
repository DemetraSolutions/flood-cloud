import { isoDate, object, optional, string } from '../../shared/validation/schema.ts';
import type { Infer } from '../../shared/validation/schema.ts';

/** A route pattern: `/` or segments that are a literal name, a `:parameter` or `**`; a segment of digits only or of 24 hex digits is a concrete id, not a pattern. */
const ROUTE_PATTERN =
  /^(?:\/(?:(?::[A-Za-z][A-Za-z0-9]*)|(?![0-9]+(?=\/|$))(?![0-9a-fA-F]{24}(?=\/|$))[A-Za-z0-9_-]+|\*\*))+$|^\/$/;

/**
 * Body of `POST /v1/client-errors`: a JavaScript error caught by the backoffice. `route` is the
 * route pattern (`/groups/:groupId/users`), never the concrete URL: no query string, fragment, number or identifier.
 */
export const clientErrorBody = object({
  name: string({ min: 1, max: 100, pattern: /^[^\p{Cc}\p{Cf}]+$/u }),
  message: string({ max: 300 }),
  stack: optional(string({ max: 4000 })),
  route: string({ min: 1, max: 200, pattern: ROUTE_PATTERN }),
  appVersion: string({ min: 1, max: 32, pattern: /^[0-9A-Za-z.+-]+$/ }),
  occurredAt: optional(isoDate()),
});

/** Validated body of the browser error report. */
export type ClientErrorBody = Infer<typeof clientErrorBody>;
