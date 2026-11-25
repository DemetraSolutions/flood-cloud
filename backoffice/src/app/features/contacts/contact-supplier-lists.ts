import { booleanAttribute, Component, computed, ElementRef, inject, Injector, input, model } from '@angular/core';
import { issueMessageKey } from '../../core/api/field-issues';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { Button } from '../../shared/ui/button/button';
import { Checkbox } from '../../shared/ui/checkbox/checkbox';
import { TextField } from '../../shared/ui/text-field/text-field';
import { uniqueId } from '../../shared/ui/unique-id';
import { focusRow, indexAfterRemoval } from './contact-list-focus';
import { lineIssue, SupplierListRow } from './contact-model';
import { CONTACT_LIMITS } from './contact.types';

/**
 * The price lists a supplier gives, which the products that name the supplier refer to: a row for
 * each with its name, a checkbox that marks the favorite one (only one at a time) and "remove". A list
 * that is new has no id: the server gives it one. It implements the Signal Forms value control
 * contract (`value`, `disabled`), so it binds to the rows of the form model.
 */
@Component({
  selector: 'fc-contact-supplier-lists',
  imports: [Button, Checkbox, TextField, TPipe],
  templateUrl: './contact-supplier-lists.html',
  styleUrl: './contact-section.css',
})
export class ContactSupplierLists {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly i18n = inject(I18nService);
  private readonly injector = inject(Injector);

  /** The rows (two-way). */
  readonly value = model<SupplierListRow[]>([]);
  /** The contact is a supplier: the block is highlighted. */
  readonly highlighted = input(false, { transform: booleanAttribute });
  /** The message of the whole list (too many, two favorites). */
  readonly error = input<string | null>(null);
  readonly disabled = input(false, { transform: booleanAttribute });

  protected readonly id = uniqueId('fc-contact-supplier-lists');
  protected readonly errorId = `${this.id}-error`;
  protected readonly limit = CONTACT_LIMITS.supplierPriceLists;
  protected readonly rows = computed(() =>
    this.value().map((row, index) => {
      const issue = row.name.trim() === '' ? 'required' : lineIssue(row.name, CONTACT_LIMITS.name);
      return {
        row,
        index,
        label: this.i18n.t('CONTACTS.COMPANY.LIST_N', { number: index + 1 }),
        error: issue === undefined ? null : this.i18n.t(issueMessageKey(issue)),
      };
    }),
  );

  /** Focuses the first entry (used by Signal Forms to focus an invalid field). */
  focus(): void {
    this.host.nativeElement.querySelector<HTMLInputElement>('input')?.focus();
  }

  protected add(): void {
    this.value.update((rows) => [...rows, { id: '', name: '', favorite: false }]);
    focusRow(this.injector, this.host.nativeElement, this.value().length - 1);
  }

  protected remove(index: number): void {
    this.value.update((rows) => rows.filter((_, position) => position !== index));
    focusRow(this.injector, this.host.nativeElement, indexAfterRemoval(index, this.value().length));
  }

  protected rename(index: number, name: string): void {
    this.value.update((rows) => rows.map((row, position) => (position === index ? { ...row, name } : row)));
  }

  /** Marks a list as the favorite one (the others are not), or unmarks it. */
  protected setFavorite(index: number, favorite: boolean): void {
    this.value.update((rows) =>
      rows.map((row, position) => ({ ...row, favorite: position === index && favorite })),
    );
  }
}
