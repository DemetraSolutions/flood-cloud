import { Component, computed, inject, input, linkedSignal, output } from '@angular/core';
import {
  disabled,
  form,
  FormField,
  pattern,
  ReadonlyFieldTree,
  required,
  submit,
  validate,
} from '@angular/forms/signals';
import { ApiError } from '../../../core/api/api-error';
import { I18nService } from '../../../core/i18n/i18n.service';
import { TPipe } from '../../../core/i18n/t-pipe';
import { fieldErrorMessage, focusFirstError } from '../../../shared/forms/form-errors';
import { Button } from '../../../shared/ui/button/button';
import { FormError } from '../../../shared/ui/form-error/form-error';
import { TextField } from '../../../shared/ui/text-field/text-field';
import { Currency } from './catalog.types';
import { editorErrors } from './catalog-errors';

/** Body of a currency write: creation sends both fields, modification only the symbol. */
export interface CurrencyBody {
  code?: string;
  symbol?: string;
}

/** Three upper-case letters (the syntax of ISO 4217). */
export const CURRENCY_CODE = /^[A-Z]{3}$/;
/** Symbol: 1 to 8 characters, none of `<`, `>`, `&`, `"`, `'` nor control characters. */
export const CURRENCY_SYMBOL_FORBIDDEN = /[<>&"'\u0000-\u001f\u007f]/;

/**
 * Form of a currency. The code identifies the currency and cannot change after creation; the
 * symbol can. Creating a currency also creates its loyalty-card rule.
 */
@Component({
  selector: 'fc-currency-editor',
  imports: [Button, FormError, FormField, TextField, TPipe],
  templateUrl: './currency-editor.html',
  styleUrl: './catalog-editor.css',
})
export class CurrencyEditor {
  protected readonly i18n = inject(I18nService);

  /** The currency being changed; `null` to create one. */
  readonly item = input<Currency | null>(null);
  /** Error of the last save. */
  readonly error = input<ApiError | null>(null);
  /** A save is in progress. */
  readonly busy = input(false);
  /** The body to send. */
  readonly save = output<CurrencyBody>();
  /** The user gave up. */
  readonly cancelled = output<void>();

  protected readonly model = linkedSignal(() => ({
    code: this.item()?.code ?? '',
    symbol: this.item()?.symbol ?? '',
  }));
  protected readonly currencyForm = form(this.model, (path) => {
    required(path.code);
    pattern(path.code, CURRENCY_CODE);
    disabled(path.code, () => this.item() !== null);
    required(path.symbol);
    validate(path.symbol, ({ value }) => {
      if (value().length > 8) {
        return { kind: 'maxLength' };
      }
      return CURRENCY_SYMBOL_FORBIDDEN.test(value()) ? { kind: 'pattern' } : undefined;
    });
  });

  protected readonly errors = computed(() =>
    editorErrors(this.i18n, this.error(), ['code', 'symbol']),
  );
  protected readonly body = computed<CurrencyBody>(() => {
    const model = this.model();
    const item = this.item();
    if (item === null) {
      return { code: model.code, symbol: model.symbol };
    }
    return model.symbol === item.symbol ? {} : { symbol: model.symbol };
  });
  protected readonly hasChanges = computed(
    () => this.item() === null || Object.keys(this.body()).length > 0,
  );

  protected message(field: ReadonlyFieldTree<unknown>, name: string): string | null {
    return fieldErrorMessage(this.i18n, field()) ?? this.errors().fields[name] ?? null;
  }

  protected async onSubmit(event: Event): Promise<void> {
    event.preventDefault();
    await submit(this.currencyForm, {
      action: async () => {
        this.save.emit(this.body());
        return undefined;
      },
      onInvalid: () => focusFirstError(this.currencyForm),
    });
  }
}
