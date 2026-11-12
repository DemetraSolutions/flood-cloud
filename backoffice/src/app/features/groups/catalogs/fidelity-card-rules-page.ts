import { Component, computed, inject } from '@angular/core';
import { I18nService } from '../../../core/i18n/i18n.service';
import { TableColumn } from '../../../shared/ui/data-table/data-table.types';
import { GroupSettingsState } from '../group-settings-state';
import { CatalogManager } from './catalog-manager';
import { FidelityCardRule } from './catalog.types';
import { FidelityRuleEditor } from './fidelity-rule-editor';

/**
 * Loyalty-card rules of the group (`/groups/:groupId/settings/fidelity-card-rules`): one per
 * currency, created and removed together with it, so they can only be changed.
 */
@Component({
  selector: 'fc-fidelity-card-rules-page',
  imports: [CatalogManager, FidelityRuleEditor],
  template: `<fc-catalog-manager
    kind="FIDELITY_CARD_RULES"
    segment="fidelity-card-rules"
    [groupId]="state.groupId()!"
    [columns]="columns()"
    [idOf]="idOf"
    [nameOf]="nameOf"
    [canWrite]="state.canUpdate()"
    [allowCreate]="false"
    [allowDelete]="false"
    updateMethod="PUT"
  >
    <ng-template
      #editor
      let-item
      let-error="error"
      let-busy="busy"
      let-save="save"
      let-cancel="cancel"
    >
      <fc-fidelity-rule-editor
        [item]="item"
        [error]="error"
        [busy]="busy"
        (save)="save($event)"
        (cancelled)="cancel()"
      />
    </ng-template>
  </fc-catalog-manager>`,
})
export class FidelityCardRulesPage {
  protected readonly state = inject(GroupSettingsState);
  private readonly i18n = inject(I18nService);

  protected readonly idOf = (row: FidelityCardRule): string => row.currency;
  protected readonly nameOf = (row: FidelityCardRule): string => row.currency;
  protected readonly columns = computed<TableColumn<FidelityCardRule>[]>(() => [
    {
      key: 'currency',
      header: this.i18n.t('CATALOG.FIDELITY_CARD_RULES.COLUMN.CURRENCY'),
      cell: (r) => r.currency,
    },
    {
      key: 'pointValue',
      header: this.i18n.t('CATALOG.FIDELITY_CARD_RULES.COLUMN.POINT_VALUE'),
      align: 'end',
      cell: (r) => (r.pointValue === null ? '' : String(r.pointValue)),
    },
    {
      key: 'discountPercentage',
      header: this.i18n.t('CATALOG.FIDELITY_CARD_RULES.COLUMN.DISCOUNT'),
      align: 'end',
      cell: (r) => (r.discountPercentage === null ? '' : `${r.discountPercentage}%`),
    },
  ]);
}
