import { HttpClient, HttpHeaders, HttpResponse } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiData } from '../../core/api/api.types';
import { Countries, Country } from '../../core/reference/countries';
import { CountryBody, VersionedCountry } from './countries.types';

/**
 * Reads and writes on the countries and their areas (`/v1/countries`, PSA only for the writes).
 * Every change of an existing country presents the version read in `If-Match` and resolves with
 * the updated country and its new version. A successful write reads the {@link Countries}
 * reference again, so that the selects of companies, places and the wizard see the change.
 */
@Service()
export class CountriesApi {
  private readonly http = inject(HttpClient);
  private readonly countries = inject(Countries);

  /** URL of a country, or of one of its areas. */
  url(code: string, areaCode?: string): string {
    const base = `/v1/countries/${encodeURIComponent(code)}`;
    return areaCode === undefined ? base : `${base}/areas/${encodeURIComponent(areaCode)}`;
  }

  /** One country with its areas and its version. */
  async read(code: string): Promise<VersionedCountry> {
    return versioned(
      await firstValueFrom(
        this.http.get<ApiData<Country>>(this.url(code), { observe: 'response' }),
      ),
    );
  }

  /** Creates a country (`201`). */
  async create(body: CountryBody): Promise<VersionedCountry> {
    const result = versioned(
      await firstValueFrom(
        this.http.post<ApiData<Country>>('/v1/countries', body, { observe: 'response' }),
      ),
    );
    this.countries.invalidate();
    return result;
  }

  /** Changes the name of a country. */
  rename(code: string, name: string, etag: string | null): Promise<VersionedCountry> {
    return this.change('patch', this.url(code), { name }, etag);
  }

  /** Adds an area to a country. */
  addArea(code: string, body: CountryBody, etag: string | null): Promise<VersionedCountry> {
    return this.change('post', `${this.url(code)}/areas`, body, etag);
  }

  /** Changes the name of an area. */
  renameArea(
    code: string,
    areaCode: string,
    name: string,
    etag: string | null,
  ): Promise<VersionedCountry> {
    return this.change('patch', this.url(code, areaCode), { name }, etag);
  }

  /** Removes an area from a country (`409` while a company or a place uses it). */
  removeArea(code: string, areaCode: string, etag: string | null): Promise<VersionedCountry> {
    return this.change('delete', this.url(code, areaCode), undefined, etag);
  }

  /** Deletes a country (`204`; `409` while a company or a place uses it). */
  async remove(code: string, etag: string | null): Promise<void> {
    await firstValueFrom(this.http.delete<void>(this.url(code), { headers: ifMatch(etag) }));
    this.countries.invalidate();
  }

  private async change(
    method: 'post' | 'patch' | 'delete',
    url: string,
    body: CountryBody | undefined,
    etag: string | null,
  ): Promise<VersionedCountry> {
    const options = { headers: ifMatch(etag), observe: 'response' as const };
    const response = await firstValueFrom(
      method === 'delete'
        ? this.http.delete<ApiData<Country>>(url, options)
        : this.http[method]<ApiData<Country>>(url, body, options),
    );
    this.countries.invalidate();
    return versioned(response);
  }
}

function ifMatch(etag: string | null): HttpHeaders {
  return etag === null ? new HttpHeaders() : new HttpHeaders({ 'If-Match': etag });
}

function versioned(response: HttpResponse<ApiData<Country>>): VersionedCountry {
  return {
    country: (response.body as ApiData<Country>).data,
    etag: response.headers.get('ETag'),
  };
}
