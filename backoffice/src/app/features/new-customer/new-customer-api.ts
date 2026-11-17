import { HttpClient } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiData } from '../../core/api/api.types';
import { NewCustomerBody, NewCustomerResult, VatLookup } from './new-customer.types';

/** Name of the header that makes the creation idempotent. */
export const IDEMPOTENCY_HEADER = 'Idempotency-Key';

/** The creation of a new customer (`POST /v1/groups`). The lists the form needs are read in the page. */
@Service()
export class NewCustomerApi {
  private readonly http = inject(HttpClient);

  /**
   * Creates the group, its super administrator, the first company and the first place in one
   * operation. The same key with the same body answers with the stored result and never creates
   * a second group.
   *
   * @param body The request body.
   * @param key The idempotency key of this submission.
   * @returns The ids of what was created.
   * @throws ApiError When the request fails.
   */
  async create(body: NewCustomerBody, key: string): Promise<NewCustomerResult> {
    const response = await firstValueFrom(
      this.http.post<ApiData<NewCustomerResult>>('/v1/groups', body, {
        headers: { [IDEMPOTENCY_HEADER]: key },
      }),
    );
    return response.data;
  }

  /**
   * Looks a company up by its Italian VAT number (`GET /v1/vat-lookups/{vatNumber}`).
   *
   * @param vatNumber The 11 digits of the VAT number.
   * @returns The subject with exactly that VAT number.
   * @throws ApiError `404` when no subject has it, `422` when it is not valid, `429` when the
   *   limit is reached, `503` when the service is not available.
   */
  async lookupVat(vatNumber: string): Promise<VatLookup> {
    const response = await firstValueFrom(
      this.http.get<ApiData<VatLookup>>(`/v1/vat-lookups/${encodeURIComponent(vatNumber)}`),
    );
    return response.data;
  }
}
