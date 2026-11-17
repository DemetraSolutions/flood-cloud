import { HttpClient } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { firstValueFrom } from 'rxjs';

/** The export of the error documents (`GET /v1/error-documents.csv`). */
@Service()
export class ErrorDocumentsApi {
  private readonly http = inject(HttpClient);

  /**
   * Downloads the CSV of the documents in error with the given filters (no limit, no cursor).
   *
   * @param filters Filters of the table (`groupId`, `dealerId`, `documentType`, `errorCode`).
   * @returns The CSV file.
   * @throws ApiError When the request fails (`413` too many rows, `429` too many requests…).
   */
  download(filters: Readonly<Record<string, string>>): Promise<Blob> {
    return firstValueFrom(
      this.http.get('/v1/error-documents.csv', { params: filters, responseType: 'blob' }),
    );
  }
}
