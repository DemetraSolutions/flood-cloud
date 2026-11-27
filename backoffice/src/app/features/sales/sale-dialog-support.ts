import { afterNextRender, computed, inject, Injector, Signal } from '@angular/core';
import { I18nService } from '../../core/i18n/i18n.service';
import { DEFAULT_LANGUAGE } from '../../core/i18n/language';
import { currencySymbol, saleReference, saleSummary } from './sale-labels';
import { SaleDetail } from './sale.types';

/** What every dialog of a write says about the sale it is for. */
export interface SaleDialogText {
  /** `n. 12-345`, `del <date>` or `senza numero`: how the title names the sale. */
  readonly reference: Signal<string>;
  /** Date and total of the sale (the line under the title). */
  readonly summary: Signal<string>;
  /** Symbol of the currency of the group (`€`). */
  readonly symbol: Signal<string>;
}

/**
 * The texts that name the sale in a dialog. Call it in the field initializer of the dialog (it
 * injects the translation service).
 *
 * @param sale The sale of the dialog.
 * @param currency Currency of the amounts.
 */
export function saleDialogText(sale: Signal<SaleDetail>, currency: Signal<string>): SaleDialogText {
  const i18n = inject(I18nService);
  const language = computed(() => i18n.language() ?? DEFAULT_LANGUAGE);
  const t = (key: string, params?: Readonly<Record<string, string | number>>): string => i18n.t(key, params);
  return {
    reference: computed(() => saleReference(t, language(), sale())),
    summary: computed(() => saleSummary(t, language(), currency(), sale())),
    symbol: computed(() => currencySymbol(currency(), language())),
  };
}

/**
 * After the next render moves the focus to the first field of the dialog that is not valid, or
 * to the summary of the failure (`fc-form-error`) when no field is: a refused send lands the
 * keyboard and screen-reader user on the problem.
 *
 * @param injector Injector of the dialog.
 * @param root The element that holds the dialog.
 */
export function focusFirstProblem(injector: Injector, root: HTMLElement): void {
  afterNextRender(
    () => {
      const target =
        root.querySelector<HTMLElement>('[aria-invalid="true"]') ??
        root.querySelector<HTMLElement>('fc-form-error');
      target!.focus();
    },
    { injector },
  );
}
