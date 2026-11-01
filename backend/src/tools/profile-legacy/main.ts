import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { MongoClient } from 'mongodb';
import { APP_ENVS, loadDatabaseConfig } from '../../config.ts';
import type { AppEnv } from '../../config.ts';
import { createMongoClient } from '../../db/client.ts';
import { createDatabases } from '../../db/databases.ts';
import { profileLegacy } from './profile.ts';

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

const USAGE = 'Usage: node src/tools/profile-legacy/cli.ts [--env development|production] [--out <report.json>]';

/** The validated command line. */
interface Args {
  /** Environment the operator asked for; `development` unless `--env` says otherwise. */
  env: AppEnv;
  out?: string;
}

/**
 * Reads the command line: any order of `--out <path>` and `--env <development|production>`, each at most once.
 *
 * @returns The arguments, or `undefined` for anything else.
 */
function parseArgs(argv: readonly string[]): Args | undefined {
  let out: string | undefined;
  let env: AppEnv = 'development';
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
    } else {
      return undefined;
    }
  }
  return out === undefined ? { env } : { env, out };
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
 * `backend/reports/legacy-profile-<env>-<timestamp>.json`.
 *
 * @returns The destination, or an error message.
 */
async function chooseDestination(requested: string | undefined, cwd: string, env: AppEnv): Promise<Destination | string> {
  const root = await findRepoRoot(cwd);
  const reportsDir = root === undefined ? resolve(cwd, 'reports') : join(root, 'backend', 'reports');
  const stamp = new Date().toISOString().split(/[-:.]/).join('');
  const out = resolve(cwd, requested ?? join(reportsDir, `legacy-profile-${env}-${stamp}.json`));
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
 * equals `--env` (`development` by default, `production` only on explicit request), reads the databases with `secondaryPreferred` and writes the report to
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
  const uri = config.mongodbUri.reveal();

  const destination = await chooseDestination(parsed.out, deps.cwd, config.appEnv);
  if (typeof destination === 'string') {
    deps.error(destination);
    return 1;
  }
  const { out } = destination;
  if (await exists(out)) {
    deps.error('Refusing to overwrite an existing output file');
    return 1;
  }

  let client: MongoClient | undefined;
  let exitCode = 0;
  try {
    // Building the client is guarded too: a connection string the driver cannot parse throws here.
    client = (deps.createClient ?? createMongoClient)(config, { readPreference: 'secondaryPreferred' });
    await client.connect();
    const databases = createDatabases(client, { prefix: config.dbNamePrefix, appEnv: config.appEnv });
    deps.error(`Profiling ${config.appEnv}: ${(await databases.listGroupIds()).length} group databases found, read-only`);
    const report = await profileLegacy(databases, {
      appEnv: config.appEnv,
      ...(deps.progressEvery === undefined ? {} : { progressEvery: deps.progressEvery }),
      onProgress: (done, total) => deps.error(`profiled ${done}/${total} group databases`),
    });
    if (destination.createFolder) {
      await mkdir(dirname(out), { recursive: true });
    }
    await writeFile(out, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    deps.info(`Report written to ${out}`);
  } catch (error) {
    deps.error(safeMessage(error, [uri]));
    exitCode = 1;
  }
  if (client !== undefined) {
    await client.close();
  }
  return exitCode;
}
