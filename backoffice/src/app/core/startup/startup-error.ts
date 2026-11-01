import { Component, computed, inject } from '@angular/core';
import { I18nService } from '../i18n/i18n.service';
import { PageReloader } from './page-reloader';

/**
 * Hard-wired texts, used ONLY when the dictionary could not be loaded: in that case the
 * translation service has nothing to translate with, yet the user must still be told why the
 * application did not start. Every other text of the application comes from the dictionary.
 */
export const STARTUP_ERROR_FALLBACK = {
  title: 'Impossibile avviare l’applicazione',
  message: 'Non è stato possibile caricare la configurazione. Riprova tra qualche istante.',
  retry: 'Riprova',
} as const;

/** Page shown instead of the application when startup fails. */
@Component({
  selector: 'fc-startup-error',
  templateUrl: './startup-error.html',
})
export class StartupError {
  private readonly i18n = inject(I18nService);
  private readonly reloader = inject(PageReloader);

  protected readonly title = computed(() =>
    this.i18n.ready() ? this.i18n.t('STARTUP.ERROR.TITLE') : STARTUP_ERROR_FALLBACK.title,
  );
  protected readonly message = computed(() =>
    this.i18n.ready() ? this.i18n.t('STARTUP.ERROR.MESSAGE') : STARTUP_ERROR_FALLBACK.message,
  );
  protected readonly retry = computed(() =>
    this.i18n.ready() ? this.i18n.t('COMMON.RETRY') : STARTUP_ERROR_FALLBACK.retry,
  );

  protected reload(): void {
    this.reloader.reload();
  }
}
