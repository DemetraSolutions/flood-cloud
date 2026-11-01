import { Component, computed, input } from '@angular/core';
import { Icon } from '../icon/icon';
import { IconName } from '../icon/icons';

/** Tone of a {@link StatusBadge}. */
export type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

const TONE_ICONS: Record<BadgeTone, IconName | null> = {
  neutral: null,
  info: 'info',
  success: 'check',
  warning: 'alert',
  danger: 'error',
};

/**
 * Status badge: the state is conveyed by text plus an icon, never by color alone.
 * `<fc-status-badge tone="success">Attivo</fc-status-badge>`.
 */
@Component({
  selector: 'fc-status-badge',
  imports: [Icon],
  templateUrl: './status-badge.html',
  styleUrl: './status-badge.css',
  host: { '[attr.data-tone]': 'tone()' },
})
export class StatusBadge {
  /** Semantic tone. */
  readonly tone = input<BadgeTone>('neutral');

  protected readonly icon = computed(() => TONE_ICONS[this.tone()]);
}
