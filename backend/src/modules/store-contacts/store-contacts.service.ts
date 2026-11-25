import { ObjectId } from 'mongodb';
import type { ClientContext } from '../../shared/http/client-context.ts';
import type { PageInfo } from '../../shared/http/envelope.ts';
import type { Logger } from '../../shared/logging/logger.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { StorePrincipal } from '../../shared/security/scope/principal.ts';
import type { ContactGroupPage, ContactGroupsService } from '../contact-groups/contact-groups.service.ts';
import type { ContactResult, ContactViewPage, ContactsService, PointsResult } from '../contacts/contacts.service.ts';
import type { PatchContactBody, CreateContactBody, PointsAdjustmentBody } from '../contacts/contacts.schemas.ts';
import type { AdjustmentBody, CreateCardBody, MovementsQuery, PatchCardBody } from '../fidelity-cards/fidelity-cards.schemas.ts';
import type { CardResult, CardViewPage, CardsService, MovementRow } from '../fidelity-cards/fidelity-cards.service.ts';
import type { StoreOperator } from '../product-catalog/caller.ts';
import type { StoreContactsAudit } from './store-contacts.audit.ts';
import { storeCallerOf } from '../store-catalog/store-catalog.service.ts';
import { STORE_CARDS_DEFAULT_PAGE, STORE_CONTACTS_DEFAULT_PAGE, STORE_CONTACT_GROUPS_DEFAULT_PAGE } from './store-contacts.schemas.ts';
import type { StoreCardsQuery, StoreContactGroupsQuery, StoreContactsQuery } from './store-contacts.schemas.ts';

/**
 * The contacts, the groups of contacts and the advanced loyalty cards of the point of sale of a store key (`doc/Store-API.md`): what its server reads and writes. Every operation goes through the same service of the backoffice,
 * with all of its rules, as the caller "store" (the perimeter of its key and, for a write, the operator): the contacts and the cards are the group's, so the place of the key narrows nothing, and the group comes from the store
 * principal alone. A write needs the operator that the `operator` check of the route verified; a read needs none. A store never deletes a contact or a card and never takes a contact out of the trash.
 */
export interface StoreContactsService {
  /** A page of the contacts of the group, whole (the count of the contacts read goes to the trace `store.contactsRead`), as the backoffice shows them (the loyalty cards with the detail of the advanced ones, never the password and the tokens of the account); with `updatedSince` those changed from that instant, the trashed ones included. */
  listContacts(store: StorePrincipal, access: GroupAccess, query: StoreContactsQuery, client: ClientContext): Promise<ContactViewPage>;
  /** One contact with its version and the warnings of its code, tax codes and VAT number. @throws {AppError} `NOT_FOUND`. */
  getContact(store: StorePrincipal, access: GroupAccess, id: ObjectId, client: ClientContext): Promise<ContactResult>;
  /** Creates a contact (the errors of `ContactsService.create`). */
  createContact(store: StorePrincipal, operator: StoreOperator, access: GroupAccess, body: CreateContactBody, client: ClientContext): Promise<ContactResult>;
  /** Modifies a contact, the codes of its loyalty cards included (the errors of `ContactsService.update`: `412`, `409`). */
  updateContact(store: StorePrincipal, operator: StoreOperator, access: GroupAccess, id: ObjectId, expected: string, body: PatchContactBody, client: ClientContext): Promise<ContactResult>;
  /** Moves a contact to the trash. There is no deletion for good and no restore for a store. */
  trashContact(store: StorePrincipal, operator: StoreOperator, access: GroupAccess, id: ObjectId, expected: string, client: ClientContext): Promise<ContactResult>;
  /** Adds points to a simple card of a contact or takes them away (the errors of `ContactsService.adjustPoints`). */
  adjustContactPoints(store: StorePrincipal, operator: StoreOperator, access: GroupAccess, id: ObjectId, code: string, body: PointsAdjustmentBody, client: ClientContext): Promise<PointsResult>;
  /** A page of the groups of contacts, by name; with `updatedSince` those changed from that instant (a group deleted for good cannot be told). */
  listContactGroups(store: StorePrincipal, access: GroupAccess, query: StoreContactGroupsQuery): Promise<ContactGroupPage>;
  /** A page of the advanced cards, whole (points by collection, first contacts), by code or from `updatedSince`, or the cards that have a code. */
  listCards(store: StorePrincipal, access: GroupAccess, query: StoreCardsQuery): Promise<CardViewPage>;
  /** One card with its version. @throws {AppError} `NOT_FOUND`. */
  getCard(store: StorePrincipal, access: GroupAccess, id: ObjectId): Promise<CardResult>;
  /** Creates a card with the credit and points it starts with and the contacts that have its code (the errors of `CardsService.create`). */
  createCard(store: StorePrincipal, operator: StoreOperator, access: GroupAccess, body: CreateCardBody, client: ClientContext): Promise<CardResult>;
  /** Changes the type or the state of a card (the errors of `CardsService.update`: `412`, `409`). There is no deletion of a card for a store. */
  updateCard(store: StorePrincipal, operator: StoreOperator, access: GroupAccess, id: ObjectId, expected: string, body: PatchCardBody, client: ClientContext): Promise<CardResult>;
  /** Adds or takes away credit and points of a card, with a movement of the operator for each (the errors of `CardsService.adjust`). */
  adjustCard(store: StorePrincipal, operator: StoreOperator, access: GroupAccess, id: ObjectId, body: AdjustmentBody, client: ClientContext): Promise<CardResult>;
  /** A page of the movements of a card, newest first. @throws {AppError} `NOT_FOUND`. */
  listMovements(store: StorePrincipal, access: GroupAccess, id: ObjectId, query: MovementsQuery): Promise<{ readonly items: readonly MovementRow[]; readonly page: PageInfo }>;
}

