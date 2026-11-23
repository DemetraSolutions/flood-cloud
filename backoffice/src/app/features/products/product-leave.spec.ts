import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot, RouterStateSnapshot } from '@angular/router';
import { leaveProduct } from './product-leave';
import type { ProductPage } from './product-page';

describe('leaveProduct', () => {
  it.each([true, false])('answers what the page answers (%s)', (answer) => {
    const page = { confirmLeave: vi.fn().mockReturnValue(answer) } as unknown as ProductPage;
    const result = TestBed.runInInjectionContext(() =>
      leaveProduct(page, {} as ActivatedRouteSnapshot, {} as RouterStateSnapshot, {} as RouterStateSnapshot),
    );
    expect(result).toBe(answer);
    expect(page.confirmLeave).toHaveBeenCalledOnce();
  });
});
