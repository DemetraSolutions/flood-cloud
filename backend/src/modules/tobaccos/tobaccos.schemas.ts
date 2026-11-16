import { listQueryShape } from '../../shared/http/list.ts';
import { integerString, object, optional, string } from '../../shared/validation/schema.ts';
import type { Infer } from '../../shared/validation/schema.ts';
import { MAX_TOBACCOS_PAGE, TOBACCOS_LIST } from './tobaccos.list.ts';

/** Longest category the filter accepts. */
export const MAX_CATEGORY_FILTER = 100;

/** Query of `GET /v1/tobaccos`: the standard list parameters (a page of at most {@link MAX_TOBACCOS_PAGE}) and the exact `category`. Unknown parameters are refused. */
export const tobaccosQuery = object({
  ...listQueryShape(TOBACCOS_LIST),
  limit: optional(integerString({ min: 1, max: MAX_TOBACCOS_PAGE })),
  category: optional(string({ min: 1, max: MAX_CATEGORY_FILTER, trim: true })),
});

/** Validated query of the list. */
export type TobaccosQuery = Infer<typeof tobaccosQuery>;
