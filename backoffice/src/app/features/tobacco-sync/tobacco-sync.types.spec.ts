import {
  countOf,
  massDisableOf,
  reasonKey,
  tobaccoSyncRoute,
  UNAVAILABLE_REASONS,
} from './tobacco-sync.types';

describe('tobacco sync types', () => {
  it('builds the route of the page of the group', () => {
    expect(tobaccoSyncRoute('g1')).toEqual(['/groups', 'g1', 'tools', 'tobacco-sync']);
  });

  it('has a text key for each reason and a generic one for the others', () => {
    expect(UNAVAILABLE_REASONS.map(reasonKey)).toEqual(
      UNAVAILABLE_REASONS.map((reason) => `TOBACCO_SYNC.REASON.${reason}`),
    );
    expect(reasonKey('somethingNew')).toBe('TOBACCO_SYNC.REASON.unknown');
  });

  it('reads a figure of the log entry only when it is a number', () => {
    expect(countOf({ inserted: 3, updated: '4', disabled: null }, 'inserted')).toBe(3);
    expect(countOf({ inserted: 3, updated: '4', disabled: null }, 'updated')).toBe(0);
    expect(countOf({ inserted: 3 }, 'reactivated')).toBe(0);
  });

  it('reads the mass deactivation only when the threshold is exceeded', () => {
    const outcome = {
      dryRun: true,
      products: { inserted: 0, updated: 0, disabled: 30, reactivated: 0, unchanged: 0, skipped: 0 },
      categories: { inserted: 0, duplicateNames: 0 },
      duplicateCodes: 0,
    };
    expect(massDisableOf(outcome)).toBeNull();
    expect(massDisableOf({ ...outcome, massDisable: { active: 100, exceeded: false } })).toBeNull();
    expect(massDisableOf({ ...outcome, massDisable: { active: 100, exceeded: true } })).toEqual({
      disable: 30,
      active: 100,
    });
  });
});
