import {
  DestroyRef,
  Directive,
  effect,
  inject,
  input,
  Service,
  signal,
  TemplateRef,
} from '@angular/core';

/** Context of the templates rendered per row; `let-row` receives the row. */
export interface RowContext<T> {
  readonly $implicit: T;
}

/**
 * Registry that {@link DataTable} provides to its content: the `fcCell` and `fcRowActions`
 * templates declared inside the table register themselves here.
 */
@Service({ autoProvided: false })
export class TableTemplates {
  private readonly cellState = signal<ReadonlyMap<string, TemplateRef<RowContext<unknown>>>>(
    new Map(),
  );
  private readonly actionsState = signal<TemplateRef<RowContext<unknown>> | null>(null);

  /** Custom cell templates by column key. */
  readonly cells = this.cellState.asReadonly();
  /** Row actions template, if declared. */
  readonly actions = this.actionsState.asReadonly();

  /** Registers the template of a column. */
  setCell(key: string, template: TemplateRef<RowContext<unknown>>): void {
    this.cellState.update((cells) => new Map(cells).set(key, template));
  }

  /** Removes the template of a column. */
  removeCell(key: string): void {
    this.cellState.update((cells) => {
      const next = new Map(cells);
      next.delete(key);
      return next;
    });
  }

  /** Registers the row actions template. */
  setActions(template: TemplateRef<RowContext<unknown>> | null): void {
    this.actionsState.set(template);
  }
}

/**
 * Custom cell for one column of {@link DataTable}:
 * `<ng-template fcCell="status" let-row><fc-status-badge>…</fc-status-badge></ng-template>`.
 * `row` is untyped inside the template.
 */
@Directive({ selector: 'ng-template[fcCell]' })
export class CellTemplate {
  /** Key of the column this template renders. */
  readonly key = input.required<string>({ alias: 'fcCell' });

  constructor() {
    const registry = inject(TableTemplates);
    const template = inject<TemplateRef<RowContext<unknown>>>(TemplateRef);
    effect((onCleanup) => {
      const key = this.key();
      registry.setCell(key, template);
      onCleanup(() => registry.removeCell(key));
    });
  }
}

/**
 * Row actions of {@link DataTable}, rendered in a last column:
 * `<ng-template fcRowActions let-row>…buttons…</ng-template>`. `row` is untyped inside the template.
 */
@Directive({ selector: 'ng-template[fcRowActions]' })
export class RowActionsTemplate {
  constructor() {
    const registry = inject(TableTemplates);
    registry.setActions(inject<TemplateRef<RowContext<unknown>>>(TemplateRef));
    inject(DestroyRef).onDestroy(() => registry.setActions(null));
  }
}
