import { ErrorHandler, inject, Service } from '@angular/core';
import { I18nService } from '../i18n/i18n.service';
import { ToastService } from '../../shared/ui/toast/toast.service';

/**
 * Application-wide error handler: logs the error to the console (nothing is swallowed) and tells
 * the user with a generic toast, without exposing technical details.
 */
@Service()
export class GlobalErrorHandler implements ErrorHandler {
  private readonly toast = inject(ToastService);
  private readonly i18n = inject(I18nService);

  handleError(error: unknown): void {
    console.error(error);
    this.toast.error(this.i18n.t('ERRORS.GENERIC.MESSAGE'));
  }
}
