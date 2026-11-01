import { Component, input } from '@angular/core';
import { Icon } from '../icon/icon';
import { IconName } from '../icon/icons';

/**
 * Button showing only an icon: the accessible name (`label`) is mandatory and doubles as
 * tooltip. `<button fc-icon-button icon="menu" [label]="'LAYOUT.MENU' | t">`.
 */
@Component({
  selector: 'button[fc-icon-button]',
  imports: [Icon],
  templateUrl: './icon-button.html',
  styleUrl: './icon-button.css',
  host: {
    type: 'button',
    '[attr.aria-label]': 'label()',
    '[attr.title]': 'label()',
  },
})
export class IconButton {
  /** Icon to show. */
  readonly icon = input.required<IconName>();
  /** Accessible name of the button. */
  readonly label = input.required<string>();
}
