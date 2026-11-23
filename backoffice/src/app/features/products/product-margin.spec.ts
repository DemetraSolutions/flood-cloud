import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { form, validate } from '@angular/forms/signals';
import { I18nService } from '../../core/i18n/i18n.service';
import { coreModelOf } from '../../../testing/product-tabs-b-form';
import { CoreModel } from './product-model';
import { CostBasis, marginLines, ProductMargin } from './product-margin';
import { PriceRow } from './product-prices';
import { Costs } from './product.types';

const price = (net: string, discount = '0'): PriceRow => ({
  id: null,
  priceListId: 'l1',
  currency: 'EUR',
  taxId: 't1',
  net,
  gross: '',
  written: 'net',
  discount,
  validFrom: '',
  validTo: '',
  dailyFrom: '',
  dailyTo: '',
  weekDays: [],
  fromQuantity: '1',
  maxSaleQuantity: '',
});
const NO_COSTS: Record<CostBasis, number | null> = { SIMPLE: null, LAST: null, AVERAGE: null, WEIGHTED_AVERAGE: null };
const COSTS: Costs = { last: 4, average: null, weightedAverage: 5, lastSupplierId: null, bySupplier: {} };

describe('marginLines', () => {
  it('gives the markup and the food cost of every rule on every cost the product has', () => {
    const lines = marginLines([price('10'), price('20', '50')], { ...NO_COSTS, SIMPLE: 4, LAST: 5 });
    expect(lines).toEqual([
      { rule: 1, basis: 'SIMPLE', cost: 4, price: 10, markup: 6, markupPercentage: 150, foodCostPercentage: 40 },
      { rule: 1, basis: 'LAST', cost: 5, price: 10, markup: 5, markupPercentage: 100, foodCostPercentage: 50 },
      { rule: 2, basis: 'SIMPLE', cost: 4, price: 10, markup: 6, markupPercentage: 150, foodCostPercentage: 40 },
      { rule: 2, basis: 'LAST', cost: 5, price: 10, markup: 5, markupPercentage: 100, foodCostPercentage: 50 },
    ]);
  });

  it('skips the rules without a price, with the number of the others kept', () => {
    const lines = marginLines([price(''), price('8')], { ...NO_COSTS, SIMPLE: 2 });
    expect(lines.map((line) => line.rule)).toEqual([2]);
  });

  it('skips the costs the product does not have', () => {
    expect(marginLines([price('8')], NO_COSTS)).toEqual([]);
  });

  it('has no markup percentage on a zero cost and no food cost on a zero price', () => {
    const [free] = marginLines([price('8')], { ...NO_COSTS, AVERAGE: 0 });
    expect(free).toMatchObject({ markup: 8, markupPercentage: null, foodCostPercentage: 0 });
    const [gift] = marginLines([price('0')], { ...NO_COSTS, AVERAGE: 3 });
    expect(gift).toMatchObject({ markup: -3, markupPercentage: -100, foodCostPercentage: null });
  });
});

@Component({
  imports: [ProductMargin],
  template: `<fc-product-margin [form]="f" [prices]="prices()" [costs]="costs()" [rooms]="rooms()" />`,
})
class Host {
  readonly prices = signal<readonly PriceRow[]>([]);
  readonly costs = signal<Costs | undefined>(undefined);
  readonly rooms = signal(false);
  readonly model = signal<CoreModel>(coreModelOf());
  readonly f = form(this.model, (path) => {
    validate(path.simpleCost, ({ value }) => (value() === 'bad' ? { kind: 'server', message: 'Non valido' } : undefined));
  });
}

