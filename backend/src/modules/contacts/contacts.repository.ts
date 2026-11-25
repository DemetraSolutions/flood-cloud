import { MongoServerError, ObjectId } from 'mongodb';
import type { Document, Filter } from 'mongodb';
import { CONTACTS_OWNED_FIELDS } from '../../db/collections.ts';
import type { Databases } from '../../db/databases.ts';
import { AppError } from '../../shared/http/errors.ts';
import { LIST_MAX_TIME_MS, escapeRegExp, listPipeline, pageOf } from '../../shared/http/list.ts';
import type { ListPage, ListParams } from '../../shared/http/list.ts';
import { bounded } from '../../shared/security/scope/bounded.ts';
import { groupDatabaseFor } from '../../shared/security/scope/group-access.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { ScopeHolder } from '../../shared/security/scope/principal.ts';
import { entityProjection, sameAs } from '../product-catalog/entity.repository.ts';
import { CONTACT_CONTAINERS } from './contacts.document.ts';
import { CONTACTS_LIST } from './contacts.schemas.ts';

/** Most contacts, products or documents a refused deletion names for each kind of reference. */
export const MAX_REPORTED_REFERENCES = 20;

/** Most holders of a card the list of the cards names (the rest is counted). */
export const MAX_CARD_HOLDERS = 20;

/** Most contacts read to find the holders of the cards of a page (the count of a card stops there). */
export const MAX_HOLDERS_SCAN = 1000;

/** Most card codes a search by the name of a contact gives back (the filter of the cards has at most these in its `$in`). */
export const MAX_NAME_CODES = 1000;

/** Most contacts examined to find the cards of a search by the name of a contact. */
export const MAX_NAME_SCAN = 100;

/** Most contacts read to look for the other contacts that use a code, a tax code or a VAT number. */
export const MAX_DUPLICATE_SCAN = 100;

/**
 * The time limit of each read that looks for the references of a contact in the collections of the legacy, in milliseconds. None of the fields it looks at is indexed (the legacy has no index on them and this backend
 * creates none), so a group with a very large collection can exceed it: the read then fails with `503` and the deletion does not go on (it fails closed).
 */
export const REFERENCE_MAX_TIME_MS = 5000;

/** The fields a row of the list reads: never the whole document, never an address, a tax code, a note, the account or the points. */
const ROW_PROJECTION = Object.freeze({
  contactCode: 1,
  customer: 1,
  supplier: 1,
  name: 1,
  surname: 1,
  companyName: 1,
  companyCode: 1,
  email: 1,
  companyEmail: 1,
  telephone: 1,
  companyTelephone: 1,
  cGroupId: 1,
  trash: 1,
  trashDate: 1,
  updateDate: 1,
} as const);

/**
 * The projection of one contact: every owned field, and the type of each container that is owned leaf by leaf (`__shapes`: `object`, `missing`, or what the legacy left there). A projection by leaf shows nothing of a container
 * that is not an object, so the type is asked of the database; the password and the tokens of the account are never read.
 */
const CONTACT_PROJECTION: Document = Object.freeze({ ...entityProjection(CONTACTS_OWNED_FIELDS), __shapes: Object.fromEntries(CONTACT_CONTAINERS.map((container) => [container, { $type: `$${container}` }])) });

const OWNED: ReadonlySet<string> = new Set(CONTACTS_OWNED_FIELDS);

/** The kinds of document of the legacy that name a contact (the order is the one a refused deletion looks them up in, from the cheapest). */
export const CONTACT_REFERENCE_KINDS = Object.freeze(['contactAssociations', 'products', 'warehouseMovements', 'appointments', 'tableReservations', 'documents', 'sales'] as const);

/** A kind of document that names a contact. */
export type ContactReferenceKind = (typeof CONTACT_REFERENCE_KINDS)[number];

