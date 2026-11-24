import { DOCUMENT } from '@angular/common';
import {
  booleanAttribute,
  Component,
  effect,
  ElementRef,
  inject,
  input,
  model,
  output,
} from '@angular/core';
import { TPipe } from '../../../core/i18n/t-pipe';
import { IconButton } from '../icon-button/icon-button';
import { uniqueId } from '../unique-id';

/**
 * Modal dialog on the native `<dialog>`: the browser provides the focus trap, inertness of the
 * page and Esc. This component adds the accessible name, a close button and returns the focus to
 * the element that had it when the dialog opened. Footer buttons are projected with the
 * `fcDialogActions` attribute.
 */
@Component({
  selector: 'fc-dialog',
  imports: [IconButton, TPipe],
  templateUrl: './dialog.html',
  styleUrl: './dialog.css',
})
export class Dialog {
  private readonly document = inject(DOCUMENT);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private opener: HTMLElement | null = null;

  /** Title of the dialog; also its accessible name. */
  readonly heading = input.required<string>();
  /** Wider panel, for long forms. */
  readonly wide = input(false, { transform: booleanAttribute });
  /** Announces the dialog as an alert (`alertdialog`): for warnings that need an answer before going on. */
  readonly alert = input(false, { transform: booleanAttribute });
  /** Whether the dialog is open (two-way). */
  readonly open = model(false);
  /** Emitted after the dialog closed, whatever the reason. */
  readonly closed = output<void>();

  protected readonly headingId = uniqueId('fc-dialog-title');
  protected readonly bodyId = uniqueId('fc-dialog-body');

  constructor() {
    effect(() => {
      const element = this.host.nativeElement.querySelector('dialog') as HTMLDialogElement;
      if (this.open()) {
        if (!element.open) {
          this.opener = this.document.activeElement as HTMLElement | null;
          element.showModal();
        }
      } else if (element.open) {
        element.close();
      }
    });
  }

  protected onClose(): void {
    this.open.set(false);
    this.opener?.focus();
    this.opener = null;
    this.closed.emit();
  }
}
