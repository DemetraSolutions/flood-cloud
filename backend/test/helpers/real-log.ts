import type { ActivityEntry } from '../../src/shared/activity-log/activity-log.ts';
import { createActivityLog } from '../../src/shared/activity-log/activity-log.ts';
import { memoryLogger } from './app.ts';
import type { TestDatabases } from './mongo.ts';

/**
 * Passes entries a test collected in memory through the real activity log (which validates the metadata of each action and redacts anything that looks like a credential) and reads back what it stored.
 *
 * @param ctx Throw-away databases.
 * @param entries The entries, as the application recorded them.
 * @returns The stored documents, in order, and the events the log reported (an entry it refused is one).
 */
export async function throughRealLog(ctx: TestDatabases, entries: readonly ActivityEntry[]): Promise<{ stored: Array<Record<string, any>>; refused: Array<Record<string, unknown>> }> {
  const logs = memoryLogger();
  const log = createActivityLog({ databases: ctx.databases, logger: logs.logger, retentionDays: 365, errorRetentionDays: 90 });
  const requestIds = new Set<string>();
  for (const entry of entries) {
    await log.record(entry);
    if (entry.requestId !== undefined) {
      requestIds.add(entry.requestId);
    }
  }
  const stored = await ctx.databases.common().collection('activityEvents').find({ requestId: { $in: [...requestIds] } }).sort({ _id: 1 }).toArray();
  return { stored, refused: logs.events };
}
