import { MongoServerError, ObjectId } from 'mongodb';
import type { ClientSession, Document, Filter } from 'mongodb';
import type { Databases } from '../../db/databases.ts';
import { AppError } from '../../shared/http/errors.ts';
import { LIST_MAX_TIME_MS } from '../../shared/http/list.ts';
import { readMirrorActivationCompanies, readMirrorActivationPlaces } from '../../shared/security/scope/group-mirror.ts';
import type { ActivationWindow } from '../../shared/security/scope/mirror-activations.ts';
import { cleanName } from './activations.names.ts';
import type { GroupSwitches } from './activations.pricing.ts';
import type { Closure } from './activations.types.ts';
import { closureOf } from './activations.mapper.ts';
import { overridesOf } from '../settings/price-list.ts';
import type { PriceOverrides } from '../settings/price-list.ts';

/** MongoDB's `MaxTimeMSExpired` error code. */
const MAX_TIME_EXPIRED = 50;

/** MongoDB's duplicate key error code. */
const DUPLICATE_KEY = 11000;

/** Prefix of the key of the lock document of a year in `common.settings`. */
export const LOCK_KEY_PREFIX = 'BILLING_LOCK:';

/** Most ids of dealers read with one query. */
const DEALERS_CHUNK = 1000;

/** The part of a group the billing reads. */
export interface GroupFacts {
  readonly id: ObjectId;
  readonly name: string;
  /** The dealer of the group, `null` when it has none (a missing or malformed `dealerId`). */
  readonly dealerId: ObjectId | null;
  /** `status === false`: the group is suspended, and still counted. */
  readonly suspended: boolean;
  readonly switches: GroupSwitches;
}

/** What a read of groups is narrowed to: every dealer, the groups with no dealer, or one dealer. */
export type DealerTarget = { readonly kind: 'all' } | { readonly kind: 'none' } | { readonly kind: 'dealer'; readonly id: ObjectId };

/** A dealer as the billing needs it. */
export interface DealerInfo {
  readonly name: string;
  readonly overrides: PriceOverrides;
}

/** A place with its company, as read for the billing; `company` is `null` when the place has none in its own group (missing, or of another group). */
export interface PlaceRecord {
  readonly place: Document;
  readonly company: Document | null;
}

/** Which closure documents a read selects. `dealerId` `undefined` is every dealer, `null` the groups with no dealer. */
export interface ClosureQuery {
  readonly kind: Closure['kind'];
  readonly period: string;
  readonly dealerId?: ObjectId | null;
}

/** The reads and writes of the billing: the groups and the dealers of the common database, the copies of the places and of the companies, and the closures. Every read is bounded and has a time limit. */
export interface ActivationsRepository {
  /**
   * The groups that count (not in the trash, not demo) of a dealer, of the groups with no dealer, or of all.
   *
   * @param target Which groups.
   * @param max Most groups; more is an error (a data problem, never a truncated answer).
   * @throws {AppError} `SERVICE_UNAVAILABLE` when the read exceeds its time limit.
   * @throws {Error} When there are more groups than `max`.
   */
  readGroups(target: DealerTarget, max: number): Promise<GroupFacts[]>;
  /**
   * The name and the price overrides of some dealers, by hexadecimal id: from the registry, or, for a dealer user with no document there, the user name and no overrides (an id that is neither is not in the map).
   *
   * @param ids The dealers.
   * @throws {AppError} `SERVICE_UNAVAILABLE` when the read exceeds its time limit.
   */
  readDealers(ids: readonly ObjectId[]): Promise<Map<string, DealerInfo>>;
  /**
   * A batch of the places activated in a window, with their companies.
   *
   * @param window The window of the activation date.
   * @param groupIds The groups to read, or `null` for every group.
   * @param after The `_id` of the last place of the previous batch, or `null`.
   * @param limit How many places at most.
   * @throws {AppError} `SERVICE_UNAVAILABLE` when a read exceeds its time limit.
   */
  readPlaces(window: ActivationWindow, groupIds: readonly ObjectId[] | null, after: ObjectId | null, limit: number): Promise<PlaceRecord[]>;
  /**
   * The closure documents of a kind and a period.
   *
   * @param query Which documents.
   * @param withLines Whether to read the lines, which are most of the size of a document.
   * @param max Most documents; more is an error.
   * @param session The transaction, to read inside it.
   * @throws {AppError} `SERVICE_UNAVAILABLE` when the read exceeds its time limit.
   */
  readClosures(query: ClosureQuery, withLines: boolean, max: number, session?: ClientSession): Promise<Closure[]>;
  /**
   * Whether a closure of a kind and a period exists, for any dealer.
   *
   * @param session The transaction, to read inside it.
   */
  hasClosure(kind: Closure['kind'], period: string, session?: ClientSession): Promise<boolean>;
  /**
   * Whether a month of a year is closed.
   *
   * @param session The transaction, to read inside it.
   */
  hasClosedMonthIn(year: number, session?: ClientSession): Promise<boolean>;
  /**
   * Writes the lock document of a year, which every freeze, unfreeze, close and reopen of that year increments inside its transaction: two of them at once write the same document, so the database makes one of them
   * wait and retry on what the other committed (without it two transactions that each read what the other writes could both commit: write skew).
   *
   * @param year The year.
   * @param by The administrator.
   * @param at Time of the change.
   * @param session The transaction.
   * @returns `false` when another transaction created the lock document first (a unique key error).
   */
  lockYear(year: number, by: ObjectId, at: Date, session: ClientSession): Promise<boolean>;
  /**
   * Inserts closure documents.
   *
   * @param closures The documents.
   * @param session The transaction.
   * @returns `false` when a document with the same kind, period and dealer already exists (a closure made meanwhile).
   */
  insertClosures(closures: readonly Closure[], session: ClientSession): Promise<boolean>;
  /**
   * Deletes the closure documents of a kind and a period.
   *
   * @param session The transaction.
   * @returns How many documents were deleted.
   */
  deleteClosures(kind: Closure['kind'], period: string, session: ClientSession): Promise<number>;
  /** Runs `work` in a transaction. */
  transaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T>;
}

