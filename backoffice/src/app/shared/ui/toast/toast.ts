import {
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  output,
  untracked,
} from '@angular/core';
import { TPipe } from '../../../core/i18n/t-pipe';
import { IconButton } from '../icon-button/icon-button';
import { Icon } from '../icon/icon';
import { IconName } from '../icon/icons';
import { Toast } from './toast.service';

const KIND_ICONS: Record<Toast['kind'], IconName> = {
  success: 'check',
  info: 'info',
  error: 'error',
};

/**
 * A single notification. Auto-dismissal pauses while the pointer is over it or focus is inside
 * it (WCAG 2.2.1) and resumes with the time that was left.
 */
@Component({
  selector: 'fc-toast',
  imports: [Icon, IconButton, TPipe],
  templateUrl: './toast.html',
  styleUrl: './toast.css',
  host: {
    '[attr.data-kind]': 'toast().kind',
    '[attr.role]': 'toast().kind === "error" ? "alert" : null',
    '(mouseenter)': 'setHover(true)',
    '(mouseleave)': 'setHover(false)',
    '(focusin)': 'setFocus(true)',
    '(focusout)': 'setFocus(false)',
  },
})
export class ToastItem {
  /** The notification to show. */
  readonly toast = input.required<Toast>();
  /** Emitted when it must be removed (timeout or close button). */
  readonly dismissed = output<void>();

  protected readonly icon = computed(() => KIND_ICONS[this.toast().kind]);

  private timer: ReturnType<typeof setTimeout> | undefined;
  private remaining = 0;
  private startedAt = 0;
  private hover = false;
  private focus = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.pause());
    effect(() => {
      this.remaining = this.toast().duration;
      untracked(() => this.update());
    });
  }

  protected setHover(value: boolean): void {
    this.hover = value;
    this.update();
  }

  protected setFocus(value: boolean): void {
    this.focus = value;
    this.update();
  }

  private update(): void {
    if (this.hover || this.focus) {
      this.pause();
    } else {
      this.resume();
    }
  }

  private pause(): void {
    if (this.timer === undefined) {
      return;
    }
    clearTimeout(this.timer);
    this.timer = undefined;
    this.remaining -= Date.now() - this.startedAt;
  }

  private resume(): void {
    if (this.timer !== undefined || this.remaining <= 0) {
      return;
    }
    this.startedAt = Date.now();
    this.timer = setTimeout(() => this.dismissed.emit(), this.remaining);
  }
}
