import { Component, computed, inject } from '@angular/core';
import { I18nService } from '../../../core/i18n/i18n.service';
import { TableColumn } from '../../../shared/ui/data-table/data-table.types';
import { GroupSettingsState } from '../group-settings-state';
import { CatalogManager } from './catalog-manager';
import { MAX_WAREHOUSE_RULES, WarehouseRule } from './catalog.types';
import { WarehouseRuleEditor } from './warehouse-rule-editor';

/** Warehouse rules of the group (`/groups/:groupId/settings/warehouse-rules`); the standard ones are read-only. */
@Component({
  selector: 'fc-warehouse-rules-page',
  imports: [CatalogManager, WarehouseRuleEditor],
  template: `<fc-catalog-manager
    kind="WAREHOUSE_RULES"
    segment="warehouse-rules"
    [groupId]="state.groupId()!"
    [columns]="columns()"
    [idOf]="idOf"
    [nameOf]="nameOf"
    [canWrite]="state.canUpdate()"
    [limit]="max"
    [locked]="isStandard"
  >
    <ng-template
      #editor
      let-item
      let-error="error"
      let-busy="busy"
      let-save="save"
      let-cancel="cancel"
    >
      <fc-warehouse-rule-editor
        [item]="item"
        [error]="error"
        [busy]="busy"
        (save)="save($event)"
        (cancelled)="cancel()"
      />
    </ng-template>
  </fc-catalog-manager>`,
})
export class WarehouseRulesPage {
  protected readonly state = inject(GroupSettingsState);
  private readonly i18n = inject(I18nService);

  protected readonly max = MAX_WAREHOUSE_RULES;
  protected readonly idOf = (row: WarehouseRule): string => row.id;
  protected readonly nameOf = (row: WarehouseRule): string => row.name;
  protected readonly isStandard = (row: WarehouseRule): boolean => row.isDefault;
  protected readonly columns = computed<TableColumn<WarehouseRule>[]>(() => [
    {
      key: 'name',
      header: this.i18n.t('CATALOG.WAREHOUSE_RULES.COLUMN.NAME'),
      cell: (r) => r.name,
    },
    {
      key: 'type',
      header: this.i18n.t('CATALOG.WAREHOUSE_RULES.COLUMN.TYPE'),
      cell: (r) =>
        r.type === null ? '' : this.i18n.t(`CATALOG.WAREHOUSE_RULES.TYPE.${r.type.toUpperCase()}`),
    },
    {
      key: 'counterpart',
      header: this.i18n.t('CATALOG.WAREHOUSE_RULES.COLUMN.COUNTERPART'),
      hideNarrow: true,
      cell: (r) =>
        r.counterpart === null
          ? ''
          : this.i18n.t(`CATALOG.WAREHOUSE_RULES.COUNTERPART.${r.counterpart.toUpperCase()}`),
    },
    {
      key: 'cash',
      header: this.i18n.t('CATALOG.WAREHOUSE_RULES.COLUMN.CASH'),
      hideNarrow: true,
      cell: (r) =>
        r.cashLoad
          ? this.i18n.t('CATALOG.WAREHOUSE_RULES.CASH_LOAD')
          : r.cashUnload
            ? this.i18n.t('CATALOG.WAREHOUSE_RULES.CASH_UNLOAD')
            : '',
    },
    {
      key: 'isDefault',
      header: this.i18n.t('CATALOG.WAREHOUSE_RULES.COLUMN.ORIGIN'),
      cell: (r) =>
        this.i18n.t(
          r.isDefault ? 'CATALOG.WAREHOUSE_RULES.STANDARD' : 'CATALOG.WAREHOUSE_RULES.CUSTOM',
        ),
    },
  ]);
}
