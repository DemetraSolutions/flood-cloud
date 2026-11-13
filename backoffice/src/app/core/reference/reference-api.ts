import { HttpClient } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiPage } from '../api/api.types';
import { referenceParams } from './reference-params';
import { ReferenceStore } from './reference-store';

/** A group as listed by `GET /v1/groups`. */
export interface GroupRef {
  readonly id: string;
  readonly name: string;
  readonly status?: 'active' | 'suspended';
  readonly trashed?: boolean;
}

/** A company or a store as listed by the reference reads of a group. */
export interface ReferenceItem {
  readonly id: string;
  readonly name: string;
  /** Company of a store; `null` when the legacy data has no valid company. */
  readonly companyId?: string | null;
  readonly trashed?: boolean;
}

/** Parameters of a reference read (`q` filters by name; `companyId` only applies to stores). */
export interface ReferenceQuery {
  readonly q?: string;
  readonly cursor?: string | null;
  readonly limit?: number;
  readonly companyId?: string;
  /** Ids to resolve (1 to {@link MAX_LOOKUP_IDS}). */
  readonly ids?: readonly string[];
}

/** Compact reads of a group for the selectors of favorites and promotions (`products:read`). */
export type LookupKind = 'products' | 'product-categories' | 'customers' | 'contact-groups';
// `companies`, `places` and `lookup` reads go through the {@link ReferenceStore}.

/** Most ids a compact read resolves in one request. */
export const MAX_LOOKUP_IDS = 100;

/** Page size of the reference reads (selectors load more on demand). */
export const REFERENCE_PAGE_SIZE = 25;

/** Page size and page limit of the name resolution of the services. */
const NAME_PAGE_SIZE = 100;
export const MAX_NAME_PAGES = 5;
/** Pages read to learn the stores of a restricted user (2000 stores). */
export const MAX_PERIMETER_PAGES = 20;

/**
 * Minimal reference reads used by selectors: groups, and the companies, stores and services of a
 * group.
 * Results are cursor pages sorted by name; the backend limits them to the user's perimeter.
 * The reads of companies, stores and `lookup` lists are served by the {@link ReferenceStore}.
 */
@Service()
export class ReferenceApi {
  private readonly http = inject(HttpClient);
  private readonly store = inject(ReferenceStore);

  /** One page of the groups visible to the current user. */
  groups(query: ReferenceQuery = {}): Promise<ApiPage<GroupRef>> {
    return this.page<GroupRef>('/v1/groups', query);
  }

  /** One page of the companies of a group. */
  companies(groupId: string, query: ReferenceQuery = {}): Promise<ApiPage<ReferenceItem>> {
    return this.store.page(groupId, 'companies', withDefaultLimit(query));
  }

  /** One page of the stores of a group, optionally of one company. */
  places(groupId: string, query: ReferenceQuery = {}): Promise<ApiPage<ReferenceItem>> {
    return this.store.page(groupId, 'places', withDefaultLimit(query));
  }

  /** One page of the services of a group (needs the `services` feature and `users:read`). */
  services(groupId: string, query: ReferenceQuery = {}): Promise<ApiPage<ReferenceItem>> {
    return this.page<ReferenceItem>(`/v1/groups/${encodeURIComponent(groupId)}/services`, query);
  }

  /**
   * Names of the given services. The services read has no `ids` filter, so the pages (100 at a
   * time, by name) are read until every id is found, the list ends or {@link MAX_NAME_PAGES}
   * pages were read. Ids that are not found are missing from the result.
   *
   * @param groupId Group of the services.
   * @param ids Ids to resolve.
   */
  serviceNames(groupId: string, ids: readonly string[]): Promise<Record<string, string>> {
    return this.scanNames((query) => this.services(groupId, query), ids);
  }

