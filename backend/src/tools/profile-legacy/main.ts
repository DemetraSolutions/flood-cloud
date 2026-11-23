import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { APP_ENVS, loadDatabaseConfig } from '../../config.ts';
import type { AppEnv } from '../../config.ts';
import { createMongoClient } from '../../db/client.ts';
import { closeClusters, createClusterClients } from '../../db/clusters.ts';
import type { ClusterRegistry } from '../../db/clusters.ts';
import { createDatabases } from '../../db/databases.ts';
import { profileCatalog } from './catalog.ts';
import { profileLegacy } from './profile.ts';
import { profileSubobjects } from './subobjects.ts';

/** Everything {@link main} needs from the process, injectable for tests. */
export interface MainDeps {
  /** Environment variables (after the optional `.env` has been loaded). */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Loads `.env` into the environment; may throw (`ENOENT` is tolerated). */
  readonly loadEnvFile: () => void;
  /** Working directory (the `backend/` folder when run through npm). */
  readonly cwd: string;
  /** Writes a line to the standard output. */
  readonly info: (line: string) => void;
  /** Writes a line to the standard error. */
  readonly error: (line: string) => void;
  /** Configuration loader; tests swap it to exercise `production` without TLS. */
  readonly loadDatabaseConfig?: typeof loadDatabaseConfig;
  /** Progress interval in group databases (50 by default); tests lower it. */
  readonly progressEvery?: number;
  /** Client factory; tests swap it to reach the local MongoDB. */
  readonly createClient?: typeof createMongoClient;
}

const USAGE = 'Usage: node src/tools/profile-legacy/cli.ts [--env development|production] [--out <report.json>] [--focus subobjects|catalog] [--sample <group databases>]';

/** Targeted profiles selectable with `--focus`. */
type Focus = 'subobjects' | 'catalog';

/** The validated command line. */
interface Args {
  /** Environment the operator asked for; `development` unless `--env` says otherwise. */
  env: AppEnv;
  out?: string;
  /** `--focus` value: the targeted sub-object or catalog profile instead of the full one. */
  focus: Focus | undefined;
  /** `--sample` value: how many group databases the catalog profile reads (only with `--focus catalog`). */
  sample: number | undefined;
}

/**
 * Reads the command line: any order of `--out <path>`, `--env <development|production>`, `--focus <subobjects|catalog>` and
 * `--sample <positive integer>` (only with `--focus catalog`), each at most once.
 *
 * @returns The arguments, or `undefined` for anything else.
 */
