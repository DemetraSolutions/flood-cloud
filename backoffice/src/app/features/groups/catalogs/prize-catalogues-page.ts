import { Component, computed, inject, input } from '@angular/core';
import { I18nService } from '../../../core/i18n/i18n.service';
import { SessionService } from '../../../core/session/session.service';
import { TableColumn } from '../../../shared/ui/data-table/data-table.types';
import { CatalogManager } from './catalog-manager';
import { MAX_PRIZE_CATALOGUES, PrizeCatalogue } from './catalog.types';
import { PrizeCatalogueEditor } from './prize-catalogue-editor';

/** Prize catalogues of the group (`/groups/:groupId/fidelity/prize-catalogues`, `fidelity:*`). */
@Component({
  selector: 'fc-prize-catalogues-page',
  imports: [CatalogManager, PrizeCatalogueEditor],
  template: `<fc-catalog-manager
    kind="PRIZE_CATALOGUES"
    segment="fidelity/prize-catalogues"
    [groupId]="groupId()"
    [columns]="columns()"
    [idOf]="idOf"
    [nameOf]="nameOf"
    [canWrite]="canWrite()"
    [limit]="max"
    [wide]="true"
  >
    <ng-template
      #editor
      let-item
      let-error="error"
      let-busy="busy"
      let-save="save"
      let-cancel="cancel"
    >
      <fc-prize-catalogue-editor
        [item]="item"
        [error]="error"
        [busy]="busy"
        (save)="save($event)"
        (cancelled)="cancel()"
      />
    </ng-template>
  </fc-catalog-manager>`,
})
export class PrizeCataloguesPage {
  private readonly i18n = inject(I18nService);
  private readonly session = inject(SessionService);

  /** Route parameter. */
  readonly groupId = input.required<string>();

  protected readonly canWrite = computed(() => this.session.can('fidelity:update'));
  protected readonly max = MAX_PRIZE_CATALOGUES;
  protected readonly idOf = (row: PrizeCatalogue): string => row.id;
  protected readonly nameOf = (row: PrizeCatalogue): string => row.name;
  protected readonly columns = computed<TableColumn<PrizeCatalogue>[]>(() => [
    {
      key: 'name',
      header: this.i18n.t('CATALOG.PRIZE_CATALOGUES.COLUMN.NAME'),
      cell: (r) => r.name,
    },
    {
      key: 'enabled',
      header: this.i18n.t('CATALOG.PRIZE_CATALOGUES.COLUMN.ENABLED'),
      cell: (r) => this.i18n.t(r.enabled ? 'CATALOG.YES' : 'CATALOG.NO'),
    },
    {
      key: 'prizes',
      header: this.i18n.t('CATALOG.PRIZE_CATALOGUES.COLUMN.PRIZES'),
      align: 'end',
      cell: (r) => String(r.prizes.length),
    },
  ]);
}
