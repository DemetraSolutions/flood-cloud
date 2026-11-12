import { Component, signal, viewChild } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { form, FormField } from '@angular/forms/signals';
import { I18nService } from '../../core/i18n/i18n.service';
import { PosPriceList } from '../../core/users/pos.catalog';
import { PosPriceLists, PriceListChoice } from './pos-price-lists';

const LISTS: PriceListChoice[] = [
  { id: 'a', name: 'Listino A' },
  { id: 'b', name: 'Listino B' },
];

@Component({
  imports: [PosPriceLists],
  template: `<fc-pos-price-lists
    label="Listini"
    [error]="error()"
    [lists]="lists()"
    [(value)]="value"
    [disabled]="disabled()"
    (blurred)="blurs.update((n) => n + 1)"
  />`,
})
class Host {
  readonly control = viewChild.required(PosPriceLists);
  readonly lists = signal(LISTS);
  readonly value = signal<PosPriceList[]>([]);
  readonly error = signal<string | null>(null);
  readonly disabled = signal(false);
  readonly blurs = signal(0);
}

@Component({
  imports: [PosPriceLists, FormField],
  template: `<fc-pos-price-lists label="Listini" [lists]="lists" [formField]="f.priceLists" />`,
})
class FormHost {
  readonly lists = LISTS;
  readonly model = signal<{ priceLists: PosPriceList[] }>({ priceLists: [] });
  readonly f = form(this.model);
}

