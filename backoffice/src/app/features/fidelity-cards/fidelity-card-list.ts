import { httpResource } from '@angular/common/http';
import { Component, computed, inject, input, linkedSignal, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ApiData, ApiPage } from '../../core/api/api.types';
import { apiErrorMessageKey } from '../../core/api/api-error';
import { Can } from '../../core/auth/can';
import { formatDate, formatMoney, formatNumber } from '../../core/i18n/format';
import { I18nService } from '../../core/i18n/i18n.service';
import { DEFAULT_LANGUAGE } from '../../core/i18n/language';
import { TPipe } from '../../core/i18n/t-pipe';
import { SessionService } from '../../core/session/session.service';
import { CursorPaginator } from '../../shared/ui/cursor-paginator/cursor-paginator';
import { DataTable } from '../../shared/ui/data-table/data-table';
import { TableColumn, TableSort } from '../../shared/ui/data-table/data-table.types';
import { CellTemplate } from '../../shared/ui/data-table/table-templates';
import { ErrorState } from '../../shared/ui/error-state/error-state';
import { Select, SelectOption } from '../../shared/ui/select/select';
import { StatusBadge } from '../../shared/ui/status-badge/status-badge';
import { TextField } from '../../shared/ui/text-field/text-field';
import { createDebouncer } from '../../shared/util/debouncer';
import { xlsxToolRoute } from '../catalog-xlsx/xlsx-tools';
import { contactRoute } from '../contacts/contact.types';
import { CardType } from '../groups/catalogs/catalog.types';
import { apiErrorOf } from '../profile/sessions';
import { FidelityCardApi } from './fidelity-card-api';
import { FidelityCardRow, fidelityCardRoute } from './fidelity-card.types';

const PAGE_SIZES = [10, 25, 50, 100];
const DEFAULT_LIMIT = 25;
const SORT_KEYS = ['code', 'createdAt', 'updatedAt'];
const DEFAULT_SORT = 'code';
const OBJECT_ID = /^[0-9a-f]{24}$/;

/**
 * The advanced loyalty cards of a group (`/groups/:groupId/fidelity/cards`): number, type, the
 * first customer that has the code (with "+N" for the others), the credit (only for a prepaid
 * type), the points (only for a type that collects them), the creation date and the state (with
 * text, not only colour). The search (the exact code or part of the name of a customer), the type,
 * the state, the sort and the cursor pagination live in the URL; a search the server could not
 * finish in time (`503`) asks to narrow the text. Whoever may update the cards creates one.
 */
@Component({
  selector: 'fc-fidelity-card-list',
  imports: [
    Can,
    CellTemplate,
    CursorPaginator,
    DataTable,
    ErrorState,
    RouterLink,
    Select,
    StatusBadge,
    TextField,
    TPipe,
  ],
  templateUrl: './fidelity-card-list.html',
  styleUrl: './fidelity-card-list.css',
})
export class FidelityCardList {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(FidelityCardApi);
  private readonly session = inject(SessionService);
  private readonly debouncer = createDebouncer();
  protected readonly i18n = inject(I18nService);

  /** Route parameter and query parameters (bound by the router). */
  readonly groupId = input.required<string>();
  readonly q = input<string>();
  readonly cardTypeId = input<string>();
  readonly enabled = input<string>();
  readonly sort = input<string>();
  readonly limit = input<string>();
  readonly cursor = input<string>();

  protected readonly sortValue = computed(() => {
    const value = this.sort() ?? '';
    return SORT_KEYS.some((key) => value === key || value === `-${key}`) ? value : DEFAULT_SORT;
  });
  protected readonly tableSort = computed<TableSort>(() => {
    const value = this.sortValue();
    return value.startsWith('-')
      ? { key: value.slice(1), direction: 'desc' }
      : { key: value, direction: 'asc' };
  });
  protected readonly pageSize = computed(() => {
    const value = Number(this.limit());
    return PAGE_SIZES.includes(value) ? value : DEFAULT_LIMIT;
  });
  protected readonly typeValue = computed(() =>
    OBJECT_ID.test(this.cardTypeId() ?? '') ? (this.cardTypeId() as string) : '',
  );
  protected readonly stateValue = computed(() =>
    this.enabled() === 'true' || this.enabled() === 'false' ? (this.enabled() as string) : '',
  );
  protected readonly searchText = linkedSignal(() => this.q() ?? '');
  protected readonly cursorStack = signal<readonly (string | null)[]>([]);
  /** The user may open contacts: without it the customers are only names. */
  protected readonly canReadContacts = computed(() => this.session.can('contacts:read'));
  protected readonly newRoute = computed(() => fidelityCardRoute(this.groupId(), null));
  protected readonly importExportRoute = computed(() => xlsxToolRoute('cards', this.groupId()));

  protected readonly entries = httpResource<ApiPage<FidelityCardRow>>(() => {
    const params: Record<string, string | number> = {
      limit: this.pageSize(),
      sort: this.sortValue(),
    };
    const filters: Record<string, string | undefined> = {
      q: this.q()?.trim(),
      cardTypeId: this.typeValue(),
      enabled: this.stateValue(),
      cursor: this.cursor(),
    };
    for (const [name, value] of Object.entries(filters)) {
      if (value) {
        params[name] = value;
      }
    }
    return { url: this.api.baseUrl(this.groupId()), params };
  });

