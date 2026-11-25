import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot, RouterStateSnapshot } from '@angular/router';
import type { ContactGroupPage } from './contact-group-page';
import { leaveContactGroup } from './contact-group-leave';

describe('leaveContactGroup', () => {
  it.each([true, false])('answers what the page answers (%s)', (answer) => {
    const page = { confirmLeave: vi.fn().mockReturnValue(answer) } as unknown as ContactGroupPage;
    const result = TestBed.runInInjectionContext(() =>
      leaveContactGroup(
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
