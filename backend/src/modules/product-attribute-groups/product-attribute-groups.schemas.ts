import { listQueryShape } from '../../shared/http/list.ts';
import type { ListConfig } from '../../shared/http/list.ts';
import { array, integerString, object, optional, refine, string } from '../../shared/validation/schema.ts';
import type { Infer } from '../../shared/validation/schema.ts';
import { localizedName } from '../../db/localized-name.ts';
import { SAFE_ID } from '../groups/catalogs/kit.ts';
import { MAX_ENTITIES_PAGE, atLeastOne } from '../product-catalog/entity.schemas.ts';
import { nameTexts, nameTextsPatch } from '../product-catalog/texts.ts';

/** Most attributes a group of attributes may have. */
export const MAX_ATTRIBUTES = 200;

/** How the groups of attributes are sorted and searched: by name (the text in the language of the caller, or the first one the group has); `q` is looked for in the name, in every language, as literal text. */
export const ATTRIBUTE_GROUPS_LIST: ListConfig = Object.freeze({
  sorts: Object.freeze({ name: Object.freeze({ field: 'name', kind: 'string' as const }) }),
  defaultSort: 'name',
  searchFields: Object.freeze(['name']),
});

/**
 * The sorts of the groups of attributes for the language of the caller.
 *
 * @param language The language of the caller.
 */
export function attributeGroupsListFor(language: string): ListConfig {
  return { ...ATTRIBUTE_GROUPS_LIST, sorts: { name: { field: 'name', kind: 'string', expression: localizedName(language) } } };
}

/** Query of the list of the groups of attributes. */
export const attributeGroupsQuery = object({ ...listQueryShape(ATTRIBUTE_GROUPS_LIST), limit: optional(integerString({ min: 1, max: MAX_ENTITIES_PAGE })) });

/** Body of `POST /v1/groups/{groupId}/product-attribute-groups`: the name is required; the attributes, if any, carry only their name (the server gives each its id). */
export const createAttributeGroupBody = object({ name: nameTexts(), attributes: optional(array(object({ name: nameTexts() }), { max: MAX_ATTRIBUTES })) });

/** Validated body of a creation. */
export type CreateAttributeGroupBody = Infer<typeof createAttributeGroupBody>;

/** The attributes of a modification: the whole list, each element with the id it already has (and a name) or without an id (a new attribute); an id may not repeat. */
const attributesPatch = () =>
  refine(
    array(object({ id: optional(string({ min: 1, max: 64, pattern: SAFE_ID })), name: nameTexts() }), { max: MAX_ATTRIBUTES }),
    (list) => {
      const seen = new Set<string>();
      return list.flatMap((attribute, index) => {
        if (attribute.id === undefined) {
          return [];
        }
        const repeated = seen.has(attribute.id);
        seen.add(attribute.id);
        return repeated ? [`${String(index)}.id`] : [];
      });
    },
    'incorrect',
  );

/** Body of `PATCH /v1/groups/{groupId}/product-attribute-groups/{id}`: the name (merged by language) and/or the whole list of the attributes; at least one (`required` on the body otherwise). */
export const patchAttributeGroupBody = atLeastOne(object({ name: optional(nameTextsPatch()), attributes: optional(attributesPatch()) }));

/** Validated body of a modification. */
export type PatchAttributeGroupBody = Infer<typeof patchAttributeGroupBody>;
