import { Component, computed, inject, linkedSignal, signal } from '@angular/core';
import {
  applyEach,
  disabled,
  form,
  FormField,
  maxLength,
  pattern,
  ReadonlyFieldTree,
  required,
  submit,
  TreeValidationResult,
  validate,
} from '@angular/forms/signals';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import {
  failureMessage,
  fieldErrorMessage,
  focusFirstError,
  serverFieldErrors,
} from '../../shared/forms/form-errors';
import { Button } from '../../shared/ui/button/button';
import { Checkbox } from '../../shared/ui/checkbox/checkbox';
import { FormError } from '../../shared/ui/form-error/form-error';
import { Select } from '../../shared/ui/select/select';
import { TextField } from '../../shared/ui/text-field/text-field';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { GroupSettingsState } from './group-settings-state';
import {
  groupFailureMessage,
  hasFieldDetails,
  isGroupConflict,
  renameFields,
} from './group-errors';
import {
  buildGeneralPatch,
  generalFieldOf,
  MAX_LANGUAGES,
  MAX_TIME_SLOTS,
  OPENING_TIME,
  SLOT_ENDS,
  SLOT_STARTS,
  toGeneralModel,
} from './group.types';
import { GroupsApi } from './groups-api';
import { LanguagePicker } from './language-picker';

/**
 * General section of the group record: name, description, languages, statistics settings
 * (opening time, compression of the product categories, time slots) and the demo flag. What the
 * role may not change is shown read-only; the server decides on every write (`403` with
 * `notAllowed` lands on the field).
 */
@Component({
  selector: 'fc-group-general',
  imports: [Button, Checkbox, FormError, FormField, LanguagePicker, Select, TextField, TPipe],
  templateUrl: './group-general.html',
  styleUrl: './group-form.css',
})
export class GroupGeneral {
  private readonly api = inject(GroupsApi);
  private readonly toast = inject(ToastService);
  protected readonly state = inject(GroupSettingsState);
  protected readonly i18n = inject(I18nService);

  private readonly draft = linkedSignal(() => toGeneralModel(this.state.group()));

  protected readonly generalForm = form(this.draft, (path) => {
    required(path.name);
    maxLength(path.name, 200);
    maxLength(path.description, 1000);
    validate(path.languages, ({ value }) =>
      value().length > MAX_LANGUAGES ? { kind: 'tooMany' } : undefined,
    );
    pattern(path.openingTime, OPENING_TIME);
    validate(path.timeSlots, ({ value }) =>
      value().length > MAX_TIME_SLOTS ? { kind: 'tooMany' } : undefined,
    );
    applyEach(path.timeSlots, (slot) => {
      validate(slot.to, ({ value, valueOf }) =>
        value() <= valueOf(slot.from) ? { kind: 'incorrect' } : undefined,
      );
    });
    disabled(path, () => !this.state.canUpdate());
    disabled(path.demo, () => !this.state.canDemo());
  });

  protected readonly slotStarts = SLOT_STARTS.map((hour) => ({ value: hour, label: hour }));
  protected readonly slotEnds = SLOT_ENDS.map((hour) => ({ value: hour, label: hour }));
  protected readonly canAddSlot = computed(() => this.draft().timeSlots.length < MAX_TIME_SLOTS);

  protected readonly patch = computed(() => {
    const group = this.state.group();
    return group === null ? {} : buildGeneralPatch(this.draft(), group, this.state.canDemo());
  });
  protected readonly hasChanges = computed(() => Object.keys(this.patch()).length > 0);
  protected readonly failure = signal<string | null>(null);
  protected readonly conflict = signal(false);
  protected readonly submitting = computed(() => this.generalForm().submitting());

  protected error(field: ReadonlyFieldTree<unknown>): string | null {
    return fieldErrorMessage(this.i18n, field());
  }

  protected addSlot(): void {
    this.draft.update((model) => ({
      ...model,
      timeSlots: [...model.timeSlots, { from: '09:00', to: '10:00' }],
    }));
  }

  protected removeSlot(index: number): void {
    this.draft.update((model) => ({
      ...model,
      timeSlots: model.timeSlots.filter((_, i) => i !== index),
    }));
  }

  protected slotLabel(key: string, index: number): string {
    return this.i18n.t(key, { number: index + 1 });
  }

  protected reload(): void {
    this.conflict.set(false);
    this.failure.set(null);
    this.state.reload();
  }

  protected async onSubmit(event: Event): Promise<void> {
    event.preventDefault();
    await submit(this.generalForm, {
      action: async () => {
        this.failure.set(null);
        this.conflict.set(false);
        try {
          this.state.apply(await this.api.update(this.state.groupId() as string, this.patch()));
        } catch (error) {
          return this.reject(error);
        }
        this.generalForm().reset();
        this.toast.success(this.i18n.t('GROUP_SETTINGS.SAVED'));
        return undefined;
      },
      onInvalid: () => focusFirstError(this.generalForm),
    });
  }

  private reject(error: unknown): TreeValidationResult {
    if (hasFieldDetails(error)) {
      const f = this.generalForm;
      const fields: Record<string, ReadonlyFieldTree<unknown>> = {
        name: f.name,
        description: f.description,
        languages: f.languages,
        openingTime: f.openingTime,
        compressProductsCategories: f.compressProductsCategories,
        timeSlots: f.timeSlots,
        demo: f.demo,
      };
      const mapped = serverFieldErrors(this.i18n, renameFields(error, generalFieldOf), fields);
      if (mapped.unmatched) {
        this.failure.set(failureMessage(this.i18n, error));
      }
      return mapped.errors;
    }
    this.conflict.set(isGroupConflict(error));
    this.failure.set(groupFailureMessage(this.i18n, error));
    return undefined;
  }
}
