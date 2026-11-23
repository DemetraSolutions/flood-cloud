import {
  booleanAttribute,
  Component,
  effect,
  ElementRef,
  inject,
  input,
  model,
  untracked,
} from '@angular/core';
import { issueMessageKey } from '../../core/api/field-issues';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { ReferenceItem } from '../../core/reference/reference-api';
import { Button } from '../../shared/ui/button/button';
import { Checkbox } from '../../shared/ui/checkbox/checkbox';
import { Select, SelectOption } from '../../shared/ui/select/select';
import { TextField } from '../../shared/ui/text-field/text-field';
import { uniqueId } from '../../shared/ui/unique-id';
import { numberIssue } from '../groups/catalogs/catalog-fields';
import { withCurrent } from '../companies/company-options';
import { PlaceRow } from './category-model';
import { PlaceSetupReader } from './category-place-setup';
import { CATEGORY_LIMITS } from './category.types';

/**
 * The stores a category is available in: a row for each store with a checkbox and, for the chosen
 * ones, the position of the category in the store and the production center of the store (read
 * when the store is chosen). No store chosen means every store. It implements the Signal Forms
 * value control contract (`value`, `disabled`), so it binds to the `PlaceRow[]` of the form model;
 * the chosen stores that are not listed (outside the perimeter of the user) are kept.
 */
@Component({
  selector: 'fc-category-availability',
  imports: [Button, Checkbox, Select, TextField, TPipe],
  templateUrl: './category-availability.html',
  styleUrl: './category-availability.css',
})
export class CategoryAvailability {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly reader = inject(PlaceSetupReader);
  private readonly i18n = inject(I18nService);

  /** Group of the stores. */
  readonly groupId = input.required<string>();
  /** The stores to choose from. */
  readonly places = input.required<readonly ReferenceItem[]>();
  /** The chosen stores with their position and production center (two-way). */
  readonly value = model<PlaceRow[]>([]);
  /** Error message; empty or null when valid. */
  readonly error = input<string | null>(null);
  /** Disables every control. */
  readonly disabled = input(false, { transform: booleanAttribute });

  protected readonly id = uniqueId('fc-category-availability');
  protected readonly errorId = `${this.id}-error`;
  protected readonly states = this.reader.states;

  constructor() {
    // The production centers of a chosen store are read once.
    effect(() => {
      const groupId = this.groupId();
      const rows = this.value();
      untracked(() => rows.forEach((row) => this.reader.load(groupId, row.placeId)));
    });
  }

  /** Focuses the first checkbox (used by Signal Forms to focus an invalid field). */
  focus(): void {
    this.host.nativeElement.querySelector<HTMLInputElement>('input')?.focus();
  }

  protected rowOf(placeId: string): PlaceRow | undefined {
    return this.value().find((row) => row.placeId === placeId);
  }

  protected choose(placeId: string, on: boolean): void {
    this.value.update((rows) =>
      on
        ? [...rows, { placeId, position: '', productionCenterId: '' }]
        : rows.filter((row) => row.placeId !== placeId),
    );
  }

  protected change(placeId: string, change: Partial<PlaceRow>): void {
    this.value.update((rows) =>
      rows.map((row) => (row.placeId === placeId ? { ...row, ...change } : row)),
    );
  }

  /** The message of a position that is not a whole number from 0 to 1,000,000, `null` when it is fine. */
  protected positionError(row: PlaceRow): string | null {
    const issue = numberIssue(row.position, {
      min: 0,
      max: CATEGORY_LIMITS.number,
      integer: true,
      optional: true,
    });
    return issue === undefined ? null : this.i18n.t(issueMessageKey(issue));
  }

  /** The production centers a store offers; the one the row holds stays available even when it cannot be read. */
  protected centers(row: PlaceRow): SelectOption[] {
    const state = this.states().get(row.placeId);
    const options =
      state?.status === 'ready'
        ? state.setup.centers.map((center) => ({ value: center.id, label: center.name }))
        : [];
    return withCurrent(options, row.productionCenterId, (value) => value);
  }

  protected failed(row: PlaceRow): boolean {
    return this.states().get(row.placeId)?.status === 'error';
  }

  protected retry(placeId: string): void {
    this.reader.load(this.groupId(), placeId);
  }
}
