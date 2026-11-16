import { Component, computed, input, signal } from '@angular/core';
import { FieldTree, FormField } from '@angular/forms/signals';
import { TPipe } from '../../core/i18n/t-pipe';
import { Button } from '../../shared/ui/button/button';
import { TextField } from '../../shared/ui/text-field/text-field';
import { CredentialModel } from './place-model';

/**
 * A write-only credential (an API key, a password…): the server never returns it, only whether
 * it is set. The field shows "impostata" or "non impostata" and never holds the stored value.
 * "Cambia" (or "Imposta") opens a password input for the new value, "Rimuovi" asks to remove it
 * on the next save. The form keeps the typed value (`value`) and the removal (`clear`); the save
 * sends the credential only when one of them changed.
 */
@Component({
  selector: 'fc-credential-field',
  imports: [Button, FormField, TextField, TPipe],
  templateUrl: './credential-field.html',
  styleUrl: './place-section.css',
})
export class CredentialField {
  /** The credential in the form. */
  readonly credential = input.required<FieldTree<CredentialModel>>();
  /** Visible label (already translated). */
  readonly label = input.required<string>();
  /** Whether the user may not change the credential: only its state is shown. */
  readonly locked = input(false);
  /** Error message of the typed value. */
  readonly error = input<string | null>(null);

  /** Whether the input is open: the user chose to type a new value. */
  protected readonly editing = signal(false);

  protected readonly disabled = computed(() => this.locked() || this.credential()().disabled());
  protected readonly isSet = computed(() => this.credential().set().value());
  protected readonly clearing = computed(() => this.credential().clear().value());

  protected change(): void {
    this.credential().clear().value.set(false);
    this.editing.set(true);
  }

  protected cancel(): void {
    this.credential().value().value.set('');
    this.editing.set(false);
  }

  protected remove(): void {
    this.cancel();
    this.credential().clear().value.set(true);
  }

  protected keep(): void {
    this.credential().clear().value.set(false);
  }
}
