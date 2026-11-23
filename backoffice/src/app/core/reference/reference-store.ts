import { HttpClient } from '@angular/common/http';
import { effect, inject, Service, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiPage } from '../api/api.types';
import { ApiError } from '../api/api-error';
import { GroupContext } from '../groups/group-context';
import { SessionService } from '../session/session.service';
import type { ReferenceItem, ReferenceQuery } from './reference-api';
import { referenceParams } from './reference-params';

/**
 * Compact lists of a group kept in memory, with the endpoint that serves each (below
 * `/v1/groups/{groupId}/`). To keep another entity in the store, add it here: the backend must
 * serve it as a cursor page with `ETag` and `304` like the others.
 */
export const REFERENCE_ENDPOINTS = {
  companies: 'companies',
  places: 'places',
  products: 'lookup/products',
  'product-categories': 'lookup/product-categories',
  customers: 'lookup/customers',
  suppliers: 'lookup/suppliers',
  'contact-groups': 'lookup/contact-groups',
  'price-lists': 'lookup/price-lists',
  'email-templates': 'lookup/email-templates',
} as const;

/** A list the store keeps. */
export type ReferenceKind = keyof typeof REFERENCE_ENDPOINTS;

/** Most groups whose lists the store remembers (the oldest visited are forgotten first). */
export const MAX_REMEMBERED_GROUPS = 5;

/** A page held in memory with the validator the server gave it. */
interface Entry {
  readonly kind: ReferenceKind;
  readonly etag: string | null;
  readonly page: ApiPage<ReferenceItem>;
  /** `true` when the page must be revalidated before its next use. */
  stale: boolean;
}

interface Pending {
  readonly groupId: string;
  readonly kind: ReferenceKind;
  readonly promise: Promise<ApiPage<ReferenceItem>>;
}

/**
 * Store of the reference data of the working group: companies, stores and the compact `lookup`
 * lists (decision 4.5.3). Each page read (one per group, list and parameters: search text,
 * cursor, limit, filters) is kept with its `ETag`; a page in memory is served without a request
 * until it becomes stale, and a stale page is revalidated with `If-None-Match`: `304` keeps the
 * data, `200` replaces it.
 *
 * - Pages become stale when the user enters a group (startup and group change) and when
 *   {@link invalidate} reports a write on the entity; the revalidation happens on the next use.
 * - Reads are keyed by group, so a group never sees the data of another one. The pages of the
 *   last {@link MAX_REMEMBERED_GROUPS} groups are remembered (to revalidate them cheaply when the
 *   user comes back); everything is dropped on sign-out.
 * - A failed read keeps the data in memory (and the page stays stale); `403` and `404` mean the
 *   group is no longer reachable and its data is dropped.
 * - Concurrent equal reads share one request.
 */
@Service()
export class ReferenceStore {
  private readonly http = inject(HttpClient);
  private readonly session = inject(SessionService);
  private readonly context = inject(GroupContext);

  private readonly groups = new Map<string, Map<string, Entry>>();
  private readonly pending = new Map<string, Pending>();
  private current: string | null = null;
  /** Bumped by every invalidation: a response that started before it is stale when it arrives. */
  private version = 0;

  constructor() {
    effect(() => {
      const anonymous = this.session.status() === 'anonymous';
      const groupId = this.context.groupId();
      untracked(() => {
        if (anonymous) {
          this.clear();
        } else if (groupId !== null) {
          this.enter(groupId);
        }
      });
    });
  }

