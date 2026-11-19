import { I18nService } from '../../core/i18n/i18n.service';
import { abbreviateId } from '../activity-log/activity-log.types';

/** What the "Gruppo" cell of a cross-group row shows: a label and the group it links to (`null`: no link). */
export interface GroupCell {
  readonly id: string | null;
  readonly label: string;
}

/**
 * The "Gruppo" cell of a row of a cross-group list: the name of the group with a link to it; a
 * dash without a link when the row has no group (a platform user) or the group does not exist
 * (`groupName: null`); a dash with the link when the group has no text name (`''`); the short id
 * when the server gave no name at all.
 *
 * @param i18n Translator (for the dash).
 * @param row The row, with its `groupId` and `groupName`.
 */
export function groupCell(
  i18n: Pick<I18nService, 't'>,
  row: { readonly groupId?: string | null; readonly groupName?: string | null },
): GroupCell {
  const id = row.groupId ?? null;
  const dash = i18n.t('CROSS_GROUP.NO_NAME');
  if (id === null || row.groupName === null) {
    return { id: null, label: dash };
  }
  return { id, label: row.groupName === undefined ? abbreviateId(id) : row.groupName || dash };
}
