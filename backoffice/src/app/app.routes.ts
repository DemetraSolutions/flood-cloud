import { CanMatchFn, Routes } from '@angular/router';
import {
  anonymousOnly,
  anyPermission,
  authenticated,
  feature,
  groupLanding,
  passwordChangeAllowed,
  permission,
  role,
  companiesLanding,
  placesLanding,
  trashLanding,
  usersLanding,
} from './core/auth/guards';
import { Shell } from './core/layout/shell';
import { leaveCompany } from './features/companies/company-leave';
import { leaveEmailTemplate } from './features/email-templates/email-template-leave';
import { leaveCatalogItem } from './features/product-catalog/catalog-item-leave';
import { leavePlace } from './features/places/place-leave';
import { leaveCategory } from './features/product-categories/category-leave';
import { leaveProduct } from './features/products/product-leave';
import { FAMILIES, FAMILY_ORDER, ProductFamily } from './features/products/product.types';

/**
 * Creation and detail of users under a path prefix (the group area and the platform area; the
 * one list of users is a separate route). Each route carries its full path so that the route
 * parameters reach the pages as inputs without depending on parameter inheritance.
 */
function userRoutes(prefix: string, canMatch: CanMatchFn[]): Routes {
  return [
    {
      path: `${prefix}/new`,
      canMatch: [...canMatch, permission('users:create')],
      title: 'USERS.FORM.NEW_TITLE',
      loadComponent: () => import('./features/users/user-form').then((m) => m.UserForm),
    },
    {
      path: `${prefix}/:userId`,
      canMatch,
      title: 'USERS.FORM.EDIT_TITLE',
      loadComponent: () => import('./features/users/user-form').then((m) => m.UserForm),
    },
  ];
}

/** List, creation and detail of dealers (PSA only). */
const dealerRoutes: Routes = [
  {
    path: 'dealers',
    canMatch: [role('PSA'), permission('dealers:read')],
    title: 'DEALERS.TITLE',
    loadComponent: () => import('./features/dealers/dealers-list').then((m) => m.DealersList),
  },
  {
    path: 'dealers/new',
    canMatch: [
      role('PSA'),
      permission('dealers:read'),
      permission('dealers:create'),
      permission('users:create'),
    ],
    title: 'DEALERS.FORM.NEW_TITLE',
    loadComponent: () => import('./features/dealers/dealer-form').then((m) => m.DealerForm),
  },
  {
    path: 'dealers/:dealerId',
    canMatch: [role('PSA'), permission('dealers:read')],
    title: 'DEALERS.FORM.EDIT_TITLE',
    loadComponent: () => import('./features/dealers/dealer-form').then((m) => m.DealerForm),
  },
];

/** The catalog pages of the group record, lazy-loaded one by one. */
const catalogRoutes: Routes = [
  {
    path: 'price-lists',
    title: 'GROUP_SETTINGS.SECTION.PRICE_LISTS',
    loadComponent: () =>
      import('./features/groups/catalogs/price-lists-page').then((m) => m.PriceListsPage),
  },
  {
    path: 'taxes',
    title: 'GROUP_SETTINGS.SECTION.TAXES',
    loadComponent: () => import('./features/groups/catalogs/taxes-page').then((m) => m.TaxesPage),
  },
  {
    path: 'currencies',
    title: 'GROUP_SETTINGS.SECTION.CURRENCIES',
    loadComponent: () =>
      import('./features/groups/catalogs/currencies-page').then((m) => m.CurrenciesPage),
  },
  {
    path: 'measure-units',
    title: 'GROUP_SETTINGS.SECTION.MEASURE_UNITS',
    loadComponent: () =>
      import('./features/groups/catalogs/measure-units-page').then((m) => m.MeasureUnitsPage),
  },
  {
    path: 'warehouse-rules',
    title: 'GROUP_SETTINGS.SECTION.WAREHOUSE_RULES',
    loadComponent: () =>
      import('./features/groups/catalogs/warehouse-rules-page').then((m) => m.WarehouseRulesPage),
  },
  {
    path: 'fidelity-card-rules',
    title: 'GROUP_SETTINGS.SECTION.FIDELITY_CARD_RULES',
    loadComponent: () =>
      import('./features/groups/catalogs/fidelity-card-rules-page').then(
        (m) => m.FidelityCardRulesPage,
      ),
  },
];

