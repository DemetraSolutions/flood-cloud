import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiData } from '../../core/api/api.types';
import { SyncOptions, SyncOutcome } from './tobacco-sync.types';

/** The write of the synchronization of the tobaccos (the state is read with `httpResource` in the page). */
@Service()
export class TobaccoSyncApi {
  private readonly http = inject(HttpClient);

  /**
   * Synchronizes the national price list into the tobaccos of the group, or only counts what it would do.
   *
   * @param groupId The group.
   * @param options The options of the synchronization.
   * @param key The `Idempotency-Key` of this submission (the same on every retry of it).
   * @param dryRun `true` to only count.
   * @returns The counts.
   * @throws ApiError `403`, `409` (a precondition or another synchronization running), `413`, `422`, `429`.
   */
  async sync(
    groupId: string,
    options: SyncOptions,
    key: string,
    dryRun: boolean,
  ): Promise<SyncOutcome> {
    const response = await firstValueFrom(
      this.http.post<ApiData<SyncOutcome>>(
        `/v1/groups/${encodeURIComponent(groupId)}/tobacco-sync`,
        {
          warehouse: options.warehouse,
          noDiscount: options.noDiscount,
          placeIds: options.placeIds,
          ...(options.confirmMassDisable === true ? { confirmMassDisable: true } : {}),
        },
        {
          headers: new HttpHeaders({ 'Idempotency-Key': key }),
          ...(dryRun ? { params: new HttpParams().set('dryRun', 'true') } : {}),
        },
      ),
    );
    return response.data;
  }
}
