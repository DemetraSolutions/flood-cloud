import { httpResource } from '@angular/common/http';
import { Component, computed, inject, input, linkedSignal, resource, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiData, ApiPage } from '../../core/api/api.types';
import { apiErrorMessageKey } from '../../core/api/api-error';
import { GroupFeatures } from '../../core/groups/group-features';
import { formatDate, formatMoney, formatNumber } from '../../core/i18n/format';
import { I18nService } from '../../core/i18n/i18n.service';
import { DEFAULT_LANGUAGE } from '../../core/i18n/language';
import { TPipe } from '../../core/i18n/t-pipe';
import { ReferenceApi } from '../../core/reference/reference-api';
import { ReferenceStore } from '../../core/reference/reference-store';
import { NonFiscalMode } from '../../core/sales/non-fiscal-mode';
import { CursorPaginator } from '../../shared/ui/cursor-paginator/cursor-paginator';
import { DataTable } from '../../shared/ui/data-table/data-table';
import { TableColumn } from '../../shared/ui/data-table/data-table.types';
import { CellTemplate } from '../../shared/ui/data-table/table-templates';
import { ErrorState } from '../../shared/ui/error-state/error-state';
import { Select, SelectOption } from '../../shared/ui/select/select';
import { StatusBadge } from '../../shared/ui/status-badge/status-badge';
import { TextField } from '../../shared/ui/text-field/text-field';
import { abbreviateId } from '../activity-log/activity-log.types';
import { loadAll } from '../places/lookup-loader';
import { apiErrorOf } from '../profile/sessions';
import { loadSaleNames, SaleNames } from '../sales/sale-names';
import {
  badgeText,
  receiptLabel,
  SaleBadge,
  saleBadges,
  SaleFilter,
  saleParams,
  SaleRow,
  saleRoute,
  SaleSummary,
} from '../sales/sale.types';

/**
 * The purchases of a contact: the sales that carry it as customer (`GET …/sales?contactId=`) with
 * their totals (`…/sales/summary`) as tiles (sold, number of sales, average receipt and, when
 * there are any, refunds), newest first with the cursor pagination. The period is optional (a
 * contact's sales have no bound) and, when set, goes to the server with both ends; the store
 * narrows it. Each sale opens its own page. The table has a table column only for a group with
 * the `rooms` function. Every read follows the UM mode: it asks for the non fiscal sales
 * ("Preventivo") only while the mode is on, and the tab reads again when the mode changes.
 */
@Component({
  selector: 'fc-contact-purchases',
  imports: [CellTemplate, CursorPaginator, DataTable, ErrorState, RouterLink, Select, StatusBadge, TextField, TPipe],
  templateUrl: './contact-purchases.html',
  styleUrl: './contact-purchases.css',
})
export class ContactPurchases {
  private readonly i18n = inject(I18nService);
  private readonly mode = inject(NonFiscalMode);
  private readonly features = inject(GroupFeatures);
  private readonly reference = inject(ReferenceApi);
  private readonly store = inject(ReferenceStore);

  readonly groupId = input.required<string>();
  readonly contactId = input.required<string>();
  /** Currency of the amounts (the first of the group). */
  readonly currency = input('EUR');

  // The filters.
  protected readonly from = signal('');
  protected readonly to = signal('');
  protected readonly placeId = signal('');
  protected readonly rangeError = computed(() => this.from() !== '' && this.to() !== '' && this.from() > this.to());
  private readonly filter = computed<SaleFilter>(() => ({
    contactId: this.contactId(),
    placeId: this.placeId(),
    from: this.from(),
    to: this.to(),
  }));
  /** What the reads send, `null` while the period is not valid. */
  private readonly params = computed(() => (this.rangeError() ? null : saleParams(this.filter(), this.mode.nonFiscalVisible())));

  private readonly places = resource({
    params: () => this.groupId(),
    loader: ({ params }) => loadAll(this.store, params, 'places'),
  });
  protected readonly placeOptions = computed<SelectOption[]>(() =>
    (this.places.hasValue() ? this.places.value() : []).map((place) => ({ value: place.id, label: place.name })),
  );

  // The pages: back to the first one when the filters or the UM mode change.
  protected readonly limit = signal(25);
  private readonly scope = computed(() => `${this.groupId()}|${JSON.stringify(this.params())}`);
  protected readonly cursor = linkedSignal<string, string | null>({ source: this.scope, computation: () => null });
  protected readonly cursorStack = linkedSignal<string, readonly (string | null)[]>({ source: this.scope, computation: () => [] });

