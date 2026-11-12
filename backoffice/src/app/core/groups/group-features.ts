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
 * The features (modules) turned on for the group the user works on (tasks 4.3.2 and 4.5.2).
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
        } else if (!chooser || this.lastContextId !== null) {
          // Signed out, or the user went back to "all groups". A page that asked for the
          // features of its own group before any choice (a deep link) is left alone.
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
   * Makes the features of a group available: users bound to a group have them already;
   * for a PSA or dealer the group is read unless it is the one already loaded. Never rejects: a
   * failure is kept in {@link error}.
   *
   * @param groupId The group the user is heading to.
   */
  ensure(groupId: string): Promise<void> {
    if (!this.groups.canChoose() || this.current()?.groupId === groupId) {
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
    return this.enabled(feature);
  }

  /**
   * Reads the features again after the group was changed: from the profile for users bound to
   * a group, from the group (conditional request) for PSA and dealers. Never rejects.
   */
  async refresh(): Promise<void> {
    if (!this.groups.canChoose()) {
      try {
        await this.session.loadProfile();
      } catch (error) {
        this.fail(error);
      }
      return;
    }
    const groupId = this.current()?.groupId ?? this.groups.groupId();
    if (groupId !== null) {
      await this.read(groupId);
    }
  }

  private fixedFlags(): FeatureFlags | null {
    return this.session.me()?.groupFeatures ?? null;
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

  private async fetch(groupId: string): Promise<void> {
    const request = ++this.requestId;
    const cached = this.cache.get(groupId);
    if (this.current()?.groupId !== groupId) {
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
        this.http.get<ApiData<{ features?: unknown }>>(
          `/v1/groups/${encodeURIComponent(groupId)}`,
          { headers, observe: 'response' },
        ),
      );
      const flags = parseFlags(response.body?.data.features);
      const etag = response.headers.get('ETag');
      loaded = etag === null ? { groupId, flags } : { groupId, flags, etag };
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
