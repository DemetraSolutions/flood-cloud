import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject, input, output } from '@angular/core';
import { TPipe } from '../../../core/i18n/t-pipe';
import { EmptyState } from '../empty-state/empty-state';
import { Icon } from '../icon/icon';
import { IconName } from '../icon/icons';
import { Skeleton } from '../skeleton/skeleton';
import { TableColumn, TableSort } from './data-table.types';
import { TableTemplates } from './table-templates';

/**
 * Dense data table on native `<table>`: declarative columns, sortable headers (a button inside
 * the `<th>`, state in `aria-sort`), custom cells and row actions through templates, loading
 * and empty states. Sorting is only emitted (`sortChange`): data and order belong to the page.
 */
@Component({
  selector: 'fc-data-table',
  imports: [NgTemplateOutlet, EmptyState, Icon, Skeleton, TPipe],
  templateUrl: './data-table.html',
  styleUrl: './data-table.css',
  providers: [TableTemplates],
})
export class DataTable<T> {
  /** Accessible name of the table (visually hidden `<caption>`). */
  readonly caption = input.required<string>();
  /** Column definitions. */
  readonly columns = input.required<readonly TableColumn<T>[]>();
  /** Rows of the current page. */
  readonly rows = input.required<readonly T[]>();
  /** Stable identity of a row, used for tracking. */
  readonly rowKey = input.required<(row: T) => string>();
  /** Shows the loading skeleton instead of the rows. */
  readonly loading = input(false);
  /** Current sort, if any. */
  readonly sort = input<TableSort | null>(null);
  /** Key of the column whose cells are row headers (`<th scope="row">`). */
  readonly rowHeader = input<string | null>(null);
  /** Empty-state headline; defaults to the dictionary text. */
  readonly emptyTitle = input<string | null>(null);
  /** Empty-state explanation; defaults to the dictionary text. */
  readonly emptyMessage = input<string | null>(null);
  /** Emitted when the user asks to sort by a column. */
  readonly sortChange = output<TableSort>();

  private readonly templates = inject(TableTemplates);

  protected readonly cellTemplates = this.templates.cells;
  protected readonly actions = this.templates.actions;
  protected readonly columnCount = computed(
    () => this.columns().length + (this.actions() === null ? 0 : 1),
  );

  protected ariaSort(column: TableColumn<T>): 'ascending' | 'descending' | null {
    const sort = this.sort();
    if (sort?.key !== column.key) {
      return null;
    }
    return sort.direction === 'asc' ? 'ascending' : 'descending';
  }

  protected sortIcon(column: TableColumn<T>): IconName {
    const state = this.ariaSort(column);
    if (state === null) {
      return 'sort';
    }
    return state === 'ascending' ? 'chevron-up' : 'chevron-down';
  }

  protected toggleSort(column: TableColumn<T>): void {
    const direction = this.ariaSort(column) === 'ascending' ? 'desc' : 'asc';
    this.sortChange.emit({ key: column.key, direction });
  }
}
