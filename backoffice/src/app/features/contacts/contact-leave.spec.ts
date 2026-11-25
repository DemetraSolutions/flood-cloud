import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot, RouterStateSnapshot } from '@angular/router';
import type { ContactPage } from './contact-page';
import { leaveContact } from './contact-leave';

describe('leaveContact', () => {
  it.each([true, false])('answers what the page answers (%s)', (answer) => {
    const page = { confirmLeave: vi.fn().mockReturnValue(answer) } as unknown as ContactPage;
    const result = TestBed.runInInjectionContext(() =>
      leaveContact(
        page,
        {} as ActivatedRouteSnapshot,
        {} as RouterStateSnapshot,
        {} as RouterStateSnapshot,
      ),
    );
    expect(result).toBe(answer);
    expect(page.confirmLeave).toHaveBeenCalledOnce();
  });
});
