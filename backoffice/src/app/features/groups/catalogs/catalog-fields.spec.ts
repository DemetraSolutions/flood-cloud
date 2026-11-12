import { TestBed } from '@angular/core/testing';
import { I18nService } from '../../../core/i18n/i18n.service';
import {
  dateIssue,
  datesReversed,
  dateTimeText,
  fromLocalInput,
  numberIssue,
  numberOrNull,
  numberText,
  placesCell,
  sameList,
  textOrNull,
  toLocalInput,
  validityText,
} from './catalog-fields';

describe('numberIssue', () => {
  it('requires a value unless optional', () => {
    expect(numberIssue('  ', { min: 0 })).toBe('required');
    expect(numberIssue('', { min: 0, optional: true })).toBeUndefined();
  });

  it('rejects text that is not a finite number', () => {
    expect(numberIssue('abc', { min: 0 })).toBe('type');
    expect(numberIssue('Infinity', { min: 0 })).toBe('type');
  });

  it('rejects decimals when an integer is expected', () => {
    expect(numberIssue('1.5', { min: 0, integer: true })).toBe('type');
    expect(numberIssue('2', { min: 0, integer: true })).toBeUndefined();
    expect(numberIssue('1.5', { min: 0 })).toBeUndefined();
  });

  it('checks the minimum and the maximum', () => {
    expect(numberIssue('-1', { min: 0 })).toBe('minimum');
    expect(numberIssue('101', { min: 0, max: 100 })).toBe('maximum');
    expect(numberIssue('100', { min: 0, max: 100 })).toBeUndefined();
    expect(numberIssue('1000', { min: 0 })).toBeUndefined();
  });
});

describe('field conversions', () => {
  it('converts a number text to a number or null', () => {
    expect(numberOrNull(' 12.5 ')).toBe(12.5);
    expect(numberOrNull('  ')).toBeNull();
  });

  it('converts a number to the text of a field', () => {
    expect(numberText(7)).toBe('7');
    expect(numberText(null)).toBe('');
  });

  it('trims a text or returns null when blank', () => {
    expect(textOrNull('  abc ')).toBe('abc');
    expect(textOrNull('   ')).toBeNull();
  });
});

describe('dates in the time zone of the browser', () => {
  it('shows a stored instant as a datetime-local value and reads it back', () => {
    const local = toLocalInput('2026-12-01T10:30:00.000Z');
    expect(local).toMatch(/^2026-12-01T\d{2}:30$|^2026-12-0[12]T\d{2}:\d{2}$/);
    expect(fromLocalInput(local)).toBe('2026-12-01T10:30:00.000Z');
  });

  it('shows nothing for no date or for a text that is not a date', () => {
    expect(toLocalInput(null)).toBe('');
    expect(toLocalInput('not a date')).toBe('');
  });

  it('writes a year of fewer than four digits as the input expects', () => {
    const local = toLocalInput('0999-06-15T12:00:00.000Z');
    expect(local).toMatch(/^0999-06-1[45]T\d{2}:\d{2}$/);
    // Historical zones may have offsets in seconds: only check that the value reads back.
    expect(fromLocalInput(local)).not.toBeNull();
  });

  it('reads an empty or invalid input as no date', () => {
    expect(fromLocalInput('')).toBeNull();
    expect(fromLocalInput('  ')).toBeNull();
    expect(fromLocalInput('nonsense')).toBeNull();
  });

  it('refuses texts that Date would bend into another date', () => {
    expect(fromLocalInput('1')).toBeNull();
    expect(fromLocalInput('abc 2020')).toBeNull();
    expect(fromLocalInput('2026-02-30T10:00')).toBeNull();
    expect(fromLocalInput('2026-04-31T10:00')).toBeNull();
    expect(fromLocalInput('2026-13-01T10:00')).toBeNull();
    expect(fromLocalInput('2026-12-01T24:00')).toBeNull();
    expect(fromLocalInput('2026-12-01T10:00Z')).toBeNull();
    expect(fromLocalInput('0000-00-01T10:00')).toBeNull();
    expect(fromLocalInput('10000-01-01T10:00')).toBeNull();
    expect(fromLocalInput('2026-02-28T10:00:30')).toBe(
      new Date('2026-02-28T10:00:30').toISOString(),
    );
    expect(fromLocalInput('2028-02-29T10:00')).toBe(new Date('2028-02-29T10:00').toISOString());
  });

  it('flags a filled date field that is not a date', () => {
    expect(dateIssue('')).toBeUndefined();
    expect(dateIssue(' ')).toBeUndefined();
    expect(dateIssue('2026-12-01T10:00')).toBeUndefined();
    expect(dateIssue('2026-02-30T10:00')).toBe('incorrect');
  });

  it('detects an end before the start, only when both are dates', () => {
    expect(datesReversed('2026-12-02T10:00', '2026-12-01T10:00')).toBe(true);
    expect(datesReversed('2026-12-01T10:00', '2026-12-02T10:00')).toBe(false);
    expect(datesReversed('2026-12-01T10:00', '2026-12-01T10:00')).toBe(false);
    expect(datesReversed('', '2026-12-01T10:00')).toBe(false);
    expect(datesReversed('2026-12-01T10:00', '')).toBe(false);
  });
});

describe('lists and texts of catalog tables', () => {
  const i18n = () => {
    const service = TestBed.inject(I18nService);
    vi.spyOn(service, 't').mockImplementation((key, params) =>
      params === undefined ? key : `${key} ${JSON.stringify(params)}`,
    );
    return service;
  };
  afterEach(() => vi.restoreAllMocks());

  it('compares lists by content and order', () => {
    expect(sameList(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(sameList(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(sameList(['a'], ['a', 'b'])).toBe(false);
  });

  it('describes the stores of an element, marking the read-only ones', () => {
    expect(placesCell(i18n(), [], false)).toBe('CATALOG.ALL_PLACES');
    expect(placesCell(i18n(), ['a', 'b'], false)).toBe('CATALOG.PLACES_COUNT {"count":2}');
    expect(placesCell(i18n(), ['a'], true)).toBe(
      'CATALOG.PLACES_COUNT {"count":1} · CATALOG.READ_ONLY',
    );
  });

  it('formats a stored date, and shows a text that is not a date as it is', () => {
    const service = TestBed.inject(I18nService);
    expect(dateTimeText(service, '2026-12-01T10:30:00.000Z')).toMatch(/2026/);
    expect(dateTimeText(service, 'yesterday')).toBe('yesterday');
  });

  it('describes a validity period', () => {
    const service = i18n();
    expect(validityText(service, null, null)).toBe('CATALOG.ALWAYS');
    expect(validityText(service, null, 'soon')).toBe('CATALOG.VALIDITY {"from":"…","to":"soon"}');
    expect(validityText(service, 'later', null)).toBe('CATALOG.VALIDITY {"from":"later","to":"…"}');
  });
});
