import { httpResource } from '@angular/common/http';
import {
  afterNextRender,
  Component,
  computed,
  effect,
  inject,
  Injector,
  input,
  linkedSignal,
  resource,
  signal,
  untracked,
} from '@angular/core';
import { disabled, form, FormField, ReadonlyFieldTree, submit, TreeValidationResult, validate, validateTree } from '@angular/forms/signals';
import { Router, RouterLink } from '@angular/router';
import { ApiData } from '../../core/api/api.types';
import { ApiError, apiErrorMessageKey } from '../../core/api/api-error';
import { GroupFeatures } from '../../core/groups/group-features';
import { formatDate } from '../../core/i18n/format';
import { I18nService } from '../../core/i18n/i18n.service';
import { DEFAULT_LANGUAGE } from '../../core/i18n/language';
import { TPipe } from '../../core/i18n/t-pipe';
import { ReferenceStore } from '../../core/reference/reference-store';
import { SessionService } from '../../core/session/session.service';
import { failureMessage, fieldErrorMessage, focusFirstError, SERVER_ERROR_KIND, serverFieldErrors } from '../../shared/forms/form-errors';
import { Button } from '../../shared/ui/button/button';
import { ConfirmDialog } from '../../shared/ui/confirm-dialog/confirm-dialog';
import { ErrorState } from '../../shared/ui/error-state/error-state';
import { FormError } from '../../shared/ui/form-error/form-error';
import { PageHeader } from '../../shared/ui/page-header/page-header';
import { SelectOption } from '../../shared/ui/select/select';
import { TabItem, TabList } from '../../shared/ui/tab-list/tab-list';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { IdempotencyKey } from '../../shared/util/idempotency';
import { isStale, resolveField } from '../companies/company-errors';
import { withCurrent } from '../companies/company-options';
import { RecordGroup } from '../groups/record-group';
import { loadAll } from '../places/lookup-loader';
import { Versioned } from '../product-catalog/product-catalog.types';
import { apiErrorOf } from '../profile/sessions';
import { ContactAccount } from './contact-account';
import { ContactApi } from './contact-api';
import { ContactCompany } from './contact-company';
import {
  CONTACT_REFERENCE_KINDS,
  contactFailureMessage,
  isReferenced,
  ReferenceKind,
  referenceKinds,
} from './contact-errors';
import { ContactFidelity } from './contact-fidelity';
import { ContactGeneral } from './contact-general';
import {
  birthDateIssue,
  BodyContext,
  cardsIssue,
  ContactModel,
  createBody,
  discountIssue,
  emailIssue,
  lineIssue,
  listIssue,
  modelChanged,
  notesIssue,
  patchBody,
  phoneIssue,
  recipientCodeIssue,
  servicesIssue,
  supplierListsIssue,
  toModel,
} from './contact-model';
import { ContactPerson } from './contact-person';
import { ContactPurchases } from './contact-purchases';
import { ContactReferenceBlock } from './contact-reference-block';
import { ContactServices } from './contact-services';
import {
  CONTACT_KINDS,
  CONTACT_LIMITS,
  AdvancedCardInfo,
  Contact,
  FidelityCard,
  ContactWarning,
  contactLabel,
  ContactKind,
  contactRoute,
  DEFAULT_KIND,
  PointsAdjustment,
} from './contact.types';

/** The tabs of the page, in the order of the legacy form. */
export const CONTACT_SECTIONS = ['general', 'person', 'company', 'fidelity', 'services', 'account', 'purchases'] as const;

/** A tab of the page. */
export type ContactSection = (typeof CONTACT_SECTIONS)[number];

/** Fields of the server that are a whole list: the error on any of their parts lands on the list. */
const LISTS: Readonly<Record<string, string>> = {
  'person.phones': 'person.phones',
  'person.emails': 'person.emails',
  'company.phones': 'company.phones',
  'company.emails': 'company.emails',
  'company.faxes': 'company.faxes',
  'company.supplierPriceLists': 'company.supplierPriceLists',
  fidelityCards: 'cards',
  services: 'services',
  // A product that still uses a price list of the supplier that was taken away.
  products: 'company.supplierPriceLists',
};

