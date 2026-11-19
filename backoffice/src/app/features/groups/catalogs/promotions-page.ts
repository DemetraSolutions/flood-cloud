import { Component, computed, inject, input } from '@angular/core';
import { I18nService } from '../../../core/i18n/i18n.service';
import { SessionService } from '../../../core/session/session.service';
import { TableColumn } from '../../../shared/ui/data-table/data-table.types';
import { CatalogManager } from './catalog-manager';
import { MAX_PROMOTIONS, Promotion } from './catalog.types';
import { placesCell, validityText } from './catalog-fields';
import { PlacePerimeter } from './place-perimeter';
import { PromotionEditor } from './promotion-editor';

/**
 * Promotions of the group (`/groups/:groupId/promotions`, permissions `products:read` and
 * `products:update`). Company and store administrators see read-only the promotions that apply
 * outside their stores or to the whole group.
 */
@Component({
  selector: 'fc-promotions-page',
  imports: [CatalogManager, PromotionEditor],
  providers: [PlacePerimeter],
  template: `<fc-catalog-manager
    kind="PROMOTIONS"
    segment="promotions"
    [groupId]="groupId()"
    [columns]="columns()"
    [idOf]="idOf"
    [nameOf]="nameOf"
    [canWrite]="canWrite()"
    [limit]="max"
    [locked]="outOfPerimeter"
    [viewable]="true"
    lockedNote="CATALOG.PROMOTIONS.LOCKED_NOTE"
    [wide]="true"
  >
    <ng-template
      #editor
      let-item
      let-error="error"
      let-busy="busy"
      let-readonly="readonly"
      let-save="save"
      let-cancel="cancel"
    >
      <fc-promotion-editor
        [groupId]="groupId()"
        [item]="item"
        [error]="error"
        [busy]="busy"
        [readOnly]="readonly"
        (save)="save($event)"
        (cancelled)="cancel()"
      />
    </ng-template>
  </fc-catalog-manager>`,
})
export class PromotionsPage {
  private readonly i18n = inject(I18nService);
  private readonly perimeter = inject(PlacePerimeter);
  private readonly session = inject(SessionService);

  /** Route parameter. */
  readonly groupId = input.required<string>();

  constructor() {
    this.perimeter.attach(this.groupId);
  }

  protected readonly canWrite = computed(() => this.session.can('products:update'));
  protected readonly max = MAX_PROMOTIONS;
  protected readonly idOf = (row: Promotion): string => row.id;
  protected readonly nameOf = (row: Promotion): string => row.name;
  protected readonly outOfPerimeter = (row: Promotion): boolean =>
    !this.perimeter.covers(row.conditions.placeIds);
  protected readonly columns = computed<TableColumn<Promotion>[]>(() => [
    { key: 'name', header: this.i18n.t('CATALOG.PROMOTIONS.COLUMN.NAME'), cell: (r) => r.name },
    {
      key: 'code',
      header: this.i18n.t('CATALOG.PROMOTIONS.COLUMN.CODE'),
      hideNarrow: true,
      cell: (r) => r.code ?? '',
    },
    {
      key: 'enabled',
      header: this.i18n.t('CATALOG.PROMOTIONS.COLUMN.ENABLED'),
      cell: (r) => this.i18n.t(r.enabled ? 'CATALOG.YES' : 'CATALOG.NO'),
    },
    {
      key: 'validity',
      header: this.i18n.t('CATALOG.PROMOTIONS.COLUMN.VALIDITY'),
      hideNarrow: true,
      cell: (r) => validityText(this.i18n, r.conditions.startDate, r.conditions.endDate),
    },
    {
      key: 'places',
      header: this.i18n.t('CATALOG.PROMOTIONS.COLUMN.PLACES'),
      cell: (r) => placesCell(this.i18n, r.conditions.placeIds, this.outOfPerimeter(r)),
    },
  ]);
}
