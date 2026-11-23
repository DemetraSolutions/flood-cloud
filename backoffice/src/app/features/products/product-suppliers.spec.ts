import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { I18nService } from '../../core/i18n/i18n.service';
import { ReferenceApi, ReferenceItem } from '../../core/reference/reference-api';
import { settle } from '../../../testing/api';
import { SupplierListRow, SupplierRow } from './product-model';
import { ProductSuppliers } from './product-suppliers';
import { Costs, PRODUCT_LIMITS } from './product.types';

const ID_A = '665f1c2e9b1d4a0012ab3401';
const ID_B = '665f1c2e9b1d4a0012ab3402';
const ID_C = '665f1c2e9b1d4a0012ab3403';
const KNOWN: ReferenceItem[] = [
  {
    id: ID_A,
    name: 'Mulino',
    priceLists: [
      { id: 'L1', name: 'Listino base' },
      { id: 'L2', name: '' },
    ],
  },
  { id: ID_B, name: '', priceLists: [] },
  { id: ID_C, name: 'Cantina' },
];
const list = (change: Partial<SupplierListRow> = {}): SupplierListRow => ({ id: 'L1', price: '5', discount1: '1', discount2: '2', discount3: '3', ...change });
const supplier = (change: Partial<SupplierRow> = {}): SupplierRow => ({
  contactId: ID_A,
  code: 'C1',
  name: 'Farina 00',
  minQuantity: '2',
  deliveryTime: '3',
  deliveryTimeUnit: 'days',
  favorite: false,
  priceLists: [],
  ...change,
});
const COSTS: Costs = {
  last: null,
  average: null,
  weightedAverage: null,
  lastSupplierId: null,
  bySupplier: { [ID_A]: { last: 1.5, average: null, weightedAverage: 2 } },
};

@Component({
  imports: [ProductSuppliers],
  template: `<fc-product-suppliers groupId="g1" [(value)]="value" [costs]="costs()" [error]="error()" [disabled]="disabled()" />`,
})
class Host {
  readonly value = signal<SupplierRow[]>([]);
  readonly costs = signal<Costs | undefined>(undefined);
  readonly error = signal<string | null>(null);
  readonly disabled = signal(false);
}

