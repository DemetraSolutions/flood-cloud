import { Component, inject, input, output } from '@angular/core';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { Button } from '../../shared/ui/button/button';
import { ProductBlock } from './product-errors';

/**
 * The panel that says what refers to a product the server refused to delete, kind by kind: the
 * names of the products (menus, bills of materials, modifiers), of the categories and what the
 * user cannot see (a note). The text of a kind is `PRODUCTS.REFERENCE.<kind>`.
 */
@Component({
  selector: 'fc-product-reference-block',
  imports: [Button, TPipe],
  templateUrl: './product-reference-block.html',
  styleUrl: './product-reference-block.css',
})
export class ProductReferenceBlock {
  protected readonly i18n = inject(I18nService);

  /** The refused deletion. */
  readonly block = input.required<ProductBlock>();
  /** The user dismissed the panel. */
  readonly closed = output<void>();

  protected kindLabel(kind: string): string {
    return this.i18n.t(`PRODUCTS.REFERENCE.${kind}`);
  }
}
