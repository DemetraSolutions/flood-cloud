import { HttpClient } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { firstValueFrom } from 'rxjs';

/** The export of the diagnostic table (`GET /v1/diagnostics/devices.csv`). */
@Service()
export class DiagnosticsApi {
  private readonly http = inject(HttpClient);

  /**
   * Downloads the CSV of the devices with the given filters (no limit, no cursor).
   *
   * @param filters Filters of the table (`groupId`, `companyId`, `placeId`, `type`, `q`).
   * @returns The CSV file.
   * @throws ApiError When the request fails (`413` too many rows, `429` too many requests…).
   */
  download(filters: Readonly<Record<string, string>>): Promise<Blob> {
    return firstValueFrom(
      this.http.get('/v1/diagnostics/devices.csv', {
        params: filters,
        responseType: 'blob',
      }),
    );
  }
}

/** Delay before the temporary address of a download is released: one turn of the event loop after the click. */
const REVOKE_DELAY_MS = 0;

/**
 * Offers a file to the browser as a download and releases the temporary address afterwards.
 *
 * @param blob Content of the file.
 * @param filename Name proposed to the user.
 */
export function saveFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
  } finally {
    // Some browsers cancel the download when the address is released in the same turn as the click.
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
  }
}