  /** The card types of the group, to filter by and to know which cards have a credit or points (a failure leaves them empty). */
  private readonly typesResource = httpResource<ApiData<CardType[]>>(
    () => `/v1/groups/${encodeURIComponent(this.groupId())}/fidelity/card-types`,
  );
  private readonly types = computed(() =>
    this.typesResource.hasValue() ? this.typesResource.value().data : [],
  );
  private readonly currencies = httpResource<ApiData<{ code: string }[]>>(
    () => `/v1/groups/${encodeURIComponent(this.groupId())}/lookup/currencies`,
  );
  private readonly currency = computed(() =>
    this.currencies.hasValue() ? (this.currencies.value().data[0]?.code ?? 'EUR') : 'EUR',
  );
  protected readonly typeOptions = computed<SelectOption[]>(() => [
    { value: '', label: this.i18n.t('FIDELITY_CARDS.FILTER.ALL_TYPES') },
    ...this.types().map((type) => ({ value: type.id, label: type.name })),
  ]);
  protected readonly stateOptions = computed<SelectOption[]>(() => [
    { value: '', label: this.i18n.t('FIDELITY_CARDS.STATE.ALL') },
    { value: 'true', label: this.i18n.t('FIDELITY_CARDS.STATE.ENABLED') },
    { value: 'false', label: this.i18n.t('FIDELITY_CARDS.STATE.DISABLED') },
  ]);

  protected readonly rows = computed(() =>
    this.entries.hasValue() ? this.entries.value().data : [],
  );
  protected readonly nextCursor = computed(() =>
    this.entries.hasValue() ? this.entries.value().page.next : null,
  );
  protected readonly loadError = computed(() => apiErrorOf(this.entries.error()));
  protected readonly errorMessage = computed(() => {
    const error = this.loadError();
    if (error?.code === 'SERVICE_UNAVAILABLE') {
      return this.i18n.t('FIDELITY_CARDS.LIST.TOO_SLOW');
    }
    return this.i18n.t(error === null ? 'ERRORS.GENERIC.MESSAGE' : apiErrorMessageKey(error));
  });
  private readonly language = computed(() => this.i18n.language() ?? DEFAULT_LANGUAGE);
  private readonly none = computed(() => this.i18n.t('FIDELITY_CARDS.LIST.NONE'));

  protected readonly columns = computed<TableColumn<FidelityCardRow>[]>(() => {
    const col = (key: string) => this.i18n.t(`FIDELITY_CARDS.COLUMN.${key}`);
    return [
      { key: 'code', header: col('CODE'), sortable: true },
      {
        key: 'type',
        header: col('TYPE'),
        cell: (row) =>
          row.cardType === null
            ? this.i18n.t('FIDELITY_CARDS.TYPE_GONE')
            : (row.cardType.name ?? ''),
      },
      { key: 'customer', header: col('CUSTOMER') },
      {
        key: 'balance',
        header: col('BALANCE'),
        align: 'end',
        cell: (row) => this.balanceText(row),
      },
      {
        key: 'points',
        header: col('POINTS'),
        align: 'end',
        hideNarrow: true,
        cell: (row) => this.pointsText(row),
      },
      {
        key: 'createdAt',
        header: col('CREATED'),
        sortable: true,
        hideNarrow: true,
        cell: (row) => (row.createdAt === null ? '' : formatDate(row.createdAt, this.language())),
      },
      { key: 'enabled', header: col('STATE') },
    ];
  });
  protected readonly rowKey = (row: FidelityCardRow): string => row.id;

  protected detailRoute(row: FidelityCardRow): string[] {
    return fidelityCardRoute(this.groupId(), row.id);
  }

  protected contactRoute(id: string): string[] {
    return contactRoute(this.groupId(), id);
  }

  /** The name of the first customer of a row (a contact without a name is "customer"). */
  protected customerName(row: FidelityCardRow): string {
    return row.contact?.displayName ?? this.i18n.t('FIDELITY_CARDS.LIST.CUSTOMER');
  }

  /** The credit of a card of a prepaid type, a dash for any other (a type that is gone has no credit to show). */
  private balanceText(row: FidelityCardRow): string {
    const prepaid =
      this.types().find((type) => type.id === row.cardType?.id)?.prepaid.enabled === true;
    return prepaid && row.balance !== null
      ? formatMoney(Math.round(row.balance * 100), this.currency(), this.language())
      : this.none();
  }

  /** The points of a card of a type that collects them, a dash for any other. */
  private pointsText(row: FidelityCardRow): string {
    const collects =
      this.types().find((type) => type.id === row.cardType?.id)?.pointsCollect.enabled === true;
    return collects
      ? formatNumber(row.totalPoints, this.language(), { maximumFractionDigits: 0 })
      : this.none();
  }

  protected reload(): void {
    this.entries.reload();
  }

  protected onSearch(text: string): void {
    this.searchText.set(text);
    this.debouncer.schedule(() => this.change({ q: text.trim() === '' ? null : text.trim() }));
  }

  protected onType(value: string): void {
    this.change({ cardTypeId: value === '' ? null : value });
  }

  protected onState(value: string): void {
    this.change({ enabled: value === '' ? null : value });
  }

  protected onSort(sort: TableSort): void {
    this.change({ sort: sort.direction === 'desc' ? `-${sort.key}` : sort.key });
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

  private change(change: Record<string, string | null>): void {
    this.cursorStack.set([]);
    void this.navigate({ ...change, cursor: null });
  }

  private navigate(change: Record<string, string | null | undefined>): Promise<boolean> {
    return this.router.navigate([], {
      relativeTo: this.route,
      queryParams: change,
      queryParamsHandling: 'merge',
    });
  }
}
