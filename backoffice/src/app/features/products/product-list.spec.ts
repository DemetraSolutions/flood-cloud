import { Provider, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { API, backend, errorBody, provideApiTesting, settle } from '../../../testing/api';
import { emulateNativeDialog } from '../../../testing/dialog';
import { PRODUCT_ID_1, PRODUCT_ID_2, PRODUCT_ID_3, productRow, SUPPLIER_ID } from '../../../testing/product-list-rows';
import { signIn } from '../../../testing/session';
import { AppConfig } from '../../core/config/app-config';
import { FeatureFlags } from '../../core/groups/feature-catalog';
import { I18nService } from '../../core/i18n/i18n.service';
import { ReferenceStore } from '../../core/reference/reference-store';
import { Profile } from '../../core/session/session.types';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { CategoryNode } from '../product-categories/category.types';
import { ProductList } from './product-list';
import { ProductRow } from './product.types';

const GROUP = '665f1c2e9b1d4a0012ab34a1';
const ROOT = '665f1c2e9b1d4a0012ab34c1';
const CHILD = '665f1c2e9b1d4a0012ab34c2';
const OTHER = '665f1c2e9b1d4a0012ab34c3';
const PL1 = '665f1c2e9b1d4a0012ab34e1';
const PL2 = '665f1c2e9b1d4a0012ab34e2';
const UNKNOWN_ID = '665f1c2e9b1d4a0012ab3aff';
const ALL = ['products:read', 'products:update', 'profile:read'];
const READ_ONLY = { permissions: ['products:read', 'profile:read'] };
const LIST = `${API}/v1/groups/${GROUP}/products`;
const TREE_URL = `${API}/v1/groups/${GROUP}/product-categories/tree`;
const PLACES_URL = `${API}/v1/groups/${GROUP}/places`;
const SUPPLIERS_URL = `${API}/v1/groups/${GROUP}/lookup/suppliers`;
const warehouse = { groupFeatures: { warehouse: true } as FeatureFlags };

const node = (id: string, name: string | null, children: CategoryNode[] = []): CategoryNode => ({
  id,
  name,
  parentId: null,
  position: 1,
  enabled: true,
  children,
});
const TREE = [node(ROOT, 'Bibite', [node(CHILD, 'Acqua')]), node(OTHER, null)];
const PLACES = [
  { id: PL1, name: 'Bar Centro' },
  { id: PL2, name: 'Bar Nord' },
];

const page = (data: ProductRow[], next: string | null = null) => ({ data, page: { limit: 25, next } });

interface Options {
  /** Path of the page (after `/groups/{group}/`). */
  path?: string;
  /** Answer of the reads of the filters: `fail` makes them fail. */
  lookups?: 'ok' | 'fail';
  /** Answer of the read of the name of the supplier of the filter. */
  supplierName?: 'known' | 'missing' | 'fail';
  language?: string;
  providers?: Provider[];
}

async function render(query = '', profile: Partial<Profile> = {}, options: Options = {}) {
  emulateNativeDialog();
  TestBed.configureTestingModule({
    providers: [
      ...provideApiTesting(),
      ...(options.providers ?? []),
      provideRouter(
        [
          { path: 'groups/:groupId/products', component: ProductList, data: { family: 'products' } },
          { path: 'groups/:groupId/services', component: ProductList, data: { family: 'services' } },
          { path: 'groups/:groupId/product-modifiers', component: ProductList, data: { family: 'modifiers' } },
          { path: 'groups/:groupId/tobacco-products', component: ProductList, data: { family: 'tgm' } },
          { path: 'groups/:groupId/bogus', component: ProductList, data: { family: 'toString' } },
          { path: 'groups/:groupId/plain', component: ProductList },
          { path: '**', children: [] },
        ],
        withComponentInputBinding(),
      ),
    ],
  });
  const i18n = TestBed.inject(I18nService);
  vi.spyOn(i18n, 't').mockImplementation((key, params) => (params === undefined ? key : `${key} ${JSON.stringify(params)}`));
  if (options.language !== undefined) {
    Object.defineProperty(i18n, 'language', { value: signal(options.language).asReadonly() });
  }
  signIn({ role: 'SA', permissions: ALL, ...profile });
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(`/groups/${GROUP}/${options.path ?? 'products'}${query}`);
  const root = harness.routeNativeElement as HTMLElement;
  document.body.appendChild(root);
  const view = async () => {
    await settle();
    harness.detectChanges();
    await settle();
    harness.detectChanges();
  };
  const request = () => backend().expectOne((r) => r.url === LIST && r.method === 'GET');
  const flush = async (data: ProductRow[], next: string | null = null) => {
    const req = request();
    req.flush(page(data, next));
    await view();
    return req;
  };
  const params = (req: ReturnType<typeof request>) =>
    Object.fromEntries(req.request.params.keys().map((k) => [k, req.request.params.get(k)]));
  /** Answers the reads of the category tree and of the stores. */
  const answerLookups = async () => {
    await view();
    for (const read of backend().match((r) => r.url === SUPPLIERS_URL && r.params.has('ids'))) {
      if (options.supplierName === 'fail') {
        read.flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' });
      } else {
        const data = options.supplierName === 'missing' ? [] : [{ id: SUPPLIER_ID, name: 'Rossi Srl' }];
        read.flush({ data, page: { limit: 100, next: null } });
      }
    }
    for (const read of backend().match((r) => r.url === TREE_URL || r.url === PLACES_URL)) {
      if (options.lookups === 'fail') {
        read.flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' });
      } else {
        read.flush(read.request.url === TREE_URL ? { data: TREE } : { data: PLACES, page: { limit: 100, next: null } });
      }
    }
    await view();
  };
  await answerLookups();
  const rows = () => [...root.querySelectorAll('tbody tr')];
  const cells = (row: number) => [...rows()[row]!.querySelectorAll('th, td')].map((c) => c.textContent?.trim());
  const headers = () => [...root.querySelectorAll('thead th')].map((c) => c.textContent?.trim());
  const search = () => new URL(TestBed.inject(Router).url, 'http://x').searchParams;
  const dialogButton = (text: string) =>
    [...root.querySelectorAll<HTMLButtonElement>('dialog[open] button')].find((b) => b.textContent?.trim() === text)!;
  const toasts = () => TestBed.inject(ToastService).toasts().map((t) => `${t.kind}: ${t.message}`);
  const checkboxes = () => [...root.querySelectorAll<HTMLInputElement>('td input[type=checkbox]')];
  const selectAll = () => root.querySelector<HTMLInputElement>('.bulk fc-checkbox input')!;
  const tick = async (input: HTMLInputElement, checked = true) => {
    input.checked = checked;
    input.dispatchEvent(new Event('change'));
    await view();
  };
  const selects = () => [...root.querySelectorAll<HTMLSelectElement>('form.filters fc-select select')];
  const choose = async (select: HTMLSelectElement, value: string) => {
    select.value = value;
    select.dispatchEvent(new Event('change'));
    await view();
  };
  const type = async (input: HTMLInputElement, value: string) => {
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await new Promise((resolve) => setTimeout(resolve, 350));
    await view();
  };
  const action = (row: number, label: string) =>
    rows()[row]!.querySelector<HTMLElement>(`[aria-label^="${label}"]`);
  return {
    root,
    view,
    request,
    flush,
    params,
    rows,
    cells,
    headers,
    search,
    dialogButton,
    toasts,
    checkboxes,
    selectAll,
    tick,
    selects,
    choose,
    type,
    action,
    answerLookups,
  };
}

/** Opens a page of rows with the lookups answered. */
async function open(rows: ProductRow[], query = '', profile: Partial<Profile> = {}, options: Options = {}) {
  const view = await render(query, profile, options);
  await view.flush(rows);
  return view;
}

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
  sessionStorage.clear();
});

