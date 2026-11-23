import { Provider, WritableSignal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Route, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { TestRequest } from '@angular/common/http/testing';
import { I18nService } from '../app/core/i18n/i18n.service';
import { DEFAULT_LANGUAGE } from '../app/core/i18n/language';
import { ReferenceStore } from '../app/core/reference/reference-store';
import { Profile } from '../app/core/session/session.types';
import { PlacesApi } from '../app/features/places/places-api';
import { languageName } from '../app/features/groups/languages';
import { leaveProduct } from '../app/features/products/product-leave';
import { ProductModel } from '../app/features/products/product-model';
import { ProductPage } from '../app/features/products/product-page';
import { FAMILIES, Product } from '../app/features/products/product.types';
import { ToastService } from '../app/shared/ui/toast/toast.service';
import { API, backend, errorBody, provideApiTesting, settle } from './api';
import { emulateNativeDialog } from './dialog';
import { errorOf, findControl } from './forms';
import { fakeFeatureFlags } from './groups';
import { signIn } from './session';

export const GROUP = '665f1c2e9b1d4a0012ab34a1';
export const ID = '665f1c2e9b1d4a0012ab3801';
export const CAT = '665f1c2e9b1d4a0012ab3811';
export const CAT2 = '665f1c2e9b1d4a0012ab3812';
export const BRAND = '665f1c2e9b1d4a0012ab3821';
export const LIST1 = '665f1c2e9b1d4a0012ab3831';
export const LIST2 = '665f1c2e9b1d4a0012ab3832';
export const LIST3 = '665f1c2e9b1d4a0012ab3833';
export const TAX1 = '665f1c2e9b1d4a0012ab3841';
export const TAX2 = '665f1c2e9b1d4a0012ab3842';
export const P1 = '665f1c2e9b1d4a0012ab3401';
export const P2 = '665f1c2e9b1d4a0012ab3402';
export const PROD1 = '665f1c2e9b1d4a0012ab3701';
export const PROD2 = '665f1c2e9b1d4a0012ab3702';
export const SUPPLIER = '665f1c2e9b1d4a0012ab3851';
export const USER = '665f1c2e9b1d4a0012ab34ce';

export const FULL = ['products:read', 'products:update', 'places:update', 'groups:read', 'profile:read'];
export const READ_ONLY = ['products:read', 'places:update', 'groups:read', 'profile:read'];
export const NO_GROUPS = ['products:read', 'products:update', 'places:update', 'profile:read'];

export const BASE = `${API}/v1/groups/${GROUP}/products`;
export const ITEM = `${BASE}/${ID}`;
export const LANGS = `${API}/v1/groups/${GROUP}/lookup/languages`;
export const TREE_URL = `${API}/v1/groups/${GROUP}/product-categories/tree`;
export const BRANDS_URL = `${API}/v1/groups/${GROUP}/product-brands`;
export const ATTRIBUTES_URL = `${API}/v1/groups/${GROUP}/product-attribute-groups`;
export const LISTS_URL = `${API}/v1/groups/${GROUP}/lookup/price-lists`;
export const TAXES_URL = `${API}/v1/groups/${GROUP}/lookup/taxes`;
export const CURRENCIES_URL = `${API}/v1/groups/${GROUP}/lookup/currencies`;
export const UNITS_URL = `${API}/v1/groups/${GROUP}/lookup/measure-units`;
export const NEW = `/groups/${GROUP}/products/new`;
export const EDIT = `/groups/${GROUP}/products/${ID}`;
export const LIST_ROUTE = `/groups/${GROUP}/products`;

export const ALL_FEATURES = {
  cash: true,
  customersApp: true,
  tobaccosGamesMonopoly: true,
  productsVariants: true,
  ordering: true,
  rooms: true,
  media: true,
  warehouse: true,
  services: true,
  scales: true,
  advancedProducts: true,
};
export const NO_FEATURES = Object.fromEntries(Object.keys(ALL_FEATURES).map((name) => [name, false]));

/** The categories of the group: `Bevande` and, below it, `Caffè`. */
export const TREE = [
  {
    id: CAT,
    name: 'Bevande',
    parentId: null,
    position: 1,
    enabled: true,
    children: [{ id: CAT2, name: 'Caffè', parentId: CAT, position: 1, enabled: true, children: [] }],
  },
];

export const BRANDS = { data: [{ id: BRAND, name: { it: 'Illy' } }], page: { limit: 100, next: null } };
export const ATTRIBUTE_GROUPS = {
  data: [
    {
      id: '665f1c2e9b1d4a0012ab3861',
      name: { it: 'Origine' },
      attributes: [{ id: '665f1c2e9b1d4a0012ab3862', name: { it: 'Brasile' } }],
      createdAt: null,
      updatedAt: null,
    },
  ],
  page: { limit: 100, next: null },
};
export const PRICE_LISTS = [
  { id: LIST1, name: 'Listino uno', enabled: true },
  { id: LIST2, name: 'Spento', enabled: false },
  { id: LIST3, name: 'Listino tre', enabled: true },
];
export const TAXES = [
  { id: TAX1, rate: 22, department: 1, description: 'IVA 22', vatNature: null },
  { id: TAX2, rate: 10, department: 2, description: 'IVA 10', vatNature: null },
];
export const CURRENCIES = [{ code: 'EUR' }, { code: 'USD' }];
export const UNITS = [{ value: 'kg' }, { value: 'pz' }];

/** A product with a value in every field of every feature. */
export const PRODUCT: Product = {
  id: ID,
  family: 'products',
  type: 'product',
  isModifier: false,
  enabled: true,
  code: 'C1',
  plu: '12',
  name: { it: 'Caffè', en: 'Coffee' },
  shortName: { it: 'Caff' },
  description: { it: 'Caldo' },
  shortDescription: {},
  favorite: false,
  favoriteHandheld: false,
  generic: false,
  toCheck: false,
  noDiscount: false,
  brandId: BRAND,
  categoryIds: [CAT],
  attributeIds: [],
  position: 3,
  productionValue: 10,
  duration: null,
  maxConcurrent: null,
  availability: { pos: true, warehouse: true, scales: false, ecommerce: false },
  featured: false,
  integrations: { floodOrders: false, yellgo: false, leggimenu: false },
  validFrom: null,
  validTo: null,
  requiredModifierIds: [],
  modifierIds: [PROD1],
  excludedModifierIds: [],
  modifierCategoryIds: [],
  scaleType: 'weight',
  loadUnit: 'kg',
  unloadUnit: 'pz',
  conversionRatio: 1,
  colors: { text: '#ffffff', background: '#112233' },
  dining: { halfPortion: false, feePercentage: null, hiddenOnHandheld: false, affiliatedMenu: false, reversePrint: false },
  barcodes: [{ value: '8001', loadQuantity: 1, saleQuantity: 1 }],
  prices: [
    {
      id: 'r1',
      priceListId: LIST1,
      currency: 'EUR',
      taxId: TAX1,
      tax: { rate: 22, department: 1, description: 'IVA 22', vatNature: null },
      net: 1,
      gross: 1.22,
      discount: 0,
      validFrom: null,
      validTo: null,
      dailyFrom: null,
      dailyTo: null,
      weekDays: [],
      fromQuantity: 1,
      maxSaleQuantity: null,
    },
  ],
  places: [{ placeId: P1, favorite: false, favoriteHandheld: false, position: 2, productionCenterId: null }],
  printStations: {},
  counterPrintStations: {},
  stock: { [P1]: { sg1: { quantity: 5, min: 1, max: 10, location: 'A1' } } },
  costs: { last: null, average: null, weightedAverage: null, lastSupplierId: null, bySupplier: {} },
  simpleCost: null,
  suppliers: [],
  shipping: { width: null, height: null, depth: null, weight: null },
  components: [],
  menu: [],
  modifierChoices: [],
  modularPriceRule: null,
  image: null,
  gallery: [],
  internalFileName: null,
  externalUrl: null,
  editable: true,
  placeEditable: true,
  trashed: false,
  trashedAt: null,
  createdAt: '2026-11-01T08:00:00.000Z',
  updatedAt: '2026-11-10T09:30:00.000Z',
  warnings: [],
};

const NAMES: Record<string, string> = { [P1]: 'Negozio uno', [P2]: 'Negozio due' };
const PRODUCT_NAMES: Record<string, string> = { [PROD1]: 'Coca', [PROD2]: 'Fanta' };
const CATEGORY_NAMES: Record<string, string> = { [CAT]: 'Bevande', [CAT2]: 'Caffè' };

export const nameLabel = (language: string) =>
  `PRODUCTS.FIELD.NAME_IN ${JSON.stringify({ language: languageName(language, DEFAULT_LANGUAGE) })}`;
export const shortNameLabel = (language: string) =>
  `PRODUCTS.FIELD.SHORT_NAME_IN ${JSON.stringify({ language: languageName(language, DEFAULT_LANGUAGE) })}`;
export const descriptionLabel = (language: string) =>
  `PRODUCTS.FIELD.DESCRIPTION_IN ${JSON.stringify({ language: languageName(language, DEFAULT_LANGUAGE) })}`;
export const rowLabel = (key: string, number: number) => `${key} ${JSON.stringify({ number })}`;

export const L = {
  code: 'PRODUCTS.FIELD.CODE',
  plu: 'PRODUCTS.FIELD.PLU',
  position: 'PRODUCT_CATEGORIES.FIELD.POSITION',
  production: 'PRODUCT_CATEGORIES.FIELD.PRODUCTION_VALUE',
  enabled: 'PRODUCT_CATALOG.FIELD.ENABLED',
  type: 'PRODUCTS.FIELD.TYPE',
  conversion: 'PRODUCTS.FIELD.CONVERSION_RATIO',
  maxConcurrent: 'PRODUCTS.FIELD.MAX_CONCURRENT',
  fee: 'PRODUCT_CATEGORIES.DINING.FEE',
  plus: 'PRODUCTS.MODIFIER.PLUS',
  minus: 'PRODUCTS.MODIFIER.MINUS',
  from: 'PRODUCTS.PERIOD.FROM',
  to: 'PRODUCTS.PERIOD.TO',
  cost: 'PRODUCTS.MARGIN.SIMPLE_COST',
  width: 'PRODUCTS.SHIPPING.WIDTH',
  fileName: 'PRODUCT_CATEGORIES.MEDIA.INTERNAL_FILE_NAME',
  url: 'PRODUCT_CATEGORIES.MEDIA.EXTERNAL_URL',
};

/** What the reads of the page get; `'fail'` makes one fail, `'skip'` leaves the product pending. */
export interface Reads {
  languages?: string[] | 'fail';
  tree?: unknown | 'fail';
  brands?: unknown | 'fail';
  attributes?: unknown | 'fail';
  lists?: unknown | 'fail';
  taxes?: unknown;
  currencies?: unknown | 'fail';
  units?: unknown | 'fail';
  item?: Partial<Product> | 'skip' | 'fail';
  /** The status and the request id of a failed read of the product. */
  itemStatus?: number;
  requestId?: string;
  etag?: string;
  /** The page shows an existing product whatever the URL it was opened with (after a creation). */
  edit?: boolean;
}

export const fail = (code: string, status = 500) => [errorBody(code), { status, statusText: 'x' }] as const;

export interface Options {
  profile?: Partial<Profile>;
  features?: Partial<typeof ALL_FEATURES>;
  reads?: Reads | null;
  extra?: Provider[];
  /** The stores the page reads fail. */
  placesFail?: boolean;
  /** The reads of names (`lookup/products`, `lookup/product-categories`) fail. */
  namesFail?: boolean;
}

/** Renders the page of a product at `url` with a fake reference store and fake setups of stores. */
export async function renderProduct(url: string, options: Options = {}) {
  emulateNativeDialog();
  const referenceStore = {
    page: vi.fn(async (_group: string, kind: string, query: { ids?: string[] }) => {
      if (kind === 'places') {
        if (options.placesFail) {
          throw new Error('stores down');
        }
        return { data: Object.entries(NAMES).map(([id, name]) => ({ id, name })), page: { limit: 100, next: null } };
      }
      if (options.namesFail) {
        throw new Error('names down');
      }
      const source = kind === 'products' ? PRODUCT_NAMES : kind === 'suppliers' ? { [SUPPLIER]: 'Rossi srl' } : CATEGORY_NAMES;
      const ids = query.ids ?? Object.keys(source);
      return {
        data: ids.filter((id) => id in source).map((id) => ({ id, name: source[id] })),
        page: { limit: 25, next: null },
      };
    }),
    invalidate: vi.fn(),
  };
  const placesApi = {
    read: vi.fn(async (_group: string, placeId: string) => {
      if (placeId === P2) {
        throw new Error('store down');
      }
      return {
        etag: '"p"',
        place: {
          printStations: {
            stations: [
              { id: 'st1', name: 'Bar' },
              { id: 'st2', name: 'Sala' },
            ],
            productionCenters: [{ id: 'pc1', name: 'Cucina' }],
          },
          storages: { items: [{ id: 'sg1', name: 'Magazzino', cash: true, ecommerce: false }] },
        },
      };
    }),
  };
  const page = (path: string, family?: string): Route => ({
    path,
    component: ProductPage,
    canDeactivate: [leaveProduct],
    ...(family === undefined ? {} : { data: { family } }),
  });
  TestBed.configureTestingModule({
    providers: [
      ...provideApiTesting(),
      { provide: ReferenceStore, useValue: referenceStore },
      { provide: PlacesApi, useValue: placesApi },
      ...(options.extra ?? []),
      provideRouter(
        [
          ...(Object.values(FAMILIES).flatMap((family) => [
            page(`groups/:groupId/${family.segment}/new`, family.family),
            page(`groups/:groupId/${family.segment}/:productId`, family.family),
          ])),
          // A family the page does not know, and a route without one.
          page('groups/:groupId/odd/new', 'odd'),
          page('groups/:groupId/plain/new'),
          { path: '**', children: [] },
        ],
        withComponentInputBinding(),
      ),
    ],
  });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  signIn({
    id: USER,
    role: 'SA',
    permissions: FULL,
    groupFeatures: fakeFeatureFlags(false, { ...ALL_FEATURES, ...options.features }),
    ...options.profile,
  });
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(url);
  const scope = {
    get nativeElement() {
      return harness.routeNativeElement;
    },
  } as unknown as ComponentFixture<unknown>;
  const view = async () => {
    await settle();
    harness.detectChanges();
    await settle();
    harness.detectChanges();
  };
  const respond = (request: TestRequest, o: Reads) => {
    const path = request.request.url;
    const answer = (value: unknown) =>
      value === 'fail' ? request.flush(...fail('INTERNAL_ERROR')) : request.flush(value as object);
    switch (path) {
      case LANGS:
        return answer(o.languages === 'fail' ? 'fail' : { data: (o.languages ?? ['it', 'en']).map((code) => ({ code })) });
      case TREE_URL:
        return answer(o.tree === 'fail' ? 'fail' : { data: o.tree ?? TREE });
      case BRANDS_URL:
        return answer(o.brands ?? BRANDS);
      case ATTRIBUTES_URL:
        return answer(o.attributes ?? ATTRIBUTE_GROUPS);
      case LISTS_URL:
        return answer(o.lists === 'fail' ? 'fail' : { data: o.lists ?? PRICE_LISTS });
      case TAXES_URL:
        return answer({ data: o.taxes ?? TAXES });
      case CURRENCIES_URL:
        return answer(o.currencies === 'fail' ? 'fail' : { data: o.currencies ?? CURRENCIES });
      case UNITS_URL:
        return answer(o.units === 'fail' ? 'fail' : { data: o.units ?? UNITS });
      case `${API}/v1/groups/${GROUP}`:
        // The features of the group a platform administrator or a dealer works on.
        return answer({ data: { name: 'Gruppo', features: { ...ALL_FEATURES, ...options.features } } });
      case ITEM:
        return o.item === 'fail'
          ? request.flush(errorBody(o.itemStatus === 404 ? 'NOT_FOUND' : 'INTERNAL_ERROR'), {
              status: o.itemStatus ?? 500,
              statusText: 'x',
              headers: o.requestId === undefined ? {} : { 'X-Request-Id': o.requestId },
            })
          : request.flush({ data: { ...PRODUCT, ...(o.item as object) } }, { headers: { ETag: o.etag ?? '"v1"' } });
    }
  };
  /** Answers the reads the page makes when it opens. */
  const answer = async (o: Reads = {}) => {
    await settle();
    harness.detectChanges();
    await settle();
    const wantsItem = (o.edit ?? !url.includes('/new')) && o.item !== 'skip';
    for (let round = 0; round < 3; round++) {
      const pending = backend().match((r) => r.method === 'GET' && (r.url !== ITEM || wantsItem));
      if (pending.length === 0) {
        break;
      }
      for (const request of pending) {
        respond(request, o);
      }
      await settle();
      harness.detectChanges();
    }
    await view();
  };
  if (options.reads !== null) {
    await answer(options.reads ?? {});
  }
  const el = () => harness.routeNativeElement as HTMLElement;
  const component = () => harness.routeDebugElement!.componentInstance as ProductPage;
  const internals = () => component() as unknown as { model: WritableSignal<ProductModel>; viewMode: WritableSignal<string> };
  /** Changes the fields of the core of the form model, as the controls would. */
  const setCore = async (patch: Partial<ProductModel['core']>) => {
    internals().model.update((m) => ({ ...m, core: { ...m.core, ...patch } }));
    await view();
  };
  /** Changes the fields of the stores of the form model. */
  const setLocal = async (patch: Partial<ProductModel['local']>) => {
    internals().model.update((m) => ({ ...m, local: { ...m.local, ...patch } }));
    await view();
  };
  const model = () => internals().model();
  const form = () => (component() as unknown as { productForm: any }).productForm;
  const type = async (label: string, value: string) => {
    const control = findControl(scope, label);
    control.value = value;
    control.dispatchEvent(new Event('input'));
    control.dispatchEvent(new Event('change'));
    await view();
  };
  const blur = async (label: string) => {
    findControl(scope, label).dispatchEvent(new Event('blur'));
    await view();
  };
  const submit = async () => {
    el().querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await view();
  };
  const save = () => el().querySelector<HTMLButtonElement>('button[type=submit]');
  const tab = (id: string) => el().querySelector<HTMLButtonElement>(`#product-tab-${id}`);
  const tabs = () => [...el().querySelectorAll('[role=tab]')].map((t) => t.id.replace('product-tab-', ''));
  const openTab = async (id: string) => {
    tab(id)!.click();
    await view();
  };
  const visible = () => [...el().querySelectorAll<HTMLElement>('[role=tabpanel]')].filter((p) => !p.hidden).map((p) => p.id.replace('product-panel-', ''));
  const toasts = () => TestBed.inject(ToastService).toasts().map((t) => `${t.kind}: ${t.message}`);
  const formError = () => el().querySelector('fc-form-error')?.textContent?.trim() ?? null;
  const button = (text: string) =>
    [...el().querySelectorAll<HTMLButtonElement>('button:not(dialog button)')].find((b) => b.textContent?.trim() === text);
  const dialogButton = (text: string) =>
    [...el().querySelectorAll<HTMLButtonElement>('dialog[open] button')].find((b) => b.textContent?.trim() === text)!;
  const reload = () =>
    [...el().querySelectorAll<HTMLButtonElement>('form button')].find((b) => b.textContent?.trim() === 'PRODUCT_CATALOG.FORM.RELOAD');
  const viewButton = (name: 'QUICK' | 'FULL') => button(`PRODUCTS.VIEW.${name}`)!;
  const switchView = async (name: 'QUICK' | 'FULL') => {
    viewButton(name).click();
    await view();
  };
  const heading = () => (el().querySelector('h1') as HTMLElement).textContent!.trim();
  const labels = () => [...el().querySelectorAll('label')].map((l) => l.textContent?.trim());
  return {
    harness, el, component, view, answer, type, blur, submit, save, tab, tabs, openTab, visible, toasts, formError,
    button, dialogButton, reload, viewButton, switchView, heading, labels, setCore, setLocal, model, form, referenceStore, placesApi,
    router: TestBed.inject(Router),
    error: (label: string) => errorOf(scope, label),
    control: (label: string) => findControl(scope, label),
  };
}
