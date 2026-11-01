/**
 * Runtime configuration of the static server, read from environment variables
 * and validated at startup (fail-fast). Error messages name the offending
 * variable but never echo its value.
 * @module
 */

/** Validated configuration of the static server. */
export interface ServerConfig {
  /** TCP port to listen on (0 picks an ephemeral port). */
  readonly port: number;
  /** Absolute or relative directory holding the Angular build output. */
  readonly staticRoot: string;
  /** Public API base URL, exposed to the SPA through `/config.json`. */
  readonly apiBaseUrl: string;
  /** Origin of the API (scheme, host, port), used in the CSP `connect-src`. */
  readonly apiOrigin: string;
}

/** Thrown when the environment does not describe a valid configuration. */
export class ConfigError extends Error {
  /** @param message Description of the problem, without secret values. */
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Default listening port. */
export const DEFAULT_PORT = 8080;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === '') {
    return DEFAULT_PORT;
  }
  if (!/^\d{1,5}$/.test(raw) || Number(raw) > 65535) {
    throw new ConfigError('PORT must be an integer between 0 and 65535');
  }
  return Number(raw);
}

function parseApiBaseUrl(raw: string | undefined): { apiBaseUrl: string; apiOrigin: string } {
  if (raw === undefined || raw === '') {
    throw new ConfigError('API_BASE_URL is required');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError('API_BASE_URL must be an absolute URL');
  }
  const secure = url.protocol === 'https:';
  const localPlain = url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname);
  if (!secure && !localPlain) {
    throw new ConfigError('API_BASE_URL must use https (http is allowed only for localhost and 127.0.0.1)');
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new ConfigError('API_BASE_URL must not contain credentials, query or fragment');
  }
  return { apiBaseUrl: raw, apiOrigin: url.origin };
}

/**
 * Builds the server configuration from environment variables.
 *
 * Variables: `PORT` (default 8080), `STATIC_ROOT` (default `defaultStaticRoot`),
 * `API_BASE_URL` (required: absolute `https:` URL, or `http:` for localhost
 * only, without credentials, query or fragment).
 *
 * @param env Environment variables (usually `process.env`).
 * @param defaultStaticRoot Directory served when `STATIC_ROOT` is not set.
 * @returns The validated configuration.
 * @throws {ConfigError} If a variable is missing or invalid.
 * @example
 * loadConfig({ API_BASE_URL: 'https://api.example.com' }, '/app/dist');
 */
export function loadConfig(
  env: Readonly<Record<string, string | undefined>>,
  defaultStaticRoot: string,
): ServerConfig {
  const staticRoot = env['STATIC_ROOT'] === undefined || env['STATIC_ROOT'] === '' ? defaultStaticRoot : env['STATIC_ROOT'];
  return { port: parsePort(env['PORT']), staticRoot, ...parseApiBaseUrl(env['API_BASE_URL']) };
}
