import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { apply, FieldTree, form } from '@angular/forms/signals';
import {
  emptyWeek,
  ShiftSlot,
  ShiftTimeModel,
  ShiftWeek,
  SpecialDay,
} from '../../core/users/shift-time';
import { shiftTimeSchema } from './shift-time-schema';

/** The schema applied the way the user form does: under a `shiftTime` field. */
function shiftForm(shiftTime: ShiftTimeModel) {
  const model = signal({ shiftTime });
  return TestBed.runInInjectionContext(() =>
    form(model, (path) => {
      apply(path.shiftTime, shiftTimeSchema);
    }),
  );
}

function week(from: string, to: string, slots: ShiftSlot[] = []): ShiftWeek {
  const result = emptyWeek();
  result.from = from;
  result.to = to;
  result.days['1'] = { active: true, slots };
  return result;
}

const model = (weeks: ShiftWeek[] = [], specialDays: SpecialDay[] = []): ShiftTimeModel => ({
  enabled: true,
  weeks,
  specialDays,
});

/** Error kinds of every item of an array field. */
function eachKinds<T>(
  items: FieldTree<T[]>,
  pick: (item: FieldTree<T>) => { errors(): readonly { kind: string }[] },
): string[][] {
  return items()
    .value()
    .map((_, i) => kinds(pick(items[i] as FieldTree<T>)));
}

const kinds = (field: { errors(): readonly { kind: string }[] }) =>
  field.errors().map((error) => error.kind);

