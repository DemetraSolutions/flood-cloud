import { Service, signal } from '@angular/core';

/** Message for the shell's live region, so that page changes are announced to screen readers. */
@Service()
export class PageAnnouncer {
  private readonly state = signal('');

  /** Last announcement. */
  readonly message = this.state.asReadonly();

  /** Announces a page change (the new page title). */
  announce(message: string): void {
    this.state.set(message);
  }
}
