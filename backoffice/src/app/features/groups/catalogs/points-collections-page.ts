import { Component, computed, inject, input } from '@angular/core';
import { I18nService } from '../../../core/i18n/i18n.service';
import { SessionService } from '../../../core/session/session.service';
import { TableColumn } from '../../../shared/ui/data-table/data-table.types';
import { CatalogManager } from './catalog-manager';
import { validityText } from './catalog-fields';
import { MAX_POINTS_COLLECTIONS, PointsCollection } from './catalog.types';
import { PointsCollectionEditor } from './points-collection-editor';

/** Points collections of the group (`/groups/:groupId/fidelity/points-collections`, `fidelity:*`). */
@Component({
  selector: 'fc-points-collections-page',
  imports: [CatalogManager, PointsCollectionEditor],
  template: `<fc-catalog-manager
    kind="POINTS_COLLECTIONS"
    segment="fidelity/points-collections"
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
      <fc-points-collection-editor
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
export class PointsCollectionsPage {
  private readonly i18n = inject(I18nService);
  private readonly session = inject(SessionService);

  /** Route parameter. */
  readonly groupId = input.required<string>();

  protected readonly canWrite = computed(() => this.session.can('fidelity:update'));
  protected readonly max = MAX_POINTS_COLLECTIONS;
  protected readonly idOf = (row: PointsCollection): string => row.id;
  protected readonly nameOf = (row: PointsCollection): string => row.name;
  protected readonly columns = computed<TableColumn<PointsCollection>[]>(() => [
    {
      key: 'name',
      header: this.i18n.t('CATALOG.POINTS_COLLECTIONS.COLUMN.NAME'),
      cell: (r) => r.name,
    },
    {
      key: 'enabled',
      header: this.i18n.t('CATALOG.POINTS_COLLECTIONS.COLUMN.ENABLED'),
      cell: (r) => this.i18n.t(r.enabled ? 'CATALOG.YES' : 'CATALOG.NO'),
    },
    {
      key: 'conversion',
      header: this.i18n.t('CATALOG.POINTS_COLLECTIONS.COLUMN.CONVERSION'),
      align: 'end',
      hideNarrow: true,
      cell: (r) => (r.pointConversion === null ? '' : String(r.pointConversion)),
    },
    {
      key: 'validity',
      header: this.i18n.t('CATALOG.POINTS_COLLECTIONS.COLUMN.VALIDITY'),
      cell: (r) => validityText(this.i18n, r.dateFrom, r.dateTo),
    },
  ]);
}
