import { HttpClient } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiData } from '../../core/api/api.types';
import { ReferenceStore } from '../../core/reference/reference-store';
import { GroupTrashKind, TrashEmptyResponse, TrashResponse } from './trash.types';

/**
 * Bulk operations on the trash. The lists of the tabs are read with `httpResource` in the page.
 * The calls carry no `If-Match` (the selections come from lists without versions): the server
 * checks every item atomically, and one that cannot be handled is skipped with its reason. A write
 * that can change the compact lists of companies, places and contacts makes the reference store
 * read them again.
 */
@Service()
export class TrashApi {
  private readonly http = inject(HttpClient);
  private readonly store = inject(ReferenceStore);

  /**
   * Restores items of the trash of a group (`POST /v1/groups/{groupId}/trash/{kind}/restore`).
   *
   * @param groupId Group of the items.
   * @param kind Kind of the items.
   * @param ids Between 1 and 100 ids.
   */
  restore(groupId: string, kind: GroupTrashKind, ids: readonly string[]): Promise<TrashResponse> {
    return this.write(groupId, kind, 'restore', { ids });
  }

  /**
   * Deletes items of the trash of a group for good (`POST /v1/groups/{groupId}/trash/{kind}/delete`).
   *
   * @param groupId Group of the items.
   * @param kind Kind of the items.
   * @param ids Between 1 and 100 ids.
   */
  remove(groupId: string, kind: GroupTrashKind, ids: readonly string[]): Promise<TrashResponse> {
    return this.write(groupId, kind, 'delete', { ids });
  }

  /**
   * Deletes the next items of a kind from the trash of a group (`…/trash/{kind}/empty`, platform
   * administrators only; no body): the server handles at most 200 per call and says how many are left.
   *
   * @param groupId Group whose trash is emptied.
   * @param kind Kind of the items.
   * @param after The `next` of the previous call (none for the first one).
   */
  empty(groupId: string, kind: GroupTrashKind, after?: string): Promise<TrashEmptyResponse> {
    return this.write<TrashEmptyResponse>(
      groupId,
      kind,
      'empty',
      after === undefined ? null : { after },
    );
  }

  /**
   * Restores groups from the platform trash (`POST /v1/trash/groups/restore`). Groups are never
   * deleted for good.
   *
   * @param ids Between 1 and 100 ids.
   */
  async restoreGroups(ids: readonly string[]): Promise<TrashResponse> {
    const response = await firstValueFrom(
      this.http.post<ApiData<TrashResponse>>('/v1/trash/groups/restore', { ids }),
    );
    return response.data;
  }

  private async write<T extends TrashResponse = TrashResponse>(
    groupId: string,
    kind: GroupTrashKind,
    action: 'restore' | 'delete' | 'empty',
    body: object | null,
  ): Promise<T> {
    const response = await firstValueFrom(
      this.http.post<ApiData<T>>(
        `/v1/groups/${encodeURIComponent(groupId)}/trash/${kind}/${action}`,
        body,
      ),
    );
    if (kind === 'companies' || kind === 'places') {
      this.store.invalidate(groupId, kind);
    } else if (kind === 'contacts') {
      this.store.invalidate(groupId, 'customers');
      this.store.invalidate(groupId, 'suppliers');
    }
    return response.data;
  }
}