describe('shiftTimeSchema', () => {
  describe('slots of a week', () => {
    const slotOf = (start: string, end: string) => {
      const f = shiftForm(model([week('', '', [{ start, end }])]));
      return f.shiftTime.weeks[0].days['1'].slots[0];
    };

    it('accepts a valid slot', () => {
      const slot = slotOf('09:00', '13:30');
      expect(kinds(slot.start())).toEqual([]);
      expect(kinds(slot.end())).toEqual([]);
    });

    it('requires both times', () => {
      const slot = slotOf('', '');
      expect(kinds(slot.start())).toEqual(['required']);
      expect(kinds(slot.end())).toEqual(['required']);
    });

    it('requires the HH:mm format', () => {
      const slot = slotOf('9:00', '25:00');
      expect(kinds(slot.start())).toEqual(['format']);
      expect(kinds(slot.end())).toEqual(['format']);
    });

    it('requires the end to come after the start', () => {
      expect(kinds(slotOf('13:00', '09:00').end())).toEqual(['incorrect']);
      expect(kinds(slotOf('09:00', '09:00').end())).toEqual(['incorrect']);
    });

    it('does not judge the order when the start is not a valid time', () => {
      const slot = slotOf('xx', '09:00');
      expect(kinds(slot.start())).toEqual(['format']);
      expect(kinds(slot.end())).toEqual([]);
    });
  });

  describe('dates of a week', () => {
    const datesOf = (from: string, to: string) => {
      const f = shiftForm(model([week(from, to)]));
      return f.shiftTime.weeks[0];
    };

    it('accepts the default block without dates', () => {
      const w = datesOf('', '');
      expect(kinds(w.from())).toEqual([]);
      expect(kinds(w.to())).toEqual([]);
      expect(kinds(w())).toEqual([]);
    });

    it('accepts a valid range, even of one day', () => {
      const w = datesOf('2026-03-01', '2026-03-01');
      expect(kinds(w.from())).toEqual([]);
      expect(kinds(w.to())).toEqual([]);
      expect(kinds(w())).toEqual([]);
    });

    it('requires both dates when one is set', () => {
      expect(kinds(datesOf('', '2026-03-01').from())).toEqual(['required']);
      expect(kinds(datesOf('2026-03-01', '').to())).toEqual(['required']);
    });

    it('requires real calendar dates', () => {
      expect(kinds(datesOf('2026-02-30', '2026-03-01').from())).toEqual(['format']);
      expect(kinds(datesOf('2026-03-01', 'soon').to())).toEqual(['format']);
    });

    it('requires the start not to be after the end', () => {
      expect(kinds(datesOf('2026-03-10', '2026-03-01').to())).toEqual(['incorrect']);
    });

    it('does not compare with a start that is not a date', () => {
      expect(kinds(datesOf('2026-02-30', '2026-03-01').to())).toEqual([]);
    });
  });

  describe('blocks of weeks', () => {
    it('accepts a default block and dated blocks that do not overlap', () => {
      const f = shiftForm(
        model([week('', ''), week('2026-03-01', '2026-03-10'), week('2026-03-11', '2026-03-20')]),
      );
      expect(eachKinds(f.shiftTime.weeks, (w) => w())).toEqual([[], [], []]);
    });

    it('rejects a second default block', () => {
      const f = shiftForm(model([week('', ''), week('2026-03-01', '2026-03-10'), week('', '')]));
      expect(eachKinds(f.shiftTime.weeks, (w) => w())).toEqual([[], [], ['incorrect']]);
    });

    it('rejects a block that overlaps an earlier one', () => {
      const f = shiftForm(
        model([week('2026-03-01', '2026-03-10'), week('2026-03-10', '2026-03-20')]),
      );
      expect(eachKinds(f.shiftTime.weeks, (w) => w())).toEqual([[], ['incorrect']]);
    });

    it('does not compare blocks whose range is not valid', () => {
      const f = shiftForm(
        model([
          week('2026-03-10', '2026-03-01'),
          week('2026-03-01', '2026-03-20'),
          week('2026-02-30', '2026-03-20'),
          week('2026-03-01', '2026-03-05'),
          week('', '2026-03-01'),
        ]),
      );
      expect(kinds(f.shiftTime.weeks[1]())).toEqual([]);
      expect(kinds(f.shiftTime.weeks[2]())).toEqual([]);
      expect(kinds(f.shiftTime.weeks[3]())).toEqual(['incorrect']);
      expect(kinds(f.shiftTime.weeks[4]())).toEqual([]);
    });
  });

  describe('special days', () => {
    const day = (date: string, slots: ShiftSlot[] = []): SpecialDay => ({
      date,
      dayOff: false,
      slots,
    });

    it('accepts distinct valid dates', () => {
      const f = shiftForm(model([], [day('2026-12-25'), day('2026-12-26')]));
      expect(eachKinds(f.shiftTime.specialDays, (d) => d.date())).toEqual([[], []]);
    });

    it('requires a date in the YYYY-MM-DD format', () => {
      const f = shiftForm(model([], [day(''), day('2026-02-30'), day('25/12/2026')]));
      expect(eachKinds(f.shiftTime.specialDays, (d) => d.date())).toEqual([
        ['required'],
        ['format'],
        ['format'],
      ]);
    });

    it('rejects a date that appears again, not the first occurrence', () => {
      const f = shiftForm(
        model([], [day('2026-12-25'), day('2026-12-26'), day('2026-12-25'), day('2026-12-26')]),
      );
      expect(eachKinds(f.shiftTime.specialDays, (d) => d.date())).toEqual([
        [],
        [],
        ['incorrect'],
        ['incorrect'],
      ]);
    });

    it('validates the slots of a special day like those of a week', () => {
      const f = shiftForm(
        model(
          [],
          [
            day('2026-12-25', [
              { start: '10:00', end: '12:00' },
              { start: '', end: '09:00' },
              { start: '13:00', end: '12:00' },
            ]),
          ],
        ),
      );
      const slots = f.shiftTime.specialDays[0].slots;
      expect([kinds(slots[0].start()), kinds(slots[0].end())]).toEqual([[], []]);
      expect(kinds(slots[1].start())).toEqual(['required']);
      expect(kinds(slots[1].end())).toEqual([]);
      expect(kinds(slots[2].end())).toEqual(['incorrect']);
    });
  });
});
