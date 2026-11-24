import type { ListConfig } from '../../shared/http/list.ts';
import { listQueryShape } from '../../shared/http/list.ts';
import { array, boolean, enumOf, integerString, nullable, object, objectId, optional, refine, string, transform } from '../../shared/validation/schema.ts';
import type { Schema } from '../../shared/validation/schema.ts';
import { MAX_AVAILABILITY_PLACES } from './availability.ts';
import { ENTRY_PARAM } from './entity.controller.ts';
import { descriptionTexts, descriptionTextsPatch, nameTexts, nameTextsPatch } from './texts.ts';

/** Largest page of a list of departments or brands. */
export const MAX_ENTITIES_PAGE = 100;

/** Path parameters of the routes on one entry; the group was already verified by the route. */
export const entryParams = object({ [ENTRY_PARAM]: objectId() }, { allowUnknown: true });

/** The ids of the places of the availability: hexadecimal ObjectIds, without repetitions. */
export const placeIdsSchema = () => array(string({ min: 24, max: 24, pattern: /^[0-9a-f]{24}$/ }), { max: MAX_AVAILABILITY_PLACES, unique: true });

/** An image of the library of the group, by its id, or `null` for none. */
export const imageSchema = () => nullable(object({ imageId: string({ min: 24, max: 24, pattern: /^[0-9a-f]{24}$/ }) }));

/** How a download of the changes of a collection of the catalog (brands, groups of attributes) is ordered: by the date of the last change, oldest first; no search and no other sort. */
export const ENTITY_CHANGES_LIST: ListConfig = Object.freeze({
  sorts: Object.freeze({ updatedAt: Object.freeze({ field: 'updateDate', kind: 'date' as const }) }),
  defaultSort: 'updatedAt',
  searchFields: Object.freeze([]),
});

/** The `true`/`false` of a query string. */
const flag = () => transform(enumOf(['true', 'false']), (value) => value === 'true', 'enum');

/**
 * The query of a list of departments or brands: the standard list parameters of `config`, with a page of at most {@link MAX_ENTITIES_PAGE}, and the state (`enabled`).
 *
 * @param config The sorts of the list (the names are the same whatever the language; the language only decides what a name sorts as).
 */
export function entityQuery(config: ListConfig) {
  return object({ ...listQueryShape(config), limit: optional(integerString({ min: 1, max: MAX_ENTITIES_PAGE })), enabled: optional(flag()) });
}

/** The fields every department and brand has in a creation: the name, and the rest optional. */
export function commonCreateShape() {
  return { name: nameTexts(), description: optional(descriptionTexts()), enabled: optional(boolean()), placeIds: optional(placeIdsSchema()), image: optional(imageSchema()) };
}

/** The fields every department and brand has in a modification: all optional. */
export function commonPatchShape() {
  return { name: optional(nameTextsPatch()), description: optional(descriptionTextsPatch()), enabled: optional(boolean()), placeIds: optional(placeIdsSchema()), image: optional(imageSchema()) };
}

/**
 * A modification with at least one field (`required` on the body otherwise).
 *
 * @param inner The schema of the fields.
 */
export function atLeastOne<T extends object>(inner: Schema<T, false>): Schema<T, false> {
  return refine(inner, (value) => (Object.keys(value).length === 0 ? [''] : []), 'required');
}
