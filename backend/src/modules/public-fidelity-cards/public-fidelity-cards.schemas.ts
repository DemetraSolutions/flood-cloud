import { listQueryShape } from '../../shared/http/list.ts';
import { integerString, object, objectId, optional, string } from '../../shared/validation/schema.ts';
import type { Infer } from '../../shared/validation/schema.ts';
import { CARDS_LIST, MAX_CARDS_PAGE } from '../fidelity-cards/fidelity-cards.schemas.ts';
import { SAFE_ID } from '../groups/catalogs/kit.ts';
import { flag } from '../contacts/contacts.schemas.ts';

/** Page of the cards a public key reads when it asks for none, and the largest it may ask for. */
export const PUBLIC_CARDS_DEFAULT_PAGE = 50;
export const PUBLIC_CARDS_MAX_PAGE = MAX_CARDS_PAGE;

/**
 * Query of `GET /public/v1/fidelity-cards`: the page, the order (`code`, `createdAt`, `updatedAt`, each also with a leading `-`), the search text (the code of a card; with `contacts:read` also a text in the name of a contact that has a
 * card), the type and the state. Nothing else.
 */
export const publicCardsQuery = object({
  ...listQueryShape(CARDS_LIST),
  limit: optional(integerString({ min: 1, max: PUBLIC_CARDS_MAX_PAGE })),
  q: optional(string({ min: 1, max: 100, trim: true })),
  cardTypeId: optional(string({ min: 1, max: 64, pattern: SAFE_ID })),
  enabled: optional(flag()),
});

/** The validated query of the public list of cards. */
export type PublicCardsQuery = Infer<typeof publicCardsQuery>;

/** Path parameter of the routes on one card. */
export const publicCardParams = object({ cardId: objectId() });
