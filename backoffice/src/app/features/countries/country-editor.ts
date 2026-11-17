import { Component, computed, inject, input, linkedSignal, output } from '@angular/core';
import {
  disabled,
  form,
  FormField,
  maxLength,
  pattern,
  ReadonlyFieldTree,
  required,
  submit,
  validate,
} from '@angular/forms/signals';
import { ApiError } from '../../core/api/api-error';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { fieldErrorMessage, focusFirstError } from '../../shared/forms/form-errors';
import { Button } from '../../shared/ui/button/button';
import { FormError } from '../../shared/ui/form-error/form-error';
import { TextField } from '../../shared/ui/text-field/text-field';
import { editorErrors } from '../groups/catalogs/catalog-errors';
import {
  COUNTRY_CODE,
  COUNTRY_NAME_FORBIDDEN,
  COUNTRY_NAME_MAX,
  CountryBody,
} from './countries.types';

/**
 * Form of a country or of an area: a code of two upper-case letters and a name. The code
 * identifies the item and cannot change after creation; only the name can.
 */
@Component({
  selector: 'fc-country-editor',
  imports: [Button, FormError, FormField, TextField, TPipe],
  templateUrl: './country-editor.html',
  styleUrl: '../groups/catalogs/catalog-editor.css',
})
export class CountryEditor {
  protected readonly i18n = inject(I18nService);

  /** The item being changed; `null` to create one. */
  readonly item = input<{ code: string; name: string } | null>(null);
  /** Error of the last save. */
  readonly error = input<ApiError | null>(null);
  /** A save is in progress. */
  readonly busy = input(false);
  /** The body to send. */
  readonly save = output<CountryBody>();
  /** The user gave up. */
  readonly cancelled = output<void>();

  protected readonly upperCase = (text: string): string => text.toUpperCase();
  protected readonly model = linkedSignal(() => ({
    code: this.item()?.code ?? '',
    name: this.item()?.name ?? '',
  }));
  protected readonly countryForm = form(this.model, (path) => {
    required(path.code);
    pattern(path.code, COUNTRY_CODE);
    disabled(path.code, () => this.item() !== null);
    maxLength(path.name, COUNTRY_NAME_MAX);
    validate(path.name, ({ value }) => {
      if (value().trim() === '') {
        return { kind: 'required' };
      }
      return COUNTRY_NAME_FORBIDDEN.test(value()) ? { kind: 'pattern' } : undefined;
    });
  });

  protected readonly errors = computed(() =>
    editorErrors(this.i18n, this.error(), ['code', 'name']),
  );
  protected readonly body = computed<CountryBody>(() => {
    const model = this.model();
    const item = this.item();
    const name = model.name.trim();
    if (item === null) {
      return { code: model.code, name };
    }
    return name === item.name ? {} : { name };
  });
  protected readonly hasChanges = computed(
    () => this.item() === null || Object.keys(this.body()).length > 0,
  );

  protected message(field: ReadonlyFieldTree<unknown>, name: string): string | null {
    return fieldErrorMessage(this.i18n, field()) ?? this.errors().fields[name] ?? null;
  }

  protected async onSubmit(event: Event): Promise<void> {
    event.preventDefault();
    await submit(this.countryForm, {
      action: async () => {
        this.save.emit(this.body());
        return undefined;
      },
      onInvalid: () => focusFirstError(this.countryForm),
    });
  }
}
