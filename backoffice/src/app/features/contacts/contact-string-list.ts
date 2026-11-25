import { booleanAttribute, Component, computed, ElementRef, inject, Injector, input, model } from '@angular/core';
import { issueMessageKey } from '../../core/api/field-issues';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { Button } from '../../shared/ui/button/button';
import { TextField } from '../../shared/ui/text-field/text-field';
import { uniqueId } from '../../shared/ui/unique-id';
import { focusRow, indexAfterRemoval } from './contact-list-focus';

/**
 * A list of short texts (phones, e-mail addresses, fax numbers): a row for each with "remove",
 * and "add" while the list is under its limit. It implements the Signal Forms value control
 * contract (`value`, `disabled`), so it binds to the `string[]` of the form model. The rows that
 * are not valid show their own message; the message of the whole list comes from the form.
 */
@Component({
  selector: 'fc-contact-string-list',
  imports: [Button, TextField, TPipe],
  templateUrl: './contact-string-list.html',
  styleUrl: './contact-section.css',
})
export class ContactStringList {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly i18n = inject(I18nService);
  private readonly injector = inject(Injector);

  /** The entries (two-way). */
  readonly value = model<string[]>([]);
  /** Name of the list (the legend). */
  readonly legend = input.required<string>();
  /** Dictionary key of the label of one entry; it takes the `number` of the entry. */
  readonly itemKey = input.required<string>();
  /** Dictionary key of the label of the button that adds an entry. */
  readonly addKey = input.required<string>();
  /** Most entries the list takes. */
  readonly limit = input.required<number>();
  /** Native input type of an entry. */
  readonly type = input<'text' | 'email' | 'tel'>('text');
  /** Issue of one entry (a name of `FORM.ISSUE`), `undefined` when it is fine. */
  readonly issue = input<(text: string) => string | undefined>(() => undefined);
  /** The message of the whole list (a repeated entry, too many). */
  readonly error = input<string | null>(null);
  readonly disabled = input(false, { transform: booleanAttribute });

  protected readonly id = uniqueId('fc-contact-string-list');
  protected readonly errorId = `${this.id}-error`;
  protected readonly rows = computed(() =>
    this.value().map((text, index) => {
      const found = this.issue()(text);
      return {
        index,
        text,
        label: this.i18n.t(this.itemKey(), { number: index + 1 }),
        error: found === undefined ? null : this.i18n.t(issueMessageKey(found)),
      };
    }),
  );

  /** Focuses the first entry (used by Signal Forms to focus an invalid field). */
  focus(): void {
    this.host.nativeElement.querySelector<HTMLInputElement>('input')?.focus();
  }

  protected add(): void {
    this.value.update((rows) => [...rows, '']);
    focusRow(this.injector, this.host.nativeElement, this.value().length - 1);
  }

  protected remove(index: number): void {
    this.value.update((rows) => rows.filter((_, position) => position !== index));
    focusRow(this.injector, this.host.nativeElement, indexAfterRemoval(index, this.value().length));
  }

  protected change(index: number, text: string): void {
    this.value.update((rows) => rows.map((row, position) => (position === index ? text : row)));
  }
}
