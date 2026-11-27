import type { AppEnv } from '../config.ts';

/** What every database name depends on: the configured prefix and the execution environment. */
export interface DatabaseNameContext {
  /** Value of `DB_NAME_PREFIX` (possibly empty). */
  readonly prefix: string;
  /** Value of `APP_ENV`. */
  readonly appEnv: AppEnv;
}

/**
 * Name of the common database (identity, tenancy, security; also holds the worker lease).
 * This module is the only place that builds database names.
 *
 * @param context Prefix and environment.
 * @returns `<prefix><appEnv>_common`.
 * @example
 * commonDatabaseName({ prefix: '', appEnv: 'development' }); // 'development_common'
 */
export function commonDatabaseName(context: DatabaseNameContext): string {
  return `${context.prefix}${context.appEnv}_common`;
}

/**
 * Name of the legacy send queue database (the electronic invoices waiting to be sent).
 *
 * @param context Prefix and environment.
 * @returns `<prefix><appEnv>_queue`.
 * @example
 * queueDatabaseName({ prefix: '', appEnv: 'development' }); // 'development_queue'
 */
export function queueDatabaseName(context: DatabaseNameContext): string {
  return `${context.prefix}${context.appEnv}_queue`;
}

/**
 * Name of the database of one group (its documents, including the fiscal documents the queue copies).
 *
 * @param context Prefix and environment.
 * @param groupId The group id as 24 lowercase hexadecimal characters.
 * @returns `<prefix><appEnv>_<groupId>`.
 * @example
 * groupDatabaseName({ prefix: '', appEnv: 'development' }, '0123456789abcdef01234567'); // 'development_0123456789abcdef01234567'
 */
export function groupDatabaseName(context: DatabaseNameContext, groupId: string): string {
  return `${context.prefix}${context.appEnv}_${groupId}`;
}
