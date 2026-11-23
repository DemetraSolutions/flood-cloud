import { Component, computed, inject, input } from '@angular/core';
import { FieldTree, FormField, ReadonlyFieldTree } from '@angular/forms/signals';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { ReferenceApi } from '../../core/reference/reference-api';
import { fieldErrorMessage } from '../../shared/forms/form-errors';
import { selectionNames } from '../groups/catalogs/reference-loaders';
import { CategoryCheckList } from '../product-categories/category-check-list';
import { FlatNode } from '../product-categories/category.types';
import { ReferenceLoader, ReferencePicker } from '../users/reference-picker';
import { CoreModel } from './product-model';

/**
 * The variants tab of a product: the modifiers a sale requires, the ones it proposes and the ones
 * it excludes (the ones its categories bring), each chosen among the modifier products with a
 * search the server runs, and the categories of modifiers it offers. The names of the chosen
 * modifiers are read once, for the three lists together.
 */
@Component({
  selector: 'fc-product-variants',
  imports: [CategoryCheckList, FormField, ReferencePicker, TPipe],
  templateUrl: './product-variants.html',
  styleUrl: './product-section.css',
})
export class ProductVariants {
  private readonly reference = inject(ReferenceApi);
  private readonly i18n = inject(I18nService);

  readonly form = input.required<FieldTree<CoreModel>>();
  readonly groupId = input.required<string>();
  /** The categories of the tree, in reading order. */
  readonly entries = input.required<readonly FlatNode[]>();
  /** The names of the chosen modifier products are decoration: the ids of the three lists. */
  readonly chosenIds = input.required<readonly string[]>();

  protected readonly loader = computed<ReferenceLoader>(() => {
    const groupId = this.groupId();
    return (query) => this.reference.lookup(groupId, 'products', { ...query, modifier: true });
  });
  protected readonly labels = selectionNames(
    () => this.chosenIds(),
    (ids) => this.reference.lookupNames(this.groupId(), 'products', ids, true),
  );

  protected error(field: ReadonlyFieldTree<unknown>): string | null {
    return fieldErrorMessage(this.i18n, field());
  }
}
