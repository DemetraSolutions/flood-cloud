import { CanDeactivateFn } from '@angular/router';
import type { CatalogItemPage } from './catalog-item-page';

/** Route guard of the pages of a department or brand: leaving with unsaved changes asks the user to confirm (the page owns the dialog). */
export const leaveCatalogItem: CanDeactivateFn<CatalogItemPage> = (page) => page.confirmLeave();
