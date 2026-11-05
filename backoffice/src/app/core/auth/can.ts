import { Directive, effect, inject, input, TemplateRef, ViewContainerRef } from '@angular/core';
import { SessionService } from '../session/session.service';

/**
 * Renders its template only when the user holds a permission: `<button *fcCan="'users:create'">`.
 * It hides UI; the server enforces the permission on every request.
 */
@Directive({ selector: '[fcCan]' })
export class Can {
  /** Permission in the form `resource:action`. */
  readonly permission = input.required<string>({ alias: 'fcCan' });

  private readonly session = inject(SessionService);
  private readonly template = inject<TemplateRef<unknown>>(TemplateRef);
  private readonly container = inject(ViewContainerRef);

  constructor() {
    effect(() => {
      const allowed = this.session.can(this.permission());
      if (allowed && this.container.length === 0) {
        this.container.createEmbeddedView(this.template);
      } else if (!allowed) {
        this.container.clear();
      }
    });
  }
}
