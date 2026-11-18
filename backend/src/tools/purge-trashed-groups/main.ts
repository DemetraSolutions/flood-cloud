import { ObjectId } from 'mongodb';
import { APP_ENVS, loadDatabaseConfig } from '../../config.ts';
import type { AppEnv } from '../../config.ts';
import { createMongoClient } from '../../db/client.ts';
import { closeClusters, createClusterClients } from '../../db/clusters.ts';
import type { ClusterRegistry } from '../../db/clusters.ts';
import { createDatabases } from '../../db/databases.ts';
import { createGroupDatabasePurger } from '../../db/group-database-purger.ts';
import { GROUP_ID_PATTERN } from '../../db/names.ts';
import { safeMessage } from '../profile-legacy/main.ts';
import { planGroups } from '../sync-copies/plan.ts';
import { addCounts, emptyCounts } from './counts.ts';
import { planPurge } from './plan.ts';
import { purgeGroup } from './purge.ts';
import type { PurgeStep } from './purge.ts';
import { formatDryRun, formatOrphans, formatPurged, formatSummary } from './report.ts';
import type { RunTotals } from './report.ts';

/** Everything {@link main} needs from the process, injectable for tests. */
export interface MainDeps {
  /** Environment variables (after the optional `.env` has been loaded). */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Loads `.env` into the environment; may throw (`ENOENT` is tolerated). */
  readonly loadEnvFile: () => void;
  /** Writes a line to the standard output. */
  readonly info: (line: string) => void;
  /** Writes a line to the standard error. */
  readonly error: (line: string) => void;
  /** Configuration loader; tests swap it to exercise `production` without TLS. */
  readonly loadDatabaseConfig?: typeof loadDatabaseConfig;
  /** Client factory; tests swap it to reach the local MongoDB. */
  readonly createClient?: typeof createMongoClient;
  /** Clock for the `group.purged` events; `new Date()` by default. */
  readonly now?: () => Date;
  /** Waits between two groups; a timer by default, replaced by the tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Test hook called when a step of a group has finished (see `PurgeStep`); the real command passes none. */
  readonly afterStep?: (step: PurgeStep, groupHex: string) => Promise<void> | void;
}

const USAGE =
  'Usage: node src/tools/purge-trashed-groups/cli.ts [--env development|production] [--group <24 hex>] [--limit <1-1000>] [--min-idle-days <0-3650>] [--include-active] [--skip <24 hex>]... [--pause-ms <0-60000>] [--apply --expect <n> --expect-digest <16 hex>] | --orphans [--env development|production]';

/** Most groups one run can take with `--limit`. */
const MAX_LIMIT = 1000;
/** Most groups `--skip` can name. */
const MAX_SKIP = 50;
/** Default idle limit in days: a group with activity newer than this is held back. */
const DEFAULT_MIN_IDLE_DAYS = 365;
/** Default pause between two groups, in milliseconds. */
const DEFAULT_PAUSE_MS = 200;

/** The validated command line. */
interface Args {
  env: AppEnv;
  group: ObjectId | null;
  limit: number | null;
  apply: boolean;
  expect: number | null;
  digest: string | null;
  minIdleDays: number;
  includeActive: boolean;
  skip: ObjectId[];
  pauseMs: number;
  orphans: boolean;
}

/** Whether a text is a whole number of at most `digits` digits that does not exceed `max`. */
function inRange(value: string, digits: number, max: number): boolean {
  return new RegExp(`^\\d{1,${digits}}$`).test(value) && Number(value) <= max;
}

/**
 * Reads the command line: any order of `--env <development|production>` (default `development`), `--group <24 lowercase hex>`, `--limit <1-1000>`, `--min-idle-days <0-3650>`,
 * `--include-active` (a flag), `--skip <24 lowercase hex>` (repeatable, at most 50 different ids), `--pause-ms <0-60000>`, `--apply` (a flag), `--expect <n>`, `--expect-digest <16 hex>` and
 * `--orphans` (a flag), each at most once. `--apply`, `--expect` and `--expect-digest` go together. `--orphans` is a read-only listing and admits `--env` only.
 *
 * @returns The arguments, or `undefined` for anything else.
 */
