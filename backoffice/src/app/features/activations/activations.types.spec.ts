import { ApiError } from '../../core/api/api-error';
import {
  ACTION_TEXTS,
  conflictKey,
  feeItemName,
  isActivationTab,
  rangeIssue,
  currentMonth,
  FeeItem,
  flagText,
  formatCents,
  groupLines,
  isMonth,
  isSection,
  itemText,
  monthLabel,
  monthName,
  previousMonth,
  StatementLine,
  yearOf,
} from './activations.types';

const t = (key: string, params?: Record<string, string | number>) =>
  params === undefined ? key : `${key} ${JSON.stringify(params)}`;

describe('months', () => {
  it.each(['2026-06', '2020-01', '2099-12', '2100-12'])('accepts %s', (month) => {
    expect(isMonth(month)).toBe(true);
  });

  it.each([
    '2019-12',
    '2101-01',
    '2026-13',
    '2026-00',
    '2026-6',
    '26-06',
    '2026-06-01',
    '',
    5,
    null,
  ])('refuses %j', (month) => {
    expect(isMonth(month)).toBe(false);
  });

  it('counts the current month in Italy: the boundaries around midnight UTC', () => {
    // 23:59 in Rome on 31 May (summer time, UTC+2): still May.
    expect(currentMonth(new Date('2026-05-31T21:59:00Z'))).toBe('2026-05');
    // 00:00 in Rome on 1 June: June, although UTC is still May.
    expect(currentMonth(new Date('2026-05-31T22:00:00Z'))).toBe('2026-06');
    // 23:30 UTC on 31 December is already January in Rome (winter time, UTC+1).
    expect(currentMonth(new Date('2026-12-31T23:30:00Z'))).toBe('2027-01');
    expect(currentMonth(new Date('2026-12-31T22:59:00Z'))).toBe('2026-12');
    expect(currentMonth()).toMatch(/^\d{4}-\d{2}$/);
  });

  it('goes back one month, over the end of the year too', () => {
    expect(previousMonth('2026-06')).toBe('2026-05');
    expect(previousMonth('2026-12')).toBe('2026-11');
    expect(previousMonth('2026-01')).toBe('2025-12');
  });

  it('reads the year', () => {
    expect(yearOf('2026-06')).toBe(2026);
  });

  it('writes a month in words, whatever the time zone of the browser', () => {
    expect(monthLabel('2026-06', 'it')).toBe('giugno 2026');
    expect(monthLabel('2026-01', 'it')).toBe('gennaio 2026');
    expect(monthName('2026-06', 'it')).toBe('giugno');
  });
});

describe('formatCents', () => {
  it('writes euro with the Italian conventions', () => {
    expect(formatCents(12345678, 'it').replace(/\s/g, ' ')).toBe('123.456,78 €');
    expect(formatCents(0, 'it').replace(/\s/g, ' ')).toBe('0,00 €');
  });
});

describe('sections', () => {
  it('knows the two sections', () => {
    expect(isSection('activations')).toBe(true);
    expect(isSection('renewals')).toBe(true);
    expect(isSection('other')).toBe(false);
    expect(isSection(undefined)).toBe(false);
  });
});

describe('texts', () => {
  const item = (key: string, quantity = 1): FeeItem => ({
    key,
    quantity,
    unitCents: 100,
    amountCents: 100 * quantity,
  });

  it('names the flags, and shows an unknown one as it is', () => {
    expect(flagText(t, 'unpricedPlan')).toBe('ACTIVATIONS.FLAG.UNPRICED_PLAN');
    expect(flagText(t, 'expired')).toBe('ACTIVATIONS.FLAG.EXPIRED');
    expect(flagText(t, 'groupSuspended')).toBe('ACTIVATIONS.FLAG.GROUP_SUSPENDED');
    expect(flagText(t, 'companyDisabled')).toBe('ACTIVATIONS.FLAG.COMPANY_DISABLED');
    expect(flagText(t, 'activationDateFromId')).toBe('ACTIVATIONS.FLAG.DATE_FROM_ID');
    expect(flagText(t, 'somethingNew')).toBe('somethingNew');
    expect(flagText(t, 'constructor')).toBe('constructor');
  });

  it('names the items of a fee', () => {
    expect(itemText(t, item('plan:basic'))).toBe('ACTIVATIONS.ITEM.PLAN {"plan":"basic"}');
    expect(itemText(t, item('extraDesk'))).toBe('PRICE_SERVICE.EXTRA_DESK');
    expect(itemText(t, item('extraDesk', 2))).toBe('ACTIVATIONS.ITEM.EXTRA_DESKS {"count":2}');
    expect(itemText(t, item('plan:'))).toBe('ACTIVATIONS.ITEM.NO_PLAN');
    expect(itemText(t, item('kiosk'))).toBe('PRICE_SERVICE.KIOSK');
    expect(itemText(t, item('api'))).toBe('PRICE_SERVICE.API');
    expect(itemText(t, item('somethingNew'))).toBe('somethingNew');
  });

  it('has the texts of every action', () => {
    expect(Object.keys(ACTION_TEXTS)).toEqual(['freeze', 'unfreeze', 'close', 'reopen']);
  });
});

