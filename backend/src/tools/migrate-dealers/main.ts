import { APP_ENVS, loadDatabaseConfig } from '../../config.ts';
import type { AppEnv } from '../../config.ts';
import { createMongoClient } from '../../db/client.ts';
import { closeClusters, createClusterClients } from '../../db/clusters.ts';
import type { ClusterRegistry } from '../../db/clusters.ts';
import { COLLECTIONS } from '../../db/collections.ts';
import { createDatabases } from '../../db/databases.ts';
import { ensureIndexes } from '../../db/indexes.ts';
import { safeMessage } from '../profile-legacy/main.ts';
import { migrateDealers } from './migrate.ts';

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
  /** Clock for the documents written; `new Date()` by default. */
  readonly now?: () => Date;
}

const USAGE = 'Usage: node src/tools/migrate-dealers/cli.ts [--env development|production] [--apply]';

/** The validated command line. */
interface Args {
  env: AppEnv;
  apply: boolean;
}

/**
 * Reads the command line: any order of `--env <development|production>` (with a value) and `--apply` (a flag), each at most once.
 *
 * @returns The arguments, or `undefined` for anything else.
 */
function parseArgs(argv: readonly string[]): Args | undefined {
  const args: Args = { env: 'development', apply: false };
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
    } else {
      return undefined;
    }
  }
  return args;
}

/**
 * Entry point of the dealer migration (D-09): gives every existing user `D` a document in `common.dealers`.
 * It is a dry run unless `--apply` is given, refuses to run unless `APP_ENV` equals `--env` (`development` by
 * default), and works on the common cluster only. With `--apply` it first creates the indexes of the collection
 * (and nothing else), then writes one upsert per missing dealer: running it again changes nothing.
 * It never writes `users` or `groups`. Output is counts only: no user name, no id, no connection string.
 *
 * @param argv Arguments after the script name.
 * @param deps Process dependencies.
 * @returns The exit code: 0 on success, 1 on any error or when a write failed.
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
    // Only the common cluster is opened: the users live there, and nothing else is read or written.
    const common = config.clusters.get(config.commonCluster)!;
    registry = createClusterClients(
      { ...config, clusters: new Map([[config.commonCluster, common]]), defaultGroupCluster: config.commonCluster },
      deps.createClient ?? createMongoClient,
    );
    await registry.clusters.get(config.commonCluster)!.main.connect();
    const databases = createDatabases(registry, { prefix: config.dbNamePrefix, appEnv: config.appEnv });
    if (parsed.apply) {
      await ensureIndexes(databases, { common: { dealers: COLLECTIONS.common.dealers }, group: {} });
    }
    const report = await migrateDealers(databases.common(), {
      apply: parsed.apply,
      now: deps.now ?? (() => new Date()),
      onError: (errorName) => deps.error(`A dealer could not be written: ${errorName}`),
    });
    deps.info(
      parsed.apply
        ? `Applied on ${config.appEnv}: dealer users ${report.dealerUsers}, created ${report.created}, already present ${report.alreadyPresent}, errors ${report.errors}`
        : `Dry run on ${config.appEnv}, nothing written: dealer users ${report.dealerUsers}, already registered ${report.alreadyPresent}, to create ${report.created}. Run again with --apply to write them`,
    );
    exitCode = report.errors > 0 ? 1 : 0;
  } catch (error) {
    deps.error(safeMessage(error, secrets));
    exitCode = 1;
  }
  if (registry !== undefined) {
    await closeClusters(registry, (_clusterId, error) => deps.error(safeMessage(error, secrets)));
  }
  return exitCode;
}