/** What a modification of a contact changes: the fields to set and to unset, the cards to add and to remove, the new date and what the document had when it was read. */
export interface ContactChange {
  /** The `$set`: owned paths (and the containers of {@link ContactChange.containers}), never `fidelities`. */
  readonly set: Document;
  /** The `$unset`: owned paths. */
  readonly unset: Document;
  /** The containers (`account`, `fattura_elettronica`) that are in `set` as a whole because the stored one was not an object (the write requires it to still be one that is not). */
  readonly containers: readonly string[];
  /** The new `updateDate`, strictly after the one read. */
  readonly updateDate: Date;
  /** What the document had at each path of `set` and `unset` (but the containers) when it was read (`undefined` when it had nothing): the write requires it to still be that, so a field another writer changed meanwhile is never overwritten. */
  readonly readValues: Readonly<Record<string, unknown>>;
  /** The codes of the cards to add, each with zero points. */
  readonly added: readonly string[];
  /** The codes of the cards to remove, as they are stored (an element is removed by its raw code). */
  readonly removed: readonly string[];
}

/** The `$or` of the values another contact may share. */
export interface DuplicateQuery {
  readonly code: string | null;
  readonly taxCode: string | null;
  readonly vatNumber: string | null;
  readonly companyTaxCode: string | null;
}

