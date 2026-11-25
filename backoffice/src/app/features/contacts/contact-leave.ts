import { CanDeactivateFn } from '@angular/router';
import type { ContactPage } from './contact-page';

/** Route guard of the page of a contact: leaving with unsaved changes asks the user to confirm (the page owns the dialog). */
export const leaveContact: CanDeactivateFn<ContactPage> = (page) => page.confirmLeave();
