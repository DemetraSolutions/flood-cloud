import { Component, computed, inject, input } from '@angular/core';
import { FieldTree, FormField, ReadonlyFieldTree } from '@angular/forms/signals';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { fieldErrorMessage } from '../../shared/forms/form-errors';
import { Checkbox } from '../../shared/ui/checkbox/checkbox';
import { Select, SelectOption } from '../../shared/ui/select/select';
import { TextField } from '../../shared/ui/text-field/text-field';
import { Textarea } from '../../shared/ui/textarea/textarea';
import { ContactWarningNote } from './contact-warning-note';
import { ContactModel } from './contact-model';
import { ContactWarning } from './contact.types';

/**
 * The general tab of a contact: whether it is a customer, a supplier (neither: a generic contact),
 * its group of contacts, its code, the price list it is sold with (it wins over the one of the
 * group of contacts at the point of sale) and the notes. A code other contacts use too gets a
 * warning, never an error. Every control is bound to the form of the page, which decides whether
 * it can be edited.
 */
@Component({
  selector: 'fc-contact-general',
  imports: [Checkbox, ContactWarningNote, FormField, Select, TextField, Textarea, TPipe],
  templateUrl: './contact-general.html',
  styleUrl: './contact-section.css',
})
export class ContactGeneral {
  private readonly i18n = inject(I18nService);

  /** The form of the contact (bound by the page). */
  readonly form = input.required<FieldTree<ContactModel>>();
  readonly groupId = input.required<string>();
  /** The groups of contacts to choose from. */
  readonly groups = input.required<readonly SelectOption[]>();
  /** The active price lists to choose from. */
  readonly priceLists = input.required<readonly SelectOption[]>();
  /** The duplicates the server reported. */
  readonly warnings = input<readonly ContactWarning[]>([]);

  protected readonly codeWarning = computed(() => this.warnings().find((warning) => warning.field === 'code'));

  protected error(field: ReadonlyFieldTree<unknown>): string | null {
    return fieldErrorMessage(this.i18n, field());
  }
}
