import { listQueryShape } from '../../shared/http/list.ts';
import { enumOf, integerString, object, optional, string } from '../../shared/validation/schema.ts';
import type { Infer } from '../../shared/validation/schema.ts';
import { LOOKUP_LIST, MAX_LOOKUP_LIMIT } from './lookup.list.ts';

/** Product types the legacy writes (`type` of `products`): ordinary, service, VAT-exempt, tobaccos, games and monopoly. */
export const LOOKUP_PRODUCT_TYPES = ['product', 'service', 'exempt', 'tobaccos', 'games', 'monopoly'] as const;

/** Largest number of ids `ids` accepts. */
export const MAX_LOOKUP_IDS = MAX_LOOKUP_LIMIT;

/** `ids`: up to {@link MAX_LOOKUP_IDS} comma-separated ObjectIds, to resolve the names of elements already chosen. */
const ids = optional(string({ min: 24, max: MAX_LOOKUP_IDS * 25 - 1, pattern: new RegExp(`^[0-9a-fA-F]{24}(,[0-9a-fA-F]{24}){0,${MAX_LOOKUP_IDS - 1}}$`) }));

const shape = { ...listQueryShape(LOOKUP_LIST), limit: optional(integerString({ min: 1, max: MAX_LOOKUP_LIMIT })), ids };

/** Query of the compact reads of categories, customers and contact groups: the common list parameters (page of at most 100) and `ids`. */
export const lookupQuery = object(shape);

/** Query of `GET /v1/groups/{groupId}/lookup/products`: the common parameters, `ids` and the optional `type`. */
export const lookupProductsQuery = object({ ...shape, type: optional(enumOf(LOOKUP_PRODUCT_TYPES)) });

/** Validated query of the compact reads without `type`. */
export type LookupQuery = Infer<typeof lookupQuery>;

/** Validated query of the compact read of products. */
export type LookupProductsQuery = Infer<typeof lookupProductsQuery>;
