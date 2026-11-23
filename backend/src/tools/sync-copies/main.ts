import { ObjectId } from 'mongodb';
import { APP_ENVS, loadDatabaseConfig } from '../../config.ts';
import type { AppEnv } from '../../config.ts';
import { createMongoClient } from '../../db/client.ts';
import { closeClusters, createClusterClients } from '../../db/clusters.ts';
import type { ClusterRegistry } from '../../db/clusters.ts';
import { createDatabases } from '../../db/databases.ts';
import { GROUP_ID_PATTERN } from '../../db/names.ts';
import { safeMessage } from '../profile-legacy/main.ts';
import { exitCodeOf, formatReport } from './report.ts';
import { DEFAULT_BLOCK_LIMITS } from './reconcile.ts';
import type { BlockLimits } from './reconcile.ts';
import { syncCopies } from './sync.ts';

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
  /** Configuration loader; tests swap it to build a custom configuration. */
  readonly loadDatabaseConfig?: typeof loadDatabaseConfig;
  /** Client factory; tests swap it to reach the local MongoDB. */
  readonly createClient?: typeof createMongoClient;
  /** Clock for the documents written; `new Date()` by default. */
  readonly now?: () => Date;
  /** Size of the blocks of repairs; tests make them small to get several blocks. */
  readonly limits?: BlockLimits;
}

const USAGE = 'Usage: node src/tools/sync-copies/cli.ts [--env development|production] [--apply] [--group <24 hex characters>]';

/** The validated command line. */
interface Args {
  env: AppEnv;
  apply: boolean;
  group: ObjectId | null;
}

/**
 * Reads the command line: any order of `--env <development|production>` (default `development`), `--apply` (a flag) and `--group <24 lowercase hex>`, each at most once.
 *
 * @returns The arguments, or `undefined` for anything else.
 */
function parseArgs(argv: readonly string[]): Args | undefined {
  const args: Args = { env: 'development', apply: false, group: null };
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] as string;
    if (seen.has(flag)) {
      return undefined;
    }
    seen.add(flag);
    if (flag === '--apply') {
      args.apply = true;
    } else if (flag === '--env') {
      const value = argv[(index += 1)];
      if (value === undefined || !(APP_ENVS as readonly string[]).includes(value)) {
        return undefined;
      }
      args.env = value as AppEnv;
    } else if (flag === '--group') {
      const value = argv[(index += 1)];
      if (value === undefined || !GROUP_ID_PATTERN.test(value)) {
        return undefined;
      }
      args.group = ObjectId.createFromHexString(value);
    } else {
      return undefined;
    }
  }
  return args;
}

/**
 * Entry point of the copy command (`doc/Tasks.md` 5.4 and 5.5): loads the copies of `companies` and `places` of the
 * group databases into the common database. The first run is the initial load, the next ones the reconciliation. It copies
 * the current state only: it writes missing and different copies and never deletes. It works on `development` and, by
 * the decision of 2026-11-18, on `production`, with the same safety model as the dealer migration: it refuses to run
 * unless `APP_ENV` equals `--env` (`development` by default), before any connection and any write. It is a dry run
 * (the default: nothing at all is written) unless `--apply` is given, only replica sets are supported, groups on
 * clusters other than the common one are copied without a transaction (D-25), and it stops with exit code 1 before any write when a cluster
 * is older than MongoDB 4.4 or is not a replica set. Every database name goes through the environment guard of
 * `databases.ts`. Group databases are only read. Output is counts and group ids: no document value, no connection string.
 *
 * @param argv Arguments after the script name.
 * @param deps Process dependencies.
 * @returns The exit code: 0 when no copy was missing or different, 2 when some were (written or not) or an `_id` collided, 1 on any error.
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
    // Only the common cluster is connected up front; the others connect on first use, so a run limited to one group does not need them.
    await registry.clusters.get(config.commonCluster)!.main.connect();
    const databases = createDatabases(registry, { prefix: config.dbNamePrefix, appEnv: config.appEnv });
    const result = await syncCopies(databases, {
      apply: parsed.apply,
      groupId: parsed.group,
      runId: new ObjectId(),
      now: deps.now ?? (() => new Date()),
      limits: deps.limits ?? DEFAULT_BLOCK_LIMITS,
      onGroupError: (groupHex, error) => deps.error(`Group ${groupHex} failed: ${safeMessage(error, secrets)}`),
    });
    for (const line of formatReport(result, { apply: parsed.apply, appEnv: config.appEnv })) {
      deps.info(line);
    }
    exitCode = exitCodeOf(result);
  } catch (error) {
    deps.error(safeMessage(error, secrets));
    exitCode = 1;
  }
  if (registry !== undefined) {
    await closeClusters(registry, (_clusterId, error) => deps.error(safeMessage(error, secrets)));
  }
  return exitCode;
}
