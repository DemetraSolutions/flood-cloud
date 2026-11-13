import { Component, computed, inject } from '@angular/core';
import { FormField } from '@angular/forms/signals';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { Checkbox } from '../../shared/ui/checkbox/checkbox';
import { Select } from '../../shared/ui/select/select';
import { TextField } from '../../shared/ui/text-field/text-field';
import { withCurrent } from './company-options';
import { CompanySave } from './company-save';
import { CompanyState } from './company-state';
import { ECOMMERCE_FLAGS, EcommerceFlag } from './company.types';

/**
 * Customer app and e-commerce tab: access pages of the app, the e-commerce status, the price
 * list, the minimum order per currency of the group, the quantity shown and the display
 * switches. The price list select shows the stored list even when it is no longer offered.
 */
@Component({
  selector: 'fc-company-customer-app',
  imports: [Checkbox, CompanySave, FormField, Select, TextField, TPipe],
  templateUrl: './company-customer-app.html',
  styleUrl: './company-section.css',
})
export class CompanyCustomerApp {
  protected readonly state = inject(CompanyState);
  private readonly i18n = inject(I18nService);

  protected readonly f = this.state.form.customerApp;
  protected readonly flags = ECOMMERCE_FLAGS;
  private readonly ecommerce = computed(() => this.state.model().customerApp.ecommerce);

  protected readonly priceListOptions = computed(() =>
    withCurrent(
      this.state
        .priceLists()
        .filter((list) => list.enabled)
        .map((list) => ({ value: list.id, label: list.name })),
      this.ecommerce().priceListId,
      (id) => id,
    ),
  );
  /** Currencies of the group, and any other the stored minimum order has. */
  protected readonly currencies = computed(() =>
    [
      ...new Set([...this.state.currencies(), ...Object.keys(this.ecommerce().minimumOrder)]),
    ].sort(),
  );
  /** Server message on the minimum order (its currencies have no field of their own). */
  protected readonly minimumOrderError = computed(
    () =>
      this.f.ecommerce
        .minimumOrder()
        .errorSummary()
        .find((error) => error.kind === 'server')?.message ?? null,
  );

  constructor() {
    this.state.need('priceLists');
    this.state.need('currencies');
  }

  protected minimum(code: string): string {
    return this.ecommerce().minimumOrder[code] ?? '';
  }

  protected setMinimum(code: string, value: string): void {
    this.state.edit('customerApp', (app) => ({
      ...app,
      ecommerce: {
        ...app.ecommerce,
        minimumOrder: { ...app.ecommerce.minimumOrder, [code]: value },
      },
    }));
  }

  protected flagLabel(flag: EcommerceFlag): string {
    return this.i18n.t(
      `COMPANIES.CUSTOMER_APP.FLAG.${flag.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}`,
    );
  }
}
