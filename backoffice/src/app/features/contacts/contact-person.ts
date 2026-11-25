import { Component, computed, inject, input, resource, signal } from '@angular/core';
import { FieldTree, FormField, ReadonlyFieldTree } from '@angular/forms/signals';
import { ApiError } from '../../core/api/api-error';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { fieldErrorMessage } from '../../shared/forms/form-errors';
import { SearchCombobox, SearchOption } from '../../shared/ui/search-combobox/search-combobox';
import { TextField } from '../../shared/ui/text-field/text-field';
import { ContactAddress } from './contact-address';
import { ContactApi } from './contact-api';
import { emailIssue, lineIssue, PersonModel } from './contact-model';
import { ContactStringList } from './contact-string-list';
import { ContactWarningNote } from './contact-warning-note';
import { CONTACT_LIMITS, ContactWarning } from './contact.types';

/** Fewest characters that start the search of the company. */
export const COMPANY_SEARCH_MIN_CHARS = 3;

/**
 * The personal data tab of a contact: name, tax code (with the warning of a duplicate), birth date,
 * address, phones and e-mail addresses (up to ten each), discount and the company the person
 * works for, chosen by searching the contacts that have a company name. The name of the chosen
 * company is read once, when the contact is opened, and shown as text.
 */
@Component({
  selector: 'fc-contact-person',
  imports: [ContactAddress, ContactStringList, ContactWarningNote, FormField, SearchCombobox, TextField, TPipe],
  templateUrl: './contact-person.html',
  styleUrl: './contact-section.css',
})
export class ContactPerson {
  private readonly api = inject(ContactApi);
  private readonly i18n = inject(I18nService);

  /** The form of the personal data (bound by the page). */
  readonly form = input.required<FieldTree<PersonModel>>();
  readonly groupId = input.required<string>();
  /** The duplicates the server reported. */
  readonly warnings = input<readonly ContactWarning[]>([]);

  protected readonly minChars = COMPANY_SEARCH_MIN_CHARS;
  protected readonly phoneLimit = CONTACT_LIMITS.phones;
  protected readonly emailLimit = CONTACT_LIMITS.emails;
  protected readonly phoneIssue = (text: string): string | undefined => lineIssue(text, 64);
  protected readonly emailIssue = emailIssue;
  protected readonly taxCodeWarning = computed(() => this.warnings().find((warning) => warning.field === 'person.taxCode'));
  protected readonly locked = computed(() => this.form().associatedCompanyId().disabled());
  protected readonly companyId = computed(() => this.form().associatedCompanyId().value());

  /** The company the user chose in this session: its name is known without reading it. */
  private readonly chosen = signal<SearchOption | null>(null);
  private readonly named = resource({
    params: () => {
      const id = this.companyId();
      return id === '' || this.chosen()?.value === id ? undefined : { groupId: this.groupId(), id };
    },
    loader: async ({ params }) => {
      try {
        return (await this.api.read(params.groupId, params.id)).item.displayName;
      } catch (error) {
        // Only the code: the error would carry the URL with the id.
        console.warn('Cannot read the name of the associated company', error instanceof ApiError ? error.code : 'unexpected');
        return null;
      }
    },
  });
  /** The name to show for the company: the one chosen, the one read, or a short id. */
  protected readonly companyLabel = computed(() => {
    const id = this.companyId();
    if (id === '') {
      return null;
    }
    const chosen = this.chosen();
    if (chosen?.value === id) {
      return chosen.label;
    }
    return (this.named.hasValue() ? this.named.value() : null) ?? `…${id.slice(-6)}`;
  });
  protected readonly search = (text: string): Promise<readonly SearchOption[]> =>
    this.api.searchCompanies(this.groupId(), text);

  protected error(field: ReadonlyFieldTree<unknown>): string | null {
    return fieldErrorMessage(this.i18n, field());
  }

  protected onCompany(option: SearchOption | null): void {
    this.chosen.set(option);
    this.form().associatedCompanyId().value.set(option === null ? '' : option.value);
  }
}
