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
