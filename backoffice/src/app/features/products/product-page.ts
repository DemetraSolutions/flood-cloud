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
import { ApiData, ApiPage } from '../../core/api/api.types';
import { ApiError, apiErrorMessageKey } from '../../core/api/api-error';
import { GroupFeatures } from '../../core/groups/group-features';
import { formatDate } from '../../core/i18n/format';
import { I18nService } from '../../core/i18n/i18n.service';
import { DEFAULT_LANGUAGE } from '../../core/i18n/language';
import { TPipe } from '../../core/i18n/t-pipe';
import { ReferenceApi } from '../../core/reference/reference-api';
import { ReferenceStore } from '../../core/reference/reference-store';
import { SessionService } from '../../core/session/session.service';
import { readStorage, writeStorage } from '../../core/storage';
import { failureMessage, fieldErrorMessage, focusFirstError, SERVER_ERROR_KIND, serverFieldErrors } from '../../shared/forms/form-errors';
import { Button } from '../../shared/ui/button/button';
import { ConfirmDialog } from '../../shared/ui/confirm-dialog/confirm-dialog';
import { ErrorState } from '../../shared/ui/error-state/error-state';
import { FormError } from '../../shared/ui/form-error/form-error';
import { PageHeader } from '../../shared/ui/page-header/page-header';
import { Select, SelectOption } from '../../shared/ui/select/select';
import { TabItem, TabList } from '../../shared/ui/tab-list/tab-list';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { IdempotencyKey } from '../../shared/util/idempotency';
import { isStale, resolveField } from '../companies/company-errors';
import { withCurrent } from '../companies/company-options';
import { dateIssue, datesReversed, numberIssue } from '../groups/catalogs/catalog-fields';
import { languageName } from '../groups/languages';
import { RecordGroup } from '../groups/record-group';
import { loadAll } from '../places/lookup-loader';
import { textIssues } from '../product-catalog/catalog-item-texts';
import { ProductCatalogApi } from '../product-catalog/product-catalog-api';
import {
  ATTRIBUTE_GROUPS_SEGMENT,
  AttributeGroup,
  FALLBACK_LANGUAGE,
  GroupTax,
  LocalizedText,
  requiredLanguage,
  textOf,
  Versioned,
} from '../product-catalog/product-catalog.types';
import { CategoryCheckList } from '../product-categories/category-check-list';
import { CategoryStations } from '../product-categories/category-stations';
import { PlaceSetupReader } from '../product-categories/category-place-setup';
import { CATEGORIES_SEGMENT, CategoryNode, flatten } from '../product-categories/category.types';
import { apiErrorOf } from '../profile/sessions';
import { isReferenced } from '../product-categories/category-errors';
import { ProductApi } from './product-api';
import { ProductAttributes } from './product-attributes';
import { ProductAvailability } from './product-availability';
import { ProductBarcodes } from './product-barcodes';
import { ProductComponents } from './product-components';
import { ProductBlock, productReferenceGroups } from './product-errors';
import { ProductGeneral } from './product-general';
import { ProductMargin } from './product-margin';
import { ProductMedia } from './product-media';
import { ProductMenu } from './product-menu';
import {
  anyIssue,
  BodyContext,
  barcodeIssues,
  choiceIssues,
  codeIssue,
  componentIssues,
  createBody,
  fileNameIssue,
  menuIssues,
  ModelDefaults,
  modelChanged,
  patchBody,
  placeIssues,
  pluIssue,
  ProductModel,
  shortNameIssue,
  stockIssues,
  supplierIssues,
  supplierListIssues,
  toModel,
  urlIssue,
} from './product-model';
import { newPriceRow, priceIssues } from './product-prices';
import { ProductPriceRules } from './product-price-rules';
import { ProductReferenceBlock } from './product-reference-block';
import { ProductShipping } from './product-shipping';
import { ProductStock } from './product-stock';
import { ProductSuppliers } from './product-suppliers';
import { ProductVariants } from './product-variants';
import {
  FAMILIES,
  FamilySettings,
  featuresOf,
  MODULAR_PRICE_RULES,
  Product,
  ProductFamily,
  productRoute,
  PRODUCT_LIMITS,
  ProductType,
} from './product.types';

/** The tabs of the page, in the order of the legacy form. */
export const PRODUCT_SECTIONS = [
  'general',
  'barcodes',
  'prices',
  'categories',
  'availability',
  'variants',
  'stations',
  'stock',
  'attributes',
  'composition',
  'media',
  'margin',
  'suppliers',
  'shipping',
] as const;

/** A tab of the page. */
export type ProductSection = (typeof PRODUCT_SECTIONS)[number];

/** The views of the page: the quick one has the tabs of the legacy "basic" form. */
export type ProductView = 'quick' | 'full';

