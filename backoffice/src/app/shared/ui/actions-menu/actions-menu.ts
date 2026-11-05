import { Component, ElementRef, inject, input, signal, viewChild } from '@angular/core';
import { Icon } from '../icon/icon';
import { uniqueId } from '../unique-id';

/**
 * Compact "Actions" menu for table rows, built as an accessible disclosure: one icon button that
 * toggles a panel of buttons (projected as content). Esc closes it and returns the focus to the
 * button, leaving the menu with the keyboard or the pointer closes it, and so does choosing an
 * action. The panel is fixed-positioned under the button so that a scrolling table does not clip it.
 */
@Component({
  selector: 'fc-actions-menu',
  imports: [Icon],
  templateUrl: './actions-menu.html',
  styleUrl: './actions-menu.css',
  host: {
    '(focusout)': 'onFocusOut($event)',
    '(keydown.escape)': 'onEscape($event)',
    '(window:resize)': 'close()',
  },
})
export class ActionsMenu {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly trigger = viewChild.required<ElementRef<HTMLButtonElement>>('trigger');

  /** Tooltip of the icon-only button (already translated). */
  readonly text = input.required<string>();
  /** Accessible name of the button, naming the row (already translated). */
  readonly label = input.required<string>();

  protected readonly panelId = uniqueId('fc-actions-menu');
  protected readonly open = signal(false);
  protected readonly top = signal(0);
  protected readonly right = signal(0);

  protected toggle(): void {
    if (!this.open()) {
      const box = this.trigger().nativeElement.getBoundingClientRect();
      this.top.set(box.bottom + 4);
      this.right.set(window.innerWidth - box.right);
    }
    this.open.update((value) => !value);
  }

  /** Closes the panel. */
  protected close(): void {
    this.open.set(false);
  }

  /** An action was chosen: close and park the focus on the button (a dialog restores it there). */
  protected onPanelClick(): void {
    this.close();
    this.trigger().nativeElement.focus();
  }

  protected onEscape(event: Event): void {
    if (this.open()) {
      event.stopPropagation();
      this.close();
      this.trigger().nativeElement.focus();
    }
  }

  protected onFocusOut(event: FocusEvent): void {
    if (!this.host.nativeElement.contains(event.relatedTarget as Node | null)) {
      this.close();
    }
  }
}
