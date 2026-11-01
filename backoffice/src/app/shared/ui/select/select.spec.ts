import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Select, SelectOption } from './select';

const OPTIONS: SelectOption[] = [
  { value: 'a', label: 'Alfa' },
  { value: 'b', label: 'Beta' },
];

@Component({
  imports: [Select],
  template: `<fc-select
    label="Gruppo"
    [options]="options"
    [placeholder]="placeholder()"
    [hint]="hint()"
    [error]="error()"
    [disabled]="disabled()"
    required
    [(value)]="value"
    (blurred)="blurs.set(blurs() + 1)"
  />`,
})
class Host {
  readonly options = OPTIONS;
  readonly value = signal('b');
  readonly placeholder = signal<string | null>(null);
  readonly hint = signal<string | null>(null);
  readonly error = signal<string | null>(null);
  readonly disabled = signal(false);
  readonly blurs = signal(0);
}

async function render() {
  const fixture = TestBed.createComponent(Host);
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  return { fixture, host: fixture.componentInstance, root, select: root.querySelector('select')! };
}

describe('Select', () => {
  it('links the label, lists the options and selects the current value', async () => {
    const { root, select } = await render();
    expect(root.querySelector('label')!.htmlFor).toBe(select.id);
    expect(select.required).toBe(true);
    expect([...select.options].map((o) => o.textContent?.trim())).toEqual(['Alfa', 'Beta']);
    expect(select.value).toBe('b');
  });

  it('updates the model on change and emits blurred', async () => {
    const { fixture, host, select } = await render();
    select.value = 'a';
    select.dispatchEvent(new Event('change'));
    select.dispatchEvent(new Event('blur'));
    await fixture.whenStable();
    expect(host.value()).toBe('a');
    expect(host.blurs()).toBe(1);
  });

  it('adds an empty placeholder option, selected when there is no value', async () => {
    const { fixture, host, select } = await render();
    host.placeholder.set('Scegli…');
    host.value.set('');
    await fixture.whenStable();
    expect(select.options[0].textContent?.trim()).toBe('Scegli…');
    expect(select.value).toBe('');
  });

  it('describes the select with hint and error and can be disabled', async () => {
    const { fixture, host, root, select } = await render();
    expect(select.hasAttribute('aria-describedby')).toBe(false);
    host.hint.set('Aiuto');
    host.error.set('Obbligatorio');
    host.disabled.set(true);
    await fixture.whenStable();
    expect(select.getAttribute('aria-describedby')).toBe(
      `${root.querySelector('.hint')!.id} ${root.querySelector('.error')!.id}`,
    );
    expect(select.getAttribute('aria-invalid')).toBe('true');
    expect(select.disabled).toBe(true);
  });
});
