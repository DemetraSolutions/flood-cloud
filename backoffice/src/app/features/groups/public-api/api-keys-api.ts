import { HttpClient } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiData } from '../../../core/api/api.types';
import { ApiKey, ApiKeyCreateBody, ApiKeyPatch } from './api-key.types';

/** A key just created, with the secret the backend shows only in this response. */
export interface CreatedApiKey {
  /** The key as the list shows it. */
  readonly key: ApiKey;
  /** The secret: the caller shows it once and forgets it; nothing here keeps, logs or caches it. */
  readonly secret: string;
}

/**
 * Writes on the public API keys of a group (`/v1/groups/{groupId}/api-keys`); the list and the
 * usage are read with `httpResource` by their components. The secret of a new key travels only in
 * the response of {@link create}, which hands it to the caller.
 */
@Service()
export class ApiKeysApi {
  private readonly http = inject(HttpClient);

  /** Base URL of the keys of a group. */
  url(groupId: string): string {
    return `/v1/groups/${encodeURIComponent(groupId)}/api-keys`;
  }

  /**
   * Creates a key.
   *
   * @throws ApiError `FORBIDDEN` (a limit sent by a dealer), `CONFLICT` (50 active keys),
   *   `VALIDATION_ERROR` per field, `RATE_LIMITED`.
   */
  async create(groupId: string, body: ApiKeyCreateBody): Promise<CreatedApiKey> {
    const response = await firstValueFrom(
      this.http.post<ApiData<ApiKey & { secret: string }>>(this.url(groupId), body),
    );
    const { secret, ...key } = response.data;
    return { key, secret };
  }

  /**
   * Changes a key; resolves with the whole updated key.
   *
   * @throws ApiError `CONFLICT` when the key is revoked or expired.
   */
  async update(groupId: string, keyId: string, patch: ApiKeyPatch): Promise<ApiKey> {
    const response = await firstValueFrom(
      this.http.patch<ApiData<ApiKey>>(`${this.url(groupId)}/${encodeURIComponent(keyId)}`, patch),
    );
    return response.data;
  }

  /** Revokes a key (idempotent); resolves with the revoked key. */
  async revoke(groupId: string, keyId: string): Promise<ApiKey> {
    const response = await firstValueFrom(
      this.http.post<ApiData<ApiKey>>(
        `${this.url(groupId)}/${encodeURIComponent(keyId)}/revoke`,
        null,
      ),
    );
    return response.data;
  }
}