/** Fields of the stores: the ones a caller who manages only their own stores can edit (the other fields belong to `core`). */
const LOCAL_FIELDS: Readonly<Record<string, 'places' | 'stations' | 'stock'>> = {
  places: 'places',
  printStations: 'stations',
  counterPrintStations: 'stations',
  stock: 'stock',
};

/** Fields that are a whole list: the server's error on any of its parts lands on the list. */
const LIST_FIELDS = [
  'barcodes',
  'prices',
  'components',
  'menu',
  'modifierChoices',
  'suppliers',
  'gallery',
  'categoryIds',
  'attributeIds',
  'requiredModifierIds',
  'modifierIds',
  'excludedModifierIds',
  'modifierCategoryIds',
] as const;

/** Fields of the form that have a text for each language. */
const TEXT_FIELDS = ['name', 'shortName', 'description', 'shortDescription'] as const;

/** The tab of a field of the server (its first segment). */
export function sectionOf(field: string): ProductSection {
  switch (field.split('.')[0]) {
    case 'barcodes':
      return 'barcodes';
    case 'prices':
      return 'prices';
    case 'categoryIds':
      return 'categories';
    case 'places':
      return 'availability';
    case 'requiredModifierIds':
    case 'modifierIds':
    case 'excludedModifierIds':
    case 'modifierCategoryIds':
      return 'variants';
    case 'printStations':
    case 'counterPrintStations':
      return 'stations';
    case 'stock':
      return 'stock';
    case 'attributeIds':
      return 'attributes';
    case 'components':
    case 'menu':
    case 'modifierChoices':
    case 'modularPriceRule':
      return 'composition';
    case 'image':
    case 'gallery':
    case 'internalFileName':
    case 'externalUrl':
      return 'media';
    case 'simpleCost':
      return 'margin';
    case 'suppliers':
      return 'suppliers';
    case 'shipping':
      return 'shipping';
    default:
      return 'general';
  }
}

/**
 * The path in the form of a field of the server: the fields of the stores live in `local` (the
 * lists of the print stations in one field), every other field in `core`; the errors on a part of
 * a list land on the list, and a text without a language is the one of the required language.
 */
export function formPath(field: string, requiredLang: string): string {
  const [first, ...rest] = field.split('.');
  const local = Object.hasOwn(LOCAL_FIELDS, first) ? LOCAL_FIELDS[first] : undefined;
  if (local !== undefined) {
    return `local.${local}`;
  }
  if ((LIST_FIELDS as readonly string[]).includes(first)) {
    return `core.${first}`;
  }
  if (rest.length === 0 && (TEXT_FIELDS as readonly string[]).includes(first)) {
    return `core.${first}.${requiredLang}`;
  }
  return first === 'isModifier' ? 'core.type' : `core.${field}`;
}

/** What a product that exists starts with: nothing (the defaults are for a new one). */
const NO_DEFAULTS: ModelDefaults = { type: 'product', prices: [], places: [] };

/** The `localStorage` key of the view of the page a user prefers. */
function viewKey(userId: string | undefined): string {
  return `fc.productView.${userId ?? 'anonymous'}`;
}

/**
 * One product of a group (`/groups/:groupId/<family>/:productId`, or `new`) with the tabs of the
 * legacy form: general, barcodes, prices, categories, availability, variants, print stations,
 * stock, attributes, composition, media, margin, suppliers and shipping. A tab or a field is there
 * only when the group has the feature it needs and the type of the product allows it. A selector
 * switches between the quick view (the tabs of the legacy "basic" form: general with prices,
 * barcodes, colors and image, categories, availability, variants and print stations) and the full
 * one, and remembers the choice for the user; switching never loses the changes. One save in the
 * header sends what changed with the version read in `If-Match` (`412` and a `409` without details
 * ask to reload); the creation presents an `Idempotency-Key`.
 *
 * What the user can change is decided by the server: with `editable` everything, with only
 * `placeEditable` (a company or store administrator on a product shared with others) the
 * availability of their own stores, the print stations and the stock limits, without either the page
 * is read only. A product in the trash opens read only with "Restore" and "Delete for good".
 * Codes, PLUs and barcodes other products use too show a warning and never block the save.
 */
