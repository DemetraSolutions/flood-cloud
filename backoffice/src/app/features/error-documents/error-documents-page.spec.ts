import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  CanMatchFn,
  provideRouter,
  Route,
  Router,
  withComponentInputBinding,
} from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { routes } from '../../app.routes';
import { emulateNativeDialog } from '../../../testing/dialog';
import { API, backend, errorBody, provideApiTesting, settle } from '../../../testing/api';
import { fakeDealer } from '../../../testing/dealers';
import { GROUP } from '../../../testing/places';
import { signIn } from '../../../testing/session';
import { AppConfig } from '../../core/config/app-config';
import { LAST_GROUP_ID_KEY } from '../../core/groups/group-context';
import { I18nService } from '../../core/i18n/i18n.service';
import { Profile } from '../../core/session/session.types';
import { ErrorDocumentsPage } from './error-documents-page';
import { ErrorDocumentRow } from './error-documents.types';

const LIST = `${API}/v1/error-documents`;
const CSV = `${API}/v1/error-documents.csv`;
const DEALERS = `${API}/v1/dealers`;
const DEALER = '665f1c2e9b1d4a0012ab34d1';
const DEALER_2 = '665f1c2e9b1d4a0012ab34d2';

function row(overrides: Partial<ErrorDocumentRow> = {}): ErrorDocumentRow {
  return {
    id: '1',
    groupId: GROUP,
    groupName: 'Gruppo Esempio',
    companyName: 'SUSHINISI SRL',
    number: '105 M',
    date: '2026-09-25T12:00:00.000Z',
    documentType: 'invoice',
    eInvoiceType: 'TD01',
    customer: 'FABIOLA FREZZA',
    total: 33.8,
    sendStatus: 'rejected',
    error: { code: '0099', description: 'Riga 1\nRiga 2 <b>grassetto</b>' },
    ...overrides,
  };
}

const EMPTY_ROW = row({
  id: '2',
  groupName: null,
  companyName: null,
  number: null,
  date: null,
  documentType: null,
  eInvoiceType: null,
  customer: null,
  total: null,
  sendStatus: null,
  error: null,
});
const CREDIT_NOTE = row({
  id: '3',
  groupId: null,
  groupName: null,
  documentType: 'creditNote',
  eInvoiceType: null,
  date: 'garbage',
  error: { code: null, description: null },
});
const ONLY_FE = row({ id: '4', documentType: null, eInvoiceType: 'TD04' });

function page(data: ErrorDocumentRow[], next: string | null = null) {
  return { data, page: { limit: 50, next } };
}

async function render(
  url = '/tools/error-documents',
  profile: Partial<Profile> = {},
  group: string | null = null,
  withApi = true,
) {
  if (group !== null) {
    sessionStorage.setItem(LAST_GROUP_ID_KEY, group);
  }
  TestBed.configureTestingModule({
    providers: [
      ...provideApiTesting(),
      ...(withApi ? [] : [{ provide: AppConfig, useValue: { apiBaseUrl: signal(null) } }]),
      provideRouter(
        [
          { path: 'tools/error-documents', component: ErrorDocumentsPage },
          { path: '**', children: [] },
        ],
        withComponentInputBinding(),
      ),
    ],
  });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  signIn({
    role: 'PSA',
    groupId: null,
    group: null,
    permissions: ['errorDocuments:read', 'dealers:read'],
    ...profile,
  });
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(url);
  const root = harness.routeNativeElement as HTMLElement;
  document.body.appendChild(root);
  const router = TestBed.inject(Router);
  const view = async () => {
    await settle();
    harness.detectChanges();
    await settle();
    harness.detectChanges();
  };
  const request = () => backend().expectOne((r) => r.url === LIST);
  /** Answers the dealers read for the filter, when the page asks for them. */
  const dealers = async () => {
    backend()
      .expectOne((r) => r.url === DEALERS)
      .flush({
        data: [
          fakeDealer({ id: DEALER, businessName: 'Dealer Nord' }),
          fakeDealer({ id: DEALER_2, businessName: 'Dealer Sud' }),
        ],
        page: { limit: 100, next: null },
      });
    await view();
  };
  const flush = async (data: ErrorDocumentRow[], next: string | null = null) => {
    request().flush(page(data, next));
    await view();
  };
  const rows = () => [...root.querySelectorAll('tbody tr')];
  const cells = (index: number) =>
    [...rows()[index].querySelectorAll('th, td')].map((c) => c.textContent?.trim());
  const fieldOrNull = (label: string) => {
    const found = [...root.querySelectorAll('label')].find((l) => l.textContent?.trim() === label);
    return found === undefined
      ? null
      : root.querySelector<HTMLInputElement | HTMLSelectElement>(`#${found.htmlFor}`);
  };
  const field = (label: string) => fieldOrNull(label)!;
  const choose = async (label: string, value: string) => {
    const control = field(label);
    control.value = value;
    control.dispatchEvent(new Event('change'));
    await view();
  };
  const search = () => new URL(router.url, 'http://x').searchParams;
  const button = (text: string) =>
    [...root.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === text,
    )!;
  return {
    root,
    view,
    request,
    flush,
    dealers,
    rows,
    cells,
    field,
    fieldOrNull,
    choose,
    search,
    button,
  };
}

