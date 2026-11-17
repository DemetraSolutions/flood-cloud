import { object, string } from '../../shared/validation/schema.ts';
import type { Infer } from '../../shared/validation/schema.ts';

/**
 * Path parameters of `GET /v1/vat-lookups/{vatNumber}`. The schema only types the value (any text the URL can carry, trimmed): the VAT number is judged by the service,
 * which answers with the issue `format` or `checksum` and never reports a length of its own.
 */
export const vatLookupParams = object({ vatNumber: string({ max: 8192, trim: true }) });

/** Validated path parameters of the lookup. */
export type VatLookupParams = Infer<typeof vatLookupParams>;
