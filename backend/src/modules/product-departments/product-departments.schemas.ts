import { integer, object, optional, boolean, string } from '../../shared/validation/schema.ts';
import type { Infer } from '../../shared/validation/schema.ts';
import type { ListConfig } from '../../shared/http/list.ts';
import { localizedName } from '../../db/localized-name.ts';
import { SAFE_ID } from '../groups/catalogs/kit.ts';
import { atLeastOne, commonCreateShape, commonPatchShape, entityQuery } from '../product-catalog/entity.schemas.ts';

/** Smallest and largest code of a department: the number of the department on the cash register. */
export const DEPARTMENT_CODE_RANGE = Object.freeze({ min: 1, max: 99 });

/**
 * How the departments are sorted and searched: by name (the text in the language of the caller, or the first one the entry has) by default, or by code; `q` is looked for in the name, in every language,
 * case-insensitive, as literal text. The fields below name what is sorted; {@link departmentsListFor} gives the expression of the language of the caller.
 */
export const DEPARTMENTS_LIST: ListConfig = Object.freeze({
  sorts: Object.freeze({
    name: Object.freeze({ field: 'name', kind: 'string' as const }),
    code: Object.freeze({ field: 'code', kind: 'number' as const }),
  }),
  defaultSort: 'name',
  searchFields: Object.freeze(['name']),
});

/**
 * The sorts of the departments for the language of the caller: the name sorts as its text in that language (else the first the entry has, `null` for a name that is not a set of texts), the code
 * as a number even when the legacy stored it as text (`null` for a code that is not a whole number, which sorts first).
 *
 * @param language The language of the caller.
 */
export function departmentsListFor(language: string): ListConfig {
  return {
    ...DEPARTMENTS_LIST,
    sorts: {
      name: { field: 'name', kind: 'string', expression: localizedName(language) },
      code: { field: 'code', kind: 'number', expression: { $convert: { input: '$code', to: 'int', onError: null, onNull: null } } },
    },
  };
}

/** Query of the list of the departments. */
export const departmentsQuery = entityQuery(DEPARTMENTS_LIST);

/** The id of a tax rate of the group. */
const taxId = () => string({ min: 1, max: 64, pattern: SAFE_ID });

/** Body of `POST /v1/groups/{groupId}/product-departments`: the code, the name and the tax rate are required. Nothing else is accepted. */
export const createDepartmentBody = object({
  ...commonCreateShape(),
  code: integer(DEPARTMENT_CODE_RANGE),
  taxId: taxId(),
  noDiscount: optional(boolean()),
  secondaryFiscalPrinter: optional(boolean()),
});

/** Validated body of a creation. */
export type CreateDepartmentBody = Infer<typeof createDepartmentBody>;

/** Body of `PATCH /v1/groups/{groupId}/product-departments/{id}`: any of the fields, at least one (`required` on the body otherwise). */
export const patchDepartmentBody = atLeastOne(
  object({ ...commonPatchShape(), code: optional(integer(DEPARTMENT_CODE_RANGE)), taxId: optional(taxId()), noDiscount: optional(boolean()), secondaryFiscalPrinter: optional(boolean()) }),
);

/** Validated body of a modification. */
export type PatchDepartmentBody = Infer<typeof patchDepartmentBody>;
