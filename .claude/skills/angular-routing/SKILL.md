---
name: angular-routing
description: Usa quando definisci route del backoffice Angular 22: struttura lazy per feature, gruppo corrente nell'URL, guard canMatch funzionali per sessione e permessi, resolver funzionali, parametri come input con withComponentInputBinding, titoli di pagina.
---
# Angular Routing (v22)

## Configurazione
```ts
export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withComponentInputBinding()),
    provideHttpClient(withInterceptors([authInterceptor, errorInterceptor])),
  ],
};
```
`withComponentInputBinding()` passa parametri di percorso, query e `data` come **input** del componente di pagina (`readonly groupId = input.required<string>()`).

## Struttura delle route
```ts
export const routes: Routes = [
  { path: 'login', loadComponent: () => import('./core/auth/login-page').then((m) => m.LoginPage) },
  {
    path: '',
    canMatch: [authenticated],
    loadComponent: () => import('./core/layout/shell').then((m) => m.Shell),
    children: [
      {
        path: 'groups/:groupId',
        canMatch: [groupInScope],
        children: [
          {
            path: 'products',
            canMatch: [requirePermission('products:read')],
            title: 'Prodotti',
            loadChildren: () => import('./features/products/products.routes').then((m) => m.PRODUCTS_ROUTES),
          },
        ],
      },
    ],
  },
  { path: '**', loadComponent: () => import('./core/layout/not-found-page').then((m) => m.NotFoundPage) },
];
```
- Ogni feature espone le proprie route da `features/<feature>/<feature>.routes.ts`, caricate in lazy.
- Il **gruppo di lavoro è nell'URL** (`/groups/:groupId/...`) per tutti i ruoli; per SA, CA e PA è sempre il loro unico gruppo.
- Filtri, ordinamento e cursore delle liste stanno nei **query parameter** (skill `angular-list-page`).

## Guard e resolver funzionali
```ts
/** Lets the route match only when the user holds the given permission. */
export function requirePermission(permission: string): CanMatchFn {
  return () => inject(Permissions).can(permission) || inject(Router).createUrlTree(['/forbidden']);
}
```
- `canMatch` per sessione e permessi (la feature non viene neppure scaricata).
- Guard di sessione che attende la fine del ripristino della sessione (skill `angular-auth-session`).
- Resolver funzionali (`ResolveFn`) solo se il dato serve prima di mostrare la pagina; altrimenti la pagina carica con `httpResource` e mostra lo stato di caricamento.
- Niente guard a classe.

## Titoli
`title` statico nella route o `TitleStrategy` personalizzata per titoli dinamici (es. nome del prodotto).

## Test
Guard con `TestBed.runInInjectionContext`; navigazioni e parametri con `RouterTestingHarness`; route sconosciuta ⇒ pagina "non trovato"; feature non permessa non caricata.