/** Runs a read, answering `503` when it exceeds its time limit: the answer is unknown, never an empty one. */
async function limited<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    throw error instanceof MongoServerError && error.code === MAX_TIME_EXPIRED ? new AppError('SERVICE_UNAVAILABLE') : error;
  }
}

/** What the billing reads of a group: never `apiKey`, `databaseHost`, the settings as a whole or the integrations of the group but the `status` of StatManager. */
export const GROUP_PROJECTION: Readonly<Record<string, 1>> = Object.freeze({ name: 1, dealerId: 1, status: 1, 'settings.tobaccosGamesMonopoly': 1, 'settings.integrations.statmanager.status': 1 });

function groupFactsOf(document: Document): GroupFacts {
  const settings = document['settings'] as { tobaccosGamesMonopoly?: unknown; integrations?: { statmanager?: { status?: unknown } | null } | null } | null | undefined;
  return {
    id: document['_id'] as ObjectId,
    name: cleanName(document['name']),
    dealerId: document['dealerId'] instanceof ObjectId ? document['dealerId'] : null,
    suspended: document['status'] === false,
    switches: { tobaccos: settings?.tobaccosGamesMonopoly === true, statManager: settings?.integrations?.statmanager?.status === true },
  };
}

/**
 * Builds the repository of the billing. The groups, the dealers and the closures are read from the common database; the places and the companies only through the fixed readers of the copies (`group-mirror.ts`), which
 * project nothing but the fields the billing needs.
 *
 * @param databases Database accessor.
 */
