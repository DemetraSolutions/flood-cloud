import { ObjectId } from 'mongodb';
import { array, boolean, enumOf, nullable, number, object, optional, personName, string } from '../../../shared/validation/schema.ts';
import type { Infer } from '../../../shared/validation/schema.ts';
import { defineCatalog } from './catalog.ts';
import type { ReferenceCheck } from './catalog.ts';
import { MAX_REFERENCES, choiceOf, flagOf, invalid, nestedOf, numberOf, objectIdsOf, storedIds, stringsOf, textOf } from './kit.ts';

/** Most card types a group may have. */
export const MAX_CARD_TYPES = 50;

/** Most points collections one card type may use. */
export const MAX_CARD_COLLECTIONS = 50;

const PREPAID_TYPES = ['multi', 'mono'] as const;

/**
 * A loyalty card type (legacy `fidelity.cardsTypes[]`). Mapping: `status` is `enabled`; `prepaid.status` and `pointsCollect.status` are `prepaid.enabled`
 * and `pointsCollect.enabled`; `placesAvailability` (stored as `ObjectId`) is `placeIds`. `priceListId` refers to a price list of the group and
 * `pointsCollect.collectionIds` to points collections of the group; `placeIds` to places of the group.
 */
export interface CardType {
  readonly id: string;
  readonly enabled: boolean;
  readonly name: string | null;
  /** Base discount of the card, 0 to 100. */
  readonly discountPercentage: number;
  readonly priceListId: string | null;
  readonly prepaid: { readonly enabled: boolean; readonly type: (typeof PREPAID_TYPES)[number]; readonly taxPercentage: number | null };
  readonly pointsCollect: { readonly enabled: boolean; readonly collectionIds: readonly string[] };
  readonly placeIds: readonly string[];
}

const placeId = string({ min: 24, max: 24, pattern: /^[0-9a-f]{24}$/ });
const localId = string({ min: 1, max: 64, pattern: /^[A-Za-z0-9_-]+$/ });
const name = personName(200);

/** The fields a request may carry, all optional; the creation adds a required name. */
const shape = {
  enabled: optional(boolean()),
  discountPercentage: optional(number({ min: 0, max: 100 })),
  priceListId: optional(nullable(localId)),
  prepaid: optional(object({ enabled: optional(boolean()), type: optional(enumOf(PREPAID_TYPES)), taxPercentage: optional(nullable(number({ min: 0, max: 100 }))) })),
  pointsCollect: optional(object({ enabled: optional(boolean()), collectionIds: optional(array(localId, { max: MAX_CARD_COLLECTIONS, unique: true })) })),
  placeIds: optional(array(placeId, { max: MAX_REFERENCES, unique: true })),
};

/** Body of the creation of a card type: the name is required. */
export const createCardTypeBody = object({ name, ...shape });

/** Body of the modification of a card type (JSON Merge Patch; the lists replace the stored ones). */
export const patchCardTypeBody = object({ name: optional(name), ...shape });

type CreateBody = Infer<typeof createCardTypeBody>;
type PatchBody = Infer<typeof patchCardTypeBody>;

/**
 * The card types (`/fidelity/card-types`). A price list, a points collection or a place a request names must exist in the group
 * (`422 incorrect` on the field with the index of the id).
 */
export const cardTypes = defineCatalog<CardType, CreateBody, PatchBody>({
  name: 'cardType',
  segment: 'fidelity/card-types',
  path: 'fidelity.cardsTypes',
  kind: 'array',
  limit: MAX_CARD_TYPES,
  extraPaths: ['priceLists', 'fidelity.pointsCollections'],
  idKey: 'id',
  readPermission: 'fidelity:read',
  updatePermission: 'fidelity:update',
  operations: { create: true, patch: 'PATCH', remove: true },
  createSchema: createCardTypeBody,
  patchSchema: patchCardTypeBody,
  toElement: (id, raw, anomalies) => {
    const prepaid = nestedOf(raw['prepaid'], `fidelity.cardsTypes.${id}.prepaid`, anomalies);
    const pointsCollect = nestedOf(raw['pointsCollect'], `fidelity.cardsTypes.${id}.pointsCollect`, anomalies);
    return {
      id,
      enabled: flagOf(raw['status']),
      name: textOf(raw['name']),
      discountPercentage: numberOf(raw['discountPercentage']) ?? 0,
      priceListId: textOf(raw['priceListId']),
      prepaid: {
        enabled: flagOf(prepaid['status']),
        type: choiceOf(prepaid['type'], PREPAID_TYPES, `fidelity.cardsTypes.${id}.prepaid.type`, anomalies) ?? 'multi',
        taxPercentage: numberOf(prepaid['taxPercentage']),
      },
      pointsCollect: { enabled: flagOf(pointsCollect['status']), collectionIds: stringsOf(pointsCollect['collectionIds'], `fidelity.cardsTypes.${id}.pointsCollect.collectionIds`, anomalies) },
      placeIds: objectIdsOf(raw['placesAvailability'], `fidelity.cardsTypes.${id}.placesAvailability`, anomalies),
    };
  },
  defaults: (id) => ({
    id,
    enabled: true,
    name: null,
    discountPercentage: 0,
    priceListId: null,
    prepaid: { enabled: false, type: 'multi', taxPercentage: null },
    pointsCollect: { enabled: false, collectionIds: [] },
    placeIds: [],
  }),
  places: (element) => ({ field: 'placeIds', ids: element.placeIds }),
  toRaw: (element, raw) => ({
    ...raw,
    id: element.id,
    status: element.enabled,
    name: element.name,
    discountPercentage: element.discountPercentage,
    priceListId: element.priceListId,
    prepaid: { ...nestedOf(raw?.['prepaid'], '', []), status: element.prepaid.enabled, type: element.prepaid.type, taxPercentage: element.prepaid.taxPercentage },
    pointsCollect: { ...nestedOf(raw?.['pointsCollect'], '', []), status: element.pointsCollect.enabled, collectionIds: [...element.pointsCollect.collectionIds] },
    placesAvailability: element.placeIds.map((place) => ObjectId.createFromHexString(place)),
  }),
  check: ({ element, body, state }): ReferenceCheck[] => {
    if (body.priceListId !== undefined && body.priceListId !== null && !storedIds(state.raw('priceLists'), 'map').has(body.priceListId)) {
      throw invalid('priceListId', 'incorrect');
    }
    const collectionIds = body.pointsCollect?.collectionIds;
    if (collectionIds !== undefined) {
      const known = storedIds(state.raw('fidelity.pointsCollections'), 'array');
      const index = collectionIds.findIndex((collection) => !known.has(collection));
      if (index !== -1) {
        throw invalid(`pointsCollect.collectionIds.${String(index)}`, 'incorrect');
      }
    }
    return body.placeIds === undefined ? [] : [{ field: 'placeIds', collection: 'places', ids: element.placeIds }];
  },
});