/**
 * Fidelity, product favorites and promotions of the group (`groups/:groupId/…`, outside the
 * record of the group: company and store administrators reach them too). Fidelity needs
 * `fidelity:read`, favorites and promotions `products:read`; the server checks the group against
 * the perimeter of the user. Each route carries its full path so that the group reaches the page
 * as an input.
 */
const groupCatalogRoutes: Routes = [
  {
    path: 'groups/:groupId/fidelity/card-types',
    canMatch: [permission('fidelity:read')],
    title: 'CATALOG.CARD_TYPES.TITLE',
    loadComponent: () =>
      import('./features/groups/catalogs/card-types-page').then((m) => m.CardTypesPage),
  },
  {
    path: 'groups/:groupId/fidelity/points-collections',
    canMatch: [permission('fidelity:read')],
    title: 'CATALOG.POINTS_COLLECTIONS.TITLE',
    loadComponent: () =>
      import('./features/groups/catalogs/points-collections-page').then(
        (m) => m.PointsCollectionsPage,
      ),
  },
  {
    path: 'groups/:groupId/fidelity/prize-catalogues',
    canMatch: [permission('fidelity:read')],
    title: 'CATALOG.PRIZE_CATALOGUES.TITLE',
    loadComponent: () =>
      import('./features/groups/catalogs/prize-catalogues-page').then((m) => m.PrizeCataloguesPage),
  },
  {
    path: 'groups/:groupId/product-favorites',
    canMatch: [permission('products:read')],
    title: 'CATALOG.PRODUCT_FAVORITES.TITLE',
    loadComponent: () =>
      import('./features/groups/catalogs/product-favorites-page').then(
        (m) => m.ProductFavoritesPage,
      ),
  },
  {
    path: 'groups/:groupId/promotions',
    canMatch: [permission('products:read')],
    title: 'CATALOG.PROMOTIONS.TITLE',
    loadComponent: () =>
      import('./features/groups/catalogs/promotions-page').then((m) => m.PromotionsPage),
  },
];

/** The tabs of the company page, as child routes (the general tab is the default one). */
const companyTabs: Routes = [
  {
    path: '',
    pathMatch: 'full',
    title: 'COMPANIES.SECTION.GENERAL',
    loadComponent: () =>
      import('./features/companies/company-general').then((m) => m.CompanyGeneral),
  },
  {
    path: 'e-invoicing',
    title: 'COMPANIES.SECTION.E_INVOICING',
    loadComponent: () =>
      import('./features/companies/company-e-invoicing').then((m) => m.CompanyEInvoicing),
  },
  {
    path: 'invoice-numbering',
    title: 'COMPANIES.SECTION.INVOICE_NUMBERING',
    loadComponent: () =>
      import('./features/companies/company-numbering').then((m) => m.CompanyNumbering),
  },
  {
    path: 'bank-accounts',
    title: 'COMPANIES.SECTION.BANK_ACCOUNTS',
    loadComponent: () => import('./features/companies/company-banks').then((m) => m.CompanyBanks),
  },
  {
    path: 'meal-vouchers',
    title: 'COMPANIES.SECTION.MEAL_VOUCHERS',
    loadComponent: () =>
      import('./features/companies/company-meal-vouchers').then((m) => m.CompanyMealVouchers),
  },
  {
    path: 'customer-app',
    title: 'COMPANIES.SECTION.CUSTOMER_APP',
    loadComponent: () =>
      import('./features/companies/company-customer-app').then((m) => m.CompanyCustomerApp),
  },
  {
    path: 'media',
    title: 'COMPANIES.SECTION.MEDIA',
    loadComponent: () => import('./features/companies/company-media').then((m) => m.CompanyMedia),
  },
];

/**
 * Companies of a group: the list, the page of a new company (general tab only) and the page of
 * a company with its tabs as child routes. Leaving a page with unsaved changes asks for
 * confirmation. Each route carries its full path so that the parameters reach the pages as
 * inputs; the server checks the group and the company against the perimeter of the user.
 */
