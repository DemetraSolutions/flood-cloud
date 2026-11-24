import { Component, computed, inject, linkedSignal, resource, signal } from '@angular/core';
import { apiErrorMessageKey, ApiError } from '../../core/api/api-error';
import { formatNumber } from '../../core/i18n/format';
import { I18nService } from '../../core/i18n/i18n.service';
import { DEFAULT_LANGUAGE } from '../../core/i18n/language';
import { TPipe } from '../../core/i18n/t-pipe';
import { failureMessage } from '../../shared/forms/form-errors';
import { Button } from '../../shared/ui/button/button';
import { ConfirmDialog } from '../../shared/ui/confirm-dialog/confirm-dialog';
import { ErrorState } from '../../shared/ui/error-state/error-state';
import { FormError } from '../../shared/ui/form-error/form-error';
import { PageHeader } from '../../shared/ui/page-header/page-header';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { apiErrorOf } from '../profile/sessions';
import { SecurityPolicyApi } from './security-policy-api';
import {
  NonBrowserMode,
  PolicySource,
  SecurityPolicyChange,
  SustainedMode,
  VersionedPolicy,
} from './security-policy.types';

/** Dictionary key of the text that says where a value in force comes from. */
export const SOURCE_KEYS: Readonly<Record<PolicySource, string>> = {
  default: 'SECURITY_POLICY.SOURCE.DEFAULT',
  database: 'SECURITY_POLICY.SOURCE.DATABASE',
  forced: 'SECURITY_POLICY.SOURCE.FORCED',
};

/** Whether the server answered that the block cannot be turned on from this browser. */
function isBrowserRequired(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    error.details.some(
      (detail) => detail.field === 'nonBrowserRequests' && detail.issue === 'browserRequired',
    )
  );
}

/**
 * Security policy (`/settings/security`, platform administrators): what happens to calls that do
 * not come from a browser and to users over the hourly and daily limits, each either only
 * reported in the activity log or refused. The thresholds are shown, read only. Turning on a
 * refusal asks for confirmation; going back to "report only" does not. The save sends only the
 * fields that changed, with the version read in `If-Match`.
 */
@Component({
  selector: 'fc-security-policy-page',
  imports: [Button, ConfirmDialog, ErrorState, FormError, PageHeader, TPipe],
  templateUrl: './security-policy-page.html',
  styleUrl: './security-policy-page.css',
})
export class SecurityPolicyPage {
  private readonly api = inject(SecurityPolicyApi);
  private readonly toast = inject(ToastService);
  protected readonly i18n = inject(I18nService);

  private readonly loaded = resource({ loader: () => this.api.read() });
  /** The policy as the server has it, and its version; replaced by every save. */
  private readonly saved = linkedSignal<VersionedPolicy | undefined, VersionedPolicy | null>({
    source: () => (this.loaded.hasValue() ? this.loaded.value() : undefined),
    computation: (value) => value ?? null,
  });
  protected readonly policy = computed(() => this.saved()?.value ?? null);
  /** Whether the server forces report only, whatever is saved. */
  protected readonly forced = computed(() => {
    const sources = this.policy()?.sources;
    return sources?.nonBrowserRequests === 'forced' || sources?.sustainedLimits === 'forced';
  });
  protected readonly loading = computed(() => this.loaded.isLoading());
  protected readonly failed = computed(() => this.loaded.error() !== undefined);
  protected readonly loadError = computed(() => apiErrorOf(this.loaded.error()));
  protected readonly loadErrorMessage = computed(() => {
    const error = this.loadError();
    return this.i18n.t(error === null ? 'ERRORS.GENERIC.MESSAGE' : apiErrorMessageKey(error));
  });

  /** The choices on screen, starting from the saved values. */
  protected readonly nonBrowser = linkedSignal<NonBrowserMode | undefined>(
    () => this.policy()?.nonBrowserRequests,
  );
  protected readonly sustained = linkedSignal<SustainedMode | undefined>(
    () => this.policy()?.sustainedLimits,
  );

  /** What changed against the saved values: only these fields are sent. */
  protected readonly change = computed<SecurityPolicyChange>(() => {
    const policy = this.policy();
    return {
      ...(policy !== null && this.nonBrowser() !== policy.nonBrowserRequests
        ? { nonBrowserRequests: this.nonBrowser() }
        : {}),
      ...(policy !== null && this.sustained() !== policy.sustainedLimits
        ? { sustainedLimits: this.sustained() }
        : {}),
    };
  });
  protected readonly dirty = computed(() => Object.keys(this.change()).length > 0);
  /** Whether the change turns on a refusal (that is what asks for confirmation). */
  private readonly restricts = computed(
    () =>
      this.change().nonBrowserRequests === 'block' || this.change().sustainedLimits === 'enforce',
  );

  protected readonly confirmOpen = signal(false);
  protected readonly saving = signal(false);
  /** Message of a failure of the save. */
  protected readonly failure = signal<string | null>(null);
  /** The version saved is no longer the current one. */
  protected readonly stale = signal(false);

  protected readonly confirmMessage = computed(() =>
    [
      this.change().nonBrowserRequests === 'block'
        ? this.i18n.t('SECURITY_POLICY.CONFIRM.NON_BROWSER')
        : null,
      this.change().sustainedLimits === 'enforce'
        ? this.i18n.t('SECURITY_POLICY.CONFIRM.LIMITS')
        : null,
      this.i18n.t('SECURITY_POLICY.CONFIRM.LOGGED'),
    ]
      .filter((part) => part !== null)
      .join(' '),
  );

  /** A threshold as the user reads it. */
  protected number(value: number): string {
    return formatNumber(value, this.i18n.language() ?? DEFAULT_LANGUAGE);
  }

  protected sourceKey(source: PolicySource): string {
    return SOURCE_KEYS[source];
  }

  protected reload(): void {
    this.failure.set(null);
    this.stale.set(false);
    this.loaded.reload();
  }

  protected async onSubmit(event: Event): Promise<void> {
    event.preventDefault();
    if (!this.dirty() || this.saving()) {
      return;
    }
    if (this.restricts()) {
      this.confirmOpen.set(true);
      return;
    }
    await this.save();
  }

  protected async onConfirmed(): Promise<void> {
    await this.save();
  }

  private async save(): Promise<void> {
    this.saving.set(true);
    this.failure.set(null);
    this.stale.set(false);
    try {
      const result = await this.api.write(this.change(), (this.saved() as VersionedPolicy).etag);
      this.saved.set(result);
      this.toast.success(this.i18n.t('SECURITY_POLICY.SAVED'));
    } catch (error) {
      if (error instanceof ApiError && error.status === 412) {
        this.stale.set(true);
      } else if (isBrowserRequired(error)) {
        this.failure.set(this.i18n.t('SECURITY_POLICY.BROWSER_REQUIRED'));
      } else {
        this.failure.set(failureMessage(this.i18n, error));
      }
    } finally {
      this.saving.set(false);
      this.confirmOpen.set(false);
    }
  }
}
