import { HttpClient } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiData } from '../../core/api/api.types';
import { UserArea, UserCreate, UserRecord, UserWrite } from './user.types';

/**
 * Writes on the user routes of `/v1` (the group area under `/v1/groups/{groupId}/users`, the
 * platform area under `/v1/users`). Reads use `httpResource` in the pages.
 */
@Service()
export class UsersApi {
  private readonly http = inject(HttpClient);

  /** Base URL of the users of an area. */
  baseUrl(area: UserArea): string {
    return area.kind === 'group'
      ? `/v1/groups/${encodeURIComponent(area.groupId)}/users`
      : '/v1/users';
  }

  /** URL of one user of an area. */
  userUrl(area: UserArea, userId: string): string {
    return `${this.baseUrl(area)}/${encodeURIComponent(userId)}`;
  }

  /** Creates a user (`201`). */
  async create(area: UserArea, body: UserCreate): Promise<UserRecord> {
    const response = await firstValueFrom(
      this.http.post<ApiData<UserRecord>>(this.baseUrl(area), body),
    );
    return response.data;
  }

  /** Updates a user with a JSON Merge Patch. */
  async update(area: UserArea, userId: string, patch: UserWrite): Promise<UserRecord> {
    const response = await firstValueFrom(
      this.http.patch<ApiData<UserRecord>>(this.userUrl(area, userId), patch),
    );
    return response.data;
  }

  /** Sets a new temporary password (`204`). */
  async setPassword(area: UserArea, userId: string, password: string): Promise<void> {
    await firstValueFrom(
      this.http.put<void>(`${this.userUrl(area, userId)}/password`, { password }),
    );
  }

  /** Moves a user to the trash. */
  async trash(area: UserArea, userId: string): Promise<UserRecord> {
    const response = await firstValueFrom(
      this.http.post<ApiData<UserRecord>>(`${this.userUrl(area, userId)}/trash`, null),
    );
    return response.data;
  }

  /** Restores a user from the trash. */
  async restore(area: UserArea, userId: string): Promise<UserRecord> {
    const response = await firstValueFrom(
      this.http.post<ApiData<UserRecord>>(`${this.userUrl(area, userId)}/restore`, null),
    );
    return response.data;
  }

  /** Permanently deletes a user (`204`; only from the trash). */
  async remove(area: UserArea, userId: string): Promise<void> {
    await firstValueFrom(this.http.delete<void>(this.userUrl(area, userId)));
  }

  /** Whether a username is free on the whole platform. */
  async isUsernameAvailable(username: string): Promise<boolean> {
    const response = await firstValueFrom(
      this.http.get<ApiData<{ available: boolean }>>(
        `/v1/usernames/${encodeURIComponent(username)}/availability`,
      ),
    );
    return response.data.available;
  }
}
