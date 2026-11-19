import { Component, computed, inject } from '@angular/core';
import { FormField } from '@angular/forms/signals';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { Countries } from '../../core/reference/countries';
import { Select } from '../../shared/ui/select/select';
import { TextField } from '../../shared/ui/text-field/text-field';
import { withCurrent } from './company-options';
import { CompanyState } from './company-state';

/** Tax regimes of the electronic invoice (`RF03` was repealed). */
export const TAX_REGIMES = [
  'RF01',
  'RF02',
  'RF04',
  'RF05',
  'RF06',
  'RF07',
  'RF08',
  'RF09',
  'RF10',
  'RF11',
  'RF12',
  'RF13',
  'RF14',
  'RF15',
  'RF16',
  'RF17',
  'RF18',
  'RF19',
] as const;

/**
 * E-invoicing tab: transmission hub and transmitter (reserved to platform administrators and
 * dealers), PEC and recipient code, professional register and company register (REA) data and
 * tax regime. The hub select shows the stored value even when the user cannot choose it (another
 * dealer's hub).
 */
@Component({
  selector: 'fc-company-e-invoicing',
  imports: [FormField, Select, TextField, TPipe],
  templateUrl: './company-e-invoicing.html',
  styleUrl: './company-section.css',
})
export class CompanyEInvoicing {
  protected readonly state = inject(CompanyState);
  protected readonly i18n = inject(I18nService);
  private readonly countries = inject(Countries);

  protected readonly f = this.state.form.eInvoicing;
  private readonly model = computed(() => this.state.model().eInvoicing);

  protected readonly hubOptions = computed(() => {
    const options = [{ value: 'aruba', label: this.i18n.t('COMPANIES.E_INVOICING.HUB_ARUBA') }];
    for (const hub of this.state.hubs()) {
      if (hub.value !== 'aruba') {
        options.push({ value: hub.value, label: hub.label });
      }
    }
    return withCurrent(options, this.model().hub, () =>
      this.i18n.t('COMPANIES.E_INVOICING.HUB_OTHER'),
    );
  });
  protected readonly provinceOptions = computed(() => {
    const options = this.countries
      .areas('IT')
      .map((area) => ({ value: area.code, label: `${area.name} (${area.code})` }));
    return {
      register: withCurrent(options, this.model().professionalRegister.province, (code) => code),
      office: withCurrent(options, this.model().rea.office, (code) => code),
    };
  });
  protected readonly taxRegimes = TAX_REGIMES.map((code) => ({ value: code, label: code }));
  protected readonly shareholders = ['SU', 'SM'].map((code) => ({
    value: code,
    label: this.i18n.t(`COMPANIES.E_INVOICING.SHAREHOLDERS.${code}`),
  }));
  protected readonly liquidation = ['LS', 'LN'].map((code) => ({
    value: code,
    label: this.i18n.t(`COMPANIES.E_INVOICING.LIQUIDATION.${code}`),
  }));

  constructor() {
    this.state.need('countries');
    this.state.need('hubs');
  }
}
