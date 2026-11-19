import { HttpClient, HttpHeaders } from '@angular/common/http';
import { computed, effect, inject, Service, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiData } from '../api/api.types';
import { ApiError } from '../api/api-error';
import { SessionService } from '../session/session.service';
import { FEATURE_NAMES, FeatureFlags } from './feature-catalog';
import { GroupContext } from './group-context';

/** Loading state of the features of the working group. */
export type FeaturesStatus = 'idle' | 'loading' | 'ready' | 'error';

interface Loaded {
  readonly groupId: string;
  readonly flags: FeatureFlags;
  readonly name: string;
}

interface Other {
  readonly flags: FeatureFlags;
  readonly name: string;
}

interface Cached extends Loaded {
  readonly etag: string;
}

/** Keeps the booleans of the catalog and drops everything else (allowlist). */
function parseFlags(value: unknown): FeatureFlags {
  const source = (typeof value === 'object' && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  return Object.fromEntries(
    FEATURE_NAMES.map((name) => [name, source[name] === true]),
  ) as FeatureFlags;
}

/**
 * The features (modules) turned on for the group the user works on (tasks 4.3.2 and 4.5.2), and
 * for the group of a record page that is not the working group (`ensure`, `enabledFor`, `nameOf`):
 * those are kept apart, so that opening a record of another group never changes the menu.
 *
 * Users bound to a group (SA, CA, PA) get them from `GET /v1/me` (`groupFeatures`); PSA and
 * dealers from the detail of the group they work on (`GET /v1/groups/{groupId}`), read again at
 * every change of working group and after every change of the group made in the backoffice
 * ({@link refresh}). A re-read sends the `ETag` of the last answer in `If-None-Match`: on `304`
 * the representation kept in memory is reused. Nothing is persisted in the browser.
 *
 * Features gate the interface only; the server answers `403 FEATURE_DISABLED` on its own.
 */
@Service()
export class GroupFeatures {
  private readonly http = inject(HttpClient);
  private readonly session = inject(SessionService);
  private readonly groups = inject(GroupContext);

  private readonly cache = new Map<string, Cached>();
  private readonly current = signal<Loaded | null>(null);
  /** Features and name of the groups read for record pages that are not the working group. */
  private readonly others = signal<ReadonlyMap<string, Other>>(new Map());
  private readonly loading = signal(false);
  private readonly failure = signal<ApiError | null>(null);
  private inFlight: { readonly groupId: string; readonly promise: Promise<void> } | null = null;
  private requestId = 0;
  private lastContextId: string | null = null;

  /** The features of the working group, `null` while unknown (not loaded, loading, failed). */
  readonly flags = computed<FeatureFlags | null>(() =>
    this.groups.canChoose() ? (this.current()?.flags ?? null) : this.fixedFlags(),
  );

  /** Loading state of the features. */
  readonly status = computed<FeaturesStatus>(() => {
    if (this.flags() !== null) {
      return 'ready';
    }
    if (this.loading()) {
      return 'loading';
    }
    return this.failure() === null ? 'idle' : 'error';
  });

  /** Why the last read failed, `null` when it did not. */
  readonly error = this.failure.asReadonly();

  constructor() {
    // Working group of a PSA or dealer: read its features at start-up and at every change.
    effect(() => {
      const groupId = this.groups.groupId();
      const chooser = this.groups.canChoose();
      untracked(() => {
        if (chooser && groupId !== null) {
          void this.ensure(groupId);
        } else if (!chooser) {
          // Signed out: nothing is kept.
          this.reset();
          this.others.set(new Map());
        } else if (this.lastContextId !== null) {
          // Back to "all groups": the group left stays known to the record pages that show it.
          this.retire();
          this.reset();
        }
        this.lastContextId = groupId;
      });
    });
  }

  /** Whether a feature is on for the working group (`false` while the features are unknown). */
  enabled(feature: string): boolean {
    const flags = this.flags();
    return flags !== null && Object.hasOwn(flags, feature) && flags[feature as keyof FeatureFlags];
  }

  /**
   * Whether a feature is on for the group of a page (from the URL). The working group and the
   * groups of users bound to a group use the usual state; any other group the one read by
   * {@link ensure} (`false` until it is read).
   *
   * @param groupId Group of the page.
   * @param feature Feature name.
   */
  enabledFor(groupId: string | null, feature: string): boolean {
    if (!this.groups.canChoose() || groupId === null || groupId === this.groups.groupId()) {
      return this.enabled(feature);
    }
    const flags = this.others().get(groupId)?.flags;
    return (
      flags !== undefined && Object.hasOwn(flags, feature) && flags[feature as keyof FeatureFlags]
    );
  }

  /** Name of a group read for a page, `null` while unknown (or for the working group). */
  nameOf(groupId: string): string | null {
    return this.others().get(groupId)?.name ?? null;
  }

  /**
   * Makes the features of a group available: users bound to a group have them already;
   * for a PSA or dealer the group is read unless it is the one already loaded. Never rejects: a
   * failure is kept in {@link error}.
   *
   * @param groupId The group the user is heading to.
   */
  ensure(groupId: string): Promise<void> {
    if (!this.groups.canChoose()) {
      return Promise.resolve();
    }
    if (groupId !== this.groups.groupId()) {
      return this.others().has(groupId) ? Promise.resolve() : this.readOther(groupId);
    }
    if (this.current()?.groupId === groupId) {
      return Promise.resolve();
    }
    if (this.inFlight?.groupId === groupId) {
      return this.inFlight.promise;
    }
    return this.read(groupId);
  }

  /**
   * Whether a feature is on for a group, waiting for the read when needed.
   *
   * @param groupId Group of the page (from the URL); `null` to use the working group.
   * @param feature Feature name.
   */
  async isEnabledFor(groupId: string | null, feature: string): Promise<boolean> {
    const id = groupId ?? this.groups.groupId();
    if (this.groups.canChoose()) {
      if (id === null) {
        return false;
      }
      await this.ensure(id);
    }
    return this.enabledFor(id, feature);
  }

  /**
   * Reads the features again after the group was changed: from the profile for users bound to
   * a group, from the group (conditional request) for PSA and dealers. Never rejects.
   *
   * @param groupId Group that was changed (PSA and dealers); the working group when omitted.
   */
  async refresh(groupId?: string): Promise<void> {
    if (!this.groups.canChoose()) {
      try {
        await this.session.loadProfile();
      } catch (error) {
        this.fail(error);
      }
      return;
    }
    if (groupId !== undefined && groupId !== this.groups.groupId()) {
      await this.readOther(groupId);
      return;
    }
    const target = this.current()?.groupId ?? this.groups.groupId();
    if (target !== null) {
      await this.read(target);
    }
  }

  private fixedFlags(): FeatureFlags | null {
    return this.session.me()?.groupFeatures ?? null;
  }

  /** Keeps the loaded group among the others (it is no longer the working group). */
  private retire(): void {
    const loaded = this.current();
    if (loaded !== null) {
      const { flags, name } = loaded;
      this.others.update((map) => new Map(map).set(loaded.groupId, { flags, name }));
    }
  }

  private reset(): void {
    this.requestId++;
    this.cache.clear();
    this.current.set(null);
    this.loading.set(false);
    this.failure.set(null);
    this.inFlight = null;
  }

  private read(groupId: string): Promise<void> {
    const promise = this.fetch(groupId);
    this.inFlight = { groupId, promise };
    return promise;
  }

  /** Reads a group that is not the working group; a failure is logged and leaves it unknown. */
  private async readOther(groupId: string): Promise<void> {
    try {
      const response = await firstValueFrom(
        this.http.get<ApiData<{ features?: unknown; name?: unknown }>>(
          `/v1/groups/${encodeURIComponent(groupId)}`,
        ),
      );
      const name = response.data.name;
      const entry = {
        flags: parseFlags(response.data.features),
        name: typeof name === 'string' ? name : '',
      };
      this.others.update((map) => new Map(map).set(groupId, entry));
    } catch (error) {
      this.describe(error);
    }
  }

  private async fetch(groupId: string): Promise<void> {
    const request = ++this.requestId;
    const cached = this.cache.get(groupId);
    if (this.current()?.groupId !== groupId) {
      this.retire();
      this.current.set(null);
    }
    this.loading.set(true);
    this.failure.set(null);
    let loaded: Loaded | Cached | null = null;
    let failure: ApiError | null = null;
    try {
      const headers =
        cached === undefined
          ? new HttpHeaders()
          : new HttpHeaders({ 'If-None-Match': cached.etag });
      const response = await firstValueFrom(
        this.http.get<ApiData<{ features?: unknown; name?: unknown }>>(
          `/v1/groups/${encodeURIComponent(groupId)}`,
          { headers, observe: 'response' },
        ),
      );
      const flags = parseFlags(response.body?.data.features);
      const name = response.body?.data.name;
      const base = { groupId, flags, name: typeof name === 'string' ? name : '' };
      const etag = response.headers.get('ETag');
      loaded = etag === null ? base : { ...base, etag };
    } catch (error) {
      if (error instanceof ApiError && error.status === 304 && cached !== undefined) {
        loaded = cached;
      } else {
        failure = this.describe(error);
      }
    }
    // An answer made obsolete (another group, or a sign-out that cleared the cache) is dropped
    // whole: it must not reach the cache of the next context either.
    if (request === this.requestId) {
      if (loaded !== null && 'etag' in loaded) {
        this.cache.set(groupId, loaded);
      }
      this.current.set(loaded);
      this.failure.set(failure);
      this.loading.set(false);
      this.inFlight = null;
    }
  }

  private describe(error: unknown): ApiError {
    console.warn(
      'Cannot read the features of the group',
      error instanceof ApiError ? error.code : 'unexpected',
    );
    return error instanceof ApiError
      ? error
      : new ApiError({ status: 0, code: 'UNKNOWN_ERROR', message: 'Unexpected error' });
  }

  private fail(error: unknown): void {
    this.failure.set(this.describe(error));
  }
}