@Component({
  selector: 'fc-product-page',
  imports: [
    Button,
    CategoryCheckList,
    CategoryStations,
    ConfirmDialog,
    ErrorState,
    FormError,
    FormField,
    PageHeader,
    ProductAttributes,
    ProductAvailability,
    ProductBarcodes,
    ProductComponents,
    ProductGeneral,
    ProductMargin,
    ProductMedia,
    ProductMenu,
    ProductPriceRules,
    ProductReferenceBlock,
    ProductShipping,
    ProductStock,
    ProductSuppliers,
    ProductVariants,
    RecordGroup,
    RouterLink,
    Select,
    TabList,
    TPipe,
  ],
  providers: [PlaceSetupReader],
  templateUrl: './product-page.html',
  styleUrl: './product-page.css',
})
export class ProductPage {
  private readonly api = inject(ProductApi);
  private readonly catalog = inject(ProductCatalogApi);
  private readonly reference = inject(ReferenceApi);
  private readonly store = inject(ReferenceStore);
  private readonly session = inject(SessionService);
  private readonly groupFeatures = inject(GroupFeatures);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  private readonly injector = inject(Injector);
  private readonly key = new IdempotencyKey();
  protected readonly i18n = inject(I18nService);

  /** Route parameters, route data and query parameters (bound by the router); no `productId` on the page of a new product. */
  readonly groupId = input.required<string>();
  readonly productId = input<string>();
  /** Route data: the family of the section the page was opened from (the family of a product that exists is its own). */
  readonly family = input<string>();
  /** Query parameter: `quick` or `full` overrides the view the user prefers. */
  readonly view = input<string>();

  protected readonly isNew = computed(() => this.productId() === undefined);
  /** Company and store administrators see and choose only the stores of their perimeter. */
  protected readonly restricted = computed(() => {
    const role = this.session.me()?.role;
    return role === 'CA' || role === 'PA';
  });
  protected readonly features = computed(() =>
    featuresOf((name) => this.groupFeatures.enabledFor(this.groupId(), name)),
  );

  private readonly loaded = resource({
    params: () => {
      const productId = this.productId();
      return productId === undefined ? undefined : { groupId: this.groupId(), productId };
    },
    loader: ({ params }) => this.api.read(params.groupId, params.productId),
  });
  /** The product as the server has it, and its version; replaced by every save. */
  private readonly saved = linkedSignal<Versioned<Product> | undefined, Versioned<Product> | null>({
    // `value()` throws while the resource is in error: read it only when there is one.
    source: () => (this.loaded.hasValue() ? this.loaded.value() : undefined),
    computation: (value) => value ?? null,
  });
  protected readonly item = computed(() => this.saved()?.item ?? null);
  protected readonly warnings = computed(() => this.item()?.warnings ?? []);
  protected readonly loadingItem = computed(() => !this.isNew() && this.loaded.isLoading());
  protected readonly failed = computed(() => this.loaded.error() !== undefined);
  protected readonly loadError = computed(() => apiErrorOf(this.loaded.error()));
  protected readonly loadErrorMessage = computed(() => {
    const error = this.loadError();
    return this.i18n.t(error === null ? 'ERRORS.GENERIC.MESSAGE' : apiErrorMessageKey(error));
  });

  /** The family of the page: the one of the product, or the one of the section for a new product. */
  protected readonly familySettings = computed<FamilySettings>(() => {
    const own = this.item()?.family;
    const routed = this.family() as ProductFamily | undefined;
    return FAMILIES[own ?? (routed !== undefined && Object.hasOwn(FAMILIES, routed) ? routed : 'products')];
  });
  protected readonly isModifier = computed(() => this.item()?.isModifier ?? this.familySettings().modifier);
  protected readonly listRoute = computed(() => productRoute(this.groupId(), this.familySettings().family));

  // What the user may do.
  private readonly canUpdate = computed(() => this.session.can('products:update'));
  protected readonly trashed = computed(() => this.item()?.trashed === true);
  /** The user may change the whole product. */
  protected readonly fullEdit = computed(() => {
    const item = this.item();
    return this.canUpdate() && !this.trashed() && (item === null || item.editable);
  });
  /** The user may change only the data of their own stores. */
  protected readonly localEdit = computed(() => {
    const item = this.item();
    return this.canUpdate() && !this.trashed() && item !== null && !item.editable && item.placeEditable;
  });
  protected readonly canWrite = computed(() => this.fullEdit() || this.localEdit());
  /** A product for every store: whoever manages only their own stores cannot limit it, so its availability is not theirs to change. */
  protected readonly placesLocked = computed(() => this.localEdit() && this.item()!.places.length === 0);
  /** The user holds the write permission but the server says the product is not theirs to change as a whole. */
  protected readonly sharedNote = computed(() => this.canUpdate() && !this.trashed() && !this.isNew() && !this.fullEdit());
  protected readonly canRestoreOrDelete = computed(() => this.canUpdate() && this.trashed() && this.item()?.editable === true);

