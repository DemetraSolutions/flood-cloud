import { Component, computed, inject } from '@angular/core';
import { FormField } from '@angular/forms/signals';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { Button } from '../../shared/ui/button/button';
import { Checkbox } from '../../shared/ui/checkbox/checkbox';
import { Select } from '../../shared/ui/select/select';
import { TextField } from '../../shared/ui/text-field/text-field';
import { CompanyState } from './company-state';

/** Most series an invoice numbering can have. */
export const MAX_NUMBERING_VALUES = 50;

/**
 * Invoice numbering tab: whether the series is a prefix or a suffix, the series (at most one is
 * the cash one), the number the numbering starts from, the discount lines and the Cerved lookup
 * (reserved to platform administrators and dealers).
 */
@Component({
  selector: 'fc-company-numbering',
  imports: [Button, Checkbox, FormField, Select, TextField, TPipe],
  templateUrl: './company-numbering.html',
  styleUrl: './company-section.css',
})
export class CompanyNumbering {
  protected readonly state = inject(CompanyState);
  protected readonly i18n = inject(I18nService);

  protected readonly f = this.state.form.invoiceNumbering;
  protected readonly positions = computed(() => [
    { value: 'prefix', label: this.i18n.t('COMPANIES.NUMBERING.PREFIX') },
    { value: 'suffix', label: this.i18n.t('COMPANIES.NUMBERING.SUFFIX') },
  ]);
  protected readonly canAdd = computed(
    () =>
      this.state.canWrite() &&
      this.state.model().invoiceNumbering.values.length < MAX_NUMBERING_VALUES,
  );

  protected add(): void {
    this.state.edit('invoiceNumbering', (numbering) => ({
      ...numbering,
      values: [...numbering.values, { name: '', cash: false }],
    }));
  }

  protected remove(index: number): void {
    this.state.edit('invoiceNumbering', (numbering) => ({
      ...numbering,
      values: numbering.values.filter((_, at) => at !== index),
    }));
  }

  /** At most one series is the cash one: choosing it clears the others. */
  protected setCash(index: number, cash: boolean): void {
    this.state.edit('invoiceNumbering', (numbering) => ({
      ...numbering,
      values: numbering.values.map((value, at) => ({
        ...value,
        cash: at === index ? cash : cash ? false : value.cash,
      })),
    }));
  }

  protected rowLabel(key: string, index: number): string {
    return this.i18n.t(key, { number: index + 1 });
  }
}