describe('ErrorDocumentsPage', () => {
  beforeEach(() => {
    sessionStorage.clear();
    emulateNativeDialog();
  });

  afterEach(() => {
    for (const request of backend().match(() => true)) {
      request.flush({ data: [], page: { limit: 100, next: null } });
    }
    backend().verify();
    vi.restoreAllMocks();
    document.body.replaceChildren();
    sessionStorage.clear();
  });

  describe('table', () => {
    it('requests the first page with the default limit and no filter', async () => {
      const { request, view, dealers } = await render();
      const req = request();
      expect(req.request.params.keys()).toEqual(['limit']);
      expect(req.request.params.get('limit')).toBe('50');
      req.flush(page([]));
      await dealers();
      await view();
    });

    it('shows the legacy columns, the group and the error code', async () => {
      const { flush, cells, root, dealers } = await render();
      await flush([row(), EMPTY_ROW, CREDIT_NOTE, ONLY_FE]);
      await dealers();
      expect(root.querySelector('h1')?.textContent).toBe('ERROR_DOCUMENTS.TITLE');
      expect(root.querySelector('caption')?.textContent?.trim()).toBe('ERROR_DOCUMENTS.TITLE');
      expect([...root.querySelectorAll('thead th')].map((th) => th.textContent?.trim())).toEqual([
        'ERROR_DOCUMENTS.DETAIL',
        'ERROR_DOCUMENTS.COLUMN.NUMBER',
        'ERROR_DOCUMENTS.COLUMN.DATE',
        'ERROR_DOCUMENTS.COLUMN.TYPE',
        'ERROR_DOCUMENTS.COLUMN.CUSTOMER',
        'ERROR_DOCUMENTS.COLUMN.TOTAL',
        'ERROR_DOCUMENTS.COLUMN.COMPANY',
        'ERROR_DOCUMENTS.COLUMN.GROUP',
        'ERROR_DOCUMENTS.COLUMN.ERROR_CODE',
      ]);
      const first = cells(0);
      expect(first.slice(1, 5)).toEqual([
        '105 M',
        '25-09-2026',
        'ERROR_DOCUMENTS.TYPE.INVOICE TD01',
        'FABIOLA FREZZA',
      ]);
      expect(first[5]).toMatch(/33,80\s€/);
      expect(first.slice(6)).toEqual(['SUSHINISI SRL', 'Gruppo Esempio', '0099']);
      expect(cells(1).slice(1)).toEqual(Array(8).fill('—'));
      // Invalid date, no FE type, error without a code.
      expect(cells(2)[7]).toBe('—');
      expect(cells(2).slice(2, 4)).toEqual(['—', 'ERROR_DOCUMENTS.TYPE.CREDIT_NOTE']);
      expect(cells(2)[8]).toBe('—');
      expect(cells(3)[3]).toBe('TD04');
    });

    it('shows a loading table, then the empty state', async () => {
      const { request, root, view } = await render();
      expect(root.querySelector('table')?.getAttribute('aria-busy')).toBe('true');
      request().flush(page([]));
      await view();
      expect(root.querySelector('fc-empty-state')?.textContent).toContain(
        'ERROR_DOCUMENTS.EMPTY_MESSAGE',
      );
    });

    it('shows the error and retries', async () => {
      const { request, root, view } = await render();
      request().flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' });
      await view();
      expect(root.querySelector('fc-error-state')?.textContent).toContain(
        'ERROR_DOCUMENTS.LOAD_ERROR',
      );
      expect(root.querySelector('table')).toBeNull();
      root.querySelector<HTMLButtonElement>('fc-error-state button')!.click();
      await view();
      request().flush(page([row()]));
      await view();
      expect(root.querySelectorAll('tbody tr')).toHaveLength(1);
    });

    it('reports an unexpected failure generically', async () => {
      const { root, view } = await render(undefined, {}, null, false);
      await view();
      expect(root.querySelector('fc-error-state')?.textContent).toContain('ERRORS.GENERIC.MESSAGE');
    });

    it('sends the working group', async () => {
      const { request, dealers } = await render(undefined, {}, GROUP);
      const req = request();
      expect(req.request.params.get('groupId')).toBe(GROUP);
      req.flush(page([]));
      await dealers();
    });
  });

  describe('error detail', () => {
    it('opens a dialog with the description as plain text and closes it', async () => {
      const { flush, root, view, button, dealers } = await render();
      await flush([row(), EMPTY_ROW, CREDIT_NOTE]);
      await dealers();
      const buttons = root.querySelectorAll<HTMLButtonElement>('tbody button.detail-button');
      expect(buttons).toHaveLength(3);
      expect(buttons[0].getAttribute('aria-label')).toBe('ERROR_DOCUMENTS.DETAIL');
      expect(root.querySelector('dialog')?.hasAttribute('open')).toBe(false);
      buttons[0].click();
      await view();
      expect(root.querySelector('dialog')?.hasAttribute('open')).toBe(true);
      const description = root.querySelector('.error-description') as HTMLElement;
      expect(description.textContent?.trim()).toBe('Riga 1\nRiga 2 <b>grassetto</b>');
      expect(description.querySelector('b')).toBeNull();
      expect(root.querySelector('.error-code')?.textContent).toContain('0099');
      button('COMMON.CLOSE').click();
      await view();
      expect(root.querySelector('dialog')?.hasAttribute('open')).toBe(false);
      expect(root.querySelector('.error-description')).toBeNull();
    });

    it('says when there is no description or code', async () => {
      const { flush, root, view, dealers } = await render();
      await flush([EMPTY_ROW, CREDIT_NOTE]);
      await dealers();
      const buttons = root.querySelectorAll<HTMLButtonElement>('tbody button.detail-button');
      buttons[0].click();
      await view();
      expect(root.querySelector('.error-description')?.textContent).toContain(
        'ERROR_DOCUMENTS.NO_DESCRIPTION',
      );
      expect(root.querySelector('.error-code')).toBeNull();
      root.querySelector<HTMLButtonElement>('dialog header button')!.click();
      await view();
      buttons[1].click();
      await view();
      expect(root.querySelector('.error-description')?.textContent).toContain(
        'ERROR_DOCUMENTS.NO_DESCRIPTION',
      );
      expect(root.querySelector('.error-code')).toBeNull();
    });
  });

  describe('filters in the URL', () => {
    it('sends the filters it finds in the URL', async () => {
      const { request, dealers } = await render(
        `/tools/error-documents?dealerId=${DEALER}&documentType=creditNote&errorCode=%200099%20&cursor=c1&limit=25`,
        {},
        GROUP,
      );
      const { params } = request().request;
      expect(params.get('groupId')).toBe(GROUP);
      expect(params.get('dealerId')).toBe(DEALER);
      expect(params.get('documentType')).toBe('creditNote');
      expect(params.get('errorCode')).toBe('0099');
      expect(params.get('cursor')).toBe('c1');
      expect(params.get('limit')).toBe('25');
      await dealers();
    });

    it('ignores the invalid filters', async () => {
      const { request, dealers } = await render(
        '/tools/error-documents?dealerId=xyz&documentType=nope&errorCode=a-b&limit=7',
      );
      expect(request().request.params.keys()).toEqual(['limit']);
      await dealers();
    });

    it('shows the filters of the URL in the controls', async () => {
      const { flush, dealers, field } = await render(
        `/tools/error-documents?dealerId=${DEALER_2}&documentType=invoice&errorCode=77`,
      );
      await flush([]);
      await dealers();
      expect(field('ERROR_DOCUMENTS.FILTER.DEALER').value).toBe(DEALER_2);
      expect(field('ERROR_DOCUMENTS.FILTER.TYPE').value).toBe('invoice');
      expect(field('ERROR_DOCUMENTS.FILTER.ERROR_CODE').value).toBe('77');
      const dealerSelect = field('ERROR_DOCUMENTS.FILTER.DEALER') as HTMLSelectElement;
      expect([...dealerSelect.options].map((o) => o.textContent?.trim())).toEqual([
        'ERROR_DOCUMENTS.FILTER.ALL_DEALERS',
        'Dealer Nord',
        'Dealer Sud',
      ]);
    });

    it('changes the filters in the URL and resets the cursor', async () => {
      const { request, view, choose, search, dealers } = await render(
        '/tools/error-documents?cursor=c9',
      );
      request().flush(page([]));
      await dealers();
      await choose('ERROR_DOCUMENTS.FILTER.TYPE', 'invoice');
      expect(search().get('documentType')).toBe('invoice');
      expect(search().has('cursor')).toBe(false);
      request().flush(page([]));
      await view();
      await choose('ERROR_DOCUMENTS.FILTER.DEALER', DEALER);
      expect(search().get('dealerId')).toBe(DEALER);
      request().flush(page([]));
      await view();
      for (const [label, name] of [
        ['ERROR_DOCUMENTS.FILTER.DEALER', 'dealerId'],
        ['ERROR_DOCUMENTS.FILTER.TYPE', 'documentType'],
      ]) {
        await choose(label, '');
        expect(search().has(name)).toBe(false);
        request().flush(page([]));
        await view();
      }
    });

    it('filters by error code after the user stops typing', async () => {
      const { request, field, search, view, dealers } = await render();
      request().flush(page([]));
      await dealers();
      const input = field('ERROR_DOCUMENTS.FILTER.ERROR_CODE');
      input.value = ' 0099 ';
      input.dispatchEvent(new Event('input'));
      await new Promise((resolve) => setTimeout(resolve, 350));
      await view();
      expect(search().get('errorCode')).toBe('0099');
      request().flush(page([]));
      await view();
      input.value = '  ';
      input.dispatchEvent(new Event('input'));
      await new Promise((resolve) => setTimeout(resolve, 350));
      await view();
      expect(search().has('errorCode')).toBe(false);
      request().flush(page([]));
      await view();
    });

    it('does not submit the page', async () => {
      const { request, root, view, dealers } = await render();
      request().flush(page([]));
      await dealers();
      await view();
      const event = new Event('submit', { cancelable: true });
      root.querySelector('form')!.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    });
  });

  describe('dealer filter', () => {
    it.each([
      ['a dealer', { role: 'D' as const, permissions: ['errorDocuments:read', 'dealers:read'] }],
      ['a platform administrator without dealers:read', { permissions: ['errorDocuments:read'] }],
    ])('is hidden, never read nor sent, for %s', async (_name, profile) => {
      const { request, fieldOrNull, view } = await render(
        `/tools/error-documents?dealerId=${DEALER}`,
        profile,
      );
      expect(request().request.params.keys()).toEqual(['limit']);
      await view();
      expect(fieldOrNull('ERROR_DOCUMENTS.FILTER.DEALER')).toBeNull();
      expect(backend().match((r) => r.url === DEALERS)).toHaveLength(0);
    });
  });

  describe('pagination', () => {
    it('moves along the cursors and changes the page size', async () => {
      const { request, flush, button, view, search, choose, dealers } = await render();
      await flush([row()], 'c1');
      await dealers();
      expect(button('PAGINATION.PREVIOUS').disabled).toBe(true);
      button('PAGINATION.NEXT').click();
      await view();
      expect(search().get('cursor')).toBe('c1');
      const second = request();
      expect(second.request.params.get('cursor')).toBe('c1');
      second.flush(page([row()]));
      await view();
      button('PAGINATION.PREVIOUS').click();
      await view();
      expect(search().has('cursor')).toBe(false);
      request().flush(page([row()], 'c1'));
      await view();
      await choose('PAGINATION.PER_PAGE', '100');
      expect(search().get('limit')).toBe('100');
      expect(request().request.params.get('limit')).toBe('100');
    });
  });

  describe('CSV download', () => {
    let created: Blob[];
    let revoked: string[];
    let clicked: HTMLAnchorElement[];

    beforeEach(() => {
      created = [];
      revoked = [];
      clicked = [];
      URL.createObjectURL = vi.fn((blob: Blob) => {
        created.push(blob);
        return 'blob:test';
      });
      URL.revokeObjectURL = vi.fn((url: string) => {
        revoked.push(url);
      });
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
        this: HTMLAnchorElement,
      ) {
        clicked.push(this);
      });
    });

    it('downloads the file with the filters of the table and without the page', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-17T10:00:00Z') });
      try {
        const { request, button, view, root, dealers } = await render(
          '/tools/error-documents?documentType=invoice&errorCode=0099&cursor=c1&limit=25',
          {},
          GROUP,
        );
        request().flush(page([row()]));
        await dealers();
        button('ERROR_DOCUMENTS.DOWNLOAD').click();
        await view();
        const req = backend().expectOne((r) => r.url === CSV);
        expect(req.request.responseType).toBe('blob');
        expect(req.request.params.keys().sort()).toEqual(['documentType', 'errorCode', 'groupId']);
        expect(button('ERROR_DOCUMENTS.DOWNLOAD').disabled).toBe(true);
        expect(root.querySelector('[role="status"]')?.textContent?.trim()).toBe(
          'ERROR_DOCUMENTS.DOWNLOADING',
        );
        req.flush(new Blob(['a;b']));
        await view();
        expect(created).toHaveLength(1);
        expect(clicked[0].download).toBe('error-documents_2026-11-17.csv');
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(revoked).toEqual(['blob:test']);
        expect(button('ERROR_DOCUMENTS.DOWNLOAD').disabled).toBe(false);
        expect(root.querySelector('[role="status"]')?.textContent?.trim()).toBe('');
      } finally {
        vi.useRealTimers();
      }
    });

    it.each([
      [413, 'PAYLOAD_TOO_LARGE', 'ERROR_DOCUMENTS.DOWNLOAD_ERROR.TOO_LARGE'],
      [429, 'RATE_LIMITED', 'ERROR_DOCUMENTS.DOWNLOAD_ERROR.TOO_MANY'],
      [500, 'INTERNAL_ERROR', 'ERROR_DOCUMENTS.DOWNLOAD_ERROR.GENERIC'],
    ])('maps a %i failure to its message', async (status, code, key) => {
      const { flush, button, view, root, dealers } = await render();
      await flush([row()]);
      await dealers();
      button('ERROR_DOCUMENTS.DOWNLOAD').click();
      await view();
      backend()
        .expectOne((r) => r.url === CSV)
        .flush(new Blob([JSON.stringify(errorBody(code))]), { status, statusText: code });
      await view();
      expect(root.querySelector('[role="status"]')?.textContent?.trim()).toBe(key);
      expect(button('ERROR_DOCUMENTS.DOWNLOAD').disabled).toBe(false);
      expect(created).toHaveLength(0);
    });

    it('reports a failure to save as generic', async () => {
      const { flush, button, view, root, dealers } = await render();
      await flush([row()]);
      await dealers();
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
        throw new Error('blocked');
      });
      button('ERROR_DOCUMENTS.DOWNLOAD').click();
      await view();
      backend()
        .expectOne((r) => r.url === CSV)
        .flush(new Blob(['x']));
      await view();
      expect(root.querySelector('[role="status"]')?.textContent?.trim()).toBe(
        'ERROR_DOCUMENTS.DOWNLOAD_ERROR.GENERIC',
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(revoked).toEqual(['blob:test']);
    });

    it('reports a network failure as generic', async () => {
      const { flush, button, view, root, dealers } = await render();
      await flush([row()]);
      await dealers();
      button('ERROR_DOCUMENTS.DOWNLOAD').click();
      await view();
      backend()
        .expectOne((r) => r.url === CSV)
        .error(new ProgressEvent('error'));
      await view();
      expect(root.querySelector('[role="status"]')?.textContent?.trim()).toBe(
        'ERROR_DOCUMENTS.DOWNLOAD_ERROR.GENERIC',
      );
    });
  });
});

describe('error documents route', () => {
  function route() {
    const find = (list: readonly Route[]): Route | undefined => {
      for (const item of list) {
        if (item.path === 'tools/error-documents') {
          return item;
        }
        const found = find(item.children ?? []);
        if (found !== undefined) {
          return found;
        }
      }
      return undefined;
    };
    return find(routes) as Route;
  }

  it('is protected by the errorDocuments:read permission and titled', async () => {
    const found = route();
    expect(found.title).toBe('ERROR_DOCUMENTS.TITLE');
    expect(found.canMatch).toHaveLength(1);
    expect(await found.loadComponent?.()).toBe(ErrorDocumentsPage);
  });

  it.each([
    [['errorDocuments:read'], true],
    [['places:read'], false],
  ])('matches only with the permission (%j)', (permissions, allowed) => {
    TestBed.configureTestingModule({ providers: [...provideApiTesting(), provideRouter([])] });
    signIn({ role: 'PSA', permissions });
    const guard = (route().canMatch as CanMatchFn[])[0];
    expect(TestBed.runInInjectionContext(() => guard(route(), [], {} as never)) === true).toBe(
      allowed,
    );
  });
});