async function render(value: PosPriceList[] = []) {
  TestBed.configureTestingModule({});
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key) => key);
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.value.set(value);
  document.body.appendChild(fixture.nativeElement);
  await fixture.whenStable();
  const host = fixture.componentInstance;
  const root = fixture.nativeElement as HTMLElement;
  const rows = () => [...root.querySelectorAll('li')];
  const usable = (row: number) => rows()[row].querySelectorAll('input')[0];
  const isDefault = (row: number) => rows()[row].querySelectorAll('input')[1];
  const noDefault = () => rows()[rows().length - 1].querySelector('input')!;
  const toggle = async (input: HTMLInputElement) => {
    input.checked = !input.checked;
    input.dispatchEvent(new Event('change'));
    await fixture.whenStable();
  };
  const pick = async (input: HTMLInputElement) => {
    input.checked = true;
    input.dispatchEvent(new Event('change'));
    await fixture.whenStable();
  };
  const update = async (change: () => void) => {
    change();
    await fixture.whenStable();
  };
  return { fixture, host, root, rows, usable, isDefault, noDefault, toggle, pick, update };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('PosPriceLists', () => {
  it('shows one row per price list plus "no default", with nothing chosen', async () => {
    const { root, rows, usable, isDefault, noDefault } = await render();
    expect(root.querySelector('legend')?.textContent).toBe('Listini');
    expect(rows().length).toBe(3);
    expect(rows()[0].textContent).toContain('Listino A');
    expect(rows()[1].textContent).toContain('Listino B');
    expect(rows()[0].textContent).toContain('USERS.POS.PRICE_LIST_DEFAULT');
    expect(rows()[2].textContent).toContain('USERS.POS.PRICE_LIST_NO_DEFAULT');
    expect(usable(0).checked).toBe(false);
    expect(usable(1).checked).toBe(false);
    expect(isDefault(0).disabled).toBe(true);
    expect(isDefault(1).disabled).toBe(true);
    expect(noDefault().checked).toBe(true);
    expect(noDefault().disabled).toBe(false);
  });

  it('reflects the stored entries', async () => {
    const { usable, isDefault, noDefault } = await render([
      { priceListId: 'a', enabled: true, isDefault: false },
      { priceListId: 'b', enabled: true, isDefault: true },
    ]);
    expect(usable(0).checked).toBe(true);
    expect(usable(1).checked).toBe(true);
    expect(isDefault(0).checked).toBe(false);
    expect(isDefault(1).checked).toBe(true);
    expect(isDefault(0).disabled).toBe(false);
    expect(noDefault().checked).toBe(false);
  });

  it('adds the entry when a list is made usable the first time', async () => {
    const { host, usable, isDefault, toggle } = await render();
    await toggle(usable(1));
    expect(host.value()).toEqual([{ priceListId: 'b', enabled: true, isDefault: false }]);
    expect(isDefault(1).disabled).toBe(false);
    expect(isDefault(0).disabled).toBe(true);
  });

  it('updates the existing entry when it is toggled', async () => {
    const { host, usable, toggle } = await render([
      { priceListId: 'a', enabled: false, isDefault: false },
    ]);
    await toggle(usable(0));
    expect(host.value()).toEqual([{ priceListId: 'a', enabled: true, isDefault: false }]);
    await toggle(usable(0));
    expect(host.value()).toEqual([{ priceListId: 'a', enabled: false, isDefault: false }]);
  });

  it('removes the default when the default list is no longer usable', async () => {
    const { host, usable, noDefault, toggle } = await render([
      { priceListId: 'a', enabled: true, isDefault: true },
      { priceListId: 'b', enabled: true, isDefault: false },
    ]);
    await toggle(usable(1));
    expect(host.value()[0].isDefault).toBe(true);
    await toggle(usable(0));
    expect(host.value()).toEqual([
      { priceListId: 'a', enabled: false, isDefault: false },
      { priceListId: 'b', enabled: false, isDefault: false },
    ]);
    expect(noDefault().checked).toBe(true);
  });

  it('keeps a single default at a time', async () => {
    const { host, isDefault, noDefault, pick } = await render([
      { priceListId: 'a', enabled: true, isDefault: true },
      { priceListId: 'b', enabled: true, isDefault: false },
    ]);
    await pick(isDefault(1));
    expect(host.value().map((e) => e.isDefault)).toEqual([false, true]);
    expect(isDefault(0).name).toBe(isDefault(1).name);
    expect(isDefault(0).name).toBe(noDefault().name);
    await pick(isDefault(0));
    expect(host.value().map((e) => e.isDefault)).toEqual([true, false]);
  });

  it('clears every default with "no default"', async () => {
    const { host, noDefault, pick } = await render([
      { priceListId: 'a', enabled: true, isDefault: false },
      { priceListId: 'b', enabled: true, isDefault: true },
    ]);
    await pick(noDefault());
    expect(host.value()).toEqual([
      { priceListId: 'a', enabled: true, isDefault: false },
      { priceListId: 'b', enabled: true, isDefault: false },
    ]);
  });

  it('keeps entries of price lists that are not among the lists', async () => {
    const { host, usable, isDefault, noDefault, toggle, pick } = await render([
      { priceListId: 'gone', enabled: true, isDefault: true },
    ]);
    expect(usable(0).checked).toBe(false);
    expect(noDefault().checked).toBe(false);
    await toggle(usable(0));
    expect(host.value()).toEqual([
      { priceListId: 'gone', enabled: true, isDefault: true },
      { priceListId: 'a', enabled: true, isDefault: false },
    ]);
    await pick(isDefault(0));
    expect(host.value()).toEqual([
      { priceListId: 'gone', enabled: true, isDefault: false },
      { priceListId: 'a', enabled: true, isDefault: true },
    ]);
  });

  it('follows the lists of the group', async () => {
    const { host, rows, update } = await render();
    await update(() => host.lists.set([{ id: 'c', name: 'Listino C' }]));
    expect(rows().length).toBe(2);
    expect(rows()[0].textContent).toContain('Listino C');
  });

  it('disables every control', async () => {
    const { host, root, update } = await render([
      { priceListId: 'a', enabled: true, isDefault: true },
    ]);
    await update(() => host.disabled.set(true));
    expect(root.querySelector('fieldset')!.disabled).toBe(true);
    const inputs = [...root.querySelectorAll('input')];
    expect(inputs.length).toBe(5);
    expect(inputs.every((input) => input.disabled)).toBe(true);
  });

  it('shows the error of the server', async () => {
    const { host, root, update } = await render();
    expect(root.querySelector('.error span')).toBeNull();
    await update(() => host.error.set('Listino non valido'));
    expect(root.querySelector('.error span')?.textContent).toBe('Listino non valido');
  });

  it('emits blurred when any control loses the focus', async () => {
    const { host, usable, isDefault, noDefault, fixture } = await render();
    for (const input of [usable(0), isDefault(0), noDefault()]) {
      input.dispatchEvent(new Event('blur'));
    }
    await fixture.whenStable();
    expect(host.blurs()).toBe(3);
  });

  it('focuses the first control', async () => {
    const { host, usable } = await render();
    host.control().focus();
    expect(document.activeElement).toBe(usable(0));
  });

  it('focuses the "no default" radio when the group has no price lists', async () => {
    const { host, update } = await render();
    await update(() => host.lists.set([]));
    // The "no default" radio is always there, so the focus lands on it.
    host.control().focus();
    expect((document.activeElement as HTMLInputElement).type).toBe('radio');
  });

  it('works as a Signal Forms value control', async () => {
    TestBed.configureTestingModule({});
    vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key) => key);
    const fixture = TestBed.createComponent(FormHost);
    fixture.componentInstance.model.set({
      priceLists: [{ priceListId: 'a', enabled: true, isDefault: false }],
    });
    await fixture.whenStable();
    const inputs = fixture.nativeElement.querySelectorAll('input') as NodeListOf<HTMLInputElement>;
    expect(inputs[0].checked).toBe(true);
    inputs[1].checked = true;
    inputs[1].dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect(fixture.componentInstance.model().priceLists[0].isDefault).toBe(true);
  });
});
