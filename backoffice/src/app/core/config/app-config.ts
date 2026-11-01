import { HttpClient } from '@angular/common/http';
import { inject, Service, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

/** Public runtime configuration served as `/config.json` (same origin). Contains no secrets. */
export type PublicConfig = { readonly apiBaseUrl: string };

/** Location of the public configuration file. */
export const CONFIG_URL = '/config.json';

const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1']);

/**
 * Validates the raw configuration by allowlist: only `apiBaseUrl` is read, as an absolute
 * `https:` URL (`http:` only for `localhost` / `127.0.0.1`) without credentials, query or
 * fragment. The trailing slash is removed.
 *
 * @param raw Parsed JSON of unknown shape.
 * @returns The validated configuration.
 * @throws Error when the configuration is missing or invalid.
 */
export function parsePublicConfig(raw: unknown): PublicConfig {
  if (typeof raw !== 'object' || raw === null || !('apiBaseUrl' in raw)) {
    throw new Error('Invalid public configuration: "apiBaseUrl" is missing.');
  }
  const value = raw.apiBaseUrl;
  if (typeof value !== 'string' || !URL.canParse(value) || /[?#]/.test(value)) {
    throw new Error('Invalid public configuration: "apiBaseUrl" is not a valid absolute URL.');
  }
  const url = new URL(value);
  const secure = url.protocol === 'https:';
  const localHttp = url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname);
  if (!secure && !localHttp) {
    throw new Error('Invalid public configuration: "apiBaseUrl" must use https.');
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('Invalid public configuration: "apiBaseUrl" must not contain credentials.');
  }
  return { apiBaseUrl: `${url.origin}${url.pathname.replace(/\/+$/, '')}` };
}

/** Read-only access to the public runtime configuration, loaded once at startup. */
@Service()
export class AppConfig {
  private readonly http = inject(HttpClient);
  private readonly apiBaseUrlState = signal<string | null>(null);

  /** Absolute API base URL without trailing slash; `null` until {@link load} succeeds. */
  readonly apiBaseUrl = this.apiBaseUrlState.asReadonly();

  /**
   * Downloads and validates `/config.json`.
   *
   * @throws Error when the file cannot be fetched or its content is invalid.
   */
  async load(): Promise<void> {
    const raw = await firstValueFrom(this.http.get<unknown>(CONFIG_URL));
    this.apiBaseUrlState.set(parsePublicConfig(raw).apiBaseUrl);
  }
}
