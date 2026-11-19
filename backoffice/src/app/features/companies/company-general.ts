import { Component, computed, inject } from '@angular/core';
import { FormField } from '@angular/forms/signals';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { Countries } from '../../core/reference/countries';
import { Select } from '../../shared/ui/select/select';
import { TextField } from '../../shared/ui/text-field/text-field';
import { withCurrent } from './company-options';
import { CompanyState } from './company-state';

/**
 * General tab of the company: identity, address, currency, contacts and the reserved fields
 * (status and expiry date, editable by platform administrators and dealers only). Country and
 * province come from the countries; the currency from the currencies of the group.
 */
@Component({
  selector: 'fc-company-general',
  imports: [FormField, Select, TextField, TPipe],
  templateUrl: './company-general.html',
  styleUrl: './company-section.css',
})
export class CompanyGeneral {
  protected readonly state = inject(CompanyState);
  protected readonly i18n = inject(I18nService);
  private readonly countries = inject(Countries);

  protected readonly f = this.state.form.general;
  private readonly general = computed(() => this.state.model().general);

  protected readonly countryOptions = computed(() =>
    withCurrent(
      this.countries.list().map((country) => ({ value: country.code, label: country.name })),
      this.general().address.country,
      (code) => code,
    ),
  );
  protected readonly areas = computed(() => this.countries.areas(this.general().address.country));
  protected readonly provinceOptions = computed(() =>
    withCurrent(
      this.areas().map((area) => ({ value: area.code, label: `${area.name} (${area.code})` })),
      this.general().address.province,
      (code) => code,
    ),
  );
  protected readonly currencyOptions = computed(() =>
    withCurrent(
      this.state.currencies().map((code) => ({ value: code, label: code })),
      this.general().currency,
      (code) => code,
    ),
  );
  protected readonly statusOptions = computed(() => [
    { value: 'active', label: this.i18n.t('COMPANIES.STATUS.ACTIVE') },
    { value: 'disabled', label: this.i18n.t('COMPANIES.STATUS.DISABLED') },
  ]);

  constructor() {
    this.state.need('countries');
    this.state.need('currencies');
  }

  /** A province of another country is not valid: the choice is cleared when the country changes. */
  protected onCountry(code: string): void {
    const province = this.general().address.province;
    if (!this.countries.areas(code).some((area) => area.code === province)) {
      this.f.address.province().value.set('');
    }
  }
}
