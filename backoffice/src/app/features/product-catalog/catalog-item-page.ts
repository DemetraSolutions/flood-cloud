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
import {
  disabled,
  form,
  FormField,
  ReadonlyFieldTree,
  required,
  submit,
  TreeValidationResult,
  validate,
  validateTree,
} from '@angular/forms/signals';
import { Router, RouterLink } from '@angular/router';
import { ApiData } from '../../core/api/api.types';
import { ApiError, apiErrorMessageKey } from '../../core/api/api-error';
import { GroupFeatures } from '../../core/groups/group-features';
import { formatDate } from '../../core/i18n/format';
import { I18nService } from '../../core/i18n/i18n.service';
import { DEFAULT_LANGUAGE } from '../../core/i18n/language';
import { TPipe } from '../../core/i18n/t-pipe';
import { ReferenceApi } from '../../core/reference/reference-api';
import { SessionService } from '../../core/session/session.service';
import {
  failureMessage,
  fieldErrorMessage,
  focusFirstError,
  SERVER_ERROR_KIND,
  serverFieldErrors,
} from '../../shared/forms/form-errors';
import { Button } from '../../shared/ui/button/button';
import { Checkbox } from '../../shared/ui/checkbox/checkbox';
import { ConfirmDialog } from '../../shared/ui/confirm-dialog/confirm-dialog';
import { ErrorState } from '../../shared/ui/error-state/error-state';
import { FormError } from '../../shared/ui/form-error/form-error';
import { PageHeader } from '../../shared/ui/page-header/page-header';
import { Select } from '../../shared/ui/select/select';
import { TabItem, TabList } from '../../shared/ui/tab-list/tab-list';
import { TextField } from '../../shared/ui/text-field/text-field';
import { Textarea } from '../../shared/ui/textarea/textarea';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { IdempotencyKey } from '../../shared/util/idempotency';
import { LogoModel } from '../companies/company-model';
import { LogoSlot } from '../companies/logo-slot';
import { isStale, resolveField } from '../companies/company-errors';
import { numberIssue } from '../groups/catalogs/catalog-fields';
import { lookupLoader, placesLoader, selectionNames } from '../groups/catalogs/reference-loaders';
import { RecordGroup } from '../groups/record-group';
import { languageName } from '../groups/languages';
import { apiErrorOf } from '../profile/sessions';
import { ReferencePicker } from '../users/reference-picker';
import { createBody, ItemModel, patchBody, toModel } from './catalog-item-model';
import { textIssues } from './catalog-item-texts';
import { ProductCatalogApi } from './product-catalog-api';
import {
  CatalogEntry,
  catalogRoute,
  CatalogKind,
  Department,
  FALLBACK_LANGUAGE,
  GroupTax,
  isEditable,
  KINDS,
  requiredLanguage,
  taxLabel,
  Versioned,
} from './product-catalog.types';

/** The tabs of the page, in the order of the legacy form. */
type Section = 'general' | 'availability' | 'media';

/**
 * One department or brand of a group (`/groups/:groupId/product-departments/:itemId` and
 * `/groups/:groupId/product-brands/:itemId`, or `new`; the kind comes from the route): the
 * general tab (state, switches, code and tax rate of a department, name and description for each
 * language of the group), the availability tab (the stores the entry is for; none means every
 * store) and, with the `media` feature, the image from the library of the group. One save in the
 * header sends what changed with the version read in `If-Match` (`412` asks to reload); the
 * creation presents an `Idempotency-Key`. Without `products:update` the page is read only.
 */
@Component({
  selector: 'fc-catalog-item-page',
  imports: [
    Button,
    Checkbox,
    ConfirmDialog,
    ErrorState,
    FormError,
    FormField,
    LogoSlot,
    PageHeader,
    RecordGroup,
    ReferencePicker,
    RouterLink,
    Select,
    TabList,
    TextField,
    Textarea,
    TPipe,
  ],
  templateUrl: './catalog-item-page.html',
  styleUrl: './catalog-item-page.css',
})
export class CatalogItemPage {
  private readonly api = inject(ProductCatalogApi);
  private readonly reference = inject(ReferenceApi);
  private readonly session = inject(SessionService);
  private readonly features = inject(GroupFeatures);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  private readonly injector = inject(Injector);
  private readonly key = new IdempotencyKey();
  protected readonly i18n = inject(I18nService);

  /** Route data and parameters (bound by the router); no `itemId` on the page of a new entry. */
  readonly kind = input.required<CatalogKind>();
  readonly groupId = input.required<string>();
  readonly itemId = input<string>();

