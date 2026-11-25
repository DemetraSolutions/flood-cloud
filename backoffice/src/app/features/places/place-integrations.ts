import { Component, computed, inject } from '@angular/core';
import { I18nService } from '../../core/i18n/i18n.service';
import {
  DojoTerminals,
  SatispayActivation,
  TshSync,
  TshSyncResult,
} from '../integrations';
import { groupsOf } from './place-fields';
import { PlaceFieldsView } from './place-fields-view';
import { PlaceState } from './place-state';
import { PlaceTshMap } from './place-tsh-map';

/**
 * Integrations tab of the place: a card for each provider (Flood Pay, Dojo, Satispay…), in the
 * order of the old backoffice. The switch of each is for platform administrators and dealers; the
 * credentials are write-only (only "impostata" or "non impostata" is shown). Under the cards of
 * Dojo, Satispay and TS Hospitality sit the actions of the integrations module (the terminals,
 * the activation, the categories) and the map of the categories of TS Hospitality; the actions
 * call the provider with what the place has already saved, so they wait for the unsaved changes
 * of this tab to be saved.
 */
@Component({
  selector: 'fc-place-integrations',
  imports: [DojoTerminals, PlaceFieldsView, PlaceTshMap, SatispayActivation, TshSync],
  templateUrl: './place-integrations.html',
  styleUrl: './place-section.css',
})
export class PlaceIntegrations {
  protected readonly state = inject(PlaceState);
  private readonly i18n = inject(I18nService);

  protected readonly groups = groupsOf('integrations');
  /** Why the actions cannot run now: the tab has changes the provider calls would not see. */
  protected readonly blockedBy = computed(() =>
    this.state.dirty().has('integrations') ? this.i18n.t('INTEGRATIONS.UNSAVED') : null,
  );
  protected readonly etag = computed(() => this.state.etag());

  protected onSynced(result: TshSyncResult): void {
    this.state.adoptTshCategories(result.categories, result.etag);
  }
}
