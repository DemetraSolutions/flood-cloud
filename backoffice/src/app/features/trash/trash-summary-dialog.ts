import { Component, computed, inject, input, model } from '@angular/core';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { Button } from '../../shared/ui/button/button';
import { Dialog } from '../../shared/ui/dialog/dialog';
import { TRASH_ISSUES, TrashIssue, TrashKind, TrashSummary } from './trash.types';

/** Most names listed under a reason; the others are counted. */
export const MAX_LISTED_NAMES = 10;

/** Dictionary key of the reason of each issue (`referenced` also depends on the kind). */
const ISSUE_KEYS: Readonly<Record<Exclude<TrashIssue, 'referenced'>, string>> = {
  taken: 'TAKEN',
  forbidden: 'FORBIDDEN',
  notTrashed: 'NOT_TRASHED',
  notFound: 'NOT_FOUND',
};

/** One reason of the summary with the items skipped for it. */
interface IssueGroup {
  readonly issue: TrashIssue;
  readonly reason: string;
  readonly count: number;
  readonly names: string;
}

/**
 * Outcome of a bulk call of the trash: how many items were restored or deleted and, for the
 * skipped ones, a readable reason per issue (with the names of the items the user selected).
 */
@Component({
  selector: 'fc-trash-summary-dialog',
  imports: [Button, Dialog, TPipe],
  templateUrl: './trash-summary-dialog.html',
  styleUrl: './trash-summary-dialog.css',
})
export class TrashSummaryDialog {
  private readonly i18n = inject(I18nService);

  /** Kind of the items (the reason of a `referenced` item depends on it). */
  readonly kind = input.required<TrashKind>();
  /** What to report. */
  readonly summary = input.required<TrashSummary>();
  /** Names of the items by id, when the user selected them. */
  readonly names = input<ReadonlyMap<string, string>>(new Map());
  /** Whether the dialog is open (two-way). */
  readonly open = model(false);

  protected readonly skippedCount = computed(() => this.summary().skipped.length);
  protected readonly nothingDone = computed(() => {
    const summary = this.summary();
    return summary.restored + summary.deleted + summary.skipped.length === 0;
  });
  protected readonly groups = computed<IssueGroup[]>(() => {
    const skipped = this.summary().skipped;
    return TRASH_ISSUES.flatMap((issue) => {
      const ids = skipped.filter((item) => item.issue === issue).map((item) => item.id);
      if (ids.length === 0) {
        return [];
      }
      const named = ids.flatMap((id) => this.names().get(id) ?? []);
      const listed = named.slice(0, MAX_LISTED_NAMES).join(', ');
      const more = named.length - MAX_LISTED_NAMES;
      return [
        {
          issue,
          reason: this.reason(issue),
          count: ids.length,
          names:
            more > 0 ? `${listed} ${this.i18n.t('TRASH.SUMMARY.MORE', { count: more })}` : listed,
        },
      ];
    });
  });

  private reason(issue: TrashIssue): string {
    const key =
      issue === 'referenced' ? `REFERENCED_${this.kind().toUpperCase()}` : ISSUE_KEYS[issue];
    return this.i18n.t(`TRASH.ISSUE.${key}`);
  }
}
