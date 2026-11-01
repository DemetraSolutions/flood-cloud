import type { Db, MongoClient, ObjectId } from 'mongodb';
import { commonDatabaseName, groupDatabaseName, parseGroupDatabaseName } from './names.ts';
import type { DatabaseNameContext } from './names.ts';

/** Escapes a string for literal use inside a regular expression. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** MongoDB rejects database names longer than 63 bytes. */
export const MAX_DATABASE_NAME_BYTES = 63;

/** Upper bound for the administrative commands (listing databases, server version) in milliseconds. */
const ADMIN_MAX_TIME_MS = 30_000;

/**
 * Environment guard: accepts only `^<prefix><appEnv>_(common|<24 hex>)$`, at most 63 bytes long.
 * It keeps `production_*` databases out of reach when `APP_ENV=development` and vice versa.
 *
 * @param name Database name to check.
 * @param context Prefix and environment.
 * @throws {Error} If the name does not belong to this environment (the message never contains the URI).
 */
export function assertAllowedDatabaseName(name: string, context: DatabaseNameContext): void {
  const allowed = new RegExp(`^${escapeRegExp(context.prefix)}${escapeRegExp(context.appEnv)}_(common|[0-9a-f]{24})$`);
  if (!allowed.test(name) || Buffer.byteLength(name) > MAX_DATABASE_NAME_BYTES) {
    throw new Error(`Database "${name}" is not allowed in environment "${context.appEnv}"`);
  }
}

/** The only way to obtain a `Db` handle. */
export interface Databases {
  /** The common database (identity, tenancy, security). */
  common(): Db;
  /**
   * The operational database of a group.
   *
   * @param groupId Group id taken from the authenticated context or from a database name.
   */
  group(groupId: ObjectId): Db;
  /**
   * Ids of the group databases that exist on the server for this prefix and environment
   * (names are parsed, never trusted), sorted by hex.
   */
  listGroupIds(): Promise<ObjectId[]>;
  /**
   * Counts the databases that are neither the common database nor a group database of this
   * environment. Only counts leave: the names never do.
   *
   * @returns `flite_common` and `queue` (the other products' databases of this environment) and `other`.
   */
  countOtherDatabases(): Promise<Record<'flite_common' | 'queue' | 'other', number>>;
  /** Version string of the MongoDB server. */
  serverVersion(): Promise<string>;
}

/**
 * Builds the database accessor. Every name is built by `names.ts` and passes
 * {@link assertAllowedDatabaseName}; no other module may call the driver's database selector.
 *
 * @param client The process-wide client.
 * @param context Prefix and environment from the configuration.
 * @returns The accessor.
 * @throws {Error} From `common()` / `group()` if the resulting name is not allowed.
 */
export function createDatabases(client: MongoClient, context: DatabaseNameContext): Databases {
  const open = (name: string): Db => {
    assertAllowedDatabaseName(name, context);
    return client.db(name);
  };
  const listNames = async (): Promise<string[]> => {
    const { databases } = await client.db().admin().listDatabases({ nameOnly: true, maxTimeMS: ADMIN_MAX_TIME_MS });
    return databases.map((entry) => entry.name);
  };
  return {
    common: () => open(commonDatabaseName(context)),
    group: (groupId) => open(groupDatabaseName(context, groupId)),
    listGroupIds: async () => {
      const ids: ObjectId[] = [];
      for (const name of await listNames()) {
        const id = parseGroupDatabaseName(context, name);
        if (id !== null) {
          ids.push(id);
        }
      }
      return ids.sort((a, b) => a.toHexString().localeCompare(b.toHexString()));
    },
    countOtherDatabases: async () => {
      const counts = { flite_common: 0, queue: 0, other: 0 };
      const head = `${context.prefix}${context.appEnv}_`;
      for (const name of await listNames()) {
        if (name === commonDatabaseName(context) || parseGroupDatabaseName(context, name) !== null) {
          continue;
        }
        if (name === `${head}flite_common`) {
          counts.flite_common += 1;
        } else if (name === `${head}queue`) {
          counts.queue += 1;
        } else {
          counts.other += 1;
        }
      }
      return counts;
    },
    serverVersion: async () => {
      const info = await client.db().admin().command({ buildInfo: 1, maxTimeMS: ADMIN_MAX_TIME_MS });
      return String(info['version']);
    },
  };
}
