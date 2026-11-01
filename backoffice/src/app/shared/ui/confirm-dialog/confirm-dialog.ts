import { Component, input, model, output } from '@angular/core';
import { TPipe } from '../../../core/i18n/t-pipe';
import { Button } from '../button/button';
import { Dialog } from '../dialog/dialog';

/**
 * Confirmation for destructive or irreversible actions. The `message` must name the object
 * ("Eliminare il punto vendita «Centro»?"). Confirming does NOT close the dialog: the page
 * closes it (`open.set(false)`) when the action succeeded, keeping it open with `busy` meanwhile.
 */
@Component({
  selector: 'fc-confirm-dialog',
  imports: [Button, Dialog, TPipe],
  templateUrl: './confirm-dialog.html',
})
export class ConfirmDialog {
  /** Dialog title (already translated). */
  readonly heading = input.required<string>();
  /** Question naming the object (already translated). */
  readonly message = input.required<string>();
  /** Label of the confirm button; defaults to the dictionary "Conferma". */
  readonly confirmLabel = input<string | null>(null);
  /** Uses the danger style for the confirm button. */
  readonly danger = input(false);
  /** Action in progress: confirm shows a spinner and both buttons are disabled. */
  readonly busy = input(false);
  /** Whether the dialog is open (two-way). */
  readonly open = model(false);
  /** Emitted when the user confirms. */
  readonly confirmed = output<void>();
}
