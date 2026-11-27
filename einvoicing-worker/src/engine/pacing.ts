/**
 * Keys and helpers that apply a provider's limits (data) with the persistent limiters.
 *
 * @module
 */
import type { LimitRule, Limiters } from '../limits/limiters.ts';
import type { Account, ProviderAdapter } from '../providers/types.ts';

/** Key of an account limiter. */
export const accountKey = (hub: string, kind: 'upload' | 'status' | 'auth'): string => `account:${hub}:${kind}`;

/** The per-IP limiters: the engine uses `upload` and `status`, an adapter also `auth` and `notifications` (its own requests). */
export type IpKind = 'upload' | 'status' | 'auth' | 'notifications';

/** Key of a per-IP limiter, shared by every account of the provider. */
export const ipKey = (provider: string, kind: IpKind): string => `ip:${provider}:${kind}`;

/** Prefix of the seller cooldown keys of a hub. */
export const sellerPrefix = (hub: string): string => `seller:${hub}:`;

/** The rule of an account's uploads: the provider's pacing and the account's own caps. */
export function accountRule(adapter: ProviderAdapter, account: Account): LimitRule {
  const { minIntervalMs, jitterMs } = adapter.limits.account;
  return { minIntervalMs: minIntervalMs(account.maxPerHour), jitterMs, maxPerHour: account.maxPerHour, maxPerYear: account.maxPerYear };
}

/** Collaborators of the pacing helpers. */
export interface Pacing {
  readonly limiters: Limiters;
  readonly clock: () => number;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Whether the per-IP limiter will be free before `deadline` (so waiting for it fits the round).
 *
 * @param pacing Limiters and clock.
 * @param adapter The provider.
 * @param kind Which limiter.
 * @param deadline Instant the round ends.
 */
export function ipFreeBefore(pacing: Pacing, adapter: ProviderAdapter, kind: 'upload' | 'status', deadline: number): boolean {
  return pacing.limiters.gate(ipKey(adapter.provider, kind), adapter.limits.ip[kind], pacing.clock()).at <= deadline;
}

/**
 * Waits for the per-IP spacing (a few seconds, never past `deadline`) and records the use.
 *
 * @param pacing Limiters, clock and sleep.
 * @param adapter The provider.
 * @param kind Which limiter.
 * @param deadline Instant the round ends.
 * @param signal Aborted when the lease is lost or the worker stops.
 * @returns `false` when the wait does not fit the round or the signal fired: the caller gives up for now.
 * @throws {FencedError} When a newer epoch owns the limiter.
 */
export async function takeIpSlot(pacing: Pacing, adapter: ProviderAdapter, kind: 'upload' | 'status', deadline: number, signal: AbortSignal): Promise<boolean> {
  const key = ipKey(adapter.provider, kind);
  const rule = adapter.limits.ip[kind];
  const gate = pacing.limiters.gate(key, rule, pacing.clock());
  if (gate.at > deadline) {
    return false;
  }
  const wait = gate.at - pacing.clock();
  if (wait > 0) {
    await pacing.sleep(wait, signal);
  }
  if (signal.aborted) {
    return false;
  }
  await pacing.limiters.consume(key, rule, pacing.clock());
  return true;
}
