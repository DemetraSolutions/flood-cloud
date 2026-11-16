import {
  booleanAttribute,
  Component,
  computed,
  ElementRef,
  input,
  model,
  output,
  viewChild,
} from '@angular/core';
import { Icon } from '../icon/icon';
import { uniqueId } from '../unique-id';

/**
 * Labelled multi-line text input on a native `<textarea>`, with the same label, hint and error
 * wiring as the text field. The `value` model follows the Signal Forms control contract.
 */
@Component({
  selector: 'fc-textarea',
  imports: [Icon],
  templateUrl: './textarea.html',
  styleUrls: ['../field.css', './textarea.css'],
})
export class Textarea {
  /** Visible label (already translated). */
  readonly label = input.required<string>();
  /** Current value. */
  readonly value = model('');
  /** Visible lines. */
  readonly rows = input(4);
  /** Optional help text under the field. */
  readonly hint = input<string | null>(null);
  /** Error message; empty or null when the value is valid. */
  readonly error = input<string | null>(null);
  /** Marks the field as required. */
  readonly required = input(false, { transform: booleanAttribute });
  /** Shows the text in a monospace font (code, markup). */
  readonly code = input(false, { transform: booleanAttribute });
  /** Disables the field. */
  readonly disabled = input(false, { transform: booleanAttribute });
  /** Emitted when the field loses focus (to start showing errors). */
  readonly blurred = output<void>();

  private readonly control = viewChild.required<ElementRef<HTMLTextAreaElement>>('control');

  protected readonly id = uniqueId('fc-textarea');
  protected readonly hintId = `${this.id}-hint`;
  protected readonly errorId = `${this.id}-error`;
  protected readonly describedBy = computed(() => {
    const ids = [this.hint() ? this.hintId : '', this.error() ? this.errorId : ''];
    return ids.filter((id) => id !== '').join(' ') || null;
  });

  /** Focuses the field (used by Signal Forms to focus the first invalid field). */
  focus(options?: FocusOptions): void {
    this.control().nativeElement.focus(options);
  }

  protected onInput(event: Event): void {
    this.value.set((event.target as HTMLTextAreaElement).value);
  }
}
