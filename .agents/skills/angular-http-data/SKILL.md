---
name: angular-http-data
description: Usa quando il backoffice Angular legge o scrive dati del backend: httpResource per le letture reattive, HttpClient per le scritture, configurazione dell'URL delle API, tipi delle risposte, envelope e mappatura degli errori del backend.
---
# Angular HTTP Data (v22)

Riferimenti: `doc/API.md` (contratto), `doc/API-Guidelines.md` (envelope, errori, paginazione).

## Configurazione
- `HttpClient` è fornito in root e usa **fetch di default** in v22. In `app.config.ts`: `provideHttpClient(withInterceptors([authInterceptor, errorInterceptor]))`. Niente `withFetch()` (deprecato), niente `HttpClientModule`. `withXhr()` solo se serve l'avanzamento degli upload.
- L'URL delle API arriva da una configurazione pubblica caricata all'avvio (token di iniezione `APP_CONFIG`); nessun segreto lato frontend.

## Tipi del contratto
In `core/api/`: tipi dell'envelope e degli errori, condivisi da tutte le feature.
```ts
/** Successful single-resource envelope. */
export interface ApiData<T> { readonly data: T }
/** Cursor-paginated list envelope. */
export interface ApiPage<T> { readonly data: readonly T[]; readonly page: { readonly limit: number; readonly next: string | null } }
/** Error envelope returned by the backend. */
export interface ApiError { readonly error: { readonly code: string; readonly message: string; readonly details?: readonly { field: string; issue: string }[] } }
```
I tipi di ogni risorsa (`Product`, `Place`…) stanno nella feature e rispecchiano `doc/API.md`.

## Letture: `httpResource`
```ts
/** Data access for products of the current group. */
@Service()
export class ProductsApi {
  private readonly config = inject(APP_CONFIG);

  /** Reactive product list: refetches whenever the group or the filters change. */
  list(groupId: () => string, filters: () => ProductFilters) {
    return httpResource<ApiPage<Product>>(() => ({
      url: `${this.config.apiBaseUrl}/v1/groups/${groupId()}/products`,
      params: toQueryParams(filters()),
    }));
  }
}
```
- La resource espone `value()`, `isLoading()`, `error()`, `status()`, `reload()`: la pagina li mappa sui quattro stati della vista.
- Una funzione che restituisce `undefined` sospende la richiesta (es. finché manca il gruppo).
- Niente sottoscrizioni manuali per le letture.

## Scritture: `HttpClient`
Creazioni, modifiche ed eliminazioni con `HttpClient` (`post`, `patch`, `delete`) nei servizi della feature, convertite in promise o observable secondo l'uso, seguite da `reload()` della resource interessata o aggiornamento locale.
- `PATCH` con solo i campi modificati (JSON Merge Patch); `If-Match` dove il backend usa `ETag`.
- Pulsante di invio disabilitato durante la richiesta; nessun doppio invio.

## Errori
- Un interceptor centrale traduce le risposte d'errore in un tipo applicativo con il `code` del backend.
- `401` gestiti dalla sessione (skill `angular-auth-session`); `403` e `404` come da skill `angular-permissions-ui`; `422` mappati sui campi del form (skill `angular-forms`); `429` con attesa da `Retry-After`; `0`/`5xx` con messaggio "Servizio non raggiungibile, riprova".
- All'utente mai codici tecnici grezzi o messaggi interni.

## Test
`provideHttpClientTesting()` + `HttpTestingController`: URL, metodo, parametri e body attesi; ogni ramo d'errore; `verify()` a fine test.
