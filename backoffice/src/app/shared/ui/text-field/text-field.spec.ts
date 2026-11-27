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
    autocapitalize="none"
    spellcheck="false"
    [inputmode]="inputmode()"
    [format]="format()"
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
  readonly inputmode = signal<'numeric' | null>(null);
  readonly blurs = signal(0);
  readonly format = signal<((text: string) => string) | null>(null);
}

async function render() {
  const fixture = TestBed.createComponent(Host);
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  return { fixture, host: fixture.componentInstance, root, input: root.querySelector('input')! };
}

@Component({
  imports: [TextField],
  template: `<fc-text-field
    label="Aruba"
    inputId="aruba-username"
    fieldName="aruba-username"
    ignorePasswordManagers
  />`,
})
class FixedHost {}

describe('TextField', () => {
  it('uses a fixed id and name and opts out of password managers', async () => {
    const fixture = TestBed.createComponent(FixedHost);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const input = root.querySelector('input')!;
    expect(input.id).toBe('aruba-username');
    expect(input.name).toBe('aruba-username');
    expect(root.querySelector('label')!.htmlFor).toBe('aruba-username');
    expect(input.getAttribute('data-1p-ignore')).toBe('');
    expect(input.getAttribute('data-lpignore')).toBe('true');
  });

  it('leaves name and password-manager attributes off by default', async () => {
    const { input } = await render();
    expect(input.hasAttribute('name')).toBe(false);
    expect(input.hasAttribute('data-1p-ignore')).toBe(false);
    expect(input.hasAttribute('data-lpignore')).toBe(false);
  });

  it('links a visible label to the input and passes native attributes', async () => {
    const { root, input } = await render();
    const label = root.querySelector('label')!;
    expect(label.htmlFor).toBe(input.id);
    expect(label.textContent).toBe('Email');
    expect(input.type).toBe('email');
    expect(input.value).toBe('a@b.it');
    expect(input.required).toBe(true);
    expect(input.getAttribute('autocomplete')).toBe('email');
    expect(input.getAttribute('autocapitalize')).toBe('none');
    expect(input.getAttribute('spellcheck')).toBe('false');
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

  it('shows and keeps the text a format function makes of what the user types', async () => {
    const { fixture, host, input } = await render();
    host.format.set((text) => text.toUpperCase());
    await fixture.whenStable();
    input.value = 'abc';
    input.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    expect(input.value).toBe('ABC');
    expect(host.value()).toBe('ABC');
    input.value = 'XYZ';
    input.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    expect(host.value()).toBe('XYZ');
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

  it('sets the inputmode attribute only when asked to', async () => {
    const { fixture, host, input } = await render();
    expect(input.hasAttribute('inputmode')).toBe(false);
    host.inputmode.set('numeric');
    await fixture.whenStable();
    expect(input.getAttribute('inputmode')).toBe('numeric');
  });

  it('can be disabled', async () => {
    const { fixture, host, input } = await render();
    host.disabled.set(true);
    await fixture.whenStable();
    expect(input.disabled).toBe(true);
  });

  it('focuses the input when asked to (Signal Forms focus the first invalid field)', async () => {
    const { fixture, input } = await render();
    const field = fixture.debugElement.children[0].componentInstance as TextField;
    field.focus();
    expect(document.activeElement).toBe(input);
  });
});
