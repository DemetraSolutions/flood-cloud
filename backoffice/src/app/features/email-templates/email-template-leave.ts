import { CanDeactivateFn } from '@angular/router';
import type { EmailTemplatePage } from './email-template-page';

/** Route guard of the template pages: leaving with unsaved changes asks the user to confirm (the page owns the dialog). */
export const leaveEmailTemplate: CanDeactivateFn<EmailTemplatePage> = (page) =>
  page.confirmLeave();
