import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Checkbox } from './checkbox';

@Component({
  imports: [Checkbox],
  template: `<fc-checkbox
    label="Accetto"
    [hint]="hint()"
    [error]="error()"
    [disabled]="disabled()"
    required
    [(checked)]="checked"
    (blurred)="blurs.set(blurs() + 1)"
  />`,
})
class Host {
  readonly checked = signal(false);
  readonly hint = signal<string | null>(null);
  readonly error = signal<string | null>(null);
  readonly disabled = signal(false);
  readonly blurs = signal(0);
}

async function render() {
  const fixture = TestBed.createComponent(Host);
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  return { fixture, host: fixture.componentInstance, root, box: root.querySelector('input')! };
}

describe('Checkbox', () => {
  it('is a native checkbox with a visible, linked label', async () => {
    const { root, box } = await render();
    expect(box.type).toBe('checkbox');
    expect(root.querySelector('label')!.htmlFor).toBe(box.id);
    expect(box.required).toBe(true);
    expect(box.checked).toBe(false);
  });

  it('updates the model and emits blurred', async () => {
    const { fixture, host, box } = await render();
    box.click();
    box.dispatchEvent(new Event('blur'));
    await fixture.whenStable();
    expect(host.checked()).toBe(true);
    expect(host.blurs()).toBe(1);
  });

  it('describes the checkbox with hint and error and can be disabled', async () => {
    const { fixture, host, root, box } = await render();
    expect(box.hasAttribute('aria-describedby')).toBe(false);
    host.hint.set('Aiuto');
    host.error.set('Devi accettare');
    host.disabled.set(true);
    await fixture.whenStable();
    expect(box.getAttribute('aria-describedby')).toBe(
      `${root.querySelector('.hint')!.id} ${root.querySelector('.error')!.id}`,
    );
    expect(box.getAttribute('aria-invalid')).toBe('true');
    expect(box.disabled).toBe(true);
  });
});
