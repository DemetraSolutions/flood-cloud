import { Component, computed, inject } from '@angular/core';
import { I18nService } from '../../../core/i18n/i18n.service';
import { TableColumn } from '../../../shared/ui/data-table/data-table.types';
import { GroupSettingsState } from '../group-settings-state';
import { CatalogManager } from './catalog-manager';
import { PriceList, MAX_PRICE_LISTS } from './catalog.types';
import { PriceListEditor } from './price-list-editor';

/** Price lists of the group (`/groups/:groupId/settings/price-lists`). Exactly one is the standard one. */
@Component({
  selector: 'fc-price-lists-page',
  imports: [CatalogManager, PriceListEditor],
  template: `<fc-catalog-manager
    kind="PRICE_LISTS"
    segment="price-lists"
    [groupId]="state.groupId()!"
    [columns]="columns()"
    [idOf]="idOf"
    [nameOf]="nameOf"
    [canWrite]="state.canUpdate()"
    [limit]="max"
    [kept]="isDefault"
  >
    <ng-template
      #editor
      let-item
      let-error="error"
      let-busy="busy"
      let-save="save"
      let-cancel="cancel"
    >
      <fc-price-list-editor
        [item]="item"
        [error]="error"
        [busy]="busy"
        (save)="save($event)"
        (cancelled)="cancel()"
      />
    </ng-template>
  </fc-catalog-manager>`,
})
export class PriceListsPage {
  protected readonly state = inject(GroupSettingsState);
  private readonly i18n = inject(I18nService);

  protected readonly max = MAX_PRICE_LISTS;
  protected readonly idOf = (row: PriceList): string => row.id;
  protected readonly nameOf = (row: PriceList): string => row.name;
  protected readonly isDefault = (row: PriceList): boolean => row.isDefault;
  protected readonly columns = computed<TableColumn<PriceList>[]>(() => [
    { key: 'name', header: this.i18n.t('CATALOG.PRICE_LISTS.COLUMN.NAME'), cell: (r) => r.name },
    {
      key: 'enabled',
      header: this.i18n.t('CATALOG.PRICE_LISTS.COLUMN.ENABLED'),
      cell: (r) => this.i18n.t(r.enabled ? 'CATALOG.YES' : 'CATALOG.NO'),
    },
    {
      key: 'isDefault',
      header: this.i18n.t('CATALOG.PRICE_LISTS.COLUMN.DEFAULT'),
      cell: (r) => (r.isDefault ? this.i18n.t('CATALOG.PRICE_LISTS.DEFAULT') : ''),
    },
  ]);
}