  // Languages: the ones of the group (`it` when the read fails: the server then decides) and the ones the product has.
  private readonly languagesResource = httpResource<ApiData<{ code: string }[]>>(
    () => `/v1/groups/${encodeURIComponent(this.groupId())}/lookup/languages`,
  );
  protected readonly groupLanguages = computed(() => {
    const codes = this.languagesResource.hasValue() ? this.languagesResource.value().data.map((language) => language.code) : [];
    return codes.length > 0 ? codes : [FALLBACK_LANGUAGE];
  });
  protected readonly languages = computed(() => {
    const item = this.item();
    return [
      ...new Set([
        ...this.groupLanguages(),
        ...[item?.name, item?.shortName, item?.description, item?.shortDescription, item?.modifier?.description].flatMap((texts) => Object.keys(texts ?? {})),
      ]),
    ];
  });
  protected readonly requiredLang = computed(() => requiredLanguage(this.groupLanguages(), this.i18n.language() ?? DEFAULT_LANGUAGE));

  // The references the form chooses from.
  private readonly tree = httpResource<ApiData<CategoryNode[]>>(
    () => `${this.catalog.baseUrl(this.groupId(), CATEGORIES_SEGMENT)}/tree`,
  );
  protected readonly treeEntries = computed(() => (this.tree.hasValue() ? flatten(this.tree.value().data) : []));
  protected readonly treeFailed = computed(() => this.tree.error() !== undefined);
  protected readonly places = resource({
    params: () => this.groupId(),
    loader: ({ params }) => loadAll(this.store, params, 'places'),
  });
  protected readonly placeList = computed(() => (this.places.hasValue() ? this.places.value() : []));
  protected readonly placesFailed = computed(() => this.places.error() !== undefined);
  private readonly brandsResource = httpResource<ApiPage<{ id: string; name: LocalizedText }>>(() => ({
    url: this.catalog.baseUrl(this.groupId(), 'product-brands'),
    params: { limit: 100, sort: 'name' },
  }));
  private readonly attributesResource = httpResource<ApiPage<AttributeGroup>>(() => ({
    url: this.catalog.baseUrl(this.groupId(), ATTRIBUTE_GROUPS_SEGMENT),
    params: { limit: 100, sort: 'name' },
  }));
  protected readonly attributeGroups = computed(() => (this.attributesResource.hasValue() ? this.attributesResource.value().data : []));
  protected readonly attributesTruncated = computed(() => this.attributesResource.hasValue() && this.attributesResource.value().page.next !== null);
  private readonly priceListsResource = httpResource<ApiData<{ id: string; name: string; enabled: boolean }[]>>(
    () => `/v1/groups/${encodeURIComponent(this.groupId())}/lookup/price-lists`,
  );
  private readonly taxesResource = httpResource<ApiData<GroupTax[]>>(
    () => `/v1/groups/${encodeURIComponent(this.groupId())}/lookup/taxes`,
  );
  // Currencies and units of measure: when a read fails the page offers the ones the product already has (and the euro).
  private readonly currenciesResource = httpResource<ApiData<{ code: string }[]>>(
    () => `/v1/groups/${encodeURIComponent(this.groupId())}/lookup/currencies`,
  );
  private readonly unitsResource = httpResource<ApiData<{ value: string }[]>>(
    () => `/v1/groups/${encodeURIComponent(this.groupId())}/lookup/measure-units`,
  );
  protected readonly taxes = computed(() => (this.taxesResource.hasValue() ? this.taxesResource.value().data : []));
  protected readonly currencies = computed(() => {
    const codes = this.currenciesResource.hasValue() ? this.currenciesResource.value().data.map((currency) => currency.code) : [];
    return codes.length > 0 ? codes : ['EUR'];
  });
  protected readonly priceListOptions = computed<SelectOption[]>(() =>
    (this.priceListsResource.hasValue() ? this.priceListsResource.value().data : [])
      .filter((list) => list.enabled)
      .map((list) => ({ value: list.id, label: list.name })),
  );
  protected readonly brandOptions = computed<SelectOption[]>(() =>
    withCurrent(
      (this.brandsResource.hasValue() ? this.brandsResource.value().data : []).map((brand) => ({
        value: brand.id,
        label: textOf(brand.name, this.i18n.language() ?? DEFAULT_LANGUAGE),
      })),
      this.model().core.brandId,
      (id) => id,
    ),
  );
  protected readonly unitOptions = computed<SelectOption[]>(() => {
    const listed = (this.unitsResource.hasValue() ? this.unitsResource.value().data : []).map((unit) => ({ value: unit.value, label: unit.value }));
    const { loadUnit, unloadUnit } = this.model().core;
    return withCurrent(withCurrent(listed, loadUnit, (value) => value), unloadUnit, (value) => value);
  });
  /** A new product waits for what it starts with: the price lists, the tax rates and the currencies, and, for a company or store administrator, the stores. */
  private readonly loadingDefaults = computed(
    () =>
      this.isNew() &&
      (this.priceListsResource.isLoading() ||
        this.taxesResource.isLoading() ||
        this.currenciesResource.isLoading() ||
        (this.restricted() && this.places.isLoading())),
  );
  protected readonly loading = computed(() => this.loadingItem() || this.languagesResource.isLoading() || this.loadingDefaults());

