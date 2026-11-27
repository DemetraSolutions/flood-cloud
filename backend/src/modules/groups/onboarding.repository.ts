import type { ClientSession, Document } from 'mongodb';
import type { Databases } from '../../db/databases.ts';
import type { Logger } from '../../shared/logging/logger.ts';
import { createCardCodeIndex } from '../fidelity-cards/fidelity-cards.indexes.ts';
import { createSalesCustomerIndex } from '../sales/sales.indexes.ts';
import { createSalesKeyIndex } from '../sales/sales.key-index.ts';
import { createStockOriginIndex } from '../stock/stock.indexes.ts';
import { createNumberingIndexes } from '../document-numbering/numbering.indexes.ts';
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
  /**
   * Creates, after the transaction has committed, the unique index of the origins of the warehouse movements (`{ origin.kind, origin.id, origin.seq }`, partial, step VS1), so the first movement of the group finds it. A failure is logged and
   * never stops the creation of the customer.
   *
   * @param principal The authenticated caller the creation access was issued to.
   * @param access The creation access.
   */
  createStockIndex(principal: AuthPrincipal, access: GroupAccess): Promise<void>;
  /**
   * Creates, after the transaction has committed, the indexes of the numbering of the fiscal documents (step VS3: the unique one of the counters and the two supporting ones of `documents`), so the first invoice of the group finds them. A failure is logged and
   * never stops the creation of the customer (the numbering creates them again, and refuses to number without the unique one).
   *
   * @param principal The authenticated caller the creation access was issued to.
   * @param access The creation access.
   */
  createNumberingIndexes(principal: AuthPrincipal, access: GroupAccess): Promise<void>;
  /**
   * Creates, after the transaction has committed, the unique partial index of the key of the sales (`{ floodCloud.key }`, step VS4a) and the index on the `timestampId` the search by it reads, so the first sale of the group finds them. A failure is logged and
   * never stops the creation of the customer (the creation of a sale creates them again, and refuses to save a sale without the unique one).
   *
   * @param principal The authenticated caller the creation access was issued to.
   * @param access The creation access.
   */
  createSalesKeyIndex(principal: AuthPrincipal, access: GroupAccess): Promise<void>;
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

    createStockIndex: async (principal, access) => {
      await createStockOriginIndex(groupCreationDatabase(principal, access, databases), access.groupId, logger);
    },

    createNumberingIndexes: async (principal, access) => {
      await createNumberingIndexes(groupCreationDatabase(principal, access, databases), access.groupId, logger);
    },

    createSalesKeyIndex: async (principal, access) => {
      await createSalesKeyIndex(groupCreationDatabase(principal, access, databases), access.groupId, logger);
    },
  };
}
