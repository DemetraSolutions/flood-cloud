import { Component, computed, inject, input, output, signal } from '@angular/core';
import {
  form,
  FormField,
  pattern,
  required,
  submit,
  TreeValidationResult,
} from '@angular/forms/signals';
import { ApiError } from '../../core/api/api-error';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { SessionService } from '../../core/session/session.service';
import {
  fieldErrorMessage,
  focusFirstError,
  SERVER_ERROR_KIND,
} from '../../shared/forms/form-errors';
import { Button } from '../../shared/ui/button/button';
import { TextField } from '../../shared/ui/text-field/text-field';
import { IdempotencyKey } from '../../shared/util/idempotency';
import { integrationFailure, outcomeUnknown } from './integration-errors';
import { IntegrationsApi } from './integrations-api';
import { IntegrationsStatus } from './integrations-status';

/** The field of the body (and of a `422`) that holds the code. */
const CODE_FIELD = 'activationCode';

/**
 * Activation of Satispay for a place: the user types the one-time code generated in the Satispay
 * app and the backend exchanges it for the key of the shop, which it keeps; the code is never
 * kept, here or there. Only platform administrators and dealers see it, and only when Satispay is
 * configured on the platform. One attempt has one `Idempotency-Key`, reused when the user
 * repeats the same code after a failure whose outcome is unknown (network, server error), so a
 * code that was already spent is never spent twice. The page learns the new version of the place
 * with `activated` (`null` when the place changed meanwhile and must be read again) and that it
 * is stale with `stale`.
 */
@Component({
  selector: 'fc-satispay-activation',
  imports: [Button, FormField, TextField, TPipe],
  templateUrl: './satispay-activation.html',
  styleUrl: './integration-action.css',
})
export class SatispayActivation {
  private readonly status = inject(IntegrationsStatus);
  private readonly session = inject(SessionService);
  private readonly api = inject(IntegrationsApi);
  private readonly i18n = inject(I18nService);
  private readonly key = new IdempotencyKey();

  /** Group of the place. */
  readonly groupId = input.required<string>();
  /** The place; `undefined` while it is not created yet. */
  readonly placeId = input.required<string | undefined>();
  /** Version of the place the page is editing. */
  readonly etag = input.required<string | null>();
  /** Why the action cannot run now (unsaved changes); `null` when it can. */
  readonly blockedBy = input<string | null>(null);
  /** Emitted when the key was set: the new version of the place, `null` when it must be read again. */
  readonly activated = output<string | null>();
  /** Emitted when the place changed meanwhile (`412`). */
  readonly stale = output<void>();

  protected readonly model = signal({ activationCode: '' });
  protected readonly codeForm = form(this.model, (path) => {
    required(path.activationCode);
    pattern(path.activationCode, /^[A-Za-z0-9]{1,32}$/);
  });
  /** A code has no spaces: a pasted one loses them. */
  protected readonly withoutSpaces = (text: string): string => text.replace(/\s/g, '');
  protected readonly failure = signal<string | null>(null);
  protected readonly submitting = computed(() => this.codeForm().submitting());

  protected readonly visible = computed(() => {
    const role = this.session.me()?.role;
    return (
      this.placeId() !== undefined &&
      (role === 'PSA' || role === 'D') &&
      this.status.available('satispay')
    );
  });

  constructor() {
    this.status.need();
  }

  protected codeError(): string | null {
    return fieldErrorMessage(this.i18n, this.codeForm.activationCode());
  }

  protected async activate(): Promise<void> {
    if (this.blockedBy() !== null) {
      return;
    }
    await submit(this.codeForm, {
      action: () => this.send(),
      onInvalid: () => focusFirstError(this.codeForm),
    });
  }

  private async send(): Promise<TreeValidationResult> {
    this.failure.set(null);
    const code = this.model().activationCode.trim();
    try {
      const result = await this.api.activateSatispay(
        this.groupId(),
        this.placeId() as string,
        code,
        this.key.forBody({ code }),
        this.etag(),
      );
      this.key.reset();
      this.model.set({ activationCode: '' });
      this.codeForm().reset();
      this.activated.emit(result.etag);
      return undefined;
    } catch (error) {
      return this.reject(error);
    }
  }

  private reject(error: unknown): TreeValidationResult {
    if (!outcomeUnknown(error)) {
      this.key.reset();
    }
    const failure = integrationFailure(this.i18n, error, CODE_FIELD);
    if (failure.stale) {
      this.stale.emit();
    }
    if (error instanceof ApiError && error.details.some((detail) => detail.field === CODE_FIELD)) {
      return [
        { kind: SERVER_ERROR_KIND, fieldTree: this.codeForm.activationCode, message: failure.message },
      ];
    }
    this.failure.set(failure.message);
    return undefined;
  }
}
