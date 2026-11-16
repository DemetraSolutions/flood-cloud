import { Component, computed, inject, input, output } from '@angular/core';
import { FieldTree, FormField } from '@angular/forms/signals';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { Button } from '../../shared/ui/button/button';
import { Checkbox } from '../../shared/ui/checkbox/checkbox';
import { Select, SelectOption } from '../../shared/ui/select/select';
import { TextField, TextFieldType } from '../../shared/ui/text-field/text-field';
import { withCurrent } from '../companies/company-options';
import { WEEK_DAYS } from './place-model';
import { PlaceState } from './place-state';

/** One column of a list of rows. */
export interface RowColumn {
  /** Name of the property of the row. */
  readonly key: string;
  readonly type: 'text' | 'number' | 'time' | 'flag' | 'select' | 'days';
  /** Label of the control (already translated). */
  readonly label: string;
  /** The options of a `select`. */
  readonly options?: readonly SelectOption[];
}

type RowTree = Record<string, FieldTree<unknown>>;

/**
 * A list of rows the user adds to, edits and removes from (payment types, tips, time blocks,
 * delivery costs, categories…): one control per column, a remove button per row and an add
 * button that stops at the limit of the API. The rows are the fields of a list of the form of
 * the {@link PlaceState}; adding and removing is up to the page, which changes its model.
 */
@Component({
  selector: 'fc-rows-editor',
  imports: [Button, Checkbox, FormField, Select, TextField, TPipe],
  templateUrl: './rows-editor.html',
  styleUrl: './place-section.css',
})
export class RowsEditor {
  protected readonly state = inject(PlaceState);
  private readonly i18n = inject(I18nService);

  /** The list in the form. */
  readonly rows = input.required<FieldTree<unknown>>();
  readonly columns = input.required<readonly RowColumn[]>();
  /** Title of the group (already translated). */
  readonly legend = input.required<string>();
  /** Label of the add button (already translated). */
  readonly addLabel = input.required<string>();
  /** Most rows the list can have. */
  readonly max = input.required<number>();
  /** Emitted when the user adds a row. */
  readonly add = output<void>();
  /** Emitted with the index of the row the user removes. */
  readonly remove = output<number>();

  protected readonly days = WEEK_DAYS;
  protected readonly items = computed(() => [...(this.rows() as unknown as Iterable<RowTree>)]);

  protected flagCell(row: RowTree, column: RowColumn): FieldTree<boolean> {
    return row[column.key] as FieldTree<boolean>;
  }

  protected textCell(row: RowTree, column: RowColumn): FieldTree<string> {
    return row[column.key] as FieldTree<string>;
  }

  protected daysCell(row: RowTree, column: RowColumn): FieldTree<number[]> {
    return row[column.key] as FieldTree<number[]>;
  }

  protected textType(column: RowColumn): TextFieldType {
    return column.type === 'number' || column.type === 'time' ? column.type : 'text';
  }

  protected label(column: RowColumn, index: number): string {
    return `${column.label} ${index + 1}`;
  }

  protected removeLabel(index: number): string {
    return this.i18n.t('PLACES.REMOVE_ROW', { legend: this.legend(), number: index + 1 });
  }

  protected optionsOf(column: RowColumn, row: RowTree): SelectOption[] {
    return withCurrent(
      column.options ?? [],
      this.textCell(row, column)().value(),
      (value) => value,
    );
  }

  protected dayLabel(day: string): string {
    return this.i18n.t(`PLACES.DAY.${day}`);
  }

  protected hasDay(row: RowTree, column: RowColumn, day: string): boolean {
    return this.daysCell(row, column)().value().includes(Number(day));
  }

  protected toggleDay(row: RowTree, column: RowColumn, day: string, on: boolean): void {
    const value = Number(day);
    this.daysCell(row, column)().value.update((days) =>
      on
        ? [...days.filter((current) => current !== value), value].sort((a, b) => a - b)
        : days.filter((current) => current !== value),
    );
  }
}
