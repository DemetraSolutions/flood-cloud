import { Component, computed, inject, input, linkedSignal, output } from '@angular/core';
import {
  disabled,
  form,
  FormField,
  maxLength,
  ReadonlyFieldTree,
  required,
  submit,
} from '@angular/forms/signals';
import { ApiError } from '../../../core/api/api-error';
import { I18nService } from '../../../core/i18n/i18n.service';
import { TPipe } from '../../../core/i18n/t-pipe';
import { fieldErrorMessage, focusFirstError } from '../../../shared/forms/form-errors';
import { Button } from '../../../shared/ui/button/button';
import { Checkbox } from '../../../shared/ui/checkbox/checkbox';
import { FormError } from '../../../shared/ui/form-error/form-error';
import { TextField } from '../../../shared/ui/text-field/text-field';
import { PriceList } from './catalog.types';
import { editorErrors } from './catalog-errors';

/** Body of a price list write (creation: the whole list; modification: what changed). */
export interface PriceListBody {
  name?: string;
  enabled?: boolean;
  isDefault?: boolean;
}

/**
 * Form of a price list. The standard list stays the standard one (the flag moves by marking
 * another list); the first list of a group is the standard one whatever is asked, so a creation
 * only sends the flag when it is on.
 */
@Component({
  selector: 'fc-price-list-editor',
  imports: [Button, Checkbox, FormError, FormField, TextField, TPipe],
  templateUrl: './price-list-editor.html',
  styleUrl: './catalog-editor.css',
})
export class PriceListEditor {
  protected readonly i18n = inject(I18nService);

  /** The list being changed; `null` to create one. */
  readonly item = input<PriceList | null>(null);
  /** Error of the last save. */
  readonly error = input<ApiError | null>(null);
  /** A save is in progress. */
  readonly busy = input(false);
  /** The body to send. */
  readonly save = output<PriceListBody>();
  /** The user gave up. */
  readonly cancelled = output<void>();

  protected readonly model = linkedSignal(() => ({
    name: this.item()?.name ?? '',
    enabled: this.item()?.enabled ?? true,
    isDefault: this.item()?.isDefault ?? false,
  }));
  protected readonly priceForm = form(this.model, (path) => {
    required(path.name);
    maxLength(path.name, 100);
    disabled(path.isDefault, () => this.item()?.isDefault === true);
  });

  protected readonly errors = computed(() =>
    editorErrors(this.i18n, this.error(), ['name', 'enabled', 'isDefault']),
  );
  protected readonly body = computed<PriceListBody>(() => {
    const model = this.model();
    const item = this.item();
    if (item === null) {
      return {
        name: model.name.trim(),
        enabled: model.enabled,
        ...(model.isDefault ? { isDefault: true } : {}),
      };
    }
    return {
      ...(model.name.trim() === item.name ? {} : { name: model.name.trim() }),
      ...(model.enabled === item.enabled ? {} : { enabled: model.enabled }),
      ...(model.isDefault && !item.isDefault ? { isDefault: true } : {}),
    };
  });
  protected readonly hasChanges = computed(
    () => this.item() === null || Object.keys(this.body()).length > 0,
  );

  protected message(field: ReadonlyFieldTree<unknown>, name: string): string | null {
    return fieldErrorMessage(this.i18n, field()) ?? this.errors().fields[name] ?? null;
  }

  protected async onSubmit(event: Event): Promise<void> {
    event.preventDefault();
    await submit(this.priceForm, {
      action: async () => {
        this.save.emit(this.body());
        return undefined;
      },
      onInvalid: () => focusFirstError(this.priceForm),
    });
  }
}
