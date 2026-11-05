import { afterNextRender, Component, ElementRef, inject, input } from '@angular/core';
import { Icon } from '../icon/icon';

/**
 * Form-level error message (failed login, rejected request…). It is an alert region that takes
 * the focus when it appears, so the failure is announced and keyboard users land on it.
 */
@Component({
  selector: 'fc-form-error',
  imports: [Icon],
  template: `<fc-icon name="error" /><span>{{ message() }}</span>`,
  styles: `
    :host {
      display: flex;
      align-items: flex-start;
      gap: var(--space-2);
      padding: var(--space-3);
      border: 1px solid var(--color-danger);
      border-radius: var(--radius-md);
      color: var(--color-danger);
    }
  `,
  host: { role: 'alert', tabindex: '-1' },
})
export class FormError {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** Message to show (already translated). */
  readonly message = input.required<string>();

  constructor() {
    afterNextRender(() => this.host.nativeElement.focus());
  }
}