/** The tab of a field of the server. */
export function sectionOf(field: string): ContactSection {
  const [first, second] = field.split('.');
  if (first === 'person') {
    return 'person';
  }
  if (first === 'company' || first === 'eInvoicing' || first === 'products') {
    return 'company';
  }
  if (first === 'fidelityCards') {
    return 'fidelity';
  }
  if (first === 'services') {
    return 'services';
  }
  return first === 'account' && second !== undefined ? 'account' : 'general';
}

/**
 * The path in the form of a field of the server: the lists are one field of the form (an error on
 * a part of a list lands on the list), the codes of the cards are `cards`, and every other field
 * has the same name in the form.
 */
export function formPath(field: string): string {
  const segments = field.split('.');
  for (const length of [2, 1]) {
    const list = LISTS[segments.slice(0, length).join('.')];
    if (list !== undefined) {
      return list;
    }
  }
  return field;
}

/**
 * One contact of a group (`/groups/:groupId/contacts/:contactId`, or `new`) with the tabs of the
 * legacy form: general, personal data, company data (with the price lists of the supplier and the
 * e-invoicing block), fidelity, services (only with the `services` feature), account and, for a
 * saved contact and whoever reads the sales, its purchases (read only, outside the form). One save in
 * the header sends only what changed with the version read in `If-Match` (`412` and a `409`
 * without details ask to reload); the creation presents an `Idempotency-Key`. A `422` lands on its
 * field also in a tab that is not visible, with a mark on the tab. Codes, tax codes and VAT
 * numbers other contacts use too show a warning and never block the save.
 *
 * Without `contacts:write` the page is read only. A contact in the trash opens read only with
 * "Restore" and "Delete for good" (which the server refuses with the kinds of reference that
 * still use the contact). The points of a card are never edited here: they have an explicit
 * adjustment. Nothing of the contact is kept in the browser.
 */
@Component({
  selector: 'fc-contact-page',
  imports: [
    Button,
    ConfirmDialog,
    ContactAccount,
    ContactCompany,
    ContactFidelity,
    ContactGeneral,
    ContactPerson,
    ContactPurchases,
    ContactReferenceBlock,
    ContactServices,
    ErrorState,
    FormError,
    FormField,
    PageHeader,
    RecordGroup,
    RouterLink,
    TabList,
    TPipe,
  ],
  templateUrl: './contact-page.html',
  styleUrl: './contact-page.css',
})
export class ContactPage {
  private readonly api = inject(ContactApi);
  private readonly store = inject(ReferenceStore);
  private readonly session = inject(SessionService);
  private readonly groupFeatures = inject(GroupFeatures);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  private readonly injector = inject(Injector);
  private readonly key = new IdempotencyKey();
  protected readonly i18n = inject(I18nService);

  /** Route parameters and query parameters (bound by the router); no `contactId` on the page of a new contact. */
  readonly groupId = input.required<string>();
  readonly contactId = input<string>();
  /** Query parameter of the page of a new contact: the tab of the list it was opened from. */
  readonly kind = input<string>();

  protected readonly isNew = computed(() => this.contactId() === undefined);
  protected readonly listRoute = computed(() => contactRoute(this.groupId()));
  protected readonly newKind = computed<ContactKind>(() => {
    const kind = this.kind();
    return CONTACT_KINDS.find((candidate) => candidate === kind) ?? DEFAULT_KIND;
  });
  protected readonly hasServices = computed(() => this.groupFeatures.enabledFor(this.groupId(), 'services'));
  private readonly context = computed<BodyContext>(() => ({ services: this.hasServices() }));

