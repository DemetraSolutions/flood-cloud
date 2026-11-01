import { Component, input } from '@angular/core';

/**
 * Empty-state message with a suggested action projected as content:
 * `<fc-empty-state title="…" message="…"><button fc-button>Crea</button></fc-empty-state>`.
 */
@Component({
  selector: 'fc-empty-state',
  templateUrl: './empty-state.html',
  styleUrl: './empty-state.css',
})
export class EmptyState {
  /** Short headline (already translated). */
  readonly title = input.required<string>();
  /** Explanation (already translated). */
  readonly message = input<string | null>(null);
}
