import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { API, backend, errorBody, provideApiTesting, settle } from '../../../testing/api';
import {
  CONTACT_ID_1,
  CONTACT_ID_2,
  CONTACT_ID_3,
  CONTACT_ID_4,
  contactRow,
} from '../../../testing/contacts-rows';
import { emulateNativeDialog } from '../../../testing/dialog';
import { signIn } from '../../../testing/session';
import { AppConfig } from '../../core/config/app-config';
import { I18nService } from '../../core/i18n/i18n.service';
import { ReferenceStore } from '../../core/reference/reference-store';
import { Profile } from '../../core/session/session.types';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { ContactList } from './contact-list';
import { ContactRow } from './contact.types';

const GROUP = '665f1c2e9b1d4a0012ab34a1';
const CG1 = '665f1c2e9b1d4a0012ab3d01';
const CG2 = '665f1c2e9b1d4a0012ab3d02';
const ALL = ['contacts:read', 'contacts:write', 'contacts:export', 'profile:read'];
const READ_ONLY = { permissions: ['contacts:read', 'profile:read'] };
const LIST = `${API}/v1/groups/${GROUP}/contacts`;
const GROUPS_URL = `${API}/v1/groups/${GROUP}/lookup/contact-groups`;

const page = (data: ContactRow[], next: string | null = null) => ({
  data,
  page: { limit: 25, next },
});

interface Options {
  /** Answer of the read of the groups of contacts. */
  groups?: 'ok' | 'fail';
  noApi?: boolean;
}

async function render(query = '', profile: Partial<Profile> = {}, options: Options = {}) {
  emulateNativeDialog();
  TestBed.configureTestingModule({
    providers: [
      ...provideApiTesting(),
      ...(options.noApi === true
        ? [{ provide: AppConfig, useValue: { apiBaseUrl: signal(null) } }]
        : []),
      provideRouter(
        [
          { path: 'groups/:groupId/contacts', component: ContactList },
          { path: '**', children: [] },
        ],
        withComponentInputBinding(),
      ),
    ],
  });
  const i18n = TestBed.inject(I18nService);
  vi.spyOn(i18n, 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  signIn({ role: 'SA', permissions: ALL, ...profile });
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(`/groups/${GROUP}/contacts${query}`);
  const root = harness.routeNativeElement as HTMLElement;
  document.body.appendChild(root);
  const view = async () => {
    await settle();
    harness.detectChanges();
    await settle();
    harness.detectChanges();
  };
  const request = () => backend().expectOne((r) => r.url === LIST && r.method === 'GET');
  const flush = async (data: ContactRow[], next: string | null = null) => {
    const req = request();
    req.flush(page(data, next));
    await view();
    return req;
  };
  const params = (req: ReturnType<typeof request>) =>
    Object.fromEntries(req.request.params.keys().map((k) => [k, req.request.params.get(k)]));
  const answerGroups = async () => {
    await view();
    for (const read of backend().match((r) => r.url === GROUPS_URL)) {
      if (options.groups === 'fail') {
        read.flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' });
      } else {
        read.flush({
          data: [
            { id: CG1, name: 'Fedeli' },
            { id: CG2, name: 'Occasionali' },
          ],
          page: { limit: 100, next: null },
        });
      }
    }
    await view();
  };
  await answerGroups();
  const rows = () => [...root.querySelectorAll('tbody tr')];
  const cells = (row: number) =>
    [...rows()[row]!.querySelectorAll('th, td')].map((c) => c.textContent?.trim());
  const headers = () => [...root.querySelectorAll('thead th')].map((c) => c.textContent?.trim());
  const search = () => new URL(TestBed.inject(Router).url, 'http://x').searchParams;
  const dialogButton = (text: string) =>
    [...root.querySelectorAll<HTMLButtonElement>('dialog[open] button')].find(
      (b) => b.textContent?.trim() === text,
    )!;
  const toasts = () =>
    TestBed.inject(ToastService)
      .toasts()
      .map((t) => `${t.kind}: ${t.message}`);
  const checkboxes = () => [...root.querySelectorAll<HTMLInputElement>('td input[type=checkbox]')];
  const selectAll = () => root.querySelector<HTMLInputElement>('.bulk fc-checkbox input')!;
  const tick = async (input: HTMLInputElement, checked = true) => {
    input.checked = checked;
    input.dispatchEvent(new Event('change'));
    await view();
  };
  const groupSelect = () => root.querySelector<HTMLSelectElement>('form.filters fc-select select')!;
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
  const tabs = () => [...root.querySelectorAll<HTMLElement>('[role=tab]')];
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
    groupSelect,
    choose,
    type,
    tabs,
    action,
  };
}

