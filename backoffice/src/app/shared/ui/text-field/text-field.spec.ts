import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TextField } from './text-field';

@Component({
  imports: [TextField],
  template: `<fc-text-field
    label="Email"
    type="email"
    [hint]="hint()"
    [error]="error()"
    autocomplete="email"
    required
    [disabled]="disabled()"
    [(value)]="value"
    (blurred)="blurs.set(blurs() + 1)"
  />`,
})
class Host {
  readonly value = signal('a@b.it');
  readonly hint = signal<string | null>(null);
  readonly error = signal<string | null>(null);
  readonly disabled = signal(false);
  readonly blurs = signal(0);
}

async function render() {
  const fixture = TestBed.createComponent(Host);
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  return { fixture, host: fixture.componentInstance, root, input: root.querySelector('input')! };
}

describe('TextField', () => {
  it('links a visible label to the input and passes native attributes', async () => {
    const { root, input } = await render();
    const label = root.querySelector('label')!;
    expect(label.htmlFor).toBe(input.id);
    expect(label.textContent).toBe('Email');
    expect(input.type).toBe('email');
    expect(input.value).toBe('a@b.it');
    expect(input.required).toBe(true);
    expect(input.getAttribute('autocomplete')).toBe('email');
    expect(input.hasAttribute('aria-invalid')).toBe(false);
    expect(input.hasAttribute('aria-describedby')).toBe(false);
  });

  it('updates the model on input and emits blurred', async () => {
    const { fixture, host, input } = await render();
    input.value = 'nuovo@b.it';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('blur'));
    await fixture.whenStable();
    expect(host.value()).toBe('nuovo@b.it');
    expect(host.blurs()).toBe(1);
  });

  it('describes the input with hint and error, marks it invalid and announces the error', async () => {
    const { fixture, host, root, input } = await render();
    host.hint.set('Usa la tua email di lavoro');
    await fixture.whenStable();
    const hint = root.querySelector('.hint')!;
    expect(input.getAttribute('aria-describedby')).toBe(hint.id);

    host.error.set('Email non valida');
    await fixture.whenStable();
    const error = root.querySelector('.error')!;
    expect(input.getAttribute('aria-describedby')).toBe(`${hint.id} ${error.id}`);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(error.getAttribute('aria-live')).toBe('polite');
    expect(error.textContent).toContain('Email non valida');
    expect(error.querySelector('svg')).not.toBeNull();
  });

  it('can be disabled', async () => {
    const { fixture, host, input } = await render();
    host.disabled.set(true);
    await fixture.whenStable();
    expect(input.disabled).toBe(true);
  });
});
