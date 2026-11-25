import { Component, computed, inject, input } from '@angular/core';
import { FieldTree, FormField, ReadonlyFieldTree } from '@angular/forms/signals';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { fieldErrorMessage } from '../../shared/forms/form-errors';
import { Checkbox } from '../../shared/ui/checkbox/checkbox';
import { Select, SelectOption } from '../../shared/ui/select/select';
import { TextField } from '../../shared/ui/text-field/text-field';
import { EInvoicingModel } from './contact-model';
import {
  CONTACT_LIMITS,
  E_INVOICE_CHANNELS,
  PAYMENT_METHODS,
  PAYMENT_TERMS,
  TAX_REGIMES,
  TRANSMISSION_FORMATS,
} from './contact.types';

/**
 * The e-invoicing block of the company data: format and channel of the transmission, the
 * recipient code and the certified e-mail (PEC), the payment terms and method, the tax regime
 * (each code with its Italian name), the administration reference, the split payment and the
 * purchase order data.
 */
@Component({
  selector: 'fc-contact-e-invoicing',
  imports: [Checkbox, FormField, Select, TextField, TPipe],
  templateUrl: './contact-e-invoicing.html',
  styleUrl: './contact-section.css',
})
export class ContactEInvoicing {
  private readonly i18n = inject(I18nService);

  /** The form of the e-invoicing data (bound by the page). */
  readonly form = input.required<FieldTree<EInvoicingModel>>();

  protected readonly referenceLimit = CONTACT_LIMITS.administrationReference;
  protected readonly formats = computed<SelectOption[]>(() =>
    TRANSMISSION_FORMATS.map((code) => ({ value: code, label: this.i18n.t(`CONTACTS.E_INVOICING.FORMAT_${code}`) })),
  );
  /** The channel decides which of the recipient code and the PEC is asked (the other keeps its value). */
  protected readonly channel = computed(() => this.form().channel().value());
  protected readonly recipientHint = computed(() =>
    this.i18n.t(`CONTACTS.E_INVOICING.RECIPIENT_CODE_HINT_${this.form().transmissionFormat().value() === 'FPA12' ? 'FPA12' : 'FPR12'}`),
  );
  protected readonly channels = computed<SelectOption[]>(() =>
    E_INVOICE_CHANNELS.map((code) => ({ value: code, label: this.i18n.t(`CONTACTS.E_INVOICING.CHANNEL_${code}`) })),
  );
  protected readonly terms = computed(() => this.options(PAYMENT_TERMS, 'PAYMENT_TERM_NAME'));
  protected readonly methods = computed(() => this.options(PAYMENT_METHODS, 'PAYMENT_METHOD_NAME'));
  protected readonly regimes = computed(() => this.options(TAX_REGIMES, 'TAX_REGIME_NAME'));

  protected error(field: ReadonlyFieldTree<unknown>): string | null {
    return fieldErrorMessage(this.i18n, field());
  }

  /** The codes with their names: `<name> (<code>)`. */
  private options(codes: readonly string[], group: string): SelectOption[] {
    return codes.map((code) => ({ value: code, label: `${this.i18n.t(`CONTACTS.E_INVOICING.${group}.${code}`)} (${code})` }));
  }
}
