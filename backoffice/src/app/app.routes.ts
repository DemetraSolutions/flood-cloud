import { Routes } from '@angular/router';
import {
  anonymousOnly,
  authenticated,
  passwordChangeAllowed,
  permission,
} from './core/auth/guards';
import { Shell } from './core/layout/shell';

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
