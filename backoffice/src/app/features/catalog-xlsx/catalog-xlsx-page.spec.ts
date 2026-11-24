import { Provider } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { API, backend, errorBody, provideApiTesting, settle } from '../../../testing/api';
import { emulateNativeDialog } from '../../../testing/dialog';
import { signIn } from '../../../testing/session';
import { I18nService } from '../../core/i18n/i18n.service';
import { ReferenceStore } from '../../core/reference/reference-store';
import { Profile } from '../../core/session/session.types';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { CatalogXlsxPage } from './catalog-xlsx-page';
import { ImportOutcome } from './catalog-xlsx.types';

const GROUP = '665f1c2e9b1d4a0012ab34a1';
const BASE = `${API}/v1/groups/${GROUP}`;
const TEMPLATE = `${BASE}/catalog-export/template`;
const EXPORT = `${BASE}/catalog-export`;
const IMPORT = `${BASE}/catalog-import`;

const counts = (inserted: number, updated: number, removed: number, unchanged: number) => ({
  inserted,
  updated,
  removed,
  unchanged,
});
const OUTCOME: ImportOutcome = {
  dryRun: true,
  sheets: {
    products: counts(3, 2, 1, 10),
    variants: counts(0, 0, 0, 4),
    categories: counts(1, 0, 0, 2),
  },
};
const NOTHING: ImportOutcome = {
  dryRun: true,
  sheets: {
    products: counts(0, 0, 0, 5),
    variants: counts(0, 0, 0, 0),
    categories: counts(0, 0, 0, 1),
  },
};
const xlsx = (name = 'catalog.xlsx', size = 1000) =>
  Object.defineProperty(new File(['x'], name), 'size', { value: size }) as File;

async function render(profile: Partial<Profile> = {}, extra: Provider[] = []) {
  emulateNativeDialog();
  TestBed.configureTestingModule({
    providers: [
      ...provideApiTesting(),
      ...extra,
      provideRouter(
        [
          { path: 'groups/:groupId/tools/catalog-import-export', component: CatalogXlsxPage },
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
    role: 'SA',
    groupId: GROUP,
    permissions: ['products:read', 'products:update', 'profile:read'],
    ...profile,
  });
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(`/groups/${GROUP}/tools/catalog-import-export`);
  const root = harness.routeNativeElement as HTMLElement;
  document.body.appendChild(root);
  const view = async () => {
    await settle();
    harness.detectChanges();
    await settle();
    harness.detectChanges();
  };
  await view();
  const button = (text: string) =>
    [...root.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === text,
    )!;
  const dialogButton = (text: string) =>
    [...root.querySelectorAll<HTMLButtonElement>('dialog[open] button')].find(
      (b) => b.textContent?.trim() === text,
    )!;
  const status = () => root.querySelector('[role="status"]')?.textContent?.trim();
  const toasts = () =>
    TestBed.inject(ToastService)
      .toasts()
      .map((t) => `${t.kind}: ${t.message}`);
  /** Chooses a file in the hidden input, as the browser does. */
  const choose = async (file: File | null) => {
    const input = root.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, 'files', {
      value: file === null ? [] : [file],
      configurable: true,
    });
    input.dispatchEvent(new Event('change'));
    await view();
  };
  const importRequest = (dryRun: boolean) =>
    backend().expectOne((r) => r.url === IMPORT && r.params.has('dryRun') === dryRun);
  /** Chooses a file and checks it with the answer given. */
  const verify = async (file: File, outcome: ImportOutcome = OUTCOME) => {
    await choose(file);
    button('CATALOG_XLSX.IMPORT.VERIFY').click();
    await view();
    importRequest(true).flush({ data: outcome });
    await view();
  };
  const rows = (index = 0) =>
    [...root.querySelectorAll('fc-data-table')[index]!.querySelectorAll('tbody tr')].map((tr) =>
      [...tr.querySelectorAll('th, td')].map((c) => c.textContent?.trim()),
    );
  return { root, view, button, dialogButton, status, toasts, choose, importRequest, verify, rows };
}

/** Records the files offered to the browser as downloads. */
function captureDownloads() {
  const names: string[] = [];
  URL.createObjectURL = vi.fn(() => 'blob:test');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    names.push(this.download);
  });
  return names;
}

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
  sessionStorage.clear();
});

