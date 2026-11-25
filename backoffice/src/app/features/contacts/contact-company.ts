import { Component, computed, inject, input } from '@angular/core';
import { FieldTree, FormField, ReadonlyFieldTree } from '@angular/forms/signals';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { fieldErrorMessage } from '../../shared/forms/form-errors';
import { TextField } from '../../shared/ui/text-field/text-field';
import { ContactAddress } from './contact-address';
import { ContactEInvoicing } from './contact-e-invoicing';
import { CompanyModel, EInvoicingModel, emailIssue, lineIssue } from './contact-model';
import { ContactStringList } from './contact-string-list';
import { ContactSupplierLists } from './contact-supplier-lists';
import { ContactWarningNote } from './contact-warning-note';
import { CONTACT_LIMITS, ContactWarning } from './contact.types';

/**
 * The company data tab of a contact: company name, VAT number and tax code (with the warning of a
 * duplicate), address, phones, e-mail addresses and fax numbers (up to ten each), discount, the
 * price lists of the supplier (always there, highlighted while the contact is a supplier) and the
 * e-invoicing block.
 */
@Component({
  selector: 'fc-contact-company',
  imports: [
    ContactAddress,
    ContactEInvoicing,
    ContactStringList,
    ContactSupplierLists,
    ContactWarningNote,
    FormField,
    TextField,
    TPipe,
  ],
  templateUrl: './contact-company.html',
  styleUrl: './contact-section.css',
})
export class ContactCompany {
  private readonly i18n = inject(I18nService);

  /** The form of the company data (bound by the page). */
  readonly form = input.required<FieldTree<CompanyModel>>();
  /** The e-invoicing block, which lives apart in the form of the contact. */
  readonly invoicing = input.required<FieldTree<EInvoicingModel>>();
  readonly groupId = input.required<string>();
  /** The contact is a supplier. */
  readonly supplier = input(false);
  /** The duplicates the server reported. */
  readonly warnings = input<readonly ContactWarning[]>([]);

  protected readonly phoneLimit = CONTACT_LIMITS.phones;
  protected readonly emailLimit = CONTACT_LIMITS.emails;
  protected readonly phoneIssue = (text: string): string | undefined => lineIssue(text, 64);
  protected readonly emailIssue = emailIssue;
  protected readonly vatWarning = computed(() => this.warnings().find((warning) => warning.field === 'company.vatNumber'));
  protected readonly taxCodeWarning = computed(() => this.warnings().find((warning) => warning.field === 'company.taxCode'));

  protected error(field: ReadonlyFieldTree<unknown>): string | null {
    return fieldErrorMessage(this.i18n, field());
  }
}
