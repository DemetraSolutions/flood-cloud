import { Component, computed, inject, input, linkedSignal, resource, signal } from '@angular/core';
import {
  applyEach,
  FieldTree,
  form,
  FormField,
  ReadonlyFieldTree,
  submit,
  TreeValidationResult,
  validate,
} from '@angular/forms/signals';
import { apiErrorMessageKey } from '../../core/api/api-error';
import { formatMoney } from '../../core/i18n/format';
import { I18nService } from '../../core/i18n/i18n.service';
import { DEFAULT_LANGUAGE } from '../../core/i18n/language';
import { TPipe } from '../../core/i18n/t-pipe';
import { fieldErrorMessage, focusFirstError } from '../../shared/forms/form-errors';
import { Button } from '../../shared/ui/button/button';
import { ErrorState } from '../../shared/ui/error-state/error-state';
import { FormError } from '../../shared/ui/form-error/form-error';
import { TextField } from '../../shared/ui/text-field/text-field';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { PriceListApi } from '../price-list/price-list-api';
import {
  DealerPrices,
  PriceFormModel,
  PriceList,
  PriceOverrides,
  priceIssue,
  pricesToCents,
  SERVICE_KEYS,
  SERVICE_LABEL_KEYS,
  ServiceKey,
  servicesToModel,
  Versioned,
  centsToEuroText,
} from '../price-list/price-list.types';
import { priceWriteOutcome } from '../price-list/price-write-error';
import { apiErrorOf } from '../profile/sessions';

/**
 * The section "Prezzi personalizzati" of the dealer detail (platform administrators): for each
 * plan and service of the price list the default price and an optional price of the dealer
 * that applies instead of it, typed in euro and sent in cents. An empty field means no override
 * ("Ripristina predefinito" empties it). Saving presents the version read in `If-Match`; a stale
 * version (`412`) asks to reload and the fields the backend refuses (`422`) show their message.
 */
@Component({
  selector: 'fc-dealer-price-overrides',
  imports: [Button, ErrorState, FormError, FormField, TextField, TPipe],
  templateUrl: './dealer-price-overrides.html',
  styleUrl: './dealer-price-overrides.css',
})
export class DealerPriceOverrides {
  private readonly api = inject(PriceListApi);
  private readonly toast = inject(ToastService);
  protected readonly i18n = inject(I18nService);

  /** The dealer (bound by the parent). */
  readonly dealerId = input.required<string>();

  private readonly defaults = resource({ loader: () => this.api.read() });
  private readonly loaded = resource({
    params: () => this.dealerId(),
    loader: ({ params }) => this.api.readOverrides(params),
  });
  /** The overrides as the server has them, and their version; replaced by every save. */
  private readonly saved = linkedSignal<
    Versioned<DealerPrices> | undefined,
    Versioned<DealerPrices> | null
  >({
    source: () => (this.loaded.hasValue() ? this.loaded.value() : undefined),
    computation: (value) => value ?? null,
  });
  private readonly defaultList = computed<PriceList | null>(() =>
    this.defaults.hasValue() ? this.defaults.value().value : null,
  );
  protected readonly ready = computed(() => this.saved() !== null && this.defaultList() !== null);
  protected readonly loading = computed(() => this.loaded.isLoading() || this.defaults.isLoading());
  protected readonly loadError = computed(
    () => apiErrorOf(this.loaded.error()) ?? apiErrorOf(this.defaults.error()),
  );
  protected readonly failed = computed(
    () => this.loaded.error() !== undefined || this.defaults.error() !== undefined,
  );
  protected readonly loadErrorMessage = computed(() => {
    const error = this.loadError();
    return this.i18n.t(error === null ? 'ERRORS.GENERIC.MESSAGE' : apiErrorMessageKey(error));
  });

