import { HttpClient, HttpHeaders, HttpResponse } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiData, ApiPage } from '../../core/api/api.types';
import { SearchOption } from '../../shared/ui/search-combobox/search-combobox';
import { ProductCatalogApi } from '../product-catalog/product-catalog-api';
import { Versioned } from '../product-catalog/product-catalog.types';
import { ProductRow } from '../products/product.types';
import {
  Contact,
  CONTACTS_SEGMENT,
  ContactRow,
  ContactTrashResponse,
  contactLabel,
  PointsAdjustment,
} from './contact.types';

/** Most results a search of the page offers. */
const SEARCH_LIMIT = 25;

/**
 * Reads and writes of the contacts of a group (`/v1/groups/{groupId}/contacts`): the generic
 * reads and writes of the catalog plus the actions only contacts have (trash, restore, deletion for
 * good, the bulk move to the trash and the adjustment of the points of a card). The list is read
 * with `httpResource` in the pages. A write on a contact presents its version in `If-Match`; a
 * creation and a points adjustment present an `Idempotency-Key`.
 */
@Service()
export class ContactApi {
  private readonly http = inject(HttpClient);
  private readonly catalog = inject(ProductCatalogApi);

  /** URL of the contacts of a group. */
  baseUrl(groupId: string): string {
    return this.catalog.baseUrl(groupId, CONTACTS_SEGMENT);
  }

  /** One contact with its version and its warnings. */
  read(groupId: string, contactId: string): Promise<Versioned<Contact>> {
    return this.catalog.read<Contact>(groupId, CONTACTS_SEGMENT, contactId);
  }

  /** Creates a contact (`201`). */
  create(groupId: string, body: object, key: string): Promise<Versioned<Contact>> {
    return this.catalog.create<Contact>(groupId, CONTACTS_SEGMENT, body, key);
  }

  /** Changes the given fields of a contact. */
  update(
    groupId: string,
    contactId: string,
    body: object,
    etag: string | null,
  ): Promise<Versioned<Contact>> {
    return this.catalog.update<Contact>(groupId, CONTACTS_SEGMENT, contactId, body, etag);
  }

  /** Puts a contact in the trash (`If-Match`). */
  trash(groupId: string, contactId: string, etag: string | null): Promise<Versioned<Contact>> {
    return this.action(groupId, contactId, 'trash', etag);
  }

  /** Takes a contact out of the trash (`If-Match`). */
  restore(groupId: string, contactId: string, etag: string | null): Promise<Versioned<Contact>> {
    return this.action(groupId, contactId, 'restore', etag);
  }

  /** Deletes a contact of the trash for good (`204`; `409` with what refers to it, `503` when the check is too slow). */
  async remove(groupId: string, contactId: string, etag: string | null): Promise<void> {
    await firstValueFrom(
      this.http.delete<void>(this.catalog.itemUrl(groupId, CONTACTS_SEGMENT, contactId), {
        headers: ifMatch(etag),
      }),
    );
  }

  /**
   * Moves up to 100 contacts to the trash in one call: no `If-Match`, the outcome of every contact
   * is in the answer (in the order of the request).
   */
  async trashMany(groupId: string, ids: readonly string[]): Promise<ContactTrashResponse> {
    const response = await firstValueFrom(
      this.http.post<ApiData<ContactTrashResponse>>(`${this.baseUrl(groupId)}/trash`, { ids }),
    );
    return response.data;
  }

  /**
   * Adds points to a card or takes them away (`delta` is a whole number other than zero).
   *
   * @param key The `Idempotency-Key` of the dialog (the same one on every retry of it).
   * @param reason What the adjustment is for, optional.
   * @returns The card with its new balance.
   */
  async adjustPoints(
    groupId: string,
    contactId: string,
    code: string,
    delta: number,
    reason: string | null,
    key: string,
  ): Promise<PointsAdjustment> {
    const url = `${this.catalog.itemUrl(groupId, CONTACTS_SEGMENT, contactId)}/fidelity-cards/${encodeURIComponent(code)}/points-adjustments`;
    const response = await firstValueFrom(
      this.http.post<ApiData<PointsAdjustment>>(
        url,
        reason === null ? { delta } : { delta, reason },
        { headers: new HttpHeaders({ 'Idempotency-Key': key }) },
      ),
    );
    return response.data;
  }

