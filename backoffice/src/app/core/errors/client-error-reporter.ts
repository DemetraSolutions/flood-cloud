import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { ActivatedRouteSnapshot, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiError } from '../api/api-error';
import { SessionService } from '../session/session.service';
import { APP_VERSION } from './app-version';

/** Longest message sent (the backend accepts 300 characters). */
export const MAX_MESSAGE_LENGTH = 300;
/** Longest error name sent. */
const MAX_NAME_LENGTH = 100;
/** Stack lines sent. */
export const MAX_STACK_LINES = 10;
/** Longest route pattern sent. */
const MAX_ROUTE_LENGTH = 200;
/** Identical errors are reported once in this window (milliseconds). */
export const DEDUPE_WINDOW_MS = 60_000;
/** Reports sent per page load. */
export const MAX_REPORTS_PER_PAGE_LOAD = 10;

/** Body of `POST /v1/client-errors`. */
export interface ClientErrorReport {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly route: string;
  readonly appVersion: string;
  readonly occurredAt: string;
}

/** Longest line of the stack sent. */
const MAX_LINE_LENGTH = 300;
/** Quoted fragments longer than this are replaced (they may hold text typed by the user). */
const MAX_QUOTED_LENGTH = 20;
const QUOTED = new RegExp(`(["'\`])(?:(?!\\1)[^\\n]){${MAX_QUOTED_LENGTH + 1},}?\\1`, 'g');

/** Replaces long quoted fragments (JSON.parse, URL or Angular messages echo user input) with an ellipsis. */
function scrub(text: string): string {
  return text.replace(QUOTED, (_match, quote: string) => `${quote}…${quote}`);
}

/** Text of a value that is not an error; empty when it cannot be converted (null prototype, throwing `toString`). */
function describe(value: unknown): string {
  try {
    return String(value);
  } catch {
    return '';
  }
}

/** Whether the server already knows about this failure (an API call that failed). */
function isServerKnown(error: unknown): boolean {
  return error instanceof ApiError || error instanceof HttpErrorResponse;
}

/**
 * Route pattern of the active route as declared in the router configuration
 * (`/groups/:groupId/users`): never the concrete URL, so ids and query strings are not sent.
 */
function routePattern(root: ActivatedRouteSnapshot): string {
  const parts: string[] = [];
  let current: ActivatedRouteSnapshot | null = root;
  while (current !== null) {
    const path = current.routeConfig?.path;
    if (path) {
      parts.push(path);
    }
    current = current.firstChild;
  }
  return `/${parts.join('/')}`.slice(0, MAX_ROUTE_LENGTH);
}

/**
 * Reports unexpected JavaScript errors of signed-in users to the backend (`POST
 * /v1/client-errors`) so that they show up in the activity log. Errors of API calls are not
 * reported (the server saw them). Identical errors are sent once a minute, at most ten per page
 * load, and a failed report is only logged (never reported again). The report carries no
 * request data, token or form input.
 */
@Service()
export class ClientErrorReporter {
  private readonly http = inject(HttpClient);
  private readonly session = inject(SessionService);
  private readonly router = inject(Router);
  private readonly lastSent = new Map<string, number>();
  private sent = 0;

  /**
   * Sends the report of an error, when it qualifies. Never throws and never waits for the
   * server.
   *
   * @param error The unexpected value that reached the global error handler.
   */
  report(error: unknown): void {
    try {
      this.send(error);
    } catch (failure) {
      console.warn(
        'Error report not built',
        failure instanceof Error ? failure.name : 'unexpected',
      );
    }
  }

  private send(error: unknown): void {
    if (!this.session.isAuthenticated() || isServerKnown(error)) {
      return;
    }
    const body = this.build(error);
    const key = `${body.name}|${body.message}|${body.stack?.split('\n', 2).join('|') ?? ''}`;
    const now = Date.now();
    const previous = this.lastSent.get(key);
    if (
      this.sent >= MAX_REPORTS_PER_PAGE_LOAD ||
      (previous !== undefined && now - previous < DEDUPE_WINDOW_MS)
    ) {
      return;
    }
    this.sent += 1;
    this.lastSent.set(key, now);
    firstValueFrom(this.http.post<void>('/v1/client-errors', body)).catch((failure: unknown) => {
      console.warn(
        'Error report not delivered',
        failure instanceof ApiError ? failure.code : 'unexpected',
      );
    });
  }

  private build(error: unknown): ClientErrorReport {
    const isError = error instanceof Error;
    const rawName = isError ? error.name : 'NonError';
    const name = rawName.slice(0, MAX_NAME_LENGTH) || 'Error';
    const message = scrub((isError ? error.message : describe(error)).slice(0, MAX_MESSAGE_LENGTH));
    const rawStack = isError ? error.stack : undefined;
    const stack =
      typeof rawStack === 'string' && rawStack !== ''
        ? rawStack
            .split('\n')
            .slice(0, MAX_STACK_LINES)
            .map((line, index) =>
              index === 0 && line.startsWith(`${rawName}:`) ? `${name}: ${message}` : scrub(line),
            )
            .map((line) => line.slice(0, MAX_LINE_LENGTH))
            .join('\n')
        : undefined;
    return {
      name,
      message,
      ...(stack === undefined ? {} : { stack }),
      route: routePattern(this.router.routerState.snapshot.root),
      appVersion: APP_VERSION.slice(0, 32),
      occurredAt: new Date().toISOString(),
    };
  }
}
