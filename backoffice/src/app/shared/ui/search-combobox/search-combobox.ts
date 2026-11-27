import {
  Component,
  computed,
  ElementRef,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { I18nService } from '../../../core/i18n/i18n.service';
import { TPipe } from '../../../core/i18n/t-pipe';
import { failureMessage } from '../../forms/form-errors';
import { createDebouncer } from '../../util/debouncer';
import { Icon } from '../icon/icon';
import { IconButton } from '../icon-button/icon-button';
import { uniqueId } from '../unique-id';

/** One choice of {@link SearchCombobox}; `label` is already translated. */
export interface SearchOption {
  readonly value: string;
  readonly label: string;
}

/** Delay between the last keystroke and the search, in milliseconds. */
export const SEARCH_COMBOBOX_DEBOUNCE_MS = 250;

/**
 * Single choice among too many options to list: an editable combobox with a listbox popup (ARIA
 * 1.2) that asks the server while the user types. `search` receives the trimmed text (`''` for
 * the first options, shown on opening) and returns the matching options; it is called after a
 * short pause and only from `minChars` characters on, and only the answer of the latest call is
 * used. Keys: arrows, Home, End, Enter, Escape. A clear button removes the choice.
 *
 * The chosen value lives in the parent (`value`, e.g. a URL parameter); `valueLabel` is the
 * name to show for a value the component did not choose itself (resolved by the parent). An
 * `error` is shown under the field, linked with `aria-describedby`, and sets `aria-invalid`.
 */
@Component({
  selector: 'fc-search-combobox',
  imports: [Icon, IconButton, TPipe],
  templateUrl: './search-combobox.html',
  styleUrls: ['../field.css', './search-combobox.css'],
  host: { '(focusout)': 'onFocusOut($event)' },
})
export class SearchCombobox {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly debouncer = createDebouncer(SEARCH_COMBOBOX_DEBOUNCE_MS);
  private readonly input = viewChild.required<ElementRef<HTMLInputElement>>('field');
  protected readonly i18n = inject(I18nService);

  /** Visible label (already translated). */
  readonly label = input.required<string>();
  /** Chosen value, `''` for none. */
  readonly value = input('');
  /** Name to show for `value` when this component did not choose it (`null`: unknown). */
  readonly valueLabel = input<string | null>(null);
  /** Returns the options matching the text; rejects on failure. */
  readonly search = input.required<(text: string) => Promise<readonly SearchOption[]>>();
  /** Fewest characters that start a search (a shorter text shows a hint). */
  readonly minChars = input(2);
  /** Text of the empty field (what "no choice" means). */
  readonly placeholder = input<string | null>(null);
  /** Accessible name of the clear button (already translated). */
  readonly clearLabel = input.required<string>();
  /** Error message (already translated); empty or null when the choice is valid. */
  readonly error = input<string | null>(null);
  /** The choice changed: the option chosen, `null` when cleared. */
  readonly choice = output<SearchOption | null>();

  protected readonly inputId = uniqueId('fc-search-combobox');
  protected readonly listId = `${this.inputId}-list`;
  protected readonly errorId = `${this.inputId}-error`;
  protected readonly open = signal(false);
  protected readonly text = signal('');
  protected readonly items = signal<readonly SearchOption[]>([]);
  protected readonly loading = signal(false);
  protected readonly failure = signal<string | null>(null);
  protected readonly active = signal(-1);
  private readonly chosen = signal<SearchOption | null>(null);
  private readonly tooShort = signal(false);

  private requestId = 0;

  /** What the input shows: the search text while open, the choice otherwise. */
  protected readonly inputValue = computed(() => {
    if (this.open()) {
      return this.text();
    }
    const chosen = this.chosen();
    return chosen !== null && chosen.value === this.value()
      ? chosen.label
      : (this.valueLabel() ?? '');
  });
  protected readonly activeId = computed(() =>
    this.open() && this.active() >= 0 ? this.optionId(this.active()) : null,
  );
  protected readonly showTooShort = computed(() => this.open() && this.tooShort());
  protected readonly announcement = computed(() =>
    this.open() && !this.loading() && this.failure() === null && !this.tooShort()
      ? this.i18n.t('SEARCH_COMBOBOX.RESULTS', { count: this.items().length })
      : '',
  );

  protected optionId(index: number): string {
    return `${this.inputId}-option-${index}`;
  }

  protected show(): void {
    if (this.open()) {
      return;
    }
    this.open.set(true);
    this.text.set('');
    void this.load();
  }

  protected onInput(event: Event): void {
    this.open.set(true);
    this.text.set((event.target as HTMLInputElement).value);
    this.debouncer.schedule(() => void this.load());
  }

  protected onKeydown(event: KeyboardEvent): void {
    const last = this.items().length - 1;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.show();
        this.active.update((index) => Math.min(index + 1, last));
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.active.update((index) => Math.max(index - 1, 0));
        break;
      case 'Home':
      case 'End':
        if (this.open() && last >= 0) {
          event.preventDefault();
          this.active.set(event.key === 'Home' ? 0 : last);
        }
        break;
      case 'Enter':
        if (this.open() && this.active() >= 0) {
          event.preventDefault();
          this.choose(this.active());
        }
        break;
      case 'Escape':
        if (this.open()) {
          event.stopPropagation();
          this.close();
        }
        break;
    }
  }

  protected onFocusOut(event: FocusEvent): void {
    if (!this.host.nativeElement.contains(event.relatedTarget as Node | null)) {
      this.close();
    }
  }

  protected choose(index: number): void {
    const option = this.items()[index]!;
    this.chosen.set(option);
    this.close();
    this.choice.emit(option);
  }

  /** Removes the choice and keeps the focus in the field. */
  protected clear(): void {
    this.chosen.set(null);
    this.close();
    this.choice.emit(null);
    this.input().nativeElement.focus();
  }

  protected retry(): void {
    void this.load();
  }

  private close(): void {
    this.debouncer.cancel();
    // A search still on its way must not reopen anything or show stale results later.
    this.requestId++;
    this.loading.set(false);
    this.open.set(false);
  }

  private async load(): Promise<void> {
    const request = ++this.requestId;
    const text = this.text().trim();
    this.failure.set(null);
    if (text.length > 0 && text.length < this.minChars()) {
      this.items.set([]);
      this.active.set(-1);
      this.tooShort.set(true);
      this.loading.set(false);
      return;
    }
    this.tooShort.set(false);
    this.loading.set(true);
    try {
      const options = await this.search()(text);
      if (request === this.requestId) {
        this.items.set(options);
        this.active.set(options.length > 0 ? 0 : -1);
      }
    } catch (error) {
      if (request === this.requestId) {
        this.items.set([]);
        this.active.set(-1);
        this.failure.set(failureMessage(this.i18n, error));
      }
    } finally {
      if (request === this.requestId) {
        this.loading.set(false);
      }
    }
  }
}
