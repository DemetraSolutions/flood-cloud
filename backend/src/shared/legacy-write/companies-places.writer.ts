import { ObjectId } from 'mongodb';
import type { ClientSession, Collection, Document } from 'mongodb';
import type { Databases } from '../../db/databases.ts';
import { groupDatabaseFor } from '../security/scope/group-access.ts';
import type { GroupAccess } from '../security/scope/group-access.ts';
import type { AuthPrincipal } from '../security/scope/principal.ts';
import { companyInScope, placeInScope } from '../security/scope/scope-filters.ts';
import { EXACT_TYPES, expectedCopy } from './copy-rule.ts';
import { COMPANY_CONTAINERS } from './company-paths.ts';
import { companyContainerDefaults, newCompanyDocument, newPlaceDocument } from './defaults.ts';
import { CrossClusterWriteError, InvalidWriteInputError, MalformedDocumentError } from './errors.ts';
import { COMPANY_FIELD_KINDS, PLACE_FIELD_KINDS, checkChanges, checkObjectId } from './fields.ts';
import type { CompanyChanges, NewCompanyFields, NewPlaceFields, PlaceFields } from './fields.ts';
import { reserveWithGoogleRecord } from './reserve-with-google.ts';
import { normalizeVatNumber, vatNumberFilter } from './vat.ts';
import { versionOf } from './version.ts';

/** The two collections the service writes. */
export type EntityKind = 'companies' | 'places';

/** The outcome of a write: what happened, never an exception for an expected case. */
export type WriteOutcome =
  /** The document was created or changed: its id and its new version (of the whole stored document). */
  | { readonly outcome: 'written'; readonly id: ObjectId; readonly version: string }
  /** The document was deleted. */
  | { readonly outcome: 'deleted'; readonly id: ObjectId }
  /** The document does not exist in the group. Nothing was written. */
  | { readonly outcome: 'notFound' }
  /** The stored document has a version other than the expected one (someone else changed it). Nothing was written. */
  | { readonly outcome: 'conflict' }
  /** The `companyId` of a place does not name a company of the group that is not in the trash. Nothing was written. */
  | { readonly outcome: 'companyNotFound' }
  /** A deletion was asked for a document that is not in the trash. Nothing was written. */
  | { readonly outcome: 'notTrashed' }
  /** The VAT number of a company created or changed is already the number of another company of the group that is not in the trash. Nothing was written. */
  | { readonly outcome: 'vatNumberTaken' }
  /** A company in the trash cannot be deleted because a place of the group (trashed ones included) still refers to it. Nothing was written. */
  | { readonly outcome: 'referenced' };

/** Options of {@link companiesPlacesWriter}. */
export interface WriterOptions {
  /** Clock for `insertDate` and `updateDate`; the system clock by default. */
  readonly now?: () => Date;
  /** Largest number of places of a group that `groups.places[]` can be recalculated for ({@link MAX_GROUP_PLACES} by default). */
  readonly maxGroupPlaces?: number;
}

/**
 * Safety limit on the places of a group read to recalculate `groups.places[]` (the legacy shape is the whole list in the group document,
 * about 50 bytes per place). Above it the write fails and rolls back, instead of loading an unbounded set.
 */
export const MAX_GROUP_PLACES = 10_000;

/**
 * The write service of companies and places (`doc/Tasks.md` 5.6): the only writer of the `companies` and `places` of a group database
 * and of their copies in the common database. It has no HTTP routes of its own: the company routes (area 6) use it, and the place routes (area 7) will.
 *
 * Every operation runs in one transaction on the common cluster and, in this order: writes the group database in the legacy format, rereads
 * the whole document (with `EXACT_TYPES`), writes the copy in `common` with `replaceOne({ _id, groupId }, { ...document, groupId }, { upsert: true })`
 * (or removes it on delete), applies the side effects of places (`groups.places[]` recalculated in full; `reserve_with_google`) and always
 * sets `updateDate`. If anything fails nothing is written. The `groupId` and the ids come from the verified access, never from the input.
 *
 * Every write that changes an existing document takes the version the caller read (see {@link CompaniesPlacesWriter.currentVersion}). Inside the
 * transaction the document is read again: if its version differs the outcome is `conflict` and nothing is written. A write of the legacy
 * between the read and the write makes the transaction fail with a write conflict and is retried, so it is detected too. The legacy does not
 * check versions: the last writer wins on its side.
 */
