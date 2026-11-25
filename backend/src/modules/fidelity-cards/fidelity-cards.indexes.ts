import type { Db, ObjectId } from 'mongodb';
import type { Databases } from '../../db/databases.ts';
import type { Logger } from '../../shared/logging/logger.ts';
import { groupDatabaseFor } from '../../shared/security/scope/group-access.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { ScopeHolder } from '../../shared/security/scope/principal.ts';

/**
 * The unique index of the legacy on the code of the loyalty cards (`ms-fidelity-service` creates `{ code: 1 }` with `unique: true` and the default name `code_1`; its `background` option is ignored by the server). The new backend
 * creates the very same index, so `createIndex` is idempotent next to the legacy's.
 */
export const CARD_CODE_INDEX = Object.freeze({ key: Object.freeze({ code: 1 as const }), options: Object.freeze({ name: 'code_1', unique: true }) });

/**
 * Creates the unique index on the code of the cards in a group database, and says so in the log when it cannot (the usual reason is that the group already has two cards with the same code): the check of the code before every insert
 * goes on protecting the group. The log has the group and the kind of failure, never a code or the text of the server's message (which names a value).
 *
 * @param db The group database.
 * @param groupId The group, for the log.
 * @param logger Where a failure is reported.
 */
export async function createCardCodeIndex(db: Db, groupId: ObjectId, logger: Logger): Promise<void> {
  try {
    await db.collection('fidelity_cards').createIndex({ ...CARD_CODE_INDEX.key }, { ...CARD_CODE_INDEX.options });
  } catch (error) {
    const failure = error as { readonly name?: unknown; readonly code?: unknown };
    logger.error('the unique index on the code of the loyalty cards could not be created', { groupId: groupId.toHexString(), errorName: String(failure.name), errorCode: typeof failure.code === 'number' ? failure.code : null });
  }
}

/** Makes sure a group has the unique index on the code of its cards before its first card is written by this process. */
export interface CardIndexGuard {
  /** Creates the index if this process has not checked the group yet (once per group and process: a failure is logged, not repeated on every write). */
  ensure(principal: ScopeHolder, access: GroupAccess): Promise<void>;
}

/**
 * Builds the guard of the index.
 *
 * @param databases Database accessor.
 * @param logger Where a failure is reported.
 */
export function createCardIndexGuard(databases: Databases, logger: Logger): CardIndexGuard {
  const checked = new Map<string, Promise<void>>();
  return {
    ensure: (principal, access) => {
      const key = access.groupId.toHexString();
      if (!checked.has(key)) {
        checked.set(key, createCardCodeIndex(groupDatabaseFor(principal, access, databases), access.groupId, logger));
      }
      return checked.get(key)!;
    },
  };
}