/** Collaborators of {@link createStoreContactsService}: the services of the backoffice, which are the ones the store goes through. */
export interface StoreContactsServiceDeps {
  /** Only what a store may call: no `remove`, no `restore`, no bulk trash (the type does not let this module delete a contact). */
  readonly contacts: Pick<ContactsService, 'listChanges' | 'get' | 'create' | 'update' | 'trash' | 'adjustPoints'>;
  readonly contactGroups: Pick<ContactGroupsService, 'list'>;
  /** Only what a store may call: no `remove`. */
  readonly cards: Pick<CardsService, 'listFull' | 'get' | 'create' | 'update' | 'adjust' | 'movements'>;
  /** The alerts and the trace of the store (credit above the limits, an advanced card code taken from other contacts, contacts read). */
  readonly audit: StoreContactsAudit;
  readonly logger: Logger;
}

/**
 * Builds the contacts and cards service of the server of a point of sale.
 *
 * @param deps The services of the contacts, of their groups and of the advanced cards.
 */
export function createStoreContactsService(deps: StoreContactsServiceDeps): StoreContactsService {
  const { contacts, contactGroups, cards, audit, logger } = deps;
  /**
   * The alert of a store that links to a contact the code of an advanced card other contacts already have: for each advanced card of the contact it did not have before, the card is read and, when its holders are more than this
   * contact, `store.advancedCardRelinked` is written. A failure of the read is logged: the write that succeeded stays a success.
   */
  const relinked = async (store: StorePrincipal, operator: StoreOperator, access: GroupAccess, client: ClientContext, result: ContactResult, before: ReadonlySet<string>): Promise<void> => {
    for (const card of result.entity.fidelityCards) {
      if (before.has(card.code) || card.advanced === null || card.advanced.cardId === null) {
        continue;
      }
      try {
        const detail = await cards.get(storeCallerOf(store, null), access, ObjectId.createFromHexString(card.advanced.cardId));
        if (detail.entity.contactsCount > 1) {
          await audit.cardRelinked(store, operator, client, result.entity.id, card.advanced.cardId, detail.entity.contactsCount - 1);
        }
      } catch (error) {
        logger.error('reading an advanced card to tell who else has it failed', { error });
      }
    }
  };
  return {
    listContacts: async (store, access, query, client) => {
      const page = await contacts.listChanges(storeCallerOf(store, null), access, { ...query, limit: query.limit ?? STORE_CONTACTS_DEFAULT_PAGE });
      await audit.contactsRead(store, client, page.items.length);
      return page;
    },
    getContact: async (store, access, id, client) => {
      const found = await contacts.get(storeCallerOf(store, null), access, id);
      await audit.contactsRead(store, client, 1);
      return found;
    },
    createContact: async (store, operator, access, body, client) => {
      const created = await contacts.create(storeCallerOf(store, operator), access, body, client);
      await relinked(store, operator, access, client, created, new Set());
      return created;
    },
    updateContact: async (store, operator, access, id, expected, body, client) => {
      // The codes the contact has now, read only when the request changes them: what is new after the write is what was linked.
      const before = body.fidelityCards === undefined ? null : new Set((await contacts.get(storeCallerOf(store, null), access, id)).entity.fidelityCards.map((card) => card.code));
      const updated = await contacts.update(storeCallerOf(store, operator), access, id, expected, body, client);
      if (before !== null) {
        await relinked(store, operator, access, client, updated, before);
      }
      return updated;
    },
    trashContact: (store, operator, access, id, expected, client) => contacts.trash(storeCallerOf(store, operator), access, id, expected, client),
    adjustContactPoints: (store, operator, access, id, code, body, client) => contacts.adjustPoints(storeCallerOf(store, operator), access, id, code, body, client),
    listContactGroups: (store, access, query) => contactGroups.list(storeCallerOf(store, null), access, { ...query, limit: query.limit ?? STORE_CONTACT_GROUPS_DEFAULT_PAGE }),
    listCards: (store, access, query) => cards.listFull(storeCallerOf(store, null), access, { ...query, limit: query.limit ?? STORE_CARDS_DEFAULT_PAGE }),
    getCard: (store, access, id) => cards.get(storeCallerOf(store, null), access, id),
    createCard: async (store, operator, access, body, client) => {
      const created = await cards.create(storeCallerOf(store, operator), access, body, client);
      await audit.creditAdded(store, operator, client, created.entity.id, body.initialBalance ?? 0);
      return created;
    },
    updateCard: (store, operator, access, id, expected, body, client) => cards.update(storeCallerOf(store, operator), access, id, expected, body, client),
    adjustCard: async (store, operator, access, id, body, client) => {
      const adjusted = await cards.adjust(storeCallerOf(store, operator), access, id, body, client);
      await audit.creditAdded(store, operator, client, adjusted.entity.id, body.balanceDelta ?? 0);
      return adjusted;
    },
    listMovements: (store, access, id, query) => cards.movements(storeCallerOf(store, null), access, id, query),
  };
}