  protected readonly serviceKeys = SERVICE_KEYS;
  /** The plans of the form: those of the price list and those the dealer already overrides. */
  protected readonly model = linkedSignal<PriceFormModel>(() => {
    const list = this.defaultList();
    const overrides = this.saved()?.value.overrides.plans ?? {};
    const keys = [...new Set([...Object.keys(list?.plans ?? {}), ...Object.keys(overrides)])].sort(
      (a, b) => a.localeCompare(b, 'it'),
    );
    return {
      plans: keys.map((key) => ({
        key,
        price: Object.hasOwn(overrides, key) ? centsToEuroText(overrides[key]) : '',
      })),
      services: servicesToModel(this.saved()?.value.overrides.services),
    };
  });
  protected readonly overridesForm = form(this.model, (path) => {
    applyEach(path.plans, (row) => {
      validate(row.price, ({ value }) => {
        const kind = priceIssue(value(), true);
        return kind === undefined ? undefined : { kind };
      });
    });
    for (const key of SERVICE_KEYS) {
      validate(path.services[key], ({ value }) => {
        const kind = priceIssue(value(), true);
        return kind === undefined ? undefined : { kind };
      });
    }
  });

  protected readonly submitting = computed(() => this.overridesForm().submitting());
  /** Message of a failure that belongs to no field. */
  protected readonly failure = signal<string | null>(null);
  /** The saved version is no longer the current one. */
  protected readonly stale = signal(false);

  protected serviceLabel(key: ServiceKey): string {
    return this.i18n.t(SERVICE_LABEL_KEYS[key]);
  }

  protected planLabel(key: string): string {
    return this.i18n.t('DEALERS.PRICES.PLAN', { plan: key });
  }

  /** Hint under a field: the default price, or that there is none. */
  protected defaultHint(kind: 'plans' | 'services', key: string): string {
    const prices = (this.defaultList() as PriceList)[kind];
    return Object.hasOwn(prices, key)
      ? this.i18n.t('DEALERS.PRICES.DEFAULT', { price: this.money(prices[key]) })
      : this.i18n.t('DEALERS.PRICES.NO_DEFAULT');
  }

  protected restoreLabel(name: string): string {
    return this.i18n.t('DEALERS.PRICES.RESTORE_LABEL', { name });
  }

  protected error(field: FieldTree<string>): string | null {
    return fieldErrorMessage(this.i18n, field());
  }

  protected restore(field: FieldTree<string>): void {
    field().value.set('');
  }

  protected reload(): void {
    this.failure.set(null);
    this.stale.set(false);
    this.defaults.reload();
    this.loaded.reload();
  }

  protected async onSubmit(event: Event): Promise<void> {
    event.preventDefault();
    await submit(this.overridesForm, {
      action: async () => {
        this.failure.set(null);
        this.stale.set(false);
        const model = this.model();
        const plans = pricesToCents(model.plans.map((row) => [row.key, row.price]));
        const services = pricesToCents(SERVICE_KEYS.map((key) => [key, model.services[key]]));
        const body: PriceOverrides = {
          ...(Object.keys(plans).length > 0 ? { plans } : {}),
          ...(Object.keys(services).length > 0 ? { services } : {}),
        };
        let result: Versioned<DealerPrices>;
        try {
          result = await this.api.writeOverrides(
            this.dealerId(),
            body,
            (this.saved() as Versioned<DealerPrices>).etag,
          );
        } catch (error) {
          return this.reject(error);
        }
        this.saved.set(result);
        this.toast.success(this.i18n.t('DEALERS.PRICES.SAVED'));
        return undefined;
      },
      onInvalid: () => focusFirstError(this.overridesForm),
    });
  }

  private reject(error: unknown): TreeValidationResult {
    const outcome = priceWriteOutcome(this.i18n, error, () => {
      const f = this.overridesForm;
      const fields: Record<string, ReadonlyFieldTree<unknown>> = {};
      for (const key of SERVICE_KEYS) {
        fields[`services.${key}`] = f.services[key];
      }
      this.model().plans.forEach((row, index) => {
        fields[`plans.${row.key}`] = f.plans[index].price;
      });
      return fields;
    });
    this.stale.set(outcome.stale);
    this.failure.set(outcome.failure);
    return outcome.errors;
  }

  private money(cents: number): string {
    return formatMoney(cents, 'EUR', this.i18n.language() ?? DEFAULT_LANGUAGE);
  }
}
