import { CanDeactivateFn } from '@angular/router';
import type { ContactGroupPage } from './contact-group-page';

/** Route guard of the page of a group of contacts: leaving with unsaved changes asks the user to confirm (the page owns the dialog). */
export const leaveContactGroup: CanDeactivateFn<ContactGroupPage> = (page) => page.confirmLeave();