  private readonly loaded = resource({
    params: () => {
      const contactId = this.contactId();
      return contactId === undefined ? undefined : { groupId: this.groupId(), contactId };
    },
    loader: ({ params }) => this.api.read(params.groupId, params.contactId),
  });
  /** The contact as the server has it, and its version; replaced by every save. */
  private readonly saved = linkedSignal<Versioned<Contact> | undefined, Versioned<Contact> | null>({
    // `value()` throws while the resource is in error: read it only when there is one.
    source: () => (this.loaded.hasValue() ? this.loaded.value() : undefined),
    computation: (value) => value ?? null,
  });
  protected readonly item = computed(() => this.saved()?.item ?? null);
  /** The duplicates the server reported, each with the saved value it is about (the names of the other contacts are searched with it). */
  protected readonly warnings = computed<ContactWarning[]>(() => {
    const item = this.item();
    const values: Record<string, string> = item === null
      ? {}
      : {
          code: item.code,
          'person.taxCode': item.person.taxCode,
          'company.vatNumber': item.company.vatNumber,
          'company.taxCode': item.company.taxCode,
        };
    return (item?.warnings ?? []).map((warning) => ({ ...warning, value: values[warning.field] }));
  });
  protected readonly loading = computed(() => !this.isNew() && this.loaded.isLoading());
  protected readonly failed = computed(() => this.loaded.error() !== undefined);
  protected readonly loadError = computed(() => apiErrorOf(this.loaded.error()));
  protected readonly loadErrorMessage = computed(() => {
    const error = this.loadError();
    return this.i18n.t(error === null ? 'ERRORS.GENERIC.MESSAGE' : apiErrorMessageKey(error));
  });

  // What the user may do.
  private readonly canUpdate = computed(() => this.session.can('contacts:write'));
  protected readonly trashed = computed(() => this.item()?.trashed === true);
  protected readonly canWrite = computed(() => this.canUpdate() && !this.trashed());
  protected readonly canTrash = computed(() => this.canWrite() && !this.isNew());
  protected readonly canRestoreOrDelete = computed(() => this.canUpdate() && this.trashed());

  // The references the form chooses from.
  private readonly groups = resource({
    params: () => this.groupId(),
    loader: ({ params }) => loadAll(this.store, params, 'contact-groups'),
  });
  private readonly priceListsResource = httpResource<ApiData<{ id: string; name: string; enabled: boolean }[]>>(
    () => `/v1/groups/${encodeURIComponent(this.groupId())}/lookup/price-lists`,
  );
  protected readonly groupOptions = computed<SelectOption[]>(() =>
    withCurrent(
      (this.groups.hasValue() ? this.groups.value() : []).map((group) => ({ value: group.id, label: group.name })),
      this.model().contactGroupId,
      (id) => `…${id.slice(-6)}`,
    ),
  );
  protected readonly priceListOptions = computed<SelectOption[]>(() =>
    withCurrent(
      (this.priceListsResource.hasValue() ? this.priceListsResource.value().data : [])
        .filter((list) => list.enabled)
        .map((list) => ({ value: list.id, label: list.name })),
      this.model().priceListId,
      (id) => id,
    ),
  );

