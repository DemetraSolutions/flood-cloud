import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { I18nService } from '../../core/i18n/i18n.service';
import { ReferenceItem } from '../../core/reference/reference-api';
import { settle } from '../../../testing/api';
import { PlaceSetupReader, SetupState } from '../product-categories/category-place-setup';
import { StockRow } from './product-model';
import { ProductStock } from './product-stock';
import { Costs, StockByPlace } from './product.types';

const PLACES: ReferenceItem[] = [
  { id: 'p1', name: 'Negozio 1' },
  { id: 'p2', name: 'Negozio 2' },
];
const READY: SetupState = {
  status: 'ready',
  setup: {
    stations: [],
    centers: [],
    storages: [
      { id: 's1', name: 'Magazzino' },
      { id: 's2', name: 'Cella' },
    ],
  },
};
const row = (change: Partial<StockRow> = {}): StockRow => ({ placeId: 'p1', storageId: 's1', min: '1', max: '9', location: 'A1', ...change });
const COSTS: Costs = { last: 1.5, average: null, weightedAverage: 2, lastSupplierId: 'sup1', bySupplier: {} };

@Component({
  imports: [ProductStock],
  template: `<fc-product-stock
    groupId="g1"
    [places]="places()"
    [(value)]="value"
    [quantities]="quantities()"
    [costs]="costs()"
    [error]="error()"
    [disabled]="disabled()"
  />`,
})
class Host {
  readonly places = signal(PLACES);
  readonly value = signal<StockRow[]>([]);
  readonly quantities = signal<StockByPlace>({});
  readonly costs = signal<Costs | undefined>(undefined);
  readonly error = signal<string | null>(null);
  readonly disabled = signal(false);
}

async function render(setup: { value?: StockRow[]; quantities?: StockByPlace; costs?: Costs; language?: 'it' | null } = {}) {
  const states = signal<ReadonlyMap<string, SetupState>>(new Map());
  const load = vi.fn();
  TestBed.configureTestingModule({ providers: [{ provide: PlaceSetupReader, useValue: { states, load } }] });
  const i18n = TestBed.inject(I18nService);
  vi.spyOn(i18n, 't').mockImplementation((key, params) => (params === undefined ? key : `${key} ${JSON.stringify(params)}`));
  vi.spyOn(i18n, 'language').mockReturnValue(setup.language ?? null);
  const fixture = TestBed.createComponent(Host);
  const host = fixture.componentInstance;
  host.value.set(setup.value ?? []);
  host.quantities.set(setup.quantities ?? {});
  host.costs.set(setup.costs);
  document.body.appendChild(fixture.nativeElement);
  await settle();
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  const view = async () => {
    await settle();
    await fixture.whenStable();
  };
  const details = () => [...root.querySelectorAll<HTMLDetailsElement>('details')];
  const field = (label: string) =>
    [...root.querySelectorAll('label')].find((l) => l.textContent?.trim() === label)!.control as HTMLInputElement;
  const type = async (label: string, text: string) => {
    const input = field(label);
    input.value = text;
    input.dispatchEvent(new Event('input'));
    await view();
  };
  const put = async (...entries: [string, SetupState][]) => {
    states.set(new Map(entries));
    await view();
  };
  const facts = () => [...root.querySelectorAll('dl dt')].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent] as const);
  const control = fixture.debugElement.children[0].componentInstance as ProductStock;
  return { fixture, host, root, view, details, field, type, put, load, facts, control };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

const MIN = 'PRODUCTS.STOCK.MIN {"storage":"Magazzino"}';
const MAX = 'PRODUCTS.STOCK.MAX {"storage":"Magazzino"}';
const LOCATION = 'PRODUCTS.STOCK.LOCATION {"storage":"Magazzino"}';
const QUANTITY = 'PRODUCTS.STOCK.QUANTITY {"storage":"Magazzino"}';

