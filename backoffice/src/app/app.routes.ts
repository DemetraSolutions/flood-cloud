import { CanMatchFn, Routes } from '@angular/router';
import {
  anonymousOnly,
  authenticated,
  groupLanding,
  passwordChangeAllowed,
  permission,
  role,
} from './core/auth/guards';
import { Shell } from './core/layout/shell';

/**
 * List, creation and detail of users under a path prefix (the group area and the platform
 * area). Each route carries its full path so that the route parameters reach the pages as
 * inputs without depending on parameter inheritance.
 */
function userRoutes(prefix: string, canMatch: CanMatchFn[]): Routes {
  return [
    {
      path: prefix,
      canMatch,
      title: 'USERS.TITLE',
      loadComponent: () => import('./features/users/users-list').then((m) => m.UsersList),
    },
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
          {
            path: 'users',
            canMatch: [role('PSA', 'D'), permission('users:read')],
            title: 'USERS.TITLE',
            data: { scope: 'all' },
            loadComponent: () => import('./features/users/users-list').then((m) => m.UsersList),
          },
          ...userRoutes('groups/:groupId/users', [permission('users:read')]),
          ...userRoutes('platform/users', [role('PSA'), permission('users:read')]),
          ...dealerRoutes,
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