  /**
   * One page of a list of a group, from memory when it is current, revalidated with the server
   * otherwise.
   *
   * @param groupId Group of the list.
   * @param kind Which list.
   * @param query Parameters of the read; the `limit` is sent only when given.
   * @returns The page.
   * @throws ApiError When the read fails (data already in memory is kept, except on `403`/`404`).
   */
  page<T extends ReferenceItem = ReferenceItem>(
    groupId: string,
    kind: ReferenceKind,
    query: ReferenceQuery = {},
  ): Promise<ApiPage<T>> {
    this.enter(groupId);
    const params = referenceParams(query);
    const key = JSON.stringify([groupId, kind, params]);
    const entry = this.groups.get(groupId)?.get(key);
    if (entry !== undefined && !entry.stale) {
      return Promise.resolve(entry.page as ApiPage<T>);
    }
    let pending = this.pending.get(key);
    if (pending === undefined) {
      const promise = this.fetch(groupId, kind, key, params, entry);
      pending = { groupId, kind, promise };
      this.pending.set(key, pending);
      const read = pending;
      void promise.then(
        () => this.release(key, read),
        () => this.release(key, read),
      );
    }
    return pending.promise as Promise<ApiPage<T>>;
  }

  /**
   * Reports a create, update or delete of an entity of a group: its pages are revalidated on
   * their next use (and a read already in flight will not be taken as current).
   *
   * @param groupId Group the write was made on.
   * @param kind Which list the write changes.
   */
  invalidate(groupId: string, kind: ReferenceKind): void {
    this.version++;
    for (const entry of this.groups.get(groupId)?.values() ?? []) {
      if (entry.kind === kind) {
        entry.stale = true;
      }
    }
    for (const [key, read] of this.pending) {
      if (read.groupId === groupId && read.kind === kind) {
        this.pending.delete(key);
      }
    }
  }

  /** Drops everything (sign-out). */
  clear(): void {
    this.version++;
    this.groups.clear();
    this.pending.clear();
    this.current = null;
  }

  /**
   * The user works on `groupId`: its pages in memory become stale (revalidated on their next
   * use), and the groups visited longest ago are forgotten.
   */
  private enter(groupId: string): void {
    if (this.current === groupId) {
      return;
    }
    this.current = groupId;
    const entries = this.groups.get(groupId) ?? new Map<string, Entry>();
    for (const entry of entries.values()) {
      entry.stale = true;
    }
    this.groups.delete(groupId);
    this.groups.set(groupId, entries);
    for (const [oldest] of this.groups) {
      if (this.groups.size <= MAX_REMEMBERED_GROUPS) {
        break;
      }
      this.groups.delete(oldest);
    }
  }

  private release(key: string, read: Pending): void {
    if (this.pending.get(key) === read) {
      this.pending.delete(key);
    }
  }

  private async fetch(
    groupId: string,
    kind: ReferenceKind,
    key: string,
    params: Record<string, string | number>,
    entry: Entry | undefined,
  ): Promise<ApiPage<ReferenceItem>> {
    const started = this.version;
    const url = `/v1/groups/${encodeURIComponent(groupId)}/${REFERENCE_ENDPOINTS[kind]}`;
    const headers = entry?.etag ? { 'If-None-Match': entry.etag } : undefined;
    try {
      const response = await firstValueFrom(
        this.http.get<ApiPage<ReferenceItem>>(url, { params, headers, observe: 'response' }),
      );
      const page = response.body as ApiPage<ReferenceItem>;
      this.keep(groupId, key, {
        kind,
        etag: response.headers.get('ETag'),
        page,
        stale: started !== this.version,
      });
      return page;
    } catch (error) {
      if (!(error instanceof ApiError)) {
        throw error;
      }
      if (error.status === 304 && entry !== undefined) {
        entry.stale = started !== this.version;
        return entry.page;
      }
      if (error.status === 403 || error.status === 404) {
        // The group is no longer reachable for this user: nothing of it may stay visible.
        this.groups.delete(groupId);
        if (this.current === groupId) {
          this.current = null;
        }
      }
      throw error;
    }
  }

  private keep(groupId: string, key: string, entry: Entry): void {
    // The group may have been dropped (sign-out, forgotten, unreachable) while the read ran.
    this.groups.get(groupId)?.set(key, entry);
  }
}
