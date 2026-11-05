import { HttpClient } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiData } from '../../core/api/api.types';
import { Profile } from '../../core/session/session.types';

/** Fields of `PATCH /v1/me` (JSON Merge Patch: only what changed; `null` clears). */
export interface ProfilePatch {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  language?: string;
}

/** Writes to the current user's own profile (`/v1/me*`). Reads use `httpResource` in the pages. */
@Service()
export class ProfileApi {
  private readonly http = inject(HttpClient);

  /** Updates the profile and returns the stored one. */
  async update(patch: ProfilePatch): Promise<Profile> {
    const response = await firstValueFrom(this.http.patch<ApiData<Profile>>('/v1/me', patch));
    return response.data;
  }

  /** Changes the password of the current user (`204`). */
  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    await firstValueFrom(this.http.put<void>('/v1/me/password', { currentPassword, newPassword }));
  }

  /** Revokes another session of the current user (`204`). */
  async revokeSession(sessionId: string): Promise<void> {
    await firstValueFrom(
      this.http.delete<void>(`/v1/me/sessions/${encodeURIComponent(sessionId)}`),
    );
  }
}
