import { HttpClient } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiData } from '../../core/api/api.types';
import { CompanyBody, DealerRecord } from './dealer.types';

/** Body of `POST /v1/dealers`. */
export interface DealerCreate {
  company: CompanyBody & { businessName: string };
  user: {
    username: string;
    password: string;
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
    language?: string;
  };
}

/** Writes on `/v1/dealers`. Reads use `httpResource` in the pages. */
@Service()
export class DealersApi {
  private readonly http = inject(HttpClient);

  /** Creates the dealer and its `D` user in one transaction (`201`). */
  async create(body: DealerCreate): Promise<DealerRecord> {
    const response = await firstValueFrom(
      this.http.post<ApiData<DealerRecord>>('/v1/dealers', body),
    );
    return response.data;
  }

  /** Updates the company data with a JSON Merge Patch. */
  async update(dealerId: string, patch: CompanyBody): Promise<DealerRecord> {
    const response = await firstValueFrom(
      this.http.patch<ApiData<DealerRecord>>(`/v1/dealers/${encodeURIComponent(dealerId)}`, patch),
    );
    return response.data;
  }
}
