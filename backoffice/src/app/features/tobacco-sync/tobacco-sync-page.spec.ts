import { Provider, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { API, backend, errorBody, provideApiTesting, settle } from '../../../testing/api';
import { emulateNativeDialog } from '../../../testing/dialog';
import { signIn } from '../../../testing/session';
import { AppConfig } from '../../core/config/app-config';
import { I18nService } from '../../core/i18n/i18n.service';
import { ReferenceStore } from '../../core/reference/reference-store';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { TobaccoSyncPage } from './tobacco-sync-page';
import { SyncOutcome, SyncStatus } from './tobacco-sync.types';

const GROUP = '665f1c2e9b1d4a0012ab34a1';
const URL = `${API}/v1/groups/${GROUP}/tobacco-sync`;
const STATUS: SyncStatus = {
  available: true,
  reasons: [],
  warehouseAllowed: true,
  tobaccoPlaces: [{ id: 'pa', name: 'Bar Alfa' }],
  list: { entries: 12738, importedAt: '2026-11-24T08:00:00.000Z' },
  lastSync: {
    at: '2026-11-24T09:00:00.000Z',
    counts: { inserted: 3, updated: 2, disabled: 1, reactivated: 0, unchanged: 12000, places: 0 },
  },
};
const OUTCOME: SyncOutcome = {
  dryRun: false,
  products: { inserted: 4, updated: 5, disabled: 6, reactivated: 7, unchanged: 8, skipped: 0 },
  categories: { inserted: 1, duplicateNames: 0 },
  duplicateCodes: 0,
};

async function render(permissions: string[] = ['activityLog:read'], extra: Provider[] = []) {
  emulateNativeDialog();
  TestBed.configureTestingModule({
    providers: [...provideApiTesting(), ...extra, provideRouter([])],
  });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  signIn({ role: 'SA', groupId: GROUP, permissions: [...permissions, 'profile:read'] });
  const fixture = TestBed.createComponent(TobaccoSyncPage);
  fixture.componentRef.setInput('groupId', GROUP);
  const root = fixture.nativeElement as HTMLElement;
  document.body.appendChild(root);
  const view = async () => {
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
  };
  await view();
  const status = (answer: SyncStatus = STATUS) => {
    backend().expectOne(URL).flush({ data: answer });
    return view();
  };
  const facts = () =>
    [...root.querySelectorAll('.facts > div')].map((row) => [
      row.querySelector('dt')?.textContent?.trim(),
      row.querySelector('dd')?.textContent?.replace(/\s+/g, ' ').trim(),
    ]);
  const open = () => root.querySelector<HTMLButtonElement>('.actions button')!;
  return { fixture, root, view, status, facts, open };
}

describe('TobaccoSyncPage', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('shows that it is loading, then the state of the synchronization', async () => {
    const { root, status, facts, open } = await render();
    expect(root.querySelector('.loading')?.textContent).toBe('TOBACCO_SYNC.LOADING');
    await status();
    expect(root.querySelector('h1')?.textContent).toBe('TOBACCO_SYNC.TITLE');
    expect(facts().map(([term]) => term)).toEqual([
      'TOBACCO_SYNC.STATUS.ENTRIES',
      'TOBACCO_SYNC.STATUS.IMPORTED_AT',
      'TOBACCO_SYNC.STATUS.LAST_SYNC',
    ]);
    expect(facts()[0][1]).toMatch(/^12\D?738$/);
    expect(facts()[1][1]).toMatch(/2026|24/);
    expect(facts()[2][1]).toContain('TOBACCO_SYNC.STATUS.LAST_COUNTS {"date":"');
    expect(facts()[2][1]).toContain(
      '"inserted":"3","updated":"2","disabled":"1","reactivated":"0","unchanged":"12.000"}',
    );
    expect(root.querySelector('.notice')).toBeNull();
    expect(open().disabled).toBe(false);
  });

  it('says so when the list is empty and nothing was ever synchronized', async () => {
    const { status, facts } = await render();
    await status({
      ...STATUS,
      available: false,
      reasons: ['emptyList'],
      list: { entries: 0, importedAt: null },
      lastSync: null,
    });
    expect(facts()[1][1]).toBe('TOBACCO_SYNC.STATUS.NO_IMPORT');
    expect(facts()[2][1]).toBe('TOBACCO_SYNC.STATUS.NO_SYNC');
  });

  it('explains every reason and disables the button when it cannot start', async () => {
    const { root, status, open } = await render();
    await status({
      ...STATUS,
      available: false,
      reasons: ['noTobaccoPlace', 'noZeroTaxRate', 'somethingNew'],
    });
    expect(root.querySelector('.notice h3')?.textContent).toBe('TOBACCO_SYNC.UNAVAILABLE_TITLE');
    expect([...root.querySelectorAll('.notice li')].map((li) => li.textContent)).toEqual([
      'TOBACCO_SYNC.REASON.noTobaccoPlace',
      'TOBACCO_SYNC.REASON.noZeroTaxRate',
      'TOBACCO_SYNC.REASON.unknown',
    ]);
    expect(open().disabled).toBe(true);
  });

  it('shows the error of the state and reads it again', async () => {
    const { root, view, status } = await render();
    backend().expectOne(URL).flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' });
    await view();
    expect(root.querySelector('fc-error-state')?.textContent).toContain('TOBACCO_SYNC.LOAD_ERROR');
    root.querySelector<HTMLButtonElement>('fc-error-state button')!.click();
    await view();
    await status();
    expect(root.querySelector('.facts')).not.toBeNull();
  });

  it('reports an unexpected failure generically', async () => {
    const { root } = await render(undefined, [
      { provide: AppConfig, useValue: { apiBaseUrl: signal(null) } },
    ]);
    expect(root.querySelector('fc-error-state')?.textContent).toContain('ERRORS.GENERIC.MESSAGE');
  });

  it('opens the window of the synchronization with the points of sale of the state', async () => {
    const { root, status, open, view } = await render();
    await status();
    open().click();
    await view();
    expect(root.querySelector('fc-tobacco-sync-dialog dialog')!.hasAttribute('open')).toBe(true);
    expect(root.querySelector('fc-tobacco-sync-dialog')!.textContent).toContain('Bar Alfa');
  });

  it('closes the window and lets it open again', async () => {
    const { root, status, open, view } = await render();
    await status();
    open().click();
    await view();
    const dialog = root.querySelector('fc-tobacco-sync-dialog dialog')!;
    root.querySelector<HTMLButtonElement>('fc-tobacco-sync-dialog header button')!.click();
    await view();
    expect(dialog.hasAttribute('open')).toBe(false);
    open().click();
    await view();
    expect(dialog.hasAttribute('open')).toBe(true);
  });

  describe('after a synchronization', () => {
    async function synchronize(permissions?: string[]) {
      const page = await render(permissions);
      await page.status();
      const store = TestBed.inject(ReferenceStore);
      const invalidate = vi.spyOn(store, 'invalidate');
      page.open().click();
      await page.view();
      const dialog = page.root.querySelector('fc-tobacco-sync-dialog')!;
      const click = async (text: string, scope: ParentNode) => {
        [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!.click();
        await page.view();
      };
      await click('TOBACCO_SYNC.DIALOG.VERIFY', dialog);
      backend()
        .expectOne((r) => r.url === URL && r.params.has('dryRun'))
        .flush({ data: { ...OUTCOME, dryRun: true } });
      await page.view();
      await click('TOBACCO_SYNC.DIALOG.SYNC', dialog.querySelector('fc-dialog')!);
      await click('TOBACCO_SYNC.DIALOG.CONFIRM_ACTION', dialog.querySelector('fc-confirm-dialog')!);
      backend()
        .expectOne((r) => r.url === URL && !r.params.has('dryRun'))
        .flush({ data: OUTCOME });
      await page.view();
      return { ...page, invalidate };
    }

    it('shows the counts, drops the cached lists, tells it and reads the state again', async () => {
      const { root, invalidate, status, view } = await synchronize();
      expect(invalidate.mock.calls).toEqual([
        [GROUP, 'product-categories'],
        [GROUP, 'products'],
      ]);
      expect(
        TestBed.inject(ToastService)
          .toasts()
          .map((t) => t.message),
      ).toEqual(['TOBACCO_SYNC.DONE_TOAST {"inserted":"4","updated":"5"}']);
      const outcome = root.querySelector<HTMLElement>('[data-outcome]')!;
      expect(outcome.textContent).toBe('TOBACCO_SYNC.DONE_TITLE');
      expect(document.activeElement).toBe(outcome);
      expect(root.querySelectorAll('[aria-labelledby="sync-done-heading"] .line')).toHaveLength(9);
      expect(root.querySelector('a[href="/activity-log"]')?.textContent).toBe(
        'TOBACCO_SYNC.ACTIVITY_LINK',
      );
      // The state is read again: the new figures replace the old ones.
      await status({ ...STATUS, list: { entries: 1, importedAt: null } });
      await view();
      expect(root.querySelector('.facts dd')?.textContent?.trim()).toBe('1');
    });

    it('links the activity log only to whoever can read it', async () => {
      const { root } = await synchronize([]);
      expect(root.querySelector('[data-outcome]')).not.toBeNull();
      expect(root.querySelector('a[href="/activity-log"]')).toBeNull();
    });
  });
});