async function open(
  rows: ContactRow[],
  query = '',
  profile: Partial<Profile> = {},
  options: Options = {},
) {
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

describe('ContactList', () => {
  describe('table', () => {
    it('requests the customers by display name and shows their columns', async () => {
      const { request, params, view, root, headers, cells } = await render();
      const req = request();
      expect(params(req)).toEqual({ limit: '25', sort: 'displayName', kind: 'customers' });
      req.flush(
        page([
          contactRow(CONTACT_ID_1),
          contactRow(CONTACT_ID_2, {
            displayName: null,
            code: '',
            email: null,
            phone: null,
            company: { name: '', vatNumber: '' },
          }),
        ]),
      );
      await view();
      expect(root.querySelector('h1')?.textContent).toBe('CONTACTS.TITLE');
      expect(root.querySelector('.hint')?.textContent).toBe('CONTACTS.HINT');
      expect(root.querySelector('table caption')?.textContent?.trim()).toBe(
        'CONTACTS.KIND.CUSTOMERS',
      );
      expect(headers().slice(0, 7)).toEqual([
        'CONTACTS.COLUMN.SELECT',
        'CONTACTS.COLUMN.DISPLAY_NAME',
        'CONTACTS.COLUMN.FIRST_NAME',
        'CONTACTS.COLUMN.LAST_NAME',
        'CONTACTS.COLUMN.COMPANY_NAME',
        'CONTACTS.COLUMN.EMAIL',
        'CONTACTS.COLUMN.PHONE',
      ]);
      expect(cells(0).slice(1, 7)).toEqual([
        'Anna Bianchi',
        'Anna',
        'Bianchi',
        'Bianchi Srl',
        'anna@example.com',
        '+39 02 1234567',
      ]);
      expect(root.querySelector('tbody tr a')?.getAttribute('href')).toBe(
        `/groups/${GROUP}/contacts/${CONTACT_ID_1}`,
      );
      expect(cells(1)[1]).toBe(`…${CONTACT_ID_2.slice(-6)}`);
      expect(cells(1).slice(5, 7)).toEqual(['', '']);
    });

    it('names a contact without a display name by its code', async () => {
      const { cells } = await open([contactRow(CONTACT_ID_1, { displayName: null })]);
      expect(cells(0)[1]).toBe('K-001');
    });

    it('shows the columns of the suppliers with the company name as a link', async () => {
      const { headers, cells, rows, params, request, view } = await render('?kind=suppliers');
      const req = request();
      expect(params(req)['kind']).toBe('suppliers');
      req.flush(
        page([
          contactRow(CONTACT_ID_1, { supplier: true }),
          contactRow(CONTACT_ID_2, { displayName: null, company: { name: '', vatNumber: '' } }),
        ]),
      );
      await view();
      expect(headers().slice(0, 5)).toEqual([
        'CONTACTS.COLUMN.SELECT',
        'CONTACTS.COLUMN.COMPANY_NAME',
        'CONTACTS.COLUMN.VAT_NUMBER',
        'CONTACTS.COLUMN.EMAIL',
        'CONTACTS.COLUMN.PHONE',
      ]);
      expect(cells(0).slice(1, 5)).toEqual([
        'Bianchi Srl',
        '01234567890',
        'anna@example.com',
        '+39 02 1234567',
      ]);
      const link = rows()[0]!.querySelector('th a, td a')!;
      expect(link.getAttribute('href')).toBe(`/groups/${GROUP}/contacts/${CONTACT_ID_1}`);
      expect(cells(1)[1]).toBe('K-001');
    });

    it('shows the generic contacts like the customers', async () => {
      const { headers, params, request, view } = await render('?kind=others');
      const req = request();
      expect(params(req)['kind']).toBe('others');
      req.flush(page([]));
      await view();
      expect(headers()).toContain('CONTACTS.COLUMN.LAST_NAME');
    });

    it('shows the type of every contact in the tab with all of them', async () => {
      const { headers, params, request, view, rows } = await render('?kind=all');
      const req = request();
      expect(params(req)['kind']).toBe('all');
      req.flush(
        page([
          contactRow(CONTACT_ID_1, { customer: true, supplier: false }),
          contactRow(CONTACT_ID_2, { customer: false, supplier: true }),
          contactRow(CONTACT_ID_3, { customer: true, supplier: true }),
          contactRow(CONTACT_ID_4, { customer: false, supplier: false }),
        ]),
      );
      await view();
      expect(headers().slice(0, 5)).toEqual([
        'CONTACTS.COLUMN.SELECT',
        'CONTACTS.COLUMN.DISPLAY_NAME',
        'CONTACTS.COLUMN.TYPE',
        'CONTACTS.COLUMN.EMAIL',
        'CONTACTS.COLUMN.PHONE',
      ]);
      const badges = rows().map((row) =>
        [...row.querySelectorAll('fc-status-badge')].map((b) => b.textContent?.trim()),
      );
      expect(badges).toEqual([
        ['CONTACTS.TYPE.CUSTOMER'],
        ['CONTACTS.TYPE.SUPPLIER'],
        ['CONTACTS.TYPE.CUSTOMER', 'CONTACTS.TYPE.SUPPLIER'],
        ['CONTACTS.TYPE.OTHER'],
      ]);
    });

    it('falls back to the customers for a kind that is not valid', async () => {
      const { params, request, root, view } = await render('?kind=zzz');
      const req = request();
      expect(params(req)['kind']).toBe('customers');
      req.flush(page([]));
      await view();
      expect(root.querySelector('[role=tab][aria-selected=true]')?.textContent?.trim()).toBe(
        'CONTACTS.KIND.CUSTOMERS',
      );
    });

    it('shows the loading state, then the empty one with the way to create', async () => {
      const { request, view, root } = await render('?kind=suppliers');
      expect(root.querySelector('fc-skeleton')).not.toBeNull();
      request().flush(page([]));
      await view();
      expect(root.querySelector('fc-empty-state')?.textContent).toContain('CONTACTS.EMPTY');
      expect(root.querySelector('fc-empty-state a')?.getAttribute('href')).toBe(
        `/groups/${GROUP}/contacts/new?kind=suppliers`,
      );
    });

    it('offers to create only with contacts:write, keeping the tab', async () => {
      const allowed = await render('?kind=others');
      await allowed.flush([]);
      expect(allowed.root.querySelector('.page-header a:not(.import-export)')?.getAttribute('href')).toBe(
        `/groups/${GROUP}/contacts/new?kind=others`,
      );
      expect(allowed.root.querySelector('.page-header a:not(.import-export)')?.textContent?.trim()).toBe(
        'CONTACTS.NEW',
      );
      document.body.replaceChildren();
      TestBed.resetTestingModule();
      const limited = await render('', READ_ONLY);
      await limited.flush([]);
      expect(limited.root.querySelector('.page-header a:not(.import-export)')).toBeNull();
      expect(limited.root.querySelector('fc-empty-state a')).toBeNull();
    });

    it('links to the import and export of the contacts of the group, for whoever reads them', async () => {
      const { root, flush } = await render();
      await flush([]);
      const link = root.querySelector('.page-header a.import-export');
      expect(link?.getAttribute('href')).toBe(`/groups/${GROUP}/tools/contacts-import-export`);
      expect(link?.textContent?.trim()).toBe('CATALOG_XLSX.LINK');
    });

    it('hides the link to the import and export without contacts:export', async () => {
      const { root, flush } = await render('', READ_ONLY);
      await flush([]);
      expect(root.querySelector('a.import-export')).toBeNull();
    });

    it('shows the error state with the request id and retries', async () => {
      const { request, view, root } = await render();
      request().flush(errorBody('INTERNAL_ERROR'), {
        status: 500,
        statusText: 'x',
        headers: { 'X-Request-Id': 'req-3' },
      });
      await view();
      const state = root.querySelector('fc-error-state')!;
      expect(state.textContent).toContain('CONTACTS.LOAD_ERROR');
      expect(state.textContent).toContain('ERRORS.API.INTERNAL_ERROR');
      expect(state.textContent).toContain('req-3');
      expect(root.querySelector('.bulk')).toBeNull();
      state.querySelector('button')!.click();
      await view();
      request().flush(page([contactRow(CONTACT_ID_1)]));
      await view();
      expect(root.querySelector('fc-error-state')).toBeNull();
      expect(root.querySelectorAll('tbody tr')).toHaveLength(1);
    });

    it('asks to narrow the text when the search was too slow', async () => {
      const { request, view, root } = await render('?q=ro');
      request().flush(errorBody('SERVICE_UNAVAILABLE'), { status: 503, statusText: 'x' });
      await view();
      const state = root.querySelector('fc-error-state')!;
      expect(state.textContent).toContain('CONTACTS.LIST.TOO_SLOW');
      expect(state.textContent).not.toContain('ERRORS.API.SERVICE_UNAVAILABLE');
    });

    it('shows the generic error for a failure that is not an API error', async () => {
      const { view, root } = await render('', {}, { noApi: true });
      await view();
      expect(root.querySelector('fc-error-state')?.textContent).toContain('ERRORS.GENERIC.MESSAGE');
    });
  });

  describe('parameters in the URL', () => {
    it('reads all of them from the URL', async () => {
      const { request, params, view, groupSelect, root } = await render(
        `?kind=others&q=%20ann%20&contactGroupId=${CG2}&sort=-lastName&limit=50&cursor=abc`,
      );
      const req = request();
      expect(params(req)).toEqual({
        limit: '50',
        sort: '-lastName',
        kind: 'others',
        q: 'ann',
        contactGroupId: CG2,
        cursor: 'abc',
      });
      await view();
      expect(groupSelect().value).toBe(CG2);
      expect(root.querySelector<HTMLInputElement>('input[type=search]')!.value).toBe(' ann ');
      req.flush(page([]));
    });

    it('ignores what is not valid', async () => {
      const { request, params, view, groupSelect, root } = await render(
        '?q=%20&contactGroupId=zzz&sort=price&limit=7',
      );
      const req = request();
      expect(params(req)).toEqual({ limit: '25', sort: 'displayName', kind: 'customers' });
      await view();
      expect(groupSelect().value).toBe('');
      expect(root.querySelector<HTMLInputElement>('input[type=search]')!.value).toBe(' ');
      req.flush(page([]));
    });

    it('shows the sort of the URL in the header', async () => {
      const { root } = await open([contactRow(CONTACT_ID_1)], '?sort=-companyName');
      const sorted = [...root.querySelectorAll('th')].filter(
        (th) => th.getAttribute('aria-sort') !== null,
      );
      expect(
        sorted.map((th) => [th.textContent?.trim(), th.getAttribute('aria-sort')]),
      ).toContainEqual(['CONTACTS.COLUMN.COMPANY_NAME', 'descending']);
    });
  });

  describe('filters', () => {
    it('offers the groups of contacts and filters by one, then clears the filter', async () => {
      const { flush, groupSelect, choose, search, request, params } = await render();
      await flush([]);
      expect([...groupSelect().options].map((o) => o.textContent?.trim())).toEqual([
        'CONTACTS.FILTER.ALL_GROUPS',
        'Fedeli',
        'Occasionali',
      ]);
      await choose(groupSelect(), CG1);
      expect(search().get('contactGroupId')).toBe(CG1);
      const req = request();
      expect(params(req)['contactGroupId']).toBe(CG1);
      req.flush(page([]));
      await choose(groupSelect(), '');
      expect(search().has('contactGroupId')).toBe(false);
      await flush([]);
    });

    it('leaves only the first option when the groups cannot be read', async () => {
      const { flush, groupSelect } = await render('', {}, { groups: 'fail' });
      await flush([]);
      expect(groupSelect().options).toHaveLength(1);
    });

    it('puts the search in the URL once typing pauses, and clears it', async () => {
      const { flush, root, search, type } = await render();
      await flush([]);
      const input = root.querySelector<HTMLInputElement>('input[type=search]')!;
      await type(input, 'ann ');
      expect(search().get('q')).toBe('ann');
      await flush([]);
      await type(input, ' ');
      expect(search().has('q')).toBe(false);
      await flush([]);
      const event = new Event('submit', { cancelable: true });
      root.querySelector('form')!.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    });

    it('changes the tab, clearing the search and the group, and keeps the sort', async () => {
      const { flush, tabs, view, search, request, params } = await render(
        `?q=ann&contactGroupId=${CG1}&sort=-lastName&cursor=c1`,
      );
      await flush([]);
      expect(tabs().map((tab) => tab.textContent?.trim())).toEqual([
        'CONTACTS.KIND.CUSTOMERS',
        'CONTACTS.KIND.SUPPLIERS',
        'CONTACTS.KIND.OTHERS',
        'CONTACTS.KIND.ALL',
      ]);
      tabs()[1]!.click();
      await view();
      expect(search().get('kind')).toBe('suppliers');
      expect(search().has('q')).toBe(false);
      expect(search().has('contactGroupId')).toBe(false);
      expect(search().has('cursor')).toBe(false);
      const req = request();
      expect(params(req)).toEqual({ limit: '25', sort: '-lastName', kind: 'suppliers' });
      req.flush(page([]));
    });
  });

  describe('sort and pagination', () => {
    it('sorts by display name, last name and company name, both ways', async () => {
      const { flush, root, view, search } = await render();
      await flush([contactRow(CONTACT_ID_1)]);
      const sorts = () => [...root.querySelectorAll<HTMLButtonElement>('th button.sort')];
      const click = async (index: number, expected: string) => {
        sorts()[index]!.click();
        await view();
        expect(search().get('sort')).toBe(expected);
        await flush([contactRow(CONTACT_ID_1)]);
      };
      await click(1, 'lastName');
      await click(1, '-lastName');
      await click(2, 'companyName');
      await click(0, 'displayName');
      await click(0, '-displayName');
    });

    it('changes the page size and walks the pages back and forth', async () => {
      const { flush, root, view, search } = await render();
      await flush([contactRow(CONTACT_ID_1)], 'c1');
      const [previous, next] = [
        ...root.querySelectorAll<HTMLButtonElement>('fc-cursor-paginator .buttons button'),
      ];
      expect(previous!.disabled).toBe(true);
      next!.click();
      await view();
      expect(search().get('cursor')).toBe('c1');
      await flush([contactRow(CONTACT_ID_1)], 'c2');
      next!.click();
      await view();
      expect(search().get('cursor')).toBe('c2');
      await flush([contactRow(CONTACT_ID_1)]);
      previous!.click();
      await view();
      expect(search().get('cursor')).toBe('c1');
      await flush([contactRow(CONTACT_ID_1)], 'c2');
      previous!.click();
      await view();
      expect(search().has('cursor')).toBe(false);
      await flush([contactRow(CONTACT_ID_1)], 'c1');
      const select = root.querySelector<HTMLSelectElement>('fc-cursor-paginator select')!;
      select.value = '50';
      select.dispatchEvent(new Event('change'));
      await view();
      expect(search().get('limit')).toBe('50');
      await flush([contactRow(CONTACT_ID_1)]);
    });
  });

  describe('selection', () => {
    const rows3 = () => [
      contactRow(CONTACT_ID_1, { displayName: 'Anna Bianchi' }),
      contactRow(CONTACT_ID_2, { displayName: 'Luca Verdi' }),
      contactRow(CONTACT_ID_3, { displayName: 'Rosa Neri' }),
    ];

    it('selects the contacts one by one or all', async () => {
      const { checkboxes, selectAll, tick, root } = await open(rows3());
      expect(checkboxes().map((box) => box.getAttribute('aria-label'))).toEqual([
        'CONTACTS.SELECT_ROW {"name":"Anna Bianchi"}',
        'CONTACTS.SELECT_ROW {"name":"Luca Verdi"}',
        'CONTACTS.SELECT_ROW {"name":"Rosa Neri"}',
      ]);
      expect(root.querySelector('.bulk [role=status]')).toBeNull();
      expect(selectAll().checked).toBe(false);
      await tick(checkboxes()[0]!);
      expect(root.querySelector('.bulk [role=status]')?.textContent).toBe(
        'CONTACTS.SELECTED {"count":1}',
      );
      expect(selectAll().checked).toBe(false);
      await tick(checkboxes()[1]!);
      await tick(checkboxes()[2]!);
      expect(selectAll().checked).toBe(true);
      await tick(checkboxes()[0]!, false);
      expect(selectAll().checked).toBe(false);
      await tick(selectAll());
      expect(checkboxes().map((box) => box.checked)).toEqual([true, true, true]);
      await tick(selectAll(), false);
      expect(checkboxes().some((box) => box.checked)).toBe(false);
      expect(root.querySelector('.bulk [role=status]')).toBeNull();
    });

    it('has no "select all" without contacts', async () => {
      const { root } = await open([]);
      expect(root.querySelector('.bulk')).not.toBeNull();
      expect(root.querySelector('.bulk fc-checkbox')).toBeNull();
    });

    it('has no selection without contacts:write', async () => {
      const { root, headers } = await open(rows3(), '', READ_ONLY);
      expect(headers()).not.toContain('CONTACTS.COLUMN.SELECT');
      expect(root.querySelector('td input[type=checkbox]')).toBeNull();
      expect(root.querySelector('.bulk')).toBeNull();
    });
  });

  describe('row actions', () => {
    const contact = contactRow(CONTACT_ID_1, { displayName: 'Anna Bianchi' });

    it('opens and trashes a contact with contacts:write', async () => {
      const { action } = await open([contact]);
      expect(action(0, 'CONTACTS.EDIT_LABEL')?.getAttribute('href')).toBe(
        `/groups/${GROUP}/contacts/${CONTACT_ID_1}`,
      );
      expect(action(0, 'CONTACTS.EDIT_LABEL')?.getAttribute('aria-label')).toBe(
        'CONTACTS.EDIT_LABEL {"name":"Anna Bianchi"}',
      );
      expect(action(0, 'CONTACTS.TRASH.LABEL')?.getAttribute('aria-label')).toBe(
        'CONTACTS.TRASH.LABEL {"name":"Anna Bianchi"}',
      );
    });

    it('offers only the opening without contacts:write', async () => {
      const { action, rows } = await open([contact], '', READ_ONLY);
      expect(action(0, 'CONTACTS.EDIT_LABEL')).not.toBeNull();
      expect(action(0, 'CONTACTS.TRASH.LABEL')).toBeNull();
      expect(rows()[0]!.querySelectorAll('td:last-child a, td:last-child button')).toHaveLength(1);
    });

    it('asks for confirmation and does nothing when the user cancels', async () => {
      const view = await open([contact]);
      view.action(0, 'CONTACTS.TRASH.LABEL')!.click();
      await view.view();
      const dialog = view.root.querySelector('dialog[open]')!;
      expect(dialog.textContent).toContain('CONTACTS.TRASH.TITLE');
      expect(dialog.textContent).toContain('CONTACTS.TRASH.CONFIRM_ONE {"name":"Anna Bianchi"}');
      expect(view.dialogButton('CONTACTS.TRASH.ACTION').getAttribute('data-variant')).toBe(
        'danger',
      );
      view.dialogButton('COMMON.CANCEL').click();
      await view.view();
      expect(view.root.querySelector('dialog[open]')).toBeNull();
    });

    it('moves the contact to the trash once confirmed and reports it', async () => {
      const view = await open([contact]);
      const invalidate = vi.spyOn(TestBed.inject(ReferenceStore), 'invalidate');
      view.action(0, 'CONTACTS.TRASH.LABEL')!.click();
      await view.view();
      view.dialogButton('CONTACTS.TRASH.ACTION').click();
      await view.view();
      const req = backend().expectOne(`${LIST}/trash`);
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({ ids: [CONTACT_ID_1] });
      expect(req.request.headers.has('If-Match')).toBe(false);
      req.flush({ data: { results: [{ id: CONTACT_ID_1, outcome: 'trashed' }] } });
      await view.view();
      expect(view.root.querySelector('dialog[open]')).toBeNull();
      const report = view.root.querySelector('.report')!;
      expect(report.getAttribute('role')).toBe('status');
      expect(report.textContent).toContain('CONTACTS.TRASH.REPORT_TRASHED {"count":1}');
      expect(report.querySelector('ul')).toBeNull();
      expect(invalidate).toHaveBeenCalledWith(GROUP, 'customers');
      expect(invalidate).toHaveBeenCalledWith(GROUP, 'suppliers');
      await view.flush([]);
    });

    it('shows a refusal of the trash in a toast', async () => {
      const view = await open([contact]);
      view.action(0, 'CONTACTS.TRASH.LABEL')!.click();
      await view.view();
      view.dialogButton('CONTACTS.TRASH.ACTION').click();
      await view.view();
      backend()
        .expectOne(`${LIST}/trash`)
        .flush(errorBody('FORBIDDEN'), { status: 403, statusText: 'x' });
      await view.view();
      expect(view.toasts()).toEqual(['error: ERRORS.API.FORBIDDEN']);
      expect(view.root.querySelector('.report')).toBeNull();
      expect(view.root.querySelector('dialog[open]')).toBeNull();
    });
  });

  describe('bulk trash', () => {
    const rows = () => [
      contactRow(CONTACT_ID_1, { displayName: 'Anna Bianchi' }),
      contactRow(CONTACT_ID_2, { displayName: 'Luca Verdi' }),
      contactRow(CONTACT_ID_3, { displayName: null, code: '' }),
      contactRow(CONTACT_ID_4, { displayName: 'Rosa Neri' }),
    ];
    const start = async () => {
      const view = await open(rows());
      await view.tick(view.selectAll());
      return view;
    };

    it('asks for confirmation with the count, then reports what happened to each contact', async () => {
      const view = await start();
      const invalidate = vi.spyOn(TestBed.inject(ReferenceStore), 'invalidate');
      view.root.querySelector<HTMLButtonElement>('.bulk button')!.click();
      await view.view();
      expect(view.root.querySelector('dialog[open]')!.textContent).toContain(
        'CONTACTS.TRASH.CONFIRM {"count":4}',
      );
      view.dialogButton('CONTACTS.TRASH.ACTION').click();
      await view.view();
      const req = backend().expectOne(`${LIST}/trash`);
      expect(req.request.body).toEqual({
        ids: [CONTACT_ID_1, CONTACT_ID_2, CONTACT_ID_3, CONTACT_ID_4],
      });
      req.flush({
        data: {
          results: [
            { id: CONTACT_ID_1, outcome: 'trashed' },
            { id: CONTACT_ID_2, outcome: 'skipped', issue: 'conflict' },
            { id: CONTACT_ID_3, outcome: 'skipped' },
            { id: CONTACT_ID_4, outcome: 'skipped', issue: 'alreadyTrashed' },
            { id: '665f1c2e9b1d4a0012ab3cff', outcome: 'skipped', issue: 'notFound' },
          ],
        },
      });
      await view.view();
      expect(view.root.querySelector('dialog[open]')).toBeNull();
      const report = view.root.querySelector('.report')!;
      expect(report.querySelector('h2')?.textContent).toBe('CONTACTS.TRASH.REPORT_TITLE');
      expect(report.textContent).toContain('CONTACTS.TRASH.REPORT_TRASHED {"count":1}');
      expect(report.textContent).toContain('CONTACTS.TRASH.REPORT_SKIPPED {"count":4}');
      expect([...report.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
        'CONTACTS.TRASH.REPORT_ITEM {"name":"Luca Verdi","issue":"CONTACTS.TRASH.ISSUE.CONFLICT"}',
        `CONTACTS.TRASH.REPORT_ITEM {"name":"…${CONTACT_ID_3.slice(-6)}","issue":"CONTACTS.TRASH.ISSUE.NOTFOUND"}`,
        'CONTACTS.TRASH.REPORT_ITEM {"name":"Rosa Neri","issue":"CONTACTS.TRASH.ISSUE.ALREADYTRASHED"}',
        'CONTACTS.TRASH.REPORT_ITEM {"name":"665f1c2e9b1d4a0012ab3cff","issue":"CONTACTS.TRASH.ISSUE.NOTFOUND"}',
      ]);
      expect(invalidate).toHaveBeenCalledWith(GROUP, 'customers');
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
      view.dialogButton('CONTACTS.TRASH.ACTION').click();
      await view.view();
      backend()
        .expectOne(`${LIST}/trash`)
        .flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' });
      await view.view();
      expect(view.toasts()).toEqual(['error: ERRORS.API.INTERNAL_ERROR']);
      expect(view.root.querySelector('.report')).toBeNull();
      expect(view.root.querySelector('dialog[open]')).toBeNull();
    });
  });
});