const companyRoutes: Routes = [
  // The companies of every group in the scope of a PSA or dealer (no working group).
  {
    path: 'companies',
    canMatch: [role('PSA', 'D'), permission('companies:read'), companiesLanding],
    title: 'COMPANIES.TITLE',
    data: { scope: 'all' },
    loadComponent: () => import('./features/companies/companies-list').then((m) => m.CompaniesList),
  },
  {
    path: 'groups/:groupId/companies',
    canMatch: [permission('companies:read')],
    title: 'COMPANIES.TITLE',
    loadComponent: () => import('./features/companies/companies-list').then((m) => m.CompaniesList),
  },
  {
    path: 'groups/:groupId/companies/new',
    canMatch: [permission('companies:read'), permission('companies:create')],
    canDeactivate: [leaveCompany],
    loadComponent: () => import('./features/companies/company-page').then((m) => m.CompanyPage),
    children: [companyTabs[0]],
  },
  {
    path: 'groups/:groupId/companies/:companyId',
    canMatch: [permission('companies:read')],
    canDeactivate: [leaveCompany],
    loadComponent: () => import('./features/companies/company-page').then((m) => m.CompanyPage),
    children: companyTabs,
  },
];

/**
 * E-mail templates of a group (`doc/Tasks.md` step T2): list, page of a new template and page of
 * one. They need `places:read` (changing, `places:update`, is checked by the page and the server)
 * and the `email` feature of the group (the module that is off lands on the "feature disabled"
 * page). Leaving a page with unsaved changes asks for confirmation.
 */
const emailTemplateRoutes: Routes = [
  {
    path: 'groups/:groupId/email-templates',
    canMatch: [permission('places:read'), feature('email')],
    title: 'EMAIL_TEMPLATES.TITLE',
    loadComponent: () =>
      import('./features/email-templates/email-templates-list').then((m) => m.EmailTemplatesList),
  },
  {
    path: 'groups/:groupId/email-templates/new',
    canMatch: [permission('places:update'), feature('email')],
    canDeactivate: [leaveEmailTemplate],
    title: 'EMAIL_TEMPLATES.FORM.NEW_TITLE',
    loadComponent: () =>
      import('./features/email-templates/email-template-page').then((m) => m.EmailTemplatePage),
  },
  {
    path: 'groups/:groupId/email-templates/:templateId',
    canMatch: [permission('places:read'), feature('email')],
    canDeactivate: [leaveEmailTemplate],
    title: 'EMAIL_TEMPLATES.FORM.EDIT_TITLE',
    loadComponent: () =>
      import('./features/email-templates/email-template-page').then((m) => m.EmailTemplatePage),
  },
];

/**
 * Departments, brands and attribute groups of the products of a group (`doc/Tasks.md` step C1).
 * Reading needs `products:read`, writing (`products:update`) is checked by the pages and the
 * server; the departments also need the `cash` feature of the group. The departments and the
 * brands share the list and the page (the kind is route data). Leaving a page with unsaved
 * changes asks for confirmation.
 */
function catalogItemRoutes(
  kind: 'departments' | 'brands',
  segment: string,
  text: string,
  guards: CanMatchFn[],
): Routes {
  const data = { kind };
  const page = () =>
    import('./features/product-catalog/catalog-item-page').then((m) => m.CatalogItemPage);
  return [
    {
      path: `groups/:groupId/${segment}`,
      canMatch: [permission('products:read'), ...guards],
      title: `PRODUCT_CATALOG.${text}.TITLE`,
      data,
      loadComponent: () =>
        import('./features/product-catalog/catalog-list').then((m) => m.CatalogList),
    },
    {
      path: `groups/:groupId/${segment}/new`,
      canMatch: [permission('products:update'), ...guards],
      canDeactivate: [leaveCatalogItem],
      title: `PRODUCT_CATALOG.${text}.FORM.NEW_TITLE`,
      data,
      loadComponent: page,
    },
    {
      path: `groups/:groupId/${segment}/:itemId`,
      canMatch: [permission('products:read'), ...guards],
      canDeactivate: [leaveCatalogItem],
      title: `PRODUCT_CATALOG.${text}.FORM.EDIT_TITLE`,
      data,
      loadComponent: page,
    },
  ];
}