describe('ProductStock', () => {
  it('says there are no stores when none is listed', async () => {
    const { host, root, view, details } = await render();
    host.places.set([]);
    await view();
    expect(details()).toHaveLength(0);
    expect(root.querySelector('.note')?.textContent).toBe('PRODUCT_CATEGORIES.STATIONS.NO_PLACES');
  });

  describe('summary', () => {
    it('shows no total without quantities and no costs without them', async () => {
      const { facts } = await render();
      expect(facts()).toEqual([['PRODUCTS.STOCK.TOTAL', 'PRODUCTS.STOCK.NONE']]);
    });

    it('sums the quantities of every storage of every store and skips the ones the warehouse has not counted', async () => {
      const { facts } = await render({
        quantities: {
          p1: { s1: { quantity: 10.5, min: null, max: null, location: null }, s2: { quantity: null, min: null, max: null, location: null } },
          p2: { s1: { quantity: 2, min: null, max: null, location: null } },
        },
      });
      expect(facts()).toEqual([['PRODUCTS.STOCK.TOTAL', '12,5']]);
    });

    it('has no total when every quantity is unknown', async () => {
      const { facts } = await render({ quantities: { p1: { s1: { quantity: null, min: null, max: null, location: null } } } });
      expect(facts()[0]).toEqual(['PRODUCTS.STOCK.TOTAL', 'PRODUCTS.STOCK.NONE']);
    });

    it('shows the costs and the last supplier, with the text for the ones that are unknown', async () => {
      const { facts } = await render({ costs: COSTS });
      expect(facts()).toEqual([
        ['PRODUCTS.STOCK.TOTAL', 'PRODUCTS.STOCK.NONE'],
        ['PRODUCTS.STOCK.COST_LAST', '1,5'],
        ['PRODUCTS.STOCK.COST_AVERAGE', 'PRODUCTS.STOCK.NONE'],
        ['PRODUCTS.STOCK.COST_WEIGHTED_AVERAGE', '2'],
        ['PRODUCTS.STOCK.LAST_SUPPLIER', 'sup1'],
      ]);
    });

    it('says there is no last supplier', async () => {
      const { facts } = await render({ costs: { ...COSTS, lastSupplierId: null } });
      expect(facts().at(-1)).toEqual(['PRODUCTS.STOCK.LAST_SUPPLIER', 'PRODUCTS.STOCK.NONE']);
    });

    it('formats the numbers in the language of the user when it is known', async () => {
      const { facts } = await render({ costs: COSTS, language: 'it' });
      expect(facts()[1]).toEqual(['PRODUCTS.STOCK.COST_LAST', '1,5']);
    });
  });

  describe('sections', () => {
    it('opens at start the stores that have a limit or a quantity, and reads only those', async () => {
      const { details, load } = await render({ value: [row()], quantities: { p2: {} } });
      expect(details().map((d) => d.open)).toEqual([true, true]);
      expect(load).toHaveBeenCalledWith('g1', 'p1');
      expect(load).toHaveBeenCalledWith('g1', 'p2');
    });

    it('leaves closed the stores without limits and reads them when they are opened, and forgets the opening when closed', async () => {
      const { details, load, view } = await render({ value: [row()] });
      expect(details().map((d) => d.open)).toEqual([true, false]);
      expect(load).not.toHaveBeenCalledWith('g1', 'p2');
      details()[1].open = true;
      details()[1].dispatchEvent(new Event('toggle'));
      await view();
      expect(load).toHaveBeenCalledWith('g1', 'p2');
      details()[1].open = false;
      details()[1].dispatchEvent(new Event('toggle'));
      await view();
      expect(details()[1].open).toBe(false);
    });

    it('shows loading while the storages are not known or are being read', async () => {
      const { details, put } = await render();
      expect(details()[0].querySelector('[role=status]')?.textContent).toBe('COMMON.LOADING');
      await put(['p1', { status: 'loading' }]);
      expect(details()[0].querySelector('[role=status]')?.textContent).toBe('COMMON.LOADING');
    });

    it('shows the error with a retry that reads the store again', async () => {
      const { details, put, load } = await render();
      await put(['p1', { status: 'error' }]);
      expect(details()[0].querySelector('[role=alert]')?.textContent).toBe('PRODUCTS.STOCK.LOAD_ERROR');
      load.mockClear();
      details()[0].querySelector('button')!.click();
      expect(load).toHaveBeenCalledWith('g1', 'p1');
    });

    it('says a store has no storages', async () => {
      const { details, put } = await render();
      await put(['p1', { status: 'ready', setup: { stations: [], centers: [], storages: [] } }]);
      expect(details()[0].querySelector('.note')?.textContent).toBe('PRODUCTS.STOCK.NO_STORAGES');
    });
  });

  describe('storages', () => {
    it('shows a fieldset per storage with the limits of the row and the quantity of the warehouse, read only', async () => {
      const { details, put, field } = await render({
        value: [row()],
        quantities: { p1: { s1: { quantity: 4, min: null, max: null, location: null } } },
      });
      await put(['p1', READY]);
      expect([...details()[0].querySelectorAll('legend')].map((l) => l.textContent)).toEqual(['Magazzino', 'Cella']);
      expect(field(QUANTITY).value).toBe('4');
      expect(field(QUANTITY).readOnly).toBe(true);
      expect(field(MIN).value).toBe('1');
      expect(field(MAX).value).toBe('9');
      expect(field(LOCATION).value).toBe('A1');
      expect(field('PRODUCTS.STOCK.QUANTITY {"storage":"Cella"}').value).toBe('');
      expect(field('PRODUCTS.STOCK.MIN {"storage":"Cella"}').value).toBe('');
    });

    it('has no quantity for a storage the product has no stock in', async () => {
      const { put, field } = await render({ value: [row()], quantities: { p1: {} } });
      await put(['p1', READY]);
      expect(field(QUANTITY).value).toBe('');
    });

    it('adds a row when the limits of a storage are first edited and updates it after, keeping the other rows', async () => {
      const { host, put, type } = await render({ value: [row({ storageId: 's2' })] });
      await put(['p1', READY]);
      await type(MIN, '3');
      expect(host.value()).toEqual([row({ storageId: 's2' }), { placeId: 'p1', storageId: 's1', min: '3', max: '', location: '' }]);
      await type(MAX, '8');
      await type(LOCATION, 'B2');
      expect(host.value()).toEqual([row({ storageId: 's2' }), { placeId: 'p1', storageId: 's1', min: '3', max: '8', location: 'B2' }]);
    });

    it('distinguishes the rows of the same storage in another store', async () => {
      const { host, put, type } = await render({ value: [row({ placeId: 'p2' })] });
      await put(['p1', READY], ['p2', READY]);
      await type(MIN, '5');
      expect(host.value()).toEqual([row({ placeId: 'p2' }), { placeId: 'p1', storageId: 's1', min: '5', max: '', location: '' }]);
    });

    it('shows the errors of the limits and of the location', async () => {
      const { details, put } = await render({ value: [row({ min: 'x', max: '-1', location: 'a'.repeat(65) })] });
      await put(['p1', READY]);
      expect([...details()[0].querySelectorAll('.error span')].map((e) => e.textContent)).toEqual([
        'FORM.ISSUE.TYPE',
        'FORM.ISSUE.MINIMUM',
        'FORM.ISSUE.MAX_LENGTH',
      ]);
    });

    it('disables the fieldsets', async () => {
      const { host, details, put, view } = await render();
      await put(['p1', READY]);
      const fieldsets = () => [...details()[0].querySelectorAll('fieldset')].map((f) => f.disabled);
      expect(fieldsets()).toEqual([false, false]);
      host.disabled.set(true);
      await view();
      expect(fieldsets()).toEqual([true, true]);
    });
  });

  it('shows the error as an alert linked to the stores', async () => {
    const { host, root, view } = await render();
    expect(root.querySelector('p.problem')).toBeNull();
    expect(root.querySelector('details')?.parentElement?.hasAttribute('aria-describedby')).toBe(false);
    host.error.set('Non valido');
    await view();
    const alert = root.querySelector('p.problem[role=alert]')!;
    expect(alert.textContent).toBe('Non valido');
    expect(root.querySelector('details')?.parentElement?.getAttribute('aria-describedby')).toBe(alert.id);
  });

  it('focuses the summary of the first store, and does nothing without stores', async () => {
    const { host, root, view, control } = await render();
    control.focus();
    expect(document.activeElement).toBe(root.querySelector('summary'));
    host.places.set([]);
    await view();
    expect(() => control.focus()).not.toThrow();
  });
});