  protected readonly model = linkedSignal<ContactModel>(() => this.initial());
  private readonly base = computed(() => this.initial());
  protected readonly contactForm = form(this.model, (path) => {
    const kind = (issue: string | undefined) => (issue === undefined ? undefined : { kind: issue });
    const line = (text: string, max: number) => kind(lineIssue(text, max));
    validate(path.code, ({ value }) => line(value(), CONTACT_LIMITS.code));
    validate(path.notes, ({ value }) => kind(notesIssue(value())));
    validate(path.person.firstName, ({ value }) => line(value(), CONTACT_LIMITS.name));
    validate(path.person.lastName, ({ value }) => line(value(), CONTACT_LIMITS.name));
    validate(path.person.taxCode, ({ value }) => line(value(), CONTACT_LIMITS.taxCode));
    validate(path.person.birthDate, ({ value }) => kind(birthDateIssue(value())));
    validate(path.person.discountPercent, ({ value }) => kind(discountIssue(value())));
    validate(path.person.phones, ({ value }) => kind(listIssue(value(), CONTACT_LIMITS.phones, (text) => lineIssue(text, 64))));
    validate(path.person.emails, ({ value }) => kind(listIssue(value(), CONTACT_LIMITS.emails, emailIssue)));
    validate(path.company.name, ({ value }) => line(value(), CONTACT_LIMITS.companyName));
    validate(path.company.vatNumber, ({ value }) => line(value(), CONTACT_LIMITS.taxCode));
    validate(path.company.taxCode, ({ value }) => line(value(), CONTACT_LIMITS.taxCode));
    validate(path.company.discountPercent, ({ value }) => kind(discountIssue(value())));
    validate(path.company.phones, ({ value }) => kind(listIssue(value(), CONTACT_LIMITS.phones, (text) => lineIssue(text, 64))));
    validate(path.company.emails, ({ value }) => kind(listIssue(value(), CONTACT_LIMITS.emails, emailIssue)));
    validate(path.company.faxes, ({ value }) => kind(listIssue(value(), CONTACT_LIMITS.phones, (text) => lineIssue(text, 64))));
    validate(path.company.supplierPriceLists, ({ value }) => kind(supplierListsIssue(value())));
    for (const address of [path.person.address, path.company.address]) {
      validate(address.street, ({ value }) => line(value(), 150));
      validate(address.postcode, ({ value }) => line(value(), 20));
      validate(address.city, ({ value }) => line(value(), 100));
    }
    // Only the field the channel asks for is checked: the other one is hidden and keeps what it had.
    validate(path.eInvoicing.recipientCode, ({ value, valueOf }) =>
      valueOf(path.eInvoicing.channel) === 'CD' ? kind(recipientCodeIssue(value())) : undefined,
    );
    validate(path.eInvoicing.pec, ({ value, valueOf }) =>
      valueOf(path.eInvoicing.channel) === 'PEC' ? kind(emailIssue(value())) : undefined,
    );
    validate(path.eInvoicing.administrationReference, ({ value }) => line(value(), CONTACT_LIMITS.administrationReference));
    validate(path.account.email, ({ value }) => kind(emailIssue(value())));
    validate(path.account.phone, ({ value }) => kind(phoneIssue(value())));
    validate(path.cards, ({ value }) => kind(cardsIssue(value(), this.cards().map((card) => card.code))));
    validate(path.services, ({ value }) => kind(servicesIssue(value())));
    // A contact needs a first name or a company name.
    validateTree(path, ({ value, fieldTree }) =>
      value().person.firstName.trim() === '' && value().company.name.trim() === ''
        ? [
            { kind: 'nameOrCompany', fieldTree: fieldTree.person.firstName },
            { kind: 'nameOrCompany', fieldTree: fieldTree.company.name },
          ]
        : [],
    );
    disabled(path, () => !this.canWrite());
  });

  /** What the server would receive: what differs from the saved contact (everything, for a new one). */
  protected readonly body = computed(() =>
    this.item() === null
      ? createBody(this.model(), this.context())
      : patchBody(this.model(), this.base(), this.context()),
  );
  /** Whether the form differs from the saved contact, or, for a new one, from the empty form. */
  protected readonly unsaved = computed(() =>
    this.item() === null ? modelChanged(this.model(), this.base()) : Object.keys(this.body()).length > 0,
  );
  protected readonly failure = signal<string | null>(null);
  /** The version read is no longer the current one (`412` or a concurrent change): the page offers to read again. */
  protected readonly stale = signal(false);
  protected readonly submitting = computed(() => this.contactForm().submitting());

  /** The balance of each saved card: read from the server, and moved by the adjustments of this session without touching the form. */
  protected readonly cards = linkedSignal<readonly FidelityCard[]>(() => this.item()?.fidelityCards ?? []);
  protected readonly balances = computed<Record<string, number>>(() =>
    Object.fromEntries(this.cards().filter((card) => card.advanced === null).map((card) => [card.code, card.points])),
  );
  /** The advanced cards the contact has (by code): they show their own type, state and balances, and the points of the contact do not count. */
  protected readonly advancedCards = computed<Record<string, AdvancedCardInfo>>(() =>
    Object.fromEntries(this.cards().flatMap((card) => (card.advanced === null ? [] : [[card.code, card.advanced] as const]))),
  );
  protected readonly canReadCards = computed(() => this.session.can('fidelity:read'));
  private readonly currencies = httpResource<ApiData<{ code: string }[]>>(
    () => `/v1/groups/${encodeURIComponent(this.groupId())}/lookup/currencies`,
  );
  protected readonly currency = computed(() => (this.currencies.hasValue() ? (this.currencies.value().data[0]?.code ?? 'EUR') : 'EUR'));

