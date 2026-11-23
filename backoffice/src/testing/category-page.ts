import { Provider } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { CategoryPage } from '../app/features/product-categories/category-page';
import { leaveCategory } from '../app/features/product-categories/category-leave';
import {
  Category,
  CategoryNode,
} from '../app/features/product-categories/category.types';
import { I18nService } from '../app/core/i18n/i18n.service';
import { DEFAULT_LANGUAGE } from '../app/core/i18n/language';
import { ReferenceApi } from '../app/core/reference/reference-api';
import { ReferenceStore } from '../app/core/reference/reference-store';
import { Profile } from '../app/core/session/session.types';
import { PlacesApi } from '../app/features/places/places-api';
import { LogoSlot } from '../app/features/companies/logo-slot';
import { languageName } from '../app/features/groups/languages';
import { ToastService } from '../app/shared/ui/toast/toast.service';
import { API, backend, errorBody, provideApiTesting, settle } from './api';
import { emulateNativeDialog } from './dialog';
import { errorOf, findControl } from './forms';
import { fakeFeatureFlags } from './groups';
import { signIn } from './session';

export const GROUP = '665f1c2e9b1d4a0012ab34a1';
export const ID = '665f1c2e9b1d4a0012ab34c1';
export const ROOT = '665f1c2e9b1d4a0012ab34c2';
export const CHILD = '665f1c2e9b1d4a0012ab34c3';
export const OTHER = '665f1c2e9b1d4a0012ab34c4';
export const FOOD = '665f1c2e9b1d4a0012ab34c5';
export const OUTSIDE = '665f1c2e9b1d4a0012ab34c9';
export const P1 = '665f1c2e9b1d4a0012ab3401';
export const P2 = '665f1c2e9b1d4a0012ab3402';
export const P3 = '665f1c2e9b1d4a0012ab3403';
export const PROD1 = '665f1c2e9b1d4a0012ab3701';
export const PROD2 = '665f1c2e9b1d4a0012ab3702';
export const IMAGE = '665f1c2e9b1d4a0012ab3601';

export const FULL = ['products:read', 'products:update', 'places:update', 'groups:read', 'profile:read'];
export const READ_ONLY = ['products:read', 'places:update', 'groups:read', 'profile:read'];

export const BASE = `${API}/v1/groups/${GROUP}/product-categories`;
export const LANGS = `${API}/v1/groups/${GROUP}/lookup/languages`;
export const TREE_URL = `${BASE}/tree`;
export const NEW = `/groups/${GROUP}/product-categories/new`;
export const EDIT = `/groups/${GROUP}/product-categories/${ID}`;

/** The tree of the group: the category of the tests is `Caffè`, with `Espresso` below it. */
export const TREE: CategoryNode[] = [
  {
    id: ROOT,
    name: 'Bevande',
    parentId: null,
    position: 1,
    enabled: true,
    children: [
      {
        id: ID,
        name: 'Caffè',
        parentId: ROOT,
        position: 1,
        enabled: true,
        children: [{ id: CHILD, name: 'Espresso', parentId: ID, position: 1, enabled: true, children: [] }],
      },
      { id: OTHER, name: null, parentId: ROOT, position: 2, enabled: true, children: [] },
    ],
  },
  { id: FOOD, name: 'Cibo', parentId: null, position: 2, enabled: true, children: [] },
];

/** A category with every field of every feature. */
export const CATEGORY: Category = {
  id: ID,
  parentId: ROOT,
  depth: 1,
  cyclic: false,
  name: { it: 'Caffè' },
  description: { it: 'Calde' },
  enabled: true,
  position: 3,
  productionValue: 10,
  availability: { pos: true, ecommerce: false },
  noDiscount: false,
  requiresLegalAge: false,
  secondaryFiscalPrinter: false,
  featured: false,
  integrations: { floodOrders: false, yellgo: false, leggimenu: false },
  dining: {
    endOfMeal: false,
    hiddenOnHandheld: false,
    feePercentage: 5,
    printGroup: 2,
    alwaysFirstCourse: false,
    notAffiliatedMenu: false,
    type: 'food',
  },
  tobacco: false,
  backgroundColor: '#112233',
  textColor: '#ffffff',
  modifierIds: [PROD1],
  modifierCategoryIds: [FOOD],
  printStations: {},
  counterPrintStations: {},
  places: [{ placeId: P1, position: 2, productionCenterId: null }],
  image: null,
  icon: null,
  internalFileName: null,
  externalUrl: null,
  createdAt: '2026-11-01T08:00:00.000Z',
  updatedAt: '2026-11-10T09:30:00.000Z',
};

