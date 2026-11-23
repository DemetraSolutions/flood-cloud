import { CanDeactivateFn } from '@angular/router';
import type { ProductPage } from './product-page';

/** Route guard of the pages of a product: leaving with unsaved changes asks the user to confirm (the page owns the dialog). */
export const leaveProduct: CanDeactivateFn<ProductPage> = (page) => page.confirmLeave();
