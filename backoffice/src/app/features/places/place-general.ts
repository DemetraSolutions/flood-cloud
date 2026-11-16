import { Component, computed, inject } from '@angular/core';
import { FormField } from '@angular/forms/signals';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { Countries } from '../../core/reference/countries';
import { Checkbox } from '../../shared/ui/checkbox/checkbox';
import { Select, SelectOption } from '../../shared/ui/select/select';
import { TextField } from '../../shared/ui/text-field/text-field';
import { withCurrent } from '../companies/company-options';
import { PlaceState } from './place-state';

/** A price list of the group as the price list controls show it: with the row of the place that enables it. */
interface PriceListEntry {
  readonly id: string;
  readonly name: string;
  /** Index of the row of the place; `-1` when the place does not use the list. */
  readonly index: number;
}

/**
 * General tab of the place, in the order of the legacy backoffice: the company, the plan, the
 * expiration date and the status (platform administrators and dealers; the plan only platform
 * administrators change, and dealers choose it when creating), the sign, the price lists, the
 * address, the invoice series and the contact, then the price lists the place sells with (and the
 * all-you-can-eat codes when the group has the restaurant module).
 */
@Component({
  selector: 'fc-place-general',
  imports: [Checkbox, FormField, Select, TextField, TPipe],
  templateUrl: './place-general.html',
  styleUrl: './place-section.css',
})
export class PlaceGeneral {
  protected readonly state = inject(PlaceState);
  protected readonly i18n = inject(I18nService);
  private readonly countries = inject(Countries);

  protected readonly f = this.state.form.general;
  protected readonly license = this.state.form.license;
  private readonly general = computed(() => this.state.model().general);

  protected readonly companyOptions = computed(() =>
    withCurrent(
      this.state.companies().map((company) => ({ value: company.id, label: company.name })),
      this.general().companyId,
      (id) => id,
    ),
  );
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
  protected readonly planOptions = this.state.planOptions;
  protected readonly statusOptions = computed(() => [
    { value: 'active', label: this.i18n.t('PLACES.STATUS.ACTIVE') },
    { value: 'disabled', label: this.i18n.t('PLACES.STATUS.DISABLED') },
  ]);
  private readonly enabledLists = computed<SelectOption[]>(() =>
    this.state
      .priceLists()
      .filter((priceList) => priceList.enabled)
      .map((priceList) => ({ value: priceList.id, label: priceList.name })),
  );
  protected readonly priceListOptions = computed(() =>
    withCurrent(this.enabledLists(), this.general().priceListId, (id) => id),
  );
  protected readonly ecommerceOptions = computed(() =>
    withCurrent(this.enabledLists(), this.general().ecommercePriceListId, (id) => id),
  );
  protected readonly seriesOptions = computed(() =>
    withCurrent(
      this.state.series().map((name) => ({ value: name, label: name })),
      this.general().invoiceSeries,
      (name) => name,
    ),
  );
  protected readonly entries = computed<PriceListEntry[]>(() => {
    const rows = this.general().priceLists;
    const known = this.state.priceLists().filter((priceList) => priceList.enabled);
    const unknown = rows
      .filter((row) => !known.some((priceList) => priceList.id === row.id))
      .map((row) => ({ id: row.id, name: row.id }));
    return [
      ...known.map((priceList) => ({ id: priceList.id, name: priceList.name })),
      ...unknown,
    ].map((entry) => ({ ...entry, index: rows.findIndex((row) => row.id === entry.id) }));
  });

  constructor() {
    this.state.need('countries');
    this.state.need('companies');
    this.state.need('priceLists');
    this.state.need('series');
  }

  /** A province of another country is not valid: the choice is cleared when the country changes. */
  protected onCountry(code: string): void {
    const province = this.general().address.province;
    if (!this.countries.areas(code).some((area) => area.code === province)) {
      this.f.address.province().value.set('');
    }
  }

  protected toggle(entry: PriceListEntry, on: boolean): void {
    this.state.edit('general', (general) => ({
      ...general,
      priceLists: on
        ? [
            ...general.priceLists,
            { id: entry.id, allYouCanEat: false, ayceCode1: '', ayceCode2: '' },
          ]
        : general.priceLists.filter((row) => row.id !== entry.id),
    }));
  }
}