function parseArgs(argv: readonly string[]): Args | undefined {
  const args: Args = { env: 'development', group: null, limit: null, apply: false, expect: null, digest: null, minIdleDays: DEFAULT_MIN_IDLE_DAYS, includeActive: false, skip: [], pauseMs: DEFAULT_PAUSE_MS, orphans: false };
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] as string;
    if (seen.has(flag) && flag !== '--skip') {
      return undefined;
    }
    seen.add(flag);
    if (flag === '--apply' || flag === '--include-active' || flag === '--orphans') {
      args.apply ||= flag === '--apply';
      args.includeActive ||= flag === '--include-active';
      args.orphans ||= flag === '--orphans';
      continue;
    }
    const value = argv[(index += 1)];
    if (value === undefined) {
      return undefined;
    }
    if (flag === '--env' && (APP_ENVS as readonly string[]).includes(value)) {
      args.env = value as AppEnv;
    } else if (flag === '--group' && GROUP_ID_PATTERN.test(value)) {
      args.group = ObjectId.createFromHexString(value);
    } else if (flag === '--skip' && GROUP_ID_PATTERN.test(value) && !args.skip.some((id) => id.toHexString() === value) && args.skip.length < MAX_SKIP) {
      args.skip.push(ObjectId.createFromHexString(value));
    } else if (flag === '--limit' && /^[1-9]\d{0,3}$/.test(value) && Number(value) <= MAX_LIMIT) {
      args.limit = Number(value);
    } else if (flag === '--min-idle-days' && inRange(value, 4, 3650)) {
      args.minIdleDays = Number(value);
    } else if (flag === '--pause-ms' && inRange(value, 5, 60_000)) {
      args.pauseMs = Number(value);
    } else if (flag === '--expect' && /^\d{1,6}$/.test(value)) {
      args.expect = Number(value);
    } else if (flag === '--expect-digest' && /^[0-9a-f]{16}$/.test(value)) {
      args.digest = value;
    } else {
      return undefined;
    }
  }
  if (args.apply !== (args.expect !== null) || args.apply !== (args.digest !== null)) {
    return undefined;
  }
  return args.orphans && [...seen].some((flag) => flag !== '--orphans' && flag !== '--env') ? undefined : args;
}

/**
 * Entry point of the purge of the groups in the trash: for every group of `common.groups` whose `trash` is `true` it deletes its users with a group role, the data of the common database that depends on it, the copies of its companies and places, its database, and finally the group document. Irreversible: take a backup first.
 * It is a dry run (the default: nothing at all is written) that prints counts and group ids only. Groups with recent activity (`--min-idle-days`, unless `--include-active`), with a dedicated `databaseHost` or with an unusable cluster are held back. With
 * `--apply --expect <n> --expect-digest <d>` it deletes, and refuses before any write when the selection does not count exactly `n` groups or has another digest, so a selection that changed after the audit is never applied. It refuses to run unless `APP_ENV`
 * equals `--env` (`development` by default), before any connection, when the common database is missing (wrong `DB_NAME_PREFIX`) and, to apply, when the common
 * cluster is not a replica set. A group that fails is counted and the others go on. `--orphans` only lists the group databases without a group document. Output is counts and ids: no name, e-mail, document value or connection string.
 *
 * @param argv Arguments after the script name.
 * @param deps Process dependencies.
 * @returns The exit code: 0 when the run (or the dry run) completed, 1 on any refusal, error, failed group or event that could not be written.
 */
