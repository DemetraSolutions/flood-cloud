import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot, RouterStateSnapshot } from '@angular/router';
import type { CategoryPage } from './category-page';
import { leaveCategory } from './category-leave';

describe('leaveCategory', () => {
  it.each([true, false])('answers what the page answers (%s)', (answer) => {
    const page = { confirmLeave: vi.fn().mockReturnValue(answer) } as unknown as CategoryPage;
    const result = TestBed.runInInjectionContext(() =>
      leaveCategory(page, {} as ActivatedRouteSnapshot, {} as RouterStateSnapshot, {} as RouterStateSnapshot),
    );
    expect(result).toBe(answer);
    expect(page.confirmLeave).toHaveBeenCalledOnce();
  });
});