  protected readonly settings = computed(() => KINDS[this.kind()]);
  protected readonly isDepartments = computed(() => this.kind() === 'departments');
  protected readonly isNew = computed(() => this.itemId() === undefined);
  /** Company and store administrators see and choose only the stores of their perimeter. */
  protected readonly restricted = computed(() => {
    const role = this.session.me()?.role;
    return role === 'CA' || role === 'PA';
  });
  protected readonly listRoute = computed(() => catalogRoute(this.groupId(), this.kind()));
  protected readonly hasMedia = computed(() => this.features.enabledFor(this.groupId(), 'media'));
  protected readonly hasMonopoly = computed(() =>
    this.features.enabledFor(this.groupId(), 'tobaccosGamesMonopoly'),
  );

  private readonly loaded = resource({
    params: () => {
      const itemId = this.itemId();
      return itemId === undefined
        ? undefined
        : { groupId: this.groupId(), segment: this.settings().segment, itemId };
    },
    loader: ({ params }) =>
      this.api.read<CatalogEntry>(params.groupId, params.segment, params.itemId),
  });
  /** The entry as the server has it, and its version; replaced by every save. */
  private readonly saved = linkedSignal<Versioned<CatalogEntry> | undefined, Versioned<CatalogEntry> | null>({
    // `value()` throws while the resource is in error: read it only when there is one.
    source: () => (this.loaded.hasValue() ? this.loaded.value() : undefined),
    computation: (value) => value ?? null,
  });
  protected readonly item = computed(() => this.saved()?.item ?? null);
  /** The user holds the write permission but the server says this entry is not theirs to change. */
  protected readonly sharedReadOnly = computed(() => {
    const item = this.item();
    return this.session.can('products:update') && item !== null && !isEditable(item);
  });
  protected readonly canWrite = computed(
    () => this.session.can('products:update') && !this.sharedReadOnly(),
  );
  protected readonly department = computed(() =>
    this.isDepartments() ? (this.item() as Department | null) : null,
  );
  protected readonly loadingItem = computed(() => !this.isNew() && this.loaded.isLoading());
  protected readonly failed = computed(() => this.loaded.error() !== undefined);
  protected readonly loadError = computed(() => apiErrorOf(this.loaded.error()));
  protected readonly loadErrorMessage = computed(() => {
    const error = this.loadError();
    return this.i18n.t(error === null ? 'ERRORS.GENERIC.MESSAGE' : apiErrorMessageKey(error));
  });

  // Languages: the ones of the group (`it` when the read fails: the server then
  // decides) and the ones the entry already has.
  private readonly languagesResource = httpResource<ApiData<{ code: string }[]>>(
    () => `/v1/groups/${encodeURIComponent(this.groupId())}/lookup/languages`,
  );
  protected readonly groupLanguages = computed(() => {
    const codes = this.languagesResource.hasValue()
      ? this.languagesResource.value().data.map((language) => language.code)
      : [];
    return codes.length > 0 ? codes : [FALLBACK_LANGUAGE];
  });
  protected readonly languages = computed(() => {
    const item = this.item();
    return [
      ...new Set([
        ...this.groupLanguages(),
        ...Object.keys(item?.name ?? {}),
        ...Object.keys(item?.description ?? {}),
      ]),
    ];
  });
  protected readonly requiredLang = computed(() =>
    requiredLanguage(this.groupLanguages(), this.i18n.language() ?? DEFAULT_LANGUAGE),
  );
  protected readonly loading = computed(
    () => this.loadingItem() || this.languagesResource.isLoading(),
  );

  // Tax rates of the group, for the departments (the compact read open to `products:read`).
  private readonly taxes = httpResource<ApiData<GroupTax[]>>(() =>
    this.isDepartments()
      ? `/v1/groups/${encodeURIComponent(this.groupId())}/lookup/taxes`
      : undefined,
  );
  protected readonly taxesFailed = computed(() => this.taxes.error() !== undefined);
  protected readonly taxOptions = computed(() => {
    const options = this.taxes.hasValue()
      ? this.taxes.value().data.map((tax) => ({ value: tax.id, label: taxLabel(tax) }))
      : [];
    const current = this.department();
    if (current?.taxId != null && !options.some((option) => option.value === current.taxId)) {
      // The tax the department holds stays available even when the group's list is not readable.
      options.push({
        value: current.taxId,
        label: current.tax === null ? current.taxId : taxLabel(current.tax),
      });
    }
    return options;
  });

