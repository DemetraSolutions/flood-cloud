import { Component } from '@angular/core';
import { PlaceFieldsView } from './place-fields-view';

/**
 * Integrations tab of the place: a card for each provider (Flood Pay, Dojo, Satispay…), in the
 * order of the old backoffice. The switch of each is for platform administrators and dealers; the
 * credentials are write-only (only "impostata" or "non impostata" is shown).
 */
@Component({
  selector: 'fc-place-integrations',
  imports: [PlaceFieldsView],
  template: `
    <form novalidate (submit)="$event.preventDefault()">
      <fc-place-fields block="integrations" />
    </form>
  `,
  styleUrl: './place-section.css',
})
export class PlaceIntegrations {}
