import { Component, computed, inject, linkedSignal, signal } from '@angular/core';
import {
  disabled,
  form,
  FormField,
  ReadonlyFieldTree,
  submit,
  TreeValidationResult,
} from '@angular/forms/signals';
import { issueMessageKey } from '../../core/api/field-issues';
import { ApiError } from '../../core/api/api-error';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import {
  failureMessage,
  fieldErrorMessage,
  serverFieldErrors,
} from '../../shared/forms/form-errors';
import { Button } from '../../shared/ui/button/button';
import { Checkbox } from '../../shared/ui/checkbox/checkbox';
import { ConfirmDialog } from '../../shared/ui/confirm-dialog/confirm-dialog';
import { Dialog } from '../../shared/ui/dialog/dialog';
import { FormError } from '../../shared/ui/form-error/form-error';
import { StatusBadge } from '../../shared/ui/status-badge/status-badge';
import { TextField } from '../../shared/ui/text-field/text-field';
import { ToastService } from '../../shared/ui/toast/toast.service';
import {
  groupFailureMessage,
  hasFieldDetails,
  isGroupConflict,
  renameFields,
} from './group-errors';
import { GroupSettingsState } from './group-settings-state';
import {
  API_KEY_CHARACTERS,
  API_KEY_MAX,
  API_KEY_MIN,
  GroupPatch,
  INTEGRATION_PROVIDERS,
  IntegrationProvider,
} from './group.types';
import { GroupsApi } from './groups-api';

/**
 * Integrations section of the group record: for each provider the switch and the state of its
 * key. A key is only ever set or removed, never shown: the dialog that sets it takes a password
 * field, the typed value is cleared as soon as the dialog closes and it is never logged.
 * Platform administrators and dealers can change integrations; the others see them read-only.
 */
@Component({
  selector: 'fc-group-integrations',
  imports: [
    Button,
    Checkbox,
    ConfirmDialog,
    Dialog,
    FormError,
    FormField,
    StatusBadge,
    TextField,
    TPipe,
  ],
  templateUrl: './group-integrations.html',
  styleUrls: ['./group-form.css', './group-integrations.css'],
})
export class GroupIntegrations {
  private readonly api = inject(GroupsApi);
  private readonly toast = inject(ToastService);
  protected readonly state = inject(GroupSettingsState);
  protected readonly i18n = inject(I18nService);

  protected readonly providers = INTEGRATION_PROVIDERS;
  protected readonly apiKeyMin = API_KEY_MIN;
  protected readonly apiKeyMax = API_KEY_MAX;

  protected readonly label = (provider: IntegrationProvider): string =>
    this.i18n.t(`INTEGRATION.${provider.toUpperCase()}`);
  protected readonly keySet = (provider: IntegrationProvider): boolean =>
    this.state.group()?.integrations[provider].apiKeySet ?? false;
  protected readonly actionLabel = (key: string, provider: IntegrationProvider): string =>
    this.i18n.t(key, { provider: this.label(provider) });

  private readonly draft = linkedSignal<Record<IntegrationProvider, boolean>>(
    () =>
      Object.fromEntries(
        INTEGRATION_PROVIDERS.map((provider) => [
          provider,
          this.state.group()?.integrations[provider].enabled ?? false,
        ]),
      ) as Record<IntegrationProvider, boolean>,
  );
  protected readonly integrationsForm = form(this.draft, (path) => {
    disabled(path, () => !this.state.canManage());
  });

  protected readonly patch = computed<GroupPatch>(() => {
    const stored = this.state.group()?.integrations;
    const changed = INTEGRATION_PROVIDERS.filter(
      (provider) => this.draft()[provider] !== stored?.[provider].enabled,
    );
    return changed.length === 0
      ? {}
      : {
          integrations: Object.fromEntries(
            changed.map((provider) => [provider, { enabled: this.draft()[provider] }]),
          ),
        };
  });
  protected readonly hasChanges = computed(() => Object.keys(this.patch()).length > 0);
  protected readonly failure = signal<string | null>(null);
  protected readonly conflict = signal(false);
  protected readonly submitting = computed(() => this.integrationsForm().submitting());

