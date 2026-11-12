import {
  dateOf,
  emptyDay,
  emptyShiftTime,
  emptyWeek,
  isCalendarDate,
  isDated,
  rangesOverlap,
  SHIFT_DAY_KEYS,
  SHIFT_DAY_ORDER,
  ShiftTime,
  specialDaysBody,
  toShiftModel,
  weeksBody,
} from './shift-time';

describe('empty values', () => {
  it('has an inactive day without slots', () => {
    expect(emptyDay()).toEqual({ active: false, slots: [] });
  });

  it('has a default week with the seven days inactive and independent objects', () => {
    const week = emptyWeek();
    expect(week.from).toBe('');
    expect(week.to).toBe('');
    expect(Object.keys(week.days)).toEqual([...SHIFT_DAY_KEYS]);
    expect(Object.values(week.days).every((day) => !day.active && day.slots.length === 0)).toBe(
      true,
    );
    week.days['1'].slots.push({ start: '09:00', end: '12:00' });
    expect(emptyWeek().days['1'].slots).toEqual([]);
    expect(week.days['2']).not.toBe(week.days['1']);
  });

  it('has no shifts', () => {
    expect(emptyShiftTime()).toEqual({ enabled: false, weeks: [], specialDays: [] });
  });

  it('shows Monday first and Sunday last', () => {
    expect(SHIFT_DAY_ORDER).toEqual(['1', '2', '3', '4', '5', '6', '0']);
  });
});

describe('dateOf', () => {
  it('takes the date part of an instant, or nothing for null', () => {
    expect(dateOf('2026-03-01T00:00:00.000Z')).toBe('2026-03-01');
    expect(dateOf(null)).toBe('');
  });
});

function record(): ShiftTime {
  const week = emptyWeek();
  week.days['1'] = { active: true, slots: [{ start: '09:00', end: '13:00' }] };
  return {
    enabled: true,
    weeks: [
      { from: '2026-03-01T00:00:00.000Z', to: '2026-03-31T00:00:00.000Z', days: week.days },
      { from: null, to: null, days: emptyWeek().days },
    ],
    specialDays: [{ date: '2026-12-25', dayOff: false, slots: [{ start: '10:00', end: '12:00' }] }],
  };
}

describe('toShiftModel', () => {
  it('converts dates and copies slots', () => {
    const stored = record();
    const model = toShiftModel(stored);
    expect(model.enabled).toBe(true);
    expect(model.weeks.map((w) => [w.from, w.to])).toEqual([
      ['2026-03-01', '2026-03-31'],
      ['', ''],
    ]);
    expect(model.weeks[0].days['1']).toEqual({
      active: true,
      slots: [{ start: '09:00', end: '13:00' }],
    });
    expect(model.specialDays).toEqual(stored.specialDays);
    model.weeks[0].days['1'].slots[0].start = '08:00';
    model.specialDays[0].slots[0].start = '08:00';
    expect(stored.weeks[0].days['1'].slots[0].start).toBe('09:00');
    expect(stored.specialDays[0].slots[0].start).toBe('10:00');
  });
});

describe('request bodies', () => {
  it('turns empty week dates into null and keeps the others', () => {
    const body = weeksBody([{ ...emptyWeek(), from: '2026-03-01', to: '2026-03-31' }, emptyWeek()]);
    expect(body[0].from).toBe('2026-03-01');
    expect(body[0].to).toBe('2026-03-31');
    expect(body[1].from).toBeNull();
    expect(body[1].to).toBeNull();
    expect(Object.keys(body[1].days)).toEqual([...SHIFT_DAY_KEYS]);
  });

  it('copies the slots of the days', () => {
    const week = emptyWeek();
    week.days['3'] = { active: true, slots: [{ start: '09:00', end: '10:00' }] };
    const body = weeksBody([week]);
    expect(body[0].days['3']).toEqual({ active: true, slots: [{ start: '09:00', end: '10:00' }] });
    expect(body[0].days['3'].slots[0]).not.toBe(week.days['3'].slots[0]);
  });

  it('copies the special days', () => {
    const days = [{ date: '2026-12-25', dayOff: true, slots: [{ start: '10:00', end: '11:00' }] }];
    const body = specialDaysBody(days);
    expect(body).toEqual(days);
    expect(body[0]).not.toBe(days[0]);
    expect(body[0].slots[0]).not.toBe(days[0].slots[0]);
  });
});

describe('ranges and dates', () => {
  const range = (from: string, to: string) => ({ from, to });

  it.each([
    ['2026-03-01', '2026-03-10', '2026-03-05', '2026-03-20', true],
    ['2026-03-01', '2026-03-10', '2026-03-10', '2026-03-20', true],
    ['2026-03-05', '2026-03-20', '2026-03-01', '2026-03-10', true],
    ['2026-03-01', '2026-03-10', '2026-03-11', '2026-03-20', false],
    ['2026-03-11', '2026-03-20', '2026-03-01', '2026-03-10', false],
  ])('%s..%s vs %s..%s -> %s', (a, b, c, d, expected) => {
    expect(rangesOverlap(range(a, b), range(c, d))).toBe(expected);
  });

  it('tells a dated week from one with missing dates', () => {
    expect(isDated({ from: '2026-03-01', to: '2026-03-02' })).toBe(true);
    expect(isDated({ from: '', to: '2026-03-02' })).toBe(false);
    expect(isDated({ from: '2026-03-01', to: '' })).toBe(false);
    expect(isDated({ from: '', to: '' })).toBe(false);
  });

  it.each([
    ['2026-03-01', true],
    ['2028-02-29', true],
    ['2026-02-30', false],
    ['2026-02-29', false],
    ['2026-13-01', false],
    ['2026-00-10', false],
    ['2026-3-1', false],
    ['01/03/2026', false],
    ['', false],
    ['2026-03-01T00:00', false],
  ])('isCalendarDate(%s) -> %s', (value, expected) => {
    expect(isCalendarDate(value)).toBe(expected);
  });
});
