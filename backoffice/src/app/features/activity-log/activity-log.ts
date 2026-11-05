import { httpResource } from '@angular/common/http';
import { Component, computed, inject, input, linkedSignal, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { ApiPage } from '../../core/api/api.types';
import { apiErrorMessageKey } from '../../core/api/api-error';
import { GroupContext } from '../../core/groups/group-context';
import { formatDate } from '../../core/i18n/format';
import { I18nService } from '../../core/i18n/i18n.service';
import { DEFAULT_LANGUAGE } from '../../core/i18n/language';
import { TPipe } from '../../core/i18n/t-pipe';
import { SessionService } from '../../core/session/session.service';
import { BadgeTone, StatusBadge } from '../../shared/ui/status-badge/status-badge';
import { Button } from '../../shared/ui/button/button';
import { Checkbox } from '../../shared/ui/checkbox/checkbox';
import { CursorPaginator } from '../../shared/ui/cursor-paginator/cursor-paginator';
import { DataTable } from '../../shared/ui/data-table/data-table';
import { TableColumn } from '../../shared/ui/data-table/data-table.types';
import { CellTemplate, RowActionsTemplate } from '../../shared/ui/data-table/table-templates';
import { Dialog } from '../../shared/ui/dialog/dialog';
import { ErrorState } from '../../shared/ui/error-state/error-state';
import { Select } from '../../shared/ui/select/select';
import { TextField } from '../../shared/ui/text-field/text-field';
import { createDebouncer } from '../../shared/util/debouncer';
import { apiErrorOf } from '../profile/sessions';
import { ActivityDetail } from './activity-detail';
import {
  abbreviateId,
  actionLabelKey,
  ACTIVITY_ACTIONS,
  ACTIVITY_CATEGORIES,
  ACTIVITY_OUTCOMES,
  ActivityCategory,
  ActivityEntry,
  ActivityOutcome,
} from './activity-log.types';

/** Page sizes offered by the list. */
export const ACTIVITY_PAGE_SIZES = [10, 25, 50, 100] as const;
const DEFAULT_LIMIT = 25;
/** Longest period the backend accepts, in days. */
export const MAX_PERIOD_DAYS = 400;
const DAY_MS = 86_400_000;
const OBJECT_ID = /^[0-9a-f]{24}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_REQUEST_ID_LENGTH = 128;
const ERROR_ACTIONS = ['client.error', 'request.failed'];

const CATEGORY_TONES: Record<ActivityCategory, BadgeTone> = {
  data: 'info',
  security: 'warning',
  error: 'danger',
};
const OUTCOME_TONES: Record<ActivityOutcome, BadgeTone> = {
  success: 'success',
  failure: 'danger',
  denied: 'warning',
};

/** Query parameters of the list as kept in the URL (`null` removes one). */
type QueryChange = Record<string, string | null>;

/** A calendar day (`YYYY-MM-DD`) or `null` when the text is not a real date. */
function validDay(value: string | undefined): string | null {
  return value !== undefined &&
    DAY.test(value) &&
    !Number.isNaN(new Date(`${value}T00:00:00`).getTime())
    ? value
    : null;
}

/**
 * Monitor of the activity log (`/activity-log`): filters and cursor pagination live in the URL.
 * What each user sees is decided by the server (the platform admin everything, the others their
 * perimeter); the page only offers the filters that make sense for the role. A row opens its
 * details (field changes, metadata, client error) in a dialog.
 */
@Component({
  selector: 'fc-activity-log',
  imports: [
    ActivityDetail,
    Button,
    CellTemplate,
    Checkbox,
    CursorPaginator,
    DataTable,
    Dialog,
    ErrorState,
    RowActionsTemplate,
    Select,
    StatusBadge,
    TextField,
    TPipe,
  ],
  templateUrl: './activity-log.html',
  styleUrl: './activity-log.css',
})
export class ActivityLogPage {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly session = inject(SessionService);
  protected readonly groups = inject(GroupContext);
  private readonly debouncer = createDebouncer();
  protected readonly i18n = inject(I18nService);

  /** Query parameters (bound by the router). */
  readonly category = input<string>();
  readonly outcome = input<string>();
  readonly action = input<string>();
  readonly from = input<string>();
  readonly to = input<string>();
  readonly requestId = input<string>();
  readonly actorId = input<string>();
  readonly groupId = input<string>();
  readonly limit = input<string>();
  readonly cursor = input<string>();

  private readonly isPlatformAdmin = computed(() => this.session.me()?.role === 'PSA');

  protected readonly pageSize = computed(() => {
    const value = Number(this.limit());
    return (ACTIVITY_PAGE_SIZES as readonly number[]).includes(value) ? value : DEFAULT_LIMIT;
  });
  protected readonly categoryOptions = computed(() =>
    ACTIVITY_CATEGORIES.filter((value) => value !== 'error' || this.isPlatformAdmin()).map(
      (value) => ({ value, label: this.i18n.t(`ACTIVITY.CATEGORY.${value.toUpperCase()}`) }),
    ),
  );
  protected readonly outcomeOptions = computed(() =>
    ACTIVITY_OUTCOMES.map((value) => ({
      value,
      label: this.i18n.t(`ACTIVITY.OUTCOME.${value.toUpperCase()}`),
    })),
  );
  /** Actions of the error category are only for the platform admin. */
  private readonly visibleActions = computed(() =>
    ACTIVITY_ACTIONS.filter((value) => this.isPlatformAdmin() || !ERROR_ACTIONS.includes(value)),
  );
  protected readonly actionOptions = computed(() =>
    this.visibleActions().map((value) => ({ value, label: this.i18n.t(actionLabelKey(value)) })),
  );

  /** Filters read from the URL, ignoring values that are not valid. */
  protected readonly categoryFilter = computed(
    () => this.categoryOptions().find((option) => option.value === this.category())?.value,
  );
  private readonly outcomeFilter = computed(() =>
    ACTIVITY_OUTCOMES.find((value) => value === this.outcome()),
  );
  private readonly actionFilter = computed(() =>
    this.visibleActions().find((value) => value === this.action()),
  );
  private readonly fromDay = computed(() => validDay(this.from()));
  private readonly toDay = computed(() => validDay(this.to()));
  private readonly requestIdFilter = computed(() => {
    const value = this.requestId()?.trim() ?? '';
    return value === '' ? undefined : value.slice(0, MAX_REQUEST_ID_LENGTH);
  });
  protected readonly actorFilter = computed(() => {
    const value = this.actorId();
    return value !== undefined && OBJECT_ID.test(value) ? value : undefined;
  });
  protected readonly groupFilter = computed(() => {
    const value = this.groupId();
    return this.groups.canChoose() && value !== undefined && OBJECT_ID.test(value)
      ? value
      : undefined;
  });

  /** Error of the period (end before start, or longer than the backend accepts), if any. */
  protected readonly periodError = computed(() => {
    const from = this.fromDay();
    const to = this.toDay();
    if (from === null || to === null) {
      return null;
    }
    const days =
      (new Date(`${to}T00:00:00`).getTime() - new Date(`${from}T00:00:00`).getTime()) / DAY_MS;
    if (days < 0) {
      return this.i18n.t('ACTIVITY.PERIOD.ORDER');
    }
    return days > MAX_PERIOD_DAYS ? this.i18n.t('ACTIVITY.PERIOD.TOO_LONG') : null;
  });

  protected readonly requestText = linkedSignal(() => this.requestId() ?? '');
  protected readonly cursorStack = signal<readonly (string | null)[]>([]);

  protected readonly entries = httpResource<ApiPage<ActivityEntry>>(() => {
    if (this.periodError() !== null) {
      return undefined;
    }
    const params: Record<string, string | number> = { limit: this.pageSize() };
    const from = this.fromDay();
    const to = this.toDay();
    const filters = {
      category: this.categoryFilter(),
      outcome: this.outcomeFilter(),
      action: this.actionFilter(),
      from: from === null ? undefined : new Date(`${from}T00:00:00`).toISOString(),
      to: to === null ? undefined : new Date(`${to}T23:59:59.999`).toISOString(),
      requestId: this.requestIdFilter(),
      actorId: this.actorFilter(),
      groupId: this.groupFilter(),
      cursor: this.cursor(),
    };
    for (const [name, value] of Object.entries(filters)) {
      if (value) {
        params[name] = value;
      }
    }
    return { url: '/v1/activity-log', params };
  });

  protected readonly rows = computed(() => this.entries.value()?.data ?? []);
  protected readonly nextCursor = computed(() => this.entries.value()?.page.next ?? null);
  protected readonly loadError = computed(() => apiErrorOf(this.entries.error()));
  protected readonly errorMessage = computed(() => {
    const error = this.loadError();
    return this.i18n.t(error === null ? 'ERRORS.GENERIC.MESSAGE' : apiErrorMessageKey(error));
  });

  /** Whether the PSA/dealer filter by the working group is offered, and possible. */
  protected readonly canFilterGroup = computed(() => this.groups.canChoose());
  protected readonly groupFilterActive = computed(() => this.groupFilter() !== undefined);

  protected readonly selected = signal<ActivityEntry | null>(null);
  protected readonly detailOpen = signal(false);

  protected readonly columns = computed<TableColumn<ActivityEntry>[]>(() => [
    { key: 'at', header: this.i18n.t('ACTIVITY.COLUMN.AT'), cell: (row) => this.date(row.at) },
    { key: 'category', header: this.i18n.t('ACTIVITY.COLUMN.CATEGORY') },
    {
      key: 'action',
      header: this.i18n.t('ACTIVITY.COLUMN.ACTION'),
      cell: (row) => this.actionLabel(row),
    },
    { key: 'outcome', header: this.i18n.t('ACTIVITY.COLUMN.OUTCOME') },
    {
      key: 'actor',
      header: this.i18n.t('ACTIVITY.COLUMN.ACTOR'),
      cell: (row) => this.actorName(row),
    },
    {
      key: 'groupId',
      header: this.i18n.t('ACTIVITY.COLUMN.GROUP'),
      hideNarrow: true,
      cell: (row) => (row.groupId === null ? '' : abbreviateId(row.groupId)),
    },
    {
      key: 'resource',
      header: this.i18n.t('ACTIVITY.COLUMN.RESOURCE'),
      hideNarrow: true,
      cell: (row) => (row.resource === null ? '' : row.resource.type),
    },
    {
      key: 'requestId',
      header: this.i18n.t('ACTIVITY.COLUMN.REQUEST_ID'),
      hideNarrow: true,
      cell: (row) => row.requestId ?? '',
    },
  ]);
  protected readonly rowKey = (row: ActivityEntry): string => row.id;
  protected readonly abbreviate = abbreviateId;

  protected categoryTone(row: ActivityEntry): BadgeTone {
    return CATEGORY_TONES[row.category];
  }

  protected outcomeTone(row: ActivityEntry): BadgeTone {
    return OUTCOME_TONES[row.outcome];
  }

  protected categoryLabel(row: ActivityEntry): string {
    return this.i18n.t(`ACTIVITY.CATEGORY.${row.category.toUpperCase()}`);
  }

  protected outcomeLabel(row: ActivityEntry): string {
    return this.i18n.t(`ACTIVITY.OUTCOME.${row.outcome.toUpperCase()}`);
  }

  protected actionLabel(row: ActivityEntry): string {
    return ACTIVITY_ACTIONS.includes(row.action)
      ? this.i18n.t(actionLabelKey(row.action))
      : row.action;
  }

  protected actorName(row: ActivityEntry): string {
    const { kind, username, id, role } = row.actor;
    if (kind === 'user') {
      // A higher-ranked actor is hidden by the server: only the role is left.
      return (
        username ??
        (id === null ? (role === null ? '' : this.i18n.t(`ROLE.${role}`)) : abbreviateId(id))
      );
    }
    return this.i18n.t(`ACTIVITY.ACTOR.${kind.toUpperCase()}`);
  }

  protected canFilterActor(row: ActivityEntry): boolean {
    return row.actor.kind === 'user' && row.actor.id !== null;
  }

  protected rowLabel(key: string, row: ActivityEntry): string {
    return this.i18n.t(key, { action: this.actionLabel(row), date: this.date(row.at) });
  }

  protected openDetails(row: ActivityEntry): void {
    this.selected.set(row);
    this.detailOpen.set(true);
  }

  protected filterByActor(row: ActivityEntry): void {
    this.change({ actorId: row.actor.id });
  }

  protected clearActor(): void {
    this.change({ actorId: null });
  }

  protected onSelect(name: 'category' | 'outcome' | 'action', value: string): void {
    this.change({ [name]: value === '' ? null : value });
  }

  protected onDate(name: 'from' | 'to', value: string): void {
    this.change({ [name]: value === '' ? null : value });
  }

  protected onRequestId(text: string): void {
    this.requestText.set(text);
    this.debouncer.schedule(() =>
      this.change({ requestId: text.trim() === '' ? null : text.trim() }),
    );
  }

  protected onGroupFilter(checked: boolean): void {
    this.change({ groupId: checked ? this.groups.groupId() : null });
  }

  protected onLimit(limit: number): void {
    this.change({ limit: String(limit) });
  }

  protected onNext(cursor: string): void {
    this.cursorStack.update((stack) => [...stack, this.cursor() ?? null]);
    void this.navigate({ cursor });
  }

  protected onPrevious(): void {
    const stack = this.cursorStack();
    this.cursorStack.set(stack.slice(0, -1));
    void this.navigate({ cursor: stack[stack.length - 1] });
  }

  /** Changes a filter: the first page is shown again. */
  private change(change: QueryChange): void {
    this.cursorStack.set([]);
    void this.navigate({ ...change, cursor: null });
  }

  private navigate(change: QueryChange): Promise<boolean> {
    return this.router.navigate([], {
      relativeTo: this.route,
      queryParams: change,
      queryParamsHandling: 'merge',
    });
  }

  private date(value: string): string {
    return formatDate(value, this.i18n.language() ?? DEFAULT_LANGUAGE, {
      dateStyle: 'short',
      timeStyle: 'medium',
    });
  }
}