  private readonly baseUrl = computed(() => `/v1/groups/${encodeURIComponent(this.groupId())}/sales`);
  protected readonly summary = httpResource<ApiData<SaleSummary>>(() => {
    const params = this.params();
    return params === null ? undefined : { url: `${this.baseUrl()}/summary`, params };
  });
  protected readonly entries = httpResource<ApiPage<SaleRow>>(() => {
    const params = this.params();
    if (params === null) {
      return undefined;
    }
    const cursor = this.cursor();
    return {
      url: this.baseUrl(),
      params: { ...params, limit: this.limit(), ...(cursor === null ? {} : { cursor }) },
    };
  });
  protected readonly rows = computed(() => (this.entries.hasValue() ? this.entries.value().data : []));
  protected readonly nextCursor = computed(() => (this.entries.hasValue() ? this.entries.value().page.next : null));
  protected readonly totals = computed(() => (this.summary.hasValue() ? this.summary.value().data : null));

  // The names of the companies and stores of the rows.
  private readonly namesRead = resource({
    params: () => (this.rows().length === 0 ? undefined : { groupId: this.groupId(), rows: this.rows() }),
    loader: ({ params }) => loadSaleNames(this.reference, params.groupId, params.rows),
  });
  private readonly names = computed(() => (this.namesRead.hasValue() ? this.namesRead.value() : null));

  // The failure of either read.
  protected readonly failed = computed(() => this.entries.error() !== undefined || this.summary.error() !== undefined);
  protected readonly loadError = computed(() => apiErrorOf(this.entries.error() ?? this.summary.error()));
  protected readonly errorMessage = computed(() => {
    const error = this.loadError();
    if (error?.code === 'SERVICE_UNAVAILABLE') {
      return this.i18n.t('SALES.TOO_SLOW');
    }
    return this.i18n.t(error === null ? 'ERRORS.GENERIC.MESSAGE' : apiErrorMessageKey(error));
  });
  protected readonly loading = computed(() => this.entries.isLoading());

  private readonly language = computed(() => this.i18n.language() ?? DEFAULT_LANGUAGE);
  protected readonly hasRooms = computed(() => this.features.enabledFor(this.groupId(), 'rooms'));

  /** The tiles: the amounts in the currency of the group, the refunds only when there are some. */
  protected readonly tiles = computed(() => {
    const totals = this.totals();
    if (totals === null) {
      return [];
    }
    const tile = (key: string, value: string) => ({ key, label: this.i18n.t(`SALES.TILE.${key}`), value });
    return [
      tile('SOLD', this.money(totals.total)),
      tile('COUNT', formatNumber(totals.count, this.language())),
      tile('AVERAGE', this.money(totals.average)),
      ...(totals.refunded > 0 ? [tile('REFUNDED', this.money(totals.refunded))] : []),
    ];
  });

  protected readonly columns = computed<TableColumn<SaleRow>[]>(() => {
    const col = (key: string) => this.i18n.t(`SALES.COLUMN.${key}`);
    const date = (row: SaleRow, options: Intl.DateTimeFormatOptions) =>
      row.date === null ? '' : formatDate(row.date, this.language(), options);
    return [
      { key: 'number', header: col('NUMBER') },
      { key: 'date', header: col('DATE'), cell: (row) => date(row, { dateStyle: 'medium' }) },
      { key: 'time', header: col('TIME'), hideNarrow: true, cell: (row) => date(row, { timeStyle: 'short' }) },
      { key: 'total', header: col('TOTAL'), align: 'end', cell: (row) => this.money(row.total) },
      { key: 'company', header: col('COMPANY'), hideNarrow: true, cell: (row) => this.nameOf('companies', row.companyId) },
      { key: 'place', header: col('PLACE'), hideNarrow: true, cell: (row) => this.nameOf('places', row.placeId) },
      { key: 'cashDesk', header: col('CASH_DESK'), hideNarrow: true, cell: (row) => row.cashDesk ?? '' },
      { key: 'operator', header: col('OPERATOR'), hideNarrow: true, cell: (row) => row.operator?.name ?? '' },
      ...(this.hasRooms()
        ? [{ key: 'table', header: col('TABLE'), hideNarrow: true, cell: (row: SaleRow) => row.table ?? '' }]
        : []),
    ];
  });
  protected readonly rowKey = (row: SaleRow): string => row.id;

  protected saleLink(row: SaleRow): string[] {
    return saleRoute(this.groupId(), row.id);
  }

  /** `report-number` of the receipt, or a text for a sale without one. */
  protected numberText(row: SaleRow): string {
    return receiptLabel(row.number) || this.i18n.t('SALES.NO_NUMBER');
  }

  protected badgesOf(row: SaleRow): SaleBadge[] {
    return saleBadges(row);
  }

  protected badgeLabel(badge: SaleBadge): string {
    return badgeText((key, params) => this.i18n.t(key, params), badge);
  }

  protected reload(): void {
    this.entries.reload();
    this.summary.reload();
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

  private money(value: number): string {
    return formatMoney(Math.round(value * 100), this.currency(), this.language());
  }

  /** The name of a company or store, the short id while the names are not known to the user, `''` while they are read. */
  private nameOf(kind: keyof SaleNames, id: string | null): string {
    const names = this.names();
    if (id === null || names === null) {
      return '';
    }
    return names[kind][id] ?? abbreviateId(id);
  }
}
