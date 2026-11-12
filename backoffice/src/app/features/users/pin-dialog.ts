import {
  Component,
  computed,
  effect,
  input,
  model,
  output,
  signal,
  untracked,
} from '@angular/core';
import { TPipe } from '../../core/i18n/t-pipe';
import { PIN_PATTERN } from '../../core/users/pin';
import { Button } from '../../shared/ui/button/button';
import { Dialog } from '../../shared/ui/dialog/dialog';
import { TextField } from '../../shared/ui/text-field/text-field';

/** What the PIN dialog hands to the page when confirmed (`pin` is `null` to remove the PIN). */
export interface PinSubmission {
  readonly pin: string | null;
  readonly password: string;
}

/**
 * Dialog to set or remove a PIN. The values typed (PIN and, when asked, the current password) live
 * only in signals of this dialog, are cleared whenever it closes and never reach logs or
 * storage. It does no request: the page that opened it sends the submission and shows the
 * server's answers through `pinError` and `passwordError`.
 */
@Component({
  selector: 'fc-pin-dialog',
  imports: [Button, Dialog, TextField, TPipe],
  templateUrl: './pin-dialog.html',
})
export class PinDialog {
  /** Title of the dialog (already translated). */
  readonly heading = input.required<string>();
  /** Whether the dialog is open (two-way). */
  readonly open = model(false);
  /** `set` asks for the new PIN; `remove` only confirms (and asks the password if needed). */
  readonly mode = input<'set' | 'remove'>('set');
  /** Whether the current password is required (the user's own PIN). */
  readonly askPassword = input(false);
  /** Request in progress. */
  readonly busy = input(false);
  /** Message of a server error on the PIN. */
  readonly pinError = input<string | null>(null);
  /** Message of a server error on the password. */
  readonly passwordError = input<string | null>(null);
  /** Emitted when the user confirms and the values pass the local checks. */
  readonly submitted = output<PinSubmission>();

  protected readonly pin = signal('');
  protected readonly password = signal('');
  private readonly local = signal<{ pin: string | null; password: string | null }>({
    pin: null,
    password: null,
  });
  protected readonly pinMessage = computed(() => this.local().pin ?? this.pinError());
  protected readonly passwordMessage = computed(
    () => this.local().password ?? this.passwordError(),
  );

  constructor() {
    effect(() => {
      if (!this.open()) {
        untracked(() => {
          this.pin.set('');
          this.password.set('');
          this.local.set({ pin: null, password: null });
        });
      }
    });
  }

  protected onSubmit(event: Event): void {
    event.preventDefault();
    // The dialog can sit inside another form: its submission must not reach that form.
    event.stopPropagation();
    const pinIssue =
      this.mode() === 'set' && !PIN_PATTERN.test(this.pin()) ? 'FORM.ISSUE.PATTERN' : null;
    const passwordIssue =
      this.askPassword() && this.password() === '' ? 'FORM.ISSUE.REQUIRED' : null;
    this.local.set({ pin: pinIssue, password: passwordIssue });
    if (pinIssue === null && passwordIssue === null) {
      this.submitted.emit({
        pin: this.mode() === 'set' ? this.pin() : null,
        password: this.password(),
      });
    }
  }
}
