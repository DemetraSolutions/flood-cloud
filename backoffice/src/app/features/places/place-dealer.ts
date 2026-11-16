import { Component, inject } from '@angular/core';
import { PlaceFieldsView } from './place-fields-view';
import { PlaceState } from './place-state';
import { PlaceStoreKey } from './place-store-key';

/**
 * "Impostazioni rivenditore" of the settings menu (platform administrators and dealers): the
 * Sentry switch of the POS (platform administrators), the address of the server of the store, the
 * address of the Connector and the store key panel of the place.
 */
@Component({
  selector: 'fc-place-dealer',
  imports: [PlaceFieldsView, PlaceStoreKey],
  template: `
    <form novalidate (submit)="$event.preventDefault()">
      <fc-place-fields block="dealerSettings" />
    </form>
    @if (state.hasStoreKey()) {
      <fc-place-store-key />
    }
  `,
  styleUrl: './place-section.css',
})
export class PlaceDealer {
  protected readonly state = inject(PlaceState);
}
