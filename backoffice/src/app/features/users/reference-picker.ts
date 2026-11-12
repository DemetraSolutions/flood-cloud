import {
  booleanAttribute,
  afterNextRender,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  model,
  output,
  signal,
  untracked,
} from '@angular/core';
import { ApiPage } from '../../core/api/api.types';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { ReferenceItem } from '../../core/reference/reference-api';
import { failureMessage } from '../../shared/forms/form-errors';
import { Button } from '../../shared/ui/button/button';
import { Icon } from '../../shared/ui/icon/icon';
import { IconButton } from '../../shared/ui/icon-button/icon-button';
import { TextField } from '../../shared/ui/text-field/text-field';
import { uniqueId } from '../../shared/ui/unique-id';
import { createDebouncer } from '../../shared/util/debouncer';

/** Reads one page of reference items (the picker passes the search text and the cursor). */
export type ReferenceLoader = (query: {
  q: string;
  cursor: string | null;
}) => Promise<ApiPage<ReferenceItem>>;

/**
 * Multi-selection of reference items (companies or stores): a searchable list of checkboxes
 * with "load more" for the cursor pagination. Selected ids that are not on a loaded page stay
 * selected (only their count is shown). It implements the Signal Forms value control contract
 * (`value`, `disabled`), so it binds to a `string[]` field. Changing `loader` reloads the list.
 */
@Component({
  selector: 'fc-reference-picker',
  imports: [Button, Icon, IconButton, TextField, TPipe],
  templateUrl: './reference-picker.html',
  styleUrls: ['../../shared/ui/field.css', './reference-picker.css'],
})
export class ReferencePicker {
  private readonly i18n = inject(I18nService);
  private readonly debouncer = createDebouncer();

  /** Legend of the group (already translated). */
  readonly label = input.required<string>();
  /** Function that reads a page of items. */
  readonly loader = input.required<ReferenceLoader>();
  /** Ids of the selected items (two-way). */
  readonly value = model<string[]>([]);
  /**
   * Names of selected items that may not be on a loaded page, by id. When given, the picker lists
   * the selected items by name (the names of the loaded items are known by the picker itself).
   */
  readonly labels = input<Readonly<Partial<Record<string, string>>> | null>(null);
  /** Text shown for an item whose name is empty (for example a contact without a name). */
  readonly emptyLabel = input<string | null>(null);
  /**
   * Lets the user reorder the selected items with "up" and "down" buttons (needs `labels`). The
   * order of `value` is the order of the selection.
   */
  readonly ordered = input(false, { transform: booleanAttribute });
  /** Error message; empty or null when valid. */
  readonly error = input<string | null>(null);
  /** Disables the whole group. */
  readonly disabled = input(false, { transform: booleanAttribute });
  /** Emitted when the focus leaves a checkbox. */
  readonly blurred = output<void>();

  protected readonly id = uniqueId('fc-reference-picker');
  protected readonly errorId = `${this.id}-error`;
  protected readonly search = signal('');
  protected readonly items = signal<readonly ReferenceItem[]>([]);
  protected readonly next = signal<string | null>(null);
  protected readonly loading = signal(false);
  protected readonly failure = signal<string | null>(null);
  protected readonly selected = computed(() => new Set(this.value()));
  private readonly known = signal<Readonly<Partial<Record<string, string>>>>({});
  protected readonly chosen = computed(() => {
    const labels = this.labels();
    if (labels === null) {
      return [];
    }
    return this.value().map((id) => {
      const name = this.known()[id] ?? labels[id] ?? null;
      return {
        id,
        text: name === null ? this.i18n.t('REFERENCE_PICKER.UNKNOWN') : this.show(name),
      };
    });
  });
  /** Announcement of the last move, for screen readers. */
  protected readonly moved = signal('');

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private requestId = 0;

  constructor() {
    effect(() => {
      this.loader();
      untracked(() => void this.load(true));
    });
  }

  /** Focuses the first checkbox (used by Signal Forms to focus an invalid field). */
  focus(): void {
    this.host.nativeElement.querySelector<HTMLInputElement>('input[type=checkbox]')?.focus();
  }

  protected onSearch(text: string): void {
    this.search.set(text);
    this.debouncer.schedule(() => void this.load(true));
  }

  protected toggle(id: string, checked: boolean): void {
    this.value.update((ids) => (checked ? [...ids, id] : ids.filter((other) => other !== id)));
  }

  protected remove(id: string): void {
    this.value.update((ids) => ids.filter((other) => other !== id));
  }

  /** Text of an item name: the neutral label when the name is empty. */
  protected show(name: string): string {
    return name === '' ? (this.emptyLabel() ?? '') : name;
  }

  /** Moves a selected item one place up (`-1`) or down (`1`) and keeps the focus on its button. */
  protected move(id: string, step: -1 | 1): void {
    const ids = [...this.value()];
    const from = ids.indexOf(id);
    const to = from + step;
    [ids[from], ids[to]] = [ids[to], ids[from]];
    this.value.set(ids);
    const text = this.chosen()[to].text;
    this.moved.set(
      this.i18n.t('REFERENCE_PICKER.MOVED', { name: text, position: to + 1, total: ids.length }),
    );
    afterNextRender(
      () => {
        const [up, down] = [
          ...this.host.nativeElement.querySelectorAll<HTMLButtonElement>('button[data-move]'),
        ].filter((button) => button.dataset['move'] === id);
        const [wanted, other] = step === -1 ? [up, down] : [down, up];
        (wanted.disabled ? other : wanted).focus();
      },
      { injector: this.injector },
    );
  }

  protected loadMore(): void {
    void this.load(false);
  }

  protected retry(): void {
    void this.load(true);
  }

  private async load(reset: boolean): Promise<void> {
    const request = ++this.requestId;
    this.loading.set(true);
    this.failure.set(null);
    try {
      const page = await this.loader()({
        q: this.search(),
        cursor: reset ? null : this.next(),
      });
      if (request === this.requestId) {
        this.known.update((known) => ({
          ...known,
          ...Object.fromEntries(page.data.map((item) => [item.id, item.name])),
        }));
        this.items.update((current) => (reset ? page.data : [...current, ...page.data]));
        this.next.set(page.page.next);
      }
    } catch (error) {
      if (request === this.requestId) {
        this.failure.set(failureMessage(this.i18n, error));
      }
    } finally {
      if (request === this.requestId) {
        this.loading.set(false);
      }
    }
  }
}
