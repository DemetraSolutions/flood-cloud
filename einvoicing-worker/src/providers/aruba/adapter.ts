/**
 * The Aruba adapter: Aruba's invoicing web services (API v2) behind the provider contract of the engine.
 *
 * | Operation | Aruba |
 * |---|---|
 * | sign-in, renewal | `POST {auth}/auth/signin` (`session.ts`) |
 * | upload | `POST {ws}/services/invoice/upload` (`upload.ts`) |
 * | status | `GET {ws}/api/v2/invoices-out/detail`, and `.../notifications` for a discard (`status.ts`) |
 * | search after a crash | `GET {ws}/api/v2/invoices-out` (`find-sent.ts`) |
 *
 * The adapter holds no persistent state of its own: the tokens live in memory (and are renewed), the anti-tappo memory is
 * in memory, and everything that must survive a restart (spacing, hourly and yearly counts, cooldowns, backoff) is in the
 * persistent limiters of the engine.
 *
 * @module
 */
import type { ArubaEnvironment } from '../../config.ts';
import type { AccountRegistry } from '../../accounts/registry.ts';
import type { Limiters } from '../../limits/limiters.ts';
import type { Logger } from '../../logger.ts';
import type { ProviderAdapter } from '../types.ts';
import type { ArubaContext } from './context.ts';
import { createFinder } from './find-sent.ts';
import { createSessions } from './session.ts';
import { ARUBA_LIMITS, ARUBA_TRANSMITTER, arubaHosts, REQUEST_TIMEOUT_MS, UPLOAD_TIMEOUT_MS } from './settings.ts';
import type { ArubaHosts } from './settings.ts';
import { createStatusReader } from './status.ts';
import { createUploader } from './upload.ts';

/** Collaborators of {@link createArubaAdapter}. */
export interface ArubaDeps {
  /** `demo` or `production`: decides the hosts. */
  readonly environment: ArubaEnvironment;
  /** Read again right before every sign-in. */
  readonly registry: Pick<AccountRegistry, 'get'>;
  readonly limiters: Limiters;
  readonly logger: Logger;
  readonly clock: () => number;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Replaces `fetch` (tests). */
  readonly fetch?: typeof fetch;
  /** Replaces the hosts of the environment (tests, with a local fake of Aruba). */
  readonly hosts?: ArubaHosts;
  /** Replaces the timeouts, in milliseconds (tests). */
  readonly timeouts?: { readonly upload: number; readonly request: number };
}

/**
 * Creates the Aruba adapter.
 *
 * @param deps Environment, registry, limiters, logger, clock and sleep.
 * @returns The adapter.
 */
export function createArubaAdapter(deps: ArubaDeps): ProviderAdapter {
  const hosts = deps.hosts ?? arubaHosts(deps.environment);
  const timeouts = deps.timeouts ?? { upload: UPLOAD_TIMEOUT_MS, request: REQUEST_TIMEOUT_MS };
  const fetcher = deps.fetch ?? fetch;
  const sessions = createSessions({ hosts, fetch: fetcher, registry: deps.registry, limiters: deps.limiters, rule: ARUBA_LIMITS.ip.auth, timeoutMs: timeouts.request, logger: deps.logger, clock: deps.clock, sleep: deps.sleep });
  const ctx: ArubaContext = { hosts, fetch: fetcher, sessions, limiters: deps.limiters, logger: deps.logger, clock: deps.clock, sleep: deps.sleep, timeouts };
  const uploader = createUploader(ctx);
  const reader = createStatusReader(ctx);
  const finder = createFinder(ctx);
  return {
    provider: 'aruba',
    transmitter: ARUBA_TRANSMITTER,
    limits: ARUBA_LIMITS,
    upload: (account, file, signal) => uploader.upload(account, file, signal),
    status: (account, providerId, signal) => reader.status(account, providerId, signal),
    findSent: (account, ref, signal) => finder.findSent(account, ref, signal),
    forget(hub) {
      sessions.forget(hub);
      uploader.forget(hub);
    },
  };
}
