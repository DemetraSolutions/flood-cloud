import { CanDeactivateFn } from '@angular/router';
import type { PlacePage } from './place-page';

/**
 * Route guard of the place pages: leaving with unsaved changes asks the user to confirm
 * (the page owns the dialog); moving between the tabs never reaches it.
 */
export const leavePlace: CanDeactivateFn<PlacePage> = (page) => page.confirmLeave();
