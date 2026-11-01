import { Routes } from '@angular/router';
import { Shell } from './core/layout/shell';

/**
 * Routes of the application. Everything lives inside the {@link Shell}; pages are lazy-loaded
 * and `title` is a dictionary key (translated by `PageTitleStrategy`).
 */
export const routes: Routes = [
  {
    path: '',
    component: Shell,
    children: [
      {
        path: '',
        pathMatch: 'full',
        title: 'HOME.TITLE',
        loadComponent: () => import('./features/home/home').then((m) => m.Home),
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
];
