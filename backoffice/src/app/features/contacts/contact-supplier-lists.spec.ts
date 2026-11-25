import { Component, signal, viewChild } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { disabled, form, FormField } from '@angular/forms/signals';
import { I18nService } from '../../core/i18n/i18n.service';
import { ContactSupplierLists } from './contact-supplier-lists';
import { SupplierListRow } from './contact-model';

@Component({
  imports: [ContactSupplierLists, FormField],
  template: `<fc-contact-supplier-lists
    [formField]="f.lists"
    [highlighted]="highlighted()"
    [error]="error()"
  />`,
})
class Host {
  readonly model = signal<{ lists: SupplierListRow[] }>({
    lists: [
      { id: 'l1', name: 'Estate', favorite: true },
      { id: 'l2', name: 'Inverno', favorite: false },
    ],
  });
  readonly readOnly = signal(false);
  readonly highlighted = signal(false);
  readonly error = signal<string | null>(null);
  readonly f = form(this.model, (path) => disabled(path.lists, () => this.readOnly()));
  readonly list = viewChild.required(ContactSupplierLists);
}

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
  const inputs = () => [...root.querySelectorAll<HTMLInputElement>('input:not([type=checkbox])')];
  const stars = () => [...root.querySelectorAll<HTMLInputElement>('input[type=checkbox]')];
  const buttonOf = (text: string) =>
    [...root.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === text,
    )!;
  const type = async (input: HTMLInputElement, value: string) => {
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await fixture.whenStable();
  };
  return { fixture, host, root, inputs, stars, buttonOf, type };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('ContactSupplierLists', () => {
  it('shows a row with the name and a favorite checkbox for each price list', async () => {
    const { root, inputs, stars } = await render();
    expect(root.querySelector('legend')?.textContent).toBe('CONTACTS.COMPANY.LISTS');
    expect(inputs().map((input) => input.value)).toEqual(['Estate', 'Inverno']);
    expect(stars().map((star) => star.checked)).toEqual([true, false]);
    expect(root.textContent).toContain('CONTACTS.COMPANY.LIST_FAVORITE {"number":1}');
    expect(root.textContent).toContain('CONTACTS.COMPANY.LIST_FAVORITE_HINT');
  });

  it('names the block of a supplier as such', async () => {
    const { host, fixture, root } = await render();
    host.highlighted.set(true);
    await fixture.whenStable();
    expect(root.querySelector('legend')?.textContent).toBe('CONTACTS.COMPANY.LISTS_SUPPLIER');
  });

  it('highlights the block of a supplier', async () => {
    const { host, fixture, root } = await render();
    const group = root.querySelector('fieldset')!;
    expect(group.classList.contains('highlight')).toBe(false);
    host.highlighted.set(true);
    await fixture.whenStable();
    expect(group.classList.contains('highlight')).toBe(true);
  });

  it('renames a list', async () => {
    const { host, inputs, type } = await render();
    await type(inputs()[1], 'Autunno');
    expect(host.model().lists[1]).toMatchObject({ id: 'l2', name: 'Autunno', favorite: false });
  });

  it('keeps one favorite at a time and unmarks it when cleared', async () => {
    const { host, fixture, stars } = await render();
    stars()[1].click();
    await fixture.whenStable();
    expect(host.model().lists.map((list) => list.favorite)).toEqual([false, true]);
    stars()[1].click();
    await fixture.whenStable();
    expect(host.model().lists.map((list) => list.favorite)).toEqual([false, false]);
  });

  it('adds a list without an id and removes one, until the limit of 50', async () => {
    const { host, fixture, buttonOf } = await render();
    buttonOf('CONTACTS.COMPANY.ADD_LIST').click();
    await fixture.whenStable();
    expect(host.model().lists[2]).toMatchObject({ id: '', name: '', favorite: false });

    const remove = document.querySelectorAll<HTMLButtonElement>(
      'button[aria-label^="CONTACTS.LIST.REMOVE_LABEL"]',
    );
    remove[0].click();
    await fixture.whenStable();
    expect(host.model().lists.map((list) => list.name)).toEqual(['Inverno', '']);

    host.model.set({
      lists: Array.from({ length: 50 }, (_, i) => ({
        id: `l${i}`,
        name: `L${i}`,
        favorite: false,
      })),
    });
    await fixture.whenStable();
    expect(buttonOf('CONTACTS.COMPANY.ADD_LIST').disabled).toBe(true);
  });

  it('shows the issue of a name that is missing or too long on its own row', async () => {
    const { host, fixture, inputs, type } = await render();
    await type(inputs()[0], '');
    expect(inputs()[0].getAttribute('aria-invalid')).toBe('true');
    expect(inputs()[1].getAttribute('aria-invalid')).not.toBe('true');
    await type(inputs()[0], 'x'.repeat(101));
    expect(inputs()[0].getAttribute('aria-invalid')).toBe('true');
    host.model.set({ lists: [{ id: 'l1', name: 'Ok', favorite: false }] });
    await fixture.whenStable();
    expect(inputs()[0].getAttribute('aria-invalid')).not.toBe('true');
  });

  it('shows the message of the whole list as an alert that describes the group', async () => {
    const { host, fixture, root } = await render();
    const group = root.querySelector('fieldset')!;
    expect(root.querySelector('[role=alert]')).toBeNull();
    expect(group.hasAttribute('aria-describedby')).toBe(false);
    host.error.set('Due preferiti');
    await fixture.whenStable();
    const alert = root.querySelector('[role=alert]')!;
    expect(alert.textContent).toBe('Due preferiti');
    expect(group.getAttribute('aria-describedby')).toBe(alert.id);
  });

  it('is read only when disabled: no add, no remove, disabled fields and stars', async () => {
    const { host, fixture, root, inputs, stars } = await render();
    host.readOnly.set(true);
    await fixture.whenStable();
    expect(root.textContent).not.toContain('CONTACTS.COMPANY.ADD_LIST');
    expect(root.querySelectorAll('button[aria-label^="CONTACTS.LIST.REMOVE_LABEL"]')).toHaveLength(
      0,
    );
    expect(inputs().every((input) => input.disabled)).toBe(true);
    expect(stars().every((star) => star.disabled)).toBe(true);
  });

  it('focuses the first entry, and nothing when there is none', async () => {
    const { host, fixture, inputs } = await render();
    host.list().focus();
    expect(document.activeElement).toBe(inputs()[0]);
    host.model.set({ lists: [] });
    await fixture.whenStable();
    expect(() => host.list().focus()).not.toThrow();
  });
});
