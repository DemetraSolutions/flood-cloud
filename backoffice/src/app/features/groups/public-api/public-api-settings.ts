import { Component, computed, inject, linkedSignal, signal } from '@angular/core';
import {
  disabled,
  form,
  FormField,
  ReadonlyFieldTree,
  submit,
  TreeValidationResult,
  validate,
} from '@angular/forms/signals';
import { ApiError } from '../../../core/api/api-error';
import { I18nService } from '../../../core/i18n/i18n.service';
import { TPipe } from '../../../core/i18n/t-pipe';
import {
  failureMessage,
  fieldErrorMessage,
  focusFirstError,
  serverFieldErrors,
} from '../../../shared/forms/form-errors';
import { Button } from '../../../shared/ui/button/button';
import { Checkbox } from '../../../shared/ui/checkbox/checkbox';
import { FormError } from '../../../shared/ui/form-error/form-error';
import { Icon } from '../../../shared/ui/icon/icon';
import { TextField } from '../../../shared/ui/text-field/text-field';
import { ToastService } from '../../../shared/ui/toast/toast.service';
import { numberIssue } from '../catalogs/catalog-fields';
import {
  groupFailureMessage,
  hasFieldDetails,
  isGroupConflict,
  renameFields,
} from '../group-errors';
import { GroupSettingsState } from '../group-settings-state';
import { GroupPatch } from '../group.types';
import { GroupsApi } from '../groups-api';
import { MAX_PER_DAY, MAX_PER_MINUTE, PLATFORM_DEFAULTS, PublicApiSettings } from './api-key.types';

type NumberName = Exclude<keyof PublicApiSettings, 'enabled'>;

/** The numeric settings, with the highest value each takes. */
const NUMBERS: readonly { name: NumberName; max: number }[] = [
  { name: 'defaultRateLimitPerMinute', max: MAX_PER_MINUTE },
  { name: 'defaultDailyQuota', max: MAX_PER_DAY },
  { name: 'groupRateLimitPerMinute', max: MAX_PER_MINUTE },
  { name: 'groupDailyQuota', max: MAX_PER_DAY },
];

/**
 * Public API settings of the group (a block of the "API pubbliche" tab): the switch that makes the
 * keys of the group work, the limits new keys inherit and the cap of all the keys together.
 * Only the platform administrator changes them; a dealer reads them. A group that never set them
 * shows the platform defaults. It is saved with the same group update, and the same errors, as
 * the other tabs of the record.
 */
@Component({
  selector: 'fc-public-api-settings',
  imports: [Button, Checkbox, FormError, FormField, Icon, TextField, TPipe],
  templateUrl: './public-api-settings.html',
  styleUrl: '../group-form.css',
})
export class PublicApiSettingsBlock {
  private readonly api = inject(GroupsApi);
  private readonly toast = inject(ToastService);
  protected readonly state = inject(GroupSettingsState);
  protected readonly i18n = inject(I18nService);

  /** The settings in effect: the group's own, or the platform defaults. */
  protected readonly stored = computed<PublicApiSettings>(
    () => this.state.group()?.publicApi ?? PLATFORM_DEFAULTS,
  );
  protected readonly enabled = computed(() => this.stored().enabled);

  private readonly draft = linkedSignal(() => {
    const stored = this.stored();
    return {
      enabled: stored.enabled,
      defaultRateLimitPerMinute: String(stored.defaultRateLimitPerMinute),
      defaultDailyQuota: String(stored.defaultDailyQuota),
      groupRateLimitPerMinute: String(stored.groupRateLimitPerMinute),
      groupDailyQuota: String(stored.groupDailyQuota),
    };
  });
  protected readonly settingsForm = form(this.draft, (path) => {
    disabled(path, () => !this.state.canPublicApi());
    for (const { name, max } of NUMBERS) {
      validate(path[name], ({ value }) => {
        const kind = numberIssue(value(), { min: 1, max, integer: true });
        return kind === undefined ? undefined : { kind };
      });
    }
  });

  protected readonly patch = computed<GroupPatch>(() => {
    const stored = this.stored();
    const draft = this.draft();
    const changed: { -readonly [K in keyof PublicApiSettings]?: PublicApiSettings[K] } = {};
    if (draft.enabled !== stored.enabled) {
      changed.enabled = draft.enabled;
    }
    for (const { name } of NUMBERS) {
      if (Number(draft[name]) !== stored[name]) {
        changed[name] = Number(draft[name]);
      }
    }
    return Object.keys(changed).length === 0 ? {} : { publicApi: changed };
  });
  protected readonly hasChanges = computed(() => Object.keys(this.patch()).length > 0);
  protected readonly failure = signal<string | null>(null);
  protected readonly conflict = signal(false);
  protected readonly submitting = computed(() => this.settingsForm().submitting());

  protected error(field: ReadonlyFieldTree<unknown>): string | null {
    return fieldErrorMessage(this.i18n, field());
  }

  protected reload(): void {
    this.conflict.set(false);
    this.failure.set(null);
    this.state.reload();
  }

  protected async onSubmit(event: Event): Promise<void> {
    event.preventDefault();
    await submit(this.settingsForm, {
      action: async () => {
        this.failure.set(null);
        this.conflict.set(false);
        try {
          this.state.apply(await this.api.update(this.state.groupId() as string, this.patch()));
        } catch (error) {
          return this.reject(error);
        }
        this.settingsForm().reset();
        this.toast.success(this.i18n.t('GROUP_SETTINGS.SAVED'));
        return undefined;
      },
      onInvalid: () => focusFirstError(this.settingsForm),
    });
  }

  /** A `412` (the group changed since it was read) is shown like the `409` of the other tabs. */
  private reject(error: unknown): TreeValidationResult {
    if (hasFieldDetails(error)) {
      const fields: Record<string, ReadonlyFieldTree<unknown>> = {
        enabled: this.settingsForm.enabled,
        ...Object.fromEntries(NUMBERS.map(({ name }) => [name, this.settingsForm[name]])),
      };
      const mapped = serverFieldErrors(
        this.i18n,
        renameFields(error, (field) => field.replace(/^publicApi\./, '')),
        fields,
      );
      if (mapped.unmatched) {
        this.failure.set(failureMessage(this.i18n, error));
      }
      return mapped.errors;
    }
    this.conflict.set(isGroupConflict(error) || isPreconditionFailed(error));
    this.failure.set(
      isPreconditionFailed(error)
        ? this.i18n.t('GROUP_SETTINGS.ERROR.CONFLICT')
        : groupFailureMessage(this.i18n, error),
    );
    return undefined;
  }
}

function isPreconditionFailed(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'PRECONDITION_FAILED';
}
