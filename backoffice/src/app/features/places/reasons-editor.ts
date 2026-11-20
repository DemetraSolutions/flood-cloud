import { Component, computed, inject, input, output } from '@angular/core';
import { FieldTree, FormField } from '@angular/forms/signals';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { Button } from '../../shared/ui/button/button';
import { TextField } from '../../shared/ui/text-field/text-field';
import { PlaceState } from './place-state';

/**
 * A list of short texts (the reasons of a discount or of a deletion): one text field per reason,
 * a remove button per reason and an add button that stops at the limit of the API. The reasons are
 * the fields of a list of strings of the form of the {@link PlaceState}; adding and removing is up
 * to the page, which changes its model. It replaces the legacy single input with `;`-separated
 * entries, so that each reason has its own label and its own error.
 */
@Component({
  selector: 'fc-reasons-editor',
  imports: [Button, FormField, TextField, TPipe],
  templateUrl: './reasons-editor.html',
  styleUrl: './place-section.css',
})
export class ReasonsEditor {
  protected readonly state = inject(PlaceState);
  private readonly i18n = inject(I18nService);

  /** The list in the form. */
  readonly reasons = input.required<FieldTree<string[]>>();
  /** Title of the group (already translated). */
  readonly legend = input.required<string>();
  /** Label of the add button (already translated). */
  readonly addLabel = input.required<string>();
  /** Most reasons the list can have. */
  readonly max = input.required<number>();
  /** Emitted when the user adds a reason. */
  readonly add = output<void>();
  /** Emitted with the index of the reason the user removes. */
  readonly remove = output<number>();

  protected readonly items = computed(() => [
    ...(this.reasons() as unknown as Iterable<FieldTree<string>>),
  ]);

  protected label(index: number): string {
    return this.i18n.t('PLACES.REASON_NUMBER', { legend: this.legend(), number: index + 1 });
  }

  protected removeLabel(index: number): string {
    return this.i18n.t('PLACES.REMOVE_ROW', { legend: this.legend(), number: index + 1 });
  }
}