describe('CatalogXlsxPage', () => {
  describe('model and export', () => {
    it('downloads the model for the group', async () => {
      const names = captureDownloads();
      const { button, view, status, root } = await render();
      expect(root.querySelector('h1')?.textContent).toBe('CATALOG_XLSX.TITLE');
      button('CATALOG_XLSX.TEMPLATE.ACTION').click();
      await view();
      const request = backend().expectOne(TEMPLATE);
      expect(request.request.responseType).toBe('blob');
      expect(status()).toBe('CATALOG_XLSX.DOWNLOADING');
      expect(button('CATALOG_XLSX.TEMPLATE.ACTION').getAttribute('aria-busy')).toBe('true');
      expect(button('CATALOG_XLSX.EXPORT.ACTION').disabled).toBe(true);
      request.flush(new Blob(['x']));
      await view();
      expect(names).toEqual(['catalog-model.xlsx']);
      expect(status()).toBe('');
      expect(button('CATALOG_XLSX.TEMPLATE.ACTION').disabled).toBe(false);
    });

    it('exports with ids by default, and with names when the user chooses them, explaining each choice', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-16T10:00:00Z') });
      try {
        const names = captureDownloads();
        const { button, view, root } = await render();
        const [ids, namesRadio] = [
          ...root.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
        ];
        expect(ids!.checked).toBe(true);
        expect(root.querySelector('fieldset legend')?.textContent?.trim()).toBe(
          'CATALOG_XLSX.EXPORT.REFERENCES',
        );
        expect(root.querySelector('#references-help')?.textContent?.trim()).toBe(
          'CATALOG_XLSX.EXPORT.IDS_HELP',
        );
        button('CATALOG_XLSX.EXPORT.ACTION').click();
        await view();
        const first = backend().expectOne((r) => r.url === EXPORT);
        expect(first.request.params.get('references')).toBe('ids');
        first.flush(new Blob(['x']));
        await view();
        namesRadio!.click();
        await view();
        expect(namesRadio!.checked).toBe(true);
        expect(root.querySelector('#references-help')?.textContent?.trim()).toBe(
          'CATALOG_XLSX.EXPORT.NAMES_HELP',
        );
        button('CATALOG_XLSX.EXPORT.ACTION').click();
        await view();
        const second = backend().expectOne((r) => r.url === EXPORT);
        expect(second.request.params.get('references')).toBe('names');
        second.flush(new Blob(['x']));
        await view();
        expect(names).toEqual(['catalog_2026-11-16.xlsx', 'catalog_2026-11-16.xlsx']);
        ids!.click();
        await view();
        expect(root.querySelector('#references-help')?.textContent?.trim()).toBe(
          'CATALOG_XLSX.EXPORT.IDS_HELP',
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it.each([
      [413, 'PAYLOAD_TOO_LARGE', {}, 'CATALOG_XLSX.DOWNLOAD_ERROR.TOO_LARGE'],
      [429, 'RATE_LIMITED', {}, 'CATALOG_XLSX.DOWNLOAD_ERROR.RATE_LIMITED'],
      [
        429,
        'RATE_LIMITED',
        { 'Retry-After': '30' },
        'CATALOG_XLSX.DOWNLOAD_ERROR.RATE_LIMITED_WAIT {"seconds":30}',
      ],
      [409, 'CONFLICT', {}, 'CATALOG_XLSX.DOWNLOAD_ERROR.BUSY'],
      [500, 'INTERNAL_ERROR', {}, 'CATALOG_XLSX.DOWNLOAD_ERROR.GENERIC'],
    ])(
      'explains a %i failure of the export and lets the user try again',
      async (status, code, headers, message) => {
        captureDownloads();
        const { button, view, root } = await render();
        button('CATALOG_XLSX.EXPORT.ACTION').click();
        await view();
        backend()
          .expectOne((r) => r.url === EXPORT)
          .flush(new Blob([JSON.stringify(errorBody(code))]), {
            status,
            statusText: code,
            headers,
          });
        await view();
        expect(root.querySelector('.problem[role="alert"]')?.textContent).toBe(message);
        expect(button('CATALOG_XLSX.EXPORT.ACTION').disabled).toBe(false);
        // The message goes away when the user tries again.
        button('CATALOG_XLSX.EXPORT.ACTION').click();
        await view();
        expect(root.querySelector('.problem')).toBeNull();
        backend()
          .expectOne((r) => r.url === EXPORT)
          .flush(new Blob(['x']));
        await view();
      },
    );

    it('is open to who reads the catalog but shows no import to who cannot update it', async () => {
      const { root } = await render({ permissions: ['products:read', 'profile:read'] });
      expect(root.querySelector('#template-heading')).not.toBeNull();
      expect(root.querySelector('#export-heading')).not.toBeNull();
      expect(root.querySelector('#import-heading')).toBeNull();
    });
  });

  describe('rules', () => {
    it('explains the rules of the file in a collapsible section', async () => {
      const { root } = await render();
      const details = root.querySelector('details')!;
      expect(details.open).toBe(false);
      expect(details.querySelector('summary')?.textContent).toBe('CATALOG_XLSX.RULES.TITLE');
      expect([...details.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
        'CATALOG_XLSX.RULES.SHEETS',
        'CATALOG_XLSX.RULES.ID',
        'CATALOG_XLSX.RULES.DELETE',
        'CATALOG_XLSX.RULES.ABSENT_COLUMN',
        'CATALOG_XLSX.RULES.PLACES',
        'CATALOG_XLSX.RULES.NOT_IN_FILE',
      ]);
    });
  });

  describe('check and import', () => {
    it('opens the file chooser, which takes xlsx files only, and offers nothing before a file is chosen', async () => {
      const { root, button } = await render();
      const input = root.querySelector<HTMLInputElement>('input[type="file"]')!;
      expect(input.hidden).toBe(true);
      expect(input.accept).toContain('.xlsx');
      const click = vi.spyOn(input, 'click').mockImplementation(() => undefined);
      button('CATALOG_XLSX.IMPORT.CHOOSE').click();
      expect(click).toHaveBeenCalledOnce();
      expect(button('CATALOG_XLSX.IMPORT.VERIFY')).toBeUndefined();
      expect(button('CATALOG_XLSX.IMPORT.ACTION')).toBeUndefined();
    });

    it('checks the file with dryRun, shows the counts per sheet, and offers the import only after that', async () => {
      const { button, view, root, rows, status, importRequest, choose } = await render();
      await choose(xlsx('catalog.xlsx', 2048));
      expect(root.querySelector('.file')?.textContent).toBe(
        'CATALOG_XLSX.IMPORT.FILE {"name":"catalog.xlsx","size":"2"}',
      );
      expect(button('CATALOG_XLSX.IMPORT.ACTION')).toBeUndefined();
      button('CATALOG_XLSX.IMPORT.VERIFY').click();
      await view();
      const check = importRequest(true);
      expect(check.request.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
      expect(((check.request.body as FormData).get('file') as File).name).toBe('catalog.xlsx');
      expect(status()).toBe('CATALOG_XLSX.IMPORT.VERIFYING');
      expect(button('CATALOG_XLSX.IMPORT.VERIFY').disabled).toBe(true);
      check.flush({ data: OUTCOME });
      await view();
      expect(status()).toBe('');
      expect(rows()).toEqual([
        ['CATALOG_XLSX.SHEET.PRODUCTS', '3', '2', '1', '10'],
        ['CATALOG_XLSX.SHEET.VARIANTS', '0', '0', '0', '4'],
        ['CATALOG_XLSX.SHEET.CATEGORIES', '1', '0', '0', '2'],
      ]);
      expect([...root.querySelectorAll('thead th')].map((th) => th.textContent?.trim())).toEqual([
        'CATALOG_XLSX.COUNTS.SHEET',
        'CATALOG_XLSX.COUNTS.INSERTED',
        'CATALOG_XLSX.COUNTS.UPDATED',
        'CATALOG_XLSX.COUNTS.REMOVED',
        'CATALOG_XLSX.COUNTS.UNCHANGED',
      ]);
      expect(button('CATALOG_XLSX.IMPORT.ACTION')).toBeDefined();
      // The heading of the answer takes the focus.
      expect(document.activeElement?.id).toBe('verified-heading');
    });

    it('asks for a confirmation with the counts, then imports with the same key on a retry, and drops the cached catalog lists', async () => {
      const store = { invalidate: vi.fn() };
      const { button, dialogButton, view, root, rows, importRequest, verify, toasts } =
        await render({}, [{ provide: ReferenceStore, useValue: store }]);
      await verify(xlsx('big.xlsx'));
      button('CATALOG_XLSX.IMPORT.ACTION').click();
      await view();
      expect(root.querySelector('dialog')?.textContent).toContain(
        'CATALOG_XLSX.IMPORT.CONFIRM {"name":"big.xlsx","inserted":"4","updated":"2","removed":"1"}',
      );
      expect(
        dialogButton('CATALOG_XLSX.IMPORT.CONFIRM_ACTION').getAttribute('data-variant'),
      ).toBe('danger');
      // Nothing is sent before the confirmation; a network failure keeps the check, so the next try sends the same key.
      backend().expectNone((r) => r.url === IMPORT);
      dialogButton('CATALOG_XLSX.IMPORT.CONFIRM_ACTION').click();
      await view();
      const first = importRequest(false);
      expect(root.querySelector('[role="status"]')?.textContent).toBe(
        'CATALOG_XLSX.IMPORT.IMPORTING',
      );
      first.error(new ProgressEvent('error'));
      await view();
      expect(root.querySelector('dialog')?.hasAttribute('open')).toBe(false);
      expect(button('CATALOG_XLSX.IMPORT.ACTION')).toBeDefined();
      expect(store.invalidate).not.toHaveBeenCalled();
      button('CATALOG_XLSX.IMPORT.ACTION').click();
      await view();
      dialogButton('CATALOG_XLSX.IMPORT.CONFIRM_ACTION').click();
      await view();
      const second = importRequest(false);
      expect(second.request.headers.get('Idempotency-Key')).toBe(
        first.request.headers.get('Idempotency-Key'),
      );
      expect(((second.request.body as FormData).get('file') as File).name).toBe('big.xlsx');
      second.flush({ data: { ...OUTCOME, dryRun: false } });
      await view();
      expect(toasts()).toEqual(['success: CATALOG_XLSX.IMPORT.DONE']);
      expect(store.invalidate).toHaveBeenCalledWith(GROUP, 'product-categories');
      expect(store.invalidate).toHaveBeenCalledWith(GROUP, 'products');
      expect(root.querySelector('#done-heading')?.textContent).toBe('CATALOG_XLSX.IMPORT.DONE');
      expect(root.querySelector('#done-heading')?.parentElement?.textContent).toContain(
        'CATALOG_XLSX.IMPORT.ACTIVITY',
      );
      // Without the permission to read the log there is no link.
      expect(root.querySelector('#done-heading')?.parentElement?.querySelector('a')).toBeNull();
      expect(rows()[0]).toEqual(['CATALOG_XLSX.SHEET.PRODUCTS', '3', '2', '1', '10']);
      expect(button('CATALOG_XLSX.IMPORT.ACTION')).toBeUndefined();
      expect(button('CATALOG_XLSX.IMPORT.VERIFY')).toBeUndefined();
      expect(document.activeElement?.id).toBe('done-heading');
    });

    it('links to the activity log after an import for who can read it', async () => {
      const { button, dialogButton, view, root, importRequest, verify } = await render({
        permissions: ['products:read', 'products:update', 'activityLog:read', 'profile:read'],
      });
      await verify(xlsx());
      button('CATALOG_XLSX.IMPORT.ACTION').click();
      await view();
      dialogButton('CATALOG_XLSX.IMPORT.CONFIRM_ACTION').click();
      await view();
      importRequest(false).flush({ data: { ...OUTCOME, dryRun: false } });
      await view();
      expect(root.querySelector('#done-heading')?.parentElement?.querySelector('a')?.getAttribute('href')).toBe(
        '/activity-log',
      );
    });

    it('uses a new key for each check', async () => {
      const { button, view, importRequest, choose } = await render();
      await choose(xlsx());
      const keys: (string | null)[] = [];
      for (let attempt = 0; attempt < 2; attempt++) {
        button('CATALOG_XLSX.IMPORT.VERIFY').click();
        await view();
        const check = importRequest(true);
        keys.push(check.request.headers.get('Idempotency-Key'));
        check.flush({ data: OUTCOME });
        await view();
      }
      expect(keys[0]).not.toBe(keys[1]);
    });

    it('does not offer the import for a file that changes nothing, and says so', async () => {
      const { button, verify, root } = await render();
      await verify(xlsx(), NOTHING);
      expect(root.querySelector('#verified-heading')?.parentElement?.textContent).toContain(
        'CATALOG_XLSX.IMPORT.NO_CHANGES',
      );
      expect(button('CATALOG_XLSX.IMPORT.ACTION')).toBeUndefined();
    });

    it('cancels the confirmation without sending anything', async () => {
      const { button, dialogButton, verify, view, root } = await render();
      await verify(xlsx());
      button('CATALOG_XLSX.IMPORT.ACTION').click();
      await view();
      dialogButton('COMMON.CANCEL').click();
      await view();
      expect(root.querySelector('dialog')?.hasAttribute('open')).toBe(false);
      expect(button('CATALOG_XLSX.IMPORT.ACTION')).toBeDefined();
    });

    it('asks for a new check when another file is chosen, and forgets the answer of the first', async () => {
      const { button, verify, choose, root } = await render();
      await verify(xlsx('first.xlsx'));
      expect(button('CATALOG_XLSX.IMPORT.ACTION')).toBeDefined();
      await choose(xlsx('second.xlsx'));
      expect(button('CATALOG_XLSX.IMPORT.ACTION')).toBeUndefined();
      expect(root.querySelector('#verified-heading')).toBeNull();
      expect(button('CATALOG_XLSX.IMPORT.VERIFY')).toBeDefined();
      expect(root.querySelector('.file')?.textContent).toContain('second.xlsx');
    });

    it('does nothing when the chooser is cancelled, and keeps the file that was chosen', async () => {
      const { choose, verify, button } = await render();
      await verify(xlsx());
      await choose(null);
      expect(button('CATALOG_XLSX.IMPORT.ACTION')).toBeDefined();
    });

    it('refuses before sending a file that is not an .xlsx, is empty or is too large, and clears the message on the next valid choice', async () => {
      const { choose, root, button } = await render();
      const message = () => root.querySelector('.problem[role="alert"]')?.textContent;
      await choose(xlsx('catalog.csv'));
      expect(message()).toBe('CATALOG_XLSX.IMPORT.CLIENT_ERROR.TYPE');
      expect(button('CATALOG_XLSX.IMPORT.VERIFY')).toBeUndefined();
      await choose(xlsx('catalog.xlsx', 0));
      expect(message()).toBe('CATALOG_XLSX.IMPORT.CLIENT_ERROR.EMPTY');
      await choose(xlsx('catalog.xlsx', 10 * 1024 * 1024 + 1));
      expect(message()).toBe('CATALOG_XLSX.IMPORT.CLIENT_ERROR.SIZE');
      await choose(xlsx());
      expect(message()).toBeUndefined();
      expect(button('CATALOG_XLSX.IMPORT.VERIFY')).toBeDefined();
    });

    it('lists the problems of a refused file in a table, with the count of the ones not shown, and offers nothing to apply', async () => {
      const { button, view, root, importRequest, choose } = await render();
      await choose(xlsx());
      button('CATALOG_XLSX.IMPORT.VERIFY').click();
      await view();
      importRequest(true).flush(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'm',
            rows: [
              { sheet: 'Prodotti', row: 7, column: 'NOME', code: 'required', message: 'm' },
              { sheet: 'Categorie', row: null, column: null, code: 'unknownPlace', message: 'm' },
            ],
            errorCount: 5,
            moreErrors: true,
          },
        },
        { status: 422, statusText: 'VALIDATION_ERROR' },
      );
      await view();
      const failure = root.querySelector('#failure-heading')!.parentElement!;
      expect(failure.getAttribute('role')).toBe('alert');
      expect(failure.textContent).toContain('CATALOG_XLSX.IMPORT.ERROR.ROWS');
      expect(failure.querySelectorAll('tbody tr')).toHaveLength(2);
      expect(failure.querySelector('.more')?.textContent).toBe(
        'CATALOG_XLSX.PROBLEMS.MORE {"count":"3"}',
      );
      expect(document.activeElement?.id).toBe('failure-heading');
      expect(button('CATALOG_XLSX.IMPORT.ACTION')).toBeUndefined();
      expect(root.querySelector('#verified-heading')).toBeNull();
    });

    it.each([
      [413, 'PAYLOAD_TOO_LARGE', 'CATALOG_XLSX.IMPORT.ERROR.TOO_LARGE'],
      [415, 'UNSUPPORTED_MEDIA_TYPE', 'CATALOG_XLSX.IMPORT.ERROR.UNSUPPORTED'],
      [409, 'CONFLICT', 'CATALOG_XLSX.IMPORT.ERROR.BUSY'],
      [429, 'RATE_LIMITED', 'CATALOG_XLSX.IMPORT.ERROR.RATE_LIMITED'],
      [503, 'SERVICE_UNAVAILABLE', 'CATALOG_XLSX.IMPORT.ERROR.UNAVAILABLE'],
    ])('explains a %i answer to the check without a table', async (status, code, message) => {
      const { button, view, root, importRequest, choose } = await render();
      await choose(xlsx());
      button('CATALOG_XLSX.IMPORT.VERIFY').click();
      await view();
      importRequest(true).flush(errorBody(code), { status, statusText: code });
      await view();
      expect(root.querySelector('#failure-heading')!.parentElement!.textContent).toContain(message);
      expect(root.querySelector('table')).toBeNull();
      expect(button('CATALOG_XLSX.IMPORT.VERIFY').disabled).toBe(false);
    });

    it('asks for a new check when the import itself is refused (the catalog changed), and keeps the check when the service is only busy', async () => {
      const { button, dialogButton, view, root, importRequest, verify } = await render();
      await verify(xlsx());
      const apply = async () => {
        button('CATALOG_XLSX.IMPORT.ACTION').click();
        await view();
        dialogButton('CATALOG_XLSX.IMPORT.CONFIRM_ACTION').click();
        await view();
        return importRequest(false);
      };
      (await apply()).flush(errorBody('CONFLICT'), { status: 409, statusText: 'CONFLICT' });
      await view();
      expect(root.querySelector('#failure-heading')).not.toBeNull();
      expect(button('CATALOG_XLSX.IMPORT.ACTION')).toBeDefined();
      (await apply()).flush(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'm',
            rows: [{ sheet: 'Prodotti', row: 2, column: 'ID', code: 'notFound', message: 'm' }],
            errorCount: 1,
            moreErrors: false,
          },
        },
        { status: 422, statusText: 'VALIDATION_ERROR' },
      );
      await view();
      expect(button('CATALOG_XLSX.IMPORT.ACTION')).toBeUndefined();
      expect(root.querySelector('#verified-heading')).toBeNull();
      expect(button('CATALOG_XLSX.IMPORT.VERIFY')).toBeDefined();
    });
  });
});