/** The `contacts` collection of a group database, as seen by a caller. */
export interface ContactsRepository {
  /**
   * A page of the contacts (the group's: every place shares them), by the filter of the request.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param filter The filter of the request.
   * @param params Validated list parameters.
   * @throws {AppError} `SERVICE_UNAVAILABLE` when the read exceeds its time limit.
   */
  list(principal: ScopeHolder, access: GroupAccess, filter: Filter<Document>, params: ListParams): Promise<ListPage>;
  /**
   * A page of the contacts with every owned field (the workbook of the contacts writes them all), by the filter of the request: the same read as {@link ContactsRepository.list} with the projection of {@link ContactsRepository.findById}.
   *
   * @throws {AppError} `SERVICE_UNAVAILABLE` when the read exceeds its time limit.
   */
  listFull(principal: ScopeHolder, access: GroupAccess, filter: Filter<Document>, params: ListParams): Promise<ListPage>;
  /** How many contacts match a filter, counted up to `cap + 1` (the size check of the export). */
  countUpTo(principal: ScopeHolder, access: GroupAccess, filter: Filter<Document>, cap: number): Promise<number>;
  /** One contact with every owned field, or `null`. */
  findById(principal: ScopeHolder, access: GroupAccess, id: ObjectId): Promise<Document | null>;
  /**
   * Inserts a whole new contact.
   *
   * @throws {AppError} `CONFLICT` with `taken` on `account.email` or `account.phone` when a unique index of the legacy refuses the account.
   */
  insert(principal: ScopeHolder, access: GroupAccess, document: Document): Promise<void>;
  /**
   * Applies a change only if the contact is still as it was read, in **one** update with a pipeline: the cards are the ones the server has at the moment of the write without the removed codes (compared as stored, not
   * cleaned), plus the added ones with zero points, so the balance a sale added meanwhile is never overwritten.
   *
   * @param readDate The `updateDate` the contact had when it was read (`undefined` when it had none).
   * @returns `updated`, or `conflict` when the contact changed (or went, or was trashed) since it was read.
   * @throws {AppError} `CONFLICT` with `taken` on the account when a unique index of the legacy refuses it.
   */
  update(principal: ScopeHolder, access: GroupAccess, id: ObjectId, change: ContactChange, readDate: unknown): Promise<'updated' | 'conflict'>;
  /** Moves a contact to the trash or takes it out, only if it is still as it was read. Returns whether it was changed. */
  setTrash(principal: ScopeHolder, access: GroupAccess, id: ObjectId, to: 'trashed' | 'restored', now: Date, read: { readonly updateDate: unknown; readonly trash: unknown }): Promise<boolean>;
  /** Deletes a contact that is in the trash, only if it is still as it was read. Returns whether one was deleted. */
  removeTrashed(principal: ScopeHolder, access: GroupAccess, id: ObjectId, read: { readonly updateDate: unknown }): Promise<boolean>;
  /** The ids of the contacts in the trash, in `_id` order, at most `limit`, after a cursor. */
  trashedIds(principal: ScopeHolder, access: GroupAccess, limit: number, after: ObjectId | null): Promise<ObjectId[]>;
  /** How many contacts are in the trash. */
  countTrashed(principal: ScopeHolder, access: GroupAccess): Promise<number>;
  /** The other contacts, not in the trash, that have one of the values: their ids and the four fields. At most {@link MAX_DUPLICATE_SCAN}: the check is a warning, so a long tail is counted, not read. */
  usingValues(principal: ScopeHolder, access: GroupAccess, id: ObjectId, query: DuplicateQuery): Promise<Document[]>;
  /** Which of the account e-mail and telephone another contact (in the trash too) already uses. */
  accountTaken(principal: ScopeHolder, access: GroupAccess, id: ObjectId, account: { readonly email: string | null; readonly phone: string | null }): Promise<{ readonly email: boolean; readonly phone: boolean }>;
  /**
   * The contacts, not in the trash, that have some card codes, for the cards that show who has them: for each code the first {@link MAX_CARD_HOLDERS} (id and name parts) and how many in all (up to {@link MAX_HOLDERS_SCAN} contacts are read).
   *
   * @param codes The codes, as stored (list) or looked for with the spaces the legacy may have left around them (detail).
   * @param loose Whether a stored code with spaces around it counts (a pattern per code; one code at a time) or only the exact text.
   * @throws {AppError} `SERVICE_UNAVAILABLE` when the read exceeds its time limit.
   */
  cardHolders(principal: ScopeHolder, access: GroupAccess, codes: readonly string[], loose: boolean): Promise<Map<string, { readonly items: Document[]; readonly count: number }>>;
  /** The ids (hexadecimal, at most {@link MAX_REPORTED_REFERENCES}) of the contacts, in the trash too, that have a card code (spaces around it ignored). */
  cardHolderIds(principal: ScopeHolder, access: GroupAccess, code: string): Promise<string[]>;
  /** The card codes (cleaned) of the contacts whose first name, surname or company name contains a text (literal, without regard to case): at most {@link MAX_NAME_SCAN} contacts are examined and at most {@link MAX_NAME_CODES} codes are given back. */
  cardCodesOfContactsNamed(principal: ScopeHolder, access: GroupAccess, text: string): Promise<string[]>;
  /** The contacts of the group outside the trash that are some of the ids (hexadecimal), with the parts of their name only. */
  contactsByIds(principal: ScopeHolder, access: GroupAccess, ids: readonly string[]): Promise<Document[]>;
  /**
   * Adds a card code, with zero points, to the contacts that do not have it yet (not in the trash, with their cards a list or none), and gives them a new date: the same as a request of the contact that adds the card, in one `updateMany`.
   *
   * @returns How many contacts were changed.
   */
  linkCard(principal: ScopeHolder, access: GroupAccess, ids: readonly ObjectId[], code: string, now: Date): Promise<number>;
  /** The advanced cards (the documents of `fidelity_cards`) that have some codes, with the few fields a contact shows. */
  advancedCards(principal: ScopeHolder, access: GroupAccess, codes: readonly string[]): Promise<Document[]>;
  /** Whether a card code is the one of an advanced card: its points are then never the contact's to adjust. */
  isAdvancedCard(principal: ScopeHolder, access: GroupAccess, codes: readonly string[]): Promise<boolean>;
  /** Whether a group of contacts exists in the group. */
  groupExists(principal: ScopeHolder, access: GroupAccess, id: ObjectId): Promise<boolean>;
  /** Whether a contact of the group is a company (it has a company name) and is not in the trash. */
  companyExists(principal: ScopeHolder, access: GroupAccess, id: ObjectId): Promise<boolean>;
  /** The positions, in the list, of the ids that are not a service product of the group that is not in the trash. */
  invalidServices(principal: ScopeHolder, access: GroupAccess, ids: readonly string[]): Promise<number[]>;
  /** The products, not in the trash, that name a supplier price list of a contact (at most {@link MAX_REPORTED_REFERENCES}), hexadecimal. */
  productsUsingPriceLists(principal: ScopeHolder, access: GroupAccess, contactId: ObjectId, listIds: readonly string[]): Promise<string[]>;
  /**
   * Adds `delta` to the balance of a card, atomically and only if the balance after is not negative; the contact must not be in the trash.
   *
   * @returns The balance after, `null` when nothing matched (no such contact or card, or the balance would go below zero).
   */
  adjustPoints(principal: ScopeHolder, access: GroupAccess, id: ObjectId, code: string, delta: number): Promise<number | null>;
  /** The cards of a contact that is not in the trash (`{ fidelities }`), or `null`. */
  cardsOf(principal: ScopeHolder, access: GroupAccess, id: ObjectId): Promise<Document | null>;
  /**
   * The documents of the legacy that name a contact, of one kind: the ids of at most {@link MAX_REPORTED_REFERENCES} of them (trashed ones included), looked for as an `ObjectId` and as the text of its hexadecimal form.
   *
   * @param maxTimeMS The time the read may take (the rest of the budget of the deletion, at most {@link REFERENCE_MAX_TIME_MS}).
   * @throws {AppError} `SERVICE_UNAVAILABLE` when the read exceeds its time limit.
   */
  referencedBy(principal: ScopeHolder, access: GroupAccess, id: ObjectId, kind: ContactReferenceKind, maxTimeMS: number): Promise<string[]>;
  /** The ids of the promotions of the group that name a contact (`conditions.customersIds`), read tolerantly: see {@link promotionsNaming}. */
  promotionsNamingContact(access: GroupAccess, id: ObjectId): Promise<string[]>;
}

