import { booleanAttribute, Component, computed, input, model, output } from '@angular/core';
import { Icon } from '../icon/icon';
import { uniqueId } from '../unique-id';

/** An option of {@link Select}; `label` is already translated. */
export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

/**
 * Labelled native `<select>`. Same label, hint and error wiring as the text field. An optional
 * `placeholder` adds an empty first option (value `''`).
 */
@Component({
  selector: 'fc-select',
  imports: [Icon],
  templateUrl: './select.html',
  styleUrls: ['../field.css'],
})
export class Select {
  /** Visible label (already translated). */
  readonly label = input.required<string>();
  /** Options to choose from. */
  readonly options = input.required<readonly SelectOption[]>();
  /** Selected value. */
  readonly value = model('');
  /** Text of the empty first option, when the field may be left unselected. */
  readonly placeholder = input<string | null>(null);
  /** Optional help text under the field. */
  readonly hint = input<string | null>(null);
  /** Error message; empty or null when the value is valid. */
  readonly error = input<string | null>(null);
  /** Marks the field as required. */
  readonly required = input(false, { transform: booleanAttribute });
  /** Disables the field. */
  readonly disabled = input(false, { transform: booleanAttribute });
  /** Emitted when the field loses focus. */
  readonly blurred = output<void>();

  protected readonly id = uniqueId('fc-select');
  protected readonly hintId = `${this.id}-hint`;
  protected readonly errorId = `${this.id}-error`;
  protected readonly describedBy = computed(() => {
    const ids = [this.hint() ? this.hintId : '', this.error() ? this.errorId : ''];
    return ids.filter((id) => id !== '').join(' ') || null;
  });

  protected onChange(event: Event): void {
    this.value.set((event.target as HTMLSelectElement).value);
  }
}
