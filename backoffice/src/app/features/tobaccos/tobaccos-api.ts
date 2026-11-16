import { HttpClient, HttpHeaders } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiData } from '../../core/api/api.types';
import { TobaccoImportResult } from './tobaccos.types';

/** The writes on the national tobacco price list (the table is read with `httpResource` in the page). */
@Service()
export class TobaccosApi {
  private readonly http = inject(HttpClient);

  /**
   * Replaces the whole list with the products of an XLSX file (`POST /v1/tobaccos/import`, `multipart/form-data`, one `file` part).
   *
   * @param file The file.
   * @param key The `Idempotency-Key` of this submission (the same one on every retry of it).
   * @returns The counts and the time the server took.
   * @throws ApiError `413` too large, `415` not an XLSX, `422` with the rows that are not valid, `429` too many imports.
   */
  async import(file: File, key: string): Promise<TobaccoImportResult> {
    const body = new FormData();
    body.append('file', file, file.name);
    const response = await firstValueFrom(
      this.http.post<ApiData<TobaccoImportResult>>('/v1/tobaccos/import', body, {
        headers: new HttpHeaders({ 'Idempotency-Key': key }),
      }),
    );
    return response.data;
  }
}
