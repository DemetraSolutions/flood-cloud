import { HttpClient } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiData } from '../../../core/api/api.types';
import { ReferenceKind, ReferenceStore } from '../../../core/reference/reference-store';
import { CatalogSegment } from './catalog.types';

/** Catalogs whose compact list the reference store keeps: a write on them invalidates it. */
const REFERENCE_OF: Partial<Record<CatalogSegment, ReferenceKind>> = {
  'price-lists': 'price-lists',
};

/**
 * Writes on the catalogs of a group (`/v1/groups/{groupId}/{segment}`). Reads use `httpResource`
 * in the pages. Every write is one change of the group document: a concurrent change makes it
 * fail with `409`. A successful write on a catalog kept in the reference store invalidates it.
 */
@Service()
export class CatalogsApi {
  private readonly http = inject(HttpClient);
  private readonly store = inject(ReferenceStore);

  /** URL of a catalog, or of one of its elements. */
  url(groupId: string, segment: CatalogSegment, id?: string): string {
    const base = `/v1/groups/${encodeURIComponent(groupId)}/${segment}`;
    return id === undefined ? base : `${base}/${encodeURIComponent(id)}`;
  }

  /** Creates an element (`201`). */
  async create<T>(groupId: string, segment: CatalogSegment, body: object): Promise<T> {
    const response = await firstValueFrom(
      this.http.post<ApiData<T>>(this.url(groupId, segment), body),
    );
    this.written(groupId, segment);
    return response.data;
  }

  /** Changes an element with a JSON Merge Patch. */
  async patch<T>(groupId: string, segment: CatalogSegment, id: string, body: object): Promise<T> {
    const response = await firstValueFrom(
      this.http.patch<ApiData<T>>(this.url(groupId, segment, id), body),
    );
    this.written(groupId, segment);
    return response.data;
  }

  /** Replaces an element (the loyalty-card rule of a currency). */
  async put<T>(groupId: string, segment: CatalogSegment, id: string, body: object): Promise<T> {
    const response = await firstValueFrom(
      this.http.put<ApiData<T>>(this.url(groupId, segment, id), body),
    );
    this.written(groupId, segment);
    return response.data;
  }

  /** Deletes an element (`204`). */
  async remove(groupId: string, segment: CatalogSegment, id: string): Promise<void> {
    await firstValueFrom(this.http.delete<void>(this.url(groupId, segment, id)));
    this.written(groupId, segment);
  }

  private written(groupId: string, segment: CatalogSegment): void {
    const kind = REFERENCE_OF[segment];
    if (kind !== undefined) {
      this.store.invalidate(groupId, kind);
    }
  }
}
