import { inject } from '@angular/core';
import { AppConfig } from '../config/app-config';
import { I18nService } from '../i18n/i18n.service';
import { SessionService } from '../session/session.service';
import { StartupState } from './startup-state';

/**
 * Application initializer: loads the dictionary and the public configuration in parallel, then
 * restores the session from the refresh token kept in `sessionStorage` (a refused token only means
 * "anonymous"; a transient failure shows the startup error page with a retry). A configuration or dictionary failure is logged and recorded in
 * {@link StartupState} so the application shows the startup error page instead of starting; it
 * is never swallowed.
 */
export async function initializeApp(): Promise<void> {
  const i18n = inject(I18nService);
  const config = inject(AppConfig);
  const startup = inject(StartupState);
  const session = inject(SessionService);
  const results = await Promise.allSettled([i18n.initialize(), config.load()]);
  for (const result of results) {
    if (result.status === 'rejected') {
      console.error('Application startup failed', result.reason);
      startup.fail();
    }
  }
  if (!startup.failed()) {
    try {
      await session.restore();
    } catch (error) {
      console.error('Session restore failed', error);
      startup.fail();
    }
  }
}