const productCatalogRoutes: Routes = [
  {
    path: 'groups/:groupId/tools/tobacco-sync',
    canMatch: [permission('tobaccos:sync'), feature('tobaccosGamesMonopoly')],
    title: 'TOBACCO_SYNC.TITLE',
    loadComponent: () =>
      import('./features/tobacco-sync/tobacco-sync-page').then((m) => m.TobaccoSyncPage),
  },
  {
    path: 'groups/:groupId/tools/catalog-import-export',
    canMatch: [permission('products:read')],
    title: 'CATALOG_XLSX.TITLE',
    loadComponent: () =>
      import('./features/catalog-xlsx/catalog-xlsx-page').then((m) => m.CatalogXlsxPage),
  },
  {
    path: 'groups/:groupId/product-categories',
    canMatch: [permission('products:read')],
    title: 'PRODUCT_CATEGORIES.TITLE',
    loadComponent: () =>
      import('./features/product-categories/category-list').then((m) => m.CategoryList),
  },
  {
    path: 'groups/:groupId/product-categories/new',
    canMatch: [permission('products:update')],
    canDeactivate: [leaveCategory],
    title: 'PRODUCT_CATEGORIES.FORM.NEW_TITLE',
    loadComponent: () =>
      import('./features/product-categories/category-page').then((m) => m.CategoryPage),
  },
  {
    path: 'groups/:groupId/product-categories/:categoryId',
    canMatch: [permission('products:read')],
    canDeactivate: [leaveCategory],
    title: 'PRODUCT_CATEGORIES.FORM.EDIT_TITLE',
    loadComponent: () =>
      import('./features/product-categories/category-page').then((m) => m.CategoryPage),
  },
  ...catalogItemRoutes('departments', 'product-departments', 'DEPARTMENTS', [feature('cash')]),
  ...catalogItemRoutes('brands', 'product-brands', 'BRANDS', []),
  {
    path: 'groups/:groupId/product-attribute-groups',
    canMatch: [permission('products:read')],
    title: 'PRODUCT_CATALOG.ATTRIBUTES.TITLE',
    loadComponent: () =>
      import('./features/product-catalog/attribute-groups-page').then((m) => m.AttributeGroupsPage),
  },
];

/**
 * The products of a group, one section for each family (products, services, modifiers, tobacco,
 * games and monopoly): the list, the page of a new product and the page of a product share their
 * components and differ by the family (route data). Reading needs `products:read`, writing
 * (`products:update`) is checked by the pages and the server; a family that needs a feature of the
 * group (services, variants, tobacco) is guarded by it. Leaving a page with unsaved changes asks
 * for confirmation.
 */
function productFamilyRoutes(family: ProductFamily): Routes {
  const { segment, text, feature: required } = FAMILIES[family];
  const guards: CanMatchFn[] = required === null ? [] : [feature(required)];
  const data = { family };
  const page = () => import('./features/products/product-page').then((m) => m.ProductPage);
  return [
    {
      path: `groups/:groupId/${segment}`,
      canMatch: [permission('products:read'), ...guards],
      title: `PRODUCTS.FAMILY.${text}.TITLE`,
      data,
      loadComponent: () => import('./features/products/product-list').then((m) => m.ProductList),
    },
    {
      path: `groups/:groupId/${segment}/new`,
      canMatch: [permission('products:update'), ...guards],
      canDeactivate: [leaveProduct],
      title: `PRODUCTS.FAMILY.${text}.NEW_TITLE`,
      data,
      loadComponent: page,
    },
    {
      path: `groups/:groupId/${segment}/:productId`,
      canMatch: [permission('products:read'), ...guards],
      canDeactivate: [leaveProduct],
      title: `PRODUCTS.FAMILY.${text}.EDIT_TITLE`,
      data,
      loadComponent: page,
    },
  ];
}

const productRoutes: Routes = FAMILY_ORDER.flatMap((family) => productFamilyRoutes(family));

/**
 * Trash of a group (`groups/:groupId/trash`): one page with a tab per kind of item. It needs the
 * read permission of at least one of companies, places and users; the page shows only the tabs the
 * user may read, and the server checks the group against the perimeter of the user.
 */
