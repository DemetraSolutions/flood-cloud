import { Component, computed, inject, input } from '@angular/core';
import { I18nService } from '../../../core/i18n/i18n.service';
import { SessionService } from '../../../core/session/session.service';
import { TableColumn } from '../../../shared/ui/data-table/data-table.types';
import { CatalogManager } from './catalog-manager';
import { MAX_PRODUCT_FAVORITES, ProductFavorites } from './catalog.types';
import { FavoritesEditor } from './favorites-editor';

/** Lists of favorite products of the group (`/groups/:groupId/product-favorites`, `products:*`). */
@Component({
  selector: 'fc-product-favorites-page',
  imports: [CatalogManager, FavoritesEditor],
  template: `<fc-catalog-manager
    kind="PRODUCT_FAVORITES"
    segment="product-favorites"
    [groupId]="groupId()"
    [columns]="columns()"
    [idOf]="idOf"
    [nameOf]="nameOf"
    [canWrite]="canWrite()"
    [limit]="max"
  >
    <ng-template
      #editor
      let-item
      let-error="error"
      let-busy="busy"
      let-save="save"
      let-cancel="cancel"
    >
      <fc-favorites-editor
        [groupId]="groupId()"
        [item]="item"
        [error]="error"
        [busy]="busy"
        (save)="save($event)"
        (cancelled)="cancel()"
      />
    </ng-template>
  </fc-catalog-manager>`,
})
export class ProductFavoritesPage {
  private readonly i18n = inject(I18nService);
  private readonly session = inject(SessionService);

  /** Route parameter. */
  readonly groupId = input.required<string>();

  protected readonly canWrite = computed(() => this.session.can('products:update'));
  protected readonly max = MAX_PRODUCT_FAVORITES;
  protected readonly idOf = (row: ProductFavorites): string => row.id;
  protected readonly nameOf = (row: ProductFavorites): string => row.name;
  protected readonly columns = computed<TableColumn<ProductFavorites>[]>(() => [
    {
      key: 'name',
      header: this.i18n.t('CATALOG.PRODUCT_FAVORITES.COLUMN.NAME'),
      cell: (r) => r.name,
    },
    {
      key: 'products',
      header: this.i18n.t('CATALOG.PRODUCT_FAVORITES.COLUMN.PRODUCTS'),
      align: 'end',
      cell: (r) => String(r.products.length),
    },
  ]);
}
