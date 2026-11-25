import { Component, computed, inject, input, model, output, signal } from '@angular/core';
import { ApiError } from '../../core/api/api-error';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { failureMessage } from '../../shared/forms/form-errors';
import { Button } from '../../shared/ui/button/button';
import { IntegrationsApi } from './integrations-api';
import { IntegrationsStatus } from './integrations-status';
import { VatLookup } from './integrations.types';

/** What the lookup shows under the field: a confirmation or a failure. */
interface Notice {
  readonly kind: 'done' | 'error';
  readonly text: string;
}

/**
 * The VAT number field of a form with its "Cerca P.IVA" button (the registry of companies): the
 * field is projected as content and sits next to the button. The button is an explicit action of
 * the operator, enabled when the page says so (`enabled`) and shown only when the lookup is
 * configured on the platform. The company found is handed to the page (`found`) only when it is
 * still for the VAT number in the form; the page fills its form and tells the user so with
 * {@link filled}. While the request is in flight `busy` is set, so the page can lock the field.
 */
@Component({
  selector: 'fc-vat-lookup',
  imports: [Button, TPipe],
  templateUrl: './vat-lookup-field.html',
  styleUrl: './vat-lookup-field.css',
})
export class VatLookupField {
  private readonly status = inject(IntegrationsStatus);
  private readonly api = inject(IntegrationsApi);
  private readonly i18n = inject(I18nService);

  /** The VAT number as the form holds it now. */
  readonly vatNumber = input.required<string>();
  /** Whether the number can be looked up now (Italy and 11 digits). */
  readonly enabled = input(false);
  /** Whether a request is in flight. */
  readonly busy = model(false);
  /** Emitted with the company found, when it is still the one of the form. */
  readonly found = output<VatLookup>();

  protected readonly notice = signal<Notice | null>(null);
  protected readonly visible = computed(() => this.status.available('cerved'));

  constructor() {
    this.status.need();
  }

  /** Tells the user the form was filled with the company found. */
  filled(): void {
    this.notice.set({ kind: 'done', text: this.i18n.t('INTEGRATIONS.VAT.DONE') });
  }

  protected async lookup(): Promise<void> {
    this.busy.set(true);
    this.notice.set(null);
    const asked = this.vatNumber().trim();
    try {
      const company = await this.api.lookupVat(asked);
      if (company.vatNumber === this.vatNumber().trim()) {
        this.found.emit(company);
      } else {
        this.notice.set({ kind: 'done', text: this.i18n.t('INTEGRATIONS.VAT.STALE') });
      }
    } catch (error) {
      this.notice.set({ kind: 'error', text: this.failure(error) });
    } finally {
      this.busy.set(false);
    }
  }

  private failure(error: unknown): string {
    if (error instanceof ApiError) {
      const key: Record<number, string> = {
        404: 'INTEGRATIONS.VAT.NOT_FOUND',
        422: 'INTEGRATIONS.VAT.INVALID',
        502: 'INTEGRATIONS.PROVIDER_ERROR',
        503: 'INTEGRATIONS.VAT.UNAVAILABLE',
      };
      if (key[error.status] !== undefined) {
        return this.i18n.t(key[error.status]);
      }
      if (error.status === 429) {
        return this.rateLimited(error.retryAfterSeconds);
      }
    }
    return failureMessage(this.i18n, error);
  }

  /** The wait of a `429` in the largest sensible unit: the daily cap can ask for hours. */
  private rateLimited(seconds: number | null): string {
    if (seconds === null) {
      return this.i18n.t('INTEGRATIONS.VAT.RATE_LIMITED');
    }
    if (seconds < 120) {
      return this.i18n.t('INTEGRATIONS.VAT.RATE_LIMITED_WAIT', { seconds });
    }
    if (seconds < 7200) {
      return this.i18n.t('INTEGRATIONS.VAT.RATE_LIMITED_WAIT_MINUTES', {
        minutes: Math.ceil(seconds / 60),
      });
    }
    return this.i18n.t('INTEGRATIONS.VAT.RATE_LIMITED_WAIT_HOURS', {
      hours: Math.ceil(seconds / 3600),
    });
  }
}
