import { Provider, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { API, backend, errorBody, provideApiTesting, settle } from '../../../testing/api';
import { emulateNativeDialog } from '../../../testing/dialog';
import { signIn } from '../../../testing/session';
import { AppConfig } from '../../core/config/app-config';
import { FeatureFlags } from '../../core/groups/feature-catalog';
import { I18nService } from '../../core/i18n/i18n.service';
import { ReferenceApi } from '../../core/reference/reference-api';
import { ReferenceStore } from '../../core/reference/reference-store';
import { Profile } from '../../core/session/session.types';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { CategoryList } from './category-list';
import { Category, CategoryNode } from './category.types';

const GROUP = '665f1c2e9b1d4a0012ab34a1';
const ROOT = '665f1c2e9b1d4a0012ab34c1';
const CHILD = '665f1c2e9b1d4a0012ab34c2';
const OTHER = '665f1c2e9b1d4a0012ab34c3';
const P1 = '665f1c2e9b1d4a0012ab34d1';
const P2 = '665f1c2e9b1d4a0012ab34d2';
const PL1 = '665f1c2e9b1d4a0012ab34e1';
const PROMO = '665f1c2e9b1d4a0012ab34f1';
const ALL = ['products:read', 'products:update', 'profile:read'];
const LIST = `${API}/v1/groups/${GROUP}/product-categories`;

const category = (id: string, over: Partial<Category> = {}): Category => ({
  id,
  parentId: null,
  depth: 0,
  cyclic: false,
  name: { it: 'Bibite', en: 'Drinks' },
  description: {},
  enabled: true,
  position: 1,
  productionValue: null,
  noDiscount: false,
  requiresLegalAge: false,
  integrations: { floodOrders: false, yellgo: false, leggimenu: false },
  textColor: null,
  places: [],
  createdAt: null,
  updatedAt: null,
  ...over,
});
const node = (id: string, name: string | null, children: CategoryNode[] = [], enabled = true): CategoryNode => ({
  id,
  name,
  parentId: null,
  position: 1,
  enabled,
  children,
});

const page = (data: Category[], next: string | null = null) => ({ data, page: { limit: 25, next } });
const TREE = [node(ROOT, 'Bibite', [node(CHILD, 'Acqua', [], false)]), node(OTHER, null)];

interface FakeReference {
  lookupNames: ReturnType<typeof vi.fn>;
  placeNames: ReturnType<typeof vi.fn>;
}

async function render(query = '', profile: Partial<Profile> = {}, extra: Provider[] = []) {
  emulateNativeDialog();
  TestBed.configureTestingModule({
    providers: [
      ...provideApiTesting(),
      ...extra,
      provideRouter(
        [
          { path: 'groups/:groupId/product-categories', component: CategoryList },
          { path: '**', children: [] },
        ],
        withComponentInputBinding(),
      ),
    ],
  });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  signIn({ role: 'SA', permissions: ALL, ...profile });
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(`/groups/${GROUP}/product-categories${query}`);
  const root = harness.routeNativeElement as HTMLElement;
  document.body.appendChild(root);
  const view = async () => {
    await settle();
    harness.detectChanges();
    await settle();
    harness.detectChanges();
  };
  const request = () => backend().expectOne((r) => r.url === LIST);
  const treeRequest = () => backend().expectOne(`${LIST}/tree`);
  const flush = async (data: Category[], next: string | null = null) => {
    const req = request();
    req.flush(page(data, next));
    await view();
    return req;
  };
  const flushTree = async (nodes: CategoryNode[] = TREE) => {
    treeRequest().flush({ data: nodes });
    await view();
  };
  const params = (req: ReturnType<typeof request>) =>
    Object.fromEntries(req.request.params.keys().map((k) => [k, req.request.params.get(k)]));
  const cells = (row: number) =>
    [...root.querySelectorAll('tbody tr')[row]!.querySelectorAll('th, td')].map((c) => c.textContent?.trim());
  const headers = () => [...root.querySelectorAll('thead th')].map((c) => c.textContent?.trim());
  const search = () => new URL(TestBed.inject(Router).url, 'http://x').searchParams;
  const dialogButton = (text: string) =>
    [...root.querySelectorAll<HTMLButtonElement>('dialog[open] button')].find((b) => b.textContent?.trim() === text)!;
  const toasts = () => TestBed.inject(ToastService).toasts().map((t) => `${t.kind}: ${t.message}`);
  const viewButtons = () => [...root.querySelectorAll<HTMLButtonElement>('.views button')];
  return { root, view, request, treeRequest, flush, flushTree, params, cells, headers, search, dialogButton, toasts, viewButtons };
}

const cashFlags = { cash: true } as FeatureFlags;
const readOnly = { permissions: ['products:read', 'profile:read'] };

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
  sessionStorage.clear();
});

