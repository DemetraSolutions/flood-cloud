import { Component, computed, inject, input } from '@angular/core';
import { FieldTree, FormField } from '@angular/forms/signals';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { Button } from '../../shared/ui/button/button';
import { Checkbox } from '../../shared/ui/checkbox/checkbox';
import { TextField } from '../../shared/ui/text-field/text-field';
import {
  MAX_SLOTS,
  MAX_SPECIAL_DAYS,
  ScheduleModel,
  SlotModel,
  SpecialDayModel,
  WEEK_DAYS,
} from './place-model';
import { PlaceState } from './place-state';
import { RowColumn, RowsEditor } from './rows-editor';

/**
 * A weekly schedule: for each day of the week whether the place is open and its time slots, and
 * the special days (a date, closed or with its own slots). It edits the opening hours or the
 * delivery hours of the model of the {@link PlaceState}.
 */
@Component({
  selector: 'fc-hours-schedule',
  imports: [Button, Checkbox, FormField, RowsEditor, TextField, TPipe],
  templateUrl: './hours-schedule.html',
  styleUrl: './place-section.css',
})
export class HoursSchedule {
  protected readonly state = inject(PlaceState);
  private readonly i18n = inject(I18nService);

  /** Which schedule: the opening hours or the delivery hours. */
  readonly which = input.required<'openingHours' | 'deliveryTime'>();

  protected readonly days = WEEK_DAYS;
  protected readonly maxSlots = MAX_SLOTS;
  protected readonly maxSpecial = MAX_SPECIAL_DAYS;

  protected readonly tree = computed(() => {
    const hours = this.state.form.openingHours;
    return (this.which() === 'openingHours' ? hours : hours.deliveryTime) as unknown as {
      week: Record<string, { active: FieldTree<boolean>; values: FieldTree<unknown> }>;
      special: Iterable<{
        date: FieldTree<string>;
        closed: FieldTree<boolean>;
        values: FieldTree<unknown>;
      }>;
    };
  });
  protected readonly model = computed<ScheduleModel>(() => {
    const hours = this.state.model().openingHours;
    return this.which() === 'openingHours' ? hours : hours.deliveryTime;
  });
  protected readonly specialDays = computed(() => [...this.tree().special]);
  protected readonly columns = computed<RowColumn[]>(() => [
    { key: 'start', type: 'time', label: this.i18n.t('PLACES.HOURS.START') },
    { key: 'end', type: 'time', label: this.i18n.t('PLACES.HOURS.END') },
  ]);

  protected dayLabel(day: string): string {
    return this.i18n.t(`PLACES.DAY.${day}`);
  }

  protected slotsLegend(label: string): string {
    return this.i18n.t('PLACES.HOURS.SLOTS', { day: label });
  }

  protected specialLegend(index: number): string {
    return this.i18n.t('PLACES.HOURS.SPECIAL_DAY', { number: index + 1 });
  }

  protected addSlot(day: string): void {
    this.change((schedule) => ({
      ...schedule,
      week: {
        ...schedule.week,
        [day]: { ...schedule.week[day], values: [...schedule.week[day].values, emptySlot()] },
      },
    }));
  }

  protected removeSlot(day: string, index: number): void {
    this.change((schedule) => ({
      ...schedule,
      week: {
        ...schedule.week,
        [day]: {
          ...schedule.week[day],
          values: schedule.week[day].values.filter((_, at) => at !== index),
        },
      },
    }));
  }

  protected addSpecial(): void {
    this.change((schedule) => ({
      ...schedule,
      special: [...schedule.special, { date: '', closed: true, values: [] }],
    }));
  }

  protected removeSpecial(index: number): void {
    this.change((schedule) => ({
      ...schedule,
      special: schedule.special.filter((_, at) => at !== index),
    }));
  }

  protected addSpecialSlot(index: number): void {
    this.changeSpecial(index, (day) => ({ ...day, values: [...day.values, emptySlot()] }));
  }

  protected removeSpecialSlot(index: number, slot: number): void {
    this.changeSpecial(index, (day) => ({
      ...day,
      values: day.values.filter((_, at) => at !== slot),
    }));
  }

  private changeSpecial(index: number, change: (day: SpecialDayModel) => SpecialDayModel): void {
    this.change((schedule) => ({
      ...schedule,
      special: schedule.special.map((day, at) => (at === index ? change(day) : day)),
    }));
  }

  private change(change: (schedule: ScheduleModel) => ScheduleModel): void {
    this.state.edit('openingHours', (hours) =>
      this.which() === 'openingHours'
        ? { ...hours, ...change(hours) }
        : { ...hours, deliveryTime: change(hours.deliveryTime) },
    );
  }
}

function emptySlot(): SlotModel {
  return { start: '', end: '' };
}
