import type { ListConfig } from '../../shared/http/list.ts';
import { listQueryShape } from '../../shared/http/list.ts';
import { array, boolean, enumOf, integer, integerString, number, object, objectId, optional, refine, string, transform } from '../../shared/validation/schema.ts';
import type { Infer } from '../../shared/validation/schema.ts';
import { LINE, cardCode } from '../contacts/contacts.schemas.ts';
import { SAFE_ID } from '../groups/catalogs/kit.ts';
import { atLeastOne } from '../product-catalog/entity.schemas.ts';
import { hexId } from '../products/products.schemas.ts';

/** Largest page of a list of cards or of movements. */
export const MAX_CARDS_PAGE = 100;

/** Largest body of a write of a card: a code, a few amounts and up to twenty contacts. */
export const CARD_BODY_LIMIT = '16kb';

/** The most a credit or a number of points may be changed or given at once, up or down. */
export const MAX_CARD_AMOUNT = 1_000_000;

/** Most points collections and most contacts a request may name. */
export const CARD_LIMITS = Object.freeze({ collections: 20, contacts: 20 } as const);

/** How the cards are sorted: by code (the default), by creation or by the date of the last change. The search `q` is the service's (code and contacts), so there are no search fields. The order is applied before the page is cut. */
export const CARDS_LIST: ListConfig = Object.freeze({
  sorts: Object.freeze({
    code: Object.freeze({ field: 'code', kind: 'string' as const }),
    createdAt: Object.freeze({ field: 'insertDate', kind: 'date' as const }),
    updatedAt: Object.freeze({ field: 'updateDate', kind: 'date' as const }),
  }),
  defaultSort: 'code',
  searchFields: Object.freeze([]),
});

/** How the movements of a card are sorted: newest first, and only so. */
export const MOVEMENTS_LIST: ListConfig = Object.freeze({
  sorts: Object.freeze({ date: Object.freeze({ field: 'date', kind: 'date' as const }) }),
  defaultSort: '-date',
  searchFields: Object.freeze([]),
});

/** The `true`/`false` of a query string. */
const flag = () => transform(enumOf(['true', 'false']), (value) => value === 'true', 'enum');

/** An amount of money with at most two decimals. */
const money = (min: number, max: number) => transform(number({ min, max }), (value) => (Math.round(value * 100) / 100 === value ? value : undefined), 'format');

const collectionId = () => string({ min: 1, max: 64, pattern: SAFE_ID });

/** Query of the list of the cards: the standard parameters (a page of at most 100, a search of at most 100 characters), the type and the state. */
export const cardsQuery = object({
  ...listQueryShape(CARDS_LIST),
  limit: optional(integerString({ min: 1, max: MAX_CARDS_PAGE })),
  q: optional(string({ min: 1, max: 100, trim: true })),
  cardTypeId: optional(string({ min: 1, max: 64, pattern: SAFE_ID })),
  enabled: optional(flag()),
});

/** The validated query of the list of cards. */
export type CardsQuery = Infer<typeof cardsQuery>;

/** Query of the movements of a card: the page and the cursor, nothing else. */
export const movementsQuery = object({ limit: optional(integerString({ min: 1, max: MAX_CARDS_PAGE })), cursor: listQueryShape(MOVEMENTS_LIST).cursor });

/** The validated query of the movements. */
export type MovementsQuery = Infer<typeof movementsQuery>;

/** Path parameters of the routes on one card; the group was already verified by the route. */
export const cardIdParams = object({ cardId: objectId() }, { allowUnknown: true });

/** Body of `POST /v1/groups/{groupId}/fidelity-cards`: the code and the type; the credit and the points a card starts with and the contacts that have it are optional. */
export const createCardBody = object({
  code: cardCode(true),
  cardTypeId: string({ min: 1, max: 64, pattern: SAFE_ID }),
  enabled: optional(boolean()),
  initialBalance: optional(money(0.01, MAX_CARD_AMOUNT)),
  initialPoints: optional(
    refine(
      array(object({ collectionId: collectionId(), points: integer({ min: 1, max: MAX_CARD_AMOUNT }) }), { max: CARD_LIMITS.collections }),
      (value) => value.flatMap((item, index) => (value.findIndex((other) => other.collectionId === item.collectionId) === index ? [] : [`${String(index)}.collectionId`])),
      'incorrect',
    ),
  ),
  contactIds: optional(array(hexId(), { max: CARD_LIMITS.contacts, unique: true })),
});

/** Validated body of a creation. */
export type CreateCardBody = Infer<typeof createCardBody>;

/** Body of `PATCH /v1/groups/{groupId}/fidelity-cards/{id}`: the type and the state; the code never changes (`422` `notAllowed` when it is sent). */
export const patchCardBody = atLeastOne(
  refine(
    object({ code: optional(string({ max: 64 })), cardTypeId: optional(string({ min: 1, max: 64, pattern: SAFE_ID })), enabled: optional(boolean()) }),
    (value) => (value.code === undefined ? [] : ['code']),
    'notAllowed',
  ),
);

/** Validated body of a modification. */
export type PatchCardBody = Infer<typeof patchCardBody>;

/** Body of an adjustment: a change of the credit and/or of the points of some collections of the type, and a short reason; at least one change. */
export const adjustmentBody = refine(
  object({
    balanceDelta: optional(transform(money(-MAX_CARD_AMOUNT, MAX_CARD_AMOUNT), (value) => (value === 0 ? undefined : value), 'incorrect')),
    pointsDeltas: optional(
      refine(
        array(object({ collectionId: collectionId(), delta: transform(integer({ min: -MAX_CARD_AMOUNT, max: MAX_CARD_AMOUNT }), (value) => (value === 0 ? undefined : value), 'incorrect') }), { min: 1, max: CARD_LIMITS.collections }),
        (value) => value.flatMap((item, index) => (value.findIndex((other) => other.collectionId === item.collectionId) === index ? [] : [`${String(index)}.collectionId`])),
        'incorrect',
      ),
    ),
    reason: optional(string({ min: 1, max: 200, trim: true, pattern: LINE })),
  }),
  (value) => (value.balanceDelta === undefined && value.pointsDeltas === undefined ? [''] : []),
  'required',
);

/** Validated body of an adjustment. */
export type AdjustmentBody = Infer<typeof adjustmentBody>;
