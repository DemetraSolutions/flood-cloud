import { Component, computed, inject, input, linkedSignal, output } from '@angular/core';
import {
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
import { FormError } from '../../../shared/ui/form-error/form-error';
import { TextField } from '../../../shared/ui/text-field/text-field';
import { MeasureUnit } from './catalog.types';
import { editorErrors } from './catalog-errors';

/** Body of a unit of measure write. */
export interface MeasureUnitBody {
  value?: string;
}

/** Form of a unit of measure (1 to 20 characters, unique without regard to case). */
@Component({
  selector: 'fc-measure-unit-editor',
  imports: [Button, FormError, FormField, TextField, TPipe],
  templateUrl: './measure-unit-editor.html',
  styleUrl: './catalog-editor.css',
})
export class MeasureUnitEditor {
  protected readonly i18n = inject(I18nService);

  /** The unit being changed; `null` to create one. */
  readonly item = input<MeasureUnit | null>(null);
  /** Error of the last save. */
  readonly error = input<ApiError | null>(null);
  /** A save is in progress. */
  readonly busy = input(false);
  /** The body to send. */
  readonly save = output<MeasureUnitBody>();
  /** The user gave up. */
  readonly cancelled = output<void>();

  protected readonly model = linkedSignal(() => ({ value: this.item()?.value ?? '' }));
  protected readonly unitForm = form(this.model, (path) => {
    required(path.value);
    maxLength(path.value, 20);
  });

  protected readonly errors = computed(() => editorErrors(this.i18n, this.error(), ['value']));
  protected readonly body = computed<MeasureUnitBody>(() => ({ value: this.model().value.trim() }));
  protected readonly hasChanges = computed(() => this.body().value !== this.item()?.value);

  protected message(field: ReadonlyFieldTree<unknown>, name: string): string | null {
    return fieldErrorMessage(this.i18n, field()) ?? this.errors().fields[name] ?? null;
  }

  protected async onSubmit(event: Event): Promise<void> {
    event.preventDefault();
    await submit(this.unitForm, {
      action: async () => {
        this.save.emit(this.body());
        return undefined;
      },
      onInvalid: () => focusFirstError(this.unitForm),
    });
  }
}
