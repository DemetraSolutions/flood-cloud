import { Component, computed, inject } from '@angular/core';
import { I18nService } from '../../../core/i18n/i18n.service';
import { TableColumn } from '../../../shared/ui/data-table/data-table.types';
import { GroupSettingsState } from '../group-settings-state';
import { CatalogManager } from './catalog-manager';
import { MAX_MEASURE_UNITS, MeasureUnit } from './catalog.types';
import { MeasureUnitEditor } from './measure-unit-editor';

/** Units of measure of the group (`/groups/:groupId/settings/measure-units`). */
@Component({
  selector: 'fc-measure-units-page',
  imports: [CatalogManager, MeasureUnitEditor],
  template: `<fc-catalog-manager
    kind="MEASURE_UNITS"
    segment="measure-units"
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
      <fc-measure-unit-editor
        [item]="item"
        [error]="error"
        [busy]="busy"
        (save)="save($event)"
        (cancelled)="cancel()"
      />
    </ng-template>
  </fc-catalog-manager>`,
})
export class MeasureUnitsPage {
  protected readonly state = inject(GroupSettingsState);
  private readonly i18n = inject(I18nService);

  protected readonly max = MAX_MEASURE_UNITS;
  protected readonly idOf = (row: MeasureUnit): string => row.id;
  protected readonly nameOf = (row: MeasureUnit): string => row.value;
  protected readonly columns = computed<TableColumn<MeasureUnit>[]>(() => [
    {
      key: 'value',
      header: this.i18n.t('CATALOG.MEASURE_UNITS.COLUMN.VALUE'),
      cell: (r) => r.value,
    },
  ]);
}