const trashRoutes: Routes = [
  // The trash of every group in the scope of a PSA or dealer (no working group).
  {
    path: 'trash',
    canMatch: [
      role('PSA', 'D'),
      anyPermission('companies:read', 'places:read', 'users:read', 'products:read'),
      trashLanding,
    ],
    title: 'TRASH.TITLE',
    data: { scope: 'all' },
    loadComponent: () => import('./features/trash/trash-page').then((m) => m.TrashPage),
  },
  {
    path: 'groups/:groupId/trash',
    canMatch: [anyPermission('companies:read', 'places:read', 'users:read', 'products:read')],
    title: 'TRASH.TITLE',
    loadComponent: () => import('./features/trash/trash-page').then((m) => m.TrashPage),
  },
];

/** An entry of the settings of the place that only shows the keys of a settings block. */
function placeScalarTab(path: string, section: string, key: string): Routes[number] {
  return {
    path,
    title: `PLACES.MENU.${key}`,
    data: { section },
    loadComponent: () => import('./features/places/place-scalar-tab').then((m) => m.PlaceScalarTab),
  };
}

/** The entries of the side menu of the settings tab, as child routes (the general settings are the default one). */
const placeSettings: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'general' },
  {
    path: 'dealer',
    title: 'PLACES.MENU.DEALER',
    loadComponent: () => import('./features/places/place-dealer').then((m) => m.PlaceDealer),
  },
  {
    path: 'general',
    title: 'PLACES.MENU.GENERAL',
    loadComponent: () => import('./features/places/place-cash').then((m) => m.PlaceCash),
  },
  {
    path: 'rooms-settings',
    title: 'PLACES.MENU.ROOMS',
    loadComponent: () => import('./features/places/place-tables').then((m) => m.PlaceTables),
  },
  {
    path: 'delivery',
    title: 'PLACES.MENU.DELIVERY',
    loadComponent: () => import('./features/places/place-delivery').then((m) => m.PlaceDelivery),
  },
  {
    path: 'reservations',
    title: 'PLACES.MENU.RESERVATIONS',
    loadComponent: () =>
      import('./features/places/place-reservations').then((m) => m.PlaceReservations),
  },
  {
    path: 'self-ordering',
    title: 'PLACES.MENU.SELF_ORDERING',
    loadComponent: () =>
      import('./features/places/place-self-ordering').then((m) => m.PlaceSelfOrdering),
  },
  placeScalarTab('external-display', 'externalDisplay', 'EXTERNAL_DISPLAY'),
  {
    path: 'kiosk',
    title: 'PLACES.MENU.KIOSK',
    loadComponent: () => import('./features/places/place-kiosk').then((m) => m.PlaceKiosk),
  },
  placeScalarTab('appointments', 'appointments', 'APPOINTMENTS'),
  placeScalarTab('fidelity', 'fidelity', 'FIDELITY'),
  placeScalarTab('tobacco', 'tobacco', 'TOBACCO'),
  {
    path: 'print',
    title: 'PLACES.MENU.PRINT',
    loadComponent: () => import('./features/places/place-printing').then((m) => m.PlacePrinting),
  },
  {
    path: 'other',
    title: 'PLACES.MENU.OTHER',
    loadComponent: () => import('./features/places/place-other').then((m) => m.PlaceOther),
  },
  {
    path: 'payments',
    title: 'PLACES.MENU.PAYMENTS',
    loadComponent: () => import('./features/places/place-payments').then((m) => m.PlacePayments),
  },
];

