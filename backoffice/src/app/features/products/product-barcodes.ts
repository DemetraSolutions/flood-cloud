import { booleanAttribute, Component, computed, ElementRef, inject, input, model } from '@angular/core';
import { issueMessageKey } from '../../core/api/field-issues';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { Button } from '../../shared/ui/button/button';
import { TextField } from '../../shared/ui/text-field/text-field';
import { uniqueId } from '../../shared/ui/unique-id';
import { BarcodeRow, barcodeIssues } from './product-model';
import { ProductWarningNote } from './product-warning-note';
import { PRODUCT_LIMITS, ProductWarning } from './product.types';

/** The barcode a scanner sends has a leading `@` that is not part of the code. */
export function stripScannerPrefix(text: string): string {
  return text.startsWith('@') ? text.slice(1) : text;
}

/**
 * The barcodes of a product: a row for each with its value, how many pieces a reading loads (with
 * `warehouse`, where the pieces it unloads are shown read only: the load ones times the conversion
 * ratio) and sells, "add" and "remove". A value other products use too gets a warning, never an
 * error. It implements the Signal Forms value control contract (`value`, `disabled`), so it binds
 * to the `BarcodeRow[]` of the form model.
 */
@Component({
  selector: 'fc-product-barcodes',
  imports: [Button, ProductWarningNote, TextField, TPipe],
  templateUrl: './product-barcodes.html',
  styleUrl: './product-section.css',
})
export class ProductBarcodes {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly i18n = inject(I18nService);

  readonly groupId = input.required<string>();
  /** The rows (two-way). */
  readonly value = model<BarcodeRow[]>([]);
  /** The group has `warehouse`: the quantity a reading loads is part of the barcode. */
  readonly warehouse = input(false);
  /** Conversion ratio of the units of the product, `null` when it is not a number. */
  readonly ratio = input<number | null>(null);
  /** The duplicates the server reported (`barcodes.<index>`). */
  readonly warnings = input<readonly ProductWarning[]>([]);
  readonly error = input<string | null>(null);
  readonly disabled = input(false, { transform: booleanAttribute });

  protected readonly id = uniqueId('fc-product-barcodes');
  protected readonly errorId = `${this.id}-error`;
  protected readonly limit = PRODUCT_LIMITS.barcodes;
  protected readonly strip = stripScannerPrefix;
  protected readonly rows = computed(() =>
    this.value().map((row, index) => ({
      row,
      index,
      issues: barcodeIssues(row),
      unload: this.unloaded(row),
      warning: this.warnings().find((warning) => warning.field === `barcodes.${index}`),
    })),
  );

  /** Focuses the first field (used by Signal Forms to focus an invalid field). */
  focus(): void {
    this.host.nativeElement.querySelector<HTMLInputElement>('input')?.focus();
  }

  protected message(issue: string | undefined): string | null {
    return issue === undefined ? null : this.i18n.t(issueMessageKey(issue));
  }

  protected add(): void {
    this.value.update((rows) => [...rows, { value: '', loadQuantity: '', saleQuantity: '' }]);
  }

  protected remove(index: number): void {
    this.value.update((rows) => rows.filter((_, position) => position !== index));
  }

  protected change(index: number, change: Partial<BarcodeRow>): void {
    this.value.update((rows) => rows.map((row, position) => (position === index ? { ...row, ...change } : row)));
  }

  /** The pieces a reading unloads: the ones it loads times the conversion ratio, `''` when either is missing. */
  private unloaded(row: BarcodeRow): string {
    const load = row.loadQuantity.trim() === '' ? Number.NaN : Number(row.loadQuantity);
    const ratio = this.ratio();
    return Number.isFinite(load) && ratio !== null ? String(Number((load * ratio).toFixed(6))) : '';
  }
}
