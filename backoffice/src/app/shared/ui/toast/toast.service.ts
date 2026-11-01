import { Service, signal } from '@angular/core';

/** Kind of notification. */
export type ToastKind = 'success' | 'info' | 'error';

/** A notification shown in the toast region. */
export interface Toast {
  readonly id: number;
  readonly kind: ToastKind;
  readonly message: string;
  /** Milliseconds before auto-dismissal; `0` keeps it until the user closes it. */
  readonly duration: number;
}

/** Default auto-dismissal delay. */
export const TOAST_DEFAULT_DURATION = 6000;

/** Maximum number of toasts visible at once; the oldest is dropped. */
export const TOAST_MAX = 5;

/** Queue of notifications; the {@link ToastRegion} renders it. Messages are already translated. */
@Service()
export class ToastService {
  private nextId = 1;
  private readonly state = signal<readonly Toast[]>([]);

  /** Visible toasts, oldest first. */
  readonly toasts = this.state.asReadonly();

  /**
   * Shows a notification.
   *
   * @param kind Kind of notification.
   * @param message Text to show (already translated).
   * @param duration Milliseconds before auto-dismissal, `0` for never.
   */
  show(kind: ToastKind, message: string, duration = TOAST_DEFAULT_DURATION): void {
    const toast: Toast = { id: this.nextId++, kind, message, duration };
    this.state.update((toasts) => [...toasts, toast].slice(-TOAST_MAX));
  }

  /** Shows a success notification. */
  success(message: string): void {
    this.show('success', message);
  }

  /** Shows an informational notification. */
  info(message: string): void {
    this.show('info', message);
  }

  /** Shows an error notification. */
  error(message: string): void {
    this.show('error', message);
  }

  /** Removes a notification. */
  dismiss(id: number): void {
    this.state.update((toasts) => toasts.filter((toast) => toast.id !== id));
  }
}
