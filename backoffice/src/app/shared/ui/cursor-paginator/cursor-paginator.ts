import { Component, computed, input, output } from '@angular/core';
import { TPipe } from '../../../core/i18n/t-pipe';
import { Button } from '../button/button';
import { Icon } from '../icon/icon';
import { Select } from '../select/select';

/**
 * Cursor-based pagination controls: "previous" / "next" buttons and the page size, with no page
 * numbers (the backend only exposes `page.next`). The page keeps the stack of visited cursors
 * and decides what `previousPage` means; this component only reports intent.
 */
@Component({
  selector: 'fc-cursor-paginator',
  imports: [Button, Icon, Select, TPipe],
  templateUrl: './cursor-paginator.html',
  styleUrl: './cursor-paginator.css',
})
export class CursorPaginator {
  /** Current page size. */
  readonly limit = input.required<number>();
  /** Selectable page sizes. */
  readonly limits = input<readonly number[]>([10, 25, 50, 100]);
  /** Cursor of the next page from `page.next`, or `null` on the last page. */
  readonly nextCursor = input<string | null>(null);
  /** Whether a previous page exists (the caller has a cursor to go back to). */
  readonly hasPrevious = input(false);
  /** Disables the controls while a page is loading. */
  readonly loading = input(false);
  /** Emitted when the user asks for the previous page. */
  readonly previousPage = output<void>();
  /** Emitted with the cursor of the next page. */
  readonly nextPage = output<string>();
  /** Emitted with the new page size. */
  readonly limitChange = output<number>();

  protected readonly limitOptions = computed(() =>
    this.limits().map((value) => ({ value: String(value), label: String(value) })),
  );

  protected goNext(): void {
    // The button is disabled when there is no next cursor.
    this.nextPage.emit(this.nextCursor() as string);
  }

  protected changeLimit(value: string): void {
    this.limitChange.emit(Number(value));
  }
}
