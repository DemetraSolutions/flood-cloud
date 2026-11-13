import { CanDeactivateFn } from '@angular/router';
import type { CompanyPage } from './company-page';

/**
 * Route guard of the company pages: leaving with unsaved changes asks the user to confirm
 * (the page owns the dialog); moving between the tabs never reaches it.
 */
export const leaveCompany: CanDeactivateFn<CompanyPage> = (page) => page.confirmLeave();
