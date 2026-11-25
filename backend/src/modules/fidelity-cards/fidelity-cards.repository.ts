import { Double, MongoServerError } from 'mongodb';
import type { Document, Filter, ObjectId } from 'mongodb';
import { FIDELITY_CARDS_OWNED_FIELDS } from '../../db/collections.ts';
import type { Databases } from '../../db/databases.ts';
import { AppError } from '../../shared/http/errors.ts';
import { LIST_MAX_TIME_MS, escapeRegExp, listPipeline, pageOf } from '../../shared/http/list.ts';
import type { ListPage, ListParams } from '../../shared/http/list.ts';
import { bounded } from '../../shared/security/scope/bounded.ts';
import { groupDatabaseFor } from '../../shared/security/scope/group-access.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { ScopeHolder } from '../../shared/security/scope/principal.ts';
import { MAX_REPORTED_REFERENCES, REFERENCE_MAX_TIME_MS } from '../contacts/contacts.repository.ts';
import { apiKeyNames } from '../api-keys/api-keys.repository.ts';
import { SAFE_ID } from '../groups/catalogs/kit.ts';
import { entityProjection, sameAs } from '../product-catalog/entity.repository.ts';
import { CARDS_LIST, MOVEMENTS_LIST } from './fidelity-cards.schemas.ts';

const PROJECTION = entityProjection(FIDELITY_CARDS_OWNED_FIELDS);

/** A movement of the history of a card, as it is inserted: `manually` (the sales are the legacy's), or `import` for the credit and the points a card is given by the workbook. */
export interface NewMovement {
  /** The user who made the movement; `null` for the one made by a public API key (the activity log names the key). */
  readonly userId: ObjectId | null;
  /** The public API key that made the movement (set only then, with `userId` `null`). */
  readonly apiKeyId?: ObjectId;
  /** The store key of the server of a point of sale that made the movement (set only then, with `userId` the operator the store declared): the backoffice shows it as made at the till. A field the legacy neither reads nor rewrites. */
  readonly storeKeyId?: ObjectId;
  readonly cardId: ObjectId;
  readonly cardCode: string;
  readonly date: Date;
  /** `manually` for what an operator does in the backoffice, `import` for the initial values of a card created by the workbook: the movements of a sale are the legacy's. */
  readonly type: 'manually' | 'import';
  /** The credit moved, with its sign; `0` for a movement of points only. */
  readonly balance: number;
  /** The collection the points were moved on; `null` for a movement of credit only. */
  readonly pointsCollectionId: string | null;
  /** The points moved, with their sign; `0` for a movement of credit only. */
  readonly points: number;
}

/** What an adjustment changes: the credit and the points of some collections, each with its sign. */
export interface CardDeltas {
  readonly balance?: number;
  readonly points: ReadonlyArray<{ readonly collectionId: string; readonly delta: number }>;
}

