import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiData } from '../../core/api/api.types';
import { ExportReferences, ImportOutcome } from './catalog-xlsx.types';

/** The XLSX import and export of the catalog of a group. */
@Service()
export class CatalogXlsxApi {
  private readonly http = inject(HttpClient);

  /**
   * Downloads the model: the three sheets with the headers only (the columns of the points of sale are made by the server for the group and the perimeter of the user).
   *
   * @param groupId The group.
   * @returns The XLSX file.
   * @throws ApiError `413` too many points of sale for the columns of the file, `429`.
   */
  template(groupId: string): Promise<Blob> {
    return firstValueFrom(
      this.http.get(`/v1/groups/${encodeURIComponent(groupId)}/catalog-export/template`, {
        responseType: 'blob',
      }),
    );
  }

  /**
   * Downloads the catalog as a workbook.
   *
   * @param groupId The group.
   * @param references Whether the columns that accept an id or a name are written with ids or with names.
   * @returns The XLSX file.
   * @throws ApiError `413` the catalog is above the limits of the file, `429` one export at a time and the hourly limit.
   */
  export(groupId: string, references: ExportReferences): Promise<Blob> {
    return firstValueFrom(
      this.http.get(`/v1/groups/${encodeURIComponent(groupId)}/catalog-export`, {
        params: new HttpParams().set('references', references),
        responseType: 'blob',
      }),
    );
  }

  /**
   * Checks (`dryRun`) or applies a workbook: all or nothing.
   *
   * @param groupId The group.
   * @param file The `.xlsx` file.
   * @param key The `Idempotency-Key` of this submission (the same on every retry of it).
   * @param dryRun `true` to only count what the file would do.
   * @returns The counts per sheet.
   * @throws ApiError `413`, `415`, `422` with the problems of the file, `409` another import running, `429`.
   */
  async import(groupId: string, file: File, key: string, dryRun: boolean): Promise<ImportOutcome> {
    const body = new FormData();
    body.append('file', file, file.name);
    const response = await firstValueFrom(
      this.http.post<ApiData<ImportOutcome>>(`/v1/groups/${encodeURIComponent(groupId)}/catalog-import`, body, {
        headers: new HttpHeaders({ 'Idempotency-Key': key }),
        ...(dryRun ? { params: new HttpParams().set('dryRun', 'true') } : {}),
      }),
    );
    return response.data;
  }
}