/**
 * The ids of the promotions of a group that name an id in one of their lists of ids (`conditions.customersIds` or `conditions.contactsGroupsIds`). The lists are read as they are stored, tolerantly: an `ObjectId` is its
 * hexadecimal form, a text is compared without regard to case, anything else is left out. At most {@link MAX_REPORTED_REFERENCES}. The group comes from the verified access.
 *
 * @param databases Database accessor.
 * @param access Verified access to the group.
 * @param field The list of ids of the conditions.
 * @param id The contact or the group of contacts.
 * @throws {AppError} `SERVICE_UNAVAILABLE` when the read exceeds its time limit.
 */
export async function promotionsNaming(databases: Databases, access: GroupAccess, field: 'customersIds' | 'contactsGroupsIds', id: ObjectId): Promise<string[]> {
  const group = await bounded(() => databases.common().collection('groups').findOne({ _id: access.groupId }, { projection: { 'promotions.id': 1, [`promotions.conditions.${field}`]: 1 }, maxTimeMS: LIST_MAX_TIME_MS }));
  const wanted = id.toHexString();
  const named = (list: unknown): boolean => Array.isArray(list) && list.some((item: unknown) => (item instanceof ObjectId ? item.toHexString() === wanted : typeof item === 'string' && item.toLowerCase() === wanted));
  return ((group?.['promotions'] ?? []) as Document[]).flatMap((promotion) => (typeof promotion['id'] === 'string' && named((promotion['conditions'] as Document | undefined)?.[field]) ? [promotion['id']] : [])).slice(0, MAX_REPORTED_REFERENCES);
}

/** `409` with `taken` for the account field a unique index of the legacy refused; any other failure (a duplicate of something else included) as it is. */
function takenAccount(error: unknown): unknown {
  const key = error instanceof MongoServerError && error.code === 11000 ? Object.keys((error.keyPattern as Record<string, unknown> | undefined) ?? {})[0] : undefined;
  return key === 'account.email' || key === 'account.telephone' ? new AppError('CONFLICT', { details: [{ field: key === 'account.telephone' ? 'account.phone' : 'account.email', issue: 'taken' }] }) : error;
}