  protected readonly model = linkedSignal<ItemModel>(() => toModel(this.item(), this.languages()));
  protected readonly itemForm = form(this.model, (path) => {
    validate(path.code, ({ value }) => {
      const issue = this.isDepartments()
        ? numberIssue(value(), { min: 1, max: 99, integer: true, optional: true })
        : undefined;
      return issue === undefined ? undefined : { kind: issue };
    });
    required(path.code, { when: () => this.isDepartments() });
    required(path.taxId, { when: () => this.isDepartments() });
    validate(path.placeIds, ({ value }) =>
      this.isNew() && this.restricted() && value().length === 0 ? { kind: 'required' } : undefined,
    );
    validateTree(path, ({ value, fieldTree }) => {
      const current = this.item();
      const required = this.requiredLang();
      return textIssues(
        value().name,
        value().description,
        required,
        current === null || (current.name[required] ?? '') !== '',
      ).map((problem) => ({
        kind: problem.issue,
        fieldTree: fieldTree[problem.part][problem.language],
      }));
    });
    disabled(path, () => !this.canWrite());
  });

  private readonly options = computed(() => ({ media: this.hasMedia() }));
  /** What the server would receive: what differs from the saved entry (everything, for a new one). */
  protected readonly body = computed(() => {
    const item = this.item();
    return item === null
      ? createBody(this.kind(), this.model(), this.options())
      : patchBody(this.kind(), this.model(), item, this.options());
  });
  /** Whether the form differs from the saved entry, or, for a new one, from the empty form. */
  protected readonly unsaved = computed(() =>
    this.item() === null
      ? JSON.stringify(this.model()) !== JSON.stringify(toModel(null, this.languages()))
      : Object.keys(this.body()).length > 0,
  );
  protected readonly failure = signal<string | null>(null);
  /** The version read is no longer the current one (`412`): the page offers to read again. */
  protected readonly stale = signal(false);
  protected readonly submitting = computed(() => this.itemForm().submitting());

  protected readonly section = signal<Section>('general');
  protected readonly errorCounts = computed<Record<Section, number>>(() => {
    const shown = (field: ReadonlyFieldTree<unknown>): number =>
      fieldErrorMessage(this.i18n, field()) === null ? 0 : 1;
    const f = this.itemForm;
    let general = shown(f.code) + shown(f.taxId);
    for (const language of this.languages()) {
      general += shown(f.name[language]) + shown(f.description[language]);
    }
    return { general, availability: shown(f.placeIds), media: shown(f.image) };
  });
  protected readonly tabs = computed<TabItem[]>(() => {
    const counts = this.errorCounts();
    const sections: Section[] = this.hasMedia()
      ? ['general', 'availability', 'media']
      : ['general', 'availability'];
    return sections.map((id) => ({
      id,
      label: this.i18n.t(`PRODUCT_CATALOG.SECTION.${id.toUpperCase()}`),
      errors: counts[id],
    }));
  });

  // Stores of the availability tab.
  protected readonly placeLoader = computed(() => placesLoader(this.reference, this.groupId()));
  protected readonly placeLabels = selectionNames(
    () => this.item()?.placeIds ?? [],
    (ids) => this.reference.placeNames(this.groupId(), ids),
  );

  // Leaving with unsaved changes.
  protected readonly leaveOpen = signal(false);
  private pendingLeave: ((leave: boolean) => void) | null = null;

