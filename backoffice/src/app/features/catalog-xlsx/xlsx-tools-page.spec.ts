import { TestBed } from '@angular/core/testing';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { API, backend, errorBody, provideApiTesting, settle } from '../../../testing/api';
import { emulateNativeDialog } from '../../../testing/dialog';
import { signIn } from '../../../testing/session';
import { I18nService } from '../../core/i18n/i18n.service';
import { ReferenceStore } from '../../core/reference/reference-store';
import { CatalogXlsxPage } from './catalog-xlsx-page';
import { ImportOutcome } from './catalog-xlsx.types';
import { XLSX_TOOLS, XlsxToolKey } from './xlsx-tools';

/**
 * The page of the workbooks of the contacts and of the advanced loyalty cards (K3): the same page as the catalog (see `catalog-xlsx-page.spec.ts`), driven by the `tool` data of its route.
 */

const GROUP = '665f1c2e9b1d4a0012ab34a1';
const BASE = `${API}/v1/groups/${GROUP}`;
const counts = { inserted: 3, updated: 2, removed: 1, unchanged: 10 };

interface Case {
  readonly tool: Exclude<XlsxToolKey, 'catalog'>;
  readonly route: string;
  readonly read: string;
  readonly write: string;
  readonly sheet: string;
  readonly invalidated: string[];
}

const CASES: Case[] = [
  {
    tool: 'contacts',
    route: 'contacts-import-export',
    read: 'contacts:export',
    write: 'contacts:import',
    sheet: 'contacts',
    invalidated: ['customers', 'suppliers'],
  },
  {
    tool: 'cards',
    route: 'fidelity-cards-import-export',
    read: 'fidelityCards:export',
    write: 'fidelityCards:import',
    sheet: 'cards',
    invalidated: [],
  },
];

const xlsx = (name = 'file.xlsx') =>
  Object.defineProperty(new File(['x'], name), 'size', { value: 1000 }) as File;