export interface CompaniesPlacesWriter {
  /**
   * The current version of a document, to hand to the client as `ETag` before an update.
   *
   * @param kind `companies` or `places`.
   * @param id Id of the document.
   * @returns The version, or `null` when the document does not exist in the group.
   */
  currentVersion(kind: EntityKind, id: ObjectId): Promise<string | null>;
  /**
   * Reads a document of the group database as stored, with its version: the document with the exact BSON types (`EXACT_TYPES`: `Int32` and `Double`
   * wrappers instead of numbers), the version the same bytes give. It is the read of the detail routes, so the `ETag` they send is the version the next
   * write checks; it is not scoped (the caller applies the perimeter of the principal to the id first).
   *
   * @param kind `companies` or `places`.
   * @param id Id of the document.
   * @returns The document and its version, or `null` when the document does not exist in the group.
   */
  read(kind: EntityKind, id: ObjectId): Promise<{ readonly document: Document; readonly version: string } | null>;
  /**
   * Creates a company with the complete structure the legacy expects.
   *
   * @param fields The owned fields (the top-level ones and the dotted ones of the blocks); `name` is required.
   * @returns `written`, or `vatNumberTaken` when another company of the group that is not in the trash has the same normalized VAT number
   * (checked inside the transaction).
   * @throws {InvalidWriteInputError} If a field is not allowed, invalid or missing.
   * @throws {CrossClusterWriteError} If the group is not on the cluster of the common database.
   */
  createCompany(fields: NewCompanyFields): Promise<WriteOutcome>;
  /**
   * Creates a place with the complete structure the legacy expects and one storage, and recalculates `groups.places[]`.
   *
   * @param fields The owned fields; `name` and `companyId` are required.
   * @returns `written`, or `companyNotFound`.
   * @throws {InvalidWriteInputError} If a field is not allowed, invalid or missing.
   * @throws {CrossClusterWriteError} If the group is not on the cluster of the common database.
   */
  createPlace(fields: NewPlaceFields): Promise<WriteOutcome>;
  /**
   * Changes some owned fields of a company with `$set`, each on its own leaf path (a key of `settings.ecommerce`, one of `fattura_elettronica`…, a whole
   * array); nothing else of the document is written but `updateDate`, so the keys the service does not own survive. A block that is missing or empty
   * (`settings: {}`) is completed with the defaults of the keys the change does not set. The VAT number is checked when it changes.
   *
   * @param id Id of the company.
   * @param expectedVersion The version the caller read.
   * @param changes The fields to change, at least one.
   * @returns `written`, `notFound`, `conflict`, or `vatNumberTaken` when the new VAT number belongs to another company of the group that is not in the trash.
   * @throws {InvalidWriteInputError} If a field is not allowed or invalid, or there is none.
   * @throws {MalformedDocumentError} If a block the change writes into is not an object in the stored document.
   * @throws {CrossClusterWriteError} If the group is not on the cluster of the common database.
   */
  updateCompany(id: ObjectId, expectedVersion: string, changes: CompanyChanges): Promise<WriteOutcome>;
  /**
   * Changes some owned fields of a place with `$set` and recalculates `groups.places[]`. A new `companyId` must name a company of the group that
   * is not in the trash.
   *
   * @param id Id of the place.
   * @param expectedVersion The version the caller read.
   * @param changes The fields to change, at least one.
   * @returns `written`, `notFound`, `conflict` or `companyNotFound`.
   * @throws {InvalidWriteInputError} If a field is not allowed or invalid, or there is none.
   * @throws {CrossClusterWriteError} If the group is not on the cluster of the common database.
   */
  updatePlace(id: ObjectId, expectedVersion: string, changes: Partial<PlaceFields>): Promise<WriteOutcome>;
  /**
   * Moves a company or a place to the trash (`trash: true`). A place also leaves the Reserve with Google feed and `groups.places[]` is recalculated.
   * Nothing is cascaded: the places of a trashed company keep their reference.
   *
   * @param kind `companies` or `places`.
   * @param id Id of the document.
   * @param expectedVersion The version the caller read.
   * @returns `written`, `notFound` or `conflict`.
   * @throws {CrossClusterWriteError} If the group is not on the cluster of the common database.
   */
  trash(kind: EntityKind, id: ObjectId, expectedVersion: string): Promise<WriteOutcome>;
  /**
   * Takes a company or a place out of the trash (`trash: false`). A place goes back to the Reserve with Google feed only if its integration
   * is active and complete under the rule of the legacy; `groups.places[]` is recalculated.
   *
   * @param kind `companies` or `places`.
   * @param id Id of the document.
   * @param expectedVersion The version the caller read.
   * @returns `written`, `notFound`, `conflict`, or (companies) `vatNumberTaken` when another company of the group that is not in the trash now has its VAT number.
   * @throws {CrossClusterWriteError} If the group is not on the cluster of the common database.
   */
  restore(kind: EntityKind, id: ObjectId, expectedVersion: string): Promise<WriteOutcome>;
  /**
   * Deletes a company or a place that is in the trash, and its copy. A place also leaves the Reserve with Google feed and `groups.places[]` is
   * recalculated. Nothing is cascaded, so a company that a place of the group (trashed ones included) still refers to is not deleted.
   *
   * @param kind `companies` or `places`.
   * @param id Id of the document.
   * @param expectedVersion The version the caller read.
   * @returns `deleted`, `notFound`, `conflict`, `notTrashed`, or `referenced` (a company with places).
   * @throws {CrossClusterWriteError} If the group is not on the cluster of the common database.
   */
  deleteTrashed(kind: EntityKind, id: ObjectId, expectedVersion: string): Promise<WriteOutcome>;
}

