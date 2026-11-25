import { ObjectId } from 'mongodb';
import type { ClientSession, Collection, Db, Document } from 'mongodb';
import type { Databases } from '../../db/databases.ts';
import { groupCreationDatabase, groupDatabaseFor } from '../security/scope/group-access.ts';
import type { GroupAccess } from '../security/scope/group-access.ts';
import type { AuthPrincipal, ScopeHolder } from '../security/scope/principal.ts';
import { companyInScope, placeInScope } from '../security/scope/scope-filters.ts';
import { EXACT_TYPES, expectedCopy } from './copy-rule.ts';
import { COMPANY_CONTAINERS } from './company-paths.ts';
import { companyContainerDefaults, newCompanyDocument, newPlaceDocument, placeContainerDefaults } from './defaults.ts';
import { CrossClusterWriteError, InvalidWriteInputError, MalformedDocumentError } from './errors.ts';
import { COMPANY_FIELD_KINDS, PLACE_FIELD_KINDS, checkChanges, checkObjectId, checkUnset } from './fields.ts';
import type { CompanyChanges, NewCompanyFields, NewPlaceFields, PlaceChanges } from './fields.ts';
import { PLACE_LISTS, isEditable, itemKey, mergeList } from './place-lists.ts';
import type { ListDef } from './place-lists.ts';
import { PLACE_CONTAINERS } from './place-paths.ts';
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
  | { readonly outcome: 'referenced' }
  /** A place in the trash cannot be duplicated. Nothing was written. */
  | { readonly outcome: 'trashed' }
  /** A device the POS says is busy (read inside the transaction) would be removed by a write of the devices. Nothing was written. */
  | { readonly outcome: 'busy' };

/** What the places need to know of the company they belong to: whether it is in the trash and the names of its invoice series (`invoicesPSValues`). */
export interface CompanyOfPlace {
  readonly trashed: boolean;
  readonly invoiceSeries: readonly string[];
  /** The same series with their `cash` flag (`true` only when the stored flag is exactly `true`), in the stored order. */
  readonly series: readonly { readonly name: string; readonly cash: boolean }[];
}

