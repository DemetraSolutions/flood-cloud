import { httpResource } from '@angular/common/http';
import { Component, computed, inject, input, signal } from '@angular/core';
import { ApiPage } from '../../core/api/api.types';
import { apiErrorMessageKey } from '../../core/api/api-error';
import { formatDate, formatNumber } from '../../core/i18n/format';
import { I18nService } from '../../core/i18n/i18n.service';
import { DEFAULT_LANGUAGE } from '../../core/i18n/language';
import { TPipe } from '../../core/i18n/t-pipe';
import { CursorPaginator } from '../../shared/ui/cursor-paginator/cursor-paginator';
import { DataTable } from '../../shared/ui/data-table/data-table';
import { TableColumn } from '../../shared/ui/data-table/data-table.types';
import { ErrorState } from '../../shared/ui/error-state/error-state';
import { apiErrorOf } from '../profile/sessions';
import { FidelityCardApi } from './fidelity-card-api';
import { CardMovement, MOVEMENT_TYPES } from './fidelity-card.types';

/**
 * The history of a card (`GET …/movements`, the most recent first): date and time, type (manual,
 * import, sale, canceled sale; any other as "other"), the collection, the points and the credit with
 * their sign and the operator, with the cursor pagination. It reads again when `refresh` changes
 * (after an adjustment).
 */
@Component({
  selector: 'fc-fidelity-card-movements',
  imports: [CursorPaginator, DataTable, ErrorState, TPipe],
  templateUrl: './fidelity-card-movements.html',
})
export class FidelityCardMovements {
  private readonly api = inject(FidelityCardApi);
  private readonly i18n = inject(I18nService);

  readonly groupId = input.required<string>();
  readonly cardId = input.required<string>();
  /** Changes when the history has to be read again. */
  readonly refresh = input(0);

  protected readonly limit = signal(25);
  protected readonly cursor = signal<string | null>(null);
  protected readonly cursorStack = signal<readonly (string | null)[]>([]);

  protected readonly entries = httpResource<ApiPage<CardMovement>>(() => {
    this.refresh();
    const params: Record<string, string | number> = { limit: this.limit() };
    const cursor = this.cursor();
    if (cursor !== null) {
      params['cursor'] = cursor;
    }
    return { url: this.api.movementsUrl(this.groupId(), this.cardId()), params };
  });
  protected readonly rows = computed(() =>
    this.entries.hasValue() ? this.entries.value().data : [],
  );
  protected readonly nextCursor = computed(() =>
    this.entries.hasValue() ? this.entries.value().page.next : null,
  );
  protected readonly loadError = computed(() => apiErrorOf(this.entries.error()));
  protected readonly errorMessage = computed(() => {
    const error = this.loadError();
    return this.i18n.t(error === null ? 'ERRORS.GENERIC.MESSAGE' : apiErrorMessageKey(error));
  });
  private readonly language = computed(() => this.i18n.language() ?? DEFAULT_LANGUAGE);

  protected readonly columns = computed<TableColumn<CardMovement>[]>(() => {
    const col = (key: string) => this.i18n.t(`FIDELITY_CARDS.MOVEMENT.${key}`);
    return [
      {
        key: 'date',
        header: col('DATE'),
        cell: (row) =>
          row.date === null
            ? ''
            : formatDate(row.date, this.language(), { dateStyle: 'medium', timeStyle: 'short' }),
      },
      {
        key: 'type',
        header: col('TYPE'),
        cell: (row) =>
          this.i18n.t(
            `FIDELITY_CARDS.MOVEMENT.TYPE_${row.type !== null && (MOVEMENT_TYPES as readonly string[]).includes(row.type) ? row.type.toUpperCase() : 'OTHER'}`,
          ),
      },
      {
        key: 'collection',
        header: col('COLLECTION'),
        hideNarrow: true,
        cell: (row) => (row.collection === null ? '' : (row.collection.name ?? '')),
      },
      {
        key: 'points',
        header: col('POINTS'),
        align: 'end',
        cell: (row) => this.signed(row.points, 0),
      },
      {
        key: 'balance',
        header: col('BALANCE'),
        align: 'end',
        cell: (row) => this.signed(row.balance, 2),
      },
      {
        key: 'operator',
        header: col('OPERATOR'),
        hideNarrow: true,
        cell: (row) => this.operatorText(row),
      },
    ];
  });
  protected readonly rowKey = (row: CardMovement): string => row.id;

  /** A dash for no operator, the integration's name for an API key, the user's name otherwise. */
  private operatorText(row: CardMovement): string {
    if (row.operator === null) {
      return '–';
    }
    const name = row.operator.name ?? '';
    if (row.operator.kind === 'apiKey') {
      return this.i18n.t('FIDELITY_CARDS.MOVEMENT.INTEGRATION', { name });
    }
    return row.operator.store === true
      ? this.i18n.t('FIDELITY_CARDS.MOVEMENT.STORE_OPERATOR', { name })
      : name;
  }

  protected reload(): void {
    this.entries.reload();
  }

  protected onLimit(limit: number): void {
    this.limit.set(limit);
    this.cursor.set(null);
    this.cursorStack.set([]);
  }

  protected onNext(cursor: string): void {
    this.cursorStack.update((stack) => [...stack, this.cursor()]);
    this.cursor.set(cursor);
  }

  protected onPrevious(): void {
    const stack = this.cursorStack();
    this.cursorStack.set(stack.slice(0, -1));
    this.cursor.set(stack[stack.length - 1]);
  }

  /** A number with its sign (`+5`, `-2`), empty for none. */
  private signed(value: number | null, digits: number): string {
    if (value === null) {
      return '';
    }
    return formatNumber(value, this.language(), {
      signDisplay: 'exceptZero',
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  }
}
