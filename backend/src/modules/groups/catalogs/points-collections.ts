import { boolean, nullable, number, object, optional, personName, string } from '../../../shared/validation/schema.ts';
import type { Infer } from '../../../shared/validation/schema.ts';
import { defineCatalog } from './catalog.ts';
import { cardTypesWhere, dateOf, flagOf, invalid, isoInstant, nestedOf, numberOf, referenced, storedIds, stringsOf, textOf } from './kit.ts';

/** Most points collections a group may have. */
export const MAX_POINTS_COLLECTIONS = 50;

/**
 * A points collection (legacy `fidelity.pointsCollections[]`): a campaign that gives points on sales. Mapping: `status` is `enabled`;
 * `pointConversion` is the amount of money for one point; `prizesCatalogId` is `prizeCatalogueId`, a prize catalogue of the group. The dates are stored as
 * dates and shown as ISO 8601; a stored value that is not a date is shown as `null`.
 */
export interface PointsCollection {
  readonly id: string;
  readonly enabled: boolean;
  readonly name: string | null;
  readonly pointConversion: number | null;
  readonly minAmount: number | null;
  readonly dateFrom: string | null;
  readonly dateTo: string | null;
  readonly pointsExpirationDate: string | null;
  readonly prizeCatalogueId: string | null;
}

const name = personName(200);
const shape = {
  enabled: optional(boolean()),
  pointConversion: optional(nullable(number({ min: 0 }))),
  minAmount: optional(nullable(number({ min: 0 }))),
  dateFrom: optional(nullable(isoInstant())),
  dateTo: optional(nullable(isoInstant())),
  pointsExpirationDate: optional(nullable(isoInstant())),
  prizeCatalogueId: optional(nullable(string({ min: 1, max: 64, pattern: /^[A-Za-z0-9_-]+$/ }))),
};

/** Body of the creation of a points collection: the name is required. */
export const createPointsCollectionBody = object({ name, ...shape });

/** Body of the modification of a points collection (JSON Merge Patch). */
export const patchPointsCollectionBody = object({ name: optional(name), ...shape });

type CreateBody = Infer<typeof createPointsCollectionBody>;
type PatchBody = Infer<typeof patchPointsCollectionBody>;

const toDate = (iso: string | null): Date | null => (iso === null ? null : new Date(iso));

/**
 * The points collections (`/fidelity/points-collections`). The end of the period cannot precede its start (`422 incorrect` on `dateTo`); the prize catalogue
 * must exist in the group; deleting a collection a card type uses is refused (`409 referenced`).
 */
export const pointsCollections = defineCatalog<PointsCollection, CreateBody, PatchBody>({
  name: 'pointsCollection',
  segment: 'fidelity/points-collections',
  path: 'fidelity.pointsCollections',
  kind: 'array',
  limit: MAX_POINTS_COLLECTIONS,
  extraPaths: ['fidelity.prizeCatalogues', 'fidelity.cardsTypes'],
  idKey: 'id',
  readPermission: 'fidelity:read',
  updatePermission: 'fidelity:update',
  operations: { create: true, patch: 'PATCH', remove: true },
  createSchema: createPointsCollectionBody,
  patchSchema: patchPointsCollectionBody,
  toElement: (id, raw) => ({
    id,
    enabled: flagOf(raw['status']),
    name: textOf(raw['name']),
    pointConversion: numberOf(raw['pointConversion']),
    minAmount: numberOf(raw['minAmount']),
    dateFrom: dateOf(raw['dateFrom']),
    dateTo: dateOf(raw['dateTo']),
    pointsExpirationDate: dateOf(raw['pointsExpirationDate']),
    prizeCatalogueId: textOf(raw['prizesCatalogId']),
  }),
  defaults: (id) => ({ id, enabled: true, name: null, pointConversion: null, minAmount: null, dateFrom: null, dateTo: null, pointsExpirationDate: null, prizeCatalogueId: null }),
  toRaw: (element, raw) => ({
    ...raw,
    id: element.id,
    status: element.enabled,
    name: element.name,
    pointConversion: element.pointConversion,
    minAmount: element.minAmount,
    dateFrom: toDate(element.dateFrom),
    dateTo: toDate(element.dateTo),
    pointsExpirationDate: toDate(element.pointsExpirationDate),
    prizesCatalogId: element.prizeCatalogueId,
  }),
  check: ({ element, body, state }) => {
    if ((body.dateFrom !== undefined || body.dateTo !== undefined) && element.dateFrom !== null && element.dateTo !== null && element.dateTo < element.dateFrom) {
      throw invalid('dateTo', 'incorrect');
    }
    if (body.prizeCatalogueId !== undefined && body.prizeCatalogueId !== null && !storedIds(state.raw('fidelity.prizeCatalogues'), 'array').has(body.prizeCatalogueId)) {
      throw invalid('prizeCatalogueId', 'incorrect');
    }
    return [];
  },
  guardRemove: (element, _others, state) => {
    const users = cardTypesWhere(state.raw('fidelity.cardsTypes'), (card) => stringsOf(nestedOf(card['pointsCollect'], '', [])['collectionIds'], '', []).includes(element.id));
    if (users.length > 0) {
      throw referenced(users);
    }
  },
});
