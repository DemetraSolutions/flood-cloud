import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { emulateNativeDialog } from '../../../testing/dialog';
import { I18nService } from '../../core/i18n/i18n.service';
import { TrashSummaryDialog } from './trash-summary-dialog';
import { TrashKind, TrashSummary } from './trash.types';

function render(
  summary: TrashSummary | null,
  names: [string, string][] = [],
  kind: TrashKind = 'companies',
) {
  emulateNativeDialog();
  TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
  const fixture = TestBed.createComponent(TrashSummaryDialog);
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  fixture.componentRef.setInput('kind', kind);
  fixture.componentRef.setInput('summary', summary);
  fixture.componentRef.setInput('names', new Map(names));
  fixture.componentRef.setInput('open', true);
  const root = fixture.nativeElement as HTMLElement;
  const view = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
  };
  return { fixture, root, view };
}

afterEach(() => vi.restoreAllMocks());

describe('TrashSummaryDialog', () => {
  it('reports what was restored', async () => {
    const { root, view } = render({ restored: 2, deleted: 0, skipped: [], failedGroups: [] });
    await view();
    expect(root.textContent).toContain('TRASH.SUMMARY.RESTORED {"count":2}');
    expect(root.textContent).not.toContain('TRASH.SUMMARY.DELETED');
    expect(root.textContent).not.toContain('TRASH.SUMMARY.SKIPPED');
    expect(root.textContent).not.toContain('TRASH.SUMMARY.NOTHING');
  });

  it('reports what was deleted', async () => {
    const { root, view } = render({ restored: 0, deleted: 3, skipped: [], failedGroups: [] });
    await view();
    expect(root.textContent).toContain('TRASH.SUMMARY.DELETED {"count":3}');
    expect(root.textContent).not.toContain('TRASH.SUMMARY.RESTORED');
  });

  it('says so when there was nothing to do', async () => {
    const { root, view } = render({ restored: 0, deleted: 0, skipped: [], failedGroups: [] });
    await view();
    expect(root.textContent).toContain('TRASH.SUMMARY.NOTHING');
  });

  it('gives a reason for each kind of skipped item, with the names the user selected', async () => {
    const { root, view } = render(
      {
        restored: 1,
        deleted: 0,
        skipped: [
          { id: 'a', issue: 'referenced' },
          { id: 'b', issue: 'referenced' },
          { id: 'c', issue: 'taken' },
          { id: 'd', issue: 'forbidden' },
          { id: 'e', issue: 'notTrashed' },
          { id: 'f', issue: 'notFound' },
        ],
        failedGroups: [],
      },
      [
        ['a', 'Alfa'],
        ['b', 'Beta'],
        ['c', 'Gamma'],
      ],
    );
    await view();
    expect(root.textContent).toContain('TRASH.SUMMARY.SKIPPED {"count":6}');
    const items = [...root.querySelectorAll('li')].map((li) =>
      li.textContent?.replace(/\s+/g, ' ').trim(),
    );
    expect(items).toEqual([
      'TRASH.ISSUE.REFERENCED_COMPANIES TRASH.SUMMARY.COUNT {"count":2} Alfa, Beta',
      'TRASH.ISSUE.TAKEN TRASH.SUMMARY.COUNT {"count":1} Gamma',
      'TRASH.ISSUE.FORBIDDEN TRASH.SUMMARY.COUNT {"count":1}',
      'TRASH.ISSUE.NOT_TRASHED TRASH.SUMMARY.COUNT {"count":1}',
      'TRASH.ISSUE.NOT_FOUND TRASH.SUMMARY.COUNT {"count":1}',
    ]);
  });

  it('explains a referenced place with its own reason and caps the names listed', async () => {
    const ids = Array.from({ length: 12 }, (_, n) => `p${n}`);
    const { root, view } = render(
      {
        restored: 0,
        deleted: 0,
        skipped: ids.map((id) => ({ id, issue: 'referenced' as const })),
        failedGroups: [],
      },
      ids.map((id): [string, string] => [id, id.toUpperCase()]),
      'places',
    );
    await view();
    const text = root.querySelector('li')?.textContent?.replace(/\s+/g, ' ');
    expect(text).toContain('TRASH.ISSUE.REFERENCED_PLACES TRASH.SUMMARY.COUNT {"count":12}');
    expect(text).toContain('P0, P1, P2, P3, P4, P5, P6, P7, P8, P9 TRASH.SUMMARY.MORE {"count":2}');
    expect(text).not.toContain('P10');
  });

  it('explains a referenced product with its own reason', async () => {
    const { root, view } = render(
      {
        restored: 0,
        deleted: 0,
        skipped: [{ id: 'a', issue: 'referenced' }],
        failedGroups: [],
      },
      [['a', 'Acqua']],
      'products',
    );
    await view();
    const text = root.querySelector('li')?.textContent?.replace(/\s+/g, ' ');
    expect(text).toContain('TRASH.ISSUE.REFERENCED_PRODUCTS TRASH.SUMMARY.COUNT {"count":1} Acqua');
  });

  it('explains a referenced contact and a contact with a taken card code with their own reasons', async () => {
    const { root, view } = render(
      {
        restored: 0,
        deleted: 0,
        skipped: [
          { id: 'a', issue: 'referenced' },
          { id: 'b', issue: 'taken' },
          { id: 'c', issue: 'notFound' },
        ],
        failedGroups: [],
      },
      [
        ['a', 'Mario Bianchi'],
        ['b', 'Anna Verdi'],
        ['c', 'Luca Neri'],
      ],
      'contacts',
    );
    await view();
    const items = [...root.querySelectorAll('li')].map((li) =>
      li.textContent?.replace(/\s+/g, ' '),
    );
    expect(items[0]).toContain('TRASH.ISSUE.REFERENCED_CONTACTS');
    expect(items[0]).toContain('Mario Bianchi');
    expect(items[1]).toContain('TRASH.ISSUE.TAKEN_CONTACTS');
    expect(items[1]).toContain('Anna Verdi');
    expect(items[2]).not.toContain('CONTACTS');
  });

  it('closes with the button of the dialog', async () => {
    const { fixture, root, view } = render({
      restored: 1,
      deleted: 0,
      skipped: [],
      failedGroups: [],
    });
    await view();
    root.querySelector<HTMLButtonElement>('dialog header button')!.click();
    await view();
    expect(fixture.componentInstance.open()).toBe(false);
  });

  it('closes with its button', async () => {
    const { fixture, root, view } = render({
      restored: 1,
      deleted: 0,
      skipped: [],
      failedGroups: [],
    });
    await view();
    root.querySelector<HTMLButtonElement>('dialog footer button')!.click();
    await view();
    expect(fixture.componentInstance.open()).toBe(false);
  });

  it('lists the groups whose request failed, and is not empty because of them', async () => {
    const { root, view } = render({
      restored: 0,
      deleted: 0,
      skipped: [],
      failedGroups: ['Alfa', 'Beta'],
    });
    await view();
    expect(root.querySelector('[role=alert]')?.textContent).toContain('"groups":"Alfa, Beta"');
    expect(root.textContent).not.toContain('TRASH.SUMMARY.NOTHING');
  });
});
