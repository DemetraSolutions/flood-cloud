import type { ClientSession, Document, Filter, ObjectId } from 'mongodb';
import { PRODUCTS_DEPARTMENTS_OWNED_FIELDS } from '../../db/collections.ts';
import type { Databases } from '../../db/databases.ts';
import { LIST_MAX_TIME_MS } from '../../shared/http/list.ts';
import { bounded } from '../../shared/security/scope/bounded.ts';
import { groupDatabaseFor } from '../../shared/security/scope/group-access.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { CatalogCaller } from '../product-catalog/caller.ts';
import { createEntityRepository, entityProjection } from '../product-catalog/entity.repository.ts';
import type { EntityRepository } from '../product-catalog/entity.repository.ts';
import { createTaxProducts } from '../products/products.tax.ts';
import type { Realignment } from '../products/products.tax.ts';

/** Most departments read to check the uniqueness of a code (a group has between one and a few dozen). */
export const MAX_DEPARTMENTS_READ = 1000;

/** Most departments reported as users of a tax rate (a refused deletion lists at most these). */
export const MAX_REPORTED_DEPARTMENTS = 20;

/** The fields a list of departments returns. */
const SUMMARY = entityProjection(PRODUCTS_DEPARTMENTS_OWNED_FIELDS);

/** The `products_departments` collection of a group database. */
export interface DepartmentsRepository extends EntityRepository {
  /**
   * The code and the date of the last change of every department of the group, as stored (any type), whoever the caller is: a code is unique in the whole group, so the check cannot be limited to what the caller reaches.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @returns The departments (id and code), at most {@link MAX_DEPARTMENTS_READ}.
   * @throws {Error} If the group has more than {@link MAX_DEPARTMENTS_READ} departments: the check would be made on a part of them, so it is refused explicitly.
   */
  codes(principal: CatalogCaller, access: GroupAccess): Promise<Array<{ readonly id: ObjectId; readonly code: unknown; readonly updateDate: unknown }>>;
  /**
   * Whether the group has another active department (`status` `true`) whose tax rate has a fiscal department number.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param except The department being deleted.
   * @param department The department number of the tax rate.
   */
  hasOtherActiveWithNumber(principal: CatalogCaller, access: GroupAccess, except: ObjectId, department: number): Promise<boolean>;
}

/**
 * Builds the repository of the departments. The collection is the `products_departments` of the group database, opened from the verified access, so a department of another group is never reachable.
 *
 * @param databases Database accessor.
 */
export function createDepartmentsRepository(databases: Databases): DepartmentsRepository {
  const departments = (principal: CatalogCaller, access: GroupAccess) => groupDatabaseFor(principal, access, databases).collection('products_departments');
  return {
    ...createEntityRepository(databases, { open: (db) => db.collection('products_departments'), ownedFields: PRODUCTS_DEPARTMENTS_OWNED_FIELDS, summary: SUMMARY }),

    codes: async (principal, access) => {
      const found = await bounded(() => departments(principal, access).find({}, { projection: { code: 1, updateDate: 1 }, limit: MAX_DEPARTMENTS_READ + 1, maxTimeMS: LIST_MAX_TIME_MS }).toArray());
      if (found.length > MAX_DEPARTMENTS_READ) {
        throw new Error(`The group has more than ${String(MAX_DEPARTMENTS_READ)} departments: the uniqueness of a code cannot be checked`);
      }
      return found.map((department) => ({ id: department['_id'] as ObjectId, code: department['code'] as unknown, updateDate: department['updateDate'] as unknown }));
    },

    hasOtherActiveWithNumber: async (principal, access, except, department) =>
      (await bounded(() => departments(principal, access).findOne({ _id: { $ne: except }, status: true, 'tax.department': department }, { projection: { _id: 1 }, maxTimeMS: LIST_MAX_TIME_MS }))) !== null,
  };
}