/** The result of the version check: the document as stored, or the outcome that stops the write. */
type Gate = { readonly current: Document } | { readonly stop: WriteOutcome };

const NOT_FOUND = Object.freeze({ outcome: 'notFound' }) satisfies WriteOutcome;
const CONFLICT = Object.freeze({ outcome: 'conflict' }) satisfies WriteOutcome;
const COMPANY_NOT_FOUND = Object.freeze({ outcome: 'companyNotFound' }) satisfies WriteOutcome;
const NOT_TRASHED = Object.freeze({ outcome: 'notTrashed' }) satisfies WriteOutcome;
const VAT_TAKEN = Object.freeze({ outcome: 'vatNumberTaken' }) satisfies WriteOutcome;
const REFERENCED = Object.freeze({ outcome: 'referenced' }) satisfies WriteOutcome;

/** The container (`settings.global`, `fattura_elettronica`…) a leaf path belongs to, `undefined` for a top-level field. */
const containerOf = (path: string): string | undefined => Object.keys(COMPANY_CONTAINERS).find((container) => path.startsWith(`${container}.`));

/**
 * The leaves a write adds so that no block of the stored company stays half built: for every block the change writes into, when it is missing
 * or empty, the default of each of its keys the change does not set. A block that already has keys is left as it is (a legacy company may lack
 * some, and the legacy wrote it so), and a block that is not an object (also any parent of it) is refused.
 *
 * @param current The stored document.
 * @param set The leaves the change sets.
 * @returns The extra leaves to `$set`.
 * @throws {MalformedDocumentError} If a block, or a parent of it, is stored as something that is not an object.
 */
