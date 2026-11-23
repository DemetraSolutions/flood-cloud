import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { settle } from '../../../testing/api';
import { I18nService } from '../../core/i18n/i18n.service';
import { SelectOption } from '../../shared/ui/select/select';
import { GroupTax } from '../product-catalog/product-catalog.types';
import { PriceRow } from './product-prices';
import { ProductPriceRules } from './product-price-rules';

const TAXES: GroupTax[] = [
  { id: 't1', rate: 22, department: null, description: null, vatNature: null },
  { id: 't2', rate: 10, department: null, description: null, vatNature: null },
];
const LISTS: SelectOption[] = [{ value: 'l1', label: 'Base' }];

function priceRow(change: Partial<PriceRow> = {}): PriceRow {
  return {
    id: null,
    priceListId: 'l1',
    currency: 'EUR',
    taxId: 't1',
    net: '100',
    gross: '122',
    written: 'net',
    discount: '0',
    validFrom: '',
    validTo: '',
    dailyFrom: '',
    dailyTo: '',
    weekDays: [],
    fromQuantity: '1',
    maxSaleQuantity: '',
    ...change,
  };
}

@Component({
  imports: [ProductPriceRules],
  template: `<fc-product-price-rules
    [(value)]="value"
    [priceLists]="priceLists()"
    [currencies]="currencies()"
    [taxes]="taxes()"
    [error]="error()"
    [disabled]="disabled()"
  />`,
})
class Host {
  readonly value = signal<PriceRow[]>([priceRow()]);
  readonly priceLists = signal(LISTS);
  readonly currencies = signal<readonly string[]>(['EUR', 'USD']);
  readonly taxes = signal(TAXES);
  readonly error = signal<string | null>(null);
  readonly disabled = signal(false);
}

