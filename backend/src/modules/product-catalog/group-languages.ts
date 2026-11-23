import type { ObjectId } from 'mongodb';
import type { Databases } from '../../db/databases.ts';
import { LIST_MAX_TIME_MS } from '../../shared/http/list.ts';
import { bounded } from '../../shared/security/scope/bounded.ts';
import { groupLanguagesOf } from './texts.ts';

/** Reads the languages a group works in. */
export interface GroupLanguages {
  /**
   * The languages of a group, in order (`settings.languages` of its document in the common database): at least one, `it` when the group lists none.
   *
   * @param groupId Id of the group, from a verified access.
   */
  of(groupId: ObjectId): Promise<string[]>;
}

/**
 * Builds the reader of the languages of a group.
 *
 * @param databases Database accessor.
 */
export function createGroupLanguages(databases: Databases): GroupLanguages {
  return {
    of: async (groupId) => {
      const group = await bounded(() => databases.common().collection('groups').findOne({ _id: groupId }, { projection: { 'settings.languages': 1 }, maxTimeMS: LIST_MAX_TIME_MS }));
      return groupLanguagesOf((group?.['settings'] as { languages?: unknown } | undefined)?.languages);
    },
  };
}
