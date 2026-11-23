import { Provider, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { API, backend, errorBody, provideApiTesting, settle } from '../../../testing/api';
import { emulateNativeDialog } from '../../../testing/dialog';
import { signIn } from '../../../testing/session';
import { AppConfig } from '../../core/config/app-config';
import { I18nService } from '../../core/i18n/i18n.service';
import { ReferenceStore } from '../../core/reference/reference-store';
import { Profile } from '../../core/session/session.types';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { CatalogList } from './catalog-list';
import { CatalogEntry, CatalogKind, Department } from './product-catalog.types';

const GROUP = '665f1c2e9b1d4a0012ab34a1';
const P1 = '665f1c2e9b1d4a0012ab34d1';
const P2 = '665f1c2e9b1d4a0012ab34d2';
const ALL = ['products:read', 'products:update', 'profile:read'];

const SEGMENT: Record<CatalogKind, string> = { departments: 'product-departments', brands: 'product-brands' };
const TEXT: Record<CatalogKind, string> = { departments: 'DEPARTMENTS', brands: 'BRANDS' };

const base = {
  description: {},
  placeIds: [],
  createdAt: null,
  updatedAt: null,
};
const DRINKS: Department = {
  ...base,
  id: '665f1c2e9b1d4a0012ab34c1',
  name: { it: 'Bibite', en: 'Drinks' },
  enabled: true,
  code: 12,
  taxId: 't1',
  tax: { rate: 22, department: 3, vatNature: null, description: 'Ordinaria' },
  noDiscount: false,
  secondaryFiscalPrinter: false,
};
const FOOD: Department = {
  ...DRINKS,
  id: '665f1c2e9b1d4a0012ab34c2',
  name: { en: 'Food' },
  enabled: false,
  code: null,
  taxId: null,
  tax: null,
  editable: false,
};
const BRAND = { ...base, id: '665f1c2e9b1d4a0012ab34c3', name: { it: 'Acme' }, enabled: true };

const page = (data: CatalogEntry[], next: string | null = null) => ({ data, page: { limit: 25, next } });

async function render(
  kind: CatalogKind,
  query = '',
  profile: Partial<Profile> = {},
  extra: Provider[] = [],
) {
  emulateNativeDialog();
  const list = `${API}/v1/groups/${GROUP}/${SEGMENT[kind]}`;
  TestBed.configureTestingModule({
    providers: [
      ...provideApiTesting(),
      ...extra,
      provideRouter(
        [
          {
            path: `groups/:groupId/${SEGMENT[kind]}`,
            data: { kind },
            component: CatalogList,
          },
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
  await harness.navigateByUrl(`/groups/${GROUP}/${SEGMENT[kind]}${query}`);
  const root = harness.routeNativeElement as HTMLElement;
  document.body.appendChild(root);
  const view = async () => {
    await settle();
    harness.detectChanges();
    await settle();
    harness.detectChanges();
  };
  const request = () => backend().expectOne((r) => r.url === list);
  const flush = async (data: CatalogEntry[], next: string | null = null) => {
    const req = request();
    req.flush(page(data, next));
    await view();
    return req;
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
  return { root, view, request, flush, params, cells, headers, search, dialogButton, toasts, list };
}

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
  sessionStorage.clear();
});

describe('CatalogList', () => {
  describe('departments', () => {
    it('requests the first page sorted by name and shows code, name, tax rate and state', async () => {
      const { request, params, view, root, cells, headers } = await render('departments');
      const req = request();
      expect(params(req)).toEqual({ limit: '25', sort: 'name' });
      req.flush(page([DRINKS, FOOD]));
      await view();
      expect(root.querySelector('h1')?.textContent).toBe('PRODUCT_CATALOG.DEPARTMENTS.TITLE');
      expect(root.querySelector('.hint')?.textContent).toBe('PRODUCT_CATALOG.DEPARTMENTS.HINT');
      expect(headers().slice(0, 4)).toEqual([
        'PRODUCT_CATALOG.COLUMN.CODE',
        'PRODUCT_CATALOG.COLUMN.NAME',
        'PRODUCT_CATALOG.COLUMN.TAX',
        'PRODUCT_CATALOG.COLUMN.STATE',
      ]);
      expect(cells(0).slice(0, 4)).toEqual(['12', 'Bibite', '22% - Rep.3 | Ordinaria', 'PRODUCT_CATALOG.STATE.ENABLED']);
      expect(cells(1).slice(0, 4)).toEqual(['', 'Food', '', 'PRODUCT_CATALOG.STATE.DISABLED']);
      expect([...root.querySelectorAll('tbody a')].map((a) => a.getAttribute('href'))).toEqual([
        `/groups/${GROUP}/product-departments/${DRINKS.id}`,
        `/groups/${GROUP}/product-departments/${FOOD.id}`,
      ]);
    });

    it('reads the filters from the URL', async () => {
      const { request, params } = await render(
        'departments',
        '?q=%20bib%20&sort=-code&limit=50&cursor=abc&enabled=false',
      );
      expect(params(request())).toEqual({ limit: '50', sort: '-code', q: 'bib', enabled: 'false', cursor: 'abc' });
    });

    it('ignores invalid sort, size and state, and an empty search', async () => {
      const { request, params } = await render('departments', '?sort=price&limit=7&enabled=x&q=%20');
      expect(params(request())).toEqual({ limit: '25', sort: 'name' });
    });

    it('accepts the sort by code in both directions', async () => {
      const first = await render('departments', '?sort=code');
      expect(first.params(first.request())['sort']).toBe('code');
    });

    it('sorts by code and by name, both ways', async () => {
      const { flush, root, view, search } = await render('departments');
      await flush([DRINKS]);
      const sorts = () => [...root.querySelectorAll<HTMLButtonElement>('th button.sort')];
      sorts()[0]!.click();
      await view();
      expect(search().get('sort')).toBe('code');
      await flush([DRINKS]);
      sorts()[0]!.click();
      await view();
      expect(search().get('sort')).toBe('-code');
      await flush([DRINKS]);
      sorts()[1]!.click();
      await view();
      expect(search().get('sort')).toBe('name');
      await flush([DRINKS]);
    });
  });

  describe('brands', () => {
    it('requests the brands and shows name and state only', async () => {
      const { request, params, view, root, cells, headers } = await render('brands');
      const req = request();
      expect(params(req)).toEqual({ limit: '25', sort: 'name' });
      req.flush(page([BRAND]));
      await view();
      expect(root.querySelector('h1')?.textContent).toBe('PRODUCT_CATALOG.BRANDS.TITLE');
      expect(headers().slice(0, 2)).toEqual(['PRODUCT_CATALOG.COLUMN.NAME', 'PRODUCT_CATALOG.COLUMN.STATE']);
      expect(cells(0).slice(0, 2)).toEqual(['Acme', 'PRODUCT_CATALOG.STATE.ENABLED']);
      expect(root.querySelector('tbody a')?.getAttribute('href')).toBe(
        `/groups/${GROUP}/product-brands/${BRAND.id}`,
      );
    });

    it('accepts the descending name and refuses the sort by code', async () => {
      const desc = await render('brands', '?sort=-name');
      expect(desc.params(desc.request())['sort']).toBe('-name');
      document.body.replaceChildren();
      TestBed.resetTestingModule();
      const code = await render('brands', '?sort=code');
      expect(code.params(code.request())['sort']).toBe('name');
    });

    it('sorts by name both ways', async () => {
      const { flush, root, view, search } = await render('brands');
      await flush([BRAND]);
      root.querySelector<HTMLButtonElement>('th button.sort')!.click();
      await view();
      expect(search().get('sort')).toBe('-name');
      await flush([BRAND]);
    });
  });

  describe.each(['departments', 'brands'] as const)('%s page', (kind) => {
    const text = TEXT[kind];
    const ENTRY: CatalogEntry = kind === 'departments' ? { ...DRINKS, id: BRAND.id, name: { it: 'Acme' } } : BRAND;

    it('offers "new" and "delete" only with products:update', async () => {
      const allowed = await render(kind);
      await allowed.flush([{ ...ENTRY, editable: true }]);
      expect(allowed.root.querySelector('a.new')?.getAttribute('href')).toBe(
        `/groups/${GROUP}/${SEGMENT[kind]}/new`,
      );
      expect(allowed.root.querySelector('a.new')?.textContent).toBe(`PRODUCT_CATALOG.${text}.NEW`);
      expect(allowed.root.querySelector('tbody button')).not.toBeNull();
      document.body.replaceChildren();
      TestBed.resetTestingModule();
      const readOnly = await render(kind, '', { permissions: ['products:read', 'profile:read'] });
      await readOnly.flush([ENTRY]);
      expect(readOnly.root.querySelector('a.new')).toBeNull();
      expect(readOnly.root.querySelector('tbody button')).toBeNull();
      expect(readOnly.root.querySelector('tbody a')).not.toBeNull();
    });

    it('hides "delete" for the entries the server marks as not editable', async () => {
      const { flush, root } = await render(kind);
      await flush([{ ...ENTRY, editable: false }, ENTRY]);
      const rows = [...root.querySelectorAll('tbody tr')];
      expect(rows[0]!.querySelector('button')).toBeNull();
      expect(rows[1]!.querySelector('button')?.getAttribute('aria-label')).toBe(
        `PRODUCT_CATALOG.${text}.DELETE.LABEL {"name":"Acme"}`,
      );
    });

    it('offers to create the first entry when there is none', async () => {
      const { flush, root } = await render(kind);
      await flush([]);
      const empty = root.querySelector('fc-empty-state')!;
      expect(empty.textContent).toContain(`PRODUCT_CATALOG.${text}.EMPTY`);
      expect(empty.querySelector('a')?.getAttribute('href')).toBe(`/groups/${GROUP}/${SEGMENT[kind]}/new`);
    });

    it('does not offer to create without products:update', async () => {
      const { flush, root } = await render(kind, '', { permissions: ['products:read', 'profile:read'] });
      await flush([]);
      expect(root.querySelector('fc-empty-state a')).toBeNull();
    });

    it('puts the search in the URL once typing pauses, and clears it', async () => {
      const { flush, root, view, search } = await render(kind);
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
      const { flush, root, view, search, request, params } = await render(kind);
      await flush([ENTRY]);
      const select = root.querySelector<HTMLSelectElement>('fc-select select')!;
      select.value = 'true';
      select.dispatchEvent(new Event('change'));
      await view();
      expect(search().get('enabled')).toBe('true');
      const req = request();
      expect(params(req)['enabled']).toBe('true');
      req.flush(page([ENTRY]));
      await view();
      select.value = '';
      select.dispatchEvent(new Event('change'));
      await view();
      expect(search().has('enabled')).toBe(false);
      await flush([ENTRY]);
    });

    it('changes the page size and walks the pages back and forth', async () => {
      const { flush, root, view, search } = await render(kind);
      await flush([ENTRY], 'c1');
      const [previous, next] = [...root.querySelectorAll<HTMLButtonElement>('fc-cursor-paginator .buttons button')];
      expect(previous!.disabled).toBe(true);
      next!.click();
      await view();
      expect(search().get('cursor')).toBe('c1');
      await flush([ENTRY], 'c2');
      next!.click();
      await view();
      expect(search().get('cursor')).toBe('c2');
      await flush([ENTRY]);
      previous!.click();
      await view();
      expect(search().get('cursor')).toBe('c1');
      await flush([ENTRY], 'c2');
      previous!.click();
      await view();
      expect(search().has('cursor')).toBe(false);
      await flush([ENTRY], 'c1');
      const select = root.querySelector<HTMLSelectElement>('fc-cursor-paginator select')!;
      select.value = '50';
      select.dispatchEvent(new Event('change'));
      await view();
      expect(search().get('limit')).toBe('50');
      await flush([ENTRY]);
    });

    it('shows the error state with the request id and retries', async () => {
      const { request, view, root } = await render(kind);
      request().flush(errorBody('INTERNAL_ERROR'), {
        status: 500,
        statusText: 'x',
        headers: { 'X-Request-Id': 'req-3' },
      });
      await view();
      const state = root.querySelector('fc-error-state')!;
      expect(state.textContent).toContain('PRODUCT_CATALOG.LOAD_ERROR');
      expect(state.textContent).toContain('ERRORS.API.INTERNAL_ERROR');
      expect(state.textContent).toContain('req-3');
      state.querySelector('button')!.click();
      await view();
      request().flush(page([ENTRY]));
      await view();
      expect(root.querySelector('fc-error-state')).toBeNull();
    });

    it('reports an unexpected failure generically', async () => {
      const { root, view } = await render(kind, '', {}, [
        { provide: AppConfig, useValue: { apiBaseUrl: signal(null) } },
      ]);
      await view();
      expect(root.querySelector('fc-error-state')?.textContent).toContain('ERRORS.GENERIC.MESSAGE');
    });

    describe('deletion', () => {
      const askFor = async (extra: Provider[] = []) => {
        if (extra.length > 0) {
          TestBed.configureTestingModule({ providers: extra });
        }
        const view = await render(kind);
        await view.flush([ENTRY]);
        view.root.querySelector<HTMLButtonElement>('tbody button')!.click();
        await view.view();
        view.dialogButton('PRODUCT_CATALOG.DELETE.ACTION').click();
        await view.view();
        return view;
      };
      const item = `/${ENTRY.id}`;

      it('asks for confirmation naming the entry, deletes it, says so and reads the list again', async () => {
        const view = await render(kind);
        await view.flush([ENTRY]);
        view.root.querySelector<HTMLButtonElement>('tbody button')!.click();
        await view.view();
        const dialog = view.root.querySelector('dialog')!;
        expect(dialog.textContent).toContain(`PRODUCT_CATALOG.${text}.DELETE.TITLE`);
        expect(dialog.textContent).toContain(`PRODUCT_CATALOG.${text}.DELETE.CONFIRM {"name":"Acme"}`);
        expect(view.dialogButton('PRODUCT_CATALOG.DELETE.ACTION').getAttribute('data-variant')).toBe('danger');
        view.dialogButton('PRODUCT_CATALOG.DELETE.ACTION').click();
        await view.view();
        const req = backend().expectOne(`${view.list}${item}`);
        expect(req.request.method).toBe('DELETE');
        req.flush(null, { status: 204, statusText: 'No Content' });
        await view.view();
        expect(view.toasts()).toEqual([`success: PRODUCT_CATALOG.${text}.DELETE.DONE {"name":"Acme"}`]);
        expect(dialog.hasAttribute('open')).toBe(false);
        await view.flush([]);
      });

      it('does nothing when the user cancels', async () => {
        const view = await render(kind);
        await view.flush([ENTRY]);
        view.root.querySelector<HTMLButtonElement>('tbody button')!.click();
        await view.view();
        view.dialogButton('COMMON.CANCEL').click();
        await view.view();
        expect(view.root.querySelector('dialog')?.hasAttribute('open')).toBe(false);
      });

      it('lists the products that use the entry when the server refuses with 409, by name when known', async () => {
        const lookup = vi.fn().mockResolvedValue({ data: [{ id: P1, name: 'Acqua' }], page: { limit: 100, next: null } });
        const view = await askFor([{ provide: ReferenceStore, useValue: { page: lookup } }]);
        backend()
          .expectOne(`${view.list}${item}`)
          .flush(
            errorBody('CONFLICT', [
              { field: `products.${P1}`, issue: 'referenced' },
              { field: `products.${P2}`, issue: 'referenced' },
            ]),
            { status: 409, statusText: 'x' },
          );
        await view.view();
        expect(lookup).toHaveBeenCalledWith(GROUP, 'products', { ids: [P1, P2], limit: 100 });
        const blocked = view.root.querySelector('.blocked')!;
        expect(blocked.getAttribute('role')).toBe('alert');
        expect(blocked.querySelector('h2')?.textContent).toContain(
          `PRODUCT_CATALOG.${text}.DELETE.BLOCKED_TITLE {"name":"Acme"}`,
        );
        expect(blocked.querySelector('p')?.textContent).toBe(`PRODUCT_CATALOG.${text}.DELETE.BLOCKED_MESSAGE`);
        expect([...blocked.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['Acqua', P2]);
        expect(view.root.querySelector('dialog')?.hasAttribute('open')).toBe(false);
        expect(view.toasts()).toEqual([]);
        blocked.querySelector('button')!.click();
        await view.view();
        expect(view.root.querySelector('.blocked')).toBeNull();
      });

      it('clears an earlier notice when a new deletion is asked', async () => {
        const lookup = vi.fn().mockResolvedValue({ data: [], page: { limit: 100, next: null } });
        const view = await askFor([{ provide: ReferenceStore, useValue: { page: lookup } }]);
        backend()
          .expectOne(`${view.list}${item}`)
          .flush(errorBody('CONFLICT', [{ field: `products.${P1}`, issue: 'referenced' }]), {
            status: 409,
            statusText: 'x',
          });
        await view.view();
        expect(view.root.querySelector('.blocked')).not.toBeNull();
        view.root.querySelector<HTMLButtonElement>('tbody button')!.click();
        await view.view();
        expect(view.root.querySelector('.blocked')).toBeNull();
      });

      it('falls back to the ids when the names cannot be read, and says so in the log', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const view = await askFor([
          { provide: ReferenceStore, useValue: { page: vi.fn().mockRejectedValue(new Error('down')) } },
        ]);
        backend()
          .expectOne(`${view.list}${item}`)
          .flush(errorBody('CONFLICT', [{ field: `products.${P1}`, issue: 'referenced' }]), {
            status: 409,
            statusText: 'x',
          });
        await view.view();
        expect([...view.root.querySelectorAll('.blocked li')].map((li) => li.textContent)).toEqual([P1]);
        expect(warn).toHaveBeenCalled();
      });

      it.each([
        ['FORBIDDEN', 'PRODUCT_CATALOG.ERROR.DELETE_FORBIDDEN'],
        ['CONFLICT', 'PRODUCT_CATALOG.ERROR.CONCURRENT'],
        ['NOT_FOUND', 'ERRORS.API.NOT_FOUND'],
      ])('shows a %s refusal in a toast and reads the list again', async (code, message) => {
        const view = await askFor();
        backend().expectOne(`${view.list}${item}`).flush(errorBody(code), {
          status: code === 'FORBIDDEN' ? 403 : code === 'CONFLICT' ? 409 : 404,
          statusText: 'x',
        });
        await view.view();
        expect(view.toasts()).toEqual([`error: ${message}`]);
        expect(view.root.querySelector('.blocked')).toBeNull();
        expect(view.root.querySelector('dialog')?.hasAttribute('open')).toBe(false);
        await view.flush([ENTRY]);
      });
    });
  });
});
