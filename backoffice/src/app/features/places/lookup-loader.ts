import { ApiPage } from '../../core/api/api.types';
import { ReferenceItem } from '../../core/reference/reference-api';
import { ReferenceKind, ReferenceStore } from '../../core/reference/reference-store';

/** Pages of 100 items a select reads at most: the lists of the group are read whole, but never without a limit. */
export const MAX_LOOKUP_PAGES = 5;

/**
 * Every item of a reference list of a group (companies, places, categories), read page by page
 * from the reference store, up to {@link MAX_LOOKUP_PAGES} pages.
 *
 * @param store The reference store.
 * @param groupId Group of the list.
 * @param kind Which list.
 */
export async function loadAll(
  store: ReferenceStore,
  groupId: string,
  kind: ReferenceKind,
): Promise<ReferenceItem[]> {
  const items: ReferenceItem[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page: ApiPage<ReferenceItem> = await store.page(groupId, kind, { limit: 100, cursor });
    items.push(...page.data);
    cursor = page.page.next;
    pages++;
  } while (cursor !== null && pages < MAX_LOOKUP_PAGES);
  return items;
}
