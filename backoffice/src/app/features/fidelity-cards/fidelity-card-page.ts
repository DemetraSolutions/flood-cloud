import { httpResource } from '@angular/common/http';
import {
  afterNextRender,
  Component,
  computed,
  inject,
  Injector,
  input,
  linkedSignal,
  resource,
  signal,
} from '@angular/core';
import {
  disabled,
  form,
  FormField,
  ReadonlyFieldTree,
  submit,
  TreeValidationResult,
  validate,
} from '@angular/forms/signals';
import { Router, RouterLink } from '@angular/router';
import { ApiData } from '../../core/api/api.types';
import { ApiError, apiErrorMessageKey } from '../../core/api/api-error';
import { issueMessageKey } from '../../core/api/field-issues';
import { formatDate, formatMoney, formatNumber } from '../../core/i18n/format';
import { I18nService } from '../../core/i18n/i18n.service';
import { DEFAULT_LANGUAGE } from '../../core/i18n/language';
import { TPipe } from '../../core/i18n/t-pipe';
import { SessionService } from '../../core/session/session.service';
import {
  failureMessage,
  fieldErrorMessage,
  focusFirstError,
  serverFieldErrors,
} from '../../shared/forms/form-errors';
import { Button } from '../../shared/ui/button/button';
import { Checkbox } from '../../shared/ui/checkbox/checkbox';
import { ConfirmDialog } from '../../shared/ui/confirm-dialog/confirm-dialog';
import { ErrorState } from '../../shared/ui/error-state/error-state';
import { FormError } from '../../shared/ui/form-error/form-error';
import { PageHeader } from '../../shared/ui/page-header/page-header';
import { SearchCombobox, SearchOption } from '../../shared/ui/search-combobox/search-combobox';
import { Select, SelectOption } from '../../shared/ui/select/select';
import { StatusBadge } from '../../shared/ui/status-badge/status-badge';
import { TabItem, TabList } from '../../shared/ui/tab-list/tab-list';
import { TextField } from '../../shared/ui/text-field/text-field';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { IdempotencyKey } from '../../shared/util/idempotency';
import { isStale, resolveField } from '../companies/company-errors';
import { withCurrent } from '../companies/company-options';
import { ContactApi } from '../contacts/contact-api';
import { contactRoute } from '../contacts/contact.types';
import { CardType, PointsCollection } from '../groups/catalogs/catalog.types';
import { RecordGroup } from '../groups/record-group';
import { Versioned } from '../product-catalog/product-catalog.types';
import { apiErrorOf } from '../profile/sessions';
import { FidelityCardAdjustDialog } from './fidelity-card-adjust-dialog';
import { FidelityCardApi } from './fidelity-card-api';
import { FidelityCardMovements } from './fidelity-card-movements';
import {
  balanceIssue,
  CardModel,
  codeIssue,
  createBody,
  initialRows,
  modelChanged,
  patchBody,
  pointsIssue,
  toModel,
} from './fidelity-card-model';
import { FIDELITY_CARD_LIMITS, FidelityCard, fidelityCardRoute } from './fidelity-card.types';

/** Fewest characters that start the search of a customer. */
export const CUSTOMER_SEARCH_MIN_CHARS = 3;

/** The tabs of the page. */
export const CARD_SECTIONS = ['general', 'movements'] as const;

/** A tab of the page. */
export type CardSection = (typeof CARD_SECTIONS)[number];

/**
 * One advanced loyalty card of a group (`/groups/:groupId/fidelity/cards/:cardId`, or `new`) with
 * the tabs General and Movements (the second only for a card that exists). General: the state, the
 * code (typed for a new card, then text that cannot change), the type, and, for a card that exists,
 * the read only balances (credit for a prepaid type, points for each collection, with a mark for a
 * collection that is not active) with the adjustment dialog, and the customers that have the code
 * (the link is the code in the card list of the contact). A new card also takes the initial credit
 * (prepaid type), the initial points of the collections of its type and up to 20 customers; changing
 * the type clears the values it no longer allows. One save sends the type and the state with the
 * version read in `If-Match` (`412` asks to reload); the creation presents an `Idempotency-Key`.
 * Deleting is only possible for a card with no history and no customers (`409` says to deactivate
 * it). Without `fidelity:update` the page is read only; the adjustment never touches the form.
 */
