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
import { ReferenceStore } from '../../core/reference/reference-store';
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
import { Select, SelectOption } from '../../shared/ui/select/select';
import { TabItem, TabList } from '../../shared/ui/tab-list/tab-list';
import { TextField } from '../../shared/ui/text-field/text-field';
import { Textarea } from '../../shared/ui/textarea/textarea';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { IdempotencyKey } from '../../shared/util/idempotency';
import { isStale, resolveField } from '../companies/company-errors';
import { withCurrent } from '../companies/company-options';
import { LogoModel } from '../companies/company-model';
import { LogoSlot } from '../companies/logo-slot';
import { numberIssue } from '../groups/catalogs/catalog-fields';
import { selectionNames } from '../groups/catalogs/reference-loaders';
import { languageName } from '../groups/languages';
import { RecordGroup } from '../groups/record-group';
import { loadAll } from '../places/lookup-loader';
import { textIssues } from '../product-catalog/catalog-item-texts';
import { ProductCatalogApi } from '../product-catalog/product-catalog-api';
import { FALLBACK_LANGUAGE, requiredLanguage, Versioned } from '../product-catalog/product-catalog.types';
import { apiErrorOf } from '../profile/sessions';
import { ReferenceLoader, ReferencePicker } from '../users/reference-picker';
import { CategoryAvailability } from './category-availability';
import { CategoryCheckList } from './category-check-list';
import { CategoryModel, createBody, patchBody, toModel } from './category-model';
import { PlaceSetupReader } from './category-place-setup';
import { CategoryStations } from './category-stations';
import {
  Category,
  CATEGORIES_SEGMENT,
  CATEGORY_FEATURES,
  CATEGORY_LIMITS,
  categoryRoute,
  CategoryFeatures,
  CategoryNode,
  DINING_TYPES,
  flatten,
  hasHiddenParent,
  isCategoryEditable,
  nodeName,
  QUICK_COLORS,
  selfAndDescendants,
} from './category.types';

/** The tabs of the page, in the order of the legacy form. */
type Section = 'general' | 'variants' | 'stations' | 'availability' | 'media';

/** Order of the tabs, to find the first one that has an error. */
const SECTION_ORDER: readonly Section[] = ['general', 'variants', 'stations', 'availability', 'media'];

/** The tab of a field of the server (its first segment). */
function sectionOf(field: string): Section {
  switch (field.split('.')[0]) {
    case 'modifierIds':
    case 'modifierCategoryIds':
      return 'variants';
    case 'printStations':
    case 'counterPrintStations':
      return 'stations';
    case 'places':
      return 'availability';
    case 'image':
    case 'icon':
    case 'internalFileName':
    case 'externalUrl':
      return 'media';
    default:
      return 'general';
  }
}

/**
 * The field of the form that shows the errors of a field of the server: the controls that edit a
 * whole list (the modifiers, the print stations, the availability) show the errors of any of its
 * parts, and a text without a language is the one of the required language.
 */
function formPath(field: string, requiredLang: string): string {
  const first = field.split('.')[0];
  if (first === 'printStations' || first === 'counterPrintStations') {
    return 'stations';
  }
  if (first === 'modifierIds' || first === 'modifierCategoryIds' || first === 'places') {
    return first;
  }
  return field === 'name' || field === 'description' ? `${field}.${requiredLang}` : field;
}

/** The issue of a link: `https` only, no user or password, as long as the server accepts. */
function urlIssue(value: string): 'maxLength' | 'format' | undefined {
  const text = value.trim();
  if (text === '') {
    return undefined;
  }
  if (text.length > CATEGORY_LIMITS.externalUrl) {
    return 'maxLength';
  }
  const url = URL.canParse(text) ? new URL(text) : null;
  return url !== null && url.protocol === 'https:' && url.username === '' && url.password === ''
    ? undefined
    : 'format';
}

/** The issue of an internal file name: one line, not longer than the server accepts. */
function fileNameIssue(value: string): 'maxLength' | 'pattern' | undefined {
  const text = value.trim();
  if (text.length > CATEGORY_LIMITS.internalFileName) {
    return 'maxLength';
  }
  return /[\u0000-\u001F\u007F]/.test(text) ? 'pattern' : undefined;
}

/**
 * One category of a group (`/groups/:groupId/product-categories/:categoryId`, or `new`) with the
 * five tabs of the legacy form: general (state, switches, parent, position, texts, restaurant,
 * tobacco and colors), variants (modifier products and categories), print stations (by store),
 * availability (by store: position and production center) and media. A tab or a field is there only
 * when the group has the feature it needs. One save in the header sends what changed with the
 * version read in `If-Match` (`412` and a `409` without details ask to reload); the creation
 * presents an `Idempotency-Key`. Without `products:update`, or when the server says the category
 * is not the caller's to change (`editable: false`), the page is read only.
 */
