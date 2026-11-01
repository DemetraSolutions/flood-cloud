import { Service, signal } from '@angular/core';

/** Whether the application could not start (dictionary or public configuration unavailable). */
@Service()
export class StartupState {
  private readonly failedState = signal(false);

  /** `true` when startup failed and the startup error page must replace the application. */
  readonly failed = this.failedState.asReadonly();

  /** Marks startup as failed. */
  fail(): void {
    this.failedState.set(true);
  }
}
