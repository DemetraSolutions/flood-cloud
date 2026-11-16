import { Component, input } from '@angular/core';
import { PlaceFieldsView } from './place-fields-view';
import { SettingsBlockName } from './place.types';

/**
 * A tab that is only the keys of a settings block (appointments, external display, fidelity,
 * tobacco and games): the route says which block.
 */
@Component({
  selector: 'fc-place-scalar-tab',
  imports: [PlaceFieldsView],
  template: `
    <form novalidate (submit)="$event.preventDefault()">
      <fc-place-fields [block]="section()" />
    </form>
  `,
  styleUrl: './place-section.css',
})
export class PlaceScalarTab {
  /** The block the tab shows (given by the route). */
  readonly section = input.required<SettingsBlockName>();
}
