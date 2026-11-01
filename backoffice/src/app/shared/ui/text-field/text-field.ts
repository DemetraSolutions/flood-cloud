import { booleanAttribute, Component, computed, input, model, output } from '@angular/core';
import { Icon } from '../icon/icon';
import { uniqueId } from '../unique-id';

/** Input types supported by {@link TextField}. */
export type TextFieldType = 'text' | 'email' | 'password' | 'search' | 'tel' | 'url' | 'number';

/**
 * Labelled text input on a native `<input>`. The label is always visible; hint and error are
 * linked with `aria-describedby`, an error also sets `aria-invalid` and is announced politely.
 * The `value` model and the `disabled`/`required` inputs follow the Signal Forms control
 * contract, so it can be bound to a field. Forms should use `novalidate` and show their own
 * messages.
 */
@Component({
  selector: 'fc-text-field',
  imports: [Icon],
  templateUrl: './text-field.html',
  styleUrls: ['../field.css'],
})
export class TextField {
  /** Visible label (already translated). */
  readonly label = input.required<string>();
  /** Current value. */
  readonly value = model('');
  /** Native input type. */
  readonly type = input<TextFieldType>('text');
  /** Optional help text under the field. */
  readonly hint = input<string | null>(null);
  /** Error message; empty or null when the value is valid. */
  readonly error = input<string | null>(null);
  /** `autocomplete` attribute. */
  readonly autocomplete = input<string | null>(null);
  /** Placeholder (never a replacement for the label). */
  readonly placeholder = input('');
  /** Marks the field as required. */
  readonly required = input(false, { transform: booleanAttribute });
  /** Disables the field. */
  readonly disabled = input(false, { transform: booleanAttribute });
  /** Emitted when the field loses focus (to start showing errors). */
  readonly blurred = output<void>();

  protected readonly id = uniqueId('fc-text-field');
  protected readonly hintId = `${this.id}-hint`;
  protected readonly errorId = `${this.id}-error`;
  protected readonly describedBy = computed(() => {
    const ids = [this.hint() ? this.hintId : '', this.error() ? this.errorId : ''];
    return ids.filter((id) => id !== '').join(' ') || null;
  });

  protected onInput(event: Event): void {
    this.value.set((event.target as HTMLInputElement).value);
  }
}
