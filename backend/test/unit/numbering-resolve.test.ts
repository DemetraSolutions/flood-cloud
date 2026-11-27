import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TIME_ZONE, fiscalYearOf, numberingBase, resolvePrefixSuffix } from '../../src/modules/document-numbering/numbering.resolve.ts';

describe('the sectional of the documents', () => {
  const company = { invoicesPS: 'suffix', invoicesPSValues: [{ name: 'A', cash: false }, { name: 'B', cash: true }, { name: 'C', cash: true }] };

  it('takes the sectional the point of sale chose when the company has it', () => {
    assert.deepEqual(resolvePrefixSuffix(company, { invoicePS: 'A' }), { name: 'A', position: 'suffix', anomalies: [] });
  });

  it('takes the sectional of the cash desks (the first) when the point of sale chose none', () => {
    for (const choice of [undefined, null, '', 5]) {
      assert.deepEqual(resolvePrefixSuffix(company, { invoicePS: choice }), { name: 'B', position: 'suffix', anomalies: [] });
    }
  });

  it('goes around a sectional the company no longer has, with the anomaly, and never refuses', () => {
    assert.deepEqual(resolvePrefixSuffix(company, { invoicePS: 'Z' }), { name: 'B', position: 'suffix', anomalies: [{ code: 'prefixSuffixMissing' }] });
    assert.deepEqual(resolvePrefixSuffix({ invoicesPS: 'prefix', invoicesPSValues: [{ name: 'A', cash: false }] }, { invoicePS: 'Z' }), { name: '', position: 'prefix', anomalies: [{ code: 'prefixSuffixMissing' }] });
  });

  it('has no sectional when the company has none, and ignores what is not a sectional', () => {
    assert.deepEqual(resolvePrefixSuffix({}, {}), { name: '', position: null, anomalies: [] });
    assert.deepEqual(resolvePrefixSuffix({ invoicesPS: 'middle', invoicesPSValues: 'A' }, { invoicePS: 'A' }), { name: '', position: null, anomalies: [{ code: 'prefixSuffixMissing' }] });
    assert.deepEqual(resolvePrefixSuffix({ invoicesPS: 'prefix', invoicesPSValues: [null, 7, { name: 5, cash: true }, { cash: true }, { name: 'D' }] }, { invoicePS: 'D' }), { name: 'D', position: 'prefix', anomalies: [] });
    assert.deepEqual(resolvePrefixSuffix({ invoicesPSValues: [{ name: '', cash: true }] }, {}), { name: '', position: null, anomalies: [] });
  });
});

describe('the last invoice number issued outside Flood', () => {
  it('is a base only when it is a whole positive number or the digits of one', () => {
    assert.equal(numberingBase(5), 5);
    assert.equal(numberingBase('12'), 12);
    for (const raw of [0, -1, 1.5, '', 'x', '1.5', '-3', '1'.repeat(16), undefined, null, NaN, Infinity, {}, [4], 2 ** 60]) {
      assert.equal(numberingBase(raw), 0, String(raw));
    }
  });
});

describe('the fiscal year of a document', () => {
  const iso = (date: Date): string => date.toISOString();

  it('is the calendar year in the time zone of the point of sale, at the new year of Rome', () => {
    const before = fiscalYearOf(new Date('2026-12-31T22:30:00Z'), 'Europe/Rome');
    assert.equal(before.year, 2026);
    assert.deepEqual([iso(before.start), iso(before.end), before.timeZone, before.anomalies], ['2025-12-31T23:00:00.000Z', '2026-12-31T23:00:00.000Z', 'Europe/Rome', []]);
    const after = fiscalYearOf(new Date('2026-12-31T23:30:00Z'), 'Europe/Rome');
    assert.equal(after.year, 2027);
    assert.deepEqual([iso(after.start), iso(after.end)], ['2026-12-31T23:00:00.000Z', '2027-12-31T23:00:00.000Z']);
    // The boundary instants themselves: the start is in the year, the last millisecond before it is in the one before.
    assert.equal(fiscalYearOf(new Date('2026-12-31T23:00:00.000Z'), 'Europe/Rome').year, 2027);
    assert.equal(fiscalYearOf(new Date('2026-12-31T22:59:59.999Z'), 'Europe/Rome').year, 2026);
  });

  it('follows the offset of the zone in January, and the daylight saving of the day of the date never moves the boundaries', () => {
    const summer = fiscalYearOf(new Date('2026-07-15T10:00:00Z'), 'Europe/Rome');
    assert.deepEqual([summer.year, iso(summer.start), iso(summer.end)], [2026, '2025-12-31T23:00:00.000Z', '2026-12-31T23:00:00.000Z']);
    const sydney = fiscalYearOf(new Date('2026-06-15T10:00:00Z'), 'Australia/Sydney');
    assert.deepEqual([sydney.year, iso(sydney.start), iso(sydney.end)], [2026, '2025-12-31T13:00:00.000Z', '2026-12-31T13:00:00.000Z']);
    const york = fiscalYearOf(new Date('2026-01-01T03:00:00Z'), 'America/New_York');
    assert.deepEqual([york.year, iso(york.start), iso(york.end)], [2025, '2025-01-01T05:00:00.000Z', '2026-01-01T05:00:00.000Z']);
    const utc = fiscalYearOf(new Date('2026-03-01T00:00:00Z'), 'UTC');
    assert.deepEqual([utc.year, iso(utc.start), iso(utc.end)], [2026, '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z']);
  });

  it('works at the ends of the supported years', () => {
    const first = fiscalYearOf(new Date('1970-01-01T00:00:00Z'), 'Europe/Rome');
    assert.deepEqual([first.year, iso(first.start)], [1970, '1969-12-31T23:00:00.000Z']);
    const last = fiscalYearOf(new Date('9998-06-01T00:00:00Z'), 'UTC');
    assert.deepEqual([last.year, iso(last.start), iso(last.end)], [9998, '9998-01-01T00:00:00.000Z', '9999-01-01T00:00:00.000Z']);
  });

  it('goes around a missing or invalid time zone with Europe/Rome and the anomaly', () => {
    for (const zone of [undefined, null, '', 'Mars/Phobos', 3]) {
      const found = fiscalYearOf(new Date('2026-12-31T23:30:00Z'), zone);
      assert.deepEqual([found.year, found.timeZone, found.anomalies], [2027, DEFAULT_TIME_ZONE, [{ code: 'timezoneInvalid' }]], String(zone));
    }
  });

  it('refuses a date that is not a date or is out of the supported years: a bug of the caller', () => {
    assert.throws(() => fiscalYearOf(new Date(NaN), 'UTC'), RangeError);
    assert.throws(() => fiscalYearOf('2026-01-01' as unknown as Date, 'UTC'), RangeError);
    assert.throws(() => fiscalYearOf(new Date('1969-12-31T12:00:00Z'), 'UTC'), RangeError);
    assert.throws(() => fiscalYearOf(new Date('9999-06-01T00:00:00Z'), 'UTC'), RangeError);
    assert.throws(() => fiscalYearOf(new Date('0100-06-01T00:00:00Z'), 'UTC'), RangeError);
  });

  it('puts a year before the common era below the supported ones', () => {
    assert.throws(() => fiscalYearOf(new Date(Date.UTC(-100, 5, 1)), 'UTC'), RangeError);
  });
});
