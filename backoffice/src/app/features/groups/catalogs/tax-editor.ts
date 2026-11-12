import { Component, computed, inject, input, linkedSignal, output } from '@angular/core';
import {
  form,
  FormField,
  maxLength,
  ReadonlyFieldTree,
  submit,
  validate,
} from '@angular/forms/signals';
import { ApiError } from '../../../core/api/api-error';
import { I18nService } from '../../../core/i18n/i18n.service';
import { TPipe } from '../../../core/i18n/t-pipe';
import { fieldErrorMessage, focusFirstError } from '../../../shared/forms/form-errors';
import { Button } from '../../../shared/ui/button/button';
import { FormError } from '../../../shared/ui/form-error/form-error';
import { Select, SelectOption } from '../../../shared/ui/select/select';
import { TextField } from '../../../shared/ui/text-field/text-field';
import { Tax, VAT_NATURES, vatNatureDescription } from './catalog.types';
import { editorErrors } from './catalog-errors';
import { numberIssue, numberOrNull, numberText, textOrNull } from './catalog-fields';

/** Body of a tax rate write (creation: the filled fields; modification: what changed). */
export interface TaxBody {
  rate?: number;
  department?: number | null;
  description?: string | null;
  vatNature?: string | null;
}

/**
 * Form of a tax rate: percentage, fiscal department, description and VAT nature of the
 * electronic invoice. Choosing a nature fills in its official description, unless the user wrote
 * a description of their own.
 */
@Component({
  selector: 'fc-tax-editor',
  imports: [Button, FormError, FormField, Select, TextField, TPipe],
  templateUrl: './tax-editor.html',
  styleUrl: './catalog-editor.css',
})
export class TaxEditor {
  protected readonly i18n = inject(I18nService);

  /** The rate being changed; `null` to create one. */
  readonly item = input<Tax | null>(null);
  /** Error of the last save. */
  readonly error = input<ApiError | null>(null);
  /** A save is in progress. */
  readonly busy = input(false);
  /** The body to send. */
  readonly save = output<TaxBody>();
  /** The user gave up. */
  readonly cancelled = output<void>();

  protected readonly model = linkedSignal(() => ({
    rate: numberText(this.item()?.rate ?? null),
    department: numberText(this.item()?.department ?? null),
    description: this.item()?.description ?? '',
    vatNature: this.item()?.vatNature ?? '',
  }));
  protected readonly taxForm = form(this.model, (path) => {
    validate(path.rate, ({ value }) => {
      const kind = numberIssue(value(), { min: 0, max: 100 });
      return kind === undefined ? undefined : { kind };
    });
    validate(path.department, ({ value }) => {
      const kind = numberIssue(value(), { min: 1, max: 99, integer: true, optional: true });
      return kind === undefined ? undefined : { kind };
    });
    maxLength(path.description, 200);
  });

  protected readonly natureOptions = computed<SelectOption[]>(() => {
    const options = VAT_NATURES.map((nature) => ({
      value: nature.code,
      label: `${nature.code} - ${nature.description}`,
    }));
    const stored = this.item()?.vatNature;
    // A nature stored outside the official list is shown as it is.
    return stored && vatNatureDescription(stored) === null
      ? [{ value: stored, label: stored }, ...options]
      : options;
  });

  protected readonly errors = computed(() =>
    editorErrors(this.i18n, this.error(), ['rate', 'department', 'description', 'vatNature']),
  );
  protected readonly body = computed<TaxBody>(() => {
    const model = this.model();
    const values = {
      rate: Number(model.rate),
      department: numberOrNull(model.department),
      description: textOrNull(model.description),
      vatNature: textOrNull(model.vatNature),
    };
    const item = this.item();
    if (item === null) {
      return {
        rate: values.rate,
        ...(values.department === null ? {} : { department: values.department }),
        ...(values.description === null ? {} : { description: values.description }),
        ...(values.vatNature === null ? {} : { vatNature: values.vatNature }),
      };
    }
    const body: TaxBody = {};
    for (const key of ['rate', 'department', 'description', 'vatNature'] as const) {
      if (values[key] !== item[key]) {
        Object.assign(body, { [key]: values[key] });
      }
    }
    return body;
  });
  protected readonly hasChanges = computed(
    () => this.item() === null || Object.keys(this.body()).length > 0,
  );

  protected message(field: ReadonlyFieldTree<unknown>, name: string): string | null {
    return fieldErrorMessage(this.i18n, field()) ?? this.errors().fields[name] ?? null;
  }

  /** Picks a VAT nature and, when the description is empty or still the previous nature's, fills in the official one. */
  protected onNature(code: string): void {
    this.model.update((model) => {
      // By now the model already holds the new code: the description to replace is an official one.
      const current = model.description.trim();
      const replace =
        current === '' || VAT_NATURES.some((nature) => nature.description === current);
      const official = vatNatureDescription(code);
      return {
        ...model,
        vatNature: code,
        description: replace && official !== null ? official : model.description,
      };
    });
  }

  protected async onSubmit(event: Event): Promise<void> {
    event.preventDefault();
    await submit(this.taxForm, {
      action: async () => {
        this.save.emit(this.body());
        return undefined;
      },
      onInvalid: () => focusFirstError(this.taxForm),
    });
  }
}
