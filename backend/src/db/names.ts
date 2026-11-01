import { ObjectId } from 'mongodb';
import type { AppEnv } from '../config.ts';

/** What every database name depends on: the configured prefix and the execution environment. */
export interface DatabaseNameContext {
  /** Value of `DB_NAME_PREFIX` (possibly empty). */
  readonly prefix: string;
  /** Value of `APP_ENV`. */
  readonly appEnv: AppEnv;
}

/** Exactly 24 lowercase hexadecimal characters: the only accepted textual group id. */
export const GROUP_ID_PATTERN = /^[0-9a-f]{24}$/;

/**
 * Name of the common database (identity, tenancy, security).
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
 * Name of the operational database of a group.
 *
 * @param context Prefix and environment.
 * @param groupId The group id as an `ObjectId` or as exactly 24 lowercase hex characters.
 * @returns `<prefix><appEnv>_<groupId hex>`.
 * @throws {Error} If `groupId` is a string that is not 24 lowercase hex characters.
 */
export function groupDatabaseName(context: DatabaseNameContext, groupId: ObjectId | string): string {
  let hex: string;
  if (groupId instanceof ObjectId) {
    hex = groupId.toHexString();
  } else if (GROUP_ID_PATTERN.test(groupId)) {
    hex = groupId;
  } else {
    throw new Error('Invalid group id: expected 24 lowercase hexadecimal characters');
  }
  return `${context.prefix}${context.appEnv}_${hex}`;
}

/**
 * Extracts the group id from the name of a group database.
 * The group id of a document is never trusted; this derives it from the database name.
 *
 * @param context Prefix and environment.
 * @param name A database name.
 * @returns The group id, or `null` if the name is not a group database of this environment.
 */
export function parseGroupDatabaseName(context: DatabaseNameContext, name: string): ObjectId | null {
  const head = `${context.prefix}${context.appEnv}_`;
  if (!name.startsWith(head)) {
    return null;
  }
  const hex = name.slice(head.length);
  return GROUP_ID_PATTERN.test(hex) ? ObjectId.createFromHexString(hex) : null;
}
