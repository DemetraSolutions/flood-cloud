/**
 * Fixed facts about Aruba's invoicing web services (API v2): hosts, the transmitter, the limits as data and the sizes
 * that bound every request and response.
 *
 * @module
 */
import type { ArubaEnvironment } from '../../config.ts';
import type { LimitRule } from '../../limits/limiters.ts';
import type { ProviderLimits } from '../types.ts';

/** The two hosts of an environment: authentication and web services. Neither carries a path or a trailing slash. */
export interface ArubaHosts {
  readonly auth: string;
  readonly ws: string;
}

const HOSTS: Readonly<Record<ArubaEnvironment, ArubaHosts>> = {
  demo: { auth: 'https://demoauth.fatturazioneelettronica.aruba.it', ws: 'https://demows.fatturazioneelettronica.aruba.it' },
  production: { auth: 'https://auth.fatturazioneelettronica.aruba.it', ws: 'https://ws.fatturazioneelettronica.aruba.it' },
};

/**
 * The hosts of an environment.
 *
 * @param environment `demo` or `production`.
 * @returns The authentication and web service hosts.
 */
export function arubaHosts(environment: ArubaEnvironment): ArubaHosts {
  return HOSTS[environment];
}

/**
 * The transmitter written in `IdTrasmittente`: Aruba PEC S.p.A., which Aruba requires (its error 0094 refuses any other
 * transmitter). A public company identifier, not a secret.
 */
export const ARUBA_TRANSMITTER = { IdPaese: 'IT', IdCodice: '01879020517' } as const;

const MINUTE = 60_000;

/** Aruba's `1 request per minute` on sign-in, with a margin (65 s) and a random extra (0-3 s). */
const AUTH_RULE: LimitRule = { minIntervalMs: 65_000, jitterMs: 3_000, maxPerHour: null, maxPerYear: null };

/** Aruba's limit on notification downloads (12 per minute), kept apart from the one on searches. */
export const NOTIFICATIONS_RULE: LimitRule = { minIntervalMs: 6_000, jitterMs: 1_500, maxPerHour: null, maxPerYear: null };

/**
 * Most the adapter waits for a per-IP limiter (sign-in, notifications, the requests of a search) inside one call; a longer
 * wait is handed back to the engine as a retry. A round of the engine must stay well inside the liveness window.
 */
export const MAX_SLOT_WAIT_MS = 10_000;

/** Most one `findSent` call works for, waits included (the engine round and the record lease must not run out). */
export const FIND_BUDGET_MS = 25_000;

/** Time before the end of an access token (1800 s) at which it is renewed. */
export const TOKEN_MARGIN_MS = 300_000;

/** How long Aruba honours a refresh token (60 minutes from issue), less a margin. */
export const REFRESH_VALIDITY_MS = 59 * MINUTE;

/**
 * Pauses of a hub after Aruba refused its credentials (`invalid_grant`), stepped on every consecutive refusal (the last
 * step repeats) and reset by a successful sign-in: the account must be fixed by a person, and every try counts against
 * Aruba's one sign-in a minute.
 */
export const INVALID_GRANT_STEPS_MS: readonly number[] = [5 * MINUTE, 30 * MINUTE, 120 * MINUTE];

/** Longest token (access or refresh) accepted from Aruba, and the character set of a header-safe token. */
export const TOKEN_PATTERN = /^[\x21-\x7e]{1,4096}$/;

/** Longest lifetime accepted for an access token, in seconds (Aruba gives 1800). */
export const MAX_EXPIRES_IN_S = 86_400;

/** Timeout of the upload request, in milliseconds. */
export const UPLOAD_TIMEOUT_MS = 60_000;

/** Timeout of every other request, in milliseconds. */
export const REQUEST_TIMEOUT_MS = 20_000;

/** Largest response read for the sign-in, the upload and the searches, in bytes. */
export const SMALL_RESPONSE_BYTES = 64 * 1024;

/** Largest response read for a detail, a search page or the notifications (they can carry a base64 file), in bytes. */
export const LARGE_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Shape of the file name Aruba gives to an uploaded invoice (`uploadFileName`), validated before it is stored or put in a URL. */
export const PROVIDER_ID_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * The longest one adapter call can take: a wait for a limiter, a sign-in request and the upload request itself. The worker
 * sizes the round budget, the record lease and the liveness window from it.
 */
export const MAX_CALL_MS = MAX_SLOT_WAIT_MS + REQUEST_TIMEOUT_MS + UPLOAD_TIMEOUT_MS;

/**
 * The limits of Aruba as data for the engine. The per-IP numbers come from Aruba's SLA (upload 30 per minute, search and
 * detail 12 per minute, sign-in 1 per minute) and from the legacy, which ran in production with them; the per-account
 * pacing keeps a tiered account under its hourly leaky bucket (an excess is answered with `429` at once and any request,
 * even a rejected one, restarts the bucket's one-hour expiry).
 */
export const ARUBA_LIMITS: ProviderLimits = {
  ip: {
    upload: { minIntervalMs: 3_000, jitterMs: 500, maxPerHour: null, maxPerYear: null },
    status: { minIntervalMs: 6_000, jitterMs: 1_500, maxPerHour: null, maxPerYear: null },
    auth: AUTH_RULE,
  },
  account: {
    // 55 uploads an hour (the default of the 60-per-hour tier with a margin) are spaced 65 s apart; other caps are spread evenly.
    minIntervalMs: (maxPerHour) => (maxPerHour === 55 ? 65_000 : Math.max(3_000, Math.ceil(3_600_000 / maxPerHour))),
    jitterMs: 3_000,
    backoffStepsMs: [10 * MINUTE, 25 * MINUTE, 62 * MINUTE],
  },
  maxCallMs: MAX_CALL_MS,
};