const NAMES: Record<string, string> = { [P1]: 'Negozio uno', [P2]: 'Negozio due' };
const PRODUCTS: Record<string, string> = { [PROD1]: 'Coca', [PROD2]: 'Fanta' };

export const ALL_FEATURES = {
  cash: true,
  customersApp: true,
  tobaccosGamesMonopoly: true,
  productsVariants: true,
  ordering: true,
  rooms: true,
  media: true,
};

export const nameLabel = (language: string) =>
  `PRODUCT_CATALOG.FIELD.NAME_IN ${JSON.stringify({ language: languageName(language, DEFAULT_LANGUAGE) })}`;
export const descriptionLabel = (language: string) =>
  `PRODUCT_CATALOG.FIELD.DESCRIPTION_IN ${JSON.stringify({ language: languageName(language, DEFAULT_LANGUAGE) })}`;
export const positionLabel = (place: string) =>
  `PRODUCT_CATEGORIES.AVAILABILITY.POSITION ${JSON.stringify({ place })}`;

export const L = {
  enabled: 'PRODUCT_CATALOG.FIELD.ENABLED',
  noDiscount: 'PRODUCT_CATALOG.FIELD.NO_DISCOUNT',
  printer: 'PRODUCT_CATALOG.FIELD.SECONDARY_PRINTER',
  pos: 'PRODUCT_CATEGORIES.FIELD.POS',
  ecommerce: 'PRODUCT_CATEGORIES.FIELD.ECOMMERCE',
  featured: 'PRODUCT_CATEGORIES.FIELD.FEATURED',
  legalAge: 'PRODUCT_CATEGORIES.FIELD.LEGAL_AGE',
  yellgo: 'PRODUCT_CATEGORIES.INTEGRATIONS.YELLGO',
  parent: 'PRODUCT_CATEGORIES.FIELD.PARENT',
  position: 'PRODUCT_CATEGORIES.FIELD.POSITION',
  production: 'PRODUCT_CATEGORIES.FIELD.PRODUCTION_VALUE',
  fee: 'PRODUCT_CATEGORIES.DINING.FEE',
  printGroup: 'PRODUCT_CATEGORIES.DINING.PRINT_GROUP',
  diningType: 'PRODUCT_CATEGORIES.DINING.TYPE',
  endOfMeal: 'PRODUCT_CATEGORIES.DINING.END_OF_MEAL',
  tobacco: 'PRODUCT_CATEGORIES.TOBACCO.TYPE',
  background: 'PRODUCT_CATEGORIES.COLORS.BACKGROUND',
  fileName: 'PRODUCT_CATEGORIES.MEDIA.INTERNAL_FILE_NAME',
  url: 'PRODUCT_CATEGORIES.MEDIA.EXTERNAL_URL',
};

/** What the reads of the page get; `'fail'` makes one fail, `'skip'` leaves it pending. */
export interface Reads {
  languages?: string[] | 'fail';
  tree?: CategoryNode[] | 'fail';
  item?: object | 'skip';
  etag?: string;
  /** The page shows an existing category whatever the URL it was opened with (after a creation). */
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
}

