import { Provider, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { API, backend, errorBody, provideApiTesting, settle } from '../../../testing/api';
import { emulateNativeDialog } from '../../../testing/dialog';
import { signIn } from '../../../testing/session';
import { AppConfig } from '../../core/config/app-config';
import { I18nService } from '../../core/i18n/i18n.service';
import { Profile } from '../../core/session/session.types';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { TobaccosPage } from './tobaccos-page';
import { MAX_IMPORT_BYTES, TobaccoRow } from './tobaccos.types';

const LIST = `${API}/v1/tobaccos`;
const IMPORT = `${API}/v1/tobaccos/import`;
const ROW: TobaccoRow = {
  id: '665f1c2e9b1d4a0012ab34c1',
  code: 'A1',
  name: 'Alfa Rosso',
  shortName: 'Alfa',
  category: 'Sigarette',
  priceKg: 90,
  price: 5.5,
  barcode: '8000000000003',
};
const BARE: TobaccoRow = {
  ...ROW,
  id: '665f1c2e9b1d4a0012ab34c2',
  code: 'B2',
  name: 'Beta',
  priceKg: null,
  price: null,
  barcode: null,
};
const RESULT = { inserted: 1234, previous: 1200, elapsedMs: 2500 };

const page = (data: TobaccoRow[], next: string | null = null) => ({
  data,
  page: { limit: 100, next },
});
const xlsx = (name = 'listino.xlsx', size = 1000) =>
  Object.defineProperty(new File(['x'], name), 'size', { value: size }) as File;

async function render(
  url = '/tools/tobaccos',
  profile: Partial<Profile> = {},
  extra: Provider[] = [],
) {
  emulateNativeDialog();
  TestBed.configureTestingModule({
    providers: [
      ...provideApiTesting(),
      ...extra,
      provideRouter(
        [
          { path: 'tools/tobaccos', component: TobaccosPage },
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
    permissions: ['tobaccos:read', 'tobaccos:import', 'profile:read'],
    ...profile,
  });
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(url);
  const root = harness.routeNativeElement as HTMLElement;
  document.body.appendChild(root);
  const view = async () => {
    await settle();
    harness.detectChanges();
    await settle();
    harness.detectChanges();
  };
  const request = () => backend().expectOne((r) => r.url === LIST);
  const flush = async (data: TobaccoRow[], next: string | null = null) => {
    const req = request();
    req.flush(page(data, next));
    await view();
    return req;
  };
  const cells = (row: number) =>
    [...root.querySelectorAll('tbody tr')[row]!.querySelectorAll('th, td')].map((c) =>
      c.textContent?.trim(),
    );
  const search = () => new URL(TestBed.inject(Router).url, 'http://x').searchParams;
  const button = (text: string) =>
    [...root.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === text,
    )!;
  const dialogButton = (text: string) =>
    [...root.querySelectorAll<HTMLButtonElement>('dialog[open] button')].find(
      (b) => b.textContent?.trim() === text,
    )!;
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
  return { root, view, request, flush, cells, search, button, dialogButton, toasts, choose };
}

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
  sessionStorage.clear();
});

describe('TobaccosPage', () => {
  describe('table', () => {
    it('requests the first page of 100 sorted by code and shows the columns of the legacy table', async () => {
      const { request, view, root, cells } = await render();
      const req = request();
      expect(req.request.params.get('limit')).toBe('100');
      expect(req.request.params.get('sort')).toBe('code');
      expect(req.request.params.keys().sort()).toEqual(['limit', 'sort']);
      req.flush(page([ROW, BARE]));
      await view();
      expect(root.querySelector('h1')?.textContent).toBe('TOBACCOS.TITLE');
      expect([...root.querySelectorAll('thead th')].map((th) => th.textContent?.trim())).toEqual([
        'TOBACCOS.COLUMN.CODE',
        'TOBACCOS.COLUMN.NAME',
        'TOBACCOS.COLUMN.CATEGORY',
        'TOBACCOS.COLUMN.PRICE_KG',
        'TOBACCOS.COLUMN.PRICE',
        'TOBACCOS.COLUMN.BARCODE',
      ]);
      expect(cells(0)).toEqual(['A1', 'Alfa Rosso', 'Sigarette', '90,00', '5,50', '8000000000003']);
      expect(cells(1)).toEqual(['B2', 'Beta', 'Sigarette', '—', '—', '—']);
    });

    it('shows a loading table, then an empty state', async () => {
      const { request, root, view } = await render();
      expect(root.querySelector('table')?.getAttribute('aria-busy')).toBe('true');
      request().flush(page([]));
      await view();
      expect(root.querySelector('fc-empty-state')?.textContent).toContain('TOBACCOS.EMPTY_MESSAGE');
    });

    it('shows the error and retries', async () => {
      const { request, root, view } = await render();
      request().flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' });
      await view();
      expect(root.querySelector('fc-error-state')?.textContent).toContain('TOBACCOS.LOAD_ERROR');
      root.querySelector<HTMLButtonElement>('fc-error-state button')!.click();
      await view();
      request().flush(page([ROW]));
      await view();
      expect(root.querySelectorAll('tbody tr')).toHaveLength(1);
    });

    it('reports an unexpected failure generically', async () => {
      const { root, view } = await render(undefined, {}, [
        { provide: AppConfig, useValue: { apiBaseUrl: signal(null) } },
      ]);
      await view();
      expect(root.querySelector('fc-error-state')?.textContent).toContain('ERRORS.GENERIC.MESSAGE');
    });

    it('reads the query from the URL, ignoring what the server would refuse', async () => {
      const { request, view, root } = await render(
        '/tools/tobaccos?q=%20alfa%20&sort=-priceKg&limit=25&cursor=c1',
      );
      const req = request();
      expect(req.request.params.get('q')).toBe('alfa');
      expect(req.request.params.get('sort')).toBe('-priceKg');
      expect(req.request.params.get('limit')).toBe('25');
      expect(req.request.params.get('cursor')).toBe('c1');
      req.flush(page([]));
      await view();
      expect(root.querySelector<HTMLInputElement>('input[type="search"]')!.value).toBe(' alfa ');
    });

    it('falls back to the default sort and page size for values it does not know', async () => {
      const { request, view } = await render('/tools/tobaccos?sort=unitWeight&limit=7');
      const req = request();
      expect([req.request.params.get('sort'), req.request.params.get('limit')]).toEqual([
        'code',
        '100',
      ]);
      req.flush(page([]));
      await view();
    });

    it('sorts by a column, searches after the user stops typing, and moves along the cursors', async () => {
      const { request, flush, button, view, search, root } = await render();
      await flush([ROW], 'c1');
      button('TOBACCOS.COLUMN.PRICE').click();
      await view();
      expect(search().get('sort')).toBe('price');
      await flush([ROW], 'c1');
      button('TOBACCOS.COLUMN.PRICE').click();
      await view();
      expect(search().get('sort')).toBe('-price');
      await flush([ROW], 'c1');
      expect(button('PAGINATION.PREVIOUS').disabled).toBe(true);
      button('PAGINATION.NEXT').click();
      await view();
      expect(search().get('cursor')).toBe('c1');
      const second = request();
      expect(second.request.params.get('cursor')).toBe('c1');
      second.flush(page([BARE]));
      await view();
      button('PAGINATION.PREVIOUS').click();
      await view();
      expect(search().has('cursor')).toBe(false);
      await flush([ROW], 'c1');
      const input = root.querySelector<HTMLInputElement>('input[type="search"]')!;
      input.value = ' alfa ';
      input.dispatchEvent(new Event('input'));
      await new Promise((resolve) => setTimeout(resolve, 350));
      await view();
      expect(search().get('q')).toBe('alfa');
      await flush([]);
      input.value = ' ';
      input.dispatchEvent(new Event('input'));
      await new Promise((resolve) => setTimeout(resolve, 350));
      await view();
      expect(search().has('q')).toBe(false);
      await flush([]);
      const submit = new Event('submit', { cancelable: true });
      root.querySelector('form')!.dispatchEvent(submit);
      expect(submit.defaultPrevented).toBe(true);
    });

    it('changes the page size', async () => {
      const { flush, view, search, root } = await render();
      await flush([ROW]);
      const select = [...root.querySelectorAll('label')].find(
        (l) => l.textContent?.trim() === 'PAGINATION.PER_PAGE',
      )!;
      const control = root.querySelector<HTMLSelectElement>(`#${select.htmlFor}`)!;
      control.value = '25';
      control.dispatchEvent(new Event('change'));
      await view();
      expect(search().get('limit')).toBe('25');
      await flush([ROW]);
    });
  });

  describe('import', () => {
    it('is offered only to who may import', async () => {
      const { flush, button, root } = await render(undefined, {
        permissions: ['tobaccos:read', 'profile:read'],
      });
      await flush([ROW]);
      expect(root.querySelector('.page-header button')).toBeNull();
      expect(button('TOBACCOS.IMPORT.ACTION')).toBeUndefined();
    });

    it('opens the file chooser from the button, and the chooser takes xlsx files only', async () => {
      const { flush, button, root } = await render();
      await flush([ROW]);
      const input = root.querySelector<HTMLInputElement>('input[type="file"]')!;
      expect(input.hidden).toBe(true);
      expect(input.accept).toContain('.xlsx');
      const click = vi.spyOn(input, 'click').mockImplementation(() => undefined);
      button('TOBACCOS.IMPORT.ACTION').click();
      expect(click).toHaveBeenCalledOnce();
    });

    it('asks to confirm the replacement of the whole list naming the file, then imports and reads the list again', async () => {
      const { flush, request, choose, dialogButton, view, root, toasts, cells } = await render();
      await flush([ROW]);
      await choose(xlsx('ADM-2026.xlsx'));
      expect(root.querySelector('dialog')?.textContent).toContain(
        'TOBACCOS.IMPORT.CONFIRM {"name":"ADM-2026.xlsx"}',
      );
      expect(dialogButton('TOBACCOS.IMPORT.CONFIRM_ACTION').getAttribute('data-variant')).toBe(
        'danger',
      );
      // Nothing is sent before the confirmation.
      dialogButton('TOBACCOS.IMPORT.CONFIRM_ACTION').click();
      await view();
      const sent = backend().expectOne(IMPORT);
      expect(sent.request.method).toBe('POST');
      expect(sent.request.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
      expect(((sent.request.body as FormData).get('file') as File).name).toBe('ADM-2026.xlsx');
      expect(root.querySelector('[role="status"]')?.textContent).toContain(
        'TOBACCOS.IMPORT.RUNNING',
      );
      sent.flush({ data: RESULT });
      await view();
      expect(root.querySelector('[role="status"]')?.textContent).toBe(
        'TOBACCOS.IMPORT.DONE {"inserted":"1234","previous":"1200","seconds":"2,5"}',
      );
      expect(toasts()).toEqual([
        'success: TOBACCOS.IMPORT.DONE {"inserted":"1234","previous":"1200","seconds":"2,5"}',
      ]);
      expect(root.querySelector('dialog')?.hasAttribute('open')).toBe(false);
      await flush([BARE]);
      expect(cells(0)[0]).toBe('B2');
    });

    it('goes back to the first page after an import', async () => {
      const { flush, choose, dialogButton, view, search, request } = await render(
        '/tools/tobaccos?cursor=c1',
      );
      await flush([ROW]);
      await choose(xlsx());
      dialogButton('TOBACCOS.IMPORT.CONFIRM_ACTION').click();
      await view();
      backend().expectOne(IMPORT).flush({ data: RESULT });
      await view();
      expect(search().has('cursor')).toBe(false);
      expect(request().request.params.has('cursor')).toBe(false);
    });

    it('forgets the file when the user cancels, and does not send anything', async () => {
      const { flush, choose, dialogButton, view, root } = await render();
      await flush([ROW]);
      await choose(xlsx());
      dialogButton('COMMON.CANCEL').click();
      await view();
      expect(root.querySelector('dialog')?.hasAttribute('open')).toBe(false);
      backend().expectNone(IMPORT);
    });

    it('does nothing when no file was chosen (the chooser was cancelled)', async () => {
      const { flush, choose, root } = await render();
      await flush([ROW]);
      await choose(null);
      expect(root.querySelector('dialog')?.hasAttribute('open')).toBe(false);
      expect(root.querySelector('[role="alert"]')).toBeNull();
    });

    it('refuses before sending a file that is not an .xlsx, is empty or is too large, and lets the next choice clear the message', async () => {
      const { flush, choose, root } = await render();
      await flush([ROW]);
      for (const [file, key] of [
        [xlsx('listino.csv'), 'TYPE'],
        [xlsx('listino.xlsx', 0), 'EMPTY'],
        [xlsx('listino.xlsx', MAX_IMPORT_BYTES + 1), 'SIZE'],
      ] as const) {
        await choose(file);
        expect(root.querySelector('p[role="alert"]')?.textContent?.trim()).toBe(
          `TOBACCOS.IMPORT.CLIENT_ERROR.${key}`,
        );
        expect(root.querySelector('dialog')?.hasAttribute('open')).toBe(false);
      }
      backend().expectNone(IMPORT);
      await choose(xlsx());
      expect(root.querySelector('p[role="alert"]')).toBeNull();
    });

    it('shows what is wrong in the file with the row and the column, says the list was not changed, and can be closed', async () => {
      const { flush, choose, dialogButton, view, root, toasts } = await render();
      await flush([ROW]);
      await choose(xlsx());
      dialogButton('TOBACCOS.IMPORT.CONFIRM_ACTION').click();
      await view();
      backend()
        .expectOne(IMPORT)
        .flush(
          errorBody('VALIDATION_ERROR', [
            { field: 'rows[12].price', issue: 'minimum' },
            { field: 'rows[13].barcodes[1].barcode', issue: 'format' },
          ]),
          { status: 422, statusText: 'x' },
        );
      await view();
      const failure = root.querySelector('section[role="alert"]')!;
      expect(failure.querySelector('h2')?.textContent).toBe('TOBACCOS.IMPORT.ERROR.TITLE');
      expect(failure.textContent).toContain('TOBACCOS.IMPORT.ERROR.ROWS');
      expect([...failure.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
        'TOBACCOS.IMPORT.PROBLEM {"row":12,"column":"TOBACCOS.COLUMN.PRICE {}","message":"FORM.ISSUE.MINIMUM"}',
        'TOBACCOS.IMPORT.PROBLEM {"row":13,"column":"TOBACCOS.IMPORT.BARCODE {\\"n\\":2}","message":"FORM.ISSUE.FORMAT"}',
      ]);
      expect(failure.textContent).not.toContain('TOBACCOS.IMPORT.TRUNCATED');
      expect(toasts()).toEqual([]);
      expect(root.querySelector('dialog')?.hasAttribute('open')).toBe(false);
      failure.querySelector('button')!.click();
      await view();
      expect(root.querySelector('section[role="alert"]')).toBeNull();
    });

    it('says there may be more problems when the server reported as many as it ever does', async () => {
      const { flush, choose, dialogButton, view, root } = await render();
      await flush([ROW]);
      await choose(xlsx());
      dialogButton('TOBACCOS.IMPORT.CONFIRM_ACTION').click();
      await view();
      backend()
        .expectOne(IMPORT)
        .flush(
          errorBody(
            'VALIDATION_ERROR',
            Array.from({ length: 50 }, (_item, index) => ({
              field: `rows[${index + 2}].code`,
              issue: 'taken',
            })),
          ),
          { status: 422, statusText: 'x' },
        );
      await view();
      expect(root.querySelectorAll('section[role="alert"] li')).toHaveLength(50);
      expect(root.querySelector('section[role="alert"]')?.textContent).toContain(
        'TOBACCOS.IMPORT.TRUNCATED',
      );
    });

    it('has its own message for 413, 415, a 422 about the file, and 429 with the wait', async () => {
      const { flush, choose, dialogButton, view, root } = await render();
      await flush([ROW]);
      for (const [status, body, headers, expected] of [
        [413, errorBody('INTERNAL_ERROR'), {}, 'TOBACCOS.IMPORT.ERROR.TOO_LARGE'],
        [415, errorBody('INTERNAL_ERROR'), {}, 'TOBACCOS.IMPORT.ERROR.UNSUPPORTED'],
        [
          422,
          errorBody('VALIDATION_ERROR', [{ field: 'file', issue: 'incorrect' }]),
          {},
          'TOBACCOS.IMPORT.ERROR.INCORRECT',
        ],
        [
          429,
          errorBody('RATE_LIMITED'),
          { 'Retry-After': '120' },
          'TOBACCOS.IMPORT.ERROR.RATE_LIMITED_WAIT {"seconds":120}',
        ],
        [500, errorBody('INTERNAL_ERROR'), {}, 'ERRORS.API.INTERNAL_ERROR'],
      ] as const) {
        await choose(xlsx());
        dialogButton('TOBACCOS.IMPORT.CONFIRM_ACTION').click();
        await view();
        backend()
          .expectOne(IMPORT)
          .flush(body, { status, statusText: 'x', headers: { ...headers } });
        await view();
        expect(root.querySelector('section[role="alert"] p')?.textContent).toBe(expected);
        expect(root.querySelector('section[role="alert"] ul')).toBeNull();
      }
    });

    it('sends the same Idempotency-Key when the same file is chosen again after a failure, and a new one for another file', async () => {
      const { flush, choose, dialogButton, view } = await render();
      await flush([ROW]);
      const keys: string[] = [];
      const same = xlsx();
      for (const chosen of [same, same, xlsx('altro.xlsx')]) {
        await choose(chosen);
        dialogButton('TOBACCOS.IMPORT.CONFIRM_ACTION').click();
        await view();
        const sent = backend().expectOne(IMPORT);
        keys.push(sent.request.headers.get('Idempotency-Key')!);
        sent.flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' });
        await view();
      }
      expect(keys[1]).toBe(keys[0]);
      expect(keys[2]).not.toBe(keys[0]);
    });
  });
});