/** The `fidelity_cards` and `fidelity_cards_movements` collections of a group database, as seen by a caller. */
export interface CardsRepository {
  /** A page of the cards, by the filter of the request; the order is applied before the page is cut. */
  list(principal: ScopeHolder, access: GroupAccess, filter: Filter<Document>, params: ListParams): Promise<ListPage>;
  /** How many cards there are, counted up to `cap + 1` (the size check of the export). */
  countUpTo(principal: ScopeHolder, access: GroupAccess, cap: number): Promise<number>;
  /** One card with every owned field, or `null`. */
  findById(principal: ScopeHolder, access: GroupAccess, id: ObjectId): Promise<Document | null>;
  /**
   * The cards that have some codes, with every owned field. The comparison ignores the spaces around a stored code (the legacy may have left some; `cardHolders` does the same), so a code of the file finds `' ABC '`.
   * The unique index is on the exact text, so more than one card may match a code: at most `codes.length + 1` are read, and the caller treats more than one as ambiguous.
   */
  findByCodes(principal: ScopeHolder, access: GroupAccess, codes: readonly string[]): Promise<Document[]>;
  /** Whether a card has a code, ignoring the spaces around a stored one. */
  codeTaken(principal: ScopeHolder, access: GroupAccess, code: string): Promise<boolean>;
  /**
   * Inserts a new card and the movements of what it starts with. The caller runs it in a transaction (a repository built over `sessionDatabases`), so the card never has a credit or points that no movement explains.
   *
   * @throws {AppError} `CONFLICT` with `taken` on `code` when the unique index of the legacy refuses the code.
   */
  insert(principal: ScopeHolder, access: GroupAccess, card: Document, movements: readonly NewMovement[]): Promise<void>;
  /**
   * Applies a change of the type or of the state only if the card is still as it was read (the date, the type and the state); returns whether it was. With `emptyBalance` (a change to a type that is not prepaid) it also requires the credit
   * to be zero, missing or negative at the moment of the write, so a credit a sale added meanwhile is never left on a card that cannot show it.
   */
  update(principal: ScopeHolder, access: GroupAccess, id: ObjectId, set: Document, updateDate: Date, read: { readonly updateDate: unknown; readonly cardTypeId: unknown; readonly status: unknown }, options?: { readonly emptyBalance?: true }): Promise<boolean>;
  /**
   * Adds the deltas to the credit and to the points of a card with one update: the credit is added and rounded to two decimals in the database and kept a `Double`, and no value goes below zero (a value that is not a finite number,
   * or is a list, never matches). The write requires the card to still have the type it was read with. The date and the version of the card do not change.
   *
   * @param cardTypeId The `cardTypeId` the card had when it was read.
   * @returns The card after, `null` when nothing matched (no such card, or a value would go below zero, or the type changed).
   */
  adjust(principal: ScopeHolder, access: GroupAccess, id: ObjectId, deltas: CardDeltas, cardTypeId: unknown): Promise<Document | null>;
  /** Inserts the movements of an adjustment (in the transaction of the `$inc` they explain). */
  insertMovements(principal: ScopeHolder, access: GroupAccess, movements: readonly NewMovement[]): Promise<void>;
  /** A page of the movements of a card (by id or by code), newest first. */
  movements(principal: ScopeHolder, access: GroupAccess, card: { readonly id: ObjectId; readonly code: string }, params: ListParams): Promise<ListPage>;
  /** Whether a card has at least one movement (by id or by code). */
  hasMovements(principal: ScopeHolder, access: GroupAccess, card: { readonly id: ObjectId; readonly code: string }): Promise<boolean>;
  /** Deletes a card only if it is still as it was read: the date, the credit and the points (a sale or an adjustment since the read keeps it). */
  remove(principal: ScopeHolder, access: GroupAccess, id: ObjectId, read: { readonly updateDate: unknown; readonly balance: unknown; readonly pointsCollections: unknown }): Promise<boolean>;
  /** The display names of some users of the group (first name and surname), by hexadecimal id. */
  operatorNames(access: GroupAccess, ids: readonly ObjectId[]): Promise<Map<string, string | null>>;
  /** The names of some public API keys of the group (revoked ones included), by hexadecimal id. */
  apiKeyNames(access: GroupAccess, ids: readonly ObjectId[]): Promise<Map<string, string | null>>;
  /** The ids (hexadecimal, at most 20) of the cards of a card type: a type they use is never deleted. */
  cardTypeUsers(principal: ScopeHolder, access: GroupAccess, typeId: string): Promise<string[]>;
  /** The ids of the cards that have points (more than zero) on a points collection. */
  collectionUsers(principal: ScopeHolder, access: GroupAccess, collectionId: string): Promise<string[]>;
}

/** `409 taken` on the code for the duplicate key of the unique index of the legacy; any other failure as it is. */
function takenCode(error: unknown): unknown {
  const key = error instanceof MongoServerError && error.code === 11000 ? Object.keys((error.keyPattern as Record<string, unknown> | undefined) ?? {})[0] : undefined;
  return key === 'code' ? new AppError('CONFLICT', { details: [{ field: 'code', issue: 'taken' }] }) : error;
}

