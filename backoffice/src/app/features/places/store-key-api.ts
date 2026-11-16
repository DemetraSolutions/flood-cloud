import { HttpClient } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiData } from '../../core/api/api.types';
import { ActivationCode } from './store-key.types';

/**
 * Writes on the store key of a place (D-24): generating, cancelling and revoking. The activation
 * code travels only in the response of {@link createCode} and is handed to the caller; nothing
 * here keeps, logs or caches it.
 */
@Service()
export class StoreKeyApi {
  private readonly http = inject(HttpClient);

  /** URL of the store key of a place. */
  url(groupId: string, placeId: string): string {
    return `/v1/groups/${encodeURIComponent(groupId)}/places/${encodeURIComponent(placeId)}/store-key`;
  }

  /** Generates an activation code (replacing the pending one); the key in use keeps working. */
  async createCode(groupId: string, placeId: string): Promise<ActivationCode> {
    const response = await firstValueFrom(
      this.http.post<ApiData<ActivationCode>>(
        `${this.url(groupId, placeId)}/activation-codes`,
        null,
      ),
    );
    return response.data;
  }

  /** Cancels the pending activation code. */
  async cancelCode(groupId: string, placeId: string): Promise<void> {
    await firstValueFrom(this.http.delete<void>(`${this.url(groupId, placeId)}/activation-code`));
  }

  /** Revokes the active key: the store gets `401` at its next request. */
  async revoke(groupId: string, placeId: string): Promise<void> {
    await firstValueFrom(this.http.delete<void>(this.url(groupId, placeId)));
  }
}
