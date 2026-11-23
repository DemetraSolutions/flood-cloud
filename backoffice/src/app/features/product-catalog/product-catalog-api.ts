import { HttpClient, HttpHeaders, HttpResponse } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiData } from '../../core/api/api.types';
import { Versioned } from './product-catalog.types';

/**
 * Reads and writes of the departments, brands and attribute groups of a group
 * (`/v1/groups/{groupId}/<segment>`); the lists are read with `httpResource` in the pages. A
 * modification presents the version of the entry in `If-Match` and resolves with the new one; a
 * creation presents an `Idempotency-Key`.
 */
@Service()
export class ProductCatalogApi {
  private readonly http = inject(HttpClient);

  /** URL of a resource of a group. */
  baseUrl(groupId: string, segment: string): string {
    return `/v1/groups/${encodeURIComponent(groupId)}/${segment}`;
  }

  /** URL of one entry. */
  itemUrl(groupId: string, segment: string, itemId: string): string {
    return `${this.baseUrl(groupId, segment)}/${encodeURIComponent(itemId)}`;
  }

  /** One entry with its version. */
  async read<T>(groupId: string, segment: string, itemId: string): Promise<Versioned<T>> {
    return versioned(
      await firstValueFrom(
        this.http.get<ApiData<T>>(this.itemUrl(groupId, segment, itemId), { observe: 'response' }),
      ),
    );
  }

  /**
   * Creates an entry (`201`).
   *
   * @param key The `Idempotency-Key` of this submission (the same one on every retry of it).
   */
  async create<T>(
    groupId: string,
    segment: string,
    body: object,
    key: string,
  ): Promise<Versioned<T>> {
    return versioned(
      await firstValueFrom(
        this.http.post<ApiData<T>>(this.baseUrl(groupId, segment), body, {
          headers: new HttpHeaders({ 'Idempotency-Key': key }),
          observe: 'response',
        }),
      ),
    );
  }

  /**
   * Changes the given fields of an entry (`If-Match` with the version read).
   *
   * @param etag The version the user read, `null` when the response had none.
   */
  async update<T>(
    groupId: string,
    segment: string,
    itemId: string,
    body: object,
    etag: string | null,
  ): Promise<Versioned<T>> {
    return versioned(
      await firstValueFrom(
        this.http.patch<ApiData<T>>(this.itemUrl(groupId, segment, itemId), body, {
          headers: etag === null ? new HttpHeaders() : new HttpHeaders({ 'If-Match': etag }),
          observe: 'response',
        }),
      ),
    );
  }

  /** Deletes an entry for good (`204`; `409` while products use it). */
  async remove(groupId: string, segment: string, itemId: string): Promise<void> {
    await firstValueFrom(this.http.delete<void>(this.itemUrl(groupId, segment, itemId)));
  }
}

function versioned<T>(response: HttpResponse<ApiData<T>>): Versioned<T> {
  return {
    item: (response.body as ApiData<T>).data,
    etag: response.headers.get('ETag'),
  };
}