export function createActivationsRepository(databases: Databases): ActivationsRepository {
  const closures = () => databases.common().collection('billingClosures');
  const closureFilter = (query: ClosureQuery): Filter<Document> => ({ kind: query.kind, period: query.period, ...(query.dealerId === undefined ? {} : { dealerId: query.dealerId }) });
  return {
    readGroups: (target, max) =>
      limited(async () => {
        const dealer = target.kind === 'all' ? {} : target.kind === 'none' ? { dealerId: { $not: { $type: 'objectId' } } } : { dealerId: target.id };
        const cursor = databases
          .common()
          .collection('groups')
          .find({ trash: { $ne: true }, demo: { $ne: true }, ...dealer }, { projection: { ...GROUP_PROJECTION }, sort: { _id: 1 }, limit: max + 1, maxTimeMS: LIST_MAX_TIME_MS });
        const groups: GroupFacts[] = [];
        for await (const document of cursor) {
          groups.push(groupFactsOf(document));
        }
        if (groups.length > max) {
          throw new Error(`The billing reads more than ${String(max)} groups`);
        }
        return groups;
      }),

    readDealers: (ids) =>
      limited(async () => {
        const found = new Map<string, DealerInfo>();
        for (let start = 0; start < ids.length; start += DEALERS_CHUNK) {
          const chunk = ids.slice(start, start + DEALERS_CHUNK);
          const documents = await databases
            .common()
            .collection('dealers')
            .find({ _id: { $in: [...chunk] } }, { projection: { businessName: 1, priceOverrides: 1 }, limit: chunk.length, maxTimeMS: LIST_MAX_TIME_MS })
            .toArray();
          for (const document of documents) {
            found.set((document['_id'] as ObjectId).toHexString(), { name: cleanName(document['businessName']), overrides: overridesOf(document['priceOverrides']) });
          }
          // A dealer user with no document in the registry (created before it) is still a dealer: his name is his user name and he has no overrides.
          const missing = chunk.filter((id) => !found.has(id.toHexString()));
          if (missing.length > 0) {
            const users = await databases.common().collection('users').find({ _id: { $in: missing }, role: 'D' }, { projection: { userName: 1 }, limit: missing.length, maxTimeMS: LIST_MAX_TIME_MS }).toArray();
            for (const user of users) {
              found.set((user['_id'] as ObjectId).toHexString(), { name: cleanName(user['userName']) || (user['_id'] as ObjectId).toHexString(), overrides: {} });
            }
          }
        }
        return found;
      }),

    readPlaces: async (window, groupIds, after, limit) => {
      const places = await readMirrorActivationPlaces(databases, window, groupIds, after, limit);
      const companyIds = [...new Map(places.flatMap((place) => (place['companyId'] instanceof ObjectId ? [[place['companyId'].toHexString(), place['companyId']] as const] : []))).values()];
      const companies = companyIds.length === 0 ? [] : await readMirrorActivationCompanies(databases, companyIds);
      const byId = new Map(companies.map((company) => [(company['_id'] as ObjectId).toHexString(), company]));
      return places.map((place) => {
        const company = place['companyId'] instanceof ObjectId ? byId.get(place['companyId'].toHexString()) : undefined;
        // A company counts only if it belongs to the group of the place: an id that points into another group is no company of this place.
        const sameGroup = company !== undefined && company['groupId'] instanceof ObjectId && company['groupId'].equals(place['groupId'] as ObjectId);
        return { place, company: sameGroup ? company : null };
      });
    },

    readClosures: (query, withLines, max, session) =>
      limited(async () => {
        const documents = await closures()
          .find(closureFilter(query), { ...(withLines ? {} : { projection: { 'activations.lines': 0, 'renewals.lines': 0 } }), sort: { dealerName: 1, _id: 1 }, limit: max + 1, maxTimeMS: LIST_MAX_TIME_MS, ...(session === undefined ? {} : { session }) })
          .toArray();
        if (documents.length > max) {
          throw new Error(`The billing reads more than ${String(max)} closure documents`);
        }
        return documents.map(closureOf);
      }),

    hasClosure: (kind, period, session) =>
      limited(async () => (await closures().countDocuments({ kind, period }, { limit: 1, maxTimeMS: LIST_MAX_TIME_MS, ...(session === undefined ? {} : { session }) })) > 0),

    hasClosedMonthIn: (year, session) =>
      limited(async () => (await closures().countDocuments({ kind: 'month', period: { $gte: `${String(year)}-01`, $lte: `${String(year)}-12` } }, { limit: 1, maxTimeMS: LIST_MAX_TIME_MS, ...(session === undefined ? {} : { session }) })) > 0),

    lockYear: async (year, by, at, session) => {
      try {
        await databases.common().collection('settings').updateOne({ key: `${LOCK_KEY_PREFIX}${String(year)}` }, { $inc: { 'value.counter': 1 }, $set: { updatedAt: at, updatedBy: by } }, { upsert: true, session });
        return true;
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === DUPLICATE_KEY) {
          return false;
        }
        throw error;
      }
    },

    insertClosures: async (documents, session) => {
      try {
        await closures().insertMany(documents.map((closure) => ({ ...closure })), { session });
        return true;
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === DUPLICATE_KEY) {
          return false;
        }
        throw error;
      }
    },

    deleteClosures: async (kind, period, session) => (await closures().deleteMany({ kind, period }, { session })).deletedCount,

    transaction: (work) => databases.transaction(work),
  };
}