  // The tabs.
  /** A new supplier starts on the company data, any other new contact on the personal data. */
  protected readonly section = linkedSignal<ContactSection>(() =>
    this.isNew() ? (this.newKind() === 'suppliers' ? 'company' : 'person') : 'general',
  );
  protected readonly shown = computed<Readonly<Record<ContactSection, boolean>>>(() => ({
    general: true,
    person: true,
    company: true,
    fidelity: true,
    services: this.hasServices(),
    account: true,
    // The sales of the contact: a saved contact, for whoever reads the contacts and the sales.
    purchases: !this.isNew() && this.session.can('contacts:read') && this.session.can('sales:read'),
  }));
  protected readonly errorCounts = computed<Record<ContactSection, number>>(() => {
    const shown = (field: ReadonlyFieldTree<unknown>): number => (fieldErrorMessage(this.i18n, field()) === null ? 0 : 1);
    const f = this.contactForm;
    const address = (a: typeof f.person.address) => [a.street, a.postcode, a.city, a.countryCode, a.areaCode];
    const total = (fields: ReadonlyFieldTree<unknown>[]) => fields.reduce((sum, field) => sum + shown(field), 0);
    return {
      general: total([f.code, f.contactGroupId, f.priceListId, f.notes]),
      person: total([
        f.person.firstName,
        f.person.lastName,
        f.person.taxCode,
        f.person.birthDate,
        ...address(f.person.address),
        f.person.phones,
        f.person.emails,
        f.person.discountPercent,
        f.person.associatedCompanyId,
      ]),
      company: total([
        f.company.name,
        f.company.vatNumber,
        f.company.taxCode,
        ...address(f.company.address),
        f.company.phones,
        f.company.emails,
        f.company.faxes,
        f.company.discountPercent,
        f.company.supplierPriceLists,
        f.eInvoicing.transmissionFormat,
        f.eInvoicing.channel,
        f.eInvoicing.recipientCode,
        f.eInvoicing.pec,
        f.eInvoicing.paymentTerms,
        f.eInvoicing.paymentMethod,
        f.eInvoicing.taxRegime,
        f.eInvoicing.administrationReference,
      ]),
      fidelity: total([f.cards]),
      services: total([f.services]),
      account: total([f.account.email, f.account.phone]),
      purchases: 0,
    };
  });
  protected readonly tabs = computed<TabItem[]>(() => {
    const counts = this.errorCounts();
    const shown = this.shown();
    return CONTACT_SECTIONS.filter((id) => shown[id]).map((id) => ({
      id,
      label: this.i18n.t(`CONTACTS.SECTION.${id.toUpperCase()}`),
      errors: counts[id],
    }));
  });

  // Trash, restore and deletion for good.
  protected readonly trashOpen = signal(false);
  protected readonly deleteOpen = signal(false);
  protected readonly busy = signal(false);
  protected readonly blocked = signal<readonly ReferenceKind[] | null>(null);

  // Leaving with unsaved changes.
  protected readonly leaveOpen = signal(false);
  private pendingLeave: ((leave: boolean) => void) | null = null;

  constructor() {
    // Platform administrators and dealers: the features of the group decide the services tab.
    effect(() => {
      const groupId = this.groupId();
      untracked(() => void this.groupFeatures.ensure(groupId));
    });
  }

  /** The form model of the contact as the server has it, or the one of a new contact. */
  private initial(): ContactModel {
    return toModel(this.item(), this.newKind());
  }

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

  protected date(value: string | null): string {
    return value === null ? '' : formatDate(value, this.i18n.language() ?? DEFAULT_LANGUAGE, { dateStyle: 'medium', timeStyle: 'short' });
  }

