import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Button, ButtonVariant } from './button';

@Component({
  imports: [Button],
  template: `<button
      fc-button
      [variant]="variant()"
      [loading]="loading()"
      (click)="clicks.set(clicks() + 1)"
    >
      Salva
    </button>
    <button fc-button disabled type="submit">Invia</button>`,
})
class Host {
  readonly variant = signal<ButtonVariant>('primary');
  readonly loading = signal(false);
  readonly clicks = signal(0);
}

async function render() {
  const fixture = TestBed.createComponent(Host);
  await fixture.whenStable();
  const buttons = (fixture.nativeElement as HTMLElement).querySelectorAll('button');
  return { fixture, save: buttons[0], send: buttons[1] };
}

describe('Button', () => {
  it('is a native button of type button by default and honours the type input', async () => {
    const { save, send } = await render();
    expect(save.getAttribute('type')).toBe('button');
    expect(send.getAttribute('type')).toBe('submit');
    expect(send.disabled).toBe(true);
  });

  it('exposes the variant and is clickable', async () => {
    const { fixture, save } = await render();
    expect(save.getAttribute('data-variant')).toBe('primary');
    fixture.componentInstance.variant.set('danger');
    await fixture.whenStable();
    expect(save.getAttribute('data-variant')).toBe('danger');
    save.click();
    expect(fixture.componentInstance.clicks()).toBe(1);
  });

  it('while loading is disabled, busy and shows a hidden spinner', async () => {
    const { fixture, save } = await render();
    expect(save.hasAttribute('aria-busy')).toBe(false);
    expect(save.querySelector('.spinner')).toBeNull();
    fixture.componentInstance.loading.set(true);
    await fixture.whenStable();
    expect(save.getAttribute('aria-busy')).toBe('true');
    expect(save.disabled).toBe(true);
    expect(save.querySelector('.spinner')?.getAttribute('aria-hidden')).toBe('true');
  });
});