@Component({
  selector: 'fc-category-page',
  imports: [
    Button,
    CategoryAvailability,
    CategoryCheckList,
    CategoryStations,
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
  providers: [PlaceSetupReader],
  templateUrl: './category-page.html',
  styleUrl: './category-page.css',
})
export class CategoryPage {
  private readonly api = inject(ProductCatalogApi);
  private readonly reference = inject(ReferenceApi);
  private readonly store = inject(ReferenceStore);
  private readonly session = inject(SessionService);
  private readonly groupFeatures = inject(GroupFeatures);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  private readonly injector = inject(Injector);
  private readonly key = new IdempotencyKey();
  protected readonly i18n = inject(I18nService);

  /** Route parameters (bound by the router); no `categoryId` on the page of a new category. */
  readonly groupId = input.required<string>();
  readonly categoryId = input<string>();

  protected readonly isNew = computed(() => this.categoryId() === undefined);
  /** Company and store administrators see and choose only the stores of their perimeter. */
  protected readonly restricted = computed(() => {
    const role = this.session.me()?.role;
    return role === 'CA' || role === 'PA';
  });
  protected readonly listRoute = computed(() => categoryRoute(this.groupId()));
  protected readonly features = computed<CategoryFeatures>(
    () =>
      Object.fromEntries(
        CATEGORY_FEATURES.map((name) => [name, this.groupFeatures.enabledFor(this.groupId(), name)]),
      ) as unknown as CategoryFeatures,
  );

  private readonly loaded = resource({
    params: () => {
      const categoryId = this.categoryId();
      return categoryId === undefined ? undefined : { groupId: this.groupId(), categoryId };
    },
    loader: ({ params }) =>
      this.api.read<Category>(params.groupId, CATEGORIES_SEGMENT, params.categoryId),
  });
  /** The category as the server has it, and its version; replaced by every save. */
  private readonly saved = linkedSignal<Versioned<Category> | undefined, Versioned<Category> | null>({
    // `value()` throws while the resource is in error: read it only when there is one.
    source: () => (this.loaded.hasValue() ? this.loaded.value() : undefined),
    computation: (value) => value ?? null,
  });
  protected readonly item = computed(() => this.saved()?.item ?? null);
  /** The user holds the write permission but the server says this category is not theirs to change. */
  protected readonly sharedReadOnly = computed(() => {
    const item = this.item();
    return this.session.can('products:update') && item !== null && !isCategoryEditable(item);
  });
  protected readonly canWrite = computed(
    () => this.session.can('products:update') && !this.sharedReadOnly(),
  );
  protected readonly parentHidden = computed(() => {
    const item = this.item();
    return item !== null && hasHiddenParent(item);
  });
  protected readonly loadingItem = computed(() => !this.isNew() && this.loaded.isLoading());
  protected readonly failed = computed(() => this.loaded.error() !== undefined);
  protected readonly loadError = computed(() => apiErrorOf(this.loaded.error()));
  protected readonly loadErrorMessage = computed(() => {
    const error = this.loadError();
    return this.i18n.t(error === null ? 'ERRORS.GENERIC.MESSAGE' : apiErrorMessageKey(error));
  });

  // Languages: the ones of the group (`it` when the read fails: the server then decides) and the ones the category has.
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

  // The tree: the parents to choose from and the categories of modifiers.
  private readonly tree = httpResource<ApiData<CategoryNode[]>>(
    () => `${this.api.baseUrl(this.groupId(), CATEGORIES_SEGMENT)}/tree`,
  );
  protected readonly treeFailed = computed(() => this.tree.error() !== undefined);
  private readonly treeNodes = computed(() => (this.tree.hasValue() ? this.tree.value().data : []));
  protected readonly treeEntries = computed(() => flatten(this.treeNodes()));
  protected readonly parentOptions = computed<SelectOption[]>(() => {
    const id = this.categoryId();
    const excluded = id === undefined ? new Set<string>() : selfAndDescendants(this.treeNodes(), id);
    const none = this.i18n.t('PRODUCT_CATEGORIES.NO_NAME');
    const options = this.treeEntries()
      .filter(({ node }) => !excluded.has(node.id))
      .map(({ node, level }) => ({
        value: node.id,
        label: `${'– '.repeat(level)}${nodeName(node, none)}`,
      }));
    return withCurrent(options, this.item()?.parentId ?? '', (value) => value);
  });
  protected readonly parentPlaceholder = computed(() =>
    this.i18n.t(this.parentHidden() ? 'PRODUCT_CATEGORIES.PARENT_HIDDEN' : 'PRODUCT_CATEGORIES.FIELD.PARENT_NONE'),
  );

  // The stores of the group, for the stations and the availability.
  protected readonly places = resource({
    params: () => this.groupId(),
    loader: ({ params }) => loadAll(this.store, params, 'places'),
  });
  protected readonly placeList = computed(() => (this.places.hasValue() ? this.places.value() : []));
  protected readonly placesFailed = computed(() => this.places.error() !== undefined);

  protected readonly model = linkedSignal<CategoryModel>(() => toModel(this.item(), this.languages()));
  /** The form model of the category as the server has it. */
  private readonly base = computed(() => toModel(this.item(), this.languages()));
  protected readonly categoryForm = form(this.model, (path) => {
    validate(path.position, ({ value }) => this.numberKind(value(), CATEGORY_LIMITS.number, true));
    validate(path.productionValue, ({ value }) => this.numberKind(value(), CATEGORY_LIMITS.number, true));
    validate(path.dining.feePercentage, ({ value }) =>
      this.numberKind(value(), CATEGORY_LIMITS.percentage, false),
    );
    validate(path.dining.printGroup, ({ value }) => this.numberKind(value(), CATEGORY_LIMITS.number, true));
    validate(path.places, ({ value }) => {
      if (this.restricted() && value().length === 0) {
        return { kind: 'required' };
      }
      const wrong = value().some(
        (row) => numberIssue(row.position, { min: 0, max: CATEGORY_LIMITS.number, integer: true, optional: true }) !== undefined,
      );
      return wrong ? { kind: 'type' } : undefined;
    });
    validate(path.internalFileName, ({ value }) => {
      const issue = fileNameIssue(value());
      return issue === undefined ? undefined : { kind: issue };
    });
    validate(path.externalUrl, ({ value }) => {
      const issue = urlIssue(value());
      return issue === undefined ? undefined : { kind: issue };
    });
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

  /** What the server would receive: what differs from the saved category (everything, for a new one). */
  protected readonly body = computed(() =>
    this.item() === null
      ? createBody(this.model(), this.features())
      : patchBody(this.model(), this.base(), this.features()),
  );
  /** Whether the form differs from the saved category, or, for a new one, from the empty form. */
  protected readonly unsaved = computed(() =>
    this.item() === null
      ? JSON.stringify(this.model()) !== JSON.stringify(toModel(null, this.languages()))
      : Object.keys(this.body()).length > 0,
  );
  protected readonly failure = signal<string | null>(null);
  /** The version read is no longer the current one (`412` or a concurrent change): the page offers to read again. */
  protected readonly stale = signal(false);
  protected readonly submitting = computed(() => this.categoryForm().submitting());

  protected readonly section = signal<Section>('general');
  protected readonly errorCounts = computed<Record<Section, number>>(() => {
    const shown = (field: ReadonlyFieldTree<unknown>): number =>
      fieldErrorMessage(this.i18n, field()) === null ? 0 : 1;
    const f = this.categoryForm;
    let general = shown(f.position) + shown(f.productionValue) + shown(f.parentId);
    general += shown(f.dining.feePercentage) + shown(f.dining.printGroup);
    for (const language of this.languages()) {
      general += shown(f.name[language]) + shown(f.description[language]);
    }
    return {
      general,
      variants: shown(f.modifierIds) + shown(f.modifierCategoryIds),
      stations: shown(f.stations),
      availability: shown(f.places),
      media: shown(f.image) + shown(f.icon) + shown(f.internalFileName) + shown(f.externalUrl),
    };
  });
  protected readonly tabs = computed<TabItem[]>(() => {
    const counts = this.errorCounts();
    const features = this.features();
    const shown: Record<Section, boolean> = {
      general: true,
      variants: features.productsVariants,
      stations: features.ordering,
      availability: true,
      media: features.media,
    };
    return SECTION_ORDER.filter((id) => shown[id]).map((id) => ({
      id,
      label: this.i18n.t(`PRODUCT_CATEGORIES.SECTION.${id.toUpperCase()}`),
      errors: counts[id],
    }));
  });

  protected readonly diningTypes = computed<SelectOption[]>(() =>
    DINING_TYPES.map((type) => ({
      value: type,
      label: this.i18n.t(`PRODUCT_CATEGORIES.DINING.TYPE_${type.toUpperCase()}`),
    })),
  );
  protected readonly quickColors = QUICK_COLORS;

  // The modifier products of the variants tab (the server searches, the whole list is never read).
  protected readonly productLoader = computed<ReferenceLoader>(() => {
    const groupId = this.groupId();
    return (query) => this.reference.lookup(groupId, 'products', { ...query, modifier: true });
  });
  protected readonly productLabels = selectionNames(
    () => this.item()?.modifierIds ?? [],
    (ids) => this.reference.lookupNames(this.groupId(), 'products', ids, true),
  );

  // Leaving with unsaved changes.
  protected readonly leaveOpen = signal(false);
  private pendingLeave: ((leave: boolean) => void) | null = null;

  constructor() {
    // Platform administrators and dealers: the features of the group decide the tabs and the fields.
    effect(() => {
      const groupId = this.groupId();
      untracked(() => void this.groupFeatures.ensure(groupId));
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

  protected setImage(key: 'image' | 'icon', logo: LogoModel | null): void {
    this.model.update((current) => ({ ...current, [key]: logo }));
  }

  protected setBackground(color: string): void {
    this.model.update((current) => ({ ...current, backgroundColor: color }));
  }

  protected async onSubmit(event: Event): Promise<void> {
    event.preventDefault();
    await submit(this.categoryForm, {
      action: async () => {
        this.failure.set(null);
        this.stale.set(false);
        const wasNew = this.isNew();
        let result: Versioned<Category>;
        try {
          result = wasNew
            ? await this.api.create<Category>(
                this.groupId(),
                CATEGORIES_SEGMENT,
                this.body(),
                this.key.forBody(this.body()),
              )
            : await this.api.update<Category>(
                this.groupId(),
                CATEGORIES_SEGMENT,
                this.categoryId() as string,
                this.body(),
                (this.saved() as Versioned<Category>).etag,
              );
        } catch (error) {
          return this.reject(error);
        }
        this.key.reset();
        this.saved.set(result);
        // The compact lists of categories (and the tree) show the change.
        this.store.invalidate(this.groupId(), 'product-categories');
        this.tree.reload();
        this.toast.success(this.i18n.t(wasNew ? 'PRODUCT_CATEGORIES.FORM.CREATED' : 'PRODUCT_CATEGORIES.FORM.SAVED'));
        if (wasNew) {
          await this.router.navigate(categoryRoute(this.groupId(), result.item.id));
        }
        return undefined;
      },
      onInvalid: () => this.revealFirstError(),
    });
  }

  /** The issue of a number typed in a text field, as the kind of a client error. */
  private numberKind(text: string, max: number, integer: boolean): { kind: string } | undefined {
    const issue = numberIssue(text, { min: 0, max, integer, optional: true });
    return issue === undefined ? undefined : { kind: issue };
  }

  /** Opens the first tab that has an error and moves the focus to its first field. */
  private revealFirstError(): void {
    const counts = this.errorCounts();
    const first = SECTION_ORDER.find((id) => counts[id] > 0);
    if (first !== undefined) {
      this.section.set(first);
    }
    // The panel is hidden until the tab is shown: focus once the page has rendered it.
    afterNextRender(() => focusFirstError(this.categoryForm), { injector: this.injector });
  }

  private reject(error: unknown): TreeValidationResult {
    if (isStale(error)) {
      this.stale.set(true);
      this.failure.set(this.i18n.t('PRODUCT_CATEGORIES.FORM.STALE'));
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

  /** A `403` that names stores (`places`, the print stations): the field of the stores says what the user may not do. */
  private forbidden(error: ApiError): TreeValidationResult {
    const stations = error.details.some((detail) => sectionOf(detail.field) === 'stations');
    const places = error.details.some((detail) => sectionOf(detail.field) === 'availability');
    if (!stations && !places) {
      this.failure.set(this.i18n.t('PRODUCT_CATALOG.ERROR.FORBIDDEN'));
      return undefined;
    }
    this.section.set(places ? 'availability' : 'stations');
    return [
      {
        kind: SERVER_ERROR_KIND,
        fieldTree: places ? this.categoryForm.places : this.categoryForm.stations,
        message: this.i18n.t('PRODUCT_CATEGORIES.ERROR.PLACES_FORBIDDEN'),
      },
    ];
  }

  /** The `422` and the `409` with details (a parent that is a cycle, too many categories): each detail lands on its field. */
  private fieldErrors(error: ApiError): TreeValidationResult {
    const fields: Record<string, ReadonlyFieldTree<unknown>> = {};
    for (const { field } of error.details) {
      const found = resolveField(this.categoryForm, formPath(field, this.requiredLang()));
      if (found !== undefined) {
        fields[field] = found;
      }
    }
    const mapped = serverFieldErrors(this.i18n, error, fields);
    const matched = error.details.filter((detail) => Object.hasOwn(fields, detail.field));
    const first = SECTION_ORDER.find((id) => matched.some((detail) => sectionOf(detail.field) === id));
    if (first !== undefined) {
      this.section.set(first);
    }
    if (mapped.unmatched) {
      this.failure.set(
        this.i18n.t(
          error.details.some((detail) => detail.issue === 'tooMany')
            ? 'PRODUCT_CATEGORIES.ERROR.TOO_MANY'
            : 'ERRORS.API.VALIDATION_ERROR',
        ),
      );
    }
    return mapped.errors;
  }

  private settle(leave: boolean): void {
    this.pendingLeave?.(leave);
    this.pendingLeave = null;
  }
}