  // Dialog that sets a key and confirmation that removes one.
  protected readonly keyProvider = signal<IntegrationProvider | null>(null);
  protected readonly keyOpen = signal(false);
  protected readonly keyValue = signal('');
  protected readonly keyIssue = signal<string | null>(null);
  protected readonly removeProvider = signal<IntegrationProvider | null>(null);
  protected readonly removeOpen = signal(false);
  protected readonly busy = signal(false);

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
    await submit(this.integrationsForm, {
      action: async () => {
        this.failure.set(null);
        this.conflict.set(false);
        try {
          this.state.apply(await this.api.update(this.state.groupId() as string, this.patch()));
        } catch (error) {
          return this.reject(error);
        }
        this.integrationsForm().reset();
        this.toast.success(this.i18n.t('GROUP_SETTINGS.SAVED'));
        return undefined;
      },
    });
  }

  private reject(error: unknown): TreeValidationResult {
    if (hasFieldDetails(error)) {
      const fields = Object.fromEntries(
        INTEGRATION_PROVIDERS.map((provider) => [provider, this.integrationsForm[provider]]),
      ) as Record<string, ReadonlyFieldTree<unknown>>;
      const mapped = serverFieldErrors(
        this.i18n,
        renameFields(error, (field) => field.replace(/^integrations\./, '').split('.')[0]),
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

  /** Opens the dialog that sets (or replaces) the key of a provider. */
  protected openKey(provider: IntegrationProvider): void {
    this.keyProvider.set(provider);
    this.keyValue.set('');
    this.keyIssue.set(null);
    this.keyOpen.set(true);
  }

  /** The typed key is forgotten as soon as the dialog goes away, however it was closed. */
  protected closeKey(): void {
    this.keyValue.set('');
    this.keyOpen.set(false);
  }

  protected onKey(value: string): void {
    this.keyValue.set(value);
    this.keyIssue.set(null);
  }

  private keyProblem(key: string): string | null {
    if (key.length < API_KEY_MIN) {
      return 'FORM.ISSUE.MIN_LENGTH';
    }
    if (key.length > API_KEY_MAX) {
      return 'FORM.ISSUE.MAX_LENGTH';
    }
    return API_KEY_CHARACTERS.test(key) ? null : 'FORM.ISSUE.PATTERN';
  }

  protected async submitKey(event: Event): Promise<void> {
    event.preventDefault();
    const problem = this.keyProblem(this.keyValue());
    if (problem !== null) {
      this.keyIssue.set(this.i18n.t(problem));
      return;
    }
    const provider = this.keyProvider() as IntegrationProvider;
    this.busy.set(true);
    try {
      this.state.apply(
        await this.api.update(this.state.groupId() as string, {
          integrations: { [provider]: { apiKey: this.keyValue() } },
        }),
      );
    } catch (error) {
      this.busy.set(false);
      this.failKey(error);
      return;
    }
    this.busy.set(false);
    this.closeKey();
    this.toast.success(this.actionLabel('GROUP_SETTINGS.INTEGRATIONS.KEY_SAVED', provider));
  }

  private failKey(error: unknown): void {
    const detail =
      error instanceof ApiError ? error.details.find((d) => d.field.endsWith('apiKey')) : undefined;
    if (detail !== undefined) {
      this.keyIssue.set(this.i18n.t(issueMessageKey(detail.issue)));
      return;
    }
    this.closeKey();
    this.toast.error(groupFailureMessage(this.i18n, error));
  }

  /** Opens the confirmation that removes the key of a provider. */
  protected askRemove(provider: IntegrationProvider): void {
    this.removeProvider.set(provider);
    this.removeOpen.set(true);
  }

  protected async confirmRemove(): Promise<void> {
    const provider = this.removeProvider() as IntegrationProvider;
    this.busy.set(true);
    try {
      this.state.apply(
        await this.api.update(this.state.groupId() as string, {
          integrations: { [provider]: { apiKey: null } },
        }),
      );
      this.toast.success(this.actionLabel('GROUP_SETTINGS.INTEGRATIONS.KEY_REMOVED', provider));
    } catch (error) {
      this.toast.error(groupFailureMessage(this.i18n, error));
    }
    this.busy.set(false);
    this.removeOpen.set(false);
  }
}