  /** What a new product starts with: a price rule for each price list and, for a restricted user, their own stores. */
  private readonly defaults = computed<ModelDefaults>(() => {
    const tax = this.taxes()[0];
    const currency = this.currencies()[0];
    const lists = (this.priceListsResource.hasValue() ? this.priceListsResource.value().data : []).filter((list) => list.enabled);
    return {
      type: this.familySettings().defaultType,
      prices: tax === undefined ? [] : lists.map((list) => newPriceRow(list.id, currency, tax.id, tax.rate)),
      places: this.restricted()
        ? this.placeList().map((place) => ({ placeId: place.id, favorite: false, favoriteHandheld: false, position: '', productionCenterId: '' }))
        : [],
    };
  });

  protected readonly model = linkedSignal<ProductModel>(() => this.initial());
  private readonly base = computed(() => this.initial());
  protected readonly context = computed<BodyContext>(() => ({ features: this.features(), modifier: this.isModifier() }));
  protected readonly productForm = form(this.model, (path) => {
    const amount = { min: 0, max: PRODUCT_LIMITS.number, optional: true } as const;
    const number = (text: string, rule: Parameters<typeof numberIssue>[1]) => {
      const issue = numberIssue(text, rule);
      return issue === undefined ? undefined : { kind: issue };
    };
    const kind = (issue: string | undefined) => (issue === undefined ? undefined : { kind: issue });
    validate(path.core.code, ({ value }) => kind(codeIssue(value())));
    validate(path.core.plu, ({ value }) => kind(pluIssue(value())));
    validate(path.core.position, ({ value }) => number(value(), { min: 0, max: PRODUCT_LIMITS.position, integer: true, optional: true }));
    validate(path.core.productionValue, ({ value }) => number(value(), { min: 0, max: PRODUCT_LIMITS.position, integer: true, optional: true }));
    validate(path.core.maxConcurrent, ({ value }) => number(value(), { min: 0, max: PRODUCT_LIMITS.maxConcurrent, integer: true, optional: true }));
    validate(path.core.conversionRatio, ({ value }) => number(value(), { min: 0.000001, max: PRODUCT_LIMITS.number, optional: true }));
    validate(path.core.dining.feePercentage, ({ value }) => number(value(), { min: 0, max: PRODUCT_LIMITS.percentage, optional: true }));
    validate(path.core.modifier.pricePercentagePlus, ({ value }) => number(value(), { min: 0, max: PRODUCT_LIMITS.modifierPlus, optional: true }));
    validate(path.core.modifier.pricePercentageMinus, ({ value }) => number(value(), { min: 0, max: PRODUCT_LIMITS.percentage, optional: true }));
    validate(path.core.simpleCost, ({ value }) => number(value(), amount));
    for (const side of ['width', 'height', 'depth', 'weight'] as const) {
      validate(path.core.shipping[side], ({ value }) => number(value(), amount));
    }
    validate(path.core.validFrom, ({ value }) => kind(dateIssue(value())));
    validate(path.core.validTo, ({ valueOf }) => {
      const core = valueOf(path.core);
      return kind(dateIssue(core.validTo) ?? (datesReversed(core.validFrom, core.validTo) ? 'incorrect' : undefined));
    });
    validate(path.core.internalFileName, ({ value }) => kind(fileNameIssue(value())));
    validate(path.core.externalUrl, ({ value }) => kind(urlIssue(value())));
    validate(path.core.barcodes, ({ value }) => {
      const values = value().map((row) => row.value.trim());
      const repeated = values.some((text, index) => text !== '' && values.indexOf(text) !== index);
      return anyIssue(value(), barcodeIssues) || repeated || value().length > PRODUCT_LIMITS.barcodes ? { kind: 'incorrect' } : undefined;
    });
    validate(path.core.prices, ({ value }) =>
      anyIssue(value(), priceIssues) || value().length > PRODUCT_LIMITS.prices ? { kind: 'incorrect' } : undefined,
    );
    validate(path.core.components, ({ value }) => {
      const ids = value().map((row) => row.productId);
      const repeated = ids.some((id, index) => ids.indexOf(id) !== index);
      return anyIssue(value(), componentIssues) || repeated ? { kind: 'incorrect' } : undefined;
    });
    validate(path.core.menu, ({ value }) => (anyIssue(value(), menuIssues) ? { kind: 'incorrect' } : undefined));
    validate(path.core.modifierChoices, ({ value }) => (anyIssue(value(), choiceIssues) ? { kind: 'incorrect' } : undefined));
    validate(path.core.suppliers, ({ value }) => {
      const ids = value().map((row) => row.contactId.trim());
      const repeated = ids.some((id, index) => ids.indexOf(id) !== index);
      const wrong = anyIssue(value(), supplierIssues) || value().some((row) => anyIssue(row.priceLists, supplierListIssues));
      return wrong || repeated ? { kind: 'incorrect' } : undefined;
    });
    validate(path.local.places, ({ value }) => {
      if (this.restricted() && !this.placesLocked() && value().length === 0) {
        return { kind: 'required' };
      }
      return anyIssue(value(), placeIssues) ? { kind: 'type' } : undefined;
    });
    validate(path.local.stock, ({ value }) => (anyIssue(value(), stockIssues) ? { kind: 'incorrect' } : undefined));
    validateTree(path, ({ value, fieldTree }) => {
      const current = this.item();
      const required = this.requiredLang();
      const core = value().core;
      const problems = textIssues(core.name, core.description, required, current === null || (current.name[required] ?? '') !== '').map((problem) => ({
        kind: problem.issue,
        fieldTree: fieldTree.core[problem.part][problem.language],
      }));
      for (const [language, text] of Object.entries(core.shortName)) {
        const issue = shortNameIssue(text);
        if (issue !== undefined) {
          problems.push({ kind: issue, fieldTree: fieldTree.core.shortName[language] });
        }
      }
      return problems;
    });
    disabled(path.core, () => !this.fullEdit());
    disabled(path.local.stations, () => !this.canWrite());
    disabled(path.local.stock, () => !this.canWrite());
    disabled(path.local.places, () => !this.canWrite() || this.placesLocked());
  });

