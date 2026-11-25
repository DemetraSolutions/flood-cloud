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
import { disabled, form, FormField, ReadonlyFieldTree, submit, TreeValidationResult, validate } from '@angular/forms/signals';
import { Router, RouterLink } from '@angular/router';
import { ApiData } from '../../core/api/api.types';
import { ApiError, apiErrorMessageKey } from '../../core/api/api-error';
import { formatDate } from '../../core/i18n/format';
import { I18nService } from '../../core/i18n/i18n.service';
import { DEFAULT_LANGUAGE } from '../../core/i18n/language';
import { TPipe } from '../../core/i18n/t-pipe';
import { ReferenceStore } from '../../core/reference/reference-store';
import { SessionService } from '../../core/session/session.service';
import { fieldErrorMessage, focusFirstError, serverFieldErrors } from '../../shared/forms/form-errors';
import { Button } from '../../shared/ui/button/button';
import { ConfirmDialog } from '../../shared/ui/confirm-dialog/confirm-dialog';
import { ErrorState } from '../../shared/ui/error-state/error-state';
import { FormError } from '../../shared/ui/form-error/form-error';
import { PageHeader } from '../../shared/ui/page-header/page-header';
import { Select, SelectOption } from '../../shared/ui/select/select';
import { TextField } from '../../shared/ui/text-field/text-field';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { IdempotencyKey } from '../../shared/util/idempotency';
import { isStale, resolveField } from '../companies/company-errors';
import { withCurrent } from '../companies/company-options';
import { ContactReferenceBlock } from '../contacts/contact-reference-block';
import {
  CONTACT_GROUP_REFERENCE_KINDS,
  contactFailureMessage,
  isReferenced,
  ReferenceKind,
  referenceKinds,
} from '../contacts/contact-errors';
import { discountIssue, lineIssue } from '../contacts/contact-model';
import { RecordGroup } from '../groups/record-group';
import { Versioned } from '../product-catalog/product-catalog.types';
import { apiErrorOf } from '../profile/sessions';
import { ContactGroupApi } from './contact-group-api';
import { ContactGroupModel, createBody, patchBody, toModel } from './contact-group-model';
import { CONTACT_GROUP_LIMITS, ContactGroup, contactGroupRoute } from './contact-group.types';

/**
 * One group of contacts (`/groups/:groupId/contact-groups/:contactGroupId`, or `new`): its name,
 * the price list its contacts are sold with, their discount and, once it exists, how many contacts
 * it has (read only). One save sends what changed with the version read in `If-Match` (`412` asks
 * to reload); the creation presents an `Idempotency-Key`. Deleting asks for a confirmation and is
 * refused with the kinds of reference that still use the group (contacts and promotions). Without
 * `contacts:write` the page is read only.
 */