async function render(value: SupplierRow[] = [], costs?: Costs, language: 'it' | null = 'it') {
  const reference = {
    lookup: vi.fn((_group: string, _kind: string, query: { ids?: string[]; q?: string }) =>
      Promise.resolve({
        data: query.ids === undefined ? [KNOWN[0]] : KNOWN.filter((item) => query.ids!.includes(item.id)),
        page: { limit: 25, next: null },
      }),
    ),
  };
  TestBed.configureTestingModule({ providers: [{ provide: ReferenceApi, useValue: reference }] });
  const i18n = TestBed.inject(I18nService);
  vi.spyOn(i18n, 't').mockImplementation((key, params) => (params === undefined ? key : `${key} ${JSON.stringify(params)}`));
  vi.spyOn(i18n, 'language').mockReturnValue(language);
  const fixture = TestBed.createComponent(Host);
  const host = fixture.componentInstance;
  host.value.set(value);
  host.costs.set(costs);
  document.body.appendChild(fixture.nativeElement);
  const view = async () => {
    await settle();
    await fixture.whenStable();
  };
  await view();
  const root = fixture.nativeElement as HTMLElement;
  const control = fixture.debugElement.children[0].componentInstance as ProductSuppliers;
  const field = (label: string) =>
    [...root.querySelectorAll('label')].find((l) => l.textContent?.trim() === label)!.control as HTMLInputElement & HTMLSelectElement;
  const type = async (label: string, text: string) => {
    const input = field(label);
    input.value = text;
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input'));
    await view();
  };
  const check = async (label: string, on: boolean) => {
    const box = field(label);
    box.checked = on;
    box.dispatchEvent(new Event('change'));
    await view();
  };
  const add = () => [...root.querySelectorAll<HTMLButtonElement>('.actions button')].find((b) => b.textContent?.trim() === 'PRODUCTS.SUPPLIERS.ADD')!;
  const button = (text: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text);
  return { fixture, host, root, view, control, field, type, check, add, button, reference };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

const n = (key: string, number = 1) => `PRODUCTS.SUPPLIERS.${key} {"number":${number}}`;
const named = (key: string, name: string) => `PRODUCTS.SUPPLIERS.${key} {"name":"${name}"}`;

describe('ProductSuppliers', () => {
  it('says there are no suppliers and offers to add one, reading nothing', async () => {
    const { root, add, reference } = await render();
    expect(root.querySelector('.hint')?.textContent).toBe('PRODUCTS.SUPPLIERS.HINT');
    expect(root.querySelector('li.note')?.textContent).toBe('PRODUCTS.SUPPLIERS.EMPTY');
    expect(add().disabled).toBe(false);
    expect(reference.lookup).not.toHaveBeenCalled();
  });

  it('adds a supplier with the defaults and removes it', async () => {
    const { host, add, view, root } = await render();
    add().click();
    await view();
    expect(host.value()).toEqual([
      { contactId: '', code: '', name: '', minQuantity: '', deliveryTime: '', deliveryTimeUnit: 'days', favorite: false, priceLists: [] },
    ]);
    const remove = root.querySelector<HTMLButtonElement>('li > .actions button')!;
    expect(remove.getAttribute('aria-label')).toBe(n('REMOVE_LABEL'));
    remove.click();
    await view();
    expect(host.value()).toEqual([]);
  });

  it('removes only the chosen supplier', async () => {
    const { host, root, view } = await render([supplier(), supplier({ contactId: ID_B })]);
    root.querySelector<HTMLButtonElement>('li > .actions button')!.click();
    await view();
    expect(host.value()).toEqual([supplier({ contactId: ID_B })]);
  });

  it('does not add beyond the limit', async () => {
    const { add } = await render(Array.from({ length: PRODUCT_LIMITS.suppliers }, () => supplier({ contactId: '' })));
    expect(add().disabled).toBe(true);
  });

  describe('choice of the supplier', () => {
    it('reads once the names of the suppliers of the rows, without repeating or invalid ids', async () => {
      const { reference } = await render([supplier(), supplier(), supplier({ contactId: ` ${ID_B} ` }), supplier({ contactId: 'zz' })]);
      expect(reference.lookup).toHaveBeenCalledTimes(1);
      expect(reference.lookup).toHaveBeenCalledWith('g1', 'suppliers', { ids: [ID_A, ID_B], limit: 100 });
    });

    it('shows the name of the chosen supplier, or a text when it has none, and nothing when it is unknown', async () => {
      const { root } = await render([supplier(), supplier({ contactId: ID_B }), supplier({ contactId: '' })]);
      const combos = [...root.querySelectorAll<HTMLInputElement>('input[role=combobox]')].map((i) => i.value);
      expect(combos).toEqual(['Mulino', 'PRODUCTS.SUPPLIERS.NO_NAME', '']);
      expect(root.querySelector('input[role=combobox]')?.getAttribute('placeholder')).toBe('PRODUCTS.SUPPLIERS.CONTACT_NONE');
    });

    it('searches the suppliers on the server and chooses one, which drops the price lists of the old one', async () => {
      const { host, root, view, reference } = await render([supplier({ contactId: '', priceLists: [list()] }), supplier({ contactId: ID_C })]);
      root.querySelector<HTMLInputElement>('input[role=combobox]')!.dispatchEvent(new Event('focus'));
      await view();
      expect(reference.lookup).toHaveBeenCalledWith('g1', 'suppliers', { q: '', limit: 25 });
      root.querySelector<HTMLElement>('[role=option]')!.click();
      await view();
      expect(host.value()[0]).toEqual(supplier({ contactId: ID_A, priceLists: [] }));
      expect(host.value()[1]).toEqual(supplier({ contactId: ID_C }));
    });

    it('clears the supplier with the clear button', async () => {
      const { host, root, view } = await render([supplier({ priceLists: [list()] })]);
      const clear = root.querySelector<HTMLButtonElement>('fc-search-combobox button')!;
      expect(clear.getAttribute('aria-label') ?? clear.textContent).toContain('PRODUCTS.SUPPLIERS.CONTACT_CLEAR');
      clear.click();
      await view();
      expect(host.value()[0]).toEqual(supplier({ contactId: '', priceLists: [] }));
    });
  });

  it('shows and edits the fields of a supplier, keeping the others', async () => {
    const { host, field, type } = await render([supplier(), supplier({ contactId: ID_B })]);
    expect(field(n('CODE')).value).toBe('C1');
    expect(field(n('DELIVERY_UNIT')).value).toBe('days');
    expect([...field(n('DELIVERY_UNIT')).options].map((o) => [o.value, o.textContent?.trim()])).toEqual([
      ['days', 'PRODUCTS.SUPPLIERS.UNIT_DAYS'],
      ['months', 'PRODUCTS.SUPPLIERS.UNIT_MONTHS'],
      ['years', 'PRODUCTS.SUPPLIERS.UNIT_YEARS'],
    ]);
    await type(n('CODE'), 'C2');
    await type(n('NAME'), 'Farina 0');
    await type(n('MIN_QUANTITY'), '4');
    await type(n('DELIVERY_TIME'), '6');
    await type(n('DELIVERY_UNIT'), 'months');
    expect(host.value()[0]).toEqual(supplier({ code: 'C2', name: 'Farina 0', minQuantity: '4', deliveryTime: '6', deliveryTimeUnit: 'months' }));
    expect(host.value()[1]).toEqual(supplier({ contactId: ID_B }));
  });

  it('shows the errors of a supplier', async () => {
    const { root } = await render([supplier({ code: 'c'.repeat(65), name: 'n'.repeat(151), minQuantity: 'x', deliveryTime: '-1' })]);
    expect([...root.querySelectorAll('li .grid > .field .error span, li .grid fc-text-field .error span')].map((e) => e.textContent)).toEqual([
      'FORM.ISSUE.MAX_LENGTH',
      'FORM.ISSUE.MAX_LENGTH',
      'FORM.ISSUE.TYPE',
      'FORM.ISSUE.MINIMUM',
    ]);
  });

  it('keeps one favorite supplier: choosing one clears the others, clearing one keeps the others', async () => {
    const { host, check } = await render([supplier({ favorite: true }), supplier({ contactId: ID_B }), supplier({ contactId: ID_C })]);
    await check(n('FAVORITE', 2), true);
    expect(host.value().map((s) => s.favorite)).toEqual([false, true, false]);
    await check(n('FAVORITE', 2), false);
    expect(host.value().map((s) => s.favorite)).toEqual([false, false, false]);
  });

  it('keeps the favorite flag of the other suppliers when one is cleared', async () => {
    const { host, check } = await render([supplier({ favorite: true }), supplier({ contactId: ID_B, favorite: true })]);
    await check(n('FAVORITE', 2), false);
    expect(host.value().map((s) => s.favorite)).toEqual([true, false]);
  });

  describe('price lists', () => {
    const legends = (root: HTMLElement) => [...root.querySelectorAll('fieldset fieldset legend')].map((l) => l.textContent);

    it('names a list with the one of the supplier, a text when it has no name, and the id when the supplier does not offer it', async () => {
      const { root } = await render([
        supplier({ priceLists: [list(), list({ id: 'L2' }), list({ id: 'L9' })] }),
        supplier({ contactId: ID_B, priceLists: [list({ id: 'L3' })] }),
      ]);
      expect(legends(root)).toEqual([
        named('LIST', 'Listino base'),
        named('LIST', 'PRODUCTS.SUPPLIERS.LIST_NO_NAME'),
        named('LIST', 'L9'),
        named('LIST', 'L3'),
      ]);
      expect([...root.querySelectorAll('fieldset fieldset .note')].map((x) => x.textContent)).toEqual([
        'PRODUCTS.SUPPLIERS.LIST_GONE',
        'PRODUCTS.SUPPLIERS.LIST_GONE',
      ]);
    });

    it('shows the id of a list, without a note, when the supplier cannot be read', async () => {
      const { root } = await render([supplier({ contactId: 'zz', priceLists: [list({ id: 'L1' })] })]);
      expect(legends(root)).toEqual([named('LIST', 'L1')]);
      expect(root.querySelector('fieldset fieldset .note')).toBeNull();
    });

    it('edits only the list changed', async () => {
      const { host, type } = await render([
        supplier({ priceLists: [list(), list({ id: 'L2', price: '7' })] }),
        supplier({ contactId: ID_B, priceLists: [list({ id: 'L3' })] }),
      ]);
      const label = 'PRODUCTS.SUPPLIERS.LIST_PRICE {"name":"PRODUCTS.SUPPLIERS.LIST_NO_NAME"}';
      await type(label, '8');
      await type('PRODUCTS.SUPPLIERS.LIST_DISCOUNT_1 {"name":"PRODUCTS.SUPPLIERS.LIST_NO_NAME"}', '10');
      await type('PRODUCTS.SUPPLIERS.LIST_DISCOUNT_2 {"name":"PRODUCTS.SUPPLIERS.LIST_NO_NAME"}', '20');
      await type('PRODUCTS.SUPPLIERS.LIST_DISCOUNT_3 {"name":"PRODUCTS.SUPPLIERS.LIST_NO_NAME"}', '30');
      expect(host.value()[0].priceLists).toEqual([list(), list({ id: 'L2', price: '8', discount1: '10', discount2: '20', discount3: '30' })]);
      expect(host.value()[1].priceLists).toEqual([list({ id: 'L3' })]);
    });

    it('shows the errors of a list', async () => {
      const { root } = await render([supplier({ priceLists: [list({ price: 'x', discount1: '101', discount2: '-1', discount3: 'y' })] })]);
      const lists = root.querySelector('fieldset fieldset')!;
      expect([...lists.querySelectorAll('.error span')].map((e) => e.textContent)).toEqual([
        'FORM.ISSUE.TYPE',
        'FORM.ISSUE.MAXIMUM',
        'FORM.ISSUE.MINIMUM',
        'FORM.ISSUE.TYPE',
      ]);
    });

    it('removes a list', async () => {
      const { host, button, view } = await render([supplier({ priceLists: [list(), list({ id: 'L2' })] }), supplier({ contactId: ID_B, priceLists: [list({ id: 'L3' })] })]);
      button(named('LIST_REMOVE', 'Listino base'))!.click();
      await view();
      expect(host.value()[0].priceLists.map((l) => l.id)).toEqual(['L2']);
      expect(host.value()[1].priceLists.map((l) => l.id)).toEqual(['L3']);
    });

    it('offers to add the lists of the supplier it does not have yet, and adds one empty', async () => {
      const { host, button, view } = await render([supplier({ priceLists: [list()] }), supplier({ contactId: ID_B })]);
      expect(button(named('LIST_ADD', 'Listino base'))).toBeUndefined();
      button(named('LIST_ADD', 'PRODUCTS.SUPPLIERS.LIST_NO_NAME'))!.click();
      await view();
      expect(host.value()[0].priceLists).toEqual([list(), { id: 'L2', price: '', discount1: '', discount2: '', discount3: '' }]);
      expect(host.value()[1].priceLists).toEqual([]);
      expect(button(named('LIST_ADD', 'PRODUCTS.SUPPLIERS.LIST_NO_NAME'))).toBeUndefined();
    });

    it('offers the lists of a supplier with the name it has', async () => {
      const { button } = await render([supplier()]);
      expect(button(named('LIST_ADD', 'Listino base'))).toBeDefined();
    });
  });

  describe('costs', () => {
    it('shows the costs of the supplier read only, with an empty text for the unknown ones', async () => {
      const { root } = await render([supplier(), supplier({ contactId: ID_B })], COSTS);
      const lists = root.querySelectorAll('dl.facts');
      expect(lists).toHaveLength(1);
      expect([...lists[0].children].map((c) => c.textContent)).toEqual([
        'PRODUCTS.STOCK.COST_LAST',
        '1,5',
        'PRODUCTS.STOCK.COST_AVERAGE',
        '',
        'PRODUCTS.STOCK.COST_WEIGHTED_AVERAGE',
        '2',
      ]);
    });

    it('formats the costs in the default language until the language of the user is known', async () => {
      const { root } = await render([supplier()], COSTS, null);
      expect(root.querySelector('dl.facts dd')?.textContent).toBe('1,5');
    });

    it('shows no costs without the warehouse', async () => {
      const { root } = await render([supplier()]);
      expect(root.querySelector('dl')).toBeNull();
    });
  });

  it('is read only when disabled: no remove and add buttons and a disabled fieldset', async () => {
    const { host, root, add, view } = await render([supplier()]);
    expect(add()).toBeDefined();
    host.disabled.set(true);
    await view();
    expect(root.querySelector('li > .actions')).toBeNull();
    expect(root.querySelector('fieldset')?.disabled).toBe(true);
  });

  it('shows the error as an alert linked to the list', async () => {
    const { host, root, view } = await render();
    expect(root.querySelector('p.problem')).toBeNull();
    expect(root.querySelector('ul')?.hasAttribute('aria-describedby')).toBe(false);
    host.error.set('Non valido');
    await view();
    const alert = root.querySelector('p.problem[role=alert]')!;
    expect(alert.textContent).toBe('Non valido');
    expect(root.querySelector('ul')?.getAttribute('aria-describedby')).toBe(alert.id);
  });

  it('focuses the first field, and does nothing without suppliers', async () => {
    const { host, root, view, control } = await render([supplier()]);
    control.focus();
    expect(document.activeElement).toBe(root.querySelector('input'));
    host.value.set([]);
    await view();
    expect(() => control.focus()).not.toThrow();
  });
});
