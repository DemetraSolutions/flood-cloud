import { Component, computed, inject, input, linkedSignal, output } from '@angular/core';
import { form, FormField, ReadonlyFieldTree, submit, validate } from '@angular/forms/signals';
import { ApiError } from '../../../core/api/api-error';
import { I18nService } from '../../../core/i18n/i18n.service';
import { TPipe } from '../../../core/i18n/t-pipe';
import { fieldErrorMessage, focusFirstError } from '../../../shared/forms/form-errors';
import { Button } from '../../../shared/ui/button/button';
import { FormError } from '../../../shared/ui/form-error/form-error';
import { TextField } from '../../../shared/ui/text-field/text-field';
import { FidelityCardRule } from './catalog.types';
import { editorErrors } from './catalog-errors';
import { numberIssue, numberOrNull, numberText } from './catalog-fields';

/** Body of `PUT` on a loyalty-card rule: both values, `null` when not set. */
export interface FidelityRuleBody {
  pointValue: number | null;
  discountPercentage: number | null;
}

/** Form of the loyalty-card rule of a currency: the money value of a point and the discount. */
@Component({
  selector: 'fc-fidelity-rule-editor',
  imports: [Button, FormError, FormField, TextField, TPipe],
  templateUrl: './fidelity-rule-editor.html',
  styleUrl: './catalog-editor.css',
})
export class FidelityRuleEditor {
  protected readonly i18n = inject(I18nService);

  /** The rule being changed (rules exist for every currency: there is no creation). */
  readonly item = input<FidelityCardRule | null>(null);
  /** Error of the last save. */
  readonly error = input<ApiError | null>(null);
  /** A save is in progress. */
  readonly busy = input(false);
  /** The body to send. */
  readonly save = output<FidelityRuleBody>();
  /** The user gave up. */
  readonly cancelled = output<void>();

  protected readonly model = linkedSignal(() => ({
    pointValue: numberText(this.item()?.pointValue ?? null),
    discountPercentage: numberText(this.item()?.discountPercentage ?? null),
  }));
  protected readonly ruleForm = form(this.model, (path) => {
    validate(path.pointValue, ({ value }) => {
      const kind = numberIssue(value(), { min: 0, optional: true });
      return kind === undefined ? undefined : { kind };
    });
    validate(path.discountPercentage, ({ value }) => {
      const kind = numberIssue(value(), { min: 0, max: 100, optional: true });
      return kind === undefined ? undefined : { kind };
    });
  });

  protected readonly errors = computed(() =>
    editorErrors(this.i18n, this.error(), ['pointValue', 'discountPercentage']),
  );
  protected readonly body = computed<FidelityRuleBody>(() => ({
    pointValue: numberOrNull(this.model().pointValue),
    discountPercentage: numberOrNull(this.model().discountPercentage),
  }));
  protected readonly hasChanges = computed(() => {
    const item = this.item();
    return (
      this.body().pointValue !== (item?.pointValue ?? null) ||
      this.body().discountPercentage !== (item?.discountPercentage ?? null)
    );
  });

  protected message(field: ReadonlyFieldTree<unknown>, name: string): string | null {
    return fieldErrorMessage(this.i18n, field()) ?? this.errors().fields[name] ?? null;
  }

  protected async onSubmit(event: Event): Promise<void> {
    event.preventDefault();
    await submit(this.ruleForm, {
      action: async () => {
        this.save.emit(this.body());
        return undefined;
      },
      onInvalid: () => focusFirstError(this.ruleForm),
    });
  }
}