describe('groupLines', () => {
  function line(group: string, company: string, place: string): StatementLine {
    return {
      groupId: group,
      groupName: `Gruppo ${group}`,
      companyId: company,
      companyName: `Azienda ${company}`,
      placeId: place,
      placeName: `Punto ${place}`,
      activatedAt: '2026-05-10T10:00:00.000Z',
      plan: 'basic',
      items: [],
      monthlyCents: 2000,
      months: 7,
      amountCents: 14000,
      flags: [],
      projection12Cents: 24000,
    };
  }

  it('groups the lines by group and by company, in order', () => {
    const blocks = groupLines([
      line('g1', 'c1', 'p1'),
      line('g1', 'c1', 'p2'),
      line('g1', 'c2', 'p3'),
      line('g2', 'c2', 'p4'),
    ]);
    expect(
      blocks.map((group) => [
        group.groupName,
        group.companies.map((company) => [company.companyName, company.lines.length]),
      ]),
    ).toEqual([
      [
        'Gruppo g1',
        [
          ['Azienda c1', 2],
          ['Azienda c2', 1],
        ],
      ],
      ['Gruppo g2', [['Azienda c2', 1]]],
    ]);
  });

  it('gives nothing for no lines', () => {
    expect(groupLines([])).toEqual([]);
  });
});

describe('conflictKey', () => {
  const conflict = (issue?: string) =>
    new ApiError({
      status: 409,
      code: 'CONFLICT',
      message: 'x',
      details: issue === undefined ? [] : [{ field: 'month', issue }],
    });

  it('names the reason when it is a known one', () => {
    expect(conflictKey(conflict('baseNotFrozen'))).toBe('ACTIVATIONS.CONFLICT.BASE_NOT_FROZEN');
    expect(conflictKey(conflict('monthInFuture'))).toBe('ACTIVATIONS.CONFLICT.MONTH_IN_FUTURE');
    expect(conflictKey(conflict('alreadyClosed'))).toBe('ACTIVATIONS.CONFLICT.ALREADY_CLOSED');
    expect(conflictKey(conflict('monthClosed'))).toBe('ACTIVATIONS.CONFLICT.MONTH_CLOSED');
    expect(conflictKey(conflict('tooManyLines'))).toBe('ACTIVATIONS.CONFLICT.TOO_MANY_LINES');
    expect(conflictKey(conflict('alreadyFrozen'))).toBe('ACTIVATIONS.CONFLICT.ALREADY_FROZEN');
    expect(conflictKey(conflict('yearInFuture'))).toBe('ACTIVATIONS.CONFLICT.YEAR_IN_FUTURE');
    expect(conflictKey(conflict('empty'))).toBe('ACTIVATIONS.CONFLICT.EMPTY');
    expect(conflictKey(conflict('notFrozen'))).toBe('ACTIVATIONS.CONFLICT.NOT_FROZEN');
    expect(conflictKey(conflict('notClosed'))).toBe('ACTIVATIONS.CONFLICT.NOT_CLOSED');
  });

  it('gives a general text for any other conflict', () => {
    expect(conflictKey(conflict('somethingNew'))).toBe('ACTIVATIONS.CONFLICT.GENERIC');
    expect(conflictKey(conflict())).toBe('ACTIVATIONS.CONFLICT.GENERIC');
  });

  it('leaves anything else to the central mapping', () => {
    expect(
      conflictKey(new ApiError({ status: 500, code: 'INTERNAL_ERROR', message: 'x' })),
    ).toBeNull();
    expect(conflictKey(new Error('boom'))).toBeNull();
  });
});

describe('rangeIssue', () => {
  it('accepts a period of up to 24 months, in order', () => {
    expect(rangeIssue('2026-05', '2026-05')).toBeUndefined();
    expect(rangeIssue('2025-01', '2026-12')).toBeUndefined();
    expect(rangeIssue('2025-12', '2026-01')).toBeUndefined();
  });

  it('refuses a period that ends first or lasts more than 24 months', () => {
    expect(rangeIssue('2026-06', '2026-05')).toBe('order');
    expect(rangeIssue('2025-01', '2027-01')).toBe('span');
  });
});

describe('tabs', () => {
  it('knows the two tabs', () => {
    expect(isActivationTab('invoices')).toBe(true);
    expect(isActivationTab('detail')).toBe(true);
    expect(isActivationTab('other')).toBe(false);
  });
});

describe('feeItemName', () => {
  const item = (key: string, providers?: string[]): FeeItem => ({
    key,
    quantity: 3,
    unitCents: 100,
    amountCents: 300,
    ...(providers === undefined ? {} : { providers }),
  });

  it('names the item without its quantity', () => {
    expect(feeItemName(t, item('extraDesk'))).toBe('PRICE_SERVICE.EXTRA_DESK');
  });

  it('adds the providers of the api item in brackets, unknown ones as they are', () => {
    expect(feeItemName(t, item('api', ['qodeup', 'googleMaps', 'statmanager', 'other']))).toBe(
      'PRICE_SERVICE.API (ACTIVATIONS.PROVIDER.QODEUP, ACTIVATIONS.PROVIDER.GOOGLE_MAPS, ACTIVATIONS.PROVIDER.STATMANAGER, other)',
    );
    expect(feeItemName(t, item('api', []))).toBe('PRICE_SERVICE.API');
  });
});
