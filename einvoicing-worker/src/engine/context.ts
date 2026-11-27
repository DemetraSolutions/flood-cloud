/**
 * What the engine jobs share.
 *
 * @module
 */
import type { AccountRegistry } from '../accounts/registry.ts';
import type { Limiters } from '../limits/limiters.ts';
import type { Logger } from '../logger.ts';
import type { ProviderAdapter } from '../providers/types.ts';
import type { GroupStore } from './groups.ts';
import type { SentHistory } from './history.ts';
import type { QueueStore } from './queue.ts';

/** Collaborators of the upload and status jobs. */
export interface EngineContext {
  readonly queue: QueueStore;
  readonly history: SentHistory;
  readonly groups: GroupStore;
  readonly registry: AccountRegistry;
  readonly limiters: Limiters;
  /** The adapters, by provider. */
  readonly adapters: ReadonlyMap<string, ProviderAdapter>;
  readonly logger: Logger;
  /** Worker clock, in milliseconds since the epoch. */
  readonly clock: () => number;
  /** Waits `ms`, or less when the signal fires; never rejects. */
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** What the preparation job tells the others each round. */
export interface RoundState {
  /** When the round began. */
  startedAt: number;
  /** The hubs that may be processed this round: allowlisted, usable account, adapter present. Empty means nothing to do. */
  activeHubs: readonly string[];
  /** Grows every round: the starting point of the round robin over hubs and providers. */
  rotation: number;
}

/** Rotates a list by `by` positions, so the hub that went first last round goes last. */
export function rotate<T>(items: readonly T[], by: number): T[] {
  const offset = items.length === 0 ? 0 : by % items.length;
  return [...items.slice(offset), ...items.slice(0, offset)];
}

/**
 * What may be logged about an error: its name and code, never its message (an error thrown by an adapter must not leak a
 * body, a token or a document into the log).
 *
 * @param error Anything that was thrown.
 * @returns Fields for a log line.
 */
export function describeError(error: unknown): { readonly errorName: string; readonly errorCode?: string | number } {
  if (!(error instanceof Error)) {
    return { errorName: typeof error };
  }
  const code = (error as { code?: unknown }).code;
  return { errorName: error.name, ...(typeof code === 'string' || typeof code === 'number' ? { errorCode: code } : {}) };
}
