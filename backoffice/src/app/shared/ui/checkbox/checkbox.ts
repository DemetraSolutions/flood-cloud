import { booleanAttribute, Component, computed, input, model, output } from '@angular/core';
import { Icon } from '../icon/icon';
import { uniqueId } from '../unique-id';

/**
 * Labelled native checkbox with optional hint and error linked by `aria-describedby`.
 * The `checked` model follows the Signal Forms checkbox control contract.
 */
@Component({
  selector: 'fc-checkbox',
  imports: [Icon],
  templateUrl: './checkbox.html',
  styleUrls: ['../field.css', './checkbox.css'],
})
export class Checkbox {
  /** Visible label (already translated). */
  readonly label = input.required<string>();
  /** Whether the box is checked. */
  readonly checked = model(false);
  /** Optional help text under the checkbox. */
  readonly hint = input<string | null>(null);
  /** Error message; empty or null when valid. */
  readonly error = input<string | null>(null);
  /** Marks the checkbox as required. */
  readonly required = input(false, { transform: booleanAttribute });
  /** Disables the checkbox. */
  readonly disabled = input(false, { transform: booleanAttribute });
  /** Emitted when the checkbox loses focus. */
  readonly blurred = output<void>();

  protected readonly id = uniqueId('fc-checkbox');
  protected readonly hintId = `${this.id}-hint`;
  protected readonly errorId = `${this.id}-error`;
  protected readonly describedBy = computed(() => {
    const ids = [this.hint() ? this.hintId : '', this.error() ? this.errorId : ''];
    return ids.filter((id) => id !== '').join(' ') || null;
  });

  protected onChange(event: Event): void {
    this.checked.set((event.target as HTMLInputElement).checked);
  }
}
