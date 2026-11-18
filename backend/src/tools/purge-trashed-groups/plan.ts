import { createHash } from 'node:crypto';
import type { ObjectId } from 'mongodb';
import type { Databases } from '../../db/databases.ts';
import type { GroupDatabasePurger } from '../../db/group-database-purger.ts';
import { auditGroup } from './audit.ts';
import type { GroupAudit, HoldOptions } from './audit.ts';
import { toSelected, trashedGroupsCursor } from './select.ts';

/** How the groups of the run are chosen. */
export interface PlanOptions extends HoldOptions {
  /** Restrict the selection to this group (which must be in the trash). */
  readonly group: ObjectId | null;
  /** Groups left out of the selection. */
  readonly skip: readonly ObjectId[];
  /** Stop after this many purgeable groups. */
  readonly limit: number | null;
}

/** The outcome of the selection: every group looked at, and among them the ones a run would purge. */
export interface Plan {
  /** Every group audited, in `_id` order, with the reason it is held back when it is. */
  readonly audits: readonly GroupAudit[];
  /** The groups a run with the same options purges: the selection that `--expect` and the digest cover. */
  readonly purgeable: readonly GroupAudit[];
  /** Digest of the ids of the purgeable groups. */
  readonly digest: string;
}

/**
 * The digest of a selection: the first 16 hexadecimal characters of the SHA-256 of the sorted ids of the groups, one per line.
 *
 * @param ids Ids of the groups that would be purged.
 */
export function selectionDigest(ids: readonly ObjectId[]): string {
  return createHash('sha256').update(ids.map((id) => id.toHexString()).sort().join('\n')).digest('hex').slice(0, 16);
}

/**
 * Walks the groups of the trash in `_id` order, audits each (read only) and keeps the purgeable ones. With a limit it stops at the n-th purgeable group, so groups that are
 * held back never block the progress of the next blocks. The same function serves the dry run and `--apply`, so the digest of one matches the other.
 *
 * @param databases Database accessor.
 * @param purger Read access to the group databases.
 * @param options How to choose.
 */
export async function planPurge(databases: Databases, purger: GroupDatabasePurger, options: PlanOptions): Promise<Plan> {
  const audits: GroupAudit[] = [];
  const purgeable: GroupAudit[] = [];
  // The selected groups are read first, in one bounded query, and the cursor is done before the slow audits start: a long audit never meets a cursor timeout.
  const groups = (await trashedGroupsCursor(databases, options.group, options.skip).toArray()).map(toSelected);
  for (const group of groups) {
    const audit = await auditGroup(databases, purger, group, options);
    audits.push(audit);
    if (audit.status === 'purgeable') {
      purgeable.push(audit);
      if (purgeable.length === options.limit) {
        break;
      }
    }
  }
  return { audits, purgeable, digest: selectionDigest(purgeable.map((audit) => audit.group.id)) };
}
