import { HttpClient, HttpHeaders, HttpResponse } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiData } from '../../core/api/api.types';
import {
  EInvoicingAccount,
  EInvoicingAccountChange,
  VersionedAccount,
} from './einvoicing-account.types';

/**
 * Reads and writes the Aruba account of a dealer or of the platform (PSA only). A write or a
 * removal presents the version read in `If-Match`. The password is only ever sent, never read.
 */
@Service()
export class EInvoicingAccountsApi {
  private readonly http = inject(HttpClient);

  /**
   * The account with its version.
   *
   * @param dealerId The dealer, or `null` for the platform account.
   * @throws ApiError `404` when the dealer does not exist.
   */
  async read(dealerId: string | null): Promise<VersionedAccount> {
    return versioned(
      await firstValueFrom(
        this.http.get<ApiData<EInvoicingAccount>>(accountUrl(dealerId), { observe: 'response' }),
      ),
    );
  }

  /**
   * Creates or changes the account.
   *
   * @param dealerId The dealer, or `null` for the platform account.
   * @param change New values; no `password` keeps the stored one.
   * @param etag Version read, sent in `If-Match`.
   * @throws ApiError `412` when the account changed meanwhile, `409` with `username` taken, `422`
   *   with the fields refused, `503` when the server has no encryption key.
   */
  async write(
    dealerId: string | null,
    change: EInvoicingAccountChange,
    etag: string | null,
  ): Promise<VersionedAccount> {
    return versioned(
      await firstValueFrom(
        this.http.put<ApiData<EInvoicingAccount>>(accountUrl(dealerId), change, {
          headers: ifMatch(etag),
          observe: 'response',
        }),
      ),
    );
  }

  /**
   * Removes the account.
   *
   * @param dealerId The dealer, or `null` for the platform account.
   * @param etag Version read, sent in `If-Match`.
   * @throws ApiError `412` when it changed meanwhile, `404` when it does not exist.
   */
  async remove(dealerId: string | null, etag: string | null): Promise<void> {
    await firstValueFrom(this.http.delete<void>(accountUrl(dealerId), { headers: ifMatch(etag) }));
  }
}

function accountUrl(dealerId: string | null): string {
  return dealerId === null
    ? '/v1/settings/integrations/aruba'
    : `/v1/dealers/${encodeURIComponent(dealerId)}/integrations/aruba`;
}

function ifMatch(etag: string | null): HttpHeaders {
  return etag === null ? new HttpHeaders() : new HttpHeaders({ 'If-Match': etag });
}

function versioned(response: HttpResponse<ApiData<EInvoicingAccount>>): VersionedAccount {
  return {
    value: (response.body as ApiData<EInvoicingAccount>).data,
    etag: response.headers.get('ETag'),
  };
}
