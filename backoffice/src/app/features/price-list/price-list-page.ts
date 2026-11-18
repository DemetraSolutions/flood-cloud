import { Component, computed, inject, linkedSignal, resource, signal } from '@angular/core';
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
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { fieldErrorMessage, focusFirstError } from '../../shared/forms/form-errors';
import { Button } from '../../shared/ui/button/button';
import { ErrorState } from '../../shared/ui/error-state/error-state';
import { FormError } from '../../shared/ui/form-error/form-error';
import { TextField } from '../../shared/ui/text-field/text-field';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { apiErrorOf } from '../profile/sessions';
import { PriceListApi } from './price-list-api';
import { priceWriteOutcome } from './price-write-error';
import {
  MAX_PLANS,
  PLAN_KEY_PATTERN,
  PlanRow,
  plansToRows,
  PriceFormModel,
  PriceList,
  priceIssue,
  pricesToCents,
  SERVICE_KEYS,
  SERVICE_LABEL_KEYS,
  servicesToModel,
  ServiceKey,
  Versioned,
} from './price-list.types';

/** The form model of a price list (empty when there is none yet). */
function toModel(list: PriceList | undefined): PriceFormModel {
  return { plans: plansToRows(list?.plans ?? {}), services: servicesToModel(list?.services) };
}

/**
 * The price list (`/tools/price-list`, platform administrators): the monthly fee of each plan
 * (keys can be added and removed) and of each service, typed in euro and sent in cents. Saving
 * presents the version read in `If-Match`; a stale version (`412`) asks to reload and the fields
 * the backend refuses (`422`) show their message.
 */
@Component({
  selector: 'fc-price-list-page',
  imports: [Button, ErrorState, FormError, FormField, TextField, TPipe],
  templateUrl: './price-list-page.html',
  styleUrl: './price-list-page.css',
})
export class PriceListPage {
  private readonly api = inject(PriceListApi);
  private readonly toast = inject(ToastService);
  protected readonly i18n = inject(I18nService);

  private readonly loaded = resource({ loader: () => this.api.read() });
  /** The list as the server has it, and its version; replaced by every save. */
  private readonly saved = linkedSignal<
    Versioned<PriceList> | undefined,
    Versioned<PriceList> | null
  >({
    source: () => (this.loaded.hasValue() ? this.loaded.value() : undefined),
    computation: (value) => value ?? null,
  });
  protected readonly ready = computed(() => this.saved() !== null);
  protected readonly loading = computed(() => this.loaded.isLoading());
  protected readonly failed = computed(() => this.loaded.error() !== undefined);
  protected readonly loadError = computed(() => apiErrorOf(this.loaded.error()));
  protected readonly loadErrorMessage = computed(() => {
    const error = this.loadError();
    return this.i18n.t(error === null ? 'ERRORS.GENERIC.MESSAGE' : apiErrorMessageKey(error));
  });

  protected readonly serviceKeys = SERVICE_KEYS;
  protected readonly model = linkedSignal(() => toModel(this.saved()?.value));
  protected readonly priceForm = form(this.model, (path) => {
    applyEach(path.plans, (row) => {
      validate(row.key, ({ value, valueOf }) => {
        const key = value().trim();
        if (key === '') {
          return { kind: 'required' };
        }
        if (!PLAN_KEY_PATTERN.test(key)) {
          return { kind: 'pattern' };
        }
        return valueOf(path.plans).filter((other) => other.key.trim() === key).length > 1
          ? { kind: 'taken' }
          : undefined;
      });
      validate(row.price, ({ value }) => {
        const kind = priceIssue(value());
        return kind === undefined ? undefined : { kind };
      });
    });
    for (const key of SERVICE_KEYS) {
      validate(path.services[key], ({ value }) => {
        const kind = priceIssue(value());
        return kind === undefined ? undefined : { kind };
      });
    }
  });

  protected readonly canAddPlan = computed(() => this.model().plans.length < MAX_PLANS);
  protected readonly submitting = computed(() => this.priceForm().submitting());
  /** Message of a failure that belongs to no field. */
  protected readonly failure = signal<string | null>(null);
  /** The saved version is no longer the current one. */
  protected readonly stale = signal(false);

  protected serviceLabel(key: ServiceKey): string {
    return this.i18n.t(SERVICE_LABEL_KEYS[key]);
  }

  protected error(field: FieldTree<string>): string | null {
    return fieldErrorMessage(this.i18n, field());
  }

  protected planKeyLabel(index: number): string {
    return this.i18n.t('PRICE_LIST.PLAN_KEY', { number: index + 1 });
  }

  protected planPriceLabel(index: number): string {
    return this.i18n.t('PRICE_LIST.PLAN_PRICE', { number: index + 1 });
  }

  protected removeLabel(index: number): string {
    return this.i18n.t('PRICE_LIST.REMOVE_PLAN', { number: index + 1 });
  }

  protected addPlan(): void {
    this.model.update((model) => ({ ...model, plans: [...model.plans, { key: '', price: '' }] }));
  }

  protected removePlan(index: number): void {
    this.model.update((model) => ({
      ...model,
      plans: model.plans.filter((_, at) => at !== index),
    }));
  }

  protected reload(): void {
    this.failure.set(null);
    this.stale.set(false);
    this.loaded.reload();
  }

  protected async onSubmit(event: Event): Promise<void> {
    event.preventDefault();
    await submit(this.priceForm, {
      action: async () => {
        this.failure.set(null);
        this.stale.set(false);
        const model = this.model();
        const body: PriceList = {
          plans: pricesToCents(model.plans.map((row: PlanRow) => [row.key.trim(), row.price])),
          services: pricesToCents(SERVICE_KEYS.map((key) => [key, model.services[key]])),
        };
        let result: Versioned<PriceList>;
        try {
          result = await this.api.write(body, (this.saved() as Versioned<PriceList>).etag);
        } catch (error) {
          return this.reject(error);
        }
        this.saved.set(result);
        this.toast.success(this.i18n.t('PRICE_LIST.SAVED'));
        return undefined;
      },
      onInvalid: () => focusFirstError(this.priceForm),
    });
  }

  private reject(error: unknown): TreeValidationResult {
    const outcome = priceWriteOutcome(this.i18n, error, () => {
      const f = this.priceForm;
      const fields: Record<string, ReadonlyFieldTree<unknown>> = {};
      for (const key of SERVICE_KEYS) {
        fields[`services.${key}`] = f.services[key];
      }
      this.model().plans.forEach((row, index) => {
        fields[`plans.${row.key.trim()}`] = f.plans[index].price;
      });
      return fields;
    });
    this.stale.set(outcome.stale);
    this.failure.set(outcome.failure);
    return outcome.errors;
  }
}