@Component({
  selector: 'fc-contact-group-page',
  imports: [
    Button,
    ConfirmDialog,
    ContactReferenceBlock,
    ErrorState,
    FormError,
    FormField,
    PageHeader,
    RecordGroup,
    RouterLink,
    Select,
    TextField,
    TPipe,
  ],
  templateUrl: './contact-group-page.html',
  styleUrl: './contact-group-page.css',
})
export class ContactGroupPage {
  private readonly api = inject(ContactGroupApi);
  private readonly store = inject(ReferenceStore);
  private readonly session = inject(SessionService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  private readonly injector = inject(Injector);
  private readonly key = new IdempotencyKey();
  protected readonly i18n = inject(I18nService);

  /** Route parameters (bound by the router); no `contactGroupId` on the page of a new group of contacts. */
  readonly groupId = input.required<string>();
  readonly contactGroupId = input<string>();

  protected readonly isNew = computed(() => this.contactGroupId() === undefined);
  protected readonly listRoute = computed(() => contactGroupRoute(this.groupId()));
  protected readonly canWrite = computed(() => this.session.can('contacts:write'));

  private readonly loaded = resource({
    params: () => {
      const contactGroupId = this.contactGroupId();
      return contactGroupId === undefined ? undefined : { groupId: this.groupId(), contactGroupId };
    },
    loader: ({ params }) => this.api.read(params.groupId, params.contactGroupId),
  });
  /** The group of contacts as the server has it, and its version; replaced by every save. */
  private readonly saved = linkedSignal<Versioned<ContactGroup> | undefined, Versioned<ContactGroup> | null>({
    // `value()` throws while the resource is in error: read it only when there is one.
    source: () => (this.loaded.hasValue() ? this.loaded.value() : undefined),
    computation: (value) => value ?? null,
  });
  protected readonly item = computed(() => this.saved()?.item ?? null);
  protected readonly loading = computed(() => !this.isNew() && this.loaded.isLoading());
  protected readonly failed = computed(() => this.loaded.error() !== undefined);
  protected readonly loadError = computed(() => apiErrorOf(this.loaded.error()));
  protected readonly loadErrorMessage = computed(() => {
    const error = this.loadError();
    return this.i18n.t(error === null ? 'ERRORS.GENERIC.MESSAGE' : apiErrorMessageKey(error));
  });

  private readonly priceListsResource = httpResource<ApiData<{ id: string; name: string; enabled: boolean }[]>>(
    () => `/v1/groups/${encodeURIComponent(this.groupId())}/lookup/price-lists`,
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

  protected readonly model = linkedSignal<ContactGroupModel>(() => toModel(this.item()));
  private readonly base = computed(() => toModel(this.item()));
  protected readonly groupForm = form(this.model, (path) => {
    validate(path.name, ({ value }) => {
      const text = value().trim();
      const issue = text === '' ? 'required' : lineIssue(text, CONTACT_GROUP_LIMITS.name);
      return issue === undefined ? undefined : { kind: issue };
    });
    validate(path.discountPercent, ({ value }) => {
      const issue = discountIssue(value());
      return issue === undefined ? undefined : { kind: issue };
    });
    disabled(path, () => !this.canWrite());
  });

  /** What the server would receive: what differs from the saved group (everything, for a new one). */
  protected readonly body = computed(() =>
    this.item() === null ? createBody(this.model()) : patchBody(this.model(), this.base()),
  );
  /** Whether the form differs from the saved group, or, for a new one, from the empty form. */
  protected readonly unsaved = computed(() =>
    this.item() === null
      ? JSON.stringify(this.model()) !== JSON.stringify(this.base())
      : Object.keys(this.body()).length > 0,
  );
  protected readonly failure = signal<string | null>(null);
  /** The version read is no longer the current one: the page offers to read again. */
  protected readonly stale = signal(false);
  protected readonly submitting = computed(() => this.groupForm().submitting());

  /** The confirmation of the deletion: names the group and warns when it still has contacts. */
  protected readonly deleteMessage = computed(() => {
    const item = this.item();
    const name = item?.name ?? '';
    const count = item?.contactsCount ?? 0;
    return count > 0
      ? this.i18n.t('CONTACT_GROUPS.DELETE.CONFIRM_WITH_CONTACTS', { name, count })
      : this.i18n.t('CONTACT_GROUPS.DELETE.CONFIRM', { name });
  });
  protected readonly deleteOpen = signal(false);
  protected readonly busy = signal(false);
  protected readonly blocked = signal<readonly ReferenceKind[] | null>(null);

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
    return value === null ? '' : formatDate(value, this.i18n.language() ?? DEFAULT_LANGUAGE, { dateStyle: 'medium', timeStyle: 'short' });
  }

  protected reload(): void {
    this.stale.set(false);
    this.failure.set(null);
    this.loaded.reload();
  }

  protected async onSubmit(event: Event): Promise<void> {
    event.preventDefault();
    await submit(this.groupForm, {
      action: async () => {
        this.failure.set(null);
        this.stale.set(false);
        const wasNew = this.isNew();
        let result: Versioned<ContactGroup>;
        try {
          result = wasNew
            ? await this.api.create(this.groupId(), this.body(), this.key.forBody(this.body()))
            : await this.api.update(this.groupId(), this.contactGroupId() as string, this.body(), (this.saved() as Versioned<ContactGroup>).etag);
        } catch (error) {
          return this.reject(error);
        }
        this.key.reset();
        this.saved.set(result);
        this.store.invalidate(this.groupId(), 'contact-groups');
        this.toast.success(this.i18n.t(wasNew ? 'CONTACT_GROUPS.FORM.CREATED' : 'CONTACT_GROUPS.FORM.SAVED'));
        if (wasNew) {
          await this.router.navigate(contactGroupRoute(this.groupId(), result.item.id));
        }
        return undefined;
      },
      onInvalid: () => afterNextRender(() => focusFirstError(this.groupForm), { injector: this.injector }),
    });
  }

  /** Deletes the group of contacts; when something refers to it the panel says what kinds. */
  protected async remove(): Promise<void> {
    this.busy.set(true);
    this.failure.set(null);
    try {
      await this.api.remove(this.groupId(), this.contactGroupId() as string, (this.saved() as Versioned<ContactGroup>).etag);
    } catch (error) {
      if (isReferenced(error)) {
        this.blocked.set(referenceKinds(error, CONTACT_GROUP_REFERENCE_KINDS));
      } else if (isStale(error)) {
        this.stale.set(true);
        this.failure.set(this.i18n.t('CONTACT_GROUPS.FORM.STALE'));
      } else {
        this.failure.set(contactFailureMessage(this.i18n, error));
      }
      this.busy.set(false);
      this.deleteOpen.set(false);
      return;
    }
    this.busy.set(false);
    this.deleteOpen.set(false);
    this.store.invalidate(this.groupId(), 'contact-groups');
    this.toast.success(this.i18n.t('CONTACT_GROUPS.DELETE.DONE'));
    await this.router.navigate(this.listRoute());
  }

  private reject(error: unknown): TreeValidationResult {
    if (isStale(error)) {
      this.stale.set(true);
      this.failure.set(this.i18n.t('CONTACT_GROUPS.FORM.STALE'));
      return undefined;
    }
    if (error instanceof ApiError && error.code === 'VALIDATION_ERROR' && error.details.length > 0) {
      const fields: Record<string, ReadonlyFieldTree<unknown>> = {};
      for (const { field } of error.details) {
        const found = resolveField(this.groupForm, field);
        if (found !== undefined && found !== this.groupForm) {
          fields[field] = found;
        }
      }
      const mapped = serverFieldErrors(this.i18n, error, fields);
      if (mapped.unmatched) {
        this.failure.set(this.i18n.t('ERRORS.API.VALIDATION_ERROR'));
      }
      return mapped.errors;
    }
    this.failure.set(contactFailureMessage(this.i18n, error));
    if (error instanceof ApiError && error.code === 'CONFLICT') {
      this.stale.set(true);
    }
    return undefined;
  }

  private settle(leave: boolean): void {
    this.pendingLeave?.(leave);
    this.pendingLeave = null;
  }
}