  /** The display name of the contact, for the heading and the confirmations (empty while a new one is typed). */
  protected readonly name = computed(() => {
    const item = this.item();
    return item === null ? '' : contactLabel(item);
  });
  protected readonly trashMessage = computed(() => this.i18n.t('CONTACTS.TRASH.CONFIRM_ONE', { name: this.name() }));
  protected readonly deleteMessage = computed(() => this.i18n.t('CONTACTS.DELETE.CONFIRM', { name: this.name() }));

  protected error(field: ReadonlyFieldTree<unknown>): string | null {
    return fieldErrorMessage(this.i18n, field());
  }

  protected reload(): void {
    this.stale.set(false);
    this.failure.set(null);
    this.loaded.reload();
  }

  protected select(id: string): void {
    this.section.set(id as ContactSection);
  }

  /** The balance of a card after an adjustment: shown without reading the contact again (the form keeps what was typed). */
  protected onAdjusted(adjustment: PointsAdjustment): void {
    this.cards.update((cards) => cards.map((card) => (card.code === adjustment.code ? { ...card, points: adjustment.points } : card)));
  }

  /** The outcome of an adjustment is not known: the cards are read again from the contact (the form keeps what was typed). */
  protected async onUncertain(): Promise<void> {
    try {
      this.cards.set((await this.api.read(this.groupId(), this.contactId() as string)).item.fidelityCards);
    } catch (error) {
      this.toast.error(failureMessage(this.i18n, error));
    }
  }

  protected async onSubmit(event: Event): Promise<void> {
    event.preventDefault();
    await submit(this.contactForm, {
      action: async () => {
        this.failure.set(null);
        this.stale.set(false);
        const wasNew = this.isNew();
        let result: Versioned<Contact>;
        try {
          result = wasNew
            ? await this.api.create(this.groupId(), this.body(), this.key.forBody(this.body()))
            : await this.api.update(this.groupId(), this.contactId() as string, this.body(), (this.saved() as Versioned<Contact>).etag);
        } catch (error) {
          return this.reject(error);
        }
        this.key.reset();
        this.saved.set(result);
        this.invalidate();
        this.toast.success(this.i18n.t(wasNew ? 'CONTACTS.FORM.CREATED' : 'CONTACTS.FORM.SAVED'));
        if (wasNew) {
          await this.router.navigate(contactRoute(this.groupId(), result.item.id));
        }
        return undefined;
      },
      onInvalid: () => this.revealFirstError(),
    });
  }

  /** Puts the contact in the trash (it opens read only, with "Restore"). */
  protected async trash(): Promise<void> {
    await this.act(() => this.api.trash(this.groupId(), this.contactId() as string, (this.saved() as Versioned<Contact>).etag), 'CONTACTS.TRASH.DONE');
    this.trashOpen.set(false);
  }

  /** Takes the contact out of the trash (`409` when another contact took one of its cards in the meantime). */
  protected async restore(): Promise<void> {
    await this.act(() => this.api.restore(this.groupId(), this.contactId() as string, (this.saved() as Versioned<Contact>).etag), 'CONTACTS.RESTORE.DONE');
  }

  /** Deletes the contact for good; when something refers to it the panel says what kinds. */
  protected async remove(): Promise<void> {
    this.busy.set(true);
    this.failure.set(null);
    try {
      await this.api.remove(this.groupId(), this.contactId() as string, (this.saved() as Versioned<Contact>).etag);
    } catch (error) {
      if (isReferenced(error)) {
        this.blocked.set(referenceKinds(error, CONTACT_REFERENCE_KINDS));
      } else {
        this.settleFailure(error);
      }
      this.busy.set(false);
      this.deleteOpen.set(false);
      return;
    }
    this.busy.set(false);
    this.deleteOpen.set(false);
    this.invalidate();
    this.toast.success(this.i18n.t('CONTACTS.DELETE.DONE'));
    await this.router.navigate(this.listRoute());
  }

  /** Runs a trash or restore and shows the contact as the server answers. */
  private async act(call: () => Promise<Versioned<Contact>>, done: string): Promise<void> {
    this.busy.set(true);
    this.failure.set(null);
    this.blocked.set(null);
    try {
      this.saved.set(await call());
      this.invalidate();
      this.toast.success(this.i18n.t(done));
    } catch (error) {
      this.settleFailure(error);
    } finally {
      this.busy.set(false);
    }
  }

