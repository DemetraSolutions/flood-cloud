import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isFuture, monthOf, monthStart, monthsLeft, parseMonth, periodOf, previousMonth, yearPeriodOf } from '../../src/modules/activations/activations.period.ts';

describe('the months of the billing', () => {
  it('counts the months left of the activation year: the month of the activation is never paid, so May gives 7 and December gives 0', () => {
    assert.deepEqual([1, 2, 5, 6, 11, 12].map((month) => monthsLeft({ year: 2026, month })), [11, 10, 7, 6, 1, 0]);
  });

  it('takes the month of an instant in Rome: the turn of a month is at 22:00 UTC in summer and 23:00 UTC in winter', () => {
    // Summer time (UTC+2): 1 June 00:00 in Rome is 31 May 22:00 UTC.
    assert.deepEqual(monthOf(new Date('2026-05-31T21:59:59.999Z')), { year: 2026, month: 5 });
    assert.deepEqual(monthOf(new Date('2026-05-31T22:00:00.000Z')), { year: 2026, month: 6 });
    // Winter time (UTC+1): 1 February 00:00 in Rome is 31 January 23:00 UTC.
    assert.deepEqual(monthOf(new Date('2026-01-31T22:59:59.999Z')), { year: 2026, month: 1 });
    assert.deepEqual(monthOf(new Date('2026-01-31T23:00:00.000Z')), { year: 2026, month: 2 });
    // The turn of a year, in winter time.
    assert.deepEqual(monthOf(new Date('2025-12-31T22:59:59.999Z')), { year: 2025, month: 12 });
    assert.deepEqual(monthOf(new Date('2025-12-31T23:00:00.000Z')), { year: 2026, month: 1 });
    // Midnight UTC of 1 June is already 02:00 in Rome; 23:30 UTC of 31 May is June 1 in Rome.
    assert.deepEqual(monthOf(new Date('2026-05-31T23:30:00Z')), { year: 2026, month: 6 });
    assert.deepEqual(monthOf(new Date('2026-06-01T00:00:00Z')), { year: 2026, month: 6 });
    // The nights the clocks change are not turns of a month, and the hours around them stay in their month.
    assert.deepEqual(monthOf(new Date('2026-03-28T23:30:00Z')), { year: 2026, month: 3 });
    assert.deepEqual(monthOf(new Date('2026-10-31T00:30:00Z')), { year: 2026, month: 10 });
  });

  it('starts a month at midnight in Rome, winter and summer, and 13 is the start of the next year', () => {
    assert.equal(monthStart(2026, 6).toISOString(), '2026-05-31T22:00:00.000Z');
    assert.equal(monthStart(2026, 1).toISOString(), '2025-12-31T23:00:00.000Z');
    assert.equal(monthStart(2026, 2).toISOString(), '2026-01-31T23:00:00.000Z');
    assert.equal(monthStart(2026, 3).toISOString(), '2026-02-28T23:00:00.000Z');
    assert.equal(monthStart(2026, 4).toISOString(), '2026-03-31T22:00:00.000Z');
    assert.equal(monthStart(2026, 10).toISOString(), '2026-09-30T22:00:00.000Z');
    assert.equal(monthStart(2026, 11).toISOString(), '2026-10-31T23:00:00.000Z');
    assert.equal(monthStart(2025, 13).toISOString(), '2025-12-31T23:00:00.000Z');
    // Every month of a span of years starts at midnight in Rome exactly.
    for (let year = 2020; year <= 2100; year += 1) {
      for (let month = 1; month <= 12; month += 1) {
        const start = monthStart(year, month);
        assert.deepEqual(monthOf(start), { year, month });
        assert.deepEqual(monthOf(new Date(start.getTime() - 1)), month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 });
      }
    }
  });

  it('goes back one month, January to December of the year before', () => {
    assert.deepEqual(previousMonth({ year: 2026, month: 6 }), { year: 2026, month: 5 });
    assert.deepEqual(previousMonth({ year: 2026, month: 1 }), { year: 2025, month: 12 });
  });

  it('writes and reads the text of a month, for the years 2020 to 2100 only', () => {
    assert.equal(periodOf({ year: 2026, month: 6 }), '2026-06');
    assert.equal(periodOf({ year: 2026, month: 12 }), '2026-12');
    assert.equal(yearPeriodOf(2026), '2026');
    assert.deepEqual(parseMonth('2026-06'), { year: 2026, month: 6 });
    assert.deepEqual(parseMonth('2020-01'), { year: 2020, month: 1 });
    assert.deepEqual(parseMonth('2100-12'), { year: 2100, month: 12 });
    for (const bad of ['2019-12', '2101-01', '2026-00', '2026-13', '2026-6', '26-06', '2026/06', '2026-06-01', '', ' 2026-06', 'abcd-ef']) {
      assert.equal(parseMonth(bad), null, bad);
    }
  });

  it('tells a month after the month of now, in Rome', () => {
    const now = new Date('2026-05-31T21:59:59Z');
    assert.equal(isFuture({ year: 2026, month: 5 }, now), false);
    assert.equal(isFuture({ year: 2026, month: 6 }, now), true, 'June has not started in Rome yet... it is May, so June is the future');
    assert.equal(isFuture({ year: 2026, month: 4 }, now), false);
    assert.equal(isFuture({ year: 2027, month: 1 }, now), true);
    assert.equal(isFuture({ year: 2025, month: 12 }, now), false);
    assert.equal(isFuture({ year: 2026, month: 6 }, new Date('2026-05-31T22:00:00Z')), false, 'from its first minute in Rome a month can be closed');
  });
});

describe('the order of the detail view', () => {
  const key = { at: 1000, dealerName: 'b', groupName: 'b', placeName: 'b', placeId: 'b'.repeat(24) };
  it('goes by date descending, then dealer, group and place name, then id, and a key is equal to itself', async () => {
    const { compareDetailKeys } = await import('../../src/modules/activations/activations.mapper.ts');
    assert.ok(compareDetailKeys({ ...key, at: 2000 }, key) < 0);
    assert.ok(compareDetailKeys({ ...key, at: 500 }, key) > 0);
    assert.ok(compareDetailKeys({ ...key, dealerName: 'a' }, key) < 0);
    assert.ok(compareDetailKeys({ ...key, groupName: 'a' }, key) < 0);
    assert.ok(compareDetailKeys({ ...key, placeName: 'c' }, key) > 0);
    assert.ok(compareDetailKeys({ ...key, placeId: 'a'.repeat(24) }, key) < 0);
    assert.ok(compareDetailKeys({ ...key, placeId: 'c'.repeat(24) }, key) > 0);
    assert.equal(compareDetailKeys(key, { ...key }), 0);
  });
});