  /**
   * The contacts that have a company name and match a text, for the choice of the company a person
   * works for (the text is searched literally by the server).
   *
   * @param text At least three characters.
   */
  async searchCompanies(groupId: string, text: string): Promise<readonly SearchOption[]> {
    const page = await firstValueFrom(
      this.http.get<ApiPage<ContactRow>>(this.baseUrl(groupId), {
        params: searchParams(text),
      }),
    );
    return page.data
      .filter((row) => row.company.name !== '')
      .map((row) => ({ value: row.id, label: row.company.name }));
  }

  /**
   * The contacts (of any kind) that match a text, for the choice of the customers of a card.
   *
   * @param text At least three characters; empty reads the first page.
   */
  async searchContacts(groupId: string, text: string): Promise<readonly SearchOption[]> {
    const page = await firstValueFrom(
      this.http.get<ApiPage<ContactRow>>(this.baseUrl(groupId), {
        params: { kind: 'all', ...searchParams(text) },
      }),
    );
    return page.data.map((row) => ({ value: row.id, label: row.displayName ?? contactLabel(row) }));
  }

  /** The service products that match a text, for the services of a contact. */
  async searchServices(groupId: string, text: string): Promise<readonly SearchOption[]> {
    const page = await firstValueFrom(
      this.http.get<ApiPage<ProductRow>>(this.catalog.baseUrl(groupId, 'products'), {
        params: { family: 'services', ...searchParams(text) },
      }),
    );
    return page.data.map((row) => ({ value: row.id, label: row.name ?? row.code ?? row.id }));
  }

  /**
   * The display names of some contacts that use a value (the ones a duplicate warning lists): one
   * search by that value, whose rows are matched to the ids. An id the search does not return is
   * missing from the result.
   *
   * @param value The code, tax code or VAT number the warning is about.
   * @param ids The contacts to name (at most five).
   */
  async namesUsing(groupId: string, value: string, ids: readonly string[]): Promise<Record<string, string>> {
    const page = await firstValueFrom(
      this.http.get<ApiPage<ContactRow>>(this.baseUrl(groupId), {
        params: { kind: 'all', q: value, limit: 6 },
      }),
    );
    return Object.fromEntries(
      page.data
        .filter((row) => ids.includes(row.id) && row.displayName !== null)
        .map((row) => [row.id, row.displayName as string]),
    );
  }

  private async action(
    groupId: string,
    contactId: string,
    name: 'trash' | 'restore',
    etag: string | null,
  ): Promise<Versioned<Contact>> {
    const response = await firstValueFrom(
      this.http.post<ApiData<Contact>>(
        `${this.catalog.itemUrl(groupId, CONTACTS_SEGMENT, contactId)}/${name}`,
        null,
        { headers: ifMatch(etag), observe: 'response' },
      ),
    );
    return versioned(response);
  }
}

/** The query of a search: `q` only when there is a text (the server refuses an empty one). */
function searchParams(text: string): Record<string, string | number> {
  return text === '' ? { limit: SEARCH_LIMIT } : { q: text, limit: SEARCH_LIMIT };
}

function ifMatch(etag: string | null): HttpHeaders {
  return etag === null ? new HttpHeaders() : new HttpHeaders({ 'If-Match': etag });
}

function versioned(response: HttpResponse<ApiData<Contact>>): Versioned<Contact> {
  return { item: (response.body as ApiData<Contact>).data, etag: response.headers.get('ETag') };
}
