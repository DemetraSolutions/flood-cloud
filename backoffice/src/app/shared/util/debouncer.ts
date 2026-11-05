import { DestroyRef, inject } from '@angular/core';

/** Delays an action until calls stop for a while; only the last scheduled action runs. */
export interface Debouncer {
  /** Schedules `action`, replacing any action still waiting. */
  schedule(action: () => void): void;
  /** Drops the waiting action, if any. */
  cancel(): void;
}

/** Default delay for search-as-you-type inputs, in milliseconds. */
export const SEARCH_DEBOUNCE_MS = 300;

/**
 * Creates a {@link Debouncer} bound to the current injection context: a pending action is
 * dropped when the component or service is destroyed.
 *
 * @param delay Milliseconds to wait after the last `schedule`.
 */
export function createDebouncer(delay: number = SEARCH_DEBOUNCE_MS): Debouncer {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = (): void => {
    clearTimeout(timer);
    timer = undefined;
  };
  inject(DestroyRef).onDestroy(cancel);
  return {
    schedule(action) {
      cancel();
      timer = setTimeout(() => {
        timer = undefined;
        action();
      }, delay);
    },
    cancel,
  };
}
