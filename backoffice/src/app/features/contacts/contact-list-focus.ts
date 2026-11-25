import { afterNextRender, Injector } from '@angular/core';

/**
 * Moves the focus once the list has rendered its change: to the first control of the row at
 * `index`, or, when there is no such row (the list is empty), to the button that adds one. A
 * keyboard user who removes or adds a row never loses their place.
 *
 * @param injector Injector of the component that owns the list.
 * @param host The element of the component (`ul.rows` and `.actions` are looked up inside it).
 * @param index Position of the row to focus (`-1` for none).
 */
export function focusRow(injector: Injector, host: HTMLElement, index: number): void {
  afterNextRender(
    () => {
      const row = host.querySelectorAll('ul.rows > li')[index];
      (row?.querySelector<HTMLElement>('input, button') ?? host.querySelector<HTMLElement>('.actions button'))?.focus();
    },
    { injector },
  );
}

/** Position to focus after the row at `removed` was taken out of a list that now has `length` rows: the next one, else the previous one, else none. */
export function indexAfterRemoval(removed: number, length: number): number {
  return Math.min(removed, length - 1);
}
