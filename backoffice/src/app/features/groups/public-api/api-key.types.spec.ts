import { fakeApiKey } from '../../../../testing/api-keys';
import {
  addUtcDays,
  dailyTotals,
  daysInRange,
  expiryDay,
  expiryInstant,
  isRealDay,
  keyStatus,
  latestExpiryDay,
  permissionTextKey,
  usageRangeIssue,
  utcDay,
} from './api-key.types';

const NOW = new Date('2026-11-17T12:00:00.000Z');

describe('api key types', () => {
  it('builds the dictionary keys of a permission', () => {
    expect(permissionTextKey('places:read', 'LABEL')).toBe(
      'PUBLIC_API.PERMISSION.PLACES_READ.LABEL',
    );
    expect(permissionTextKey('catalog:read', 'HINT')).toBe(
      'PUBLIC_API.PERMISSION.CATALOG_READ.HINT',
    );
  });

  it('builds the dictionary keys of the catalog write permission', () => {
    expect(permissionTextKey('fidelityCards:write', 'HINT')).toBe(
      'PUBLIC_API.PERMISSION.FIDELITYCARDS_WRITE.HINT',
    );
    expect(permissionTextKey('catalog:write', 'LABEL')).toBe(
      'PUBLIC_API.PERMISSION.CATALOG_WRITE.LABEL',
    );
  });

  describe('keyStatus', () => {
    it('is revoked whatever the expiry', () => {
      expect(
        keyStatus(fakeApiKey({ status: 'revoked', expiresAt: '2020-01-01T00:00:00.000Z' }), NOW),
      ).toBe('revoked');
    });

    it('is expired from the expiry instant on', () => {
      expect(keyStatus(fakeApiKey({ expiresAt: '2026-11-17T12:00:00.000Z' }), NOW)).toBe('expired');
      expect(keyStatus(fakeApiKey({ expiresAt: '2026-11-17T12:00:00.001Z' }), NOW)).toBe('active');
    });

    it('is active without an expiry', () => {
      expect(keyStatus(fakeApiKey(), NOW)).toBe('active');
    });
  });

  describe('days', () => {
    it('formats and moves UTC days', () => {
      expect(utcDay(new Date('2026-01-05T23:59:59.999Z'))).toBe('2026-01-05');
      expect(utcDay(addUtcDays(NOW, -29))).toBe('2026-10-19');
      expect(utcDay(addUtcDays(NOW, 14))).toBe('2026-12-01');
    });

    it.each([
      ['2026-02-28', true],
      ['2024-02-29', true],
      ['2026-02-29', false],
      ['2026-13-01', false],
      ['2026-1-1', false],
      ['', false],
    ])('knows whether %s is a real day', (text, real) => {
      expect(isRealDay(text)).toBe(real);
    });

    it('counts the days of a range, both included', () => {
      expect(daysInRange('2026-11-17', '2026-11-17')).toBe(1);
      expect(daysInRange('2026-10-19', '2026-11-17')).toBe(30);
      expect(daysInRange('2026-11-18', '2026-11-17')).toBe(0);
    });

    it('reads the expiry as a UTC day and writes it as the end of the day', () => {
      expect(expiryDay(null)).toBe('');
      expect(expiryDay('2027-11-17T00:00:00.000Z')).toBe('2027-11-17');
      expect(expiryInstant('2027-11-17')).toBe('2027-11-17T23:59:59.999Z');
    });

    it('allows an expiry up to the day before the third anniversary', () => {
      expect(latestExpiryDay(NOW)).toBe('2029-11-16');
    });
  });

  describe('usageRangeIssue', () => {
    it.each([
      ['2026-10-19', '2026-11-17', undefined],
      ['2026-11-17', '2026-11-17', undefined],
      ['2026-08-18', '2026-11-17', undefined],
      ['2026-08-17', '2026-11-17', { field: 'from', issue: 'maximum' }],
      ['2026-11-18', '2026-11-17', { field: 'from', issue: 'incorrect' }],
      ['2026-02-30', '2026-11-17', { field: 'from', issue: 'format' }],
      ['', '2026-11-17', { field: 'from', issue: 'format' }],
      ['2026-11-01', 'tomorrow', { field: 'to', issue: 'format' }],
    ])('checks %s to %s', (from, to, expected) => {
      expect(usageRangeIssue(from, to)).toEqual(expected);
    });
  });

  it('adds up the rows of each day, in order', () => {
    const row = (day: string, route: string, calls: number) => ({
      day,
      route,
      calls,
      errors4xx: 1,
      errors5xx: 2,
      rateLimited: 3,
      aborted: 4,
    });
    expect(
      dailyTotals([
        row('2026-11-16', 'a', 5),
        row('2026-11-17', 'a', 1),
        row('2026-11-17', 'b', 2),
      ]),
    ).toEqual([
      { day: '2026-11-16', calls: 5, errors4xx: 1, errors5xx: 2, rateLimited: 3, aborted: 4 },
      { day: '2026-11-17', calls: 3, errors4xx: 2, errors5xx: 4, rateLimited: 6, aborted: 8 },
    ]);
    expect(dailyTotals([])).toEqual([]);
  });
});
