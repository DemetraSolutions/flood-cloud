import { Component, computed, inject } from '@angular/core';
import { FormField } from '@angular/forms/signals';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { Button } from '../../shared/ui/button/button';
import { Checkbox } from '../../shared/ui/checkbox/checkbox';
import { TextField } from '../../shared/ui/text-field/text-field';
import { CompanyState } from './company-state';
import { formatIban, hasValidIbanChecksum } from './iban';

/** Most bank accounts a company can have. */
export const MAX_BANK_ACCOUNTS = 20;

/**
 * Bank accounts tab: an editable list (add, remove) with at most one default account. The IBAN
 * is normalised as the user types (capitals, groups of four, spaces allowed) and a checksum
 * warning is shown as a hint; the server stays authoritative.
 */
@Component({
  selector: 'fc-company-banks',
  imports: [Button, Checkbox, FormField, TextField, TPipe],
  templateUrl: './company-banks.html',
  styleUrl: './company-section.css',
})
export class CompanyBanks {
  protected readonly state = inject(CompanyState);
  protected readonly i18n = inject(I18nService);

  protected readonly f = this.state.form.bankAccounts;
  protected readonly canAdd = computed(
    () => this.state.canWrite() && this.state.model().bankAccounts.length < MAX_BANK_ACCOUNTS,
  );

  protected add(): void {
    this.state.edit('bankAccounts', (banks) => [
      ...banks,
      { id: '', name: '', iban: '', abi: '', cab: '', bic: '', default: false },
    ]);
  }

  protected remove(index: number): void {
    this.state.edit('bankAccounts', (banks) => banks.filter((_, at) => at !== index));
  }

  /** At most one account is the default one: choosing it clears the others. */
  protected setDefault(index: number, isDefault: boolean): void {
    this.state.edit('bankAccounts', (banks) =>
      banks.map((bank, at) => ({
        ...bank,
        default: at === index ? isDefault : isDefault ? false : bank.default,
      })),
    );
  }

  protected readonly formatIban = formatIban;

  /** The hint of the IBAN field: the checksum warning when the number does not pass. */
  protected ibanHint(iban: string): string | null {
    return iban !== '' && !hasValidIbanChecksum(iban)
      ? this.i18n.t('COMPANIES.BANKS.IBAN_CHECKSUM')
      : this.i18n.t('COMPANIES.BANKS.IBAN_HINT');
  }

  protected rowLabel(key: string, index: number): string {
    return this.i18n.t(key, { number: index + 1 });
  }
}
