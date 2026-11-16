import { Component } from '@angular/core';
import { PlaceFieldsView } from './place-fields-view';

/** "Altre impostazioni" of the settings menu: the cancellation of the receipts history. */
@Component({
  selector: 'fc-place-other',
  imports: [PlaceFieldsView],
  template: `
    <form novalidate (submit)="$event.preventDefault()">
      <fc-place-fields block="cashSettings" [only]="['OTHER']" />
    </form>
  `,
  styleUrl: './place-section.css',
})
export class PlaceOther {}
