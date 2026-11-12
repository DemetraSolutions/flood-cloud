import { HttpClient } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiPage } from '../api/api.types';

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
}

/** Page size of the reference reads (selectors load more on demand). */
export const REFERENCE_PAGE_SIZE = 25;

/** Page size and page limit of the name resolution of the services. */
const NAME_PAGE_SIZE = 100;
export const MAX_NAME_PAGES = 5;

/**
 * Minimal reference reads used by selectors: groups, and the companies, stores and services of a
 * group.
 * Results are cursor pages sorted by name; the backend limits them to the user's perimeter.
 */
@Service()
export class ReferenceApi {
  private readonly http = inject(HttpClient);

  /** One page of the groups visible to the current user. */
  groups(query: ReferenceQuery = {}): Promise<ApiPage<GroupRef>> {
    return this.page<GroupRef>('/v1/groups', query);
  }

  /** One page of the companies of a group. */
  companies(groupId: string, query: ReferenceQuery = {}): Promise<ApiPage<ReferenceItem>> {
    return this.page<ReferenceItem>(`/v1/groups/${encodeURIComponent(groupId)}/companies`, query);
  }

  /** One page of the stores of a group, optionally of one company. */
  places(groupId: string, query: ReferenceQuery = {}): Promise<ApiPage<ReferenceItem>> {
    return this.page<ReferenceItem>(`/v1/groups/${encodeURIComponent(groupId)}/places`, query);
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
  async serviceNames(groupId: string, ids: readonly string[]): Promise<Record<string, string>> {
    const wanted = new Set(ids);
    const names: Record<string, string> = {};
    let cursor: string | null = null;
    for (let read = 0; wanted.size > 0 && read < MAX_NAME_PAGES; read++) {
      const page: ApiPage<ReferenceItem> = await this.services(groupId, {
        limit: NAME_PAGE_SIZE,
        cursor,
      });
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
    const params: Record<string, string | number> = { limit: query.limit ?? REFERENCE_PAGE_SIZE };
    const text = query.q?.trim();
    if (text) {
      params['q'] = text;
    }
    if (query.cursor) {
      params['cursor'] = query.cursor;
    }
    if (query.companyId) {
      params['companyId'] = query.companyId;
    }
    return firstValueFrom(this.http.get<ApiPage<T>>(url, { params }));
  }
}