async function render(test: Case, permissions: string[], store?: { invalidate: () => void }) {
  emulateNativeDialog();
  TestBed.configureTestingModule({
    providers: [
      ...provideApiTesting(),
      ...(store === undefined ? [] : [{ provide: ReferenceStore, useValue: store }]),
      provideRouter(
        [
          {
            path: `groups/:groupId/tools/${test.route}`,
            component: CatalogXlsxPage,
            data: { tool: test.tool },
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
  signIn({ role: 'SA', groupId: GROUP, permissions: [...permissions, 'profile:read'] });
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(`/groups/${GROUP}/tools/${test.route}`);
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
  const choose = async (file: File) => {
    const input = root.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));
    await view();
  };
  const importRequest = (dryRun: boolean) =>
    backend().expectOne(
      (r) => r.url === `${BASE}/${XLSX_TOOLS[test.tool].importPath}` && r.params.has('dryRun') === dryRun,
    );
  return { root, view, button, dialogButton, choose, importRequest };
}

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

describe.each(CASES)('CatalogXlsxPage as the $tool tool', (test) => {
  const spec = XLSX_TOOLS[test.tool];
  const outcome = (dryRun: boolean): ImportOutcome => ({
    dryRun,
    sheets: { [test.sheet]: counts },
  });

  it('shows the texts of its own workbook, without the note about the points of sale', async () => {
    const { root } = await render(test, [test.read, test.write]);
    expect(root.querySelector('h1')?.textContent).toBe(`${spec.prefix}.TITLE`);
    expect(root.querySelector('.hint')?.textContent).toBe(`${spec.prefix}.HINT`);
    expect(root.textContent).toContain(`${spec.prefix}.TEMPLATE.TEXT`);
    expect(root.textContent).not.toContain('PLACES_NOTE');
    expect(root.querySelector('fieldset legend')?.textContent?.trim()).toBe(
      `${spec.prefix}.EXPORT.REFERENCES`,
    );
    expect(root.querySelector('#references-help')?.textContent?.trim()).toBe(
      `${spec.prefix}.EXPORT.IDS_HELP`,
    );
    expect([...root.querySelectorAll('details li')].map((li) => li.textContent)).toEqual(
      spec.rules.map((rule) => `${spec.prefix}.RULES.${rule}`),
    );
  });

  it('downloads its model and its export from its own routes, with its own file names', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-25T10:00:00Z') });
    try {
      const names = captureDownloads();
      const { button, view } = await render(test, [test.read]);
      button('CATALOG_XLSX.TEMPLATE.ACTION').click();
      await view();
      backend().expectOne(`${BASE}/${spec.exportPath}/template`).flush(new Blob(['x']));
      await view();
      button(`${spec.prefix}.EXPORT.ACTION`).click();
      await view();
      const request = backend().expectOne((r) => r.url === `${BASE}/${spec.exportPath}`);
      expect(request.request.params.get('references')).toBe('ids');
      request.flush(new Blob(['x']));
      await view();
      expect(names).toEqual([`${spec.fileBase}-model.xlsx`, `${spec.fileBase}_2026-11-25.xlsx`]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('takes the text of the limits of the export from the tool', async () => {
    captureDownloads();
    const { button, view, root } = await render(test, [test.read]);
    button(`${spec.prefix}.EXPORT.ACTION`).click();
    await view();
    backend()
      .expectOne((r) => r.url === `${BASE}/${spec.exportPath}`)
      .flush(new Blob([JSON.stringify(errorBody('PAYLOAD_TOO_LARGE'))]), {
        status: 413,
        statusText: 'PAYLOAD_TOO_LARGE',
      });
    await view();
    expect(root.querySelector('.problem[role="alert"]')?.textContent).toBe(
      `${spec.prefix}.DOWNLOAD_ERROR.TOO_LARGE`,
    );
  });

  it(`shows the import only with ${test.write}`, async () => {
    const readOnly = await render(test, [test.read]);
    expect(readOnly.root.querySelector('#template-heading')).not.toBeNull();
    expect(readOnly.root.querySelector('#import-heading')).toBeNull();
    document.body.replaceChildren();
    TestBed.resetTestingModule();
    const writer = await render(test, [test.read, test.write]);
    expect(writer.root.querySelector('#import-heading')).not.toBeNull();
    expect(writer.root.textContent).toContain(`${spec.prefix}.IMPORT.NOTE`);
  });

  it('checks, confirms and imports on its own routes, with its own sheet and counts', async () => {
    const store = { invalidate: vi.fn() };
    const { button, dialogButton, choose, importRequest, view, root } = await render(
      test,
      [test.read, test.write],
      store,
    );
    await choose(xlsx('mine.xlsx'));
    button('CATALOG_XLSX.IMPORT.VERIFY').click();
    await view();
    const check = importRequest(true);
    expect(check.request.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    check.flush({ data: outcome(true) });
    await view();
    const headers = [...root.querySelectorAll('thead th')].map((th) => th.textContent?.trim());
    expect(headers).toEqual([
      'CATALOG_XLSX.COUNTS.SHEET',
      'CATALOG_XLSX.COUNTS.INSERTED',
      'CATALOG_XLSX.COUNTS.UPDATED',
      ...(spec.showsRemoved ? ['CATALOG_XLSX.COUNTS.REMOVED'] : []),
      'CATALOG_XLSX.COUNTS.UNCHANGED',
    ]);
    const cells = [...root.querySelectorAll('tbody tr')[0]!.querySelectorAll('th, td')].map((c) =>
      c.textContent?.trim(),
    );
    expect(cells).toEqual([
      `${spec.prefix}.SHEET.${test.sheet.toUpperCase()}`,
      '3',
      '2',
      ...(spec.showsRemoved ? ['1'] : []),
      '10',
    ]);
    button('CATALOG_XLSX.IMPORT.ACTION').click();
    await view();
    expect(root.querySelector('dialog')?.textContent).toContain(
      `${spec.prefix}.IMPORT.CONFIRM {"name":"mine.xlsx","inserted":"3","updated":"2","removed":"1"}`,
    );
    dialogButton('CATALOG_XLSX.IMPORT.CONFIRM_ACTION').click();
    await view();
    importRequest(false).flush({ data: outcome(false) });
    await view();
    expect(root.querySelector('#done-heading')?.textContent).toBe('CATALOG_XLSX.IMPORT.DONE');
    expect(store.invalidate.mock.calls).toEqual(test.invalidated.map((kind) => [GROUP, kind]));
  });

  it('saves the problems of a refused file under its own name, and takes the text of its lock and limits from the tool', async () => {
    const names = captureDownloads();
    const { button, choose, importRequest, view, root } = await render(test, [test.read, test.write]);
    await choose(xlsx());
    button('CATALOG_XLSX.IMPORT.VERIFY').click();
    await view();
    importRequest(true).flush(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'm',
          rows: [{ sheet: spec.prefix, row: 2, column: 'CODICE', code: 'duplicateCode', message: 'm' }],
          errorCount: 1,
          moreErrors: false,
        },
      },
      { status: 422, statusText: 'VALIDATION_ERROR' },
    );
    await view();
    expect(root.querySelector('tbody')?.textContent).toContain('CATALOG_XLSX.ROW_ERROR.DUPLICATE_CODE');
    button('CATALOG_XLSX.PROBLEMS.SAVE').click();
    expect(names).toEqual([`${spec.fileBase}-import-problems.txt`]);
    button('CATALOG_XLSX.IMPORT.VERIFY').click();
    await view();
    importRequest(true).flush(errorBody('CONFLICT'), { status: 409, statusText: 'CONFLICT' });
    await view();
    expect(root.querySelector('#failure-heading')?.parentElement?.textContent).toContain(
      `${spec.prefix}.IMPORT.ERROR.BUSY`,
    );
  });
});
