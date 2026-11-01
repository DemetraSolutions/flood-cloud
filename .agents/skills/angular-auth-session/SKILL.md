---
name: angular-auth-session
description: Usa quando implementi nel backoffice Angular login, logout, ripristino della sessione, interceptor del token Bearer, refresh automatico su 401 TOKEN_EXPIRED con una sola richiesta condivisa, e reazione a sessione scaduta o revocata.
---
# Angular Auth Session

Riferimenti: `doc/Security-Model.md` §4 (sessioni del backoffice), skill `opaque-token-auth` (lato server).

## Dove stanno i token
- **Access token solo in memoria** (un signal privato del servizio di sessione). Mai in `localStorage`, `sessionStorage`, cookie leggibili da JS o URL.
- **Refresh token**: secondo la decisione aperta in `doc/Security-Model.md` §12.1.
  - Raccomandato: cookie `HttpOnly` impostato dal server; il frontend non lo vede e chiama il refresh con `withCredentials: true`.
  - Alternativa: nel body; in quel caso chiedi all'utente dove conservarlo prima di implementare.
- Al ricaricamento della pagina l'access token è perso: all'avvio l'app tenta **un refresh silenzioso** (app initializer); se fallisce mostra il login.

## Servizio di sessione
Signal pubblici in sola lettura: `status` (`'unknown' | 'authenticated' | 'anonymous'`), `currentUser`, `permissions`, `scope`. Metodi: `login`, `logout`, `logoutEverywhere`, `restore`, `refresh`.

## Interceptor funzionale
```ts
/** Attaches the access token to API calls and transparently refreshes it once on TOKEN_EXPIRED. */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const session = inject(Session);
  const config = inject(APP_CONFIG);

  // Never send the token to anything but our own API.
  if (!req.url.startsWith(config.apiBaseUrl) || isAuthEndpoint(req.url)) {
    return next(req);
  }

  return next(withToken(req, session.accessToken())).pipe(
    catchError((error: unknown) => {
      if (!isTokenExpired(error)) {
        return throwError(() => error);
      }
      return session.refresh().pipe(
        switchMap(() => next(withToken(req, session.accessToken()))),
      );
    }),
  );
};
```
Regole:
1. Il token si aggiunge **solo** alle richieste verso l'URL base delle API: mai verso altri domini.
2. **Refresh condiviso (single flight)**: se più richieste ricevono `TOKEN_EXPIRED` insieme, parte **un solo** refresh e tutte attendono il suo esito (`session.refresh()` restituisce la stessa richiesta in corso, es. con `shareReplay(1)` azzerato a fine refresh).
3. Ogni richiesta si ripete **al massimo una volta** dopo il refresh.
4. Refresh fallito (`401` di qualsiasi tipo): sessione azzerata, cache dei dati svuotate, navigazione al login con il percorso di ritorno; messaggio "Sessione scaduta, accedi di nuovo".
5. `401 UNAUTHENTICATED` (token revocato, utente disattivato): niente refresh, logout immediato.
6. Le chiamate di login, refresh e logout non passano dalla logica di refresh.

## Login e logout
- Il form di login non rivela se ha sbagliato username o password: mostra il messaggio unico che arriva dal server.
- Durante il login il pulsante è disabilitato e c'è un indicatore di attesa; dopo troppi tentativi il server risponde `429`: mostra quanto attendere (`Retry-After`).
- Logout: chiama il server, poi azzera sempre lo stato locale, anche se la chiamata fallisce.
- "Esci da tutti i dispositivi" e l'elenco delle sessioni attive sono funzioni del profilo utente.

## Guard
`canMatch` funzionale sulle aree autenticate: attende che `status` non sia più `'unknown'` (ripristino in corso), poi consente o reindirizza al login. Per i permessi vedi la skill `angular-permissions-ui`.

## Test
Token aggiunto solo all'API; nessun token verso altri domini; refresh singolo con più richieste concorrenti; richiesta ripetuta una sola volta; refresh fallito ⇒ logout e redirect; `UNAUTHENTICATED` ⇒ logout senza refresh; ripristino della sessione all'avvio riuscito e fallito; nessun token in `localStorage`/`sessionStorage`.