describe('CategoryList', () => {
  describe('table', () => {
    it('requests the first page sorted by name and shows the columns without cash', async () => {
      const { request, params, flushTree, view, root, headers, cells } = await render();
      const req = request();
      expect(params(req)).toEqual({ limit: '25', sort: 'name' });
      req.flush(
        page([
          category(CHILD, {
            parentId: ROOT,
            depth: 1,
            position: 3,
            availability: { pos: true },
            updatedAt: '2026-05-01T10:30:00.000Z',
          }),
          category(ROOT, { enabled: false, position: null, name: { en: 'Food' } }),
        ]),
      );
      await flushTree();
      await view();
      expect(root.querySelector('h1')?.textContent).toBe('PRODUCT_CATEGORIES.TITLE');
      expect(headers().slice(0, 5)).toEqual([
        'PRODUCT_CATEGORIES.COLUMN.NAME',
        'PRODUCT_CATEGORIES.COLUMN.PARENT',
        'PRODUCT_CATEGORIES.COLUMN.POSITION',
        'PRODUCT_CATEGORIES.COLUMN.STATE',
        'PRODUCT_CATEGORIES.COLUMN.UPDATED',
      ]);
      expect(cells(0)[0]).toBe('Bibite');
      expect(cells(0)[1]).toBe('Bibite');
      expect(cells(0)[2]).toBe('3');
      expect(cells(0)[3]).toContain('PRODUCT_CATALOG.STATE.ENABLED');
      expect(cells(0)[4]).toContain('2026');
      expect(cells(1).slice(0, 5)).toEqual(['Food', '', '', 'PRODUCT_CATALOG.STATE.DISABLED', '']);
      expect(root.querySelector('a.new')?.getAttribute('href')).toBe(`/groups/${GROUP}/product-categories/new`);
      const link = root.querySelector('a.import-export');
      expect(link?.textContent?.trim()).toBe('CATALOG_XLSX.LINK');
      expect(link?.getAttribute('href')).toBe(`/groups/${GROUP}/tools/catalog-import-export`);
    });

    it('names the parent from the tree, the hidden one with a notice, an unknown one with nothing', async () => {
      const { flush, flushTree, cells } = await render();
      await flush([
        category(CHILD, { parentId: ROOT }),
        category(OTHER, { parentId: null, parentHidden: true }),
        category(P1, { parentId: P2 }),
        category(P2, { parentId: null }),
      ]);
      await flushTree();
      expect(cells(0)[1]).toBe('Bibite');
      expect(cells(1)[1]).toBe('PRODUCT_CATEGORIES.PARENT_HIDDEN');
      expect(cells(2)[1]).toBe('');
      expect(cells(3)[1]).toBe('');
    });

    it('shows the cash column only with the feature, empty when the value is missing', async () => {
      const { flush, flushTree, headers, cells } = await render('', { groupFeatures: cashFlags });
      await flush([
        category(ROOT, { availability: { pos: true } }),
        category(CHILD, { availability: { pos: false } }),
        category(OTHER),
        category(P1, { availability: {} }),
      ]);
      await flushTree();
      expect(headers().slice(0, 6)).toEqual([
        'PRODUCT_CATEGORIES.COLUMN.NAME',
        'PRODUCT_CATEGORIES.COLUMN.PARENT',
        'PRODUCT_CATEGORIES.COLUMN.POSITION',
        'PRODUCT_CATEGORIES.COLUMN.POS',
        'PRODUCT_CATEGORIES.COLUMN.STATE',
        'PRODUCT_CATEGORIES.COLUMN.UPDATED',
      ]);
      expect([0, 1, 2, 3].map((i) => cells(i)[3])).toEqual(['COMMON.YES', 'COMMON.NO', '', '']);
    });

    it('indents the name by level, nothing when the level is unknown', async () => {
      const { flush, flushTree, root } = await render();
      await flush([category(ROOT, { depth: 2 }), category(CHILD, { depth: null })]);
      await flushTree();
      const spans = [...root.querySelectorAll<HTMLElement>('tbody span.name')];
      expect(spans[0]!.getAttribute('style')).toContain('2.5rem');
      expect(spans[1]!.getAttribute('style')).toContain('0rem');
    });

    it('warns without blocking when a category is part of a cycle', async () => {
      const { flush, flushTree, root } = await render();
      await flush([category(ROOT), category(CHILD, { cyclic: true })]);
      await flushTree();
      expect(root.querySelector('.warning')?.getAttribute('role')).toBe('status');
      expect(root.querySelector('.warning')?.textContent).toBe('PRODUCT_CATEGORIES.CYCLIC_WARNING');
      const rows = [...root.querySelectorAll('tbody tr')];
      expect(rows[0]!.querySelector('fc-status-badge')?.textContent).toContain('PRODUCT_CATALOG.STATE.ENABLED');
      expect(rows[1]!.textContent).toContain('PRODUCT_CATEGORIES.CYCLIC');
      expect(rows[1]!.querySelectorAll('fc-status-badge').length).toBe(2);
    });

    it('has no warning without cycles', async () => {
      const { flush, flushTree, root } = await render();
      await flush([category(ROOT)]);
      await flushTree();
      expect(root.querySelector('.warning')).toBeNull();
    });

    it('shows the loading state, then the empty one with the way to create', async () => {
      const { request, flushTree, view, root } = await render();
      await view();
      expect(root.querySelector('fc-skeleton')).not.toBeNull();
      request().flush(page([]));
      await flushTree();
      expect(root.querySelector('fc-empty-state')?.textContent).toContain('PRODUCT_CATEGORIES.EMPTY');
      expect(root.querySelector('fc-empty-state a')?.getAttribute('href')).toBe(
        `/groups/${GROUP}/product-categories/new`,
      );
    });

    it('does not offer to create without products:update', async () => {
      const { flush, flushTree, root } = await render('', readOnly);
      await flush([]);
      await flushTree();
      expect(root.querySelector('a.new')).toBeNull();
      expect(root.querySelector('fc-empty-state a')).toBeNull();
    });

    it('shows the error state with the request id and retries', async () => {
      const { request, flushTree, view, root } = await render();
      request().flush(errorBody('INTERNAL_ERROR'), {
        status: 500,
        statusText: 'x',
        headers: { 'X-Request-Id': 'req-3' },
      });
      await flushTree();
      const state = root.querySelector('fc-error-state')!;
      expect(state.textContent).toContain('PRODUCT_CATALOG.LOAD_ERROR');
      expect(state.textContent).toContain('ERRORS.API.INTERNAL_ERROR');
      expect(state.textContent).toContain('req-3');
      state.querySelector('button')!.click();
      await view();
      request().flush(page([category(ROOT)]));
      await view();
      expect(root.querySelector('fc-error-state')).toBeNull();
    });

    it('shows the error state without a request id for a failure that has none', async () => {
      const { request, flushTree, root } = await render();
      request().error(new ProgressEvent('error'));
      await flushTree();
      expect(root.querySelector('fc-error-state')).not.toBeNull();
      expect(root.querySelector('fc-error-state')!.textContent).not.toContain('req-');
    });

    it('offers Edit to everyone and Delete only with products:update and when editable', async () => {
      const allowed = await render();
      await allowed.flush([category(ROOT), category(CHILD, { editable: false }), category(OTHER, { editable: true })]);
      await allowed.flushTree();
      const rows = [...allowed.root.querySelectorAll('tbody tr')];
      expect(rows[0]!.querySelector('td:last-child a')?.getAttribute('aria-label')).toBe(
        'PRODUCT_CATEGORIES.EDIT_LABEL {"name":"Bibite"}',
      );
      expect(rows[0]!.querySelector('td:last-child a')?.getAttribute('href')).toBe(
        `/groups/${GROUP}/product-categories/${ROOT}`,
      );
      expect(rows[0]!.querySelector('button')?.getAttribute('aria-label')).toBe(
        'PRODUCT_CATEGORIES.DELETE.LABEL {"name":"Bibite"}',
      );
      expect(rows[1]!.querySelector('button')).toBeNull();
      expect(rows[2]!.querySelector('button')).not.toBeNull();
      document.body.replaceChildren();
      TestBed.resetTestingModule();
      const limited = await render('', readOnly);
      await limited.flush([category(ROOT)]);
      await limited.flushTree();
      expect(limited.root.querySelector('tbody button')).toBeNull();
      expect(limited.root.querySelector('tbody td a')).not.toBeNull();
    });
  });

  describe('filters in the URL', () => {
    it('reads them from the URL', async () => {
      const { request, params, flushTree } = await render('?q=%20bib%20&sort=-position&limit=50&cursor=abc&enabled=false');
      expect(params(request())).toEqual({ limit: '50', sort: '-position', q: 'bib', enabled: 'false', cursor: 'abc' });
      await flushTree();
    });

    it('ignores an unknown sort, size and state, and an empty search', async () => {
      const { request, params, flushTree } = await render('?sort=price&limit=7&enabled=x&q=%20');
      expect(params(request())).toEqual({ limit: '25', sort: 'name' });
      await flushTree();
    });

    it('accepts the sort by position and the descending name', async () => {
      const first = await render('?sort=position');
      expect(first.params(first.request())['sort']).toBe('position');
      await first.flushTree();
      document.body.replaceChildren();
      TestBed.resetTestingModule();
      const second = await render('?sort=-name');
      expect(second.params(second.request())['sort']).toBe('-name');
      await second.flushTree();
    });

    it('sorts by name and by position, both ways', async () => {
      const { flush, flushTree, root, view, search } = await render();
      await flushTree();
      await flush([category(ROOT)]);
      const sorts = () => [...root.querySelectorAll<HTMLButtonElement>('th button.sort')];
      sorts()[0]!.click();
      await view();
      expect(search().get('sort')).toBe('-name');
      await flush([category(ROOT)]);
      sorts()[1]!.click();
      await view();
      expect(search().get('sort')).toBe('position');
      await flush([category(ROOT)]);
      sorts()[1]!.click();
      await view();
      expect(search().get('sort')).toBe('-position');
      await flush([category(ROOT)]);
    });

    it('puts the search in the URL once typing pauses, and clears it', async () => {
      const { flush, flushTree, root, view, search } = await render();
      await flushTree();
      await flush([]);
      const input = root.querySelector<HTMLInputElement>('input[type=search]')!;
      input.value = 'bib ';
      input.dispatchEvent(new Event('input'));
      await new Promise((resolve) => setTimeout(resolve, 350));
      await view();
      expect(search().get('q')).toBe('bib');
      await flush([]);
      input.value = ' ';
      input.dispatchEvent(new Event('input'));
      await new Promise((resolve) => setTimeout(resolve, 350));
      await view();
      expect(search().has('q')).toBe(false);
      await flush([]);
      const event = new Event('submit', { cancelable: true });
      root.querySelector('form')!.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    });

    it('filters by state and clears the filter', async () => {
      const { flush, flushTree, root, view, search, request, params } = await render();
      await flushTree();
      await flush([category(ROOT)]);
      const select = root.querySelector<HTMLSelectElement>('fc-select select')!;
      select.value = 'true';
      select.dispatchEvent(new Event('change'));
      await view();
      expect(search().get('enabled')).toBe('true');
      const req = request();
      expect(params(req)['enabled']).toBe('true');
      req.flush(page([category(ROOT)]));
      await view();
      select.value = '';
      select.dispatchEvent(new Event('change'));
      await view();
      expect(search().has('enabled')).toBe(false);
      await flush([category(ROOT)]);
    });

    it('changes the page size and walks the pages back and forth', async () => {
      const { flush, flushTree, root, view, search } = await render();
      await flushTree();
      await flush([category(ROOT)], 'c1');
      const [previous, next] = [...root.querySelectorAll<HTMLButtonElement>('fc-cursor-paginator .buttons button')];
      expect(previous!.disabled).toBe(true);
      next!.click();
      await view();
      expect(search().get('cursor')).toBe('c1');
      await flush([category(ROOT)], 'c2');
      next!.click();
      await view();
      expect(search().get('cursor')).toBe('c2');
      await flush([category(ROOT)]);
      previous!.click();
      await view();
      expect(search().get('cursor')).toBe('c1');
      await flush([category(ROOT)], 'c2');
      previous!.click();
      await view();
      expect(search().has('cursor')).toBe(false);
      await flush([category(ROOT)], 'c1');
      const select = root.querySelector<HTMLSelectElement>('fc-cursor-paginator select')!;
      select.value = '50';
      select.dispatchEvent(new Event('change'));
      await view();
      expect(search().get('limit')).toBe('50');
      await flush([category(ROOT)]);
    });
  });

  describe('tree view', () => {
    it('shows the loading state, then the tree, and opens a node', async () => {
      const { flush, flushTree, view, root, search } = await render('?view=tree');
      await flush([]);
      await view();
      expect(root.querySelector('[role=status]')?.textContent).toBe('COMMON.LOADING');
      await flushTree();
      expect(root.querySelector('[role=status]')).toBeNull();
      const tree = root.querySelector('ul[role=tree]')!;
      expect(tree.getAttribute('aria-label')).toBe('PRODUCT_CATEGORIES.TITLE');
      expect(root.querySelector('.filters')).toBeNull();
      expect(
        root.querySelector<HTMLButtonElement>('.views button[aria-pressed=true]')?.textContent?.trim(),
      ).toBe('PRODUCT_CATEGORIES.VIEW.TREE');
      root.querySelector<HTMLElement>(`li[data-id="${CHILD}"]`)!.click();
      await view();
      expect(TestBed.inject(Router).url).toBe(`/groups/${GROUP}/product-categories/${CHILD}`);
      expect(search().has('view')).toBe(false);
    });

    it('shows the error state with the request id and retries', async () => {
      const { flush, treeRequest, view, root } = await render('?view=tree');
      await flush([]);
      treeRequest().flush(errorBody('INTERNAL_ERROR'), {
        status: 500,
        statusText: 'x',
        headers: { 'X-Request-Id': 'req-9' },
      });
      await view();
      const state = root.querySelector('fc-error-state')!;
      expect(state.textContent).toContain('ERRORS.API.INTERNAL_ERROR');
      expect(state.textContent).toContain('req-9');
      state.querySelector('button')!.click();
      await view();
      treeRequest().flush({ data: TREE });
      await view();
      expect(root.querySelector('fc-error-state')).toBeNull();
      expect(root.querySelector('ul[role=tree]')).not.toBeNull();
    });

    it('reports a failure that is not an API error generically', async () => {
      const { view, root } = await render('?view=tree', {}, [
        { provide: AppConfig, useValue: { apiBaseUrl: signal(null) } },
      ]);
      await view();
      expect(root.querySelector('fc-error-state')?.textContent).toContain('ERRORS.GENERIC.MESSAGE');
    });

    it('shows the empty state when there is no category', async () => {
      const { flush, flushTree, root } = await render('?view=tree');
      await flush([]);
      await flushTree([]);
      expect(root.querySelector('fc-empty-state')?.textContent).toContain('PRODUCT_CATEGORIES.EMPTY_TREE');
    });

    it('switches views with the buttons and resets the cursor', async () => {
      const { flush, flushTree, root, view, search, viewButtons } = await render('?cursor=c1');
      await flush([category(ROOT)], 'c2');
      await flushTree();
      expect(viewButtons().map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
      viewButtons()[1]!.click();
      await view();
      expect(search().get('view')).toBe('tree');
      expect(search().has('cursor')).toBe(false);
      await flush([category(ROOT)]);
      expect(viewButtons().map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
      expect(root.querySelector('ul[role=tree]')).not.toBeNull();
      viewButtons()[0]!.click();
      await view();
      expect(search().has('view')).toBe(false);
      expect(root.querySelector('fc-data-table')).not.toBeNull();
    });
  });

  describe('deletion', () => {
    const fakeReference = (): FakeReference => ({
      lookupNames: vi.fn(async (_group: string, kind: string, ids: string[]) =>
        Object.fromEntries(ids.filter((id) => id !== P2).map((id) => [id, `${kind}:${id.slice(-2)}`])),
      ),
      placeNames: vi.fn(async (_group: string, ids: string[]) => Object.fromEntries(ids.map((id) => [id, 'Negozio']))),
    });
    const ask = async (extra: Provider[] = []) => {
      const view = await render('', {}, extra);
      await view.flush([category(ROOT)]);
      await view.flushTree();
      view.root.querySelector<HTMLButtonElement>('tbody button')!.click();
      await view.view();
      return view;
    };
    const confirm = async (view: Awaited<ReturnType<typeof ask>>) => {
      view.dialogButton('PRODUCT_CATALOG.DELETE.ACTION').click();
      await view.view();
    };
    const item = `${LIST}/${ROOT}`;
    const refuse = async (view: Awaited<ReturnType<typeof ask>>, details?: { field: string; issue: string }[]) => {
      backend().expectOne(item).flush(errorBody('CONFLICT', details), { status: 409, statusText: 'x' });
      await view.view();
    };

    it('asks for confirmation naming the category, deletes it, says so and reads the lists again', async () => {
      const view = await ask();
      const invalidate = vi.spyOn(TestBed.inject(ReferenceStore), 'invalidate');
      const dialog = view.root.querySelector('dialog')!;
      expect(dialog.textContent).toContain('PRODUCT_CATEGORIES.DELETE.TITLE');
      expect(dialog.textContent).toContain('PRODUCT_CATEGORIES.DELETE.CONFIRM {"name":"Bibite"}');
      expect(view.dialogButton('PRODUCT_CATALOG.DELETE.ACTION').getAttribute('data-variant')).toBe('danger');
      await confirm(view);
      const req = backend().expectOne(item);
      expect(req.request.method).toBe('DELETE');
      req.flush(null, { status: 204, statusText: 'No Content' });
      await view.view();
      expect(view.toasts()).toEqual(['success: PRODUCT_CATEGORIES.DELETE.DONE {"name":"Bibite"}']);
      expect(dialog.hasAttribute('open')).toBe(false);
      expect(invalidate).toHaveBeenCalledWith(GROUP, 'product-categories');
      await view.flush([]);
      await view.flushTree([]);
    });

    it('does nothing when the user cancels', async () => {
      const view = await ask();
      view.dialogButton('COMMON.CANCEL').click();
      await view.view();
      expect(view.root.querySelector('dialog')?.hasAttribute('open')).toBe(false);
    });

    it('lists what refers to the category by kind, with names, and warns that more can appear', async () => {
      const reference = fakeReference();
      const view = await ask([{ provide: ReferenceApi, useValue: reference }]);
      const invalidate = vi.spyOn(TestBed.inject(ReferenceStore), 'invalidate');
      await confirm(view);
      await refuse(view, [
        { field: `products.${P1}`, issue: 'referenced' },
        { field: `products.${P2}`, issue: 'referenced' },
        { field: `places.${PL1}`, issue: 'referenced' },
        { field: `promotions.${PROMO}`, issue: 'referenced' },
        { field: `subcategories.${CHILD}`, issue: 'referenced' },
        { field: 'unknownKind.x', issue: 'referenced' },
        { field: 'products.other', issue: 'other' },
      ]);
      expect(reference.lookupNames).toHaveBeenCalledWith(GROUP, 'product-categories', [CHILD]);
      expect(reference.lookupNames).toHaveBeenCalledWith(GROUP, 'products', [P1, P2]);
      expect(reference.placeNames).toHaveBeenCalledWith(GROUP, [PL1]);
      const blocked = view.root.querySelector('.blocked')!;
      expect(blocked.getAttribute('role')).toBe('alert');
      expect(blocked.querySelector('h2')?.textContent).toContain(
        'PRODUCT_CATEGORIES.DELETE.BLOCKED_TITLE {"name":"Bibite"}',
      );
      expect([...blocked.querySelectorAll('h3')].map((h) => h.textContent)).toEqual([
        'PRODUCT_CATEGORIES.REFERENCE.subcategories',
        'PRODUCT_CATEGORIES.REFERENCE.products',
        'PRODUCT_CATEGORIES.REFERENCE.promotions',
        'PRODUCT_CATEGORIES.REFERENCE.places',
      ]);
      expect([...blocked.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
        'product-categories:c2',
        'products:d1',
        P2,
        PROMO,
        'Negozio',
      ]);
      expect(blocked.querySelector('.note')?.textContent).toBe('PRODUCT_CATEGORIES.DELETE.MORE_AFTER');
      expect(view.root.querySelector('dialog')?.hasAttribute('open')).toBe(false);
      expect(view.toasts()).toEqual([]);
      expect(invalidate).not.toHaveBeenCalled();
      blocked.querySelector('button')!.click();
      await view.view();
      expect(view.root.querySelector('.blocked')).toBeNull();
    });

    it('lists a single kind, and an anonymous detail as "other items"', async () => {
      const reference = fakeReference();
      const view = await ask([{ provide: ReferenceApi, useValue: reference }]);
      await confirm(view);
      await refuse(view, [
        { field: `products.${P1}`, issue: 'referenced' },
        { field: 'products', issue: 'referenced' },
      ]);
      expect([...view.root.querySelectorAll('.blocked h3')].map((h) => h.textContent)).toEqual([
        'PRODUCT_CATEGORIES.REFERENCE.products',
      ]);
      expect([...view.root.querySelectorAll('.blocked li')].map((li) => li.textContent)).toEqual([
        'products:d1',
        'PRODUCT_CATEGORIES.DELETE.HIDDEN',
      ]);
      expect(reference.placeNames).not.toHaveBeenCalled();
    });

    it('shows only "other items" when nothing is named, without reading names', async () => {
      const reference = fakeReference();
      const view = await ask([{ provide: ReferenceApi, useValue: reference }]);
      await confirm(view);
      await refuse(view, [{ field: 'places', issue: 'referenced' }]);
      expect([...view.root.querySelectorAll('.blocked li')].map((li) => li.textContent)).toEqual([
        'PRODUCT_CATEGORIES.DELETE.HIDDEN',
      ]);
      expect(reference.placeNames).not.toHaveBeenCalled();
      expect(reference.lookupNames).not.toHaveBeenCalled();
    });

    it('falls back to the ids when the names cannot be read, and says so in the log', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const reference = { lookupNames: vi.fn().mockRejectedValue(new Error('down')), placeNames: vi.fn() };
      const view = await ask([{ provide: ReferenceApi, useValue: reference }]);
      await confirm(view);
      await refuse(view, [{ field: `products.${P1}`, issue: 'referenced' }]);
      expect([...view.root.querySelectorAll('.blocked li')].map((li) => li.textContent)).toEqual([P1]);
      expect(warn).toHaveBeenCalled();
    });

    it('clears an earlier notice when a new deletion is asked', async () => {
      const view = await ask([{ provide: ReferenceApi, useValue: fakeReference() }]);
      await confirm(view);
      await refuse(view, [{ field: `products.${P1}`, issue: 'referenced' }]);
      expect(view.root.querySelector('.blocked')).not.toBeNull();
      view.root.querySelector<HTMLButtonElement>('tbody button')!.click();
      await view.view();
      expect(view.root.querySelector('.blocked')).toBeNull();
    });

    it.each([
      ['FORBIDDEN', 403, 'PRODUCT_CATALOG.ERROR.DELETE_FORBIDDEN', undefined],
      ['CONFLICT', 409, 'PRODUCT_CATALOG.ERROR.CONCURRENT', undefined],
      ['CONFLICT', 409, 'PRODUCT_CATALOG.ERROR.CONCURRENT', [{ field: 'x', issue: 'other' }]],
      ['NOT_FOUND', 404, 'ERRORS.API.NOT_FOUND', undefined],
    ])('shows a %s (%i) refusal in a toast and reads the lists again', async (code, status, message, details) => {
      const view = await ask();
      const invalidate = vi.spyOn(TestBed.inject(ReferenceStore), 'invalidate');
      await confirm(view);
      backend().expectOne(item).flush(errorBody(code, details), { status, statusText: 'x' });
      await view.view();
      expect(view.toasts()).toEqual([`error: ${message}`]);
      expect(view.root.querySelector('.blocked')).toBeNull();
      expect(view.root.querySelector('dialog')?.hasAttribute('open')).toBe(false);
      expect(invalidate).toHaveBeenCalledWith(GROUP, 'product-categories');
      await view.flush([category(ROOT)]);
      await view.flushTree();
    });
  });
});
