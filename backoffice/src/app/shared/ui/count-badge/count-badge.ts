import { Component, input } from '@angular/core';

/**
 * Small counter shown next to a label (a menu entry): the number is for the eyes, a text for
 * screen readers says what it counts. `<fc-count-badge text="3" label="3 nuove segnalazioni" />`.
 */
@Component({
  selector: 'fc-count-badge',
  templateUrl: './count-badge.html',
  styleUrl: './count-badge.css',
})
export class CountBadge {
  /** Text shown (`3`, `99+`). */
  readonly text = input.required<string>();
  /** Text read by screen readers instead of the number (already translated). */
  readonly label = input.required<string>();
}