/** A transaction that spans the common database and the group database, or what runs inside one. */
export type AtomicRunner = <T>(work: (session: ClientSession) => Promise<T>) => Promise<T>;

/**
 * The departments and the products, as the tax rates of the group see them: the departments hold a copy of the tax rate they were given, the prices of the products hold one too, and the rates live in the group
 * document of the common database.
 */
export interface TaxDepartments {
  /**
   * The ids of the departments that were given a tax rate (`tax.id` of their copy).
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param taxId Id of the tax rate.
   * @returns At most {@link MAX_REPORTED_DEPARTMENTS} departments, hexadecimal.
   */
  usedBy(principal: CatalogCaller, access: GroupAccess, taxId: string): Promise<string[]>;
  /**
   * The ids of the products, not in the trash, that have a price with a tax rate of the group (`prices[].taxData.id`).
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param taxId Id of the tax rate.
   * @returns At most 20 products, hexadecimal.
   */
  productsUsing(principal: CatalogCaller, access: GroupAccess, taxId: string): Promise<string[]>;
  /**
   * Makes the copy of a tax rate in the departments that hold it, and in the prices of the products that hold it (`tax` and `taxData`; with a new percentage the gross price stays and the net one is computed again),
   * equal to the rate, and the date of the change of the departments and of the products touched new. It writes only what differs, so
   * repeating it changes nothing: that is what makes the operation safe to repeat when the two databases cannot be written together.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param copy The tax rate in the stored form (`{ id, value, department, description, natura }`).
   * @param now The new date of the change.
   * @param session The transaction to write in, when there is one.
   * @returns How far the realignment of the prices went (inside a transaction it is always complete, or the whole write is refused).
   */
  realign(principal: CatalogCaller, access: GroupAccess, copy: Document, now: Date, session?: ClientSession): Promise<Realignment>;
  /**
   * The way to write the group document and its departments in one transaction: available when the group database is on the cluster of the common database (a transaction cannot span clusters),
   * `null` otherwise.
   *
   * @param access Verified access to the group.
   */
  atomic(access: GroupAccess): AtomicRunner | null;
}

/**
 * Builds the port the tax rates of the group use to keep the departments consistent.
 *
 * @param databases Database accessor.
 */
export function createTaxDepartments(databases: Databases): TaxDepartments {
  const departments = (principal: CatalogCaller, access: GroupAccess) => groupDatabaseFor(principal, access, databases).collection('products_departments');
  const products = createTaxProducts(databases);
  return {
    productsUsing: (principal, access, taxId) => products.usedBy(principal, access, taxId),

    usedBy: async (principal, access, taxId) => {
      const found = await bounded(() => departments(principal, access).find({ 'tax.id': taxId }, { projection: { _id: 1 }, limit: MAX_REPORTED_DEPARTMENTS, maxTimeMS: LIST_MAX_TIME_MS }).toArray());
      return found.map((department) => (department['_id'] as ObjectId).toHexString());
    },

    realign: async (principal, access, copy, now, session) => {
      // A comparison by value, not by type: a rate stored as an integer and the same rate as a double are the same rate.
      const differs: Filter<Document> = { $or: ['value', 'department', 'description', 'natura'].map((key) => ({ [`tax.${key}`]: { $ne: copy[key] } })) };
      // Only the five keys of the copy are written: any other key of the `tax` object of a department stays.
      const keys = { 'tax.id': copy['id'], 'tax.value': copy['value'], 'tax.department': copy['department'], 'tax.description': copy['description'], 'tax.natura': copy['natura'] };
      await departments(principal, access).updateMany({ 'tax.id': copy['id'], ...differs }, { $set: { ...keys, updateDate: now } }, session === undefined ? {} : { session });
      return products.realign(principal, access, copy, now, session);
    },

    atomic: (access) => (access.clusterId === databases.commonCluster ? (work) => databases.transaction(work) : null),
  };
}
