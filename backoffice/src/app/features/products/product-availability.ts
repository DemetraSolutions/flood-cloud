import { booleanAttribute, Component, effect, ElementRef, inject, input, model, untracked } from '@angular/core';
import { issueMessageKey } from '../../core/api/field-issues';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { ReferenceItem } from '../../core/reference/reference-api';
import { Button } from '../../shared/ui/button/button';
import { Checkbox } from '../../shared/ui/checkbox/checkbox';
import { Select, SelectOption } from '../../shared/ui/select/select';
import { TextField } from '../../shared/ui/text-field/text-field';
import { uniqueId } from '../../shared/ui/unique-id';
import { withCurrent } from '../companies/company-options';
import { PlaceSetupReader } from '../product-categories/category-place-setup';
import { placeIssues, ProductPlaceRow } from './product-model';

/**
 * The stores a product is available in: a row for each store with a checkbox and, for the chosen
 * ones, "favorite" (and, with `rooms`, "favorite on the handhelds"), the position of the product in
 * the store and the production center of the store (read when the store is chosen). No store chosen
 * means every store. It implements the Signal Forms value control contract (`value`, `disabled`),
 * so it binds to the `ProductPlaceRow[]` of the form model; the chosen stores that are not listed
 * (outside the perimeter of the user) are kept.
 */
@Component({
  selector: 'fc-product-availability',
  imports: [Button, Checkbox, Select, TextField, TPipe],
  templateUrl: './product-availability.html',
  styleUrl: './product-section.css',
})
export class ProductAvailability {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly reader = inject(PlaceSetupReader);
  private readonly i18n = inject(I18nService);

  /** Group of the stores. */
  readonly groupId = input.required<string>();
  /** The stores to choose from. */
  readonly places = input.required<readonly ReferenceItem[]>();
  /** The chosen stores with their data (two-way). */
  readonly value = model<ProductPlaceRow[]>([]);
  /** The group has `rooms`: the product can be a favorite of the handhelds. */
  readonly rooms = input(false);
  readonly error = input<string | null>(null);
  readonly disabled = input(false, { transform: booleanAttribute });

  protected readonly id = uniqueId('fc-product-availability');
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

  protected rowOf(placeId: string): ProductPlaceRow | undefined {
    return this.value().find((row) => row.placeId === placeId);
  }

  protected choose(placeId: string, on: boolean): void {
    this.value.update((rows) =>
      on
        ? [...rows, { placeId, favorite: false, favoriteHandheld: false, position: '', productionCenterId: '' }]
        : rows.filter((row) => row.placeId !== placeId),
    );
  }

  protected change(placeId: string, change: Partial<ProductPlaceRow>): void {
    this.value.update((rows) => rows.map((row) => (row.placeId === placeId ? { ...row, ...change } : row)));
  }

  /** The message of a position that is not a whole number from 0 to 1,000,000, `null` when it is fine. */
  protected positionError(row: ProductPlaceRow): string | null {
    const issue = placeIssues(row).position;
    return issue === undefined ? null : this.i18n.t(issueMessageKey(issue));
  }

  /** The production centers a store offers; the one the row holds stays available even when it cannot be read. */
  protected centers(row: ProductPlaceRow): SelectOption[] {
    const state = this.states().get(row.placeId);
    const options =
      state?.status === 'ready' ? state.setup.centers.map((center) => ({ value: center.id, label: center.name })) : [];
    return withCurrent(options, row.productionCenterId, (value) => value);
  }

  protected failed(row: ProductPlaceRow): boolean {
    return this.states().get(row.placeId)?.status === 'error';
  }

  protected retry(placeId: string): void {
    this.reader.load(this.groupId(), placeId);
  }
}
