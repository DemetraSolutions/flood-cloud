import { booleanAttribute, Component, input, output } from '@angular/core';
import { TPipe } from '../../../core/i18n/t-pipe';
import { Button } from '../button/button';
import { Icon } from '../icon/icon';

/**
 * Error panel for a view that failed to load: understandable message, optional "Riprova"
 * button and the request id (when known) for support. Never shows raw error codes.
 */
@Component({
  selector: 'fc-error-state',
  imports: [Button, Icon, TPipe],
  templateUrl: './error-state.html',
  styleUrl: './error-state.css',
  host: { role: 'alert' },
})
export class ErrorState {
  /** Headline (already translated). */
  readonly title = input.required<string>();
  /** Explanation (already translated). */
  readonly message = input<string | null>(null);
  /** Request id from the failed API call, shown for support. */
  readonly requestId = input<string | null>(null);
  /** Whether to offer the retry button. */
  readonly retryable = input(true, { transform: booleanAttribute });
  /** Emitted when the user presses retry. */
  readonly retry = output<void>();
}
