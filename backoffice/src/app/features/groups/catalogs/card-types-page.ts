import { Component, computed, inject, input } from '@angular/core';
import { I18nService } from '../../../core/i18n/i18n.service';
import { SessionService } from '../../../core/session/session.service';
import { TableColumn } from '../../../shared/ui/data-table/data-table.types';
import { placesCell } from './catalog-fields';
import { CardTypeEditor } from './card-type-editor';
import { CatalogManager } from './catalog-manager';
import { CardType, MAX_CARD_TYPES } from './catalog.types';
import { PlacePerimeter } from './place-perimeter';

/**
 * Loyalty-card types of the group (`/groups/:groupId/fidelity/card-types`, permissions
 * `fidelity:read` and `fidelity:update`). Company and store administrators see read-only the
 * types that are valid outside their stores or for the whole group.
 */
@Component({
  selector: 'fc-card-types-page',
  imports: [CardTypeEditor, CatalogManager],
  providers: [PlacePerimeter],
  template: `<fc-catalog-manager
    kind="CARD_TYPES"
    segment="fidelity/card-types"
    [groupId]="groupId()"
    [columns]="columns()"
    [idOf]="idOf"
    [nameOf]="nameOf"
    [canWrite]="canWrite()"
    [limit]="max"
    [locked]="outOfPerimeter"
    [viewable]="true"
    lockedNote="CATALOG.CARD_TYPES.LOCKED_NOTE"
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
      <fc-card-type-editor
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
export class CardTypesPage {
  private readonly i18n = inject(I18nService);
  private readonly perimeter = inject(PlacePerimeter);
  private readonly session = inject(SessionService);

  /** Route parameter. */
  readonly groupId = input.required<string>();

  constructor() {
    this.perimeter.attach(this.groupId);
  }

  protected readonly canWrite = computed(() => this.session.can('fidelity:update'));
  protected readonly max = MAX_CARD_TYPES;
  protected readonly idOf = (row: CardType): string => row.id;
  protected readonly nameOf = (row: CardType): string => row.name;
  protected readonly outOfPerimeter = (row: CardType): boolean =>
    !this.perimeter.covers(row.placeIds);
  protected readonly columns = computed<TableColumn<CardType>[]>(() => [
    { key: 'name', header: this.i18n.t('CATALOG.CARD_TYPES.COLUMN.NAME'), cell: (r) => r.name },
    {
      key: 'enabled',
      header: this.i18n.t('CATALOG.CARD_TYPES.COLUMN.ENABLED'),
      cell: (r) => this.i18n.t(r.enabled ? 'CATALOG.YES' : 'CATALOG.NO'),
    },
    {
      key: 'discount',
      header: this.i18n.t('CATALOG.CARD_TYPES.COLUMN.DISCOUNT'),
      align: 'end',
      hideNarrow: true,
      cell: (r) => (r.discountPercentage === null ? '' : `${r.discountPercentage} %`),
    },
    {
      key: 'places',
      header: this.i18n.t('CATALOG.CARD_TYPES.COLUMN.PLACES'),
      cell: (r) => placesCell(this.i18n, r.placeIds, this.outOfPerimeter(r)),
    },
  ]);
}