  /**
   * Names of the given stores, resolved with the `ids` filter of the stores read (at most
   * {@link MAX_LOOKUP_IDS} per request, duplicates removed). Ids that do not exist, are trashed
   * or are outside the perimeter of the user are missing from the result.
   *
   * @param groupId Group of the stores.
   * @param ids Ids to resolve.
   */
  placeNames(groupId: string, ids: readonly string[]): Promise<Record<string, string>> {
    return this.namesByIds((query) => this.places(groupId, query), ids);
  }

  /**
   * Ids of every store the user can read in a group (the reference read is already limited to
   * the user's perimeter), reading pages of 100 for at most {@link MAX_PERIMETER_PAGES} pages.
   *
   * @param groupId Group of the stores.
   * @returns The ids, or `null` when the list is longer than what is read.
   */
  async placeIds(groupId: string): Promise<ReadonlySet<string> | null> {
    const ids = new Set<string>();
    let cursor: string | null = null;
    for (let pages = 0; pages < MAX_PERIMETER_PAGES; pages++) {
      const page: ApiPage<ReferenceItem> = await this.places(groupId, {
        limit: NAME_PAGE_SIZE,
        cursor,
      });
      for (const item of page.data) {
        ids.add(item.id);
      }
      cursor = page.page.next;
      if (cursor === null) {
        return ids;
      }
    }
    return null;
  }

  /** One page of a compact read of a group (products, categories, customers, contact groups). */
  lookup(
    groupId: string,
    kind: LookupKind,
    query: ReferenceQuery = {},
  ): Promise<ApiPage<ReferenceItem>> {
    return this.store.page(groupId, kind, withDefaultLimit(query));
  }

  /**
   * Names of the given elements of a compact read, resolved with its `ids` filter (at most
   * {@link MAX_LOOKUP_IDS} per request). Ids that do not exist or are trashed are missing from
   * the result.
   *
   * @param groupId Group of the elements.
   * @param kind Which compact read.
   * @param ids Ids to resolve.
   */
  lookupNames(
    groupId: string,
    kind: LookupKind,
    ids: readonly string[],
  ): Promise<Record<string, string>> {
    return this.namesByIds((query) => this.lookup(groupId, kind, query), ids);
  }

  private async namesByIds(
    read: (query: ReferenceQuery) => Promise<ApiPage<ReferenceItem>>,
    ids: readonly string[],
  ): Promise<Record<string, string>> {
    const unique = [...new Set(ids)];
    const names: Record<string, string> = {};
    for (let from = 0; from < unique.length; from += MAX_LOOKUP_IDS) {
      const page = await read({
        ids: unique.slice(from, from + MAX_LOOKUP_IDS),
        limit: MAX_LOOKUP_IDS,
      });
      for (const item of page.data) {
        names[item.id] = item.name;
      }
    }
    return names;
  }

  private async scanNames(
    read: (query: ReferenceQuery) => Promise<ApiPage<ReferenceItem>>,
    ids: readonly string[],
  ): Promise<Record<string, string>> {
    const wanted = new Set(ids);
    const names: Record<string, string> = {};
    let cursor: string | null = null;
    for (let pages = 0; wanted.size > 0 && pages < MAX_NAME_PAGES; pages++) {
      const page: ApiPage<ReferenceItem> = await read({ limit: NAME_PAGE_SIZE, cursor });
      for (const item of page.data) {
        if (wanted.delete(item.id)) {
          names[item.id] = item.name;
        }
      }
      cursor = page.page.next;
      if (cursor === null) {
        break;
      }
    }
    return names;
  }

  private page<T>(url: string, query: ReferenceQuery): Promise<ApiPage<T>> {
    const params = referenceParams(withDefaultLimit(query));
    return firstValueFrom(this.http.get<ApiPage<T>>(url, { params }));
  }
}

function withDefaultLimit(query: ReferenceQuery): ReferenceQuery {
  return { ...query, limit: query.limit ?? REFERENCE_PAGE_SIZE };
}
