import { booleanAttribute, Component, input } from '@angular/core';

/** Visual variants of {@link Button}. */
export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

/**
 * Button on a native `<button>`: `<button fc-button variant="primary" [loading]="saving()">`.
 * While `loading` it is disabled (no double submit) and exposes `aria-busy`.
 */
@Component({
  selector: 'button[fc-button]',
  templateUrl: './button.html',
  styleUrl: './button.css',
  host: {
    '[attr.type]': 'type()',
    '[attr.data-variant]': 'variant()',
    '[attr.aria-busy]': 'loading() ? "true" : null',
    '[disabled]': 'disabled() || loading()',
  },
})
export class Button {
  /** Visual variant. */
  readonly variant = input<ButtonVariant>('primary');
  /** Native button type; defaults to `button` so that forms are not submitted by accident. */
  readonly type = input<'button' | 'submit' | 'reset'>('button');
  /** Shows a spinner, disables the button and sets `aria-busy`. */
  readonly loading = input(false, { transform: booleanAttribute });
  /** Disables the button. */
  readonly disabled = input(false, { transform: booleanAttribute });
}
