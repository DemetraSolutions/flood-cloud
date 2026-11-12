import { HttpClient } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiData } from '../../core/api/api.types';
import { Group, GroupPatch } from './group.types';

/** An action on the state of a group (platform administrators only). */
export type GroupStateAction = 'suspend' | 'reactivate' | 'trash' | 'restore';

/** Writes on `/v1/groups/{groupId}`. Reads use `httpResource` in the pages. */
@Service()
export class GroupsApi {
  private readonly http = inject(HttpClient);

  private url(groupId: string, path = ''): string {
    return `/v1/groups/${encodeURIComponent(groupId)}${path}`;
  }

  /** Updates a group with a JSON Merge Patch; resolves with the whole updated group. */
  async update(groupId: string, patch: GroupPatch): Promise<Group> {
    const response = await firstValueFrom(
      this.http.patch<ApiData<Group>>(this.url(groupId), patch),
    );
    return response.data;
  }

  /**
   * Suspends, reactivates, trashes or restores a group.
   *
   * @throws ApiError `CONFLICT` when the group is already (or not) in that state.
   */
  async changeState(groupId: string, action: GroupStateAction): Promise<void> {
    switch (action) {
      case 'suspend':
        await firstValueFrom(this.http.post(this.url(groupId, '/suspension'), null));
        break;
      case 'reactivate':
        await firstValueFrom(this.http.delete<void>(this.url(groupId, '/suspension')));
        break;
      case 'trash':
        await firstValueFrom(this.http.post(this.url(groupId, '/trash'), null));
        break;
      case 'restore':
        await firstValueFrom(this.http.post(this.url(groupId, '/restore'), null));
        break;
    }
  }
}