/** The tabs of the place page, as child routes (the general tab is the default one), in the order of the legacy backoffice. */
const placeTabs: Routes = [
  {
    path: '',
    pathMatch: 'full',
    title: 'PLACES.SECTION.GENERAL',
    loadComponent: () => import('./features/places/place-general').then((m) => m.PlaceGeneral),
  },
  {
    path: 'devices',
    title: 'PLACES.SECTION.DEVICES',
    loadComponent: () => import('./features/places/place-devices').then((m) => m.PlaceDevices),
  },
  {
    path: 'print-stations',
    title: 'PLACES.SECTION.PRINT_STATIONS',
    loadComponent: () =>
      import('./features/places/place-print-stations').then((m) => m.PlacePrintStations),
  },
  {
    path: 'rooms',
    title: 'PLACES.SECTION.ROOMS',
    loadComponent: () => import('./features/places/place-rooms').then((m) => m.PlaceRooms),
  },
  {
    path: 'storages',
    title: 'PLACES.SECTION.STORAGES',
    loadComponent: () => import('./features/places/place-storages').then((m) => m.PlaceStorages),
  },
  {
    path: 'hours',
    title: 'PLACES.SECTION.OPENING_HOURS',
    loadComponent: () => import('./features/places/place-hours').then((m) => m.PlaceHours),
  },
  {
    path: 'media',
    title: 'PLACES.SECTION.MEDIA',
    loadComponent: () => import('./features/places/place-media').then((m) => m.PlaceMedia),
  },
  {
    path: 'settings',
    title: 'PLACES.SECTION.SETTINGS',
    loadComponent: () => import('./features/places/place-settings').then((m) => m.PlaceSettings),
    children: placeSettings,
  },
  {
    path: 'integrations',
    title: 'PLACES.SECTION.INTEGRATIONS',
    loadComponent: () =>
      import('./features/places/place-integrations').then((m) => m.PlaceIntegrations),
  },
];

/**
 * Places of a group: the list, the page of a new place (general tab only) and the page of a place
 * with its tabs as child routes. Leaving a page with unsaved changes asks for confirmation. Each
 * route carries its full path so that the parameters reach the pages as inputs; the server checks
 * the group and the place against the perimeter of the user, and does not refuse a write because a
 * tab is hidden by the features of the group (the interface does).
 */
const placeRoutes: Routes = [
  // The places of every group in the scope of a PSA or dealer (no working group).
  {
    path: 'places',
    canMatch: [role('PSA', 'D'), permission('places:read'), placesLanding],
    title: 'PLACES.TITLE',
    data: { scope: 'all' },
    loadComponent: () => import('./features/places/places-list').then((m) => m.PlacesList),
  },
  {
    path: 'groups/:groupId/places',
    canMatch: [permission('places:read')],
    title: 'PLACES.TITLE',
    loadComponent: () => import('./features/places/places-list').then((m) => m.PlacesList),
  },
  {
    path: 'groups/:groupId/places/new',
    canMatch: [permission('places:read'), permission('places:create')],
    canDeactivate: [leavePlace],
    loadComponent: () => import('./features/places/place-page').then((m) => m.PlacePage),
    children: [placeTabs[0]],
  },
  {
    path: 'groups/:groupId/places/:placeId',
    canMatch: [permission('places:read')],
    canDeactivate: [leavePlace],
    loadComponent: () => import('./features/places/place-page').then((m) => m.PlacePage),
    children: placeTabs,
  },
];

/**
 * Record of a group: general data, features, integrations and the six catalogs, as child routes
 * of one layout page (`groups:read`; the server checks the group against the user's perimeter).
 */
const groupSettingsRoutes: Routes = [
  {
    path: 'groups/:groupId/settings',
    canMatch: [permission('groups:read')],
    loadComponent: () => import('./features/groups/group-settings').then((m) => m.GroupSettings),
    children: [
      {
        path: '',
        pathMatch: 'full',
        title: 'GROUP_SETTINGS.SECTION.GENERAL',
        loadComponent: () => import('./features/groups/group-general').then((m) => m.GroupGeneral),
      },
      {
        path: 'features',
        title: 'GROUP_SETTINGS.SECTION.FEATURES',
        loadComponent: () =>
          import('./features/groups/group-features-page').then((m) => m.GroupFeaturesPage),
      },
      {
        path: 'integrations',
        title: 'GROUP_SETTINGS.SECTION.INTEGRATIONS',
        loadComponent: () =>
          import('./features/groups/group-integrations').then((m) => m.GroupIntegrations),
      },
      {
        path: 'public-api',
        canMatch: [permission('apiKeys:read')],
        title: 'GROUP_SETTINGS.SECTION.PUBLIC_API',
        loadComponent: () =>
          import('./features/groups/public-api/group-public-api').then((m) => m.GroupPublicApi),
      },
      ...catalogRoutes,
    ],
  },
];

