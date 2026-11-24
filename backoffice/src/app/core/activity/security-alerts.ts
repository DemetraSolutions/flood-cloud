import { HttpClient } from '@angular/common/http';
import { DOCUMENT } from '@angular/common';
import { computed, effect, inject, Service, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiData } from '../api/api.types';
import { SessionService } from '../session/session.service';
import { readStorage, writeStorage } from '../storage';

/** Permission needed to read the alerts. */
export const ALERTS_PERMISSION = 'activityLog:read';
/** Milliseconds between two reads of the alert count. */
export const ALERTS_POLL_MS = 300_000;
/** Days back the first read looks when the user never opened the alerts. */
export const ALERTS_FIRST_VISIT_DAYS = 7;
/** `localStorage` key prefix of the last visit to the alerts; the user id completes it. */
export const ALERTS_SEEN_KEY_PREFIX = 'fc.alertsSeenAt:';
/** The most alerts the badge shows; more are shown as `99+`. */
export const ALERTS_BADGE_MAX = 99;

const DAY_MS = 86_400_000;
/** The server refuses a `since` older than 30 days: stay a day inside the limit, so clock skew never makes it fail. */
const MAX_AGE_MS = 29 * DAY_MS;
const ENDPOINT = '/v1/activity-log/alerts/count';

/** Body of the count read. */
interface AlertCount {
  readonly count: number;
  readonly capped: boolean;
}

/** The count of a response, or an error when the body is not what the contract says. */
function parseCount(body: ApiData<AlertCount>): AlertCount {
  const { count, capped } = body.data;
  if (!Number.isInteger(count) || count < 0 || typeof capped !== 'boolean') {
    throw new Error('Unexpected alert count response');
  }
  return { count, capped };
}

/**
 * Security alerts of the activity log, as a badge on the menu and a notice on the log page.
 *
 * While a user who can read the log is signed in, the service reads the number of alerts raised
 * since their last visit (`GET /v1/activity-log/alerts/count`) at once and then every
 * {@link ALERTS_POLL_MS}, only while the browser tab is visible; it stops, and forgets the
 * count, when the session ends. What is an alert is decided by the server; the client only
 * passes the date of the last visit, kept per user in `localStorage` (the service works without
 * it). A failed read shows nothing and keeps the last count; the next read tries again.
 */
@Service()
export class SecurityAlerts {
  private readonly http = inject(HttpClient);
  private readonly session = inject(SessionService);
  private readonly document = inject(DOCUMENT);

  private readonly countState = signal(0);
  private readonly cappedState = signal(false);
  private readonly sinceState = signal(this.defaultSince());
  private userId: string | null = null;
  private generation = 0;
  private lastReadAt = 0;

  /** Alerts raised since the last visit (at most 100). */
  readonly count = this.countState.asReadonly();
  /** Whether there are more alerts than {@link count}. */
  readonly capped = this.cappedState.asReadonly();
  /** ISO date-time of the last visit: the alerts after it are new. */
  readonly since = this.sinceState.asReadonly();
  /** Text of the badge (`3`, `99+`), `null` when there is nothing to show. */
  readonly badge = computed(() => {
    const count = this.countState();
    if (count === 0) {
      return null;
    }
    return this.cappedState() || count > ALERTS_BADGE_MAX ? `${ALERTS_BADGE_MAX}+` : String(count);
  });

  /** The user whose alerts are watched: signed in and allowed to read the log. */
  private readonly watched = computed(() =>
    this.session.status() === 'authenticated' && this.session.can(ALERTS_PERMISSION)
      ? this.session.me()?.id
      : undefined,
  );

  constructor() {
    effect((onCleanup) => {
      const userId = this.watched();
      if (userId === undefined) {
        return;
      }
      untracked(() => this.start(userId));
      const timer = setInterval(() => this.onTick(), ALERTS_POLL_MS);
      const onVisibility = (): void => this.onVisibility();
      this.document.addEventListener('visibilitychange', onVisibility);
      onCleanup(() => {
        clearInterval(timer);
        this.document.removeEventListener('visibilitychange', onVisibility);
        this.stop();
      });
    });
  }

  /**
   * Records the visit to the alerts now and clears the count. The next reads count the alerts
   * raised after this moment. Does nothing when nobody is watched.
   */
  markSeen(): void {
    if (this.userId === null) {
      return;
    }
    const now = new Date().toISOString();
    writeStorage(`${ALERTS_SEEN_KEY_PREFIX}${this.userId}`, now);
    // A read in flight asked for the old date: its answer is no longer valid.
    this.generation++;
    this.sinceState.set(now);
    this.countState.set(0);
    this.cappedState.set(false);
  }

  private start(userId: string): void {
    this.userId = userId;
    this.sinceState.set(this.storedSince(userId));
    void this.read();
  }

  private stop(): void {
    this.userId = null;
    this.generation++;
    this.countState.set(0);
    this.cappedState.set(false);
    this.sinceState.set(this.defaultSince());
  }

  private onTick(): void {
    if (this.document.visibilityState === 'visible') {
      void this.read();
    }
  }

  /** A tab that was hidden catches up as soon as it is shown again, if a read is due. */
  private onVisibility(): void {
    if (
      this.document.visibilityState === 'visible' &&
      Date.now() - this.lastReadAt >= ALERTS_POLL_MS
    ) {
      void this.read();
    }
  }

  private async read(): Promise<void> {
    const generation = this.generation;
    this.lastReadAt = Date.now();
    try {
      const body = await firstValueFrom(
        this.http.get<ApiData<AlertCount>>(ENDPOINT, { params: { since: this.requestSince() } }),
      );
      const { count, capped } = parseCount(body);
      if (generation === this.generation) {
        this.countState.set(count);
        this.cappedState.set(capped);
      }
    } catch (error) {
      console.warn('Cannot read the security alerts', error);
    }
  }

  /** The date of the last visit, never older than the server accepts. */
  private requestSince(): string {
    const oldest = Date.now() - MAX_AGE_MS;
    return new Date(Math.max(Date.parse(this.sinceState()), oldest)).toISOString();
  }

  private storedSince(userId: string): string {
    const stored = Date.parse(readStorage(`${ALERTS_SEEN_KEY_PREFIX}${userId}`) ?? '');
    // A value that is not a date, or lies in the future (changed clock), starts over.
    return Number.isNaN(stored) || stored > Date.now()
      ? this.defaultSince()
      : new Date(stored).toISOString();
  }

  private defaultSince(): string {
    return new Date(Date.now() - ALERTS_FIRST_VISIT_DAYS * DAY_MS).toISOString();
  }
}