export async function main(argv: readonly string[], deps: MainDeps): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed === undefined) {
    deps.error(USAGE);
    return 1;
  }
  try {
    deps.loadEnvFile();
  } catch (error) {
    if (!(error instanceof Error && (error as { code?: unknown }).code === 'ENOENT')) {
      deps.error(safeMessage(error, []));
      return 1;
    }
  }

  let config: ReturnType<typeof loadDatabaseConfig>;
  try {
    config = (deps.loadDatabaseConfig ?? loadDatabaseConfig)(deps.env);
  } catch (error) {
    deps.error(safeMessage(error, []));
    return 1;
  }
  if (config.appEnv !== parsed.env) {
    deps.error(`Refusing to run: APP_ENV does not match the requested environment (--env ${parsed.env}, default development)`);
    return 1;
  }
  const secrets = [...config.clusters.values()].flatMap((cluster) => [cluster.uri.reveal(), ...(cluster.analyticsUri === null ? [] : [cluster.analyticsUri.reveal()])]);

  let registry: ClusterRegistry | undefined;
  let exitCode = 0;
  try {
    registry = createClusterClients(config, deps.createClient ?? createMongoClient);
    // Only the common cluster is connected up front; the others connect on first use.
    await registry.clusters.get(config.commonCluster)!.main.connect();
    const context = { prefix: config.dbNamePrefix, appEnv: config.appEnv };
    const databases = createDatabases(registry, context);
    const purger = createGroupDatabasePurger(databases, context);
    if (!(await databases.commonDatabaseExists())) {
      throw new Error('The common database does not exist on the common cluster: check DB_NAME_PREFIX');
    }
    if (parsed.orphans) {
      // Read only: the group databases of every cluster that have no group document (the logic of `databaseWithoutGroup` of sync:copies).
      const plan = await planGroups(databases, null);
      const orphans: Array<{ cluster: string; hex: string }> = [];
      for (const cluster of plan.clusters) {
        for (const id of await databases.listGroupIds(cluster)) {
          if (!plan.knownGroupHexes.has(id.toHexString())) {
            orphans.push({ cluster, hex: id.toHexString() });
          }
        }
      }
      for (const line of formatOrphans(config.appEnv, orphans)) {
        deps.info(line);
      }
    } else {
      const now = deps.now ?? (() => new Date());
      const plan = await planPurge(databases, purger, { group: parsed.group, skip: parsed.skip, limit: parsed.limit, minIdleDays: parsed.minIdleDays, includeActive: parsed.includeActive, now: now() });
      if (parsed.group !== null && plan.audits.length === 0) {
        throw new Error('Refusing to run: the group given with --group is not in the trash (or is in the --skip list)');
      }
      if (!parsed.apply) {
        for (const line of formatDryRun(plan, config.appEnv, parsed.minIdleDays)) {
          deps.info(line);
        }
      } else {
        if (parsed.expect !== plan.purgeable.length) {
          throw new Error(`Refusing to apply: --expect ${parsed.expect} but the selection counts ${plan.purgeable.length} groups (nothing was written)`);
        }
        if (parsed.digest !== plan.digest) {
          throw new Error('Refusing to apply: --expect-digest does not match the digest of the selection (nothing was written)');
        }
        if ((await databases.replicaSetName(config.commonCluster)) === null) {
          throw new Error('Refusing to apply: the common cluster is not a replica set (transactions are needed)');
        }
        const held = (status: string): number => plan.audits.filter((audit) => audit.status === status).length;
        deps.info(`Held back and not purged: recentlyActive ${held('recentlyActive')}, unknownActivity ${held('unknownActivity')}, externalHost ${held('externalHost')}, unusableCluster ${held('unusableCluster')}`);
        const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
        let totals: RunTotals = { purged: 0, skipped: 0, skippedExternalHost: 0, restoredDuringPurge: 0, failed: 0, eventsFailed: 0, withoutDatabase: 0, counts: emptyCounts() };
        for (const [position, audit] of plan.purgeable.entries()) {
          if (position > 0 && parsed.pauseMs > 0) {
            await sleep(parsed.pauseMs);
          }
          const outcome = await purgeGroup({ databases, purger, now, ...(deps.afterStep === undefined ? {} : { afterStep: deps.afterStep }) }, audit.group);
          const hex = audit.group.id.toHexString();
          if (outcome.status === 'purged') {
            deps.info(formatPurged(audit.group.id, outcome.counts, outcome.resumed));
            if (outcome.eventError !== null) {
              deps.error(`Group ${hex}: the group.purged event could not be written: ${outcome.eventError}`);
            }
            totals = { ...totals, purged: totals.purged + 1, eventsFailed: totals.eventsFailed + (outcome.eventError === null ? 0 : 1), withoutDatabase: totals.withoutDatabase + (outcome.resumed ? 1 : 0), counts: addCounts(totals.counts, outcome.counts) };
          } else if (outcome.status === 'skipped') {
            deps.info(`Skipped ${hex}: no longer in the trash`);
            totals = { ...totals, skipped: totals.skipped + 1 };
          } else if (outcome.status === 'skippedExternalHost') {
            deps.info(`Skipped ${hex}: it has a dedicated database host`);
            totals = { ...totals, skippedExternalHost: totals.skippedExternalHost + 1 };
          } else if (outcome.status === 'restored') {
            deps.error(`Group ${hex}: restored during the purge, stopped after step ${outcome.after}`);
            totals = { ...totals, restoredDuringPurge: totals.restoredDuringPurge + 1 };
          } else {
            deps.error(`Group ${hex} failed: ${outcome.errorName}`);
            totals = { ...totals, failed: totals.failed + 1 };
          }
        }
        deps.info(formatSummary(totals, config.appEnv));
        exitCode = totals.failed > 0 || totals.eventsFailed > 0 || totals.restoredDuringPurge > 0 ? 1 : 0;
      }
    }
  } catch (error) {
    deps.error(safeMessage(error, secrets));
    exitCode = 1;
  }
  if (registry !== undefined) {
    await closeClusters(registry, (_clusterId, error) => deps.error(safeMessage(error, secrets)));
  }
  return exitCode;
}
