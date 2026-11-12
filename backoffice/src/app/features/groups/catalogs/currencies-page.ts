import { Component, computed, inject } from '@angular/core';
import { I18nService } from '../../../core/i18n/i18n.service';
import { TableColumn } from '../../../shared/ui/data-table/data-table.types';
import { GroupSettingsState } from '../group-settings-state';
import { CatalogManager } from './catalog-manager';
import { Currency, MAX_CURRENCIES } from './catalog.types';
import { CurrencyEditor } from './currency-editor';

/** Currencies of the group (`/groups/:groupId/settings/currencies`); the code identifies each one. */
@Component({
  selector: 'fc-currencies-page',
  imports: [CatalogManager, CurrencyEditor],
  template: `<fc-catalog-manager
    kind="CURRENCIES"
    segment="currencies"
    [groupId]="state.groupId()!"
    [columns]="columns()"
    [idOf]="idOf"
    [nameOf]="nameOf"
    [canWrite]="state.canUpdate()"
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
      <fc-currency-editor
        [item]="item"
        [error]="error"
        [busy]="busy"
        (save)="save($event)"
        (cancelled)="cancel()"
      />
    </ng-template>
  </fc-catalog-manager>`,
})
export class CurrenciesPage {
  protected readonly state = inject(GroupSettingsState);
  private readonly i18n = inject(I18nService);

  protected readonly max = MAX_CURRENCIES;
  protected readonly idOf = (row: Currency): string => row.code;
  protected readonly nameOf = (row: Currency): string => row.code;
  protected readonly columns = computed<TableColumn<Currency>[]>(() => [
    { key: 'code', header: this.i18n.t('CATALOG.CURRENCIES.COLUMN.CODE'), cell: (r) => r.code },
    {
      key: 'symbol',
      header: this.i18n.t('CATALOG.CURRENCIES.COLUMN.SYMBOL'),
      cell: (r) => r.symbol,
    },
  ]);
}
