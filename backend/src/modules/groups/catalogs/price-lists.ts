import { boolean, object, optional, personName } from '../../../shared/validation/schema.ts';
import type { Infer } from '../../../shared/validation/schema.ts';
import { defineCatalog } from './catalog.ts';
import { cardTypesWhere, conflict, flagOf, invalid, isRecord, referenced, sameName, textOf } from './kit.ts';

/** Most price lists a group may have. */
export const MAX_PRICE_LISTS = 50;

/**
 * A price list of a group (legacy `priceLists.<id>`, a map keyed by the id). Mapping: `status` is `enabled`, `default` is `isDefault`.
 * Exactly one list is the default.
 */
export interface PriceList {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly isDefault: boolean;
}

const nameSchema = personName(100);

/** Body of the creation of a price list. The first list of a group is the default whatever the body says. */
export const createPriceListBody = object({ name: nameSchema, enabled: optional(boolean()), isDefault: optional(boolean()) });

/** Body of the modification of a price list (JSON Merge Patch). */
export const patchPriceListBody = object({ name: optional(nameSchema), enabled: optional(boolean()), isDefault: optional(boolean()) });

type CreateBody = Infer<typeof createPriceListBody>;
type PatchBody = Infer<typeof patchPriceListBody>;

/**
 * The price lists (`/price-lists`). Names are unique ignoring case (`409 taken`); setting `isDefault` takes the flag from the list that had it, in the same
 * write; the default list and the last list cannot be deleted, nor a list a card type uses (the legacy did not cascade: here the deletion is refused).
 */
export const priceLists = defineCatalog<PriceList, CreateBody, PatchBody>({
  name: 'priceList',
  segment: 'price-lists',
  path: 'priceLists',
  kind: 'map',
  limit: MAX_PRICE_LISTS,
  extraPaths: ['fidelity.cardsTypes'],
  idKey: 'id',
  readPermission: 'groups:read',
  updatePermission: 'groups:update',
  operations: { create: true, patch: 'PATCH', remove: true },
  createSchema: createPriceListBody,
  patchSchema: patchPriceListBody,
  toElement: (id, raw) => ({ id, name: textOf(raw['name']) ?? '', enabled: flagOf(raw['status']), isDefault: flagOf(raw['default']) }),
  defaults: (id, _body, state) => ({ id, name: '', enabled: true, isDefault: !isRecord(state.raw('priceLists')) || Object.keys(state.raw('priceLists') as object).length === 0 }),
  toRaw: (element, raw) => ({ ...raw, id: element.id, name: element.name, status: element.enabled, default: element.isDefault }),
  check: ({ op, element, current, body, others }) => {
    if (body.name !== undefined && others.some((other) => sameName(other.name, element.name))) {
      throw conflict('name', 'taken');
    }
    if ((op === 'create' && others.length === 0 && !element.isDefault) || (current?.isDefault === true && !element.isDefault)) {
      throw invalid('isDefault', 'incorrect');
    }
    return [];
  },
  adjust: (items, element) =>
    element.isDefault ? items.map((item) => (isRecord(item.raw) && item.id !== element.id && item.raw['default'] === true ? { ...item, raw: { ...item.raw, default: false } } : item)) : [...items],
  guardRemove: (element, others, state) => {
    if (element.isDefault) {
      throw conflict('id', 'default');
    }
    if (others.length === 0) {
      throw conflict('id', 'last');
    }
    const users = cardTypesWhere(state.raw('fidelity.cardsTypes'), (card) => card['priceListId'] === element.id);
    if (users.length > 0) {
      throw referenced(users);
    }
  },
});