/** Renders the page of a category at `url` with fake stores, setups of stores and lookups. */
export async function renderCategory(url: string, options: Options = {}) {
  emulateNativeDialog();
  const referenceApi = {
    lookup: vi.fn(async () => ({
      data: [
        { id: PROD1, name: PRODUCTS[PROD1] },
        { id: PROD2, name: PRODUCTS[PROD2] },
      ],
      page: { limit: 25, next: null },
    })),
    lookupNames: vi.fn(async (_group: string, _kind: string, ids: readonly string[]) =>
      Object.fromEntries(ids.filter((id) => id in PRODUCTS).map((id) => [id, PRODUCTS[id]])),
    ),
  };
  const referenceStore = {
    page: vi.fn(async () => {
      if (options.placesFail) {
        throw new Error('stores down');
      }
      return {
        data: [
          { id: P1, name: NAMES[P1] },
          { id: P2, name: NAMES[P2] },
        ],
        page: { limit: 100, next: null },
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
              { id: '', name: 'Without id' },
              { id: 'st2', name: 'Sala' },
            ],
            productionCenters: [
              { id: 'pc1', name: 'Cucina' },
              { id: '', name: 'Without id' },
            ],
          },
          storages: { items: [{ id: 'sg1', name: 'Magazzino', cash: true, ecommerce: false }] },
        },
      };
    }),
  };
  TestBed.configureTestingModule({
    providers: [
      ...provideApiTesting(),
      { provide: ReferenceApi, useValue: referenceApi },
      { provide: ReferenceStore, useValue: referenceStore },
      { provide: PlacesApi, useValue: placesApi },
      ...(options.extra ?? []),
      provideRouter(
        [
          { path: 'groups/:groupId/product-categories/new', component: CategoryPage, canDeactivate: [leaveCategory] },
          { path: 'groups/:groupId/product-categories/:categoryId', component: CategoryPage, canDeactivate: [leaveCategory] },
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
  /** Answers the reads the page makes when it opens. */
  const answer = async (o: Reads = {}) => {
    await settle();
    harness.detectChanges();
    await settle();
    const languages = backend().expectOne(LANGS);
    if (o.languages === 'fail') {
      languages.flush(...fail('INTERNAL_ERROR'));
    } else {
      languages.flush({ data: (o.languages ?? ['it', 'en']).map((code) => ({ code })) });
    }
    const tree = backend().expectOne(TREE_URL);
    if (o.tree === 'fail') {
      tree.flush(...fail('INTERNAL_ERROR'));
    } else {
      tree.flush({ data: o.tree ?? TREE });
    }
    if ((o.edit ?? !url.endsWith('/new')) && o.item !== 'skip') {
      backend()
        .expectOne(`${BASE}/${ID}`)
        .flush({ data: o.item ?? CATEGORY }, { headers: { ETag: o.etag ?? '"v1"' } });
    }
    await view();
  };
  if (options.reads !== null) {
    await answer(options.reads ?? {});
  }
  const el = () => harness.routeNativeElement as HTMLElement;
  const page = () => harness.routeDebugElement!.componentInstance as CategoryPage;
  const type = async (label: string, value: string) => {
    const control = findControl(scope, label);
    control.value = value;
    control.dispatchEvent(new Event(control instanceof HTMLSelectElement ? 'change' : 'input'));
    await view();
  };
  const check = async (label: string, on: boolean) => {
    const box = findControl(scope, label) as HTMLInputElement;
    box.checked = on;
    box.dispatchEvent(new Event('change'));
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
  const tab = (id: string) => el().querySelector<HTMLButtonElement>(`#category-tab-${id}`)!;
  const openTab = async (id: string) => {
    tab(id).click();
    await view();
  };
  const visible = () =>
    [...el().querySelectorAll<HTMLElement>('[role=tabpanel]')].filter((p) => !p.hidden).map((p) => p.id);
  const toasts = () => TestBed.inject(ToastService).toasts().map((t) => `${t.kind}: ${t.message}`);
  const formError = () => el().querySelector('fc-form-error')?.textContent?.trim() ?? null;
  const dialogButton = (text: string) =>
    [...el().querySelectorAll<HTMLButtonElement>('dialog[open] button')].find((b) => b.textContent?.trim() === text)!;
  const reload = () =>
    [...el().querySelectorAll<HTMLButtonElement>('form button')].find(
      (b) => b.textContent?.trim() === 'PRODUCT_CATALOG.FORM.RELOAD',
    );
  const slots = () => harness.routeDebugElement!.queryAll(By.directive(LogoSlot)).map((s) => s.componentInstance as LogoSlot);
  /** The text of the options of a select. */
  const optionsOf = (label: string) => [...(findControl(scope, label) as HTMLSelectElement).options].map((o) => o.textContent?.trim());
  /** Opens the section of a store in the stations tab, as the browser does when the user clicks it. */
  const openStore = async (name: string) => {
    const details = [...el().querySelectorAll('fc-category-stations details')].find((d) =>
      d.querySelector('summary')?.textContent?.includes(name),
    ) as HTMLDetailsElement;
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
    await view();
    await view();
  };
  /** Flushes the reads of the tree the page makes after a save. */
  const drain = () => {
    for (const request of backend().match(TREE_URL)) {
      request.flush({ data: TREE });
    }
  };
  return {
    harness, el, page, view, answer, type, check, blur, submit, save, tab, openTab, visible, toasts, formError,
    dialogButton, reload, slots, optionsOf, openStore, drain, referenceApi, referenceStore, placesApi,
    router: TestBed.inject(Router),
    error: (label: string) => errorOf(scope, label),
    control: (label: string) => findControl(scope, label),
  };
}
