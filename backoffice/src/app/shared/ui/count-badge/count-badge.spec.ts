import { TestBed } from '@angular/core/testing';
import { CountBadge } from './count-badge';

describe('CountBadge', () => {
  it('shows the number to the eyes and the label to screen readers', async () => {
    const fixture = TestBed.createComponent(CountBadge);
    fixture.componentRef.setInput('text', '99+');
    fixture.componentRef.setInput('label', '99+ nuove segnalazioni');
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const count = root.querySelector('.count')!;
    expect(count.textContent).toBe('99+');
    expect(count.getAttribute('aria-hidden')).toBe('true');
    expect(root.querySelector('.visually-hidden')?.textContent).toBe('99+ nuove segnalazioni');
  });
});