  constructor() {
    // Platform administrators and dealers: the features of the group decide the media tab and the printer switch.
    effect(() => {
      const groupId = this.groupId();
      untracked(() => void this.features.ensure(groupId));
    });
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

  /** The text of the kind (`PRODUCT_CATALOG.<DEPARTMENTS|BRANDS>.<part>`). */
  protected text(part: string): string {
    return this.i18n.t(`PRODUCT_CATALOG.${this.settings().text}.${part}`);
  }

  /** Label of a text control: the field and the language it is in. */
  protected languageLabel(field: 'NAME' | 'DESCRIPTION', code: string): string {
    return this.i18n.t(`PRODUCT_CATALOG.FIELD.${field}_IN`, {
      language: languageName(code, this.i18n.language() ?? DEFAULT_LANGUAGE),
    });
  }

  protected error(field: ReadonlyFieldTree<unknown>): string | null {
    return fieldErrorMessage(this.i18n, field());
  }

  protected date(value: string | null): string {
    return value === null
      ? ''
      : formatDate(value, this.i18n.language() ?? DEFAULT_LANGUAGE, {
          dateStyle: 'medium',
          timeStyle: 'short',
        });
  }

  protected reload(): void {
    this.stale.set(false);
    this.failure.set(null);
    this.loaded.reload();
  }

  protected select(id: string): void {
    this.section.set(id as Section);
  }

  protected setImage(image: LogoModel | null): void {
    this.model.update((current) => ({ ...current, image }));
  }

  protected async onSubmit(event: Event): Promise<void> {
    event.preventDefault();
    await submit(this.itemForm, {
      action: async () => {
        this.failure.set(null);
        this.stale.set(false);
        const wasNew = this.isNew();
        const segment = this.settings().segment;
        let result: Versioned<CatalogEntry>;
        try {
          result = wasNew
            ? await this.api.create<CatalogEntry>(
                this.groupId(),
                segment,
                this.body(),
                this.key.forBody(this.body()),
              )
            : await this.api.update<CatalogEntry>(
                this.groupId(),
                segment,
                this.itemId() as string,
                this.body(),
                (this.saved() as Versioned<CatalogEntry>).etag,
              );
        } catch (error) {
          return this.reject(error);
        }
        this.key.reset();
        this.saved.set(result);
        this.toast.success(this.text(wasNew ? 'FORM.CREATED' : 'FORM.SAVED'));
        if (wasNew) {
          await this.router.navigate(catalogRoute(this.groupId(), this.kind(), result.item.id));
        }
        return undefined;
      },
      onInvalid: () => this.revealFirstError(),
    });
  }

  /** Opens the first tab that has an error and moves the focus to its first field. */
  private revealFirstError(): void {
    const counts = this.errorCounts();
    // Walked from the last tab to the first, so that the first one with an error ends up open.
    for (const id of ['media', 'availability', 'general'] as const) {
      if (counts[id] > 0) {
        this.section.set(id);
      }
    }
    // The panel is hidden until the tab is shown: focus once the page has rendered it.
    afterNextRender(() => focusFirstError(this.itemForm), { injector: this.injector });
  }

  private reject(error: unknown): TreeValidationResult {
    if (isStale(error)) {
      this.stale.set(true);
      this.failure.set(this.i18n.t('PRODUCT_CATALOG.FORM.STALE'));
      return undefined;
    }
    if (error instanceof ApiError && error.details.length > 0) {
      if (error.code === 'FORBIDDEN') {
        return this.forbidden(error);
      }
      if (error.code === 'VALIDATION_ERROR' || error.code === 'CONFLICT') {
        return this.fieldErrors(error);
      }
    }
    if (error instanceof ApiError && error.code === 'FORBIDDEN') {
      this.failure.set(this.i18n.t('PRODUCT_CATALOG.ERROR.FORBIDDEN'));
    } else if (error instanceof ApiError && error.code === 'CONFLICT') {
      this.stale.set(true);
      this.failure.set(this.i18n.t('PRODUCT_CATALOG.ERROR.CONCURRENT'));
    } else {
      this.failure.set(failureMessage(this.i18n, error));
    }
    return undefined;
  }

  /** A `403` that names stores (`placeIds`): the stores field says what the user may not do. */
  private forbidden(error: ApiError): TreeValidationResult {
    if (error.details.some((detail) => detail.field.startsWith('placeIds'))) {
      this.section.set('availability');
      return [
        {
          kind: SERVER_ERROR_KIND,
          fieldTree: this.itemForm.placeIds,
          message: this.i18n.t('PRODUCT_CATALOG.ERROR.PLACES_FORBIDDEN'),
        },
      ];
    }
    this.failure.set(this.i18n.t('PRODUCT_CATALOG.ERROR.FORBIDDEN'));
    return undefined;
  }

  /** The `422` and the `409` with details (a code already used): each detail lands on its field. */
  private fieldErrors(error: ApiError): TreeValidationResult {
    const fields: Record<string, ReadonlyFieldTree<unknown>> = {};
    for (const { field } of error.details) {
      // A problem of the texts without a language is the one of the required language.
      const target =
        field === 'name' || field === 'description' ? `${field}.${this.requiredLang()}` : field;
      const found = resolveField(this.itemForm, target);
      if (found !== undefined) {
        fields[field] = found;
      }
    }
    const mapped = serverFieldErrors(this.i18n, error, fields);
    if (mapped.unmatched) {
      this.failure.set(this.i18n.t('ERRORS.API.VALIDATION_ERROR'));
    }
    return mapped.errors;
  }

  private settle(leave: boolean): void {
    this.pendingLeave?.(leave);
    this.pendingLeave = null;
  }
}
