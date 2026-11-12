import { Component, computed, inject } from '@angular/core';
import { I18nService } from '../../../core/i18n/i18n.service';
import { TableColumn } from '../../../shared/ui/data-table/data-table.types';
import { GroupSettingsState } from '../group-settings-state';
import { CatalogManager } from './catalog-manager';
import { MAX_TAXES, Tax } from './catalog.types';
import { TaxEditor } from './tax-editor';

/** Tax rates of the group (`/groups/:groupId/settings/taxes`). */
@Component({
  selector: 'fc-taxes-page',
  imports: [CatalogManager, TaxEditor],
  template: `<fc-catalog-manager
    kind="TAXES"
    segment="taxes"
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
      <fc-tax-editor
        [item]="item"
        [error]="error"
        [busy]="busy"
        (save)="save($event)"
        (cancelled)="cancel()"
      />
    </ng-template>
  </fc-catalog-manager>`,
})
export class TaxesPage {
  protected readonly state = inject(GroupSettingsState);
  private readonly i18n = inject(I18nService);

  protected readonly max = MAX_TAXES;
  protected readonly idOf = (row: Tax): string => row.id;
  protected readonly nameOf = (row: Tax): string => `${row.rate}%`;
  protected readonly columns = computed<TableColumn<Tax>[]>(() => [
    {
      key: 'rate',
      header: this.i18n.t('CATALOG.TAXES.COLUMN.RATE'),
      align: 'end',
      cell: (r) => `${r.rate}%`,
    },
    {
      key: 'department',
      header: this.i18n.t('CATALOG.TAXES.COLUMN.DEPARTMENT'),
      hideNarrow: true,
      cell: (r) => (r.department === null ? '' : String(r.department)),
    },
    {
      key: 'vatNature',
      header: this.i18n.t('CATALOG.TAXES.COLUMN.VAT_NATURE'),
      hideNarrow: true,
      cell: (r) => r.vatNature ?? '',
    },
    {
      key: 'description',
      header: this.i18n.t('CATALOG.TAXES.COLUMN.DESCRIPTION'),
      cell: (r) => r.description ?? '',
    },
  ]);
}