/** Options of {@link companiesPlacesWriter}. */
export interface WriterOptions {
  /** Clock for `insertDate` and `updateDate`; the system clock by default. */
  readonly now?: () => Date;
  /** Key of the HMAC that signs the versions (`VERSION_HMAC_KEY`, decoded). */
  readonly versionKey: Buffer;
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
 * and of their copies in the common database. It has no HTTP routes of its own: the company routes (area 6) and the place routes (area 7) use it.
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
   * write checks; the perimeter of the principal is applied here (a document outside it is `null`, like one that does not exist).
   *
   * @param kind `companies` or `places`.
   * @param id Id of the document.
   * @returns The document and its version, or `null` when the document does not exist in the group.
   */
  read(kind: EntityKind, id: ObjectId): Promise<{ readonly document: Document; readonly version: string } | null>;
  /**
   * What the places need of a company of the group, read from the group database, not limited to the perimeter of the caller (the caller must have judged the company already, and never asks for one it rejected): the invoice series
   * of the company a place chooses from, and whether the company is in the trash. Only these two values are ever read.
   *
   * @param id Id of the company.
   * @returns The data, or `null` when the company does not exist in the group.
   */
  companyOfPlace(id: ObjectId): Promise<CompanyOfPlace | null>;
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
   * Creates a place with the complete structure the old backoffice saves (every block with its defaults) and one storage, and recalculates `groups.places[]`.
   *
   * @param fields The owned fields (the top-level ones and the dotted ones of the blocks); `name` and `companyId` are required.
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
   * Changes some owned fields of a place with `$set`, each on its own leaf path (the top-level ones, `general.priceLists`, the opening and delivery hours, the settings, `integrations.*`, `server.ip`, `connectorAddress`), and
   * recalculates `groups.places[]`; nothing else of the document is written but `updateDate`, so what the POS writes (`devices[i].info`, `suspendedToday`…) and every key the service does not
   * own survive. A list of items (`devices`, `printStations`, `productionCenter`, `rooms`, `storages`) is given as the fragments of its items and merged over the stored items inside the
   * transaction (`mergeList`), so the keys a fragment does not carry, those of the POS included, are the ones the transaction reads. When a key of `integrations.reserveWithGoogle` or the company
   * changes, the Reserve with Google feed is brought in line with the place in the same transaction. A block that is missing or empty is completed with the defaults of the keys the change does not set. A new `companyId` must name a company
   * of the group that is not in the trash.
   *
   * @param id Id of the place.
   * @param expectedVersion The version the caller read.
   * @param changes The fields to change, at least one.
   * @param unset The stored paths to remove in the same write (`$unset`), only the ones of `UNSETTABLE_PATHS` (the activation code of Satispay an old place may still hold), none of them also in `changes`.
   * @returns `written`, `notFound`, `conflict` or `companyNotFound`.
   * @throws {InvalidWriteInputError} If a field is not allowed or invalid, or there is none, or a path to remove is not removable.
   * @throws {MalformedDocumentError} If a block the change writes into is not an object in the stored document.
   * @throws {CrossClusterWriteError} If the group is not on the cluster of the common database.
   */
  updatePlace(id: ObjectId, expectedVersion: string, changes: PlaceChanges, unset?: readonly string[]): Promise<WriteOutcome>;
  /**
   * Duplicates a place: everything of the stored document is replicated (every key, the devices, the rooms, the storages with the same ids, the integrations and the keys the backend
   * does not know), with a new `_id`, `insertDate` and `updateDate` now, `trash: false`, the `groupId` of the verified access and the name of the legacy duplicate (`<name> (Copy)`). In one
   * transaction: the insert, its copy in the common database, the Reserve with Google feed (as the legacy insert, only if the integration is active and complete) and `groups.places[]`.
   * The result of the write never carries a credential: it is the id and the version.
   *
   * @param id Id of the place to duplicate.
   * @returns `written` (with the id of the new place), `notFound`, `trashed` (a place in the trash is not duplicated) or `companyNotFound` (its company does not exist or is in the trash).
   * @throws {CrossClusterWriteError} If the group is not on the cluster of the common database.
   */
  duplicatePlace(id: ObjectId): Promise<WriteOutcome>;
  /**
   * Moves a company or a place to the trash (`trash: true`, with `trashDate` set to the time of the write). A place also leaves the Reserve with Google feed and `groups.places[]` is recalculated.
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
   * Takes a company or a place out of the trash (`trash: false`, `trashDate` removed). A place goes back to the Reserve with Google feed only if its integration
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

/**
 * The lists of items a change writes, merged item by item over the stored ones (`mergeList`): what the change carries for a list are fragments, and the stored document is the one read
 * inside the transaction, so what the POS wrote in the meantime is in the result. Every other value is written as it is.
 *
 * @param current The stored document.
 * @param set The leaves the change sets.
 * @returns The leaves to `$set`, the lists merged; `null` when a busy device would be removed.
 * @throws {MalformedDocumentError} If a list the change writes is stored as something that is not an array, or has an item without an id.
 */
function mergeLists(current: Document, set: Document): Document | null {
  const written: Document = { ...set };
  for (const list of Object.values(PLACE_LISTS) as ListDef[]) {
    if (Object.hasOwn(set, list.path)) {
      const stored: unknown = current[list.path];
      // A list with an item that has no id is not written: the write would lose it.
      if ((stored !== undefined && !Array.isArray(stored)) || !isEditable(list, stored, list.idKey)) {
        throw new MalformedDocumentError(list.path);
      }
      const merged = mergeList(stored, set[list.path] as Document[], list, list.idKey);
      // A device the POS marks busy is not removed: checked here, on the document read inside the transaction (the `status` is the POS's and is not part of the version).
      if (list.path === 'devices' && (Array.isArray(stored) ? (stored as Document[]) : []).some((device) => (device['status'] as Document | undefined)?.['busy'] === true && !merged.some((kept) => itemKey(kept) === itemKey(device)))) {
        return null;
      }
      written[list.path] = merged;
    }
  }
  return written;
}

/** The result of the version check: the document as stored, or the outcome that stops the write. */
type Gate = { readonly current: Document } | { readonly stop: WriteOutcome };

/**
 * The `integrations` of a place for its copy: the same, without the activation code of Satispay an old place may still hold. The code is single use and secret, and the copy is a new place that never
 * received one, so it is the one thing of the integrations that is not copied. Everything else (the other keys, their order, the type of every value) is untouched.
 *
 * @param integrations The `integrations` of the source place, of any type.
 * @returns The same value when there is no code to remove, a copy of it without the code otherwise.
 */
function withoutActivationCode(integrations: unknown): unknown {
  const satispay = (integrations as { satispay?: unknown } | null | undefined)?.satispay;
  if (typeof satispay !== 'object' || satispay === null || !Object.hasOwn(satispay, 'activationCode')) {
    return integrations;
  }
  const { activationCode: _removed, ...rest } = satispay as Document;
  return { ...(integrations as Document), satispay: rest };
}

const NOT_FOUND = Object.freeze({ outcome: 'notFound' }) satisfies WriteOutcome;
const CONFLICT = Object.freeze({ outcome: 'conflict' }) satisfies WriteOutcome;
const COMPANY_NOT_FOUND = Object.freeze({ outcome: 'companyNotFound' }) satisfies WriteOutcome;
const NOT_TRASHED = Object.freeze({ outcome: 'notTrashed' }) satisfies WriteOutcome;
const VAT_TAKEN = Object.freeze({ outcome: 'vatNumberTaken' }) satisfies WriteOutcome;
const REFERENCED = Object.freeze({ outcome: 'referenced' }) satisfies WriteOutcome;
const TRASHED = Object.freeze({ outcome: 'trashed' }) satisfies WriteOutcome;
const BUSY = Object.freeze({ outcome: 'busy' }) satisfies WriteOutcome;

/**
 * The leaves a write adds so that no block of the stored document stays half built: for every container the change writes into, when it is missing
 * or empty, the default of each of its keys the change does not set (nor sets anything below). A block that already has keys is left as it is (a legacy document may lack
 * some, and the legacy wrote it so), and a block that is not an object (also any parent of it) is refused.
 *
 * @param current The stored document.
 * @param set The leaves the change sets.
 * @param containers The containers that hold owned leaves, outermost first.
 * @param defaultsOf The default value of every key of a container.
 * @returns The extra leaves to `$set`.
 * @throws {MalformedDocumentError} If a block, or a parent of it, is stored as something that is not an object.
 */
function completionOf(current: Document, set: Document, containers: readonly string[], defaultsOf: (container: string) => Document): Document {
  const extra: Document = {};
  const paths = Object.keys(set);
  for (const container of containers) {
    if (!paths.some((path) => path.startsWith(`${container}.`))) {
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
      for (const [key, fallback] of Object.entries(defaultsOf(container))) {
        const leaf = `${container}.${key}`;
        if (!paths.some((other) => other === leaf || other.startsWith(`${leaf}.`))) {
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
 * @param options The key of the versions, the clock and the limit.
 * @returns The service.
 * @throws {Error} If the access was not issued by `requireGroupAccess` or does not belong to the principal.
 * @throws {UnknownClusterError} If the cluster of the access is not configured.
 */
export function companiesPlacesWriter(principal: AuthPrincipal, access: GroupAccess, databases: Databases, options: WriterOptions): CompaniesPlacesWriter {
  return createWriter(principal, groupDatabaseFor(principal, access, databases), access, databases, options).writer;
}

/**
 * Opens the read of companies and places for any caller with a perimeter, a backoffice user or the server of a store (its perimeter is its own place). Only `read` is exposed:
 * the type of {@link companiesPlacesWriter} keeps a store out of every write.
 *
 * @param principal The caller.
 * @param access A verified group access.
 * @param databases Database accessor.
 */
export function companiesPlacesReader(principal: ScopeHolder, access: GroupAccess, databases: Databases, options: Pick<WriterOptions, 'versionKey'>): Pick<CompaniesPlacesWriter, 'read'> {
  const { read } = createWriter(principal, groupDatabaseFor(principal, access, databases), access, databases, options).writer;
  return { read };
}

/**
 * A step of the creation of a customer: it runs inside the transaction of the caller, with the session of that transaction, and writes nothing outside it.
 * The outcome is the one of {@link CompaniesPlacesWriter.createCompany} and {@link CompaniesPlacesWriter.createPlace}.
 */
export type CreationStep = (session: ClientSession) => Promise<WriteOutcome>;

/** The first company and the first place of a group that is being created (`doc/Tasks.md` area 8), as steps of the transaction that creates the group. */
export interface GroupCreationWriter {
  /**
   * The creation of the first company, with the same document, check and copy as {@link CompaniesPlacesWriter.createCompany}, in the transaction of the caller.
   *
   * @param fields The owned fields of the company: `name` is required.
   * @returns The step to run in the transaction.
   * @throws {InvalidWriteInputError} If a field is not allowed, invalid or missing (before any write).
   */
  insertCompany(fields: NewCompanyFields): CreationStep;
  /**
   * The creation of the first place, with the same document, check, copy and `groups.places[]` as {@link CompaniesPlacesWriter.createPlace}, in the transaction of the caller.
   * The group document must already be written in the same transaction.
   *
   * @param fields The owned fields of the place: `name` and `companyId` are required.
   * @returns The step to run in the transaction.
   * @throws {InvalidWriteInputError} If a field is not allowed, invalid or missing (before any write).
   */
  insertPlace(fields: NewPlaceFields): CreationStep;
}

/**
 * Opens the creation steps of the first company and place of a group that does not exist yet, from the access {@link issueGroupCreationAccess} gave to this caller. It is not a
 * way to write into a group that exists: the access is refused by every other opener, and this one takes only that kind of access.
 *
 * @param principal The authenticated caller the creation access was issued to.
 * @param access The creation access.
 * @param databases Database accessor.
 * @param options The key of the versions, the clock and the limit.
 * @returns The steps.
 * @throws {Error} If the access is not a creation access of this caller.
 */
export function groupCreationWriter(principal: AuthPrincipal, access: GroupAccess, databases: Databases, options: WriterOptions): GroupCreationWriter {
  const { insertCompany, insertPlace } = createWriter(principal, groupCreationDatabase(principal, access, databases), access, databases, options);
  return { insertCompany, insertPlace };
}

function createWriter(principal: ScopeHolder, groupDb: Db, access: GroupAccess, databases: Databases, options: WriterOptions): { readonly writer: CompaniesPlacesWriter } & GroupCreationWriter {
  const groupId = access.groupId;
  const versionKey = options.versionKey;
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

  /** Whether a document is inside the perimeter of the principal (a company administrator reaches his companies and their places, a place administrator his own). */
  const inPerimeter = (kind: EntityKind, id: ObjectId, document: Document): boolean =>
    kind === 'companies' ? companyInScope(principal.scope, id) : placeInScope(principal.scope, id, document['companyId']);

  /** Reads the document and checks its version: the document, or the outcome that stops the write. */
  const gate = async (kind: EntityKind, id: ObjectId, expected: string, session: ClientSession): Promise<Gate> => {
    const current = await reread(kind, id, session);
    // The perimeter of the caller is applied to every write as it is to the read: a document outside it does not exist.
    if (current === null || !inPerimeter(kind, id, current)) {
      return { stop: NOT_FOUND };
    }
    return versionOf(kind, current, versionKey) === expected ? { current } : { stop: CONFLICT };
  };

  /** Rereads the document written and writes its copy: the version of the document is what the caller gets back. */
  const mirror = async (kind: EntityKind, id: ObjectId, session: ClientSession): Promise<WriteOutcome> => {
    const document = await reread(kind, id, session);
    if (document === null) {
      throw new Error('The document just written cannot be read back inside the transaction');
    }
    await copy(kind).replaceOne({ _id: id, groupId }, expectedCopy(document, groupId), { upsert: true, session });
    return { outcome: 'written', id, version: versionOf(kind, document, versionKey) };
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

  /**
   * Brings the Reserve with Google feed in line with the place as it is now (the legacy update): the record is written when the integration is active and complete, and the place is
   * not in the trash; in any other case the record is removed, so the feed never holds a stale one.
   */
  const syncFeed = async (id: ObjectId, session: ClientSession): Promise<void> => {
    const place = await original('places').findOne({ _id: id }, { projection: { companyId: 1, trash: 1, 'integrations.reserveWithGoogle': 1 }, session });
    const record = place === null || place['trash'] === true ? null : reserveWithGoogleRecord(place, groupId);
    if (record === null) {
      await leaveFeed(id, session);
    } else {
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
  const change = (
    kind: EntityKind,
    id: ObjectId,
    expected: string,
    set: Document,
    effect: (session: ClientSession) => Promise<void>,
    uses?: ObjectId,
    trashing?: boolean,
    unset: readonly string[] = [],
  ): Promise<WriteOutcome> =>
    run(async (session) => {
      const passed = await gate(kind, checkObjectId(id, 'id'), expected, session);
      if ('stop' in passed) {
        return passed.stop;
      }
      if (uses !== undefined && !(await companyIsUsable(uses, session))) {
        return COMPANY_NOT_FOUND;
      }
      // Only a place has leaves below blocks and lists of items (a trash or a restore sets `trash` alone).
      const completion = kind === 'places' ? completionOf(passed.current, set, PLACE_CONTAINERS, placeContainerDefaults) : {};
      const written = kind === 'places' ? mergeLists(passed.current, set) : set;
      if (written === null) {
        return BUSY;
      }
      const now = clock();
      // The informational date of the trash is written with the flag, in the same update, and removed with it when the item comes back.
      await original(kind).updateOne(
        { _id: id },
        {
          $set: { ...written, ...completion, ...(trashing === true ? { trashDate: now } : {}), updateDate: now },
          ...(trashing === false || unset.length > 0 ? { $unset: { ...(trashing === false ? { trashDate: '' } : {}), ...Object.fromEntries(unset.map((path) => [path, ''])) } } : {}),
        },
        { session },
      );
      const outcome = await mirror(kind, id, session);
      await effect(session);
      return outcome;
    });
  const none = async (): Promise<void> => undefined;
  /** The creation of a company, as a step of a transaction: the document is built (and the input checked) here, before the transaction starts. */
  const insertCompany = (fields: NewCompanyFields): CreationStep => {
    const id = new ObjectId();
    const document = newCompanyDocument(id, groupId, fields, clock());
    return async (session) => {
      if (await vatNumberTaken(document['code'] as string, id, session)) {
        return VAT_TAKEN;
      }
      await original('companies').insertOne(document, { session });
      return mirror('companies', id, session);
    };
  };
  /** The creation of a place, as a step of a transaction. */
  const insertPlace = (fields: NewPlaceFields): CreationStep => {
    const id = new ObjectId();
    const document = newPlaceDocument(id, groupId, fields, clock());
    return async (session) => {
      if (!(await companyIsUsable(document['companyId'] as ObjectId, session))) {
        return COMPANY_NOT_FOUND;
      }
      await original('places').insertOne(document, { session });
      const written = await mirror('places', id, session);
      await recalculatePlaces(session);
      return written;
    };
  };
  const placeEffects = async (session: ClientSession, feed: (() => Promise<void>) | null): Promise<void> => {
    if (feed !== null) {
      await feed();
    }
    await recalculatePlaces(session);
  };

  const writer: CompaniesPlacesWriter = {
    currentVersion: async (kind, id) => {
      const document = await original(kind).findOne({ _id: checkObjectId(id, 'id') }, { ...EXACT_TYPES });
      return document === null ? null : versionOf(kind, document, versionKey);
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
      return { document, version: versionOf(kind, document, versionKey) };
    },

    companyOfPlace: async (id) => {
      const company = await original('companies').findOne({ _id: checkObjectId(id, 'id') }, { projection: { trash: 1, invoicesPSValues: 1 } });
      if (company === null) {
        return null;
      }
      const series: unknown = company['invoicesPSValues'];
      const list = (Array.isArray(series) ? (series as unknown[]) : []).flatMap((item) =>
        typeof item === 'object' && item !== null && typeof (item as Document)['name'] === 'string' ? [{ name: (item as Document)['name'] as string, cash: (item as Document)['cash'] === true }] : [],
      );
      return { trashed: company['trash'] === true, invoiceSeries: list.map((entry) => entry.name), series: list };
    },

    createCompany: async (fields) => run(insertCompany(fields)),

    createPlace: async (fields) => run(insertPlace(fields)),

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
        await original('companies').updateOne({ _id: id }, { $set: { ...set, ...completionOf(passed.current, set, Object.keys(COMPANY_CONTAINERS), companyContainerDefaults), updateDate: clock() } }, { session });
        return mirror('companies', id, session);
      });
    },

    updatePlace: async (id, expected, changes, unset = []) => {
      const set = checkChanges(PLACE_FIELD_KINDS, changes);
      const removed = checkUnset(unset, set);
      // The feed carries the company and the Reserve with Google data of the place: it follows a change of either.
      const feeds = Object.keys(set).some((path) => path === 'companyId' || path.startsWith('integrations.reserveWithGoogle.'));
      return change('places', id, expected, set, (session) => placeEffects(session, feeds ? () => syncFeed(id, session) : null), set['companyId'] as ObjectId | undefined, undefined, removed);
    },

    duplicatePlace: async (id) => {
      const copyId = new ObjectId();
      return run(async (session) => {
        const source = await reread('places', checkObjectId(id, 'id'), session);
        if (source === null || !inPerimeter('places', id, source)) {
          return NOT_FOUND;
        }
        if (source['trash'] === true) {
          return TRASHED;
        }
        if (!(source['companyId'] instanceof ObjectId) || !(await companyIsUsable(source['companyId'], session))) {
          return COMPANY_NOT_FOUND;
        }
        const now = clock();
        // Everything of the source, key by key and in its order; only these keys differ.
        const document: Document = {
          ...source,
          _id: copyId,
          groupId,
          name: typeof source['name'] === 'string' ? `${source['name']} (Copy)` : '(Copy)',
          trash: false,
          insertDate: now,
          updateDate: now,
          ...(Object.hasOwn(source, 'integrations') ? { integrations: withoutActivationCode(source['integrations']) } : {}),
        };
        await original('places').insertOne(document, { session });
        const written = await mirror('places', copyId, session);
        await placeEffects(session, () => rejoinFeed(copyId, session));
        return written;
      });
    },

    trash: (kind, id, expected) =>
      change(kind, id, expected, { trash: true }, kind === 'places' ? (session) => placeEffects(session, () => leaveFeed(id, session)) : none, undefined, true),

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
            await original(kind).updateOne({ _id: id }, { $set: { trash: false, updateDate: clock() }, $unset: { trashDate: '' } }, { session });
            return mirror(kind, id, session);
          })
        : change(kind, id, expected, { trash: false }, (session) => placeEffects(session, () => rejoinFeed(id, session)), undefined, false),

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
  return { writer, insertCompany, insertPlace };
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