function completionOf(current: Document, set: Document): Document {
  const extra: Document = {};
  for (const container of new Set(Object.keys(set).map(containerOf))) {
    if (container === undefined) {
      continue;
    }
    let value: unknown = current;
    let path = '';
    let present = true;
    for (const step of container.split('.')) {
      path = path === '' ? step : `${path}.${step}`;
      const holder = value as Document;
      if (!Object.hasOwn(holder, step)) {
        present = false;
        break;
      }
      value = holder[step];
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new MalformedDocumentError(path);
      }
    }
    if (!present || Object.keys(value as Document).length === 0) {
      for (const [key, fallback] of Object.entries(companyContainerDefaults(container))) {
        const leaf = `${container}.${key}`;
        if (!Object.hasOwn(set, leaf)) {
          extra[leaf] = fallback;
        }
      }
    }
  }
  return extra;
}

/**
 * Opens the write service for a group the caller was verified to reach. The access is checked again against the principal (it must have been
 * issued by `requireGroupAccess`): the group database is opened from it and the `groupId` of every write is `access.groupId`.
 *
 * @param principal The authenticated caller.
 * @param access A verified group access.
 * @param databases Database accessor.
 * @param options Clock and limit.
 * @returns The service.
 * @throws {Error} If the access was not issued by `requireGroupAccess` or does not belong to the principal.
 * @throws {UnknownClusterError} If the cluster of the access is not configured.
 */
