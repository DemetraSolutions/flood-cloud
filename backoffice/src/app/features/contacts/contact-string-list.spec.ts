import { Component, signal, viewChild } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { disabled, form, FormField, validate } from '@angular/forms/signals';
import { I18nService } from '../../core/i18n/i18n.service';
import { ContactStringList } from './contact-string-list';

@Component({
  imports: [ContactStringList, FormField],
  template: `<fc-contact-string-list
    [formField]="f.phones"
    type="tel"
    legend="Telefoni"
    itemKey="CONTACTS.PERSON.PHONE_N"
    addKey="CONTACTS.PERSON.ADD_PHONE"
    [limit]="limit"
    [issue]="issue"
    [error]="error()"
  />`,
})
class Host {
  readonly model = signal({ phones: ['111', '222'] });
  readonly readOnly = signal(false);
  readonly error = signal<string | null>(null);
  readonly limit = 3;
  readonly issue = (text: string) => (text === 'bad' ? 'format' : undefined);
  readonly f = form(this.model, (path) => {
    disabled(path.phones, () => this.readOnly());
    validate(path.phones, () => undefined);
  });
  readonly list = viewChild.required(ContactStringList);
}

@Component({
  imports: [ContactStringList],
  template: `<fc-contact-string-list
    legend="Fax"
    itemKey="K"
    addKey="A"
    [limit]="2"
    [value]="['x']"
  />`,
})
class Bare {}

async function render() {
  TestBed.configureTestingModule({});
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  const fixture = TestBed.createComponent(Host);
  document.body.appendChild(fixture.nativeElement);
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  const host = fixture.componentInstance;
  const inputs = () => [...root.querySelectorAll<HTMLInputElement>('input')];
  const buttons = () => [...root.querySelectorAll<HTMLButtonElement>('button')];
  const buttonOf = (text: string) => buttons().find((b) => b.textContent?.trim() === text)!;
  const type = async (input: HTMLInputElement, value: string) => {
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await fixture.whenStable();
  };
  return { fixture, host, root, inputs, buttons, buttonOf, type };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('ContactStringList', () => {
  it('shows a labelled row for each entry under the legend', async () => {
    const { root, inputs } = await render();
    expect(root.querySelector('legend')?.textContent).toBe('Telefoni');
    expect(inputs().map((input) => input.value)).toEqual(['111', '222']);
    expect([...root.querySelectorAll('label')].map((label) => label.textContent?.trim())).toEqual([
      'CONTACTS.PERSON.PHONE_N {"number":1}',
      'CONTACTS.PERSON.PHONE_N {"number":2}',
    ]);
    expect(inputs()[0].type).toBe('tel');
  });

  it('writes what the user types into the form', async () => {
    const { host, inputs, type } = await render();
    await type(inputs()[1], '333');
    expect(host.model().phones).toEqual(['111', '333']);
  });

  it('adds an empty entry and removes one, until the limit', async () => {
    const { host, fixture, inputs, buttonOf } = await render();
    buttonOf('CONTACTS.PERSON.ADD_PHONE').click();
    await fixture.whenStable();
    expect(host.model().phones).toEqual(['111', '222', '']);
    expect(buttonOf('CONTACTS.PERSON.ADD_PHONE').disabled).toBe(true);
    expect(inputs()).toHaveLength(3);
    // The focus goes to the new row.
    expect(document.activeElement).toBe(inputs()[2]);

    const remove = [...document.querySelectorAll<HTMLButtonElement>('button[aria-label]')][0];
    expect(remove.getAttribute('aria-label')).toBe(
      'CONTACTS.LIST.REMOVE_LABEL {"name":"CONTACTS.PERSON.PHONE_N {\\"number\\":1}"}',
    );
    remove.click();
    await fixture.whenStable();
    expect(host.model().phones).toEqual(['222', '']);
    expect(buttonOf('CONTACTS.PERSON.ADD_PHONE').disabled).toBe(false);
    // The focus goes to the row that took its place.
    expect(document.activeElement).toBe(inputs()[0]);
  });

  it('moves the focus to the previous row when the last one is removed, and to Add when none is left', async () => {
    const { host, fixture, inputs, buttonOf } = await render();
    const removeButtons = () => [
      ...document.querySelectorAll<HTMLButtonElement>('button[aria-label]'),
    ];
    removeButtons()[1].click();
    await fixture.whenStable();
    expect(host.model().phones).toEqual(['111']);
    expect(document.activeElement).toBe(inputs()[0]);
    removeButtons()[0].click();
    await fixture.whenStable();
    expect(host.model().phones).toEqual([]);
    expect(document.activeElement).toBe(buttonOf('CONTACTS.PERSON.ADD_PHONE'));
  });

  it('shows the issue of each row on its own field', async () => {
    const { host, fixture, root, inputs, type } = await render();
    await type(inputs()[0], 'bad');
    expect(inputs()[0].getAttribute('aria-invalid')).toBe('true');
    expect(inputs()[1].getAttribute('aria-invalid')).not.toBe('true');
    expect(root.textContent).toContain('FORM.ISSUE');
    host.model.set({ phones: ['111', '222'] });
    await fixture.whenStable();
    expect(inputs()[0].getAttribute('aria-invalid')).not.toBe('true');
  });

  it('shows the message of the whole list as an alert that describes the group', async () => {
    const { host, fixture, root } = await render();
    const group = root.querySelector('fieldset')!;
    expect(group.hasAttribute('aria-describedby')).toBe(false);
    expect(root.querySelector('[role=alert]')).toBeNull();
    host.error.set('Doppio');
    await fixture.whenStable();
    const alert = root.querySelector('[role=alert]')!;
    expect(alert.textContent).toBe('Doppio');
    expect(group.getAttribute('aria-describedby')).toBe(alert.id);
  });

  it('is read only when disabled: no add, no remove, disabled fields', async () => {
    const { host, fixture, inputs, buttons } = await render();
    host.readOnly.set(true);
    await fixture.whenStable();
    expect(buttons()).toHaveLength(0);
    expect(inputs().every((input) => input.disabled)).toBe(true);
  });

  it('focuses the first entry', async () => {
    const { host, inputs } = await render();
    host.list().focus();
    expect(document.activeElement).toBe(inputs()[0]);
  });

  it('does nothing when asked to focus a list without entries', async () => {
    const { host, fixture } = await render();
    host.model.set({ phones: [] });
    await fixture.whenStable();
    expect(() => host.list().focus()).not.toThrow();
  });

  it('has no issue on any entry unless the parent says what an issue is', async () => {
    TestBed.configureTestingModule({});
    vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key) => key);
    const fixture = TestBed.createComponent(Bare);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelectorAll('input')).toHaveLength(1);
    expect(root.querySelector('input')?.getAttribute('aria-invalid')).not.toBe('true');
  });
});