describe('ProductList', () => {
  describe('table', () => {
    it('requests the first page by last change and shows the columns with the warehouse', async () => {
      const { request, params, view, root, headers, cells } = await render('', warehouse);
      const req = request();
      expect(params(req)).toEqual({ limit: '25', sort: '-updatedAt', family: 'products' });
      req.flush(
        page([
          productRow(PRODUCT_ID_1, {
            stock: { quantity: 7.5, composite: false },
            price: 12.5,
            lastSupplierId: SUPPLIER_ID,
            lastSupplierName: 'Rossi Srl',
          }),
          productRow(PRODUCT_ID_2, {
            code: null,
            name: null,
            enabled: false,
            updatedAt: null,
            stock: { quantity: 3, composite: true },
            editable: false,
            placeEditable: false,
          }),
          productRow(PRODUCT_ID_3, { name: 'Pane', editable: false, placeEditable: true }),
        ]),
      );
      await view();
      expect(root.querySelector('h1')?.textContent).toBe('PRODUCTS.FAMILY.PRODUCTS.TITLE');
      expect(root.querySelector('.hint')?.textContent).toBe('PRODUCTS.FAMILY.PRODUCTS.HINT');
      expect(headers().slice(0, 8)).toEqual([
        'PRODUCTS.COLUMN.SELECT',
        'PRODUCTS.COLUMN.CODE',
        'PRODUCTS.COLUMN.NAME',
        'PRODUCTS.COLUMN.STOCK',
        'PRODUCTS.COLUMN.PRICE',
        'PRODUCTS.COLUMN.LAST_SUPPLIER',
        'PRODUCTS.COLUMN.UPDATED',
        'PRODUCTS.COLUMN.STATE',
      ]);
      const first = cells(0);
      expect(first[1]).toBe('C-001');
      expect(first[2]).toBe('Acqua');
      expect(first[3]).toMatch(/^7[.,]5$/);
      expect(first[4]).toMatch(/^12[.,]50$/);
      expect(first[5]).toBe('Rossi Srl');
      expect(first[6]).toContain('2026');
      expect(first[7]).toContain('PRODUCT_CATALOG.STATE.ENABLED');
      const second = cells(1);
      expect(second.slice(1, 7)).toEqual(['', 'PRODUCTS.READ_ONLY_BADGE', 'C', '', '-', '']);
      expect(second[7]).toContain('PRODUCT_CATALOG.STATE.DISABLED');
      expect(cells(2)[2]).toBe('PanePRODUCTS.PARTIAL_BADGE');
      expect(cells(2)[3]).toBe('-');
    });

    it('has no stock column without the warehouse feature', async () => {
      const { flush, headers } = await render();
      await flush([productRow(PRODUCT_ID_1)]);
      expect(headers()).not.toContain('PRODUCTS.COLUMN.STOCK');
      expect(headers()).toContain('PRODUCTS.COLUMN.PRICE');
    });

    it('formats numbers and dates with the language of the app when it is known', async () => {
      const { flush, cells } = await render('', warehouse, { language: 'it' });
      await flush([
        productRow(PRODUCT_ID_1, { stock: { quantity: 12345.5, composite: false }, price: 9.5 }),
      ]);
      expect(cells(0)[3]).toBe('12.345,5');
      expect(cells(0)[4]).toBe('9,50');
    });

    it('shows the loading state, then the empty one with the way to create', async () => {
      const { request, view, root } = await render();
      expect(root.querySelector('fc-skeleton')).not.toBeNull();
      request().flush(page([]));
      await view();
      expect(root.querySelector('fc-empty-state')?.textContent).toContain('PRODUCTS.FAMILY.PRODUCTS.EMPTY');
      expect(root.querySelector('fc-empty-state a')?.getAttribute('href')).toBe(`/groups/${GROUP}/products/new`);
    });

    it('offers to create, also quickly, only with products:update', async () => {
      const allowed = await render();
      await allowed.flush([]);
      const links = [...allowed.root.querySelectorAll<HTMLAnchorElement>('.new a')];
      expect(links.map((a) => a.textContent?.trim())).toEqual(['PRODUCTS.FAMILY.PRODUCTS.NEW', 'PRODUCTS.NEW_QUICK']);
      expect(links.map((a) => a.getAttribute('href'))).toEqual([
        `/groups/${GROUP}/products/new`,
        `/groups/${GROUP}/products/new?view=quick`,
      ]);
      document.body.replaceChildren();
      TestBed.resetTestingModule();
      const limited = await render('', READ_ONLY);
      await limited.flush([]);
      expect(limited.root.querySelector('.new')).toBeNull();
      expect(limited.root.querySelector('fc-empty-state a')).toBeNull();
    });

    it('shows the error state with the request id and retries', async () => {
      const { request, view, root } = await render();
      request().flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x', headers: { 'X-Request-Id': 'req-3' } });
      await view();
      const state = root.querySelector('fc-error-state')!;
      expect(state.textContent).toContain('PRODUCT_CATALOG.LOAD_ERROR');
      expect(state.textContent).toContain('ERRORS.API.INTERNAL_ERROR');
      expect(state.textContent).toContain('req-3');
      expect(root.querySelector('.bulk')).toBeNull();
      state.querySelector('button')!.click();
      await view();
      request().flush(page([productRow(PRODUCT_ID_1)]));
      await view();
      expect(root.querySelector('fc-error-state')).toBeNull();
      expect(root.querySelectorAll('tbody tr')).toHaveLength(1);
    });

    it('shows the generic error for a failure that is not an API error', async () => {
      const { view, root } = await render('', {}, { providers: [{ provide: AppConfig, useValue: { apiBaseUrl: signal(null) } }] });
      await view();
      expect(root.querySelector('fc-error-state')?.textContent).toContain('ERRORS.GENERIC.MESSAGE');
    });
  });

  describe('families', () => {
    it.each([
      ['products', 'products', 'PRODUCTS'],
      ['services', 'services', 'SERVICES'],
      ['modifiers', 'product-modifiers', 'MODIFIERS'],
      ['tgm', 'tobacco-products', 'TOBACCOS'],
    ])('lists the %s with its own texts and links', async (family, segment, text) => {
      const { request, params, view, root } = await render('', {}, { path: segment });
      const req = request();
      expect(params(req)['family']).toBe(family);
      req.flush(page([productRow(PRODUCT_ID_1, { family: family as ProductRow['family'] })]));
      await view();
      expect(root.querySelector('h1')?.textContent).toBe(`PRODUCTS.FAMILY.${text}.TITLE`);
      expect(root.querySelector('.hint')?.textContent).toBe(`PRODUCTS.FAMILY.${text}.HINT`);
      expect(root.querySelector('table caption')?.textContent?.trim()).toBe(`PRODUCTS.FAMILY.${text}.TITLE`);
      expect(root.querySelector('.new a')?.getAttribute('href')).toBe(`/groups/${GROUP}/${segment}/new`);
      // The Import / Export page is the only place that imports or exports; the tobaccos are not in the file.
      expect(root.querySelector('a.import-export')?.getAttribute('href') ?? null).toBe(
        family === 'tgm' ? null : `/groups/${GROUP}/tools/catalog-import-export`,
      );
    });

    it('links to the Import / Export page also to who can only read', async () => {
      const { flush, root } = await render('', READ_ONLY);
      await flush([]);
      const link = root.querySelector('a.import-export');
      expect(link?.textContent?.trim()).toBe('CATALOG_XLSX.LINK');
      expect(link?.getAttribute('href')).toBe(`/groups/${GROUP}/tools/catalog-import-export`);
    });

    it('lists the products when the route has no family or an unknown one', async () => {
      const missing = await render('', {}, { path: 'plain' });
      const first = missing.request();
      expect(missing.params(first)['family']).toBe('products');
      first.flush(page([]));
      document.body.replaceChildren();
      TestBed.resetTestingModule();
      const unknown = await render('', {}, { path: 'bogus' });
      const second = unknown.request();
      expect(unknown.params(second)['family']).toBe('products');
      second.flush(page([]));
    });
  });

  describe('parameters in the URL', () => {
    it('reads all of them from the URL', async () => {
      const { request, params, view, selects, root } = await render(
        `?q=%20bib%20&categoryId=${CHILD}&supplierId=${SUPPLIER_ID}&placeId=${PL2}&favorite=true&enabled=false&sort=-code&limit=50&cursor=abc`,
      );
      const req = request();
      expect(params(req)).toEqual({
        limit: '50',
        sort: '-code',
        family: 'products',
        q: 'bib',
        categoryId: CHILD,
        supplierId: SUPPLIER_ID,
        placeId: PL2,
        favorite: 'true',
        enabled: 'false',
        cursor: 'abc',
      });
      await view();
      expect(selects().map((s) => s.value)).toEqual([CHILD, PL2, 'false']);
      expect(root.querySelector<HTMLInputElement>('.filters fc-checkbox input')!.checked).toBe(true);
      req.flush(page([]));
    });

    it('ignores what is not valid', async () => {
      const { request, params, view, root } = await render(
        '?q=%20&categoryId=zzz&supplierId=zzz&placeId=zzz&favorite=no&enabled=x&sort=price&limit=7',
      );
      const req = request();
      expect(params(req)).toEqual({ limit: '25', sort: '-updatedAt', family: 'products' });
      await view();
      expect(root.querySelector<HTMLInputElement>('fc-search-combobox input')!.value).toBe('');
      expect(root.querySelector<HTMLInputElement>('.filters fc-checkbox input')!.checked).toBe(false);
      req.flush(page([]));
    });

    it('shows the sort of the URL in the header', async () => {
      const { flush, root } = await render('?sort=name');
      await flush([productRow(PRODUCT_ID_1)]);
      const sorted = [...root.querySelectorAll('th')].filter((th) => th.getAttribute('aria-sort') !== null);
      expect(sorted.map((th) => [th.textContent?.trim(), th.getAttribute('aria-sort')])).toContainEqual([
        'PRODUCTS.COLUMN.NAME',
        'ascending',
      ]);
    });
  });

  describe('filters', () => {
    it('offers the categories as an indented tree and the stores as a list', async () => {
      const { flush, selects } = await render();
      await flush([]);
      const [category, place, state] = selects();
      expect([...category!.options].map((o) => o.textContent?.trim())).toEqual([
        'PRODUCTS.FILTER.ALL_CATEGORIES',
        'Bibite',
        '– Acqua',
        'PRODUCT_CATEGORIES.NO_NAME',
      ]);
      expect([...place!.options].map((o) => o.textContent?.trim())).toEqual([
        'PRODUCTS.FILTER.ALL_PLACES',
        'Bar Centro',
        'Bar Nord',
      ]);
      expect([...state!.options].map((o) => o.value)).toEqual(['', 'true', 'false']);
    });

    it('leaves the filters with their first option when they cannot be read', async () => {
      const { flush, selects } = await render('', {}, { lookups: 'fail' });
      await flush([]);
      const [category, place] = selects();
      expect(category!.options).toHaveLength(1);
      expect(place!.options).toHaveLength(1);
    });

    it('filters by category, store and state, and clears each filter', async () => {
      const { flush, selects, choose, search, request, params } = await render();
      await flush([]);
      const [category, place, state] = selects();
      const cases: [HTMLSelectElement, string, string, string][] = [
        [category!, CHILD, 'categoryId', CHILD],
        [place!, PL1, 'placeId', PL1],
        [state!, 'true', 'enabled', 'true'],
      ];
      for (const [select, value, name, sent] of cases) {
        await choose(select, value);
        expect(search().get(name)).toBe(value);
        const req = request();
        expect(params(req)[name]).toBe(sent);
        req.flush(page([]));
        await choose(select, '');
        expect(search().has(name)).toBe(false);
        await flush([]);
      }
    });

    it('filters by favorites', async () => {
      const { flush, root, view, search, request, params } = await render();
      await flush([]);
      const box = root.querySelector<HTMLInputElement>('.filters fc-checkbox input')!;
      box.checked = true;
      box.dispatchEvent(new Event('change'));
      await view();
      expect(search().get('favorite')).toBe('true');
      const req = request();
      expect(params(req)['favorite']).toBe('true');
      req.flush(page([]));
      await view();
      box.checked = false;
      box.dispatchEvent(new Event('change'));
      await view();
      expect(search().has('favorite')).toBe(false);
      await flush([]);
    });

    it('puts the search in the URL once typing pauses, and clears it', async () => {
      const { flush, root, search, type } = await render();
      await flush([]);
      const input = root.querySelector<HTMLInputElement>('input[type=search]')!;
      await type(input, 'bib ');
      expect(search().get('q')).toBe('bib');
      await flush([]);
      await type(input, ' ');
      expect(search().has('q')).toBe(false);
      await flush([]);
      const event = new Event('submit', { cancelable: true });
      root.querySelector('form')!.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    });

    const combobox = (root: HTMLElement) => root.querySelector<HTMLInputElement>('fc-search-combobox input')!;
    const suppliersRead = () =>
      backend().expectOne((r) => r.url === SUPPLIERS_URL && !r.params.has('ids'));

    it('searches the suppliers on the server, chooses one and clears the choice', async () => {
      const { flush, root, view, search, request, params } = await render();
      await flush([]);
      combobox(root).dispatchEvent(new Event('focus'));
      await view();
      const first = suppliersRead();
      expect(first.request.params.get('limit')).toBe('25');
      expect(first.request.params.has('q')).toBe(false);
      first.flush({
        data: [
          { id: SUPPLIER_ID, name: 'Rossi Srl' },
          { id: UNKNOWN_ID, name: 'Verdi Spa' },
        ],
        page: { limit: 25, next: null },
      });
      await view();
      const options = [...root.querySelectorAll<HTMLElement>('fc-search-combobox [role=option]')];
      expect(options.map((o) => o.textContent?.trim())).toEqual(['Rossi Srl', 'Verdi Spa']);
      options[0]!.click();
      await view();
      expect(search().get('supplierId')).toBe(SUPPLIER_ID);
      const req = request();
      expect(params(req)['supplierId']).toBe(SUPPLIER_ID);
      req.flush(page([]));
      await view();
      for (const read of backend().match((r) => r.url === SUPPLIERS_URL && r.params.has('ids'))) {
        read.flush({ data: [{ id: SUPPLIER_ID, name: 'Rossi Srl' }], page: { limit: 100, next: null } });
      }
      await view();
      expect(combobox(root).value).toBe('Rossi Srl');
      root.querySelector<HTMLButtonElement>('fc-search-combobox button')!.click();
      await view();
      expect(search().has('supplierId')).toBe(false);
      await flush([]);
    });

    it('asks the server for the text typed', async () => {
      const { flush, root, view } = await render();
      await flush([]);
      const input = combobox(root);
      input.dispatchEvent(new Event('focus'));
      await view();
      suppliersRead().flush({ data: [], page: { limit: 25, next: null } });
      await view();
      input.value = 'ros';
      input.dispatchEvent(new Event('input'));
      await new Promise((resolve) => setTimeout(resolve, 300));
      await view();
      const read = suppliersRead();
      expect(read.request.params.get('q')).toBe('ros');
      expect(read.request.params.get('limit')).toBe('25');
      read.flush({ data: [], page: { limit: 25, next: null } });
      await view();
    });

    it('shows the name of the supplier of the URL, and nothing for one that is not found or cannot be read', async () => {
      const known = await render(`?supplierId=${SUPPLIER_ID}`);
      await known.flush([]);
      expect(combobox(known.root).value).toBe('Rossi Srl');
      document.body.replaceChildren();
      TestBed.resetTestingModule();
      const missing = await render(`?supplierId=${SUPPLIER_ID}`, {}, { supplierName: 'missing' });
      await missing.flush([]);
      expect(combobox(missing.root).value).toBe('');
      document.body.replaceChildren();
      TestBed.resetTestingModule();
      const failed = await render(`?supplierId=${SUPPLIER_ID}`, {}, { supplierName: 'fail' });
      await failed.flush([]);
      expect(combobox(failed.root).value).toBe('');
    });
  });

  describe('sort and pagination', () => {
    it('sorts by code, name and last change, both ways', async () => {
      const { flush, root, view, search } = await render();
      await flush([productRow(PRODUCT_ID_1)]);
      const sorts = () => [...root.querySelectorAll<HTMLButtonElement>('th button.sort')];
      const click = async (index: number, expected: string) => {
        sorts()[index]!.click();
        await view();
        expect(search().get('sort')).toBe(expected);
        await flush([productRow(PRODUCT_ID_1)]);
      };
      await click(0, 'code');
      await click(0, '-code');
      await click(1, 'name');
      await click(2, 'updatedAt');
      await click(2, '-updatedAt');
    });

    it('changes the page size and walks the pages back and forth', async () => {
      const { flush, root, view, search } = await render();
      await flush([productRow(PRODUCT_ID_1)], 'c1');
      const [previous, next] = [...root.querySelectorAll<HTMLButtonElement>('fc-cursor-paginator .buttons button')];
      expect(previous!.disabled).toBe(true);
      next!.click();
      await view();
      expect(search().get('cursor')).toBe('c1');
      await flush([productRow(PRODUCT_ID_1)], 'c2');
      next!.click();
      await view();
      expect(search().get('cursor')).toBe('c2');
      await flush([productRow(PRODUCT_ID_1)]);
      previous!.click();
      await view();
      expect(search().get('cursor')).toBe('c1');
      await flush([productRow(PRODUCT_ID_1)], 'c2');
      previous!.click();
      await view();
      expect(search().has('cursor')).toBe(false);
      await flush([productRow(PRODUCT_ID_1)], 'c1');
      const select = root.querySelector<HTMLSelectElement>('fc-cursor-paginator select')!;
      select.value = '50';
      select.dispatchEvent(new Event('change'));
      await view();
      expect(search().get('limit')).toBe('50');
      await flush([productRow(PRODUCT_ID_1)]);
    });
  });

  describe('selection', () => {
    const rows3 = () => [
      productRow(PRODUCT_ID_1, { name: 'Acqua' }),
      productRow(PRODUCT_ID_2, { name: 'Birra' }),
      productRow(PRODUCT_ID_3, { name: 'Pane', editable: false }),
    ];

    it('selects only the products the user can change, one by one or all', async () => {
      const { checkboxes, selectAll, tick, root } = await open(rows3());
      expect(checkboxes().map((box) => box.disabled)).toEqual([false, false, true]);
      expect(checkboxes().map((box) => box.getAttribute('aria-label'))).toEqual([
        'PRODUCTS.SELECT_ROW {"name":"Acqua"}',
        'PRODUCTS.SELECT_ROW {"name":"Birra"}',
        'PRODUCTS.SELECT_ROW {"name":"Pane"}',
      ]);
      expect(root.querySelector('.bulk [role=status]')).toBeNull();
      expect(selectAll().checked).toBe(false);
      await tick(checkboxes()[0]!);
      expect(root.querySelector('.bulk [role=status]')?.textContent).toBe('PRODUCTS.SELECTED {"count":1}');
      expect(selectAll().checked).toBe(false);
      await tick(checkboxes()[1]!);
      expect(selectAll().checked).toBe(true);
      await tick(checkboxes()[0]!, false);
      expect(selectAll().checked).toBe(false);
      await tick(selectAll());
      expect(checkboxes().map((box) => box.checked)).toEqual([true, true, false]);
      expect(root.querySelector('.bulk [role=status]')?.textContent).toBe('PRODUCTS.SELECTED {"count":2}');
      await tick(selectAll(), false);
      expect(checkboxes().some((box) => box.checked)).toBe(false);
      expect(root.querySelector('.bulk [role=status]')).toBeNull();
    });

    it('has no "select all" when nothing can be selected, and nothing at all without products:update', async () => {
      const none = await open([productRow(PRODUCT_ID_1, { editable: false })]);
      expect(none.root.querySelector('.bulk fc-checkbox')).toBeNull();
      document.body.replaceChildren();
      TestBed.resetTestingModule();
      const limited = await open(rows3(), '', READ_ONLY);
      expect(limited.root.querySelector('.bulk')).toBeNull();
    });
  });

  describe('row actions', () => {
    const item = (id: string) => `${LIST}/${id}`;
    const product = productRow(PRODUCT_ID_1, { name: 'Acqua' });

    it('opens, quick-edits, duplicates, turns off and trashes a product the user can change', async () => {
      const { action, rows } = await open([product]);
      expect(action(0, 'PRODUCTS.EDIT_LABEL')?.getAttribute('href')).toBe(`/groups/${GROUP}/products/${PRODUCT_ID_1}`);
      expect(action(0, 'PRODUCTS.EDIT_LABEL')?.getAttribute('aria-label')).toBe('PRODUCTS.EDIT_LABEL {"name":"Acqua"}');
      expect(action(0, 'PRODUCTS.QUICK_EDIT_LABEL')?.getAttribute('href')).toBe(
        `/groups/${GROUP}/products/${PRODUCT_ID_1}?view=quick`,
      );
      expect(action(0, 'PRODUCTS.DUPLICATE.LABEL')).not.toBeNull();
      expect(action(0, 'PRODUCTS.ENABLE.OFF_LABEL')?.textContent?.trim()).toBe('PRODUCTS.ENABLE.OFF_ACTION');
      expect(action(0, 'PRODUCTS.TRASH.LABEL')).not.toBeNull();
      expect(rows()).toHaveLength(1);
    });

    it('opens the detail of a product in its own family', async () => {
      const { action } = await open([productRow(PRODUCT_ID_1, { family: 'services' })]);
      expect(action(0, 'PRODUCTS.EDIT_LABEL')?.getAttribute('href')).toBe(`/groups/${GROUP}/services/${PRODUCT_ID_1}`);
    });

    it('offers only the editing of a product that is not entirely the user\'s', async () => {
      const { action } = await open([productRow(PRODUCT_ID_1, { editable: false })]);
      expect(action(0, 'PRODUCTS.EDIT_LABEL')).not.toBeNull();
      expect(action(0, 'PRODUCTS.QUICK_EDIT_LABEL')).not.toBeNull();
      expect(action(0, 'PRODUCTS.DUPLICATE.LABEL')).toBeNull();
      expect(action(0, 'PRODUCTS.ENABLE')).toBeNull();
      expect(action(0, 'PRODUCTS.TRASH.LABEL')).toBeNull();
    });

    it('offers only the opening without products:update', async () => {
      const { action, rows } = await open([product], '', READ_ONLY);
      expect(action(0, 'PRODUCTS.EDIT_LABEL')).not.toBeNull();
      expect(rows()[0]!.querySelectorAll('td:last-child a, td:last-child button')).toHaveLength(1);
    });

    it('duplicates with an Idempotency-Key, says so and reads the list again', async () => {
      const view = await open([product]);
      const invalidate = vi.spyOn(TestBed.inject(ReferenceStore), 'invalidate');
      view.action(0, 'PRODUCTS.DUPLICATE.LABEL')!.click();
      await view.view();
      const req = backend().expectOne(`${item(PRODUCT_ID_1)}/duplicate`);
      expect(req.request.method).toBe('POST');
      expect(req.request.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
      expect(view.action(0, 'PRODUCTS.DUPLICATE.LABEL')!.hasAttribute('disabled')).toBe(true);
      req.flush({ data: { id: PRODUCT_ID_2 } }, { status: 201, statusText: 'Created', headers: { ETag: '"1"' } });
      await view.view();
      expect(view.toasts()).toEqual(['success: PRODUCTS.DUPLICATE.DONE {"name":"Acqua"}']);
      expect(invalidate).toHaveBeenCalledWith(GROUP, 'products');
      await view.flush([product, productRow(PRODUCT_ID_2)]);
      expect(view.rows()).toHaveLength(2);
    });

    it('shows the refusal of a duplication in a toast', async () => {
      const view = await open([product]);
      view.action(0, 'PRODUCTS.DUPLICATE.LABEL')!.click();
      await view.view();
      backend()
        .expectOne(`${item(PRODUCT_ID_1)}/duplicate`)
        .flush(errorBody('FORBIDDEN'), { status: 403, statusText: 'x' });
      await view.view();
      expect(view.toasts()).toEqual(['error: ERRORS.API.FORBIDDEN']);
      expect(view.action(0, 'PRODUCTS.DUPLICATE.LABEL')!.hasAttribute('disabled')).toBe(false);
    });

    it('turns a product off: reads it, then changes only its state with its version', async () => {
      const view = await open([product]);
      view.action(0, 'PRODUCTS.ENABLE.OFF_LABEL')!.click();
      await view.view();
      const read = backend().expectOne(item(PRODUCT_ID_1));
      expect(read.request.method).toBe('GET');
      read.flush({ data: {} }, { headers: { ETag: '"v7"' } });
      await view.view();
      const write = backend().expectOne(item(PRODUCT_ID_1));
      expect(write.request.method).toBe('PATCH');
      expect(write.request.body).toEqual({ enabled: false });
      expect(write.request.headers.get('If-Match')).toBe('"v7"');
      write.flush({ data: {} }, { headers: { ETag: '"v8"' } });
      await view.view();
      expect(view.toasts()).toEqual(['success: PRODUCTS.ENABLE.OFF {"name":"Acqua"}']);
      await view.flush([{ ...product, enabled: false }]);
      expect(view.action(0, 'PRODUCTS.ENABLE.ON_LABEL')?.textContent?.trim()).toBe('PRODUCTS.ENABLE.ON_ACTION');
    });

    it('turns a product on', async () => {
      const view = await open([productRow(PRODUCT_ID_1, { name: 'Acqua', enabled: false })]);
      view.action(0, 'PRODUCTS.ENABLE.ON_LABEL')!.click();
      await view.view();
      backend().expectOne(item(PRODUCT_ID_1)).flush({ data: {} }, { headers: { ETag: '"v1"' } });
      await view.view();
      const write = backend().expectOne(item(PRODUCT_ID_1));
      expect(write.request.body).toEqual({ enabled: true });
      write.flush({ data: {} });
      await view.view();
      expect(view.toasts()).toEqual(['success: PRODUCTS.ENABLE.ON {"name":"Acqua"}']);
      await view.flush([product]);
    });

    it('says why a product could not be turned off and reads the list again', async () => {
      const view = await open([product]);
      view.action(0, 'PRODUCTS.ENABLE.OFF_LABEL')!.click();
      await view.view();
      backend().expectOne(item(PRODUCT_ID_1)).flush(errorBody('NOT_FOUND'), { status: 404, statusText: 'x' });
      await view.view();
      expect(view.toasts()).toEqual(['error: ERRORS.API.NOT_FOUND']);
      await view.flush([]);
    });

    it('asks for confirmation naming the product, and does nothing when the user cancels', async () => {
      const view = await open([product]);
      view.action(0, 'PRODUCTS.TRASH.LABEL')!.click();
      await view.view();
      const dialog = view.root.querySelector('dialog[open]')!;
      expect(dialog.textContent).toContain('PRODUCTS.TRASH.TITLE');
      expect(dialog.textContent).toContain('PRODUCTS.TRASH.CONFIRM_ONE {"name":"Acqua"}');
      expect(view.dialogButton('PRODUCTS.TRASH.ACTION').getAttribute('data-variant')).toBe('danger');
      view.dialogButton('COMMON.CANCEL').click();
      await view.view();
      expect(view.root.querySelector('dialog[open]')).toBeNull();
    });

    it('names a product without a name as nothing in the confirmation', async () => {
      const view = await open([productRow(PRODUCT_ID_1, { name: null })]);
      view.action(0, 'PRODUCTS.TRASH.LABEL')!.click();
      await view.view();
      expect(view.root.querySelector('dialog[open]')!.textContent).toContain('PRODUCTS.TRASH.CONFIRM_ONE {"name":""}');
    });

    it('moves the product to the trash once confirmed and reports it', async () => {
      const view = await open([product]);
      const invalidate = vi.spyOn(TestBed.inject(ReferenceStore), 'invalidate');
      view.action(0, 'PRODUCTS.TRASH.LABEL')!.click();
      await view.view();
      view.dialogButton('PRODUCTS.TRASH.ACTION').click();
      await view.view();
      const req = backend().expectOne(`${LIST}/trash`);
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({ ids: [PRODUCT_ID_1] });
      expect(req.request.headers.has('If-Match')).toBe(false);
      req.flush({ data: { results: [{ id: PRODUCT_ID_1, outcome: 'trashed' }] } });
      await view.view();
      expect(view.root.querySelector('dialog[open]')).toBeNull();
      const report = view.root.querySelector('.report')!;
      expect(report.getAttribute('role')).toBe('status');
      expect(report.textContent).toContain('PRODUCTS.TRASH.REPORT_TRASHED {"count":1}');
      expect(report.querySelector('ul')).toBeNull();
      expect(invalidate).toHaveBeenCalledWith(GROUP, 'products');
      await view.flush([]);
    });
  });

  describe('bulk trash', () => {
    const rows = () => [
      productRow(PRODUCT_ID_1, { name: 'Acqua' }),
      productRow(PRODUCT_ID_2, { name: 'Birra' }),
      productRow(PRODUCT_ID_3, { name: null }),
      productRow(UNKNOWN_ID, { name: 'Pane', editable: false }),
    ];
    const start = async () => {
      const view = await open(rows());
      await view.tick(view.selectAll());
      return view;
    };

    it('asks for confirmation with the count, then reports what happened to each product', async () => {
      const view = await start();
      const invalidate = vi.spyOn(TestBed.inject(ReferenceStore), 'invalidate');
      view.root.querySelector<HTMLButtonElement>('.bulk button')!.click();
      await view.view();
      expect(view.root.querySelector('dialog[open]')!.textContent).toContain('PRODUCTS.TRASH.CONFIRM {"count":3}');
      view.dialogButton('PRODUCTS.TRASH.ACTION').click();
      await view.view();
      const req = backend().expectOne(`${LIST}/trash`);
      expect(req.request.body).toEqual({ ids: [PRODUCT_ID_1, PRODUCT_ID_2, PRODUCT_ID_3] });
      req.flush({
        data: {
          results: [
            { id: PRODUCT_ID_1, outcome: 'trashed' },
            { id: PRODUCT_ID_2, outcome: 'skipped', issue: 'conflict' },
            { id: PRODUCT_ID_3, outcome: 'skipped' },
            { id: UNKNOWN_ID, outcome: 'skipped', issue: 'alreadyTrashed' },
          ],
        },
      });
      await view.view();
      expect(view.root.querySelector('dialog[open]')).toBeNull();
      const report = view.root.querySelector('.report')!;
      expect(report.querySelector('h2')?.textContent).toBe('PRODUCTS.TRASH.REPORT_TITLE');
      expect(report.textContent).toContain('PRODUCTS.TRASH.REPORT_TRASHED {"count":1}');
      expect(report.textContent).toContain('PRODUCTS.TRASH.REPORT_SKIPPED {"count":3}');
      expect([...report.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
        'PRODUCTS.TRASH.REPORT_ITEM {"name":"Birra","issue":"PRODUCTS.TRASH.ISSUE.CONFLICT"}',
        'PRODUCTS.TRASH.REPORT_ITEM {"name":"","issue":"PRODUCTS.TRASH.ISSUE.NOTFOUND"}',
        `PRODUCTS.TRASH.REPORT_ITEM {"name":"${UNKNOWN_ID}","issue":"PRODUCTS.TRASH.ISSUE.ALREADYTRASHED"}`,
      ]);
      expect(invalidate).toHaveBeenCalledWith(GROUP, 'products');
      await view.flush([]);
      view.root.querySelector<HTMLButtonElement>('.report button')!.click();
      await view.view();
      expect(view.root.querySelector('.report')).toBeNull();
    });

    it('does nothing when the user cancels', async () => {
      const view = await start();
      view.root.querySelector<HTMLButtonElement>('.bulk button')!.click();
      await view.view();
      view.dialogButton('COMMON.CANCEL').click();
      await view.view();
      expect(view.root.querySelector('dialog[open]')).toBeNull();
      expect(view.root.querySelector('.report')).toBeNull();
    });

    it('shows a failure of the service in a toast, without a report', async () => {
      const view = await start();
      view.root.querySelector<HTMLButtonElement>('.bulk button')!.click();
      await view.view();
      view.dialogButton('PRODUCTS.TRASH.ACTION').click();
      await view.view();
      backend().expectOne(`${LIST}/trash`).flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' });
      await view.view();
      expect(view.toasts()).toEqual(['error: ERRORS.API.INTERNAL_ERROR']);
      expect(view.root.querySelector('.report')).toBeNull();
      expect(view.root.querySelector('dialog[open]')).toBeNull();
    });
  });
});
