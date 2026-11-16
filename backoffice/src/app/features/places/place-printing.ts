import { Component } from '@angular/core';
import { PlaceFieldsView } from './place-fields-view';

/**
 * "Stampa e layout" of the settings menu: the receipt, the pre-bill and the order, each with the
 * sections of the old backoffice. The pre-bill and the order are shown to the groups with the
 * ordering module (and always to platform administrators and dealers). The configuration is
 * downloaded and uploaded from the ⋮ menu of the page.
 */
@Component({
  selector: 'fc-place-printing',
  imports: [PlaceFieldsView],
  template: `
    <form novalidate (submit)="$event.preventDefault()">
      <fc-place-fields block="printing" />
    </form>
  `,
  styleUrl: './place-section.css',
})
export class PlacePrinting {}