async function render(language: 'it' | null = null) {
  TestBed.configureTestingModule({});
  const i18n = TestBed.inject(I18nService);
  vi.spyOn(i18n, 't').mockImplementation((key, params) => (params === undefined ? key : `${key} ${JSON.stringify(params)}`));
  vi.spyOn(i18n, 'language').mockReturnValue(language);
  const fixture = TestBed.createComponent(Host);
  document.body.appendChild(fixture.nativeElement);
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  const host = fixture.componentInstance;
  const view = () => fixture.whenStable();
  const simple = () => root.querySelector<HTMLInputElement>('input')!;
  const type = async (text: string) => {
    simple().value = text;
    simple().dispatchEvent(new Event('input'));
    await view();
  };
  const cells = () => [...root.querySelectorAll('tbody tr')].map((tr) => [...tr.children].map((c) => c.textContent?.trim()));
  return { fixture, host, root, view, simple, type, cells };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('ProductMargin', () => {
  it('has the simplified cost field, bound to the form, and the text for no margin', async () => {
    const { host, root, simple, type } = await render();
    expect(root.querySelector('label')?.textContent?.trim()).toBe('PRODUCTS.MARGIN.SIMPLE_COST');
    expect(root.querySelector('.hint')?.textContent).toBe('PRODUCTS.MARGIN.SIMPLE_COST_HINT');
    expect(simple().getAttribute('inputmode')).toBe('decimal');
    expect(root.querySelector('.note')?.textContent).toBe('PRODUCTS.MARGIN.NONE');
    expect(root.querySelector('table')).toBeNull();
    await type('3');
    expect(host.model().simpleCost).toBe('3');
  });

  it('shows the error of the simplified cost and marks it as touched on blur', async () => {
    const { host, root, simple, view } = await render();
    host.model.update((model) => ({ ...model, simpleCost: 'bad' }));
    await view();
    expect(root.querySelector('.error span')?.textContent).toBe('Non valido');
    simple().dispatchEvent(new Event('blur'));
    await view();
    expect(host.f.simpleCost().touched()).toBe(true);
  });

  it('shows a row for each rule and cost, with the amounts and without the food cost', async () => {
    const { host, root, type, view, cells } = await render();
    host.prices.set([price('10')]);
    await type('4');
    host.costs.set(COSTS);
    await view();
    expect(root.querySelector('caption')?.textContent).toBe('PRODUCTS.MARGIN.CAPTION');
    expect([...root.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual([
      'PRODUCTS.MARGIN.RULE',
      'PRODUCTS.MARGIN.COST',
      'PRODUCTS.MARGIN.PRICE',
      'PRODUCTS.MARGIN.MARKUP',
      'PRODUCTS.MARGIN.MARKUP_PERCENTAGE',
    ]);
    expect(cells()).toEqual([
      ['PRODUCTS.MARGIN.RULE_NUMBER {"number":1}', 'PRODUCTS.MARGIN.BASIS_SIMPLE: 4,00', '10,00', '6,00', '150,00'],
      ['PRODUCTS.MARGIN.RULE_NUMBER {"number":1}', 'PRODUCTS.MARGIN.BASIS_LAST: 4,00', '10,00', '6,00', '150,00'],
      ['PRODUCTS.MARGIN.RULE_NUMBER {"number":1}', 'PRODUCTS.MARGIN.BASIS_WEIGHTED_AVERAGE: 5,00', '10,00', '5,00', '100,00'],
    ]);
  });

  it('adds the food cost column with rooms, and leaves it empty when the price is zero', async () => {
    const { host, root, type, view, cells } = await render('it');
    host.prices.set([price('10'), price('0')]);
    host.rooms.set(true);
    await type('4');
    await view();
    expect(root.querySelectorAll('thead th')).toHaveLength(6);
    expect(root.querySelectorAll('thead th')[5].textContent).toBe('PRODUCTS.MARGIN.FOOD_COST');
    expect(cells().map((row) => row.at(-1))).toEqual(['40,00', '']);
  });

  it('ignores a simplified cost that is empty or is not a number', async () => {
    const { host, root, type } = await render();
    host.prices.set([price('10')]);
    await type('  ');
    expect(root.querySelector('table')).toBeNull();
    await type('abc');
    expect(root.querySelector('table')).toBeNull();
    await type(' 2,5 ');
    expect(root.querySelector('table')).toBeNull();
    await type('2.5');
    expect(root.querySelector('table')).not.toBeNull();
  });

  it('leaves the markup percentage empty on a zero cost', async () => {
    const { host, type, cells } = await render();
    host.prices.set([price('10')]);
    await type('0');
    expect(cells()[0].at(-1)).toBe('');
  });
});