  /** What the server would receive: what differs from the saved product (everything, for a new one). */
  protected readonly body = computed(() =>
    this.item() === null
      ? createBody(this.model(), this.context())
      : patchBody(this.model(), this.base(), this.context(), this.fullEdit() ? 'full' : 'local'),
  );
  /** Whether the form differs from the saved product, or, for a new one, from the empty form. */
  protected readonly unsaved = computed(() =>
    this.item() === null ? modelChanged(this.model(), this.base()) : Object.keys(this.body()).length > 0,
  );
  protected readonly failure = signal<string | null>(null);
  /** The version read is no longer the current one (`412` or a concurrent change): the page offers to read again. */
  protected readonly stale = signal(false);
  protected readonly submitting = computed(() => this.productForm().submitting());

  // The view and the tabs.
  private readonly preferred = computed<ProductView>(() => (readStorage(viewKey(this.session.me()?.id)) === 'quick' ? 'quick' : 'full'));
  protected readonly viewMode = linkedSignal<ProductView>(() => {
    const requested = this.view();
    return requested === 'quick' || requested === 'full' ? requested : this.preferred();
  });
  protected readonly quick = computed(() => this.viewMode() === 'quick');
  protected readonly section = signal<ProductSection>('general');
  protected readonly type = computed<ProductType>(() => this.model().core.type);
  protected readonly service = computed(() => this.type() === 'service');
  /** The types the user can choose among: the ones of the family the group has the feature for, and the one the product already has. */
  protected readonly types = computed<ProductType[]>(() => {
    const features = this.features();
    const family = this.familySettings();
    const allowed = family.types.filter((type) => (type === 'service' ? features.services : type === 'product' || type === 'exempt' || features.tobaccosGamesMonopoly));
    const current = this.item()?.type;
    return current === undefined || current === null || allowed.includes(current) ? allowed : [...allowed, current];
  });
  protected readonly shown = computed<Readonly<Record<ProductSection, boolean>>>(() => {
    const features = this.features();
    const modifier = this.isModifier();
    const service = this.service();
    const quick = this.quick();
    return {
      general: true,
      barcodes: !quick && !service,
      prices: !quick,
      categories: true,
      availability: true,
      variants: features.productsVariants && !modifier,
      stations: features.ordering && !modifier && !service,
      stock: !quick && features.warehouse && !service,
      attributes: !quick,
      composition: !quick,
      media: !quick && features.media,
      margin: !quick,
      suppliers: !quick && !service,
      shipping: !quick && !service,
    };
  });
  protected readonly errorCounts = computed<Record<ProductSection, number>>(() => {
    const shown = (field: ReadonlyFieldTree<unknown>): number => (fieldErrorMessage(this.i18n, field()) === null ? 0 : 1);
    const c = this.productForm.core;
    const l = this.productForm.local;
    const everyLanguage = (field: 'name' | 'shortName' | 'description' | 'shortDescription') =>
      this.languages().reduce((sum, language) => sum + shown(c[field][language]), 0);
    return {
      general:
        [c.code, c.plu, c.position, c.productionValue, c.maxConcurrent, c.validFrom, c.validTo, c.conversionRatio, c.dining.feePercentage, c.modifier.pricePercentagePlus, c.modifier.pricePercentageMinus, c.type].reduce(
          (sum, field) => sum + shown(field),
          0,
        ) +
        everyLanguage('name') +
        everyLanguage('shortName') +
        everyLanguage('description') +
        everyLanguage('shortDescription'),
      barcodes: shown(c.barcodes),
      prices: shown(c.prices),
      categories: shown(c.categoryIds),
      availability: shown(l.places),
      variants: shown(c.requiredModifierIds) + shown(c.modifierIds) + shown(c.excludedModifierIds) + shown(c.modifierCategoryIds),
      stations: shown(l.stations),
      stock: shown(l.stock),
      attributes: shown(c.attributeIds),
      composition: shown(c.components) + shown(c.menu) + shown(c.modifierChoices) + shown(c.modularPriceRule),
      media: shown(c.image) + shown(c.gallery) + shown(c.internalFileName) + shown(c.externalUrl),
      margin: shown(c.simpleCost),
      suppliers: shown(c.suppliers),
      shipping: shown(c.shipping.width) + shown(c.shipping.height) + shown(c.shipping.depth) + shown(c.shipping.weight),
    };
  });
  protected readonly tabs = computed<TabItem[]>(() => {
    const counts = this.errorCounts();
    const shown = this.shown();
    return PRODUCT_SECTIONS.filter((id) => shown[id]).map((id) => ({
      id,
      label: this.i18n.t(`PRODUCTS.SECTION.${id.toUpperCase()}`),
      errors: counts[id],
    }));
  });
  /** The tab to show: the chosen one, or the first one when the view or the type hides it. */
  protected readonly modularOptions = computed<SelectOption[]>(() =>
    MODULAR_PRICE_RULES.map((rule) => ({ value: rule, label: this.i18n.t(`PRODUCTS.COMPOSITION.RULE_${rule.toUpperCase()}`) })),
  );
  protected readonly activeSection = computed<ProductSection>(() => (this.shown()[this.section()] ? this.section() : 'general'));
  /** The ids of the modifiers chosen in the three lists of the variants tab. */
  protected readonly chosenModifiers = computed(() => {
    const core = this.model().core;
    return [...core.requiredModifierIds, ...core.modifierIds, ...core.excludedModifierIds];
  });

