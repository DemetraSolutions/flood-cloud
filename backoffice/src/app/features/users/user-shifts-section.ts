import { Component, inject } from '@angular/core';
import { FieldTree, FormField } from '@angular/forms/signals';
import { TPipe } from '../../core/i18n/t-pipe';
import {
  emptyWeek,
  MAX_SHIFT_SPECIAL_DAYS,
  MAX_SHIFT_WEEKS,
  SHIFT_DAY_ORDER,
  ShiftDayKey,
  ShiftWeek,
} from '../../core/users/shift-time';
import { Button } from '../../shared/ui/button/button';
import { Checkbox } from '../../shared/ui/checkbox/checkbox';
import { TextField } from '../../shared/ui/text-field/text-field';
import { ShiftSlots } from './shift-slots';
import { UserFormState } from './user-form-state';

/**
 * Work shifts: the switch, week blocks (one without dates that always applies, and others with a
 * date range that win over it) with the hours of each day (Monday first), and special days that
 * win over everything. The same rules as the backend are checked while typing; the backend
 * remains the authority.
 */
@Component({
  selector: 'fc-user-shifts-section',
  imports: [Button, Checkbox, FormField, ShiftSlots, TextField, TPipe],
  templateUrl: './user-shifts-section.html',
  styleUrls: ['./user-section.css', './user-shifts-section.css'],
})
export class UserShiftsSection {
  protected readonly state = inject(UserFormState);
  protected readonly shift = this.state.userForm.shiftTime;
  protected readonly days = SHIFT_DAY_ORDER;
  protected readonly maxWeeks = MAX_SHIFT_WEEKS;
  protected readonly maxSpecial = MAX_SHIFT_SPECIAL_DAYS;

  protected dayLabel(key: ShiftDayKey): string {
    return this.state.i18n.t(`USERS.SHIFTS.DAY.${key}`);
  }

  protected weekTitle(week: FieldTree<ShiftWeek>, index: number): string {
    const { from, to } = week().value();
    if (from === '' && to === '') {
      return this.state.i18n.t('USERS.SHIFTS.WEEK_DEFAULT');
    }
    return this.state.i18n.t('USERS.SHIFTS.WEEK_N', { n: index + 1 });
  }

  protected specialTitle(index: number): string {
    return this.state.i18n.t('USERS.SHIFTS.SPECIAL_N', { n: index + 1 });
  }

  protected addWeek(): void {
    this.shift.weeks().value.update((weeks) => [...weeks, emptyWeek()]);
  }

  protected removeWeek(index: number): void {
    this.shift.weeks().value.update((weeks) => weeks.filter((_, position) => position !== index));
  }

  protected addSpecial(): void {
    this.shift
      .specialDays()
      .value.update((days) => [...days, { date: '', dayOff: false, slots: [] }]);
  }

  protected removeSpecial(index: number): void {
    this.shift
      .specialDays()
      .value.update((days) => days.filter((_, position) => position !== index));
  }
}
