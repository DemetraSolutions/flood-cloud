import { Component, computed, inject, linkedSignal, signal } from '@angular/core';
import {
  disabled,
  form,
  FormField,
  ReadonlyFieldTree,
  submit,
  TreeValidationResult,
} from '@angular/forms/signals';
import { FEATURE_NAMES, FeatureFlags, featureTextKey } from '../../core/groups/feature-catalog';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import {
  failureMessage,
  fieldErrorMessage,
  serverFieldErrors,
} from '../../shared/forms/form-errors';
import { Button } from '../../shared/ui/button/button';
import { Checkbox } from '../../shared/ui/checkbox/checkbox';
import { FormError } from '../../shared/ui/form-error/form-error';
import { ToastService } from '../../shared/ui/toast/toast.service';
import {
  groupFailureMessage,
  hasFieldDetails,
  isGroupConflict,
  renameFields,
} from './group-errors';
import { GroupSettingsState } from './group-settings-state';
import { GroupPatch } from './group.types';
import { GroupsApi } from './groups-api';

/**
 * Features section of the group record: a switch for each feature of the catalog with what it
 * enables. Only platform administrators and dealers can change them (decision D-13); for the
 * others the switches are read-only. After a save the features of the context are read again, so
 * the menu and the guards follow at once.
 */
@Component({
  selector: 'fc-group-features-page',
  imports: [Button, Checkbox, FormError, FormField, TPipe],
  templateUrl: './group-features-page.html',
  styleUrl: './group-form.css',
})
export class GroupFeaturesPage {
  private readonly api = inject(GroupsApi);
  private readonly toast = inject(ToastService);
  protected readonly state = inject(GroupSettingsState);
  protected readonly i18n = inject(I18nService);

  protected readonly names = FEATURE_NAMES;
  protected readonly label = (name: (typeof FEATURE_NAMES)[number]): string =>
    this.i18n.t(featureTextKey(name, 'LABEL'));
  protected readonly description = (name: (typeof FEATURE_NAMES)[number]): string =>
    this.i18n.t(featureTextKey(name, 'DESCRIPTION'));

  private readonly draft = linkedSignal<FeatureFlags>(() => ({
    ...(this.state.group()?.features ?? ({} as FeatureFlags)),
  }));
  protected readonly featuresForm = form(this.draft, (path) => {
    disabled(path, () => !this.state.canManage());
  });

  protected readonly patch = computed<GroupPatch>(() => {
    const stored = this.state.group()?.features;
    const changed = FEATURE_NAMES.filter((name) => this.draft()[name] !== stored?.[name]);
    return changed.length === 0
      ? {}
      : { features: Object.fromEntries(changed.map((name) => [name, this.draft()[name]])) };
  });
  protected readonly hasChanges = computed(() => Object.keys(this.patch()).length > 0);
  protected readonly failure = signal<string | null>(null);
  protected readonly conflict = signal(false);
  protected readonly submitting = computed(() => this.featuresForm().submitting());

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
    await submit(this.featuresForm, {
      action: async () => {
        this.failure.set(null);
        this.conflict.set(false);
        try {
          this.state.apply(await this.api.update(this.state.groupId() as string, this.patch()));
        } catch (error) {
          return this.reject(error);
        }
        this.featuresForm().reset();
        this.toast.success(this.i18n.t('GROUP_SETTINGS.SAVED'));
        return undefined;
      },
    });
  }

  private reject(error: unknown): TreeValidationResult {
    if (hasFieldDetails(error)) {
      const fields = Object.fromEntries(
        FEATURE_NAMES.map((name) => [name, this.featuresForm[name]]),
      ) as Record<string, ReadonlyFieldTree<unknown>>;
      const mapped = serverFieldErrors(
        this.i18n,
        renameFields(error, (field) => field.replace(/^features\./, '')),
        fields,
      );
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
