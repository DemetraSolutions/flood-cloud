import { HttpClient } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { StatementSection } from './activations.types';

/**
 * The CSV export of a statement and the writes of the activations (`/v1/activations/...`, the
 * writes for platform administrators). The reads of the summary and of the statements use
 * `httpResource` in the pages.
 */
@Service()
export class ActivationsApi {
  private readonly http = inject(HttpClient);

  /**
   * Downloads the CSV of the lines of one dealer for an invoice month and section.
   *
   * @param dealer Dealer id, or `none` for the groups without a dealer.
   * @param month Invoice month (`YYYY-MM`).
   * @param section The section to export.
   * @returns The CSV file.
   * @throws ApiError When the request fails (`413` too many rows, `429` too many requests…).
   */
  downloadStatement(dealer: string, month: string, section: StatementSection): Promise<Blob> {
    return firstValueFrom(
      this.http.get(`/v1/activations/statements/${encodeURIComponent(dealer)}.csv`, {
        params: { month, section },
        responseType: 'blob',
      }),
    );
  }

  /**
   * Downloads the CSV of the detail of the activations of a period.
   *
   * @param filters `from`, `to` and, when set, `dealerId` (no limit, no cursor).
   * @throws ApiError When the request fails (`409` too many lines, `429` too many requests…).
   */
  downloadLines(filters: Readonly<Record<string, string>>): Promise<Blob> {
    return firstValueFrom(
      this.http.get('/v1/activations/lines.csv', { params: filters, responseType: 'blob' }),
    );
  }

  /** Freezes the renewal base of a year. */
  async freezeBase(year: number): Promise<void> {
    await firstValueFrom(this.http.put<unknown>(this.baseUrl(year), null));
  }

  /** Unfreezes the renewal base of a year (`409` while a month of the year is closed). */
  async unfreezeBase(year: number): Promise<void> {
    await firstValueFrom(this.http.delete<unknown>(this.baseUrl(year)));
  }

  /** Closes an invoice month for every dealer. */
  async closeMonth(month: string): Promise<void> {
    await firstValueFrom(this.http.put<unknown>(this.closureUrl(month), null));
  }

  /** Reopens a closed invoice month. */
  async reopenMonth(month: string): Promise<void> {
    await firstValueFrom(this.http.delete<unknown>(this.closureUrl(month)));
  }

  private baseUrl(year: number): string {
    return `/v1/activations/renewal-bases/${year}`;
  }

  private closureUrl(month: string): string {
    return `/v1/activations/closures/${month}`;
  }
}