function parseArgs(argv: readonly string[]): Args | undefined {
  let out: string | undefined;
  let env: AppEnv = 'development';
  let focus: Focus | undefined;
  let sample: number | undefined;
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index] as string;
    const value = argv[index + 1];
    if (value === undefined || value === '' || seen.has(flag)) {
      return undefined;
    }
    seen.add(flag);
    if (flag === '--out') {
      out = value;
    } else if (flag === '--env' && (APP_ENVS as readonly string[]).includes(value)) {
      env = value as AppEnv;
    } else if (flag === '--focus' && (value === 'subobjects' || value === 'catalog')) {
      focus = value;
    } else if (flag === '--sample' && /^[1-9][0-9]{0,5}$/.test(value)) {
      sample = Number(value);
    } else {
      return undefined;
    }
  }
  if (sample !== undefined && focus !== 'catalog') {
    return undefined;
  }
  return out === undefined ? { env, focus, sample } : { env, focus, sample, out };
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/** Finds the repository root (the folder that holds `.git`) walking up from `start`. */
async function findRepoRoot(start: string): Promise<string | undefined> {
  let dir = resolve(start);
  for (;;) {
    if (await exists(join(dir, '.git'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

function isInside(path: string, dir: string): boolean {
  return path.startsWith(`${dir}${sep}`);
}

/** Where the report goes and whether its folder may be created. */
interface Destination {
  out: string;
  createFolder: boolean;
}

/**
 * Chooses the report path. Inside the repository only `backend/reports/` is allowed (it is git-ignored);
 * outside the repository any path is. Without `--out` the report goes to
 * `backend/reports/legacy-profile-<env>-<timestamp>.json` (`legacy-subobjects-…` and `legacy-catalog-…` with `--focus`).
 *
 * @returns The destination, or an error message.
 */
async function chooseDestination(requested: string | undefined, cwd: string, env: AppEnv, kind: string): Promise<Destination | string> {
  const root = await findRepoRoot(cwd);
  const reportsDir = root === undefined ? resolve(cwd, 'reports') : join(root, 'backend', 'reports');
  const stamp = new Date().toISOString().split(/[-:.]/).join('');
  const out = resolve(cwd, requested ?? join(reportsDir, `legacy-${kind}-${env}-${stamp}.json`));
  const inReports = isInside(out, reportsDir);
  if (root !== undefined && isInside(out, root) && !inReports) {
    return 'Refusing to write the report inside the repository: use backend/reports/ or a path outside the repository';
  }
  return { out, createFolder: inReports };
}

/**
 * Message of an error with every given secret (the connection string) removed.
 *
 * @param error Anything that was thrown.
 * @param secrets Texts that must never be printed.
 * @returns For driver errors only the name and codes; otherwise `Name: message` with the secrets masked,
 * or a generic text for non-errors.
 */
export function safeMessage(error: unknown, secrets: readonly string[]): string {
  if (error instanceof Error && error.name.startsWith('Mongo')) {
    // Driver errors may echo hosts or credentials in their message: only name and codes leave.
    const { code, codeName } = error as { code?: unknown; codeName?: unknown };
    return [
      error.name,
      ...(typeof code === 'string' || typeof code === 'number' ? [`code=${code}`] : []),
      ...(typeof codeName === 'string' ? [`codeName=${codeName}`] : []),
    ].join(' ');
  }
  let text = error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown error';
  for (const secret of secrets) {
    text = text.split(secret).join('[redacted]');
  }
  return text;
}

/**
 * Entry point of the legacy profiling tool: loads the configuration and refuses to run unless `APP_ENV`
 * equals `--env` (`development` by default, `production` only on explicit request), reads the databases of every configured cluster with `secondaryPreferred` and writes the report to
 * a new file (by default under `backend/reports/`). Read-only on the cluster.
 *
 * @param argv Arguments after the script name: optionally `--env <development|production>` and `--out <path>`.
 * @param deps Process dependencies.
 * @returns The exit code: 0 on success, 1 on any error (messages never contain the URI).
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

  const destination = await chooseDestination(parsed.out, deps.cwd, config.appEnv, parsed.focus ?? 'profile');
  if (typeof destination === 'string') {
    deps.error(destination);
    return 1;
  }
  const { out } = destination;
  if (await exists(out)) {
    deps.error('Refusing to overwrite an existing output file');
    return 1;
  }

  let registry: ClusterRegistry | undefined;
  let exitCode = 0;
  try {
    // Building the clients is guarded too: a connection string the driver cannot parse throws here.
    // Every main client reads from secondaries, as the whole tool is read-only; only the main clients connect.
    const createClient = deps.createClient ?? createMongoClient;
    registry = createClusterClients(config, (clientConfig, options) => createClient(clientConfig, { readPreference: 'secondaryPreferred', ...options }));
    await Promise.all([...registry.clusters.values()].map((clients) => clients.main.connect()));
    const databases = createDatabases(registry, { prefix: config.dbNamePrefix, appEnv: config.appEnv });
    let report: unknown;
    if (parsed.focus === 'catalog') {
      let found = 0;
      for (const clusterId of databases.clusterIds) {
        found += (await databases.listGroupIds(clusterId)).length;
      }
      deps.error(`Profiling catalog of ${config.appEnv}: ${found} group databases found on ${databases.clusterIds.length} cluster(s), read-only${parsed.sample === undefined ? '' : `, sample of ${Math.min(parsed.sample, found)}`}`);
      report = await profileCatalog(databases, {
        appEnv: config.appEnv,
        ...(parsed.sample === undefined ? {} : { sample: parsed.sample }),
        ...(deps.progressEvery === undefined ? {} : { progressEvery: deps.progressEvery }),
        onProgress: (done, total) => deps.error(`profiled ${done}/${total} group databases`),
      });
    } else if (parsed.focus === 'subobjects') {
      deps.error(`Profiling sub-objects of ${config.appEnv}: common users and groups, read-only`);
      report = await profileSubobjects(databases.common(), { appEnv: config.appEnv });
    } else {
      let found = 0;
      for (const clusterId of databases.clusterIds) {
        found += (await databases.listGroupIds(clusterId)).length;
      }
      deps.error(`Profiling ${config.appEnv}: ${found} group databases found on ${databases.clusterIds.length} cluster(s), read-only`);
      report = await profileLegacy(databases, {
        appEnv: config.appEnv,
        ...(deps.progressEvery === undefined ? {} : { progressEvery: deps.progressEvery }),
        onProgress: (done, total) => deps.error(`profiled ${done}/${total} group databases`),
      });
    }
    if (destination.createFolder) {
      await mkdir(dirname(out), { recursive: true });
    }
    await writeFile(out, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    deps.info(`Report written to ${out}`);
  } catch (error) {
    deps.error(safeMessage(error, secrets));
    exitCode = 1;
  }
  if (registry !== undefined) {
    await closeClusters(registry, (_clusterId, error) => deps.error(safeMessage(error, secrets)));
  }
  return exitCode;
}
