import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot, RouterStateSnapshot } from '@angular/router';
import type { CatalogItemPage } from './catalog-item-page';
import { leaveCatalogItem } from './catalog-item-leave';

describe('leaveCatalogItem', () => {
  it.each([true, false])('answers what the page answers (%s)', (answer) => {
    const page = { confirmLeave: vi.fn().mockReturnValue(answer) } as unknown as CatalogItemPage;
    const result = TestBed.runInInjectionContext(() =>
      leaveCatalogItem(page, {} as ActivatedRouteSnapshot, {} as RouterStateSnapshot, {} as RouterStateSnapshot),
    );
    expect(result).toBe(answer);
    expect(page.confirmLeave).toHaveBeenCalledOnce();
  });
});
