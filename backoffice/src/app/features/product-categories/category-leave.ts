import { CanDeactivateFn } from '@angular/router';
import type { CategoryPage } from './category-page';

/** Route guard of the pages of a category: leaving with unsaved changes asks the user to confirm (the page owns the dialog). */
export const leaveCategory: CanDeactivateFn<CategoryPage> = (page) => page.confirmLeave();
