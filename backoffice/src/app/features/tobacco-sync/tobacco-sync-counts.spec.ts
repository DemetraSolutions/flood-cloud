import { TestBed } from '@angular/core/testing';
import { TobaccoSyncCounts } from './tobacco-sync-counts';
import { SyncOutcome } from './tobacco-sync.types';
import { I18nService } from '../../core/i18n/i18n.service';

const OUTCOME: SyncOutcome = {
  dryRun: false,
  products: { inserted: 1200, updated: 2, disabled: 3, reactivated: 4, unchanged: 5, skipped: 6 },
  categories: { inserted: 7, duplicateNames: 8 },
  duplicateCodes: 9,
};

describe('TobaccoSyncCounts', () => {
  it('lists every figure with its term, in a labelled group', () => {
    const fixture = TestBed.createComponent(TobaccoSyncCounts);
    vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key) => key);
    fixture.componentRef.setInput('outcome', OUTCOME);
    fixture.componentRef.setInput('label', 'Counts');
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const list = root.querySelector('dl')!;
    expect(list.getAttribute('role')).toBe('group');
    expect(list.getAttribute('aria-label')).toBe('Counts');
    const lines = [...root.querySelectorAll('.line')].map((line) => [
      line.querySelector('dt')?.textContent,
      line.querySelector('dd')?.textContent,
    ]);
    expect(lines.map(([term]) => term)).toEqual([
      'TOBACCO_SYNC.COUNT.inserted',
      'TOBACCO_SYNC.COUNT.updated',
      'TOBACCO_SYNC.COUNT.disabled',
      'TOBACCO_SYNC.COUNT.reactivated',
      'TOBACCO_SYNC.COUNT.unchanged',
      'TOBACCO_SYNC.COUNT.skipped',
      'TOBACCO_SYNC.COUNT.categoriesInserted',
      'TOBACCO_SYNC.COUNT.duplicateNames',
      'TOBACCO_SYNC.COUNT.duplicateCodes',
    ]);
    expect(lines[0][1]).toMatch(/^1\D?200$/);
    expect(lines.slice(1).map(([, value]) => value)).toEqual([
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
    ]);
  });
});
