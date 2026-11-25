import { HttpClient, HttpHeaders, HttpResponse } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiData } from '../../core/api/api.types';
import {
  Coordinates,
  GeocodingAddress,
  SatispayResult,
  TshCategory,
  TshSyncResult,
  VatLookup,
} from './integrations.types';

/** Name of the header that makes a request safe to repeat. */
export const IDEMPOTENCY_HEADER = 'Idempotency-Key';

/**
 * The calls of the integrations module. Nothing here talks to a provider: the browser only asks
 * the backend, which calls the provider with the credentials the place keeps. The terminals of
 * Dojo are read with `httpResource` by their component.
 */
@Service()
export class IntegrationsApi {
  private readonly http = inject(HttpClient);

  /** URL of the integrations of a place. */
  placeUrl(groupId: string, placeId: string): string {
    return `/v1/groups/${encodeURIComponent(groupId)}/places/${encodeURIComponent(placeId)}`;
  }

  /**
   * Activates Satispay for a place: the backend exchanges the one-time code for a key and keeps
   * it; the code is never kept.
   *
   * @param groupId Group of the place.
   * @param placeId The place.
   * @param activationCode The code the shop owner generated in the Satispay app.
   * @param key The `Idempotency-Key` of this attempt (the same one when the user repeats it).
   * @param etag Version of the place the user is editing.
   * @returns The new version of the place, `null` when it changed meanwhile.
   * @throws ApiError `412` when the version is not the current one, `422` with details on the
   *   fields, `429`, `502` when the provider cannot be reached, `503` when it is not available.
   */
  async activateSatispay(
    groupId: string,
    placeId: string,
    activationCode: string,
    key: string,
    etag: string | null,
  ): Promise<SatispayResult> {
    const response = await firstValueFrom(
      this.http.post<ApiData<{ keyIdSet: boolean }>>(
        `${this.placeUrl(groupId, placeId)}/integrations/satispay/activation`,
        { activationCode },
        { headers: headers({ [IDEMPOTENCY_HEADER]: key }, etag), observe: 'response' },
      ),
    );
    return { etag: response.headers.get('ETag') };
  }

  /**
   * Downloads the categories of charge of TS Hospitality and keeps them as the copy of the place.
   *
   * @param groupId Group of the place.
   * @param placeId The place.
   * @param etag Version of the place the user is editing.
   * @returns The categories and the new version of the place.
   * @throws ApiError As {@link activateSatispay}.
   */
  async syncTshCategories(groupId: string, placeId: string, etag: string | null): Promise<TshSyncResult> {
    const response: HttpResponse<ApiData<TshCategory[]>> = await firstValueFrom(
      this.http.post<ApiData<TshCategory[]>>(
        `${this.placeUrl(groupId, placeId)}/integrations/tsh/charge-categories/sync`,
        null,
        { headers: headers({}, etag), observe: 'response' },
      ),
    );
    return { categories: (response.body as ApiData<TshCategory[]>).data, etag: response.headers.get('ETag') };
  }

  /**
   * Finds the coordinates of an address of a place that exists; nothing is saved.
   *
   * @param groupId Group of the place.
   * @param placeId The place.
   * @param address The five fields of the address.
   * @throws ApiError `422` when a field is missing or the address is not found, `429`, `502`, `503`.
   */
  async geocode(groupId: string, placeId: string, address: GeocodingAddress): Promise<Coordinates> {
    const response = await firstValueFrom(
      this.http.post<ApiData<Coordinates>>(`${this.placeUrl(groupId, placeId)}/geocoding`, address),
    );
    return response.data;
  }

  /**
   * Looks a company up by its Italian VAT number (`GET /v1/vat-lookups/{vatNumber}`).
   *
   * @param vatNumber The 11 digits of the VAT number.
   * @returns The subject with exactly that VAT number.
   * @throws ApiError `404` when no subject has it, `422` when it is not valid, `429` when the
   *   limit is reached, `502` or `503` when the service is not available.
   */
  async lookupVat(vatNumber: string): Promise<VatLookup> {
    const response = await firstValueFrom(
      this.http.get<ApiData<VatLookup>>(`/v1/vat-lookups/${encodeURIComponent(vatNumber)}`),
    );
    return response.data;
  }
}

function headers(extra: Record<string, string>, etag: string | null): HttpHeaders {
  return new HttpHeaders(etag === null ? extra : { ...extra, 'If-Match': etag });
}
