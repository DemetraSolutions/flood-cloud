import { CanDeactivateFn } from '@angular/router';
import type { FidelityCardPage } from './fidelity-card-page';

/** Route guard of the page of a card: leaving with unsaved changes asks the user to confirm (the page owns the dialog). */
export const leaveFidelityCard: CanDeactivateFn<FidelityCardPage> = (page) => page.confirmLeave();