export function companiesPlacesWriter(principal: AuthPrincipal, access: GroupAccess, databases: Databases, options: WriterOptions = {}): CompaniesPlacesWriter {
  const groupDb = groupDatabaseFor(principal, access, databases);
  const groupId = access.groupId;
  const clock = options.now ?? (() => new Date());
  const maxPlaces = options.maxGroupPlaces ?? MAX_GROUP_PLACES;
  // Literal names: the collection registry check requires every collection name to be a string literal.
  const original = (kind: EntityKind): Collection<Document> => {
    checkKind(kind);
    return kind === 'companies' ? groupDb.collection('companies') : groupDb.collection('places');
  };
  const copy = (kind: EntityKind): Collection<Document> => (kind === 'companies' ? databases.common().collection('companies') : databases.common().collection('places'));

  /** Runs `work` in a transaction on the common cluster, after refusing a group that is on another cluster (no half writes). */
  const run = async (work: (session: ClientSession) => Promise<WriteOutcome>): Promise<WriteOutcome> => {
    if (access.clusterId !== databases.commonCluster) {
      throw new CrossClusterWriteError(groupId, access.clusterId, databases.commonCluster);
    }
    return databases.transaction(work);
  };

  /** Reads the whole document as stored (exact BSON types), inside the transaction. */
  const reread = (kind: EntityKind, id: ObjectId, session: ClientSession): Promise<Document | null> => original(kind).findOne({ _id: id }, { ...EXACT_TYPES, session });

  /** Reads the document and checks its version: the document, or the outcome that stops the write. */
  const gate = async (kind: EntityKind, id: ObjectId, expected: string, session: ClientSession): Promise<Gate> => {
    const current = await reread(kind, id, session);
    if (current === null) {
      return { stop: NOT_FOUND };
    }
    return versionOf(kind, current) === expected ? { current } : { stop: CONFLICT };
  };

  /** Rereads the document written and writes its copy: the version of the document is what the caller gets back. */
  const mirror = async (kind: EntityKind, id: ObjectId, session: ClientSession): Promise<WriteOutcome> => {
    const document = await reread(kind, id, session);
    if (document === null) {
      throw new Error('The document just written cannot be read back inside the transaction');
    }
    await copy(kind).replaceOne({ _id: id, groupId }, expectedCopy(document, groupId), { upsert: true, session });
    return { outcome: 'written', id, version: versionOf(kind, document) };
  };

  /** `groups.places[]`: the full list `[{ _id, insertDate }]` of the places of the group database, trashed ones included, written with `$set`. */
  const recalculatePlaces = async (session: ClientSession): Promise<void> => {
    const places = await original('places').find({}, { projection: { insertDate: 1 }, sort: { _id: 1 }, limit: maxPlaces + 1, session }).toArray();
    if (places.length > maxPlaces) {
      throw new Error('Too many places in the group to recalculate groups.places');
    }
    const result = await databases.common().collection('groups').updateOne({ _id: groupId }, { $set: { places } }, { session });
    if (result.matchedCount === 0) {
      throw new Error('The group document does not exist');
    }
  };

  /** Removes the place from the Reserve with Google feed. */
  const leaveFeed = async (id: ObjectId, session: ClientSession): Promise<void> => {
    await databases.common().collection('reserve_with_google').deleteOne({ groupId, placeId: id }, { session });
  };

  /** Puts the place back in the feed when its integration is active and complete; otherwise does nothing. */
  const rejoinFeed = async (id: ObjectId, session: ClientSession): Promise<void> => {
    const place = await original('places').findOne({ _id: id }, { projection: { companyId: 1, 'integrations.reserveWithGoogle': 1 }, session });
    const record = reserveWithGoogleRecord(place, groupId);
    if (record !== null) {
      await databases.common().collection('reserve_with_google').updateOne({ groupId, placeId: id }, { $set: record }, { upsert: true, session });
    }
  };

  /** Whether another company of the group that is not in the trash has the same normalized VAT number (`except` is the company being written). */
  const vatNumberTaken = async (code: string, except: ObjectId, session: ClientSession): Promise<boolean> => {
    const normalized = normalizeVatNumber(code);
    if (normalized === '') {
      return false;
    }
    const other = await original('companies').findOne({ _id: { $ne: except }, trash: { $ne: true }, ...vatNumberFilter(normalized) }, { projection: { _id: 1 }, session });
    return other !== null;
  };

  /** Whether a company of the group exists and is not in the trash. */
  const companyIsUsable = async (companyId: ObjectId, session: ClientSession): Promise<boolean> =>
    (await original('companies').findOne({ _id: companyId, trash: { $ne: true } }, { projection: { _id: 1 }, session })) !== null;

  /** The shared body of update, trash and restore: gate, `$set`, copy and, for places, the side effects. */
  const change = (kind: EntityKind, id: ObjectId, expected: string, set: Document, effect: (session: ClientSession) => Promise<void>, uses?: ObjectId): Promise<WriteOutcome> =>
    run(async (session) => {
      const passed = await gate(kind, checkObjectId(id, 'id'), expected, session);
      if ('stop' in passed) {
        return passed.stop;
      }
      if (uses !== undefined && !(await companyIsUsable(uses, session))) {
        return COMPANY_NOT_FOUND;
      }
      await original(kind).updateOne({ _id: id }, { $set: { ...set, updateDate: clock() } }, { session });
      const written = await mirror(kind, id, session);
      await effect(session);
      return written;
    });
  const none = async (): Promise<void> => undefined;
  const placeEffects = async (session: ClientSession, feed: (() => Promise<void>) | null): Promise<void> => {
    if (feed !== null) {
      await feed();
    }
    await recalculatePlaces(session);
  };

  return {
    currentVersion: async (kind, id) => {
      const document = await original(kind).findOne({ _id: checkObjectId(id, 'id') }, { ...EXACT_TYPES });
      return document === null ? null : versionOf(kind, document);
    },

    read: async (kind, id) => {
      checkObjectId(id, 'id');
      // The perimeter of the caller is applied here, so no caller can get a document outside it.
      if (kind === 'companies' && !companyInScope(principal.scope, id)) {
        return null;
      }
      const document = await original(kind).findOne({ _id: id }, { ...EXACT_TYPES });
      if (document === null || (kind === 'places' && !placeInScope(principal.scope, id, document['companyId']))) {
        return null;
      }
      return { document, version: versionOf(kind, document) };
    },

    createCompany: async (fields) => {
      const id = new ObjectId();
      const document = newCompanyDocument(id, groupId, fields, clock());
      return run(async (session) => {
        if (await vatNumberTaken(document['code'] as string, id, session)) {
          return VAT_TAKEN;
        }
        await original('companies').insertOne(document, { session });
        return mirror('companies', id, session);
      });
    },

    createPlace: async (fields) => {
      const id = new ObjectId();
      const document = newPlaceDocument(id, groupId, fields, clock());
      return run(async (session) => {
        if (!(await companyIsUsable(document['companyId'] as ObjectId, session))) {
          return COMPANY_NOT_FOUND;
        }
        await original('places').insertOne(document, { session });
        const written = await mirror('places', id, session);
        await recalculatePlaces(session);
        return written;
      });
    },

    updateCompany: async (id, expected, changes) => {
      const set = checkChanges(COMPANY_FIELD_KINDS, changes);
      return run(async (session) => {
        const passed = await gate('companies', checkObjectId(id, 'id'), expected, session);
        if ('stop' in passed) {
          return passed.stop;
        }
        if (Object.hasOwn(set, 'code') && (await vatNumberTaken(set['code'] as string, id, session))) {
          return VAT_TAKEN;
        }
        await original('companies').updateOne({ _id: id }, { $set: { ...set, ...completionOf(passed.current, set), updateDate: clock() } }, { session });
        return mirror('companies', id, session);
      });
    },

    updatePlace: async (id, expected, changes) => {
      const set = checkChanges(PLACE_FIELD_KINDS, changes);
      return change('places', id, expected, set, (session) => placeEffects(session, null), set['companyId'] as ObjectId | undefined);
    },

    trash: (kind, id, expected) =>
      change(kind, id, expected, { trash: true }, kind === 'places' ? (session) => placeEffects(session, () => leaveFeed(id, session)) : none),

    restore: (kind, id, expected) =>
      kind === 'companies'
        ? run(async (session) => {
            const passed = await gate(kind, checkObjectId(id, 'id'), expected, session);
            if ('stop' in passed) {
              return passed.stop;
            }
            // While it was in the trash another company may have taken its VAT number.
            if (typeof passed.current['code'] === 'string' && (await vatNumberTaken(passed.current['code'], id, session))) {
              return VAT_TAKEN;
            }
            await original(kind).updateOne({ _id: id }, { $set: { trash: false, updateDate: clock() } }, { session });
            return mirror(kind, id, session);
          })
        : change(kind, id, expected, { trash: false }, (session) => placeEffects(session, () => rejoinFeed(id, session))),

    deleteTrashed: (kind, id, expected) =>
      run(async (session) => {
        const passed = await gate(kind, checkObjectId(id, 'id'), expected, session);
        if ('stop' in passed) {
          return passed.stop;
        }
        if (passed.current['trash'] !== true) {
          return NOT_TRASHED;
        }
        if (kind === 'companies' && (await original('places').findOne({ companyId: { $in: [id, id.toHexString()] } }, { projection: { _id: 1 }, session })) !== null) {
          return REFERENCED;
        }
        await original(kind).deleteOne({ _id: id }, { session });
        await copy(kind).deleteOne({ _id: id, groupId }, { session });
        if (kind === 'places') {
          await placeEffects(session, () => leaveFeed(id, session));
        }
        return { outcome: 'deleted', id };
      }),
  };
}

/**
 * @param kind Value to check.
 * @throws {InvalidWriteInputError} If it is not one of the two collections.
 */
function checkKind(kind: unknown): asserts kind is EntityKind {
  if (kind !== 'companies' && kind !== 'places') {
    throw new InvalidWriteInputError('Not a collection the service writes', 'kind');
  }
}
