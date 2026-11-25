import { Component, computed, inject, input } from '@angular/core';
import { FieldTree, FormField, ReadonlyFieldTree } from '@angular/forms/signals';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { Countries } from '../../core/reference/countries';
import { fieldErrorMessage } from '../../shared/forms/form-errors';
import { Select } from '../../shared/ui/select/select';
import { TextField } from '../../shared/ui/text-field/text-field';
import { withCurrent } from '../companies/company-options';
import { AddressModel } from './contact-model';

/**
 * The address of the person or of the company: street, postcode, city and the country with its
 * province, which is a choice among the provinces of the country and is cleared when the country
 * changes to one that does not have it. A value the lists do not have (a legacy code) is kept as an
 * option so that it is shown and never silently replaced.
 */
@Component({
  selector: 'fc-contact-address',
  imports: [FormField, Select, TextField, TPipe],
  templateUrl: './contact-address.html',
  styleUrl: './contact-section.css',
})
export class ContactAddress {
  private readonly i18n = inject(I18nService);
  private readonly countries = inject(Countries);

  /** The form of the address (bound by the page). */
  readonly form = input.required<FieldTree<AddressModel>>();
  /** Name of the group of fields (already translated). */
  readonly legend = input.required<string>();

  protected readonly countryOptions = computed(() =>
    withCurrent(
      this.countries.list().map((country) => ({ value: country.code, label: country.name })),
      this.form().countryCode().value(),
      (code) => code,
    ),
  );
  protected readonly areas = computed(() => this.countries.areas(this.form().countryCode().value()));
  protected readonly provinceOptions = computed(() =>
    withCurrent(
      this.areas().map((area) => ({ value: area.code, label: `${area.name} (${area.code})` })),
      this.form().areaCode().value(),
      (code) => code,
    ),
  );

  constructor() {
    this.countries.need();
  }

  protected error(field: ReadonlyFieldTree<unknown>): string | null {
    return fieldErrorMessage(this.i18n, field());
  }

  /** A province of another country is not valid: the choice is cleared when the country changes. */
  protected onCountry(code: string): void {
    const province = this.form().areaCode().value();
    if (!this.countries.areas(code).some((area) => area.code === province)) {
      this.form().areaCode().value.set('');
    }
  }
}
