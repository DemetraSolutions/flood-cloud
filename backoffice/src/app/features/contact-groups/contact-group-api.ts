import { HttpClient, HttpHeaders } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ProductCatalogApi } from '../product-catalog/product-catalog-api';
import { Versioned } from '../product-catalog/product-catalog.types';
import { ContactGroup, CONTACT_GROUPS_SEGMENT } from './contact-group.types';

/**
 * Reads and writes of the groups of contacts of a group (`/v1/groups/{groupId}/contact-groups`);
 * the list is read with `httpResource` in the page. A modification and a deletion present the
 * version of the group in `If-Match`; a creation presents an `Idempotency-Key`.
 */
@Service()
export class ContactGroupApi {
  private readonly http = inject(HttpClient);
  private readonly catalog = inject(ProductCatalogApi);

  /** URL of the groups of contacts of a group. */
  baseUrl(groupId: string): string {
    return this.catalog.baseUrl(groupId, CONTACT_GROUPS_SEGMENT);
  }

  /** One group of contacts with its version and how many contacts it has. */
  read(groupId: string, contactGroupId: string): Promise<Versioned<ContactGroup>> {
    return this.catalog.read<ContactGroup>(groupId, CONTACT_GROUPS_SEGMENT, contactGroupId);
  }

  /** Creates a group of contacts (`201`). */
  create(groupId: string, body: object, key: string): Promise<Versioned<ContactGroup>> {
    return this.catalog.create<ContactGroup>(groupId, CONTACT_GROUPS_SEGMENT, body, key);
  }

  /** Changes the given fields of a group of contacts. */
  update(
    groupId: string,
    contactGroupId: string,
    body: object,
    etag: string | null,
  ): Promise<Versioned<ContactGroup>> {
    return this.catalog.update<ContactGroup>(groupId, CONTACT_GROUPS_SEGMENT, contactGroupId, body, etag);
  }

  /** Deletes a group of contacts (`204`; `409` with what still refers to it). */
  async remove(groupId: string, contactGroupId: string, etag: string | null): Promise<void> {
    await firstValueFrom(
      this.http.delete<void>(this.catalog.itemUrl(groupId, CONTACT_GROUPS_SEGMENT, contactGroupId), {
        headers: etag === null ? new HttpHeaders() : new HttpHeaders({ 'If-Match': etag }),
      }),
    );
  }
}
