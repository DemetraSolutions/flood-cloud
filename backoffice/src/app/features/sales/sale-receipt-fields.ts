import { Component, inject, input, output } from '@angular/core';
import { issueMessageKey } from '../../core/api/field-issues';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { TextField } from '../../shared/ui/text-field/text-field';
import { ReceiptForm, SaleIssues } from './sale-forms';

/**
 * The four fields of a fiscal receipt (date and time, number of the fiscal closure or report Z,
 * receipt number, amount) of the dialogs of an amendment and of a refund: a fieldset with its
 * legend and a hint under each field. The issues come from the dialog (`<prefix>.date`, …); a field
 * that has one shows its message. The whole fieldset is disabled while the dialog sends.
 */
@Component({
  selector: 'fc-sale-receipt-fields',
  imports: [TextField, TPipe],
  templateUrl: './sale-receipt-fields.html',
  styleUrl: './sale-dialog.css',
})
export class SaleReceiptFields {
  private readonly i18n = inject(I18nService);

  /** The legend (already translated). */
  readonly legend = input.required<string>();
  readonly value = input.required<ReceiptForm>();
  /** The issues of the dialog. */
  readonly issues = input.required<SaleIssues>();
  /** Prefix of the names of the issues of this receipt in `issues`. */
  readonly prefix = input.required<string>();
  /** Symbol of the currency of the amount. */
  readonly symbol = input.required<string>();
  readonly disabled = input(false);
  /** A field changed. */
  readonly valueChange = output<ReceiptForm>();

  protected error(field: keyof ReceiptForm): string | null {
    const issue = this.issues()[`${this.prefix()}.${field}`];
    return issue === undefined ? null : this.i18n.t(issueMessageKey(issue));
  }

  protected set(field: keyof ReceiptForm, text: string): void {
    this.valueChange.emit({ ...this.value(), [field]: text });
  }
}
