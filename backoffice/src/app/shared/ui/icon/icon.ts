import { Component, computed, input } from '@angular/core';
import { ICONS, IconName } from './icons';

/**
 * Decorative inline SVG icon (hidden from assistive technology). Meaning must be conveyed by
 * adjacent text or by the accessible name of the enclosing control.
 */
@Component({
  selector: 'fc-icon',
  templateUrl: './icon.html',
  styleUrl: './icon.css',
})
export class Icon {
  /** Icon to draw, from the {@link ICONS} registry. */
  readonly name = input.required<IconName>();

  protected readonly path = computed(() => ICONS[this.name()]);
}
