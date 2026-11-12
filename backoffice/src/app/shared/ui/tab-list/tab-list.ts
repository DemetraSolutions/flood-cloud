import { Component, ElementRef, inject, input, model } from '@angular/core';
import { TPipe } from '../../../core/i18n/t-pipe';
import { StatusBadge } from '../status-badge/status-badge';

/** A tab of a {@link TabList}. */
export interface TabItem {
  /** Identifier; the tab is `<idPrefix>-tab-<id>`, its panel `<idPrefix>-panel-<id>`. */
  readonly id: string;
  /** Text of the tab (already translated). */
  readonly label: string;
  /** Errors in the section, shown as a badge when above zero. */
  readonly errors?: number;
}

/**
 * The tab strip of a long form made of sections that share one save: `role="tablist"` with
 * arrow keys, Home and End. The panels are written by the user of the component (all in the DOM,
 * the inactive ones `hidden`) with the ids `<idPrefix>-panel-<id>` and `role="tabpanel"`, so that
 * every field stays in the form and keeps its errors.
 */
@Component({
  selector: 'fc-tab-list',
  imports: [StatusBadge, TPipe],
  templateUrl: './tab-list.html',
  styleUrl: './tab-list.css',
})
export class TabList {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** Accessible name of the tab strip (already translated). */
  readonly label = input.required<string>();
  /** The tabs, in order. */
  readonly tabs = input.required<readonly TabItem[]>();
  /** Prefix of the ids of tabs and panels (unique in the page). */
  readonly idPrefix = input.required<string>();
  /** Identifier of the active tab (two-way). */
  readonly active = model.required<string>();

  protected onKey(event: KeyboardEvent): void {
    const tabs = this.tabs();
    const last = tabs.length - 1;
    const at = tabs.findIndex((tab) => tab.id === this.active());
    const target = {
      ArrowRight: at === last ? 0 : at + 1,
      ArrowLeft: at === 0 ? last : at - 1,
      Home: 0,
      End: last,
    }[event.key];
    if (target !== undefined) {
      event.preventDefault();
      this.active.set(tabs[target].id);
      this.host.nativeElement
        .querySelector<HTMLElement>(`#${this.idPrefix()}-tab-${tabs[target].id}`)
        ?.focus();
    }
  }
}
