import { listQueryShape } from '../../shared/http/list.ts';
import { enumOf, integerString, object, optional, string } from '../../shared/validation/schema.ts';
import type { Infer } from '../../shared/validation/schema.ts';
import { CONTACTS_LIST, CONTACT_KINDS, cardCode, flag } from '../contacts/contacts.schemas.ts';
import { CONTACT_GROUPS_LIST, MAX_CONTACT_GROUPS_PAGE } from '../contact-groups/contact-groups.schemas.ts';
import { CARDS_LIST, MAX_CARDS_PAGE } from '../fidelity-cards/fidelity-cards.schemas.ts';
import { SAFE_ID, isoInstant } from '../groups/catalogs/kit.ts';
import { hexId } from '../products/products.schemas.ts';

/** Page of the contacts a store reads when it asks for none. */
export const STORE_CONTACTS_DEFAULT_PAGE = 25;

/** Largest page of contacts a store may ask for: half of the backoffice list, because every contact comes whole. */
export const STORE_CONTACTS_MAX_PAGE = 50;

/** Page of the groups of contacts a store reads when it asks for none. */
export const STORE_CONTACT_GROUPS_DEFAULT_PAGE = 50;

/** Page of the advanced cards a store reads when it asks for none. */
export const STORE_CARDS_DEFAULT_PAGE = 50;

/** Largest page of advanced cards a store may ask for: the largest page of the backoffice list (a card comes with its points and its first contacts). */
export const STORE_CARDS_MAX_PAGE = MAX_CARDS_PAGE;

/**
 * Query of `GET /v1/store-context/contacts`: the page, the order (`displayName`, `lastName`, `companyName`, `updatedAt`, each also with a leading `-`), the search text, the kind, the group of contacts, `trashed` and `updatedSince`
 * (an ISO 8601 instant). Nothing else: the contacts are the group's, so there is no filter of the place.
 */
export const storeContactsQuery = object({
  ...listQueryShape(CONTACTS_LIST),
  limit: optional(integerString({ min: 1, max: STORE_CONTACTS_MAX_PAGE })),
  q: optional(string({ min: 1, max: 100, trim: true })),
  kind: optional(enumOf(CONTACT_KINDS)),
  contactGroupId: optional(hexId()),
  trashed: optional(flag()),
  updatedSince: optional(isoInstant()),
});

/** The validated query of the contacts of a store. */
export type StoreContactsQuery = Infer<typeof storeContactsQuery>;

/** Query of `GET /v1/store-context/contact-groups`: the page, the order (`name`, `updatedAt`), the search text on the name and `updatedSince`. Nothing else. */
export const storeContactGroupsQuery = object({
  ...listQueryShape(CONTACT_GROUPS_LIST),
  limit: optional(integerString({ min: 1, max: MAX_CONTACT_GROUPS_PAGE })),
  updatedSince: optional(isoInstant()),
});

/** The validated query of the groups of contacts of a store. */
export type StoreContactGroupsQuery = Infer<typeof storeContactGroupsQuery>;

/**
 * Query of `GET /v1/store-context/fidelity-cards`: the page, the order (`code`, `createdAt`, `updatedAt`, each also with a leading `-`), the exact `code` (spaces around a stored one ignored), the type, the state and
 * `updatedSince`. There is no free text search: a store looks a card up by its code.
 */
export const storeCardsQuery = object({
  limit: optional(integerString({ min: 1, max: STORE_CARDS_MAX_PAGE })),
  cursor: listQueryShape(CARDS_LIST).cursor,
  sort: listQueryShape(CARDS_LIST).sort,
  code: optional(cardCode(true)),
  cardTypeId: optional(string({ min: 1, max: 64, pattern: SAFE_ID })),
  enabled: optional(flag()),
  updatedSince: optional(isoInstant()),
});

/** The validated query of the advanced cards of a store. */
export type StoreCardsQuery = Infer<typeof storeCardsQuery>;
