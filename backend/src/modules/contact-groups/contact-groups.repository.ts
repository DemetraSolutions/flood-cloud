import type { Document, Filter, ObjectId } from 'mongodb';
import { CONTACTS_GROUPS_OWNED_FIELDS } from '../../db/collections.ts';
import type { Databases } from '../../db/databases.ts';
import { LIST_MAX_TIME_MS, listPipeline, pageOf } from '../../shared/http/list.ts';
import type { ListPage, ListParams } from '../../shared/http/list.ts';
import { bounded } from '../../shared/security/scope/bounded.ts';
import { groupDatabaseFor } from '../../shared/security/scope/group-access.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { ScopeHolder } from '../../shared/security/scope/principal.ts';
import { entityProjection, sameAs } from '../product-catalog/entity.repository.ts';
import { MAX_REPORTED_REFERENCES, REFERENCE_MAX_TIME_MS, promotionsNaming } from '../contacts/contacts.repository.ts';
import { CONTACT_GROUPS_LIST } from './contact-groups.schemas.ts';

/** The most contacts the count of a group of contacts counts: a larger group shows this number. */
export const MAX_CONTACTS_COUNT = 10_000;

const PROJECTION = entityProjection(CONTACTS_GROUPS_OWNED_FIELDS);

/** What a modification of a group of contacts changes. */
export interface ContactGroupChange {
  readonly set: Document;
  readonly updateDate: Date;
  /** What the document had at each path of `set` when it was read (`undefined` when it had nothing). */
  readonly readValues: Readonly<Record<string, unknown>>;
}

/** The `contacts_groups` collection of a group database, as seen by a caller. */
export interface ContactGroupsRepository {
  /** A page of the groups of contacts, by the filter of the request. */
  list(principal: ScopeHolder, access: GroupAccess, filter: Filter<Document>, params: ListParams): Promise<ListPage>;
  /** One group of contacts with every owned field, or `null`. */
  findById(principal: ScopeHolder, access: GroupAccess, id: ObjectId): Promise<Document | null>;
  /** Inserts a whole new group of contacts. */
  insert(principal: ScopeHolder, access: GroupAccess, document: Document): Promise<void>;
  /** Applies a change only if the group is still as it was read; returns whether it was. */
  update(principal: ScopeHolder, access: GroupAccess, id: ObjectId, change: ContactGroupChange, readDate: unknown): Promise<boolean>;
  /** Deletes a group of contacts only if it is still as it was read; returns whether one was deleted. */
  remove(principal: ScopeHolder, access: GroupAccess, id: ObjectId, readDate: unknown): Promise<boolean>;
  /** How many contacts, not in the trash, are in a group of contacts, up to {@link MAX_CONTACTS_COUNT}. */
  countContacts(principal: ScopeHolder, access: GroupAccess, id: ObjectId): Promise<number>;
  /**
   * The contacts of a group of contacts, trashed ones included (at most {@link MAX_REPORTED_REFERENCES}), looked for as an `ObjectId` and as the text of its hexadecimal form: the ids, hexadecimal.
   *
   * @throws {AppError} `SERVICE_UNAVAILABLE` when the read exceeds {@link REFERENCE_MAX_TIME_MS}.
   */
  contactsOf(principal: ScopeHolder, access: GroupAccess, id: ObjectId): Promise<string[]>;
  /** The ids of the promotions of the group that name a group of contacts (`conditions.contactsGroupsIds`), read tolerantly (an `ObjectId` or a text, without regard to case). */
  promotionsNaming(access: GroupAccess, id: ObjectId): Promise<string[]>;
}

/**
 * Builds the repository of the groups of contacts. The collection is the `contacts_groups` of the group database, opened from the verified access, so a group of another group is never reachable.
 *
 * @param databases Database accessor.
 */
export function createContactGroupsRepository(databases: Databases): ContactGroupsRepository {
  const groups = (principal: ScopeHolder, access: GroupAccess) => groupDatabaseFor(principal, access, databases).collection('contacts_groups');
  const contacts = (principal: ScopeHolder, access: GroupAccess) => groupDatabaseFor(principal, access, databases).collection('contacts');
  const either = (id: ObjectId): { $in: Array<ObjectId | string> } => ({ $in: [id, id.toHexString()] });
  return {
    list: async (principal, access, filter, params) =>
      pageOf(await bounded(() => groups(principal, access).aggregate(listPipeline(filter, params, CONTACT_GROUPS_LIST, PROJECTION), { maxTimeMS: LIST_MAX_TIME_MS }).toArray()), params),

    findById: (principal, access, id) => bounded(() => groups(principal, access).findOne({ _id: id }, { projection: PROJECTION, maxTimeMS: LIST_MAX_TIME_MS })),

    insert: async (principal, access, document) => {
      await groups(principal, access).insertOne(document);
    },

    update: async (principal, access, id, change, readDate) => {
      const owned = new Set(CONTACTS_GROUPS_OWNED_FIELDS);
      for (const key of Object.keys(change.set)) {
        if (!owned.has(key)) {
          throw new Error(`Refusing to write ${key}: not an owned field`);
        }
      }
      const guard: Filter<Document> = { _id: id, ...sameAs('updateDate', readDate), $and: Object.entries(change.readValues).map(([path, value]) => sameAs(path, value)) };
      return (await groups(principal, access).updateOne(guard, { $set: { ...change.set, updateDate: change.updateDate } })).matchedCount === 1;
    },

    remove: async (principal, access, id, readDate) => (await groups(principal, access).deleteOne({ _id: id, ...sameAs('updateDate', readDate) })).deletedCount === 1,

    countContacts: (principal, access, id) => bounded(() => contacts(principal, access).countDocuments({ cGroupId: either(id), trash: { $ne: true } }, { limit: MAX_CONTACTS_COUNT, maxTimeMS: LIST_MAX_TIME_MS })),

    promotionsNaming: (access, id) => promotionsNaming(databases, access, 'contactsGroupsIds', id),

    contactsOf: async (principal, access, id) =>
      (await bounded(() => contacts(principal, access).find({ cGroupId: either(id) }, { projection: { _id: 1 }, limit: MAX_REPORTED_REFERENCES, maxTimeMS: REFERENCE_MAX_TIME_MS }).toArray())).map((document) => (document['_id'] as ObjectId).toHexString()),
  };
}