/**
 * Builds the repository of the contacts. The collection is the `contacts` of the group database, opened from the verified access, so a contact of another group is never reachable; the keys a write sets are checked
 * against the owned fields, and nothing else of the document is touched.
 *
 * @param databases Database accessor.
 */
export function createContactsRepository(databases: Databases): ContactsRepository {
  const group = (principal: ScopeHolder, access: GroupAccess) => groupDatabaseFor(principal, access, databases);
  const contacts = (principal: ScopeHolder, access: GroupAccess) => group(principal, access).collection('contacts');
  const either = (id: ObjectId): { $in: Array<ObjectId | string> } => ({ $in: [id, id.toHexString()] });
  const idsOf = (documents: readonly Document[]): ObjectId[] => documents.map((document) => document['_id'] as ObjectId);
  const hexOf = (documents: readonly Document[]): string[] => idsOf(documents).map((id) => id.toHexString());
  const read = <T>(work: () => Promise<T>): Promise<T> => bounded(work);

  /** A path to write must be one the backend owns (or a container the write replaces as a whole), and never the cards. */
  const assertOwned = (keys: Iterable<string>, containers: readonly string[]): void => {
    for (const key of keys) {
      if (key === 'fidelities' || key.startsWith('fidelities.') || (!OWNED.has(key) && !containers.includes(key))) {
        throw new Error(`Refusing to write ${key}: not an owned field`);
      }
    }
  };

  return {
    list: async (principal, access, filter, params) =>
      pageOf(await read(() => contacts(principal, access).aggregate(listPipeline(filter, params, CONTACTS_LIST, ROW_PROJECTION), { maxTimeMS: LIST_MAX_TIME_MS }).toArray()), params),

    listFull: async (principal, access, filter, params) =>
      pageOf(await read(() => contacts(principal, access).aggregate(listPipeline(filter, params, CONTACTS_LIST, CONTACT_PROJECTION), { maxTimeMS: LIST_MAX_TIME_MS }).toArray()), params),

    countUpTo: (principal, access, filter, cap) => read(() => contacts(principal, access).countDocuments(filter, { limit: cap + 1, maxTimeMS: LIST_MAX_TIME_MS })),

    findById: (principal, access, id) => read(() => contacts(principal, access).findOne({ _id: id }, { projection: CONTACT_PROJECTION, maxTimeMS: LIST_MAX_TIME_MS })),

    insert: async (principal, access, document) => {
      for (const key of Object.keys(document).filter((name) => name !== '_id')) {
        if (!OWNED.has(key) && !CONTACTS_OWNED_FIELDS.some((field) => field.startsWith(`${key}.`))) {
          throw new Error(`Refusing to write ${key}: not an owned field`);
        }
      }
      try {
        await contacts(principal, access).insertOne(document);
      } catch (error) {
        throw takenAccount(error);
      }
    },

    update: async (principal, access, id, change, readDate) => {
      assertOwned([...Object.keys(change.set), ...Object.keys(change.unset)], change.containers);
      const touchesCards = change.removed.length > 0 || change.added.length > 0;
      // One update with a pipeline, so the cards are one atomic step with the fields: the cards that stay are the ones the server has at the moment of the write (balance included), never a copy the client read.
      const stages: Document[] = [{ $set: Object.fromEntries(Object.entries({ ...change.set, updateDate: change.updateDate }).map(([path, value]) => [path, { $literal: value }])) }];
      if (Object.keys(change.unset).length > 0) {
        stages.push({ $unset: Object.keys(change.unset) });
      }
      if (touchesCards) {
        const kept = { $filter: { input: { $ifNull: ['$fidelities', []] }, cond: { $not: { $in: ['$$this.code', { $literal: [...change.removed] }] } } } };
        stages.push({ $set: { fidelities: { $concatArrays: [kept, { $literal: change.added.map((code) => ({ code, points: 0 })) }] } } });
      }
      const conditions: Filter<Document>[] = [
        ...Object.entries(change.readValues).map(([path, value]) => sameAs(path, value)),
        // A container the write replaces as a whole must still be what it was: not an object.
        ...change.containers.map((container) => ({ [container]: { $not: { $type: 'object' } } })),
        // The array of the cards is the one thing the rewrite of the cards would fail on: a document that has it as something else is left alone.
        ...(touchesCards ? [{ $or: [{ fidelities: { $exists: false } }, { fidelities: { $type: 'array' } }] }] : []),
      ];
      const guard: Filter<Document> = { _id: id, trash: { $ne: true }, ...sameAs('updateDate', readDate), ...(conditions.length === 0 ? {} : { $and: conditions }) };
      try {
        return (await contacts(principal, access).updateOne(guard, stages)).matchedCount === 1 ? 'updated' : 'conflict';
      } catch (error) {
        throw takenAccount(error);
      }
    },

    setTrash: async (principal, access, id, to, now, state) => {
      const update: Document = to === 'trashed' ? { $set: { trash: true, trashDate: now, updateDate: now } } : { $set: { trash: false, updateDate: now }, $unset: { trashDate: '' } };
      return (await contacts(principal, access).updateOne({ _id: id, ...sameAs('updateDate', state.updateDate), ...sameAs('trash', state.trash) }, update)).matchedCount === 1;
    },

    removeTrashed: async (principal, access, id, state) => (await contacts(principal, access).deleteOne({ _id: id, trash: true, ...sameAs('updateDate', state.updateDate) })).deletedCount === 1,

    trashedIds: async (principal, access, limit, after) =>
      idsOf(await read(() => contacts(principal, access).find({ trash: true, ...(after === null ? {} : { _id: { $gt: after } }) }, { projection: { _id: 1 }, sort: { _id: 1 }, limit, maxTimeMS: LIST_MAX_TIME_MS }).toArray())),

    countTrashed: (principal, access) => read(() => contacts(principal, access).countDocuments({ trash: true }, { maxTimeMS: LIST_MAX_TIME_MS })),

    usingValues: async (principal, access, id, query) => {
      const conditions: Filter<Document>[] = [
        ...(query.code === null ? [] : [{ contactCode: query.code }]),
        ...(query.taxCode === null ? [] : [{ code: query.taxCode }]),
        ...(query.vatNumber === null ? [] : [{ companyCode: query.vatNumber }]),
        ...(query.companyTaxCode === null ? [] : [{ companyCode2: query.companyTaxCode }]),
      ];
      if (conditions.length === 0) {
        return [];
      }
      return read(() =>
        contacts(principal, access)
          .find({ _id: { $ne: id }, trash: { $ne: true }, $or: conditions }, { projection: { contactCode: 1, code: 1, companyCode: 1, companyCode2: 1 }, limit: MAX_DUPLICATE_SCAN, maxTimeMS: LIST_MAX_TIME_MS })
          .toArray(),
      );
    },

    accountTaken: async (principal, access, id, account) => {
      const conditions: Filter<Document>[] = [...(account.email === null ? [] : [{ 'account.email': { $regex: `^${escapeRegExp(account.email)}$`, $options: 'i' } }]), ...(account.phone === null ? [] : [{ 'account.telephone': account.phone }])];
      if (conditions.length === 0) {
        return { email: false, phone: false };
      }
      const others = await read(() => contacts(principal, access).find({ _id: { $ne: id }, $or: conditions }, { projection: { 'account.email': 1, 'account.telephone': 1 }, limit: 2, maxTimeMS: LIST_MAX_TIME_MS }).toArray());
      const accounts = others.map((other) => other['account'] as Document);
      return { email: account.email !== null && accounts.some((other) => typeof other['email'] === 'string' && other['email'].toLowerCase() === account.email), phone: account.phone !== null && accounts.some((other) => other['telephone'] === account.phone) };
    },

    cardHolders: async (principal, access, codes, loose) => {
      const filter: Filter<Document> = loose ? { $or: codes.map((code) => ({ 'fidelities.code': { $regex: `^\\s*${escapeRegExp(code)}\\s*$` } })) } : { 'fidelities.code': { $in: [...codes] } };
      const found = await read(() =>
        contacts(principal, access)
          .find({ trash: { $ne: true }, ...filter }, { projection: { name: 1, surname: 1, companyName: 1, 'fidelities.code': 1 }, sort: { _id: 1 }, limit: MAX_HOLDERS_SCAN, maxTimeMS: LIST_MAX_TIME_MS })
          .toArray(),
      );
      const holders = new Map<string, { items: Document[]; count: number }>(codes.map((code) => [code, { items: [], count: 0 }]));
      for (const contact of found) {
        const own = new Set((Array.isArray(contact['fidelities']) ? (contact['fidelities'] as Document[]) : []).flatMap((card) => (typeof card['code'] === 'string' ? [card['code'].trim()] : [])));
        for (const code of codes) {
          const entry = holders.get(code)!;
          if (own.has(code)) {
            entry.count += 1;
            if (entry.items.length < MAX_CARD_HOLDERS) {
              entry.items.push(contact);
            }
          }
        }
      }
      return holders;
    },

    cardHolderIds: async (principal, access, code) =>
      hexOf(await read(() => contacts(principal, access).find({ 'fidelities.code': { $regex: `^\\s*${escapeRegExp(code)}\\s*$` } }, { projection: { _id: 1 }, limit: MAX_REPORTED_REFERENCES, maxTimeMS: REFERENCE_MAX_TIME_MS }).toArray())),

    cardCodesOfContactsNamed: async (principal, access, text) => {
      const contains = { $regex: escapeRegExp(text), $options: 'i' };
      const named = await read(() =>
        contacts(principal, access)
          .find({ trash: { $ne: true }, $or: [{ name: contains }, { surname: contains }, { companyName: contains }] }, { projection: { 'fidelities.code': 1 }, limit: MAX_NAME_SCAN, maxTimeMS: LIST_MAX_TIME_MS })
          .toArray(),
      );
      return named.flatMap((contact) => (Array.isArray(contact['fidelities']) ? (contact['fidelities'] as Document[]) : []).flatMap((card) => (typeof card['code'] === 'string' ? [card['code'].trim()] : []))).slice(0, MAX_NAME_CODES);
    },

    contactsByIds: (principal, access, ids) =>
      read(() => contacts(principal, access).find({ _id: { $in: ids.map((id) => ObjectId.createFromHexString(id)) }, trash: { $ne: true } }, { projection: { name: 1, surname: 1, companyName: 1 }, limit: ids.length, maxTimeMS: LIST_MAX_TIME_MS }).toArray()),

    linkCard: async (principal, access, ids, code, now) =>
      (
        await contacts(principal, access).updateMany(
          { _id: { $in: [...ids] }, trash: { $ne: true }, $and: [{ $or: [{ fidelities: { $exists: false } }, { fidelities: { $type: 'array' } }] }, { fidelities: { $not: { $elemMatch: { code } } } }] },
          { $push: { fidelities: { code, points: 0 } }, $set: { updateDate: now } } as Document,
        )
      ).modifiedCount,

    advancedCards: (principal, access, codes) =>
      read(() => group(principal, access).collection('fidelity_cards').find({ code: { $in: [...codes] } }, { projection: { code: 1, cardTypeId: 1, status: 1, balance: 1, pointsCollections: 1 }, limit: codes.length, maxTimeMS: LIST_MAX_TIME_MS }).toArray()),

    isAdvancedCard: async (principal, access, codes) =>
      (await read(() => group(principal, access).collection('fidelity_cards').findOne({ code: { $in: [...codes] } }, { projection: { _id: 1 }, maxTimeMS: LIST_MAX_TIME_MS }))) !== null,

    groupExists: async (principal, access, id) => (await read(() => group(principal, access).collection('contacts_groups').findOne({ _id: id }, { projection: { _id: 1 }, maxTimeMS: LIST_MAX_TIME_MS }))) !== null,

    companyExists: async (principal, access, id) =>
      (await read(() => contacts(principal, access).findOne({ _id: id, trash: { $ne: true }, companyName: { $type: 'string', $ne: '' } }, { projection: { _id: 1 }, maxTimeMS: LIST_MAX_TIME_MS }))) !== null,

    invalidServices: async (principal, access, ids) => {
      const wanted = [...new Set(ids)].map((id) => ObjectId.createFromHexString(id));
      const valid = await read(() => group(principal, access).collection('products').find({ _id: { $in: wanted }, type: 'service', trash: { $ne: true } }, { projection: { _id: 1 }, limit: wanted.length, maxTimeMS: LIST_MAX_TIME_MS }).toArray());
      const known = new Set(hexOf(valid));
      return ids.flatMap((id, index) => (known.has(id) ? [] : [index]));
    },

    productsUsingPriceLists: async (principal, access, contactId, listIds) =>
      hexOf(
        await read(() =>
          group(principal, access)
            .collection('products')
            .find({ trash: { $ne: true }, suppliers: { $elemMatch: { id: either(contactId), 'companyLists.id': { $in: [...listIds] } } } }, { projection: { _id: 1 }, limit: MAX_REPORTED_REFERENCES, maxTimeMS: LIST_MAX_TIME_MS })
            .toArray(),
        ),
      ),

    adjustPoints: async (principal, access, id, code, delta) => {
      const balance = delta < 0 ? { $gte: -delta } : { $type: 'number' };
      const updated = await contacts(principal, access).findOneAndUpdate(
        { _id: id, trash: { $ne: true }, fidelities: { $elemMatch: { code, points: balance } } },
        { $inc: { 'fidelities.$[card].points': delta } },
        { arrayFilters: [{ 'card.code': code, 'card.points': balance }], returnDocument: 'after', projection: { fidelities: 1 } },
      );
      const card = ((updated?.['fidelities'] ?? []) as Document[]).find((candidate) => candidate['code'] === code);
      return typeof card?.['points'] === 'number' ? card['points'] : null;
    },

    cardsOf: (principal, access, id) => read(() => contacts(principal, access).findOne({ _id: id, trash: { $ne: true } }, { projection: { fidelities: 1 }, maxTimeMS: LIST_MAX_TIME_MS })),

    promotionsNamingContact: (access, id) => promotionsNaming(databases, access, 'customersIds', id),

    referencedBy: async (principal, access, id, kind, maxTimeMS) => {
      const db = group(principal, access);
      const found = { projection: { _id: 1 }, limit: MAX_REPORTED_REFERENCES, maxTimeMS };
      const target = either(id);
      switch (kind) {
        case 'contactAssociations':
          return hexOf(await read(() => db.collection('contacts').find({ _id: { $ne: id }, associatedCompanyId: target }, found).toArray()));
        case 'products':
          return hexOf(await read(() => db.collection('products').find({ $or: [{ 'suppliers.id': target }, { 'lastAveragePrice.lastSupplierId': target }] }, found).toArray()));
        case 'warehouseMovements':
          return hexOf(await read(() => db.collection('warehouse').find({ supplierId: target }, found).toArray()));
        case 'appointments':
          return hexOf(await read(() => db.collection('calendar').find({ customerId: target }, found).toArray()));
        case 'tableReservations':
          return hexOf(await read(() => db.collection('table_reservation').find({ customerId: target }, found).toArray()));
        case 'documents':
          return hexOf(await read(() => db.collection('documents').find({ 'counterpart._id': target }, found).toArray()));
        case 'sales':
          return hexOf(await read(() => db.collection('sales').find({ $or: [{ 'customer._id': target }, { 'appointment.customerId': target }] }, found).toArray()));
      }
    },
  };
}
