import { Component, inject, input } from '@angular/core';
import { FieldTree, FormField, ReadonlyFieldTree } from '@angular/forms/signals';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { fieldErrorMessage } from '../../shared/forms/form-errors';
import { TextField } from '../../shared/ui/text-field/text-field';

/**
 * The account tab of a contact: the e-mail address and the phone number the customer is known by
 * in the public apps. There is no password: it is never read or written here. Each of the two is
 * unique in the group: the server says when another contact already has it.
 */
@Component({
  selector: 'fc-contact-account',
  imports: [FormField, TextField, TPipe],
  templateUrl: './contact-account.html',
  styleUrl: './contact-section.css',
})
export class ContactAccount {
  private readonly i18n = inject(I18nService);

  /** The form of the account (bound by the page). */
  readonly form = input.required<FieldTree<{ email: string; phone: string }>>();

  protected error(field: ReadonlyFieldTree<unknown>): string | null {
    return fieldErrorMessage(this.i18n, field());
  }
}
