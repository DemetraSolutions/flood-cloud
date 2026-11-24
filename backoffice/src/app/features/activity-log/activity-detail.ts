import { Component, computed, inject, input } from '@angular/core';
import { formatDate } from '../../core/i18n/format';
import { I18nService } from '../../core/i18n/i18n.service';
import { DEFAULT_LANGUAGE } from '../../core/i18n/language';
import { TPipe } from '../../core/i18n/t-pipe';
import {
  actionLabelKey,
  ACTIVITY_ACTIONS,
  ActivityChange,
  ActivityEntry,
  formatChangeValue,
  otherActorLabel,
  alertSummary,
} from './activity-log.types';

/**
 * Full content of an activity log entry: general data, field changes (secret values are shown
 * as "oscurato"), metadata and, for client errors, the name, message and stack as plain text.
 */
@Component({
  selector: 'fc-activity-detail',
  imports: [TPipe],
  templateUrl: './activity-detail.html',
  styleUrl: './activity-detail.css',
})
export class ActivityDetail {
  protected readonly i18n = inject(I18nService);

  /** The entry to show. */
  readonly entry = input.required<ActivityEntry>();

  protected readonly when = computed(() =>
    formatDate(this.entry().at, this.i18n.language() ?? DEFAULT_LANGUAGE, {
      dateStyle: 'medium',
      timeStyle: 'medium',
    }),
  );
  protected readonly action = computed(() => {
    const action = this.entry().action;
    return ACTIVITY_ACTIONS.includes(action) ? this.i18n.t(actionLabelKey(action)) : action;
  });
  protected readonly actor = computed(() => {
    const { kind, username, id, role } = this.entry().actor;
    if (kind === 'user') {
      return username ?? id ?? (role === null ? '' : this.i18n.t(`ROLE.${role}`));
    }
    return otherActorLabel(this.i18n, this.entry().actor);
  });
  protected readonly summary = computed(() => alertSummary(this.i18n, this.entry()));
  protected readonly changes = computed(() => this.entry().changes ?? []);
  protected readonly metadata = computed(() => Object.entries(this.entry().metadata ?? {}));

  protected value(change: ActivityChange, side: 'before' | 'after'): string {
    return change.redacted ? this.i18n.t('ACTIVITY.REDACTED') : formatChangeValue(change[side]);
  }
}
