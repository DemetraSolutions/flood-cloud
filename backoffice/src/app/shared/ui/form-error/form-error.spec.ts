import { TestBed } from '@angular/core/testing';
import { FormError } from './form-error';

describe('FormError', () => {
  it('is an alert showing the message that takes the focus when it appears', async () => {
    const fixture = TestBed.createComponent(FormError);
    fixture.componentRef.setInput('message', 'Qualcosa non va');
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.getAttribute('role')).toBe('alert');
    expect(root.textContent).toContain('Qualcosa non va');
    expect(root.querySelector('svg')).not.toBeNull();
    expect(document.activeElement).toBe(root);
  });
});
