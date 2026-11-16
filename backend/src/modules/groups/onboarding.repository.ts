import type { ClientSession, Document } from 'mongodb';
import type { Databases } from '../../db/databases.ts';
import { groupCreationDatabase } from '../../shared/security/scope/group-access.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';

/** The writes of the creation of a customer that are not the ones of the users, the companies and the places: the group document and its departments. */
export interface OnboardingRepository {
  /**
   * Inserts the whole document of a new group in `common.groups`, in the transaction of the caller.
   *
   * @param document The document built by `newGroupDocument`.
   * @param session The session of the transaction.
   */
  insertGroup(document: Document, session: ClientSession): Promise<void>;
  /**
   * Inserts the departments of the new group in the `products_departments` collection of its database, in the transaction of the caller. The collection and the database are
   * created by the insert, and by it alone: if the transaction is aborted neither exists.
   *
   * @param principal The authenticated caller the creation access was issued to.
   * @param access The creation access.
   * @param documents The documents built by `newDepartmentDocuments`.
   * @param session The session of the transaction.
   * @throws {Error} If the access is not a creation access of this caller.
   */
  insertDepartments(principal: AuthPrincipal, access: GroupAccess, documents: readonly Document[], session: ClientSession): Promise<void>;
}

/**
 * Builds the repository of the creation of a customer.
 *
 * @param databases Database accessor.
 */
export function createOnboardingRepository(databases: Databases): OnboardingRepository {
  return {
    insertGroup: async (document, session) => {
      await databases.common().collection('groups').insertOne({ ...document }, { session });
    },

    insertDepartments: async (principal, access, documents, session) => {
      await groupCreationDatabase(principal, access, databases)
        .collection('products_departments')
        .insertMany(
          documents.map((document) => ({ ...document })),
          { session },
        );
    },
  };
}
