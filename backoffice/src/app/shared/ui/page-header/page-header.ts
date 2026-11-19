import { Component, input } from '@angular/core';

/**
 * Header of a page: the title, the badges that follow it (projected by default) and, at the end
 * of the line, the actions of the page (projected with the `fcPageActions` attribute). The one
 * place of the save button of a detail page is the last of the actions: secondary actions
 * ("Indietro", "Annulla") come before it. On a narrow screen the actions wrap under the title.
 *
 * ```html
 * <fc-page-header [heading]="name">
 *   <fc-status-badge>…</fc-status-badge>
 *   <ng-container fcPageActions>
 *     <a routerLink="..">Indietro</a>
 *     <button fc-button type="submit" form="my-form">Salva</button>
 *   </ng-container>
 * </fc-page-header>
 * ```
 */
@Component({
  selector: 'fc-page-header',
  template: `
    <header class="page-header">
      <h1>{{ heading() }}</h1>
      <ng-content />
      <div class="page-actions"><ng-content select="[fcPageActions]" /></div>
    </header>
  `,
  styles: `
    :host {
      display: block;
    }

    .page-header {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-2) var(--space-3);
    }

    h1 {
      margin-inline-end: auto;
    }

    .page-actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: flex-end;
      gap: var(--space-2);
      margin-inline-start: auto;
    }

    .page-actions:empty {
      display: none;
    }
  `,
})
export class PageHeader {
  /** Title of the page (already translated). */
  readonly heading = input.required<string>();
}