  // Trashed products: restore and delete for good.
  protected readonly deleteOpen = signal(false);
  protected readonly busy = signal(false);
  protected readonly blocked = signal<ProductBlock | null>(null);

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

  /** The form model of the product as the server has it, or the one of a new product. */
  private initial(): ProductModel {
    const item = this.item();
    return toModel(item, this.languages(), item === null ? this.defaults() : NO_DEFAULTS);
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

  protected select(id: string): void {
    this.section.set(id as ProductSection);
  }

  /** Switches between the quick and the full view and remembers the choice; nothing typed is lost. */
  protected setView(view: ProductView): void {
    this.viewMode.set(view);
    writeStorage(viewKey(this.session.me()?.id), view);
  }

  protected async onSubmit(event: Event): Promise<void> {
    event.preventDefault();
    await submit(this.productForm, {
      action: async () => {
        this.failure.set(null);
        this.stale.set(false);
        const wasNew = this.isNew();
        let result: Versioned<Product>;
        try {
          result = wasNew
            ? await this.api.create(this.groupId(), this.body(), this.key.forBody(this.body()))
            : await this.api.update(this.groupId(), this.productId() as string, this.body(), (this.saved() as Versioned<Product>).etag);
        } catch (error) {
          return this.reject(error);
        }
        this.key.reset();
        this.saved.set(result);
        // The compact lists of products (and the categories' counts) show the change.
        this.store.invalidate(this.groupId(), 'products');
        this.toast.success(this.i18n.t(wasNew ? 'PRODUCTS.FORM.CREATED' : 'PRODUCTS.FORM.SAVED'));
        if (wasNew) {
          await this.router.navigate(productRoute(this.groupId(), result.item.family, result.item.id));
        }
        return undefined;
      },
      onInvalid: () => this.revealFirstError(),
    });
  }

  /** Takes the product out of the trash. */
  protected async restore(): Promise<void> {
    this.busy.set(true);
    this.failure.set(null);
    try {
      const result = await this.api.restore(this.groupId(), this.productId() as string, (this.saved() as Versioned<Product>).etag);
      this.saved.set(result);
      this.store.invalidate(this.groupId(), 'products');
      this.toast.success(this.i18n.t('PRODUCTS.RESTORE.DONE'));
    } catch (error) {
      this.settleFailure(error);
    } finally {
      this.busy.set(false);
    }
  }

  /** Deletes the product for good; when something refers to it the panel says what. */
  protected async remove(): Promise<void> {
    const item = this.item() as Product;
    const name = textOf(item.name, this.i18n.language() ?? DEFAULT_LANGUAGE);
    this.busy.set(true);
    this.failure.set(null);
    try {
      await this.api.remove(this.groupId(), item.id, (this.saved() as Versioned<Product>).etag);
    } catch (error) {
      if (isReferenced(error)) {
        this.blocked.set({ product: name, groups: await productReferenceGroups(this.reference, this.groupId(), error) });
      } else {
        this.settleFailure(error);
      }
      this.busy.set(false);
      this.deleteOpen.set(false);
      return;
    }
    this.busy.set(false);
    this.deleteOpen.set(false);
    this.store.invalidate(this.groupId(), 'products');
    this.toast.success(this.i18n.t('PRODUCTS.DELETE.DONE', { name }));
    await this.router.navigate(this.listRoute());
  }

  /** The failure of an action that is not a save: a stale version asks to read again, the rest has its message. */
  private settleFailure(error: unknown): void {
    if (isStale(error) || (error instanceof ApiError && error.code === 'CONFLICT')) {
      this.stale.set(true);
      this.failure.set(this.i18n.t('PRODUCTS.FORM.STALE'));
    } else if (error instanceof ApiError && error.code === 'FORBIDDEN') {
      this.failure.set(this.i18n.t('PRODUCT_CATALOG.ERROR.FORBIDDEN'));
    } else {
      this.failure.set(failureMessage(this.i18n, error));
    }
  }

  /** Opens the first tab that has an error (switching to the full view when the error is in a tab the quick one lacks) and moves the focus to its first field. */
  private revealFirstError(): void {
    const counts = this.errorCounts();
    // The form is invalid, so some tab has an error.
    this.openSection(PRODUCT_SECTIONS.find((id) => counts[id] > 0) as ProductSection);
    // The panel is hidden until the tab is shown: focus once the page has rendered it.
    afterNextRender(() => focusFirstError(this.productForm), { injector: this.injector });
  }

  private openSection(id: ProductSection): void {
    if (!this.shown()[id]) {
      this.viewMode.set('full');
    }
    this.section.set(id);
  }

  private reject(error: unknown): TreeValidationResult {
    if (isStale(error)) {
      this.stale.set(true);
      this.failure.set(this.i18n.t('PRODUCTS.FORM.STALE'));
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
    this.settleFailure(error);
    return undefined;
  }

  /** A `403` that names fields: the ones of the stores say what the user may not do, the others mean the product is not theirs to change. */
  private forbidden(error: ApiError): TreeValidationResult {
    const places = error.details.some((detail) => detail.field.split('.')[0] === 'places');
    const stations = error.details.some((detail) => sectionOf(detail.field) === 'stations');
    if (!places && !stations) {
      this.failure.set(this.i18n.t('PRODUCT_CATALOG.ERROR.FORBIDDEN'));
      return undefined;
    }
    this.openSection(places ? 'availability' : 'stations');
    return [
      {
        kind: SERVER_ERROR_KIND,
        fieldTree: places ? this.productForm.local.places : this.productForm.local.stations,
        message: this.i18n.t('PRODUCTS.ERROR.PLACES_FORBIDDEN'),
      },
    ];
  }

  /** The `422` and the `409` with details (a cycle in the bill of materials, too many items): each detail lands on its field. */
  private fieldErrors(error: ApiError): TreeValidationResult {
    const fields: Record<string, ReadonlyFieldTree<unknown>> = {};
    for (const { field } of error.details) {
      const found = resolveField(this.productForm, formPath(field, this.requiredLang()));
      // A field the form does not have resolves to its group: that is no place for the message.
      if (found !== undefined && found !== this.productForm.core && found !== this.productForm.local) {
        fields[field] = found;
      }
    }
    const mapped = serverFieldErrors(this.i18n, error, fields);
    const matched = error.details.filter((detail) => Object.hasOwn(fields, detail.field));
    const first = PRODUCT_SECTIONS.find((id) => matched.some((detail) => sectionOf(detail.field) === id));
    if (first !== undefined) {
      this.openSection(first);
    }
    if (mapped.unmatched) {
      this.failure.set(
        this.i18n.t(error.details.some((detail) => detail.issue === 'tooMany') ? 'PRODUCTS.ERROR.TOO_MANY' : 'ERRORS.API.VALIDATION_ERROR'),
      );
    }
    return mapped.errors;
  }

  private settle(leave: boolean): void {
    this.pendingLeave?.(leave);
    this.pendingLeave = null;
  }
}
