import { HttpClient, HttpHeaders, HttpResponse } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiData } from '../../core/api/api.types';
import { ProductCatalogApi } from '../product-catalog/product-catalog-api';
import { Versioned } from '../product-catalog/product-catalog.types';
import { Product, PRODUCTS_SEGMENT, ProductTrashResponse } from './product.types';

/**
 * Reads and writes of one product (`/v1/groups/{groupId}/products/{productId}`): the generic
 * reads and writes of the catalog, and the actions that only products have (duplication, trash,
 * restore, deletion for good and the bulk move to the trash). The lists are read with
 * `httpResource` in the pages. A write on a product presents its version in `If-Match`; a creation
 * and a duplication present an `Idempotency-Key`.
 */
@Service()
export class ProductApi {
  private readonly http = inject(HttpClient);
  private readonly catalog = inject(ProductCatalogApi);

  /** URL of the products of a group. */
  baseUrl(groupId: string): string {
    return this.catalog.baseUrl(groupId, PRODUCTS_SEGMENT);
  }

  /** One product with its version and its warnings. */
  read(groupId: string, productId: string): Promise<Versioned<Product>> {
    return this.catalog.read<Product>(groupId, PRODUCTS_SEGMENT, productId);
  }

  /** Creates a product (`201`). */
  create(groupId: string, body: object, key: string): Promise<Versioned<Product>> {
    return this.catalog.create<Product>(groupId, PRODUCTS_SEGMENT, body, key);
  }

  /** Changes the given fields of a product. */
  update(groupId: string, productId: string, body: object, etag: string | null): Promise<Versioned<Product>> {
    return this.catalog.update<Product>(groupId, PRODUCTS_SEGMENT, productId, body, etag);
  }

  /**
   * Turns a product on or off from a list: the list has no versions, so the product is read first.
   *
   * @param enabled The new state.
   */
  async setEnabled(groupId: string, productId: string, enabled: boolean): Promise<Versioned<Product>> {
    const current = await this.read(groupId, productId);
    return this.update(groupId, productId, { enabled }, current.etag);
  }

  /** Copies a product (`201`); the copy is named `<name> (Copy)`. */
  async duplicate(groupId: string, productId: string, key: string): Promise<Versioned<Product>> {
    return versioned(
      await firstValueFrom(
        this.http.post<ApiData<Product>>(`${this.catalog.itemUrl(groupId, PRODUCTS_SEGMENT, productId)}/duplicate`, null, {
          headers: new HttpHeaders({ 'Idempotency-Key': key }),
          observe: 'response',
        }),
      ),
    );
  }

  /** Takes a product out of the trash (`If-Match`). */
  async restore(groupId: string, productId: string, etag: string | null): Promise<Versioned<Product>> {
    return versioned(
      await firstValueFrom(
        this.http.post<ApiData<Product>>(`${this.catalog.itemUrl(groupId, PRODUCTS_SEGMENT, productId)}/restore`, null, {
          headers: etag === null ? new HttpHeaders() : new HttpHeaders({ 'If-Match': etag }),
          observe: 'response',
        }),
      ),
    );
  }

  /** Deletes a product of the trash for good (`204`; `409` with the references that use it). */
  async remove(groupId: string, productId: string, etag: string | null): Promise<void> {
    await firstValueFrom(
      this.http.delete<void>(this.catalog.itemUrl(groupId, PRODUCTS_SEGMENT, productId), {
        headers: etag === null ? new HttpHeaders() : new HttpHeaders({ 'If-Match': etag }),
      }),
    );
  }

  /**
   * Moves up to 100 products to the trash in one call: no `If-Match`, the outcome of every product
   * is in the answer (in the order of the request).
   */
  async trashMany(groupId: string, ids: readonly string[]): Promise<ProductTrashResponse> {
    const response = await firstValueFrom(
      this.http.post<ApiData<ProductTrashResponse>>(`${this.baseUrl(groupId)}/trash`, { ids }),
    );
    return response.data;
  }
}

function versioned(response: HttpResponse<ApiData<Product>>): Versioned<Product> {
  return { item: (response.body as ApiData<Product>).data, etag: response.headers.get('ETag') };
}
