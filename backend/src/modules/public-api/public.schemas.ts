import { MAX_CURSOR_LENGTH } from '../../shared/http/list.ts';
import { integerString, object, objectId, optional, string } from '../../shared/validation/schema.ts';
import type { Infer } from '../../shared/validation/schema.ts';

/** Largest page the public lists give: smaller than the one of `/v1`. */
export const PUBLIC_MAX_LIMIT = 100;

/** Query of the public lists (`places`, `companies`): the page size and the cursor. Nothing else is accepted: no filter, no sort, no search of the client reaches the database. */
export const publicListQuery = object({
  limit: optional(integerString({ min: 1, max: PUBLIC_MAX_LIMIT })),
  cursor: optional(string({ min: 1, max: MAX_CURSOR_LENGTH, normalize: false })),
});

/** Validated query of a public list. */
export type PublicListQuery = Infer<typeof publicListQuery>;

/** Path parameter of `GET /public/v1/places/{placeId}`. */
export const placeParams = object({ placeId: objectId() });

/** Path parameter of `GET /public/v1/companies/{companyId}`. */
export const companyParams = object({ companyId: objectId() });

/** The endpoints that take no input accept no query string either. */
export const noQuery = object({});