/**
 * Routes of the application; pages are lazy-loaded and `title` is a dictionary key (translated
 * by `PageTitleStrategy`).
 *
 * - `/login` is outside the shell and only for anonymous visitors.
 * - Everything else lives inside the {@link Shell} behind `authenticated`: an anonymous visitor
 *   is sent to the login with a `returnUrl`.
 * - While a temporary password is pending (`passwordChangeAllowed`) only `/change-password`
 *   is reachable (it is declared before the guarded group).
 * - Routes are protected with `permission(...)`, not only hidden from the menu.
 */
export const routes: Routes = [
  {
    path: 'login',
    canMatch: [anonymousOnly],
    title: 'AUTH.LOGIN.TITLE',
    loadComponent: () => import('./features/auth/login').then((m) => m.Login),
  },
  {
    path: '',
    component: Shell,
    canMatch: [authenticated],
    children: [
      {
        path: 'change-password',
        title: 'AUTH.CHANGE_PASSWORD.TITLE',
        loadComponent: () =>
          import('./features/auth/change-password').then((m) => m.ChangePassword),
      },
      {
        path: '',
        canMatch: [passwordChangeAllowed],
        children: [
          {
            path: '',
            pathMatch: 'full',
            title: 'HOME.TITLE',
            loadComponent: () => import('./features/home/home').then((m) => m.Home),
          },
          {
            path: 'profile',
            canMatch: [permission('profile:read')],
            children: [
              {
                path: '',
                pathMatch: 'full',
                title: 'PROFILE.TITLE',
                loadComponent: () =>
                  import('./features/profile/profile').then((m) => m.ProfilePage),
              },
              {
                path: 'sessions',
                title: 'SESSIONS.TITLE',
                loadComponent: () => import('./features/profile/sessions').then((m) => m.Sessions),
              },
            ],
          },
          {
            path: 'groups',
            pathMatch: 'full',
            canMatch: [permission('users:read'), groupLanding],
            title: 'GROUP_CHOOSER.TITLE',
            loadComponent: () =>
              import('./features/groups/group-chooser').then((m) => m.GroupChooser),
          },
          {
            path: 'groups/list',
            canMatch: [role('PSA', 'D'), permission('groups:read')],
            title: 'GROUPS.TITLE',
            loadComponent: () => import('./features/groups/groups-list').then((m) => m.GroupsList),
          },
          ...groupSettingsRoutes,
          ...groupCatalogRoutes,
          ...productCatalogRoutes,
          ...productRoutes,
          ...companyRoutes,
          ...placeRoutes,
          ...trashRoutes,
          ...emailTemplateRoutes,
          // The one list of users: `/users` (cross-group, PSA and dealers, while no group is
          // chosen) or the list of a group; both load the same page.
          {
            path: 'users',
            canMatch: [role('PSA', 'D'), permission('users:read'), usersLanding],
            title: 'USERS.TITLE',
            data: { scope: 'all' },
            loadComponent: () => import('./features/users/users-list').then((m) => m.UsersList),
          },
          {
            path: 'groups/:groupId/users',
            canMatch: [permission('users:read')],
            title: 'USERS.TITLE',
            loadComponent: () => import('./features/users/users-list').then((m) => m.UsersList),
          },
          ...userRoutes('groups/:groupId/users', [permission('users:read')]),
          // Old address of the platform list: bookmarks land on the one list.
          { path: 'platform/users', pathMatch: 'full', redirectTo: 'users' },
          ...userRoutes('platform/users', [role('PSA'), permission('users:read')]),
          ...dealerRoutes,
          {
            path: 'tools/new-customer',
            canMatch: [role('PSA', 'D'), permission('groups:create')],
            title: 'NEW_CUSTOMER.TITLE',
            loadComponent: () =>
              import('./features/new-customer/new-customer').then((m) => m.NewCustomer),
          },
          {
            path: 'tools/diagnostics',
            canMatch: [permission('places:read')],
            title: 'DIAGNOSTICS.TITLE',
            loadComponent: () =>
              import('./features/diagnostics/diagnostics-page').then((m) => m.DiagnosticsPage),
          },
          {
            path: 'tools/error-documents',
            canMatch: [permission('errorDocuments:read')],
            title: 'ERROR_DOCUMENTS.TITLE',
            loadComponent: () =>
              import('./features/error-documents/error-documents-page').then(
                (m) => m.ErrorDocumentsPage,
              ),
          },
          { path: 'tools/price-list', pathMatch: 'full', redirectTo: 'settings/price-list' },
          // Old addresses of the activations (bookmarks); the query parameters are kept.
          { path: 'tools/activations', pathMatch: 'full', redirectTo: 'activations' },
          {
            path: 'tools/activations/:dealerId',
            pathMatch: 'full',
            redirectTo: 'activations/:dealerId',
          },
          {
            path: 'activations',
            canMatch: [permission('activations:read')],
            title: 'ACTIVATIONS.TITLE',
            loadComponent: () =>
              import('./features/activations/activations-page').then((m) => m.ActivationsPage),
          },
          {
            path: 'activations/:dealerId',
            canMatch: [permission('activations:read')],
            title: 'ACTIVATIONS.STATEMENT.PAGE_TITLE',
            loadComponent: () =>
              import('./features/activations/statement-page').then((m) => m.StatementPage),
          },
          {
            path: 'settings/price-list',
            canMatch: [role('PSA'), permission('activations:manage')],
            title: 'PRICE_LIST.TITLE',
            loadComponent: () =>
              import('./features/price-list/price-list-page').then((m) => m.PriceListPage),
          },
          {
            path: 'tools/tobaccos',
            canMatch: [role('PSA'), permission('tobaccos:read')],
            title: 'TOBACCOS.TITLE',
            loadComponent: () =>
              import('./features/tobaccos/tobaccos-page').then((m) => m.TobaccosPage),
          },
          {
            path: 'settings/countries',
            canMatch: [role('PSA'), permission('countries:manage')],
            title: 'COUNTRIES.TITLE',
            loadComponent: () =>
              import('./features/countries/countries-page').then((m) => m.CountriesPage),
          },
          {
            path: 'settings/countries/:countryCode',
            canMatch: [role('PSA'), permission('countries:manage')],
            title: 'COUNTRIES.DETAIL_TITLE',
            loadComponent: () =>
              import('./features/countries/country-page').then((m) => m.CountryPage),
          },
          {
            path: 'settings/security',
            canMatch: [role('PSA'), permission('securityPolicy:manage')],
            title: 'SECURITY_POLICY.TITLE',
            loadComponent: () =>
              import('./features/security-policy/security-policy-page').then(
                (m) => m.SecurityPolicyPage,
              ),
          },
          {
            path: 'releases',
            canMatch: [role('PSA', 'D')],
            title: 'RELEASES.TITLE',
            loadComponent: () =>
              import('./features/releases/releases-page').then((m) => m.ReleasesPage),
          },
          {
            path: 'activity-log',
            canMatch: [permission('activityLog:read')],
            title: 'ACTIVITY.TITLE',
            loadComponent: () =>
              import('./features/activity-log/activity-log').then((m) => m.ActivityLogPage),
          },
          {
            path: 'forbidden',
            title: 'ERRORS.FORBIDDEN.TITLE',
            data: { kind: 'FORBIDDEN' },
            loadComponent: () => import('./features/errors/error-page').then((m) => m.ErrorPage),
          },
          {
            path: 'feature-disabled',
            title: 'ERRORS.FEATURE_DISABLED.TITLE',
            data: { kind: 'FEATURE_DISABLED' },
            loadComponent: () => import('./features/errors/error-page').then((m) => m.ErrorPage),
          },
          {
            path: 'error',
            title: 'ERRORS.GENERIC.TITLE',
            data: { kind: 'GENERIC' },
            loadComponent: () => import('./features/errors/error-page').then((m) => m.ErrorPage),
          },
          {
            path: '**',
            title: 'ERRORS.NOT_FOUND.TITLE',
            data: { kind: 'NOT_FOUND' },
            loadComponent: () => import('./features/errors/error-page').then((m) => m.ErrorPage),
          },
        ],
      },
    ],
  },
];
