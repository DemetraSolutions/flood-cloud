import { Component, computed, effect, inject, input, untracked } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { apiErrorMessageKey } from '../../core/api/api-error';
import { Can } from '../../core/auth/can';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { Button } from '../../shared/ui/button/button';
import { ErrorState } from '../../shared/ui/error-state/error-state';
import { Icon } from '../../shared/ui/icon/icon';
import { StatusBadge } from '../../shared/ui/status-badge/status-badge';
import { GroupActions } from './group-actions';
import { GroupSettingsState } from './group-settings-state';

/** Sections of the record, in display order: `path` is relative to the record. */
export const GROUP_SECTIONS = [
  { path: '', key: 'GENERAL', exact: true },
  { path: 'features', key: 'FEATURES', exact: false },
  { path: 'integrations', key: 'INTEGRATIONS', exact: false },
  { path: 'price-lists', key: 'PRICE_LISTS', exact: false },
  { path: 'taxes', key: 'TAXES', exact: false },
  { path: 'currencies', key: 'CURRENCIES', exact: false },
  { path: 'measure-units', key: 'MEASURE_UNITS', exact: false },
  { path: 'warehouse-rules', key: 'WAREHOUSE_RULES', exact: false },
  { path: 'fidelity-card-rules', key: 'FIDELITY_CARD_RULES', exact: false },
] as const;

/**
 * Record of a group (`/groups/:groupId/settings`): the name, the state, a banner for a
 * suspended or trashed group, the actions on its state (platform administrator) and the
 * navigation between the sections, which are the child routes (general data, features,
 * integrations and the six catalogs). Sections are routes so that each can be linked, loaded on
 * demand and saved on its own.
 */
@Component({
  selector: 'fc-group-settings',
  imports: [
    Button,
    Can,
    ErrorState,
    GroupActions,
    Icon,
    RouterLink,
    RouterLinkActive,
    RouterOutlet,
    StatusBadge,
    TPipe,
  ],
  providers: [GroupSettingsState],
  templateUrl: './group-settings.html',
  styleUrl: './group-settings.css',
})
export class GroupSettings {
  protected readonly state = inject(GroupSettingsState);
  protected readonly i18n = inject(I18nService);

  /** Route parameter. */
  readonly groupId = input.required<string>();

  protected readonly sections = GROUP_SECTIONS;
  protected readonly errorMessage = computed(() => {
    const error = this.state.loadError();
    return this.i18n.t(error === null ? 'ERRORS.GENERIC.MESSAGE' : apiErrorMessageKey(error));
  });

  constructor() {
    this.state.attach(this.groupId);
    // The record loaded: its group becomes the working group of the selector and the menu.
    effect(() => {
      const group = this.state.group();
      if (group !== null) {
        untracked(() => this.state.adopt(group));
      }
    });
  }
}