async function render(language?: string) {
  if (language !== undefined) {
    Object.defineProperty(TestBed.inject(I18nService), 'language', { value: signal(language).asReadonly() });
  }
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  const fixture = TestBed.createComponent(Host);
  document.body.appendChild(fixture.nativeElement);
  const view = async () => {
    await settle();
    await fixture.whenStable();
  };
  await view();
  const root = fixture.nativeElement as HTMLElement;
  const rows = () => [...root.querySelectorAll<HTMLElement>('ul > li')];
  const selects = (i: number) => [...rows()[i].querySelectorAll<HTMLSelectElement>('select')];
  /** Text fields of a rule: net, gross, discount, from, to, daily from, daily to, from quantity, max quantity. */
  const texts = (i: number) => [...rows()[i].querySelectorAll<HTMLInputElement>('input:not([type=checkbox])')];
  const days = (i: number) => [...rows()[i].querySelectorAll<HTMLInputElement>('input[type=checkbox]')];
  const button = (i: number, label: string) =>
    rows()[i].querySelector<HTMLButtonElement>(`button[aria-label^="${label}"]`)!;
  const addButton = () => [...root.querySelectorAll<HTMLButtonElement>('button')].at(-1)!;
  const write = async (input: HTMLInputElement, value: string) => {
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await view();
  };
  const choose = async (select: HTMLSelectElement, value: string) => {
    select.value = value;
    select.dispatchEvent(new Event('change'));
    await view();
  };
  const component = fixture.debugElement.children[0].componentInstance as ProductPriceRules;
  return { host: fixture.componentInstance, root, view, rows, selects, texts, days, button, addButton, write, choose, component };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('ProductPriceRules', () => {
  it('says there are no rules when none is set', async () => {
    const { host, root, view } = await render();
    host.value.set([]);
    await view();
    expect(root.querySelector('li.note')?.textContent).toBe('PRODUCTS.PRICES.EMPTY');
  });

  it('shows the fields of a rule', async () => {
    const { selects, texts, rows } = await render();
    expect(selects(0).map((select) => select.value)).toEqual(['l1', 'EUR', 't1']);
    expect(texts(0).map((input) => input.value)).toEqual(['100', '122', '0', '', '', '', '', '1', '']);
    expect(rows()[0].querySelector('legend')?.textContent).toBe('PRODUCTS.PRICES.RULE {"number":1}');
  });

  it('adds a rule with the first price list, currency and tax rate', async () => {
    const { host, addButton, view, rows } = await render();
    addButton().click();
    await view();
    expect(rows()).toHaveLength(2);
    expect(host.value()[1]).toEqual({
      id: null,
      priceListId: 'l1',
      currency: 'EUR',
      taxId: 't1',
      net: '0',
      gross: '0.00',
      written: 'net',
      discount: '0',
      validFrom: '',
      validTo: '',
      dailyFrom: '',
      dailyTo: '',
      weekDays: [],
      fromQuantity: '1',
      maxSaleQuantity: '',
    });
  });

  it('adds an empty rule when there are no lists, currencies or tax rates', async () => {
    const { host, addButton, view } = await render();
    host.priceLists.set([]);
    host.currencies.set([]);
    host.taxes.set([]);
    host.value.set([]);
    await view();
    addButton().click();
    await view();
    expect(host.value()).toHaveLength(1);
    expect(host.value()[0]).toMatchObject({ priceListId: '', currency: '', taxId: '', net: '0', gross: '' });
  });

  it('stops adding at the limit of 50 rules', async () => {
    const { host, addButton, view } = await render();
    host.value.set(Array.from({ length: 49 }, () => priceRow()));
    await view();
    expect(addButton().disabled).toBe(false);
    host.value.set(Array.from({ length: 50 }, () => priceRow()));
    await view();
    expect(addButton().disabled).toBe(true);
  });

  it('removes the rule of the row', async () => {
    const { host, button, view } = await render();
    host.value.set([priceRow({ net: '1' }), priceRow({ net: '2' })]);
    await view();
    button(0, 'PRODUCTS.PRICES.REMOVE_LABEL').click();
    await view();
    expect(host.value().map((row) => row.net)).toEqual(['2']);
  });

  it('moves a rule up and down, announces it and disables the moves at the borders', async () => {
    const { host, root, button, view } = await render();
    host.value.set([priceRow({ net: '1' }), priceRow({ net: '2' }), priceRow({ net: '3' })]);
    await view();
    expect(button(0, 'PRODUCTS.PRICES.UP_LABEL').disabled).toBe(true);
    expect(button(0, 'PRODUCTS.PRICES.DOWN_LABEL').disabled).toBe(false);
    expect(button(2, 'PRODUCTS.PRICES.UP_LABEL').disabled).toBe(false);
    expect(button(2, 'PRODUCTS.PRICES.DOWN_LABEL').disabled).toBe(true);
    expect(root.querySelector('.visually-hidden[role=status]')?.textContent).toBe('');

    button(1, 'PRODUCTS.PRICES.UP_LABEL').click();
    await view();
    expect(host.value().map((row) => row.net)).toEqual(['2', '1', '3']);
    expect(root.querySelector('.visually-hidden[role=status]')?.textContent).toBe('PRODUCTS.PRICES.MOVED {"from":2,"to":1}');

    button(0, 'PRODUCTS.PRICES.DOWN_LABEL').click();
    await view();
    expect(host.value().map((row) => row.net)).toEqual(['1', '2', '3']);
    expect(root.querySelector('.visually-hidden[role=status]')?.textContent).toBe('PRODUCTS.PRICES.MOVED {"from":1,"to":2}');
  });

  it('computes the gross price from the net one written, and the net from the gross', async () => {
    const { host, texts, write } = await render();
    await write(texts(0)[0], '50');
    expect(host.value()[0]).toMatchObject({ net: '50', gross: '61.00', written: 'net' });
    await write(texts(0)[1], '122');
    expect(host.value()[0]).toMatchObject({ net: '100', gross: '122', written: 'gross' });
  });

  it('leaves the other price empty when the tax rate is unknown', async () => {
    const { host, texts, write, view } = await render();
    host.value.set([priceRow({ taxId: 'gone', net: '', gross: '' })]);
    await view();
    await write(texts(0)[0], '50');
    expect(host.value()[0]).toMatchObject({ net: '50', gross: '' });
  });

  it('recomputes the price that was not written when the tax rate changes', async () => {
    const { host, selects, choose, view } = await render();
    await choose(selects(0)[2], 't2');
    expect(host.value()[0]).toMatchObject({ taxId: 't2', net: '100', gross: '110.00', written: 'net' });
    host.value.set([priceRow({ written: 'gross', gross: '122', net: '100' })]);
    await view();
    await choose(selects(0)[2], 't2');
    expect(host.value()[0]).toMatchObject({ taxId: 't2', gross: '122', net: '110.90909091', written: 'gross' });
  });

  it('only changes the tax when its rate is unknown', async () => {
    const { host, selects, choose, view } = await render();
    host.taxes.set([]);
    host.value.set([priceRow({ taxId: 'gone' })]);
    await view();
    expect(selects(0)[2].value).toBe('gone');
    await choose(selects(0)[2], '');
    expect(host.value()[0]).toMatchObject({ taxId: '', net: '100', gross: '122' });
    host.value.set([priceRow({ taxId: 'gone', written: 'gross' })]);
    await view();
    await choose(selects(0)[2], '');
    expect(host.value()[0]).toMatchObject({ taxId: '', net: '100', gross: '122' });
  });

  it('changes the other fields of the rule only', async () => {
    const { host, selects, texts, write, choose, view } = await render();
    host.value.set([priceRow({ net: '1' }), priceRow({ net: '2' })]);
    await view();
    await choose(selects(1)[0], '');
    await choose(selects(1)[1], 'USD');
    const typed = ['', '', '10', '2025-01-01T10:00', '2025-02-01T10:00', '08:00', '12:00', '3', '9'];
    for (const [position, value] of typed.entries()) {
      if (value !== '') {
        await write(texts(1)[position], value);
      }
    }
    expect(host.value()[0]).toEqual(priceRow({ net: '1' }));
    expect(host.value()[1]).toEqual(
      priceRow({
        net: '2',
        priceListId: '',
        currency: 'USD',
        discount: '10',
        validFrom: '2025-01-01T10:00',
        validTo: '2025-02-01T10:00',
        dailyFrom: '08:00',
        dailyTo: '12:00',
        fromQuantity: '3',
        maxSaleQuantity: '9',
      }),
    );
  });

  it('toggles the days of the week', async () => {
    const { host, days, view } = await render();
    expect(days(0)).toHaveLength(7);
    host.value.set([priceRow({ weekDays: [1] })]);
    await view();
    expect(days(0).map((day) => day.checked)).toEqual([false, true, false, false, false, false, false]);
    days(0)[0].checked = true;
    days(0)[0].dispatchEvent(new Event('change'));
    await view();
    expect(host.value()[0].weekDays).toEqual([1, 0]);
    days(0)[1].checked = false;
    days(0)[1].dispatchEvent(new Event('change'));
    await view();
    expect(host.value()[0].weekDays).toEqual([0]);
  });

  it('names the days in Italian until the language of the app is known', async () => {
    const { root } = await render();
    const labels = [...root.querySelectorAll('fieldset fieldset label')].map((label) => label.textContent?.trim());
    expect([labels[0], labels[6]]).toEqual(['domenica', 'sabato']);
  });

  it('names the days in the language of the app', async () => {
    const { root } = await render('en');
    const labels = [...root.querySelectorAll('fieldset fieldset label')].map((label) => label.textContent?.trim());
    expect([labels[0], labels[6]]).toEqual(['Sunday', 'Saturday']);
  });

  it('shows the error of each field of a rule', async () => {
    const { host, root, view } = await render();
    expect(root.querySelector('.error span')).toBeNull();
    host.value.set([
      priceRow({
        priceListId: '',
        currency: '',
        taxId: '',
        net: 'x',
        gross: 'y',
        discount: '101',
        validFrom: 'bad',
        validTo: 'bad',
        dailyFrom: '25:00',
        dailyTo: '8',
        fromQuantity: '-1',
        maxSaleQuantity: 'z',
      }),
    ]);
    await view();
    expect(root.querySelectorAll('.error span')).toHaveLength(12);
  });

  it('flags the end of the validity that precedes its start', async () => {
    const { host, root, view } = await render();
    host.value.set([priceRow({ validFrom: '2025-02-01T10:00', validTo: '2025-01-01T10:00' })]);
    await view();
    expect([...root.querySelectorAll('.error span')].map((span) => span.textContent)).toEqual(['FORM.ISSUE.INCORRECT']);
  });

  it('shows the amounts with and without the discount', async () => {
    const { host, rows, view } = await render();
    const facts = () => [...rows()[0].querySelectorAll('dd')].map((dd) => dd.textContent);
    expect(facts()).toEqual(['122.00', '100.00', '122.00']);
    host.value.set([priceRow({ discount: '10' })]);
    await view();
    expect(facts()).toEqual(['122.00', '90.00', '109.80']);
    host.value.set([priceRow({ net: '', gross: '' })]);
    await view();
    expect(facts()).toEqual(['', '', '']);
  });

  it('keeps the list, the currency and the tax of a rule even when they are not offered', async () => {
    const { host, selects, view } = await render();
    host.value.set([priceRow({ priceListId: 'old', currency: 'CHF', taxId: 'gone' })]);
    await view();
    const options = (i: number) => [...selects(0)[i].options].map((option) => option.value);
    expect(options(0)).toEqual(['', 'l1', 'old']);
    expect(options(1)).toEqual(['', 'EUR', 'USD', 'CHF']);
    expect(options(2)).toEqual(['', 't1', 't2', 'gone']);
  });

  it('disables the rules and hides every button when disabled', async () => {
    const { host, root, view } = await render();
    host.disabled.set(true);
    await view();
    expect(root.querySelector('fieldset')?.disabled).toBe(true);
    expect(root.querySelectorAll('button')).toHaveLength(0);
  });

  it('shows the error as an alert linked to the list', async () => {
    const { host, root, view } = await render();
    expect(root.querySelector('ul')?.hasAttribute('aria-describedby')).toBe(false);
    host.error.set('Non valido');
    await view();
    const alert = root.querySelector('p.problem[role=alert]');
    expect(alert?.textContent).toBe('Non valido');
    expect(root.querySelector('ul')?.getAttribute('aria-describedby')).toBe(alert?.id);
  });

  it('focuses the first field, and does nothing without rules', async () => {
    const { host, selects, view, component } = await render();
    component.focus();
    expect(document.activeElement).toBe(selects(0)[0]);
    host.value.set([]);
    await view();
    expect(() => component.focus()).not.toThrow();
  });
});