@Component({
  selector: 'fc-fidelity-card-page',
  imports: [
    Button,
    Checkbox,
    ConfirmDialog,
    ErrorState,
    FidelityCardAdjustDialog,
    FidelityCardMovements,
    FormError,
    FormField,
    PageHeader,
    RecordGroup,
    RouterLink,
    SearchCombobox,
    Select,
    StatusBadge,
    TabList,
    TextField,
    TPipe,
  ],
  templateUrl: './fidelity-card-page.html',
  styleUrl: './fidelity-card-page.css',
})
export class FidelityCardPage {
  private readonly api = inject(FidelityCardApi);
  private readonly contacts = inject(ContactApi);
  private readonly session = inject(SessionService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  private readonly injector = inject(Injector);
  private readonly key = new IdempotencyKey();
  protected readonly i18n = inject(I18nService);

  /** Route parameters (bound by the router); no `cardId` on the page of a new card. */
  readonly groupId = input.required<string>();
  readonly cardId = input<string>();

  protected readonly isNew = computed(() => this.cardId() === undefined);
  protected readonly listRoute = computed(() => fidelityCardRoute(this.groupId()));
  protected readonly canWrite = computed(() => this.session.can('fidelity:update'));
  /** The user may open contacts: without it the customers are only names and none can be searched. */
  protected readonly canReadContacts = computed(() => this.session.can('contacts:read'));
  protected readonly minChars = CUSTOMER_SEARCH_MIN_CHARS;
  protected readonly maxCustomers = FIDELITY_CARD_LIMITS.contacts;

  private readonly loaded = resource({
    params: () => {
      const cardId = this.cardId();
      return cardId === undefined ? undefined : { groupId: this.groupId(), cardId };
    },
    loader: ({ params }) => this.api.read(params.groupId, params.cardId),
  });
  /** The card as the server has it, and its version; replaced by every save. */
  private readonly saved = linkedSignal<
    Versioned<FidelityCard> | undefined,
    Versioned<FidelityCard> | null
  >({
    // `value()` throws while the resource is in error: read it only when there is one.
    source: () => (this.loaded.hasValue() ? this.loaded.value() : undefined),
    computation: (value) => value ?? null,
  });
  protected readonly item = computed(() => this.saved()?.item ?? null);
  /** The card the balances are read from: the saved one, or the answer of the last adjustment (which never touches the form). */
  protected readonly figures = linkedSignal<FidelityCard | null>(() => this.item());
  protected readonly loading = computed(() => !this.isNew() && this.loaded.isLoading());
  protected readonly failed = computed(() => this.loaded.error() !== undefined);
  protected readonly loadError = computed(() => apiErrorOf(this.loaded.error()));
  protected readonly loadErrorMessage = computed(() => {
    const error = this.loadError();
    return this.i18n.t(error === null ? 'ERRORS.GENERIC.MESSAGE' : apiErrorMessageKey(error));
  });

  // The catalogs the card refers to.
  private readonly typesResource = httpResource<ApiData<CardType[]>>(
    () => `/v1/groups/${encodeURIComponent(this.groupId())}/fidelity/card-types`,
  );
  private readonly collectionsResource = httpResource<ApiData<PointsCollection[]>>(
    () => `/v1/groups/${encodeURIComponent(this.groupId())}/fidelity/points-collections`,
  );
  private readonly currencies = httpResource<ApiData<{ code: string }[]>>(
    () => `/v1/groups/${encodeURIComponent(this.groupId())}/lookup/currencies`,
  );
  private readonly types = computed(() =>
    this.typesResource.hasValue() ? this.typesResource.value().data : [],
  );
  private readonly collectionNames = computed(
    () =>
      new Map(
        (this.collectionsResource.hasValue() ? this.collectionsResource.value().data : []).map(
          (collection) => [collection.id, collection.name],
        ),
      ),
  );
  protected readonly currency = computed(() =>
    this.currencies.hasValue() ? (this.currencies.value().data[0]?.code ?? 'EUR') : 'EUR',
  );
  private readonly language = computed(() => this.i18n.language() ?? DEFAULT_LANGUAGE);

  protected readonly model = linkedSignal<CardModel>(() => toModel(this.item()));
  private readonly base = computed(() => toModel(this.item()));
  /** The type chosen in the form. */
  protected readonly chosenType = computed(() =>
    this.types().find((type) => type.id === this.model().cardTypeId),
  );
  protected readonly typeOptions = computed<SelectOption[]>(() => {
    const listed = this.types().map((type) => ({ value: type.id, label: type.name }));
    return withCurrent(listed, this.model().cardTypeId, () =>
      this.i18n.t('FIDELITY_CARDS.TYPE_GONE'),
    );
  });
  /** A new card of a prepaid type takes an initial credit. */
  protected readonly askBalance = computed(
    () => this.isNew() && this.chosenType()?.prepaid.enabled === true,
  );
  /** A new card of a type that collects points takes initial points for each collection of the type. */
  protected readonly askPoints = computed(
    () => this.isNew() && this.model().initialPoints.length > 0,
  );

  protected readonly cardForm = form(this.model, (path) => {
    const kind = (issue: string | undefined) => (issue === undefined ? undefined : { kind: issue });
    validate(path.code, ({ value }) => (this.isNew() ? kind(codeIssue(value())) : undefined));
    validate(path.cardTypeId, ({ value }) => (value() === '' ? { kind: 'required' } : undefined));
    validate(path.initialBalance, ({ value }) =>
      this.askBalance() ? kind(balanceIssue(value())) : undefined,
    );
    validate(path.initialPoints, ({ value }) =>
      value().some((row) => pointsIssue(row.points) !== undefined)
        ? { kind: 'incorrect' }
        : undefined,
    );
    disabled(path, () => !this.canWrite());
  });

  /** What the server would receive: what differs from the saved card (everything, for a new one). */
  protected readonly body = computed(() =>
    this.item() === null
      ? createBody(this.model(), this.chosenType())
      : patchBody(this.model(), this.base()),
  );
  /** Whether the form differs from the saved card, or, for a new one, from the empty form. */
  protected readonly unsaved = computed(() =>
    this.item() === null
      ? modelChanged(this.model(), this.base())
      : Object.keys(this.body()).length > 0,
  );
  protected readonly failure = signal<string | null>(null);
  /** The version read is no longer the current one: the page offers to read again. */
  protected readonly stale = signal(false);
  protected readonly submitting = computed(() => this.cardForm().submitting());

  // The balances of a card that exists.
  protected readonly prepaid = computed(() => this.figures()?.cardType?.prepaid === true);
  protected readonly creditText = computed(() => {
    const balance = this.figures()?.balance;
    return balance === null || balance === undefined
      ? ''
      : formatMoney(Math.round(balance * 100), this.currency(), this.language());
  });
  protected readonly pointsRows = computed(() =>
    // Read only in the template of a card that exists, which has its figures.
    this.figures()!.points.map((points) => ({
      ...points,
      name: points.name ?? this.i18n.t('FIDELITY_CARDS.COLLECTION_GONE'),
      text: formatNumber(points.points, this.language(), { maximumFractionDigits: 0 }),
    })),
  );
  /** The collections of the type of the card, which the adjustment can move. */
  protected readonly adjustable = computed(() => {
    const card = this.figures();
    const type = this.types().find((candidate) => candidate.id === card?.cardTypeId);
    if (card?.cardType?.pointsCollect !== true || type === undefined) {
      return [];
    }
    return type.pointsCollect.collectionIds
      .filter((id) => this.collectionNames().has(id))
      .map((id) => ({ id, name: this.collectionNames().get(id) as string }));
  });
  protected readonly canAdjust = computed(
    () => this.canWrite() && !this.isNew() && (this.prepaid() || this.adjustable().length > 0),
  );
  protected readonly adjustOpen = signal(false);
  protected readonly movementsRefresh = signal(0);

  // The customers of a card that exists.
  protected readonly customers = computed(() =>
    this.item()!.contacts.map((contact) => ({
      id: contact.id,
      name: contact.displayName ?? this.i18n.t('FIDELITY_CARDS.CUSTOMER_UNNAMED'),
      route: contactRoute(this.groupId(), contact.id),
    })),
  );
  protected readonly moreCustomers = computed(() =>
    Math.max(0, this.item()!.contactsCount - this.item()!.contacts.length),
  );
  protected readonly searchCustomers = (text: string): Promise<readonly SearchOption[]> =>
    this.contacts.searchContacts(this.groupId(), text);

  // The tabs.
  protected readonly section = signal<CardSection>('general');
  protected readonly tabs = computed<TabItem[]>(() =>
    (this.isNew() ? CARD_SECTIONS.slice(0, 1) : CARD_SECTIONS).map((id) => ({
      id,
      label: this.i18n.t(`FIDELITY_CARDS.SECTION.${id.toUpperCase()}`),
    })),
  );

  // Deletion.
  protected readonly deleteOpen = signal(false);
  protected readonly busy = signal(false);
  protected readonly deleteMessage = computed(() =>
    this.i18n.t('FIDELITY_CARDS.DELETE.CONFIRM', { code: this.item()?.code ?? '' }),
  );

  // Leaving with unsaved changes.
  protected readonly leaveOpen = signal(false);
  private pendingLeave: ((leave: boolean) => void) | null = null;

  /**
   * Asked by the route guard when the user leaves the page: immediate when nothing is unsaved,
   * otherwise the user confirms in a dialog.
   *
   * @returns `true` to leave, `false` to stay.
   */
  confirmLeave(): boolean | Promise<boolean> {
    if (!this.canWrite() || !this.unsaved()) {
      return true;
    }
    this.leaveOpen.set(true);
    return new Promise<boolean>((resolve) => {
      this.pendingLeave = resolve;
    });
  }

  protected onLeave(): void {
    this.settle(true);
    this.leaveOpen.set(false);
  }

  /** The dialog was closed without confirming: stay. */
  protected onLeaveClosed(): void {
    this.leaveOpen.set(false);
    this.settle(false);
  }

  protected error(field: ReadonlyFieldTree<unknown>): string | null {
    return fieldErrorMessage(this.i18n, field());
  }

  protected date(value: string | null): string {
    return value === null
      ? ''
      : formatDate(value, this.language(), { dateStyle: 'medium', timeStyle: 'short' });
  }

  protected reload(): void {
    this.stale.set(false);
    this.failure.set(null);
    this.loaded.reload();
  }

  protected select(id: string): void {
    this.section.set(id as CardSection);
  }

  /** A new card changes type: the values the new type does not allow are cleared. */
  protected onType(id: string): void {
    if (!this.isNew()) {
      return;
    }
    const type = this.types().find((candidate) => candidate.id === id);
    this.model.update((model) => ({
      ...model,
      initialBalance: type?.prepaid.enabled === true ? model.initialBalance : '',
      initialPoints: initialRows(type, this.collectionNames()),
    }));
  }

  /** The issue of the initial points of a row, as text. */
  protected pointsError(text: string): string | null {
    const issue = pointsIssue(text);
    return issue === undefined ? null : this.i18n.t(issueMessageKey(issue));
  }

  protected setInitialPoints(index: number, points: string): void {
    this.model.update((model) => ({
      ...model,
      initialPoints: model.initialPoints.map((row, position) =>
        position === index ? { ...row, points } : row,
      ),
    }));
  }

  protected addCustomer(option: SearchOption | null): void {
    if (
      option === null ||
      this.model().customers.length >= this.maxCustomers ||
      this.model().customers.some((customer) => customer.id === option.value)
    ) {
      return;
    }
    this.model.update((model) => ({
      ...model,
      customers: [...model.customers, { id: option.value, name: option.label }],
    }));
  }

  protected removeCustomer(id: string): void {
    this.model.update((model) => ({
      ...model,
      customers: model.customers.filter((customer) => customer.id !== id),
    }));
  }

  /** The outcome of an adjustment is not known: the balances and the history are read again (the form keeps what was typed). */
  protected async onUncertain(): Promise<void> {
    this.movementsRefresh.update((count) => count + 1);
    try {
      this.figures.set((await this.api.read(this.groupId(), this.cardId() as string)).item);
    } catch (error) {
      this.toast.error(failureMessage(this.i18n, error));
    }
  }

  /** The balances after an adjustment: shown without reading the card again (the form keeps what was typed) and the history is read again. */
  protected onAdjusted(card: FidelityCard): void {
    this.figures.set(card);
    this.movementsRefresh.update((count) => count + 1);
  }

  protected async onSubmit(event: Event): Promise<void> {
    event.preventDefault();
    await submit(this.cardForm, {
      action: async () => {
        this.failure.set(null);
        this.stale.set(false);
        const wasNew = this.isNew();
        let result: Versioned<FidelityCard>;
        try {
          result = wasNew
            ? await this.api.create(this.groupId(), this.body(), this.key.forBody(this.body()))
            : await this.api.update(
                this.groupId(),
                this.cardId() as string,
                this.body(),
                (this.saved() as Versioned<FidelityCard>).etag,
              );
        } catch (error) {
          return this.reject(error);
        }
        this.key.reset();
        this.saved.set(result);
        this.toast.success(
          this.i18n.t(wasNew ? 'FIDELITY_CARDS.FORM.CREATED' : 'FIDELITY_CARDS.FORM.SAVED'),
        );
        if (wasNew) {
          await this.router.navigate(fidelityCardRoute(this.groupId(), result.item.id));
        }
        return undefined;
      },
      onInvalid: () =>
        afterNextRender(() => focusFirstError(this.cardForm), { injector: this.injector }),
    });
  }

  /** Deletes the card; one with a history or customers is refused and the page says to deactivate it. */
  protected async remove(): Promise<void> {
    this.busy.set(true);
    this.failure.set(null);
    try {
      await this.api.remove(
        this.groupId(),
        this.cardId() as string,
        (this.saved() as Versioned<FidelityCard>).etag,
      );
    } catch (error) {
      this.settleFailure(error);
      this.busy.set(false);
      this.deleteOpen.set(false);
      return;
    }
    this.busy.set(false);
    this.deleteOpen.set(false);
    this.toast.success(this.i18n.t('FIDELITY_CARDS.DELETE.DONE'));
    await this.router.navigate(this.listRoute());
  }

  /** The failure of an action that is not a save. */
  private settleFailure(error: unknown): void {
    if (
      error instanceof ApiError &&
      error.code === 'CONFLICT' &&
      error.details.some((detail) => detail.issue === 'referenced')
    ) {
      this.failure.set(this.i18n.t('FIDELITY_CARDS.ERROR.HAS_HISTORY'));
    } else if (isStale(error) || (error instanceof ApiError && error.code === 'CONFLICT')) {
      this.stale.set(true);
      this.failure.set(this.i18n.t('FIDELITY_CARDS.FORM.STALE'));
    } else if (error instanceof ApiError && error.code === 'SERVICE_UNAVAILABLE') {
      this.failure.set(this.i18n.t('FIDELITY_CARDS.ERROR.TOO_SLOW'));
    } else {
      this.failure.set(failureMessage(this.i18n, error));
    }
  }

  private reject(error: unknown): TreeValidationResult {
    if (isStale(error)) {
      this.stale.set(true);
      this.failure.set(this.i18n.t('FIDELITY_CARDS.FORM.STALE'));
      return undefined;
    }
    const conflict =
      error instanceof ApiError && error.code === 'CONFLICT' ? this.conflictKey(error) : null;
    if (conflict !== null) {
      this.failure.set(this.i18n.t(conflict));
      return undefined;
    }
    if (
      error instanceof ApiError &&
      error.details.length > 0 &&
      (error.code === 'VALIDATION_ERROR' || error.code === 'CONFLICT')
    ) {
      const fields: Record<string, ReadonlyFieldTree<unknown>> = {};
      for (const { field } of error.details) {
        const found = resolveField(this.cardForm, field);
        if (
          found !== undefined &&
          found !== this.cardForm &&
          (field === 'code' || field === 'cardTypeId')
        ) {
          fields[field] = found;
        }
      }
      const mapped = serverFieldErrors(this.i18n, error, fields);
      if (mapped.unmatched) {
        this.failure.set(this.i18n.t('ERRORS.API.VALIDATION_ERROR'));
      }
      return mapped.errors;
    }
    this.settleFailure(error);
    return undefined;
  }

  /** The text of a `409` that has its own: a card with credit changing to a type without one, a creation with the same key still running. */
  private conflictKey(error: ApiError): string | null {
    if (error.details.some((detail) => detail.field === 'balance' && detail.issue === 'notEmpty')) {
      return 'FIDELITY_CARDS.ERROR.BALANCE_NOT_EMPTY';
    }
    if (
      error.details.some(
        (detail) => detail.field === 'Idempotency-Key' && detail.issue === 'pending',
      )
    ) {
      return 'FIDELITY_CARDS.ERROR.KEY_PENDING';
    }
    return null;
  }

  private settle(leave: boolean): void {
    this.pendingLeave?.(leave);
    this.pendingLeave = null;
  }
}
