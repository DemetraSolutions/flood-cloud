import { TestBed } from '@angular/core/testing';
import { provideApiTesting, settle } from '../../../testing/api';
import { ApiErrorRow } from '../../core/api/api.types';
import { I18nService } from '../../core/i18n/i18n.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { ImportProblems } from './import-problems';

const ROWS: ApiErrorRow[] = [
  { sheet: 'Prodotti', row: 7, column: 'NOME', code: 'required', message: 'm1' },
  { sheet: 'Prodotti', row: 9, column: 'ALIQUOTA 1 (ID / VALORE)', code: 'brandNew', message: 'Fallback text' },
  { sheet: 'Categorie', row: null, column: null, code: 'unknownPlace', message: 'm3' },
  { sheet: '<img src=x onerror=alert(1)>', row: 3, column: '=HYPERLINK("x")', code: 'invalid', message: 'refused (name: tooLong)' },
];

async function render(inputs: { rows?: ApiErrorRow[]; errorCount?: number | null; moreErrors?: boolean } = {}) {
  TestBed.configureTestingModule({ providers: [...provideApiTesting()] });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  const fixture = TestBed.createComponent(ImportProblems);
  fixture.componentRef.setInput('rows', inputs.rows ?? ROWS);
  if (inputs.errorCount !== undefined) {
    fixture.componentRef.setInput('errorCount', inputs.errorCount);
  }
  if (inputs.moreErrors !== undefined) {
    fixture.componentRef.setInput('moreErrors', inputs.moreErrors);
  }
  const root = fixture.nativeElement as HTMLElement;
  document.body.appendChild(root);
  const view = async () => {
    await settle();
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
  };
  await view();
  const lines = () =>
    [...root.querySelectorAll('tbody tr')].map((tr) =>
      [...tr.querySelectorAll('th, td')].map((cell) => cell.textContent?.trim()),
    );
  const button = (text: string) =>
    [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text)!;
  return { root, view, lines, button, fixture };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('ImportProblems', () => {
  it('shows sheet, row, column and the problem translated from its code, with headers', async () => {
    const { root, lines } = await render();
    expect([...root.querySelectorAll('thead th')].map((th) => th.textContent?.trim())).toEqual([
      'CATALOG_XLSX.PROBLEMS.SHEET',
      'CATALOG_XLSX.PROBLEMS.ROW',
      'CATALOG_XLSX.PROBLEMS.COLUMN',
      'CATALOG_XLSX.PROBLEMS.PROBLEM',
    ]);
    expect(lines().slice(0, 3)).toEqual([
      ['Prodotti', '7', 'NOME', 'CATALOG_XLSX.ROW_ERROR.REQUIRED'],
      ['Prodotti', '9', 'ALIQUOTA 1 (ID / VALORE)', 'Fallback text'],
      ['Categorie', '—', '—', 'CATALOG_XLSX.ROW_ERROR.UNKNOWN_PLACE'],
    ]);
    expect(root.querySelector('table')?.getAttribute('aria-label') ?? root.querySelector('caption')?.textContent).toContain(
      'CATALOG_XLSX.PROBLEMS.CAPTION',
    );
  });

  it('shows values of the file as text, never as markup', async () => {
    const { root, lines } = await render();
    expect(root.querySelector('img')).toBeNull();
    expect(lines()[3]).toEqual([
      '<img src=x onerror=alert(1)>',
      '3',
      '=HYPERLINK("x")',
      'CATALOG_XLSX.ROW_ERROR.INVALID (name: tooLong)',
    ]);
  });

  it('counts the problems, singular and plural', async () => {
    expect((await render()).root.querySelector('.summary')?.textContent).toBe(
      'CATALOG_XLSX.PROBLEMS.SUMMARY_OTHER {"count":"4"}',
    );
    document.body.replaceChildren();
    TestBed.resetTestingModule();
    const one = await render({ rows: [ROWS[0]!] });
    expect(one.root.querySelector('.summary')?.textContent).toBe(
      'CATALOG_XLSX.PROBLEMS.SUMMARY_ONE {"count":"1"}',
    );
  });

  it('uses the count of the server when it is above the rows listed, and says how many are not shown', async () => {
    const { root } = await render({ errorCount: 1000, moreErrors: true });
    expect(root.querySelector('.summary')?.textContent).toBe(
      'CATALOG_XLSX.PROBLEMS.SUMMARY_OTHER {"count":"1000"}',
    );
    expect(root.querySelector('.more')?.textContent).toBe(
      'CATALOG_XLSX.PROBLEMS.MORE {"count":"996"}',
    );
  });

  it('says there are more problems even when the server did not count them, and says nothing otherwise', async () => {
    expect((await render({ moreErrors: true })).root.querySelector('.more')?.textContent).toBe(
      'CATALOG_XLSX.PROBLEMS.MORE_UNKNOWN',
    );
    document.body.replaceChildren();
    TestBed.resetTestingModule();
    expect((await render({ errorCount: 4 })).root.querySelector('.more')).toBeNull();
  });

  it('filters by sheet, only offered when the problems are in more than one', async () => {
    const { root, view, lines, fixture } = await render();
    const select = root.querySelector('select') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual([
      '',
      'Prodotti',
      'Categorie',
      '<img src=x onerror=alert(1)>',
    ]);
    select.value = 'Categorie';
    select.dispatchEvent(new Event('change'));
    await view();
    expect(lines()).toEqual([['Categorie', '—', '—', 'CATALOG_XLSX.ROW_ERROR.UNKNOWN_PLACE']]);
    // A chosen sheet that has no problem any more is not applied: nothing is hidden by a filter that cannot be seen.
    fixture.componentRef.setInput('rows', [ROWS[0]]);
    await view();
    expect(root.querySelector('select')).toBeNull();
    expect(lines()).toEqual([['Prodotti', '7', 'NOME', 'CATALOG_XLSX.ROW_ERROR.REQUIRED']]);
  });

  it('shows the empty state when there is nothing to list', async () => {
    const { root } = await render({ rows: [] });
    expect(root.textContent).toContain('CATALOG_XLSX.PROBLEMS.EMPTY_MESSAGE');
  });

  describe('copy and save', () => {
    const expectedText = (more: string[] = []) =>
      [
        'CATALOG_XLSX.PROBLEMS.SHEET\tCATALOG_XLSX.PROBLEMS.ROW\tCATALOG_XLSX.PROBLEMS.COLUMN\tCATALOG_XLSX.PROBLEMS.PROBLEM',
        'Prodotti\t7\tNOME\tCATALOG_XLSX.ROW_ERROR.REQUIRED',
        ...more,
      ].join('\n');

    it('copies the list as text and says so', async () => {
      const writeText = vi.fn(() => Promise.resolve());
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      const { button, view } = await render({ rows: [ROWS[0]!] });
      button('CATALOG_XLSX.PROBLEMS.COPY').click();
      await view();
      expect(writeText).toHaveBeenCalledWith(expectedText());
      expect(TestBed.inject(ToastService).toasts().map((t) => t.message)).toEqual([
        'CATALOG_XLSX.PROBLEMS.COPIED',
      ]);
    });

    it('adds the note of the problems not listed to the copy, and reports a clipboard that refuses', async () => {
      const writeText = vi.fn(() => Promise.reject(new Error('denied')));
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      const { button, view } = await render({ rows: [ROWS[0]!], moreErrors: true });
      button('CATALOG_XLSX.PROBLEMS.COPY').click();
      await view();
      expect(writeText).toHaveBeenCalledWith(expectedText(['CATALOG_XLSX.PROBLEMS.MORE_UNKNOWN']));
      expect(TestBed.inject(ToastService).toasts().map((t) => t.message)).toEqual([
        'CATALOG_XLSX.PROBLEMS.COPY_FAILED',
      ]);
    });

    it('saves the list as a text file', async () => {
      const created: Blob[] = [];
      URL.createObjectURL = vi.fn((blob: Blob) => {
        created.push(blob);
        return 'blob:test';
      });
      URL.revokeObjectURL = vi.fn();
      const clicked: HTMLAnchorElement[] = [];
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
        clicked.push(this);
      });
      const { button } = await render({ rows: [ROWS[0]!] });
      button('CATALOG_XLSX.PROBLEMS.SAVE').click();
      expect(clicked[0]!.download).toBe('catalog-import-problems.txt');
      expect(created[0]!.type).toBe('text/plain;charset=utf-8');
      expect(await created[0]!.text()).toBe(expectedText());
    });
  });
});
