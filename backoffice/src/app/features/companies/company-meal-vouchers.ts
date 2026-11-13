import { Component, computed, inject } from '@angular/core';
import { FormField } from '@angular/forms/signals';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { Button } from '../../shared/ui/button/button';
import { TextField } from '../../shared/ui/text-field/text-field';
import { CompanySave } from './company-save';
import { CompanyState } from './company-state';

/** Most issuers a company can have, and most cuts each issuer can have. */
export const MAX_ISSUERS = 50;
export const MAX_CUTS = 50;

/**
 * Meal vouchers tab: the issuers (add, remove) and, for each, the cuts of its vouchers. An
 * empty cut stands for a free amount.
 */
@Component({
  selector: 'fc-company-meal-vouchers',
  imports: [Button, CompanySave, FormField, TextField, TPipe],
  templateUrl: './company-meal-vouchers.html',
  styleUrl: './company-section.css',
})
export class CompanyMealVouchers {
  protected readonly state = inject(CompanyState);
  private readonly i18n = inject(I18nService);

  protected readonly f = this.state.form.mealVoucherIssuers;
  protected readonly canAdd = computed(
    () => this.state.canWrite() && this.state.model().mealVoucherIssuers.length < MAX_ISSUERS,
  );

  protected canAddCut(index: number): boolean {
    return (
      this.state.canWrite() && this.state.model().mealVoucherIssuers[index].cuts.length < MAX_CUTS
    );
  }

  protected add(): void {
    this.state.edit('mealVoucherIssuers', (issuers) => [
      ...issuers,
      { id: '', name: '', cuts: [] },
    ]);
  }

  protected remove(index: number): void {
    this.state.edit('mealVoucherIssuers', (issuers) => issuers.filter((_, at) => at !== index));
  }

  protected addCut(index: number): void {
    this.state.edit('mealVoucherIssuers', (issuers) =>
      issuers.map((issuer, at) =>
        at === index ? { ...issuer, cuts: [...issuer.cuts, ''] } : issuer,
      ),
    );
  }

  protected removeCut(index: number, cut: number): void {
    this.state.edit('mealVoucherIssuers', (issuers) =>
      issuers.map((issuer, at) =>
        at === index ? { ...issuer, cuts: issuer.cuts.filter((_, i) => i !== cut) } : issuer,
      ),
    );
  }

  protected label(key: string, number: number, cut?: number): string {
    return this.i18n.t(
      key,
      cut === undefined ? { number: number + 1 } : { number: number + 1, cut: cut + 1 },
    );
  }
}
