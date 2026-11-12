import { Component, computed, inject, input } from '@angular/core';
import { FieldTree, FormField } from '@angular/forms/signals';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { MAX_SHIFT_SLOTS, ShiftSlot } from '../../core/users/shift-time';
import { fieldErrorMessage } from '../../shared/forms/form-errors';
import { Button } from '../../shared/ui/button/button';
import { TextField } from '../../shared/ui/text-field/text-field';

/**
 * Time ranges (`HH:mm`) of one day: a list of start and end fields with add and remove buttons
 * (at most 10, as the backend allows). It edits the field tree it is given, in place.
 */
@Component({
  selector: 'fc-shift-slots',
  imports: [Button, FormField, TextField, TPipe],
  templateUrl: './shift-slots.html',
  styleUrl: './shift-slots.css',
})
export class ShiftSlots {
  private readonly i18n = inject(I18nService);

  /** The slots field tree. */
  readonly slots = input.required<FieldTree<ShiftSlot[]>>();
  /** Accessible name of the day or special day the slots belong to (already translated). */
  readonly dayLabel = input.required<string>();

  protected readonly full = computed(() => this.slots()().value().length >= MAX_SHIFT_SLOTS);
  protected readonly editable = computed(() => !this.slots()().disabled());

  protected add(): void {
    this.slots()().value.update((slots) => [...slots, { start: '', end: '' }]);
  }

  protected remove(index: number): void {
    this.slots()().value.update((slots) => slots.filter((_, position) => position !== index));
  }

  protected label(part: 'START' | 'END', index: number): string {
    return this.i18n.t(`USERS.SHIFTS.SLOT_${part}`, { day: this.dayLabel(), n: index + 1 });
  }

  protected error(field: FieldTree<unknown>): string | null {
    return fieldErrorMessage(this.i18n, field());
  }
}