/**
 * Builds the repository of the cards. The collections are those of the group database, opened from the verified access, so a card of another group is never reachable. Only the `$inc` of an adjustment touches the credit and the points of
 * an existing card; the movements are only inserted. The service runs the writes that must go together in a transaction, over a repository built on the database accessor of that transaction.
 *
 * @param databases Database accessor.
 */
export function createCardsRepository(databases: Databases): CardsRepository {
  const group = (principal: ScopeHolder, access: GroupAccess) => groupDatabaseFor(principal, access, databases);
  const cards = (principal: ScopeHolder, access: GroupAccess) => group(principal, access).collection('fidelity_cards');
  const history = (principal: ScopeHolder, access: GroupAccess) => group(principal, access).collection('fidelity_cards_movements');
  const hexOf = (documents: readonly Document[]): string[] => documents.map((document) => (document['_id'] as ObjectId).toHexString());
  const ofCard = (card: { readonly id: ObjectId; readonly code: string }): Filter<Document> => ({ $or: [{ cardId: card.id }, { cardCode: card.code }] });

  return {
    list: async (principal, access, filter, params) =>
      pageOf(await bounded(() => cards(principal, access).aggregate(listPipeline(filter, params, CARDS_LIST, PROJECTION), { maxTimeMS: LIST_MAX_TIME_MS }).toArray()), params),

    countUpTo: (principal, access, cap) => bounded(() => cards(principal, access).countDocuments({}, { limit: cap + 1, maxTimeMS: LIST_MAX_TIME_MS })),

    findById: (principal, access, id) => bounded(() => cards(principal, access).findOne({ _id: id }, { projection: PROJECTION, maxTimeMS: LIST_MAX_TIME_MS })),

    findByCodes: (principal, access, codes) =>
      bounded(() => cards(principal, access).find({ $or: codes.map((code) => ({ code: { $regex: `^\\s*${escapeRegExp(code)}\\s*$` } })) }, { projection: PROJECTION, limit: codes.length + 1, maxTimeMS: LIST_MAX_TIME_MS }).toArray()),

    codeTaken: async (principal, access, code) => (await bounded(() => cards(principal, access).findOne({ code: { $regex: `^\\s*${escapeRegExp(code)}\\s*$` } }, { projection: { _id: 1 }, maxTimeMS: LIST_MAX_TIME_MS }))) !== null,

    insert: async (principal, access, card, movements) => {
      try {
        await cards(principal, access).insertOne(card);
      } catch (error) {
        throw takenCode(error);
      }
      if (movements.length > 0) {
        await history(principal, access).insertMany(movements.map((movement) => ({ ...movement })));
      }
    },

    update: async (principal, access, id, set, updateDate, read, options = {}) => {
      const owned = new Set(FIDELITY_CARDS_OWNED_FIELDS);
      for (const key of Object.keys(set)) {
        if (!owned.has(key) || key === 'code' || key === 'balance' || key === 'pointsCollections') {
          throw new Error(`Refusing to write ${key}: not a field a modification may set`);
        }
      }
      const guard: Filter<Document> = {
        _id: id,
        ...sameAs('updateDate', read.updateDate),
        ...sameAs('cardTypeId', read.cardTypeId),
        ...sameAs('status', read.status),
        ...(options.emptyBalance === true ? { $or: [{ balance: { $exists: false } }, { balance: { $lte: 0 } }] } : {}),
      };
      return (await cards(principal, access).updateOne(guard, { $set: { ...set, updateDate } })).matchedCount === 1;
    },

    adjust: async (principal, access, id, deltas, cardTypeId) => {
      const set: Record<string, unknown> = {};
      const conditions: Filter<Document>[] = [];
      /** A finite number that is not in a list, from `minimum` up: the only kind of value an adjustment adds to. */
      const finite = (path: string, minimum: number): Filter<Document> => ({ $and: [{ [path]: { $gte: minimum, $lt: Number.POSITIVE_INFINITY } }, { [path]: { $not: { $type: 'array' } } }] });
      const addable = (path: string, delta: number): Filter<Document> => (delta < 0 ? finite(path, -delta) : { $or: [{ [path]: { $exists: false } }, finite(path, Number.NEGATIVE_INFINITY)] });
      if (deltas.balance !== undefined) {
        // The credit is added and rounded to two decimals in the database, in one step, and stays a `Double` (also when the key is created by the update).
        set['balance'] = { $round: [{ $add: [{ $ifNull: ['$balance', { $literal: new Double(0) }] }, { $literal: new Double(deltas.balance) }] }, 2] };
        conditions.push(addable('balance', deltas.balance));
      }
      if (deltas.points.length > 0) {
        // `$type: 'object'` also matches a list that has an object in it: a list is refused as such.
        conditions.push({ $or: [{ pointsCollections: { $exists: false } }, { pointsCollections: { $type: 'object' } }] }, { pointsCollections: { $not: { $type: 'array' } } });
      }
      for (const { collectionId, delta } of deltas.points) {
        if (!SAFE_ID.test(collectionId)) {
          throw new Error('Refusing to write a collection that is not a safe id');
        }
        const path = `pointsCollections.${collectionId}`;
        set[path] = { $add: [{ $ifNull: [`$${path}`, 0] }, { $literal: delta }] };
        conditions.push(addable(path, delta));
      }
      return cards(principal, access).findOneAndUpdate({ _id: id, ...sameAs('cardTypeId', cardTypeId), $and: conditions }, [{ $set: set }], { returnDocument: 'after', projection: PROJECTION });
    },

    insertMovements: async (principal, access, movements) => {
      await history(principal, access).insertMany(movements.map((movement) => ({ ...movement })));
    },

    movements: async (principal, access, card, params) =>
      pageOf(
        await bounded(() => history(principal, access).aggregate(listPipeline(ofCard(card), params, MOVEMENTS_LIST, { userId: 1, apiKeyId: 1, storeKeyId: 1, date: 1, type: 1, balance: 1, points: 1, pointsCollectionId: 1 }), { maxTimeMS: LIST_MAX_TIME_MS }).toArray()),
        params,
      ),

    hasMovements: async (principal, access, card) => (await bounded(() => history(principal, access).findOne(ofCard(card), { projection: { _id: 1 }, maxTimeMS: REFERENCE_MAX_TIME_MS }))) !== null,

    remove: async (principal, access, id, read) =>
      (await cards(principal, access).deleteOne({ _id: id, ...sameAs('updateDate', read.updateDate), ...sameAs('balance', read.balance), ...sameAs('pointsCollections', read.pointsCollections) })).deletedCount === 1,

    operatorNames: async (access, ids) => {
      const found = await bounded(() => databases.common().collection('users').find({ _id: { $in: [...ids] }, groupId: access.groupId }, { projection: { name: 1, surname: 1 }, limit: ids.length, maxTimeMS: LIST_MAX_TIME_MS }).toArray());
      const names = new Map<string, string | null>();
      for (const user of found) {
        const name = [user['name'], user['surname']].filter((part): part is string => typeof part === 'string').join(' ').trim();
        names.set((user['_id'] as ObjectId).toHexString(), name === '' ? null : name);
      }
      return names;
    },

    apiKeyNames: (access, ids) => apiKeyNames(databases, access.groupId, ids),

    cardTypeUsers: async (principal, access, typeId) => hexOf(await bounded(() => cards(principal, access).find({ cardTypeId: typeId }, { projection: { _id: 1 }, limit: MAX_REPORTED_REFERENCES, maxTimeMS: REFERENCE_MAX_TIME_MS }).toArray())),

    collectionUsers: async (principal, access, collectionId) =>
      SAFE_ID.test(collectionId) ? hexOf(await bounded(() => cards(principal, access).find({ [`pointsCollections.${collectionId}`]: { $gt: 0 } }, { projection: { _id: 1 }, limit: MAX_REPORTED_REFERENCES, maxTimeMS: REFERENCE_MAX_TIME_MS }).toArray())) : [],
  };
}

