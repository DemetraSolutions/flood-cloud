import type { ClientSession, Document } from 'mongodb';
import type { Databases } from '../../db/databases.ts';
import type { Logger } from '../../shared/logging/logger.ts';
import { createCardCodeIndex } from '../fidelity-cards/fidelity-cards.indexes.ts';
import { createSalesCustomerIndex } from '../sales/sales.indexes.ts';
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
  /**
   * Creates, after the transaction has committed (an index is not created inside the transaction that creates the database), the unique index on the code of the loyalty cards the legacy has on every group, so the collection exists with it from
   * the start. A failure is logged and never stops the creation of the customer.
   *
   * @param principal The authenticated caller the creation access was issued to.
   * @param access The creation access.
   */
  createCardIndex(principal: AuthPrincipal, access: GroupAccess): Promise<void>;
  /**
   * Creates, after the transaction has committed, the index of the purchases of a customer on the sales of the group (`{ customer._id, date }`, step V1), so the first read for a customer does not have to build it. A failure is logged and
   * never stops the creation of the customer.
   *
   * @param principal The authenticated caller the creation access was issued to.
   * @param access The creation access.
   */
  createSalesIndex(principal: AuthPrincipal, access: GroupAccess): Promise<void>;
}

/**
 * Builds the repository of the creation of a customer.
 *
 * @param databases Database accessor.
 * @param logger Where the failure to create the index of the cards is reported.
 */
export function createOnboardingRepository(databases: Databases, logger: Logger): OnboardingRepository {
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

    createCardIndex: (principal, access) => createCardCodeIndex(groupCreationDatabase(principal, access, databases), access.groupId, logger),

    createSalesIndex: async (principal, access) => {
      await createSalesCustomerIndex(groupCreationDatabase(principal, access, databases), access.groupId, logger);
    },
  };
}