  /** The compact lists of customers and suppliers show the change. */
  private invalidate(): void {
    this.store.invalidate(this.groupId(), 'customers');
    this.store.invalidate(this.groupId(), 'suppliers');
  }

  /** The failure of an action that is not a save: a stale version asks to read again, the rest has its message. */
  private settleFailure(error: unknown): void {
    if (isStale(error) || (error instanceof ApiError && error.code === 'CONFLICT')) {
      this.stale.set(true);
      this.failure.set(this.i18n.t('CONTACTS.FORM.STALE'));
    } else if (error instanceof ApiError && error.code === 'FORBIDDEN') {
      this.failure.set(this.i18n.t('CONTACTS.ERROR.FORBIDDEN'));
    } else {
      this.failure.set(contactFailureMessage(this.i18n, error));
    }
  }

  /** Opens the first tab that has an error and moves the focus to its first field. */
  private revealFirstError(): void {
    const counts = this.errorCounts();
    // The form is invalid, so some tab has an error.
    this.section.set(CONTACT_SECTIONS.find((id) => counts[id] > 0) as ContactSection);
    // The panel is hidden until the tab is shown: focus once the page has rendered it.
    afterNextRender(() => focusFirstError(this.contactForm), { injector: this.injector });
  }

  private reject(error: unknown): TreeValidationResult {
    if (isStale(error)) {
      this.stale.set(true);
      this.failure.set(this.i18n.t('CONTACTS.FORM.STALE'));
      return undefined;
    }
    if (error instanceof ApiError && error.code === 'CONFLICT' && error.details.some((detail) => detail.field === 'Idempotency-Key' && detail.issue === 'reused')) {
      this.failure.set(this.i18n.t('CONTACTS.ERROR.KEY_REUSED'));
      return undefined;
    }
    if (error instanceof ApiError && error.details.length > 0 && (error.code === 'VALIDATION_ERROR' || error.code === 'CONFLICT')) {
      return this.fieldErrors(error);
    }
    this.settleFailure(error);
    return undefined;
  }

  /** The `422` and the `409` with details (an account that is taken): each detail lands on its field. */
  private fieldErrors(error: ApiError): TreeValidationResult {
    const fields: Record<string, ReadonlyFieldTree<unknown>> = {};
    for (const { field } of error.details) {
      const found = resolveField(this.contactForm, formPath(field));
      // A field the form does not have resolves to its group: that is no place for the message.
      if (found !== undefined && !this.groupNodes().includes(found)) {
        fields[field] = found;
      }
    }
    // A supplier price list a product still uses: one message that says how many products.
    const used = error.details.filter((detail) => detail.field.startsWith('products.') && detail.issue === 'referenced');
    const rest = used.length === 0 ? error : new ApiError({ status: error.status, code: error.code, message: error.message, details: error.details.filter((detail) => !used.includes(detail)), requestId: error.requestId });
    const mapped = serverFieldErrors(this.i18n, rest, fields);
    if (used.length > 0) {
      mapped.errors.push({
        kind: SERVER_ERROR_KIND,
        fieldTree: this.contactForm.company.supplierPriceLists,
        message: this.i18n.t('CONTACTS.ERROR.LIST_IN_USE', { count: used.length }),
      });
    }
    const first = CONTACT_SECTIONS.find((id) => error.details.some((detail) => Object.hasOwn(fields, detail.field) && sectionOf(detail.field) === id));
    if (first !== undefined) {
      this.section.set(first);
    }
    if (mapped.unmatched && rest.details.length > 0) {
      this.failure.set(this.i18n.t('ERRORS.API.VALIDATION_ERROR'));
    }
    return mapped.errors;
  }

  /** The groups of fields of the form: they hold fields but are no field to show a message on. */
  private groupNodes(): unknown[] {
    const f = this.contactForm;
    return [f, f.person, f.company, f.eInvoicing, f.account, f.person.address, f.company.address];
  }

  private settle(leave: boolean): void {
    this.pendingLeave?.(leave);
    this.pendingLeave = null;
  }
}
