import { HttpClient, HttpHeaders, HttpResponse } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiData } from '../../core/api/api.types';
import { DealerPrices, PriceList, PriceOverrides, Versioned } from './price-list.types';

/**
 * Reads and writes the price list (`/v1/settings/price-list`) and the price overrides of a
 * dealer (`/v1/dealers/{dealerId}/price-overrides`), both PSA only. Every write presents the
 * version read in `If-Match` and resolves with the new value and its new version.
 */
@Service()
export class PriceListApi {
  private readonly http = inject(HttpClient);

  /** The price list with its version. */
  async read(): Promise<Versioned<PriceList>> {
    return versioned(
      await firstValueFrom(
        this.http.get<ApiData<PriceList>>('/v1/settings/price-list', { observe: 'response' }),
      ),
    );
  }

  /**
   * Replaces the price list.
   *
   * @throws ApiError `412` when the list changed meanwhile, `422` with the fields refused.
   */
  async write(list: PriceList, etag: string | null): Promise<Versioned<PriceList>> {
    return versioned(
      await firstValueFrom(
        this.http.put<ApiData<PriceList>>('/v1/settings/price-list', list, {
          headers: ifMatch(etag),
          observe: 'response',
        }),
      ),
    );
  }

  /** The overrides of a dealer, and the prices that result, with their version. */
  async readOverrides(dealerId: string): Promise<Versioned<DealerPrices>> {
    return versioned(
      await firstValueFrom(
        this.http.get<ApiData<DealerPrices>>(overridesUrl(dealerId), { observe: 'response' }),
      ),
    );
  }

  /**
   * Replaces the overrides of a dealer.
   *
   * @throws ApiError `412` when they changed meanwhile, `422` with the fields refused.
   */
  async writeOverrides(
    dealerId: string,
    overrides: PriceOverrides,
    etag: string | null,
  ): Promise<Versioned<DealerPrices>> {
    return versioned(
      await firstValueFrom(
        this.http.put<ApiData<DealerPrices>>(overridesUrl(dealerId), overrides, {
          headers: ifMatch(etag),
          observe: 'response',
        }),
      ),
    );
  }
}

function overridesUrl(dealerId: string): string {
  return `/v1/dealers/${encodeURIComponent(dealerId)}/price-overrides`;
}

function ifMatch(etag: string | null): HttpHeaders {
  return etag === null ? new HttpHeaders() : new HttpHeaders({ 'If-Match': etag });
}

function versioned<T>(response: HttpResponse<ApiData<T>>): Versioned<T> {
  return { value: (response.body as ApiData<T>).data, etag: response.headers.get('ETag') };
}
