# Riferimento API

> Documento **mantenuto a ogni passo** (`GEMINI.md` §3): descrive **tutti** gli endpoint realizzati delle tre superfici. Regole di progettazione in `doc/API-Guidelines.md`, credenziali in `doc/Security-Model.md`.
> Gli endpoint della superficie pubblica sono descritti anche in `doc/Public-API.md`, la versione per gli integratori esterni.

## Convenzioni comuni
- Envelope: `{ "data": ... }`, liste con `page`, errori `{ "error": { "code", "message", "details" } }`.
- Date ISO 8601 UTC, importi in centesimi interi, identificativi stringa.
- Codici d'errore: tabella in `doc/API-Guidelines.md` §5. Le route di un modulo che il gruppo non ha acceso rispondono `403 FEATURE_DISABLED` (qualunque sia il ruolo, PSA e D compresi), dopo il controllo del gruppo e del permesso.
- Ogni risposta porta `X-Request-Id`, generato dal server (un valore inviato dal client non viene riutilizzato).
- **Concorrenza ottimistica sulle aziende** (`ETag` forte e `If-Match`, `doc/API-Guidelines.md` §6): le risposte che portano un'azienda hanno `ETag: "<43 caratteri base64url>"` (la versione del documento memorizzato); ogni scrittura su un'azienda esistente richiede `If-Match` con quel valore, tra virgolette. Header mancante: `422` con `details: [{ "field": "If-Match", "issue": "required" }]`; non è un tag di questo server (elenco, tag debole `W/`, `*`): `422` con `issue: "format"`; versione non più corrente: `412 PRECONDITION_FAILED`.
- Ogni risposta è `Cache-Control: no-store`; `GET /v1/groups/{groupId}` e le liste compatte di riferimento (vedi "Liste") portano in più `ETag` (debole) e rispondono `304` a un `If-None-Match` corrispondente, per la copia in memoria del backoffice.
- Errori comuni a ogni percorso: `404 NOT_FOUND` (percorso inesistente), `405 METHOD_NOT_ALLOWED` con `Allow` (metodo non previsto), `400 BAD_REQUEST` (percorso o richiesta malformati). Sulle route con body: `400 MALFORMED_JSON`, `413 PAYLOAD_TOO_LARGE` (limite di default 100 KB), `415 UNSUPPORTED_MEDIA_TYPE` (content type diverso da `application/json` UTF-8 o body compresso).

## Liste
Le collezioni paginate rispondono `200` con `{ "data": [ … ], "page": { "limit": 50, "next": "<cursore>" } }`; `next` è `null` all'ultima pagina.
- `limit`: intero 1–200, default 50.
- `cursor`: cursore **opaco**, massimo 2200 caratteri; si passa **così com'è** il valore di `page.next` della pagina precedente, senza interpretarlo né modificarlo. È valido solo con lo stesso `sort` con cui è stato emesso: un cursore non valido, alterato o di un altro ordinamento dà `422 VALIDATION_ERROR` con `details: [{ "field": "cursor", "issue": "format" }]`.
- `sort`: uno dei nomi ammessi dalla risorsa (allowlist), con prefisso `-` per l'ordine decrescente; ogni risorsa dichiara il proprio default. Un valore fuori elenco è `422` (`enum`).
- `q`: testo di ricerca, 1–64 caratteri (spazi ai bordi rimossi), cercato come testo letterale, senza distinzione tra maiuscole e minuscole, nei campi indicati dalla risorsa.
- Parametri sconosciuti o ripetuti sono `422`. Le query hanno un tempo massimo di 5 secondi.
- **`ETag` e `304` sulle liste compatte di riferimento** (usate dal backoffice come cache in memoria): `GET /v1/groups`, `GET /v1/groups/{groupId}/companies`, `GET /v1/groups/{groupId}/places` e le letture `GET /v1/groups/{groupId}/lookup/*` (`products`, `product-categories`, `customers`, `contact-groups`, `price-lists`). Queste risposte portano `ETag: W/"…"` (debole, SHA-256 dell'intero body, `data` e `page`) e `Cache-Control: no-store`; con `If-None-Match` contenente il tag (anche `*` o un elenco) la risposta è `304` **senza body**. Il tag è calcolato sulla risposta già filtrata per il chiamante: due utenti con perimetri diversi hanno tag diversi, e un'altra pagina (`limit`, `cursor`, `sort`, `q`, filtri) dà un altro tag. Il confronto avviene **dopo** autenticazione, gruppo, permesso e validazione: un `If-None-Match` non produce mai un `304` al posto di `401`, `403`, `404` o `422`. Le altre liste (utenti, dealer, servizi, registro attività, cataloghi del gruppo) non hanno `ETag`.

## Endpoint di servizio
Fuori dalle superfici API, per le sonde di GKE.

### GET /health/live
- **Autenticazione e permesso:** anonimo (sonda di liveness dell'orchestratore)
- **Risposta:** `200`
  ```json
  { "data": { "status": "ok" } }
  ```

### GET /health/ready
- **Autenticazione e permesso:** anonimo (sonda di readiness dell'orchestratore)
- **Risposta:** `200` `{ "data": { "status": "ok" } }` se il servizio può ricevere traffico
- **Errori:** `503 SERVICE_UNAVAILABLE` durante l'arresto o se un controllo di prontezza fallisce (database non raggiungibile entro 2 s), senza dettagli
  ```json
  { "error": { "code": "SERVICE_UNAVAILABLE", "message": "Service unavailable" } }
  ```

## Formato di ogni endpoint
```markdown
### <METODO> <percorso>
- **Superficie:** backoffice | pubblica (la superficie `/store/v1` è eliminata, D-23)
- **Autenticazione e permesso:** es. Bearer backoffice, `products:read` — oppure anonimo (motivo)
- **Ruoli:** chi può chiamarlo e con quale perimetro
- **Parametri di percorso / query:** nome, tipo, obbligatorio, vincoli
- **Body:** schema con tipi e vincoli
- **Header particolari:** `Idempotency-Key`, `If-Match`…
- **Risposta:** codice e esempio
- **Errori:** codici possibili e quando
```

## Superficie backoffice — `/v1`

> **Flusso di sessione.** Il login restituisce una coppia di token opachi: l'**access token** (`fc_at_…`, valido 15 minuti) va inviato in `Authorization: Bearer` e il client lo tiene **solo in memoria**; il **refresh token** (`fc_rt_…`) viaggia nel body, non in un cookie, e il client lo conserva in `sessionStorage`. Il client rinnova la coppia **solo quando riceve `401 TOKEN_EXPIRED`**, con **un'unica richiesta di refresh condivisa** tra le chiamate concorrenti, e poi ripete la chiamata originale; ogni altro `401` (`UNAUTHENTICATED`) porta al login. Ogni refresh **ruota** il refresh token: quello precedente non vale più. Un nuovo tentativo con il token appena sostituito, entro **30 secondi** dalla rotazione (risposta persa per la rete), è rifiutato con `401 UNAUTHENTICATED` ma **non** termina la sessione e la coppia già emessa resta valida; un riuso fuori da quella finestra, o di un token più vecchio, fa revocare l'intera sessione. Il logout revoca la sessione corrente (`/auth/logout`) o tutte quelle dell'utente (`/auth/logout-all`). Le scadenze non superano mai la durata massima della sessione.
> **Password provvisoria.** Quando un amministratore crea l'utente o ne reimposta la password, il login risponde con `passwordChangeRequired: true` (come `GET /v1/me`). Finché la password non è cambiata, tutte le route con Bearer rispondono `403 PASSWORD_CHANGE_REQUIRED`, **tranne** `GET /v1/me`, `PUT /v1/me/password`, `POST /v1/auth/logout`, `POST /v1/auth/logout-all` e `POST /v1/client-errors`. Il client porta l'utente alla schermata di cambio password; dopo il cambio la sessione corrente resta valida e il flag torna `false`.
> Le risposte che contengono token non sono mai compresse.
> **Uso prolungato di `/v1` (per utente autenticato):** oltre al limite al minuto (`RATE_LIMIT_API_PER_USER`, 300), `/v1` ha un limite **orario** (`RATE_LIMIT_API_PER_USER_HOUR`, 2 000) e uno **giornaliero UTC** (`RATE_LIMIT_API_PER_USER_DAY`, 10 000), contati per id utente su ogni route `user` (non per la chiave di negozio, non per le route anonime, login e refresh). La modalità (`report` o `enforce`) si imposta dal backoffice (`sustainedLimits` in `GET/PUT /v1/settings/security-policy`, solo PSA): se il PSA non ha salvato nulla vale la variabile `RATE_LIMIT_API_SUSTAINED_MODE`; le soglie restano nelle variabili d'ambiente. Con `report` (default) il superamento **non** blocca: si registra una volta per utente e finestra l'evento di sicurezza `rateLimit.sustainedExceeded` (metadati `bucket`, `window` `hour`/`day`, `limit`, `mode`). Con `enforce` oltre soglia la risposta è `429 RATE_LIMITED` con `Retry-After` fino alla fine della finestra (il giorno se sono superate entrambe) e gli header `RateLimit-*` della finestra più vicina al limite. **PSA e D non sono mai bloccati** da questi due limiti, nemmeno con `enforce`: sono solo segnalati. Non sono mai rifiutate neppure `POST /v1/auth/logout`, `POST /v1/auth/logout-all`, `PUT /v1/me/password`, `PUT /v1/me/pin` e `DELETE /v1/me/sessions/{sessionId}` (contano, ma si possono sempre chiamare). Contano anche le richieste che la route poi rifiuta (`403`, `404`, `422`) e le `HEAD`, mai i preflight CORS. La finestra è fissa. Vincolo di configurazione: limite al minuto ≤ orario ≤ giornaliero. Chi ha bisogno di volumi alti dovrebbe usare le API pubbliche (`/public/v1`).
>
> **Segnale «richiesta non da browser».** Le richieste con le credenziali di un utente (le route `user` di `/v1`, e il login e il refresh riusciti) devono arrivare da un browser: se mancano `Origin` o ha un valore non ammesso (`CORS_ALLOWED_ORIGINS`), o le intestazioni `Sec-Fetch-*` sono incoerenti, si registra al più una volta al giorno per utente e motivo l'evento di sicurezza `request.nonBrowser` (motivo `noOrigin`/`foreignOrigin`/`inconsistentFetchMetadata`, dove è stato visto `login`/`refresh`/`api`, `User-Agent` ripulito). È **solo una segnalazione, falsificabile** (uno script può mandare le stesse intestazioni): **non blocca**, salvo che il PSA abbia impostato `nonBrowserRequests: "block"` (`GET/PUT /v1/settings/security-policy`: `403 BROWSER_REQUIRED`, mai per un PSA né per le route di revoca e credenziali), e non cambia mai la risposta se non con quel blocco. Non vale per `/public/v1`, la chiave di negozio, lo scambio del codice di attivazione, le route anonime né per un login o un refresh falliti. Si spegne (blocco compreso) con `REQUEST_ORIGIN_SIGNAL=off`. Un browser che non manda `Sec-Fetch-*` ma manda un `Origin` valido non è segnalato.
>
> **Header comuni:** dove è applicato un rate limit la risposta porta `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` (secondi alla riapertura della finestra); oltre il limite `429 RATE_LIMITED` aggiunge `Retry-After` (secondi).
> **Server di punto vendita.** L'app del negozio chiama le stesse route con una **chiave di negozio** (`Authorization: Bearer fc_sk_…`, sezione "Chiave di negozio" più sotto), ma solo quelle che la ammettono (oggi `GET /v1/store-context`, le tre di configurazione completa `GET /v1/store-context/group|company|place` e `GET /v1/store-context/countries` e `GET /v1/store-context/users` e le **quattordici del catalogo** `…/store-context/catalog/…` (sezione "Catalogo per il server di punto vendita"); il punto vendita si legge **solo** da `GET /v1/store-context/place`, il dettaglio `GET /v1/groups/{groupId}/places/{placeId}` non è aperto al negozio): ogni altra route risponde `403 FORBIDDEN` a una chiave di negozio. Una chiave valida con un punto vendita non operativo riceve `403 STORE_DISABLED`.
> **Errori delle route con Bearer:** `401 UNAUTHENTICATED` (token assente, malformato, sconosciuto o revocato), `401 TOKEN_EXPIRED` (access token scaduto: il client esegue il refresh), `403 FORBIDDEN` (permesso mancante).

### POST /v1/auth/login
- **Superficie:** backoffice
- **Autenticazione e permesso:** anonimo (è la route che ottiene le credenziali per le altre)
- **Body** (`application/json`, massimo 4 KB, nessun'altra proprietà):
  | Campo | Tipo | Obbligatorio | Vincoli |
  |---|---|---|---|
  | `username` | stringa | sì | 1–1024 caratteri, usato esattamente come inviato (nessun trim) |
  | `password` | stringa | sì | 1–1024 caratteri, usata esattamente come inviata |
- **Header particolari:** `RateLimit-*` (limiti per IP e per username)
- **Risposta:** `200` (`passwordChangeRequired` è `true` se l'utente ha una password provvisoria da cambiare; solo il login lo restituisce, non il refresh)
  ```json
  {
    "data": {
      "accessToken": "fc_at_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "accessTokenExpiresAt": "2026-11-04T09:15:00.000Z",
      "refreshToken": "fc_rt_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "refreshTokenExpiresAt": "2026-11-11T09:00:00.000Z",
      "sessionId": "665f1c2e9b1d4a0012ab34cd",
      "passwordChangeRequired": false
    }
  }
  ```
- **Errori:**
  - `401 INVALID_CREDENTIALS`: credenziali errate **oppure** account non ammesso (utente sconosciuto, bloccato per tentativi falliti, disabilitato o nel cestino, ruolo non abilitato, gruppo sospeso o nel cestino, campi vuoti o oltre 1024 caratteri). La risposta è **identica** per ogni caso:
    ```json
    { "error": { "code": "INVALID_CREDENTIALS", "message": "Invalid credentials" } }
    ```
  - `422 VALIDATION_ERROR` (campo mancante, di tipo errato o proprietà sconosciuta), `400 MALFORMED_JSON`, `413 PAYLOAD_TOO_LARGE`, `415 UNSUPPORTED_MEDIA_TYPE`
  - `429 RATE_LIMITED` con `Retry-After`

### POST /v1/auth/refresh
- **Superficie:** backoffice
- **Autenticazione e permesso:** anonimo (il refresh token è la credenziale)
- **Body** (`application/json`, massimo 4 KB, nessun'altra proprietà):
  | Campo | Tipo | Obbligatorio | Vincoli |
  |---|---|---|---|
  | `refreshToken` | stringa | sì | massimo 256 caratteri; il formato è verificato dal server |
- **Header particolari:** `RateLimit-*` (limite per IP)
- **Risposta:** `200`, stessa forma del login (nuova coppia di token; il refresh token precedente non vale più)
  ```json
  {
    "data": {
      "accessToken": "fc_at_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "accessTokenExpiresAt": "2026-11-04T09:30:00.000Z",
      "refreshToken": "fc_rt_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "refreshTokenExpiresAt": "2026-11-11T09:15:00.000Z",
      "sessionId": "665f1c2e9b1d4a0012ab34cd"
    }
  }
  ```
- **Errori:**
  - `401 UNAUTHENTICATED`: token malformato, sconosciuto, scaduto o revocato; sessione oltre la durata massima; utente o gruppo non più ammessi (la sessione viene revocata); token già ruotato (vedi la nota sul flusso)
  - `422 VALIDATION_ERROR`, `400 MALFORMED_JSON`, `413 PAYLOAD_TOO_LARGE`, `415 UNSUPPORTED_MEDIA_TYPE`
  - `429 RATE_LIMITED` con `Retry-After`

### POST /v1/auth/logout
- **Superficie:** backoffice
- **Autenticazione e permesso:** Bearer backoffice, `sessions:revoke`
- **Ruoli:** ogni utente autenticato, sulla propria sessione
- **Body:** nessuno
- **Risposta:** `204` senza body; revoca la sessione corrente (idempotente)
- **Errori:** `401 UNAUTHENTICATED` / `TOKEN_EXPIRED`, `403 FORBIDDEN`

### POST /v1/auth/logout-all
- **Superficie:** backoffice
- **Autenticazione e permesso:** Bearer backoffice, `sessions:revoke`
- **Ruoli:** ogni utente autenticato, sulle proprie sessioni
- **Body:** nessuno
- **Risposta:** `204` senza body; revoca **tutte** le sessioni dell'utente, compresa la corrente
- **Errori:** `401 UNAUTHENTICATED` / `TOKEN_EXPIRED`, `403 FORBIDDEN`

### GET /v1/me
- **Superficie:** backoffice
- **Autenticazione e permesso:** Bearer backoffice, `profile:read` (ammessa anche con la password provvisoria da cambiare)
- **Ruoli:** ogni utente autenticato, sul proprio profilo
- **Risposta:** `200` con il profilo. `permissions` è l'elenco dei permessi effettivi (`risorsa:azione`, ordinati alfabeticamente), calcolato dal server a ogni richiesta. `scope` riassume il perimetro dati; `scope.kind` è uno tra `platform`, `dealer` (con `groups` e `groupIds`, al massimo 100 id), `group` (con `groupId`), `companies` (con `groupId`, `companies`, `places`), `places` (con `groupId`, `places`), `none`. `dealer` (`id` e `businessName`) è presente per gli utenti `D` ed è `null` per gli altri ruoli (e per un `D` senza anagrafica). `passwordChangeRequired` è `true` finché l'utente ha una password provvisoria da cambiare (route sempre ammessa, vedi la nota sul flusso). `group` (`id` e `name`) è `null` per i ruoli senza gruppo; `groupFeatures` (le 15 feature del gruppo, ciascuna `true`/`false`) è presente per SA, CA e PA ed è `null` per PSA e D, che le leggono dal gruppo in cui lavorano (`GET /v1/groups/{groupId}`); `firstName`, `lastName`, `email`, `phone`, `description`, `createdAt`, `updatedAt` possono essere `null`. Il profilo porta anche i dati propri dell'utente descritti in "Gestione utenti": `avatar` (data URL o `null`), `hasAvatar`, `pinSet` (il PIN non è mai restituito), `serviceIds`, `pos` e `shiftTime`; `permissions` resta l'elenco dei permessi effettivi (la matrice per modulo è nelle route di gestione degli utenti).
  ```json
  {
    "data": {
      "id": "665f1c2e9b1d4a0012ab34ce",
      "username": "mario.rossi",
      "firstName": "Mario",
      "lastName": "Rossi",
      "email": "mario.rossi@example.com",
      "phone": "+39 02 1234567",
      "role": "CA",
      "groupId": "665f1c2e9b1d4a0012ab34a1",
      "dealerId": null,
      "companyIds": ["665f1c2e9b1d4a0012ab34b2"],
      "placeIds": ["665f1c2e9b1d4a0012ab34b3", "665f1c2e9b1d4a0012ab34b4"],
      "status": "active",
      "trashed": false,
      "language": "it",
      "theme": "system",
      "hiddenInStats": false,
      "description": null,
      "avatar": null,
      "hasAvatar": false,
      "pinSet": true,
      "serviceIds": [],
      "pos": { "enabled": true, "grants": { "discount": true, "…": "gli altri flag e i dispositivi, come in Gestione utenti" }, "options": { "side": "dx", "…": "le altre preferenze" } },
      "shiftTime": { "enabled": false, "weeks": [], "specialDays": [] },
      "permissions": ["companies:read", "places:read", "places:update", "profile:read", "profile:update", "sessions:revoke", "users:read"],
      "canManagePermissions": false,
      "passwordChangeRequired": false,
      "dealer": null,
      "scope": { "kind": "companies", "groupId": "665f1c2e9b1d4a0012ab34a1", "companies": 1, "places": 2 },
      "group": { "id": "665f1c2e9b1d4a0012ab34a1", "name": "Gruppo Esempio" },
      "groupFeatures": { "cash": true, "rooms": true, "ordering": false, "warehouse": true, "tobaccosGamesMonopoly": false, "productsVariants": true, "services": false, "appointments": false, "customersApp": false, "media": false, "email": false, "scales": false, "delivery": false, "autoDepartments": false, "advancedProducts": false },
      "createdAt": "2025-03-10T08:30:00.000Z",
      "updatedAt": "2026-10-01T12:00:00.000Z"
    }
  }
  ```
- **Errori:** `401 UNAUTHENTICATED` / `TOKEN_EXPIRED`, `403 FORBIDDEN`, `404 NOT_FOUND` (utente scomparso dopo l'autenticazione)

### PATCH /v1/me
- **Superficie:** backoffice
- **Autenticazione e permesso:** Bearer backoffice, `profile:update`
- **Ruoli:** ogni utente autenticato, sul proprio profilo
- **Body** (`application/json`, massimo 512 KB perché può portare l'avatar, JSON Merge Patch; almeno un campo; ogni altra proprietà, come `role`, `groupId`, `permissions`, `status` o `pin`, è respinta come sconosciuta; il PIN ha la sua route):
  | Campo | Tipo | Vincoli |
  |---|---|---|
  | `firstName` | stringa o `null` | 1–100 caratteri dopo il trim, senza caratteri di controllo né override bidirezionali; `null` azzera |
  | `lastName` | stringa o `null` | come `firstName` |
  | `email` | stringa o `null` | indirizzo di sintassi ordinaria (ASCII, un solo `@`, dominio con punto), massimo 254 caratteri, salvato in minuscolo; `null` azzera |
  | `phone` | stringa o `null` | cifre, spazi, `+`, `-`, `(`, `)` con almeno una cifra, massimo 32 caratteri; `null` azzera |
  | `language` | stringa | `it` (unico valore supportato) |
  | `theme` | stringa | tema colori del backoffice: `light`, `dark` o `system` (segue il sistema operativo); altro valore: `422` sul campo `theme`. Salvato in `settings.theme`; se manca o non è valido nel documento, `GET /v1/me` restituisce `system`. Lo cambia solo l'utente stesso; stesse regole e stesso evento di registro della lingua |
  | `avatar` | stringa o `null` | data URL di un'immagine PNG, JPEG o WebP, al massimo 200 KB di dati; `null` la rimuove. Stesse regole di "Gestione utenti" |
  | `pos.options` | oggetto | le preferenze di interfaccia della cassa (stesse chiavi e valori di `pos.options` in "Gestione utenti", **senza** `priceLists` e `defaultPriceListId`, che si cambiano dalla scheda dell'utente). `pos.enabled` e `pos.grants` non sono ammessi: sono permessi |
  Un campo assente non viene modificato.
  ```json
  { "firstName": "Mario", "phone": null, "language": "it", "pos": { "options": { "side": "sx", "darkMode": true } } }
  ```
- **Risposta:** `200` con il profilo aggiornato, stessa forma di `GET /v1/me`
- **Errori:** `401 UNAUTHENTICATED` / `TOKEN_EXPIRED`, `403 FORBIDDEN`, `404 NOT_FOUND`, `400 MALFORMED_JSON`, `413 PAYLOAD_TOO_LARGE`, `415 UNSUPPORTED_MEDIA_TYPE`, `422 VALIDATION_ERROR`:
  ```json
  { "error": { "code": "VALIDATION_ERROR", "message": "Invalid request", "details": [{ "field": "email", "issue": "format" }, { "field": "role", "issue": "unknown" }] } }
  ```
  Un body vuoto (`{}`) dà `details: [{ "field": "(body)", "issue": "required" }]`. Un'immagine non valida dà `avatar`/`format` (tipo non ammesso, base64 non valido o contenuto che non corrisponde al tipo dichiarato) o `avatar`/`maximum` (oltre 200 KB); un `favoritesId` che non è tra i preferiti del gruppo dà `pos.options.favoritesId`/`incorrect`.

### PUT /v1/me/password
- **Superficie:** backoffice
- **Autenticazione e permesso:** Bearer backoffice, `profile:update` (ammessa anche con la password provvisoria da cambiare: è la route che la sostituisce)
- **Ruoli:** ogni utente autenticato, sulla propria password
- **Body** (`application/json`, massimo 8 KB, nessun'altra proprietà):
  | Campo | Tipo | Obbligatorio | Vincoli |
  |---|---|---|---|
  | `currentPassword` | stringa | sì | 1–1024 caratteri, usata esattamente come inviata |
  | `newPassword` | stringa | sì | massimo 1024 caratteri nella richiesta; la policy richiede 12–128 caratteri, diversa dallo username e dalla password attuale |
- **Header particolari:** `RateLimit-*` (limite per utente)
- **Risposta:** `204` senza body. Se la password era provvisoria, non lo è più (`passwordChangeRequired` torna `false`). Tutte le **altre** sessioni dell'utente vengono revocate; quella corrente resta valida.
- **Errori:** `401 UNAUTHENTICATED` / `TOKEN_EXPIRED`, `403 FORBIDDEN`, `404 NOT_FOUND`, `400 MALFORMED_JSON`, `413 PAYLOAD_TOO_LARGE`, `415 UNSUPPORTED_MEDIA_TYPE`, `429 RATE_LIMITED` con `Retry-After`, `422 VALIDATION_ERROR`:
  - password attuale errata:
    ```json
    { "error": { "code": "VALIDATION_ERROR", "message": "Invalid request", "details": [{ "field": "currentPassword", "issue": "incorrect" }] } }
    ```
  - nuova password fuori policy (uno o più `issue` su `newPassword`: `tooShort`, `tooLong`, `sameAsUsername`, `invalidCharacters`; `reused` se è uguale alla password attuale):
    ```json
    { "error": { "code": "VALIDATION_ERROR", "message": "Invalid request", "details": [{ "field": "newPassword", "issue": "tooShort" }] } }
    ```

### PUT /v1/me/pin
- **Superficie:** backoffice
- **Autenticazione e permesso:** Bearer backoffice, `profile:update`
- **Ruoli:** ogni utente autenticato, sul proprio PIN
- **Body** (`application/json`, massimo 8 KB, nessun'altra proprietà):
  | Campo | Tipo | Obbligatorio | Vincoli |
  |---|---|---|---|
  | `currentPassword` | stringa | sì | 1–1024 caratteri, usata esattamente come inviata |
  | `pin` | stringa o `null` | sì | da 3 a 6 cifre; `null` rimuove il PIN |
  ```json
  { "currentPassword": "<password attuale>", "pin": "4821" }
  ```
- **Header particolari:** `RateLimit-*` (stesso limite per utente del cambio password)
- **Risposta:** `204` senza body. Il PIN non è mai restituito (nel profilo e negli utenti c'è solo `pinSet`) né registrato. Il PIN non è una credenziale di sessione: nessuna sessione viene chiusa.
- **Errori:** `401 UNAUTHENTICATED` / `TOKEN_EXPIRED`, `403 FORBIDDEN`, `404 NOT_FOUND`, `400 MALFORMED_JSON`, `413 PAYLOAD_TOO_LARGE`, `415 UNSUPPORTED_MEDIA_TYPE`, `429 RATE_LIMITED` con `Retry-After`, `422 VALIDATION_ERROR` (`currentPassword`/`incorrect` se la password è errata, ed è registrato `auth.passwordCheckFailed`; `pin`/`minLength`, `maxLength` o `pattern` se non sono da 3 a 6 cifre)

### GET /v1/me/sessions
- **Superficie:** backoffice
- **Autenticazione e permesso:** Bearer backoffice, `profile:read`
- **Ruoli:** ogni utente autenticato, sulle proprie sessioni
- **Risposta:** `200` con l'elenco delle sessioni **attive** dell'utente (senza paginazione e senza token); `current` indica la sessione della richiesta.
  ```json
  {
    "data": [
      {
        "id": "665f1c2e9b1d4a0012ab34cd",
        "createdAt": "2026-11-04T09:00:00.000Z",
        "lastUsedAt": "2026-11-04T09:12:30.000Z",
        "userAgent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
        "ip": "203.0.113.10",
        "current": true
      },
      {
        "id": "665f1c2e9b1d4a0012ab34d0",
        "createdAt": "2026-11-02T15:40:00.000Z",
        "lastUsedAt": "2026-11-03T08:05:10.000Z",
        "userAgent": null,
        "ip": null,
        "current": false
      }
    ]
  }
  ```
- **Errori:** `401 UNAUTHENTICATED` / `TOKEN_EXPIRED`, `403 FORBIDDEN`

### DELETE /v1/me/sessions/{sessionId}
- **Superficie:** backoffice
- **Autenticazione e permesso:** Bearer backoffice, `sessions:revoke`
- **Ruoli:** ogni utente autenticato, sulle proprie sessioni
- **Parametri di percorso:** `sessionId` (stringa di 24 caratteri esadecimali, obbligatorio), l'`id` di una sessione di `GET /v1/me/sessions`
- **Risposta:** `204` senza body; la sessione è revocata
- **Errori:** `401 UNAUTHENTICATED` / `TOKEN_EXPIRED`, `403 FORBIDDEN`, `404 NOT_FOUND` (sessione inesistente, di un altro utente o già revocata), `422 VALIDATION_ERROR` (`sessionId` non valido):
  ```json
  { "error": { "code": "VALIDATION_ERROR", "message": "Invalid request", "details": [{ "field": "sessionId", "issue": "format" }] } }
  ```

## Gestione utenti (`/v1`)

Rappresentazione di un utente, comune a tutte le route di questa sezione (il campo `pos` è abbreviato: i flag e le preferenze sono elencati in `doc/Data-Model.md`, *users*):
```json
{
  "id": "665f1c2e9b1d4a0012ab34ce",
  "username": "mario.rossi",
  "firstName": "Mario",
  "lastName": "Rossi",
  "email": "mario.rossi@example.com",
  "phone": "+39 02 1234567",
  "role": "CA",
  "groupId": "665f1c2e9b1d4a0012ab34a1",
  "dealerId": null,
  "companyIds": ["665f1c2e9b1d4a0012ab34b2"],
  "placeIds": ["665f1c2e9b1d4a0012ab34b3"],
  "status": "active",
  "trashed": false,
  "language": "it",
  "theme": "system",
  "hiddenInStats": false,
  "description": "Referente di sala",
  "avatar": "data:image/png;base64,iVBORw0KGgo…",
  "hasAvatar": true,
  "pinSet": true,
  "serviceIds": ["665f1c2e9b1d4a0012ab34f0"],
  "permissions": {
    "status": false,
    "modules": {
      "groups": { "r": false, "w": false },
      "users": { "r": true, "w": false },
      "companies": { "r": true, "w": false },
      "places": { "r": true, "w": true },
      "documents": { "r": true, "w": true },
      "products": { "r": true, "w": true },
      "calendar": { "r": true, "w": true },
      "warehouse": { "r": true, "w": true },
      "contacts": { "r": true, "w": true },
      "fidelity": { "r": false, "w": false },
      "settings": { "r": false, "w": false },
      "stats": { "r": true, "w": false },
      "logs": { "r": true }
    },
    "canManagePermissions": false
  },
  "pos": {
    "enabled": true,
    "grants": {
      "discount": true,
      "priceChange": true,
      "invoices": true,
      "freeSale": true,
      "discountMaxPercentage": 20,
      "servicePercentage": null,
      "automaticCash": { "glory": { "withdrawal": false, "deposit": false }, "…": "gli altri dispositivi" },
      "…": "gli altri flag, tutti presenti"
    },
    "options": {
      "side": "dx",
      "template": "material-whitepurple-light",
      "priceLists": [{ "priceListId": "Zk3vQ0aT9bX2mN7pLw4HcA", "enabled": true, "isDefault": true }],
      "favoritesId": null,
      "…": "le altre preferenze, tutte presenti"
    }
  },
  "shiftTime": {
    "enabled": true,
    "weeks": [
      {
        "from": null,
        "to": null,
        "days": { "0": { "active": false, "slots": [] }, "1": { "active": true, "slots": [{ "start": "09:00", "end": "13:00" }, { "start": "14:00", "end": "18:00" }] }, "…": "i giorni da 2 a 6" }
      }
    ],
    "specialDays": [{ "date": "2026-12-25", "dayOff": true, "slots": [] }]
  },
  "createdAt": "2026-11-04T09:00:00.000Z",
  "updatedAt": "2026-11-04T09:00:00.000Z"
}
```
Mai presenti password, hash, **PIN** o token: del PIN c'è solo `pinSet`. `avatar` è presente solo nel dettaglio e nelle risposte di creazione e modifica, mai negli elenchi (lì c'è `hasAvatar`); un'immagine memorizzata dal vecchio sistema che non è un PNG, JPEG o WebP valido non si mostra: `avatar: null` con `hasAvatar: true`. **PSA e D hanno tutti i permessi** (D-10): per loro `permissions` mostra tutti i flag e `canManagePermissions` veri, qualunque cosa il documento contenga. `permissions.modules` ha sempre i 13 moduli (`logs` solo con `r`); un flag assente nel documento vale `false`. Date di `shiftTime.weeks[].from|to` in ISO 8601 UTC; `shiftTime.weeks[].days` ha sempre le chiavi `"0"` (domenica) … `"6"`.

Le richieste di creazione e modifica accettano `permissions` come `{ "modules": { "<modulo>": { "r": bool, "w": bool } }, "canManagePermissions": bool }` con i 13 moduli (`groups`, `users`, `companies`, `places`, `documents`, `products`, `calendar`, `warehouse`, `contacts`, `fidelity`, `settings`, `stats`, `logs` con il solo `r`) e ogni flag opzionale, più i dati dell'utente descritti qui sotto.

**Regole comuni**
- **Due aree.** Gli utenti di un gruppo (ruoli `SA`, `CA`, `PA`, `E`) stanno sotto `/v1/groups/{groupId}/users`; gli utenti di piattaforma (`PSA`, `D`) sotto `/v1/users`, **gestiti solo da un PSA** (qualunque altro ruolo riceve `403 FORBIDDEN`). `GET /v1/users` è invece anche l'elenco trasversale di PSA e D.
- **Gruppo nel percorso.** `groupId` è verificato rispetto al perimetro del chiamante prima del permesso: un id malformato o fuori perimetro dà `404 NOT_FOUND`. Un PSA o un D che accede a un gruppo lascia traccia nel registro delle attività.
- **Ruoli gestibili.** PSA: tutti; D e SA: `SA`, `CA`, `PA`, `E`; CA: `CA`, `PA`, `E`; PA: `PA`, `E`; E: nessuno. Il ruolo richiesto (in creazione o modifica) fuori da questo elenco dà `403 FORBIDDEN`. Il perimetro del chiamante limita anche gli utenti visibili: un utente inesistente, di un altro gruppo o fuori perimetro dà sempre lo **stesso** `404 NOT_FOUND`.
- **Anti-escalation.** `403 FORBIDDEN` (senza dettagli) anche quando: il bersaglio è il chiamante stesso, ha un rango superiore o un perimetro non gestito dal chiamante, **ha permessi che il chiamante non possiede** (vale per creazione, modifica, disabilitazione, cestino, reset password e eliminazione; la matrice richiesta non può superare quella del chiamante, e lo stesso vale per i permessi della cassa: vedi "Dati dell'utente").
- **Perimetro (campi `companyIds` / `placeIds`, fino a 100 id ciascuno, duplicati ignorati).** `CA`: almeno un'azienda (`required` su `companyIds`); `PA` ed `E`: almeno un punto vendita (`required` su `placeIds`); `SA`, `PSA`, `D`: nessuno dei due (`incorrect`). Un id inesistente, nel cestino, di un altro gruppo o fuori dal perimetro del chiamante, o un punto vendita che non appartiene alle aziende dell'utente, è `incorrect` sulla posizione (`companyIds.N`, `placeIds.N`), senza distinguere i casi.
- **Password provvisoria.** Creazione e reset impostano una password provvisoria: l'utente al primo accesso deve cambiarla (`passwordChangeRequired`, vedi `PUT /v1/me/password`). Policy: 12–128 caratteri, diversa dallo username; le violazioni sono `issue` su `password` (`tooShort`, `tooLong`, `sameAsUsername`, `invalidCharacters`). Un cambio di ruolo, perimetro, stato o permessi (anche `pos.enabled` e `pos.grants`, non le preferenze `pos.options`), il reset della password e il cestino **terminano le sessioni** dell'utente e ne svuotano i token legacy. Un cambio di PIN non termina le sessioni.
- **Username:** solo ASCII, 3–64 caratteri tra lettere, cifre, `.`, `_`, `@`, `+`, `-` (spazi ai bordi rimossi). Univoco su tutta la piattaforma: se già in uso `409 CONFLICT` con `details: [{ "field": "username", "issue": "taken" }]`.
- **Errori comuni:** `401 UNAUTHENTICATED` / `TOKEN_EXPIRED`, `403 FORBIDDEN`, `403 PASSWORD_CHANGE_REQUIRED` (l'utente ha una password provvisoria da cambiare), `404 NOT_FOUND`, `400 MALFORMED_JSON`, `413 PAYLOAD_TOO_LARGE` (512 KB sulle scritture, perché possono portare l'avatar; 4 KB sul reset password), `415 UNSUPPORTED_MEDIA_TYPE`, `422 VALIDATION_ERROR` (per campo; proprietà sconosciute `unknown`; body vuoto in PATCH `(body)`/`required`).
- **Rate limit dedicato** su creazione e reset password (ognuno costa un calcolo di hash): per utente, 20 richieste al minuto di default; oltre `429 RATE_LIMITED` con `Retry-After`, con header `RateLimit-*` sulle risposte.

**Dati dell'utente** (campi comuni a creazione e modifica, tutti facoltativi; `null` svuota un valore che ammette `null`, `[]` una lista, a differenza del vecchio sistema; in `PATCH` ciò che manca resta com'è)
| Campo | Tipo | Vincoli |
|---|---|---|
| `description` | stringa o `null` | fino a 1000 caratteri |
| `avatar` | stringa o `null` | data URL `data:image/png|jpeg|webp;base64,…`; al massimo 200 KB di dati; il tipo è **verificato dai primi byte** del contenuto, non dal prefisso, e il base64 deve essere valido e canonico. Mai SVG o altro: `422` `avatar`/`format` (tipo non ammesso, contenuto diverso dal tipo dichiarato, base64 non valido), `avatar`/`maximum` (oltre 200 KB) |
| `pin` | stringa o `null` | da 3 a 6 cifre; mai restituito (solo `pinSet`) né registrato; `null` lo rimuove; non termina le sessioni. Salvato come richiede la cassa |
| `hiddenInStats` | booleano | l'utente non compare nelle statistiche |
| `serviceIds` | array di id | solo nelle route di gruppo; fino a 200 id univoci. I servizi del gruppo (prodotti di tipo servizio non nel cestino) che l'utente può erogare; ammessi solo per i ruoli `SA`, `CA`, `PA` e solo se il gruppo ha la feature `services`. Altrimenti `422` `serviceIds`/`notAllowed` (ruolo, area o feature spenta: la route resta disponibile, quindi non è `403 FEATURE_DISABLED`) o `serviceIds.N`/`incorrect` (non è un servizio del gruppo, o è ripetuto). Si controllano solo gli id nuovi; svuotare la lista è sempre ammesso |
| `pos` | oggetto | dati della cassa, vedi sotto |
| `shiftTime` | oggetto | turni, vedi sotto |

`pos`: `{ "enabled": bool, "grants": {…}, "options": {…} }`, tutto facoltativo, in modifica si fonde con i valori salvati (i singoli flag inviati cambiano, gli altri restano). `grants` sono **permessi**: 47 flag booleani (nomi in `doc/Data-Model.md`; `cashEnabled` e `handheldEnabled` valgono `true` quando la chiave manca e per ogni utente nuovo, `handheldWallet` `false`; sono accettati sempre, anche se il gruppo non ha le sale), `discountMaxPercentage` e `servicePercentage` (0–100 o `null` per nessun tetto), `automaticCash` per i dispositivi `glory`, `cashMatic`, `vne`, `azkoyen`, `cashSystem` (flag booleani). `options` sono preferenze di interfaccia, non permessi: 34 booleani (compresi `productsUppercase`, `productsBold`, `roomsLegend`, default `false`) più `productsColorStyle` (`line`, `fill`; default `line`), `handheldTextZoom` (85, 90, …, 125; default 100), `handheldCategoriesLayout` (`scroll`, `slidein`, `list`; default `scroll`), `handheldCategoriesRows` (1, 2; default 2), `handheldProductsColumns` (1–4; default 2), `handheldMenuPosition` (`bottom`, `top`; default `bottom`), poi `favoritesId` (id di un elenco di `GET /v1/groups/{groupId}/product-favorites` del gruppo dell'utente, o `null`), `side` e `sideRooms` (`dx`, `sx`), `virtualKeyboard` (`""`, `pb`, `p`, `mb`, `m`), `template` (`material-tealwhite-light`, `material-tealwhite-dark`, `material-whitepurple-light`, `material-whitepurple-dark` o `null`), `productsFontSize` e `productsShortNameFontSize` (`s`, `m`, `l`), `roomsTablesColumns` (4, 5, 6, 8 o `null`), `roomsTablesColumnsHandheld` (2, 3, 4 o `null`), `roomsGridZoomHandheld` (1, 1.5, 2, 2.5, 3), `quickDiscount` (0–100 o `null`), `defaultPriceListId` (listino di un elenco di `GET /v1/groups/{groupId}/price-lists`, o `null`) e `priceLists`, l'elenco `[{ "priceListId", "enabled", "isDefault" }]` dei listini che l'utente può usare (fino a 50, al massimo uno `isDefault`, tutti del gruppo dell'utente, senza ripetizioni; se inviato, sostituisce l'elenco salvato). Riferimenti non validi: `pos.options.favoritesId`, `pos.options.defaultPriceListId`, `pos.options.priceLists.N.priceListId` o `.isDefault` `incorrect` (un riferimento che l'utente ha già non è ricontrollato). Un utente senza gruppo (PSA, D) non può riferirsi ad alcun elenco.
- **Chi può dare i permessi della cassa** (`pos.enabled`, `pos.grants`): serve `canManagePermissions`, altrimenti `403 FORBIDDEN` senza dettagli. `PSA`, `D` e `SA` li impostano tutti. `CA` e `PA` concedono **solo ciò che hanno loro**: un flag diventa `true` solo se lo hanno, non abilitano la cassa se non è abilitata per loro, e se hanno un tetto di sconto non possono impostare `null` né un valore maggiore: `403 FORBIDDEN` con `details: [{ "field": "pos.grants.discount", "issue": "notAllowed" }]` (anche `pos.enabled`, `pos.grants.discountMaxPercentage`, `pos.grants.automaticCash.<dispositivo>.<flag>`). Chi crea senza poter gestire i permessi dà all'utente il solo default del ruolo (per `CA` e `PA` limitato a ciò che possiedono). Le `options` non sono permessi: le cambia chiunque possa modificare l'utente.
- **Default alla creazione.** Senza `permissions`, la matrice è quella del ruolo nel modulo di creazione del vecchio sistema (tabella in `doc/Technical-Guide.md` §6, limitata a ciò che possiede chi crea); senza `pos`, `PSA` e `D` hanno la cassa spenta e nessun flag (salvo `cashEnabled` e `handheldEnabled`, `true` per tutti), gli altri ruoli la cassa abilitata con `discount`, `priceChange`, `invoices` e `freeSale`; le preferenze hanno i valori predefiniti (`side` e `sideRooms` `dx`, `virtualKeyboard` `""`, `template` `material-whitepurple-light`, font `s`, `roomsGridZoomHandheld` 2, il resto spento o `null`) e `priceLists` contiene tutti i listini del gruppo abilitati, con selezionato il predefinito del gruppo (vuoto per chi non ha gruppo). Ciò che l'utente invia sostituisce i default. Il documento creato ha tutte le chiavi del vecchio sistema.
- **`shiftTime`**: `{ "enabled": bool, "weeks": [{ "from": data|null, "to": data|null, "days": { "0": { "active": bool, "slots": [{ "start": "HH:mm", "end": "HH:mm" }] }, … } }], "specialDays": [{ "date": "YYYY-MM-DD", "dayOff": bool, "slots": […] }] }`. `weeks` e `specialDays`, se inviati, sostituiscono la lista salvata; in un blocco i giorni non elencati sono inattivi e senza fasce. Il blocco senza date è quello predefinito (uno solo); i blocchi con date (`from` e `to` insieme, `from` non dopo `to`) non possono sovrapporsi; un giorno speciale prevale sui blocchi. Limiti: 20 blocchi, 10 fasce per giorno, 366 giorni speciali; in una fascia `start` precede `end`. Non dipendono da alcuna feature. Violazioni: `shiftTime.weeks.N` `incorrect` (secondo blocco predefinito o sovrapposizione), `shiftTime.weeks.N.from|to` `required` / `shiftTime.weeks.N.to` `incorrect`, `…slots.N.end` `incorrect`, `shiftTime.specialDays.N.date` `incorrect` (ripetuto), `format` per una data impossibile.

### GET /v1/groups/{groupId}/users
- **Superficie:** backoffice
- **Autenticazione e permesso:** Bearer backoffice, `users:read`
- **Ruoli:** i ruoli con il permesso, entro il proprio perimetro (PSA e D dei propri gruppi; SA, CA, PA il proprio gruppo; i CA e i PA vedono gli utenti del proprio perimetro di aziende e punti vendita)
- **Parametri di percorso:** `groupId` (24 caratteri esadecimali)
- **Query:** `limit`, `cursor`, `sort`, `q` come nelle convenzioni sulle liste; `role` (`SA`, `CA`, `PA`, `E`); `status` (`active`, `disabled`); `trashed` (`true` per vedere solo il cestino; default `false`, cestino escluso). `sort`: `username` (default), `lastName`, `createdAt`, con `-` per l'ordine decrescente. `q` cerca nello username, nome, cognome, e-mail e telefono.
- **Risposta:** `200`
  ```json
  { "data": [ { "id": "665f1c2e9b1d4a0012ab34ce", "username": "mario.rossi", "role": "CA", "hasAvatar": true, "…": "rappresentazione completa come sopra, senza il campo avatar" } ], "page": { "limit": 50, "next": null } }
  ```
- **Errori:** comuni, `422` su parametri di query non validi (`cursor`/`format` se il cursore non è valido)

### POST /v1/groups/{groupId}/users
- **Superficie:** backoffice
- **Autenticazione e permesso:** Bearer backoffice, `users:create`
- **Ruoli:** secondo i ruoli gestibili e il perimetro; il gruppo viene dal percorso, mai dal body
- **Body** (`application/json`, massimo 16 KB, nessun'altra proprietà):
  | Campo | Tipo | Obbligatorio | Vincoli |
  |---|---|---|---|
  | `username` | stringa | sì | vedi regole comuni |
  | `password` | stringa | sì | provvisoria; policy delle regole comuni; max 1024 nella richiesta |
  | `role` | stringa | sì | `SA`, `CA`, `PA`, `E` |
  | `firstName`, `lastName` | stringa o `null` | no | 1–100 caratteri, senza caratteri di controllo |
  | `email` | stringa o `null` | no | sintassi ordinaria, max 254, salvata in minuscolo |
  | `phone` | stringa o `null` | no | cifre, spazi, `+-()`, max 32 |
  | `language` | stringa | no | `it` |
  | `theme` | stringa | no | `light`, `dark` o `system` (default) |
  | `companyIds`, `placeIds` | array di id | secondo il ruolo | max 100 elementi, vedi perimetro |
  | `status` | stringa | no | `active` (default) o `disabled` |
  | `permissions` | oggetto | no | default del ruolo, limitato a quanto possiede il chiamante |
  | `description`, `avatar`, `pin`, `hiddenInStats`, `serviceIds`, `pos`, `shiftTime` | vedi "Dati dell'utente" | no | `serviceIds` solo nelle route di gruppo |
  ```json
  { "username": "mario.rossi", "password": "<password provvisoria>", "role": "PA", "firstName": "Mario", "placeIds": ["665f1c2e9b1d4a0012ab34b3"], "pin": "4821", "pos": { "grants": { "discountMaxPercentage": 10 } } }
  ```
- **Header particolari:** risposta con `Location: /v1/groups/{groupId}/users/{userId}`; `RateLimit-*`
- **Risposta:** `201` con l'utente creato (rappresentazione completa)
- **Errori:** comuni; `403 FORBIDDEN` (ruolo non gestibile, permessi richiesti non posseduti, permessi della cassa senza `canManagePermissions` o non posseduti da un `CA`/`PA`, con `details` `notAllowed` sui campi `pos.*`); `409 CONFLICT` (`username`/`taken`); `422` per campo (`password` con le issue di policy, `companyIds`/`placeIds` `required` / `incorrect`, `companyIds.N` / `placeIds.N` `incorrect`, `avatar`, `pin`, `serviceIds`, `pos.options.*`, `shiftTime.*` come in "Dati dell'utente"); `429 RATE_LIMITED`

### GET /v1/groups/{groupId}/users/{userId}
- **Autenticazione e permesso:** Bearer backoffice, `users:read`
- **Parametri di percorso:** `groupId`, `userId` (24 caratteri esadecimali)
- **Risposta:** `200` con l'utente
- **Errori:** comuni; `404 NOT_FOUND` identico per utente inesistente, di un altro gruppo o fuori perimetro

### PATCH /v1/groups/{groupId}/users/{userId}
- **Autenticazione e permesso:** Bearer backoffice, `users:update`
- **Body** (JSON Merge Patch, massimo 512 KB, almeno un campo): gli stessi campi della creazione tranne `password`, tutti opzionali (`username`, `role`, `firstName`, `lastName`, `email`, `phone`, `language`, `theme`, `companyIds`, `placeIds`, `status`, `permissions`, `description`, `avatar`, `pin`, `hiddenInStats`, `serviceIds`, `pos`, `shiftTime`). I flag di `permissions` e di `pos` inviati sostituiscono quelli salvati, gli altri restano; le scritture sono per singolo valore, quindi le informazioni dell'utente che il sistema non gestisce restano intatte. Un `pin` inviato è sempre scritto. Il perimetro è verificato solo se cambia perimetro o ruolo. Disabilitare un utente (`status: "disabled"`) richiede di possedere almeno i permessi che l'utente ha.
- **Risposta:** `200` con l'utente aggiornato (invariato se nessun valore cambia)
- **Errori:** comuni; `403 FORBIDDEN` (se stesso, rango, perimetro, permessi non posseduti); `404`; `409 CONFLICT` (`username`/`taken`); `422`

### PUT /v1/groups/{groupId}/users/{userId}/password
- **Autenticazione e permesso:** Bearer backoffice, `users:update`
- **Body** (massimo 4 KB): `{ "password": "…" }`, la nuova password provvisoria (policy delle regole comuni)
- **Risposta:** `204` senza body; sblocca l'account se bloccato, termina le sessioni dell'utente e lo obbliga a cambiare la password al prossimo accesso
- **Errori:** comuni; `403 FORBIDDEN` (inclusi i permessi del bersaglio non posseduti), `404`, `422` (`password` con le issue di policy), `429 RATE_LIMITED`

### POST /v1/groups/{groupId}/users/{userId}/trash
- **Autenticazione e permesso:** Bearer backoffice, `users:trash`
- **Body:** nessuno
- **Risposta:** `200` con l'utente (`trashed: true`); le sue sessioni terminano
- **Errori:** comuni; `403 FORBIDDEN` (inclusi i permessi del bersaglio non posseduti), `404`, `409 CONFLICT` (già nel cestino)

### POST /v1/groups/{groupId}/users/{userId}/restore
- **Autenticazione e permesso:** Bearer backoffice, `users:trash`
- **Body:** nessuno
- **Risposta:** `200` con l'utente (`trashed: false`)
- **Errori:** comuni; `403`, `404`, `409 CONFLICT` (non è nel cestino)

### DELETE /v1/groups/{groupId}/users/{userId}
- **Autenticazione e permesso:** Bearer backoffice, `users:delete`
- **Risposta:** `204` senza body; elimina definitivamente l'utente, le sue credenziali e le sue sessioni
- **Errori:** comuni; `403 FORBIDDEN` (inclusi i permessi del bersaglio non posseduti), `404`, `409 CONFLICT` (l'utente **non è nel cestino**; il ripristino è atomico sullo stato: se un'altra richiesta lo ha già ripristinato risponde `409` e l'evento è uno solo)

### GET /v1/users
- **Autenticazione e permesso:** Bearer backoffice, `users:read`
- **Ruoli:** **PSA** (tutti gli utenti) e **D** (gli utenti dei gruppi del dealer); ogni altro ruolo `403 FORBIDDEN`
- **Query:** come l'elenco del gruppo, con `role` su tutti i ruoli (`PSA`, `D`, `SA`, `CA`, `PA`, `E`) e in più `groupId` e `dealerId` (24 caratteri esadecimali). `dealerId` è riservato al PSA (un D riceve `403 FORBIDDEN`).
- **Risposta:** `200` `{ "data": [ … ], "page": { "limit": 50, "next": "…" } }`. Ogni voce ha anche `groupName`, il nome del gruppo dell'utente, cercato solo per i gruppi della pagina: `""` se il gruppo non ha un nome, `null` per un utente senza gruppo (PSA e D) o con un gruppo che non esiste. L'elenco del gruppo e il dettaglio dell'utente non lo hanno. Con `trashed=true` il D vede solo gli utenti nel cestino dei propri gruppi (mai gli utenti di piattaforma); il PSA tutti. Il ripristino (`POST /v1/users/{id}/restore`) e l'eliminazione definitiva (`DELETE /v1/users/{id}`) degli utenti di piattaforma (PSA, D) nel cestino sono del solo PSA (il D riceve `403`); gli utenti di un gruppo si ripristinano ed eliminano sulle rotte del gruppo.
- **Errori:** comuni; `403 FORBIDDEN`; `422`; `503 SERVICE_UNAVAILABLE` se la lettura dei nomi dei gruppi supera il tempo massimo

### POST /v1/users
- **Autenticazione e permesso:** Bearer backoffice, `users:create`; solo **PSA**
- **Body:** come la creazione di un utente di gruppo ma `role` è `PSA` o `D`, senza `companyIds`, `placeIds` né `serviceIds` (nessun gruppo, nessun perimetro). Con `role: "D"` viene creata nella stessa transazione anche l'anagrafica minima del dealer (con lo stesso id e la ragione sociale pari allo username, da completare con `PATCH /v1/dealers/{dealerId}`); per creare un dealer con l'anagrafica completa si usa `POST /v1/dealers`.
- **Header particolari:** `Location: /v1/users/{userId}`; `RateLimit-*`
- **Risposta:** `201` con l'utente creato
  ```json
  { "data": { "id": "665f1c2e9b1d4a0012ab34d1", "username": "dealer.nord", "role": "D", "groupId": null, "…": "rappresentazione completa" } }
  ```
- **Errori:** comuni; `403 FORBIDDEN`, `409 CONFLICT` (`username`/`taken`), `422`, `429 RATE_LIMITED`

### GET /v1/users/{userId}, PATCH /v1/users/{userId}, PUT /v1/users/{userId}/password, POST /v1/users/{userId}/trash, POST /v1/users/{userId}/restore, DELETE /v1/users/{userId}
- **Autenticazione e permesso:** Bearer backoffice, rispettivamente `users:read`, `users:update`, `users:update`, `users:trash`, `users:trash`, `users:delete`; solo **PSA**, su utenti `PSA` e `D`
- **Body, risposte ed errori:** come le route corrispondenti del gruppo (PATCH senza `companyIds` / `placeIds` / `serviceIds`, con `role` limitato a `PSA` e `D`). In più: `DELETE` di un `D` che ha ancora gruppi (anche nel cestino) dà `409 CONFLICT` con `details: [{ "field": "groups", "issue": "referenced" }]`, altrimenti elimina anche la sua anagrafica dealer; un `PATCH` che porta il ruolo **da o verso `D`** dà `422` con `details: [{ "field": "role", "issue": "immutable" }]` (il ruolo `D` non si cambia). Un utente di gruppo chiesto su questo percorso è `404 NOT_FOUND`.

### GET /v1/usernames/{username}/availability
- **Autenticazione e permesso:** Bearer backoffice, `users:create`
- **Parametri di percorso:** `username` (stesse regole dello username)
- **Header particolari:** `RateLimit-*` (15 richieste al minuto per utente di default)
- **Risposta:** `200`
  ```json
  { "data": { "available": false } }
  ```
  `available` è `false` anche se lo username appartiene a un utente nel cestino.
- **Errori:** comuni; `422` (username non valido), `429 RATE_LIMITED`

## Dati di riferimento (`/v1`)

Letture **compatte** (id, nome, stato) pensate per alimentare i selettori del backoffice, per esempio il gruppo, le aziende e i punti vendita nel perimetro di un utente. Le aree gruppi, aziende e punti vendita le estendono con le route di gestione complete (le aziende sono in "Aziende", i punti vendita in "Punti vendita"). Parametri di lista comuni (`limit`, `cursor`, `sort`, `q`: vedi "Liste"); `sort` ammette solo `name` (default, anche `-name`), `q` cerca nel nome. Errori comuni a queste letture: `401 UNAUTHENTICATED` / `TOKEN_EXPIRED`, `403 FORBIDDEN` (permesso mancante), `403 PASSWORD_CHANGE_REQUIRED`, `422 VALIDATION_ERROR` (parametri non validi, `cursor`/`format` per un cursore non valido).

### GET /v1/groups
- **Superficie:** backoffice
- **Autenticazione e permesso:** Bearer backoffice, `groups:read`
- **Ruoli:** PSA: tutti i gruppi; D: i propri gruppi, solo attivi e non nel cestino; SA: il proprio gruppo, solo se attivo e non nel cestino. CA e PA non hanno il permesso (`403 FORBIDDEN`).
- **Query:** parametri di lista; `status` (`active`, `suspended`); `trashed` (`true` per il cestino; default `false`, cestino escluso); `dealerId` (24 caratteri esadecimali: l'`id` dell'utente `D` del dealer); `demo` (`true` per i soli gruppi demo, `false` per gli altri). I filtri `status`, `dealerId` e `trashed=true` sono riservati al PSA: un altro ruolo che li usa riceve `403 FORBIDDEN`; `demo` è aperto a tutti i ruoli.
- **Risposta:** `200`
  ```json
  {
    "data": [
      { "id": "665f1c2e9b1d4a0012ab34a1", "name": "Gruppo Esempio", "status": "active", "trashed": false, "dealerId": "665f1c2e9b1d4a0012ab34d1", "demo": false,
        "counts": { "companies": { "active": 2, "trashed": 1 }, "places": { "active": 5, "trashed": 0 }, "users": { "active": 12, "trashed": 3 } } }
    ],
    "page": { "limit": 50, "next": null }
  }
  ```
  `status` è `active` o `suspended`; `dealerId` è `null` se il gruppo non ha dealer; `demo` è `false` se non è un gruppo demo. `counts` riporta, per aziende, punti vendita e utenti del gruppo, gli elementi attivi (`active`: `trash` diverso da `true`) e quelli nel cestino (`trashed`: `trash: true`); lo `status` dell'utente non conta. Aziende e punti vendita sono contati sulle copie del database comune, gli utenti sugli utenti con quel `groupId`; un gruppo vuoto ha tutti zeri. I conteggi sono calcolati solo per i gruppi della pagina restituita (quindi dentro il perimetro del chiamante) con tre aggregazioni per richiesta; non sono presenti in `GET /v1/groups/{groupId}`.
- **Errori:** comuni; `403 FORBIDDEN` anche per i filtri riservati
- **Cache:** `ETag` e `304` con `If-None-Match` (vedi "Liste")

### GET /v1/groups/{groupId}/companies
La lista compatta delle aziende (che alimenta i selettori e lo store dei dati di riferimento del backoffice) è descritta in "Aziende", con gli stessi campi `id`, `name` e `trashed` più quelli aggiunti dal passo 6A.

### GET /v1/countries
- **Autenticazione e permesso:** Bearer backoffice, qualunque utente autenticato (permesso `profile:read`, che tutti hanno)
- **Risposta:** `200` con `{ "data": [ { "code": "IT", "name": "Italia", "areas": [ { "code": "MI", "name": "Milano" } ] } ], "page": { "limit": <numero di elementi>, "next": null } }`, ordinati per nome (poi per codice), con `ETag` debole e `304` a un `If-None-Match` corrispondente (`Cache-Control: no-store`). Letti dalla collection `countries` (al più 400): un documento senza codice alpha-2 valido è escluso, un nome mancante vale il codice, `areas` che non è un elenco (per esempio `'none'`) vale `[]`, un'area senza codice è esclusa e il suo nome mancante vale il codice. Gli stessi codici sono quelli accettati da `address.country` e `address.province` delle aziende.
- **Errori:** comuni

### Gestione stati: GET /v1/countries/{countryCode} e scritture (passo 9-ter/1)
Paesi e province (`areas`) della collection `countries`, letti anche dal POS: forma identica al legacy (`{ code, name, areas: [{ code, name }] }`). `GET /v1/countries` (sopra) resta invariata per ogni utente autenticato. **Le scritture sono solo del PSA** (`countries:manage`, solo nel suo tetto): D, SA, CA, PA ricevono `403 FORBIDDEN`, la chiave di negozio `403`, nessuna route esiste su `/public/v1`. Le scritture hanno un rate limit per utente (`RATE_LIMIT_COUNTRIES_ADMIN_PER_USER`, 30 al minuto, `429`). **Codici:** 2 lettere A–Z, rese maiuscole e senza spazi prima del controllo (`it ` vale `IT`; anche nel percorso); **mai modificabili**. **Nome:** 1–100 caratteri, senza spazi ai bordi né caratteri di controllo (C0 e C1), separatori di riga e paragrafo, controlli bidirezionali, caratteri a larghezza zero o BOM (`format`). Ogni risposta che porta un paese ha l'`ETag` **forte** della sua versione (HMAC di `code`, `name` e `areas`); ogni modifica o eliminazione vuole `If-Match` con quella versione: header mancante o non un tag forte `422` (`If-Match`, `required` o `format`), versione non più corrente `412 PRECONDITION_FAILED`. Errori comuni: `401`, `403`, `404 NOT_FOUND` (paese o provincia inesistente), `422`, `429`.

- **`GET /v1/countries/{countryCode}`** (`profile:read`): `200` con `{ "data": { "code", "name", "areas": [...] } }` e `ETag` forte; `404` se il paese non esiste; `422` se il codice non è di due lettere.
- **`POST /v1/countries`**, corpo `{ code, name }`: `201` con il paese (`areas: []`), `Location: /v1/countries/{code}` e `ETag`. `409 CONFLICT` con `details: [{ "field": "code", "issue": "taken" }]` se il codice esiste. Chiavi diverse da `code` e `name`: `422` `unknown`.
- **`PATCH /v1/countries/{countryCode}`**, `If-Match`, corpo `{ name }`: `200` con il paese e il nuovo `ETag`. Un `code` nel corpo è `422` con `issue: immutable`. Lo stesso nome non scrive nulla.
- **`DELETE /v1/countries/{countryCode}`**, `If-Match`: `204` senza corpo. `409 CONFLICT` quando un'azienda o un punto vendita (copie del common, cestinati compresi) ha quel `countryCode`: un dettaglio per ogni elemento che lo usa, `{ "field": "companies.<id>" | "places.<id>", "issue": "inUse" }`, al più **20 per tipo**: con 20 dettagli di un tipo un client non distingue «esattamente 20» da «di più». Se la verifica dell'uso supera il tempo limite la risposta è `503 SERVICE_UNAVAILABLE` e non si cancella nulla. Una modifica del paese fatta tra la lettura e la cancellazione (per esempio una provincia aggiunta) dà `412`; il paese resta. I contatti dei gruppi non si controllano.
- **`POST /v1/countries/{countryCode}/areas`**, `If-Match`, corpo `{ code, name }`: `201` con il paese aggiornato, `Location: /v1/countries/{countryCode}/areas/{code}` e il nuovo `ETag`. `409` `code`/`taken` se il paese ha già quella provincia. L'inserimento è atomico: due richieste che aggiungono province diverse sopravvivono entrambe (la seconda può comunque ricevere `412` se è arrivata con la versione vecchia dopo la prima).
- **`PATCH /v1/countries/{countryCode}/areas/{areaCode}`**, `If-Match`, corpo `{ name }`: `200` con il paese aggiornato. `code` nel corpo `422` `immutable`.
- **`DELETE /v1/countries/{countryCode}/areas/{areaCode}`**, `If-Match`: `200` con il paese aggiornato. `409` `inUse` (stesso formato) quando un'azienda o un punto vendita ha quel `countryCode` **e** quel `countryAreaCode`.
- **Registro attività:** `country.created|updated|deleted`, `countryArea.created|updated|deleted` (metadati `countryCode`, `areaCode`; risorsa `countryArea` con id `<paese>-<provincia>`, per esempio `IT-MI`).

### GET /v1/groups/{groupId}/places
La lista dei punti vendita (che alimenta i selettori e lo store dei dati di riferimento del backoffice) è descritta in "Punti vendita", con gli stessi campi `id`, `name`, `companyId` e `trashed` più quelli aggiunti dal passo 7A (stessa route, stesso percorso).

## Aziende (`/v1`)

L'azienda (`companies` del gruppo) è gestita **per intero**: oltre ai dati anagrafici, la fatturazione elettronica, la numerazione delle fatture, le banche, i buoni pasto, le impostazioni dell'app clienti e i media, con gli stessi tipi BSON che scrive il backoffice legacy (stringhe `''` in `fattura_elettronica`, array sempre presenti, interi Int32 o `null`, nessuna chiave sconosciuta rimossa). Le scritture passano dal servizio di scrittura (transazione sul database del gruppo e sulla copia del common, versione per `If-Match`). Tutte le route sono **route di gruppo**: `groupId` è verificato rispetto al perimetro **prima** del permesso (id malformato, inesistente o fuori perimetro: `404 NOT_FOUND`). Un'azienda inesistente, di un altro gruppo o fuori dal perimetro (un CA raggiunge solo la propria) è lo stesso `404`. Errori comuni: `401 UNAUTHENTICATED` / `TOKEN_EXPIRED`, `403 FORBIDDEN` (permesso mancante; il PA non ha permessi sulle aziende), `403 PASSWORD_CHANGE_REQUIRED`, `404 NOT_FOUND`, `413 PAYLOAD_TOO_LARGE` (body oltre 64 KB), `415`, `422 VALIDATION_ERROR` (per campo; `unknown` per le proprietà non previste, `forbiddenKey` per gli operatori).

**Permessi per ruolo.** PSA, D e SA leggono, creano, modificano, mettono nel cestino ed eliminano nel proprio perimetro (la matrice dell'utente restringe il SA); il CA legge e modifica **tutte le schede della propria azienda** ma non crea né cestina (`403`); il PA non ha permessi. L'eliminazione dal cestino ha il permesso `companies:delete` (stessi ruoli e tetti di `companies:trash`: PSA, D e SA, mai CA e PA; è derivato dal modulo `companies` della matrice come `users:delete` da `users`). **`hub`, `transmitter` (paese e codice), `status`, `expirationDate` e `invoiceNumbering.cervedLookup`** possono essere modificati solo da PSA e D: per SA e CA un valore **diverso** da quello attuale dà `403 FORBIDDEN` con `details: [{ "field": "eInvoicing.hub", "issue": "notAllowed" }, …]`, mentre rimandare il valore attuale è accettato (così il salvataggio unico può rinviare l'intero oggetto). Alla **creazione** il confronto è con i default (`status` `active`, `expirationDate`, `hub`, `transmitter.country` e `transmitter.code` `null`/`''`, `cervedLookup` `false`): inviare il default è accettato, un valore diverso dà lo stesso `403` per i ruoli non ammessi.

**Hub.** Valori ammessi: `null` (o `''`: nessuno), `aruba`, `aruba__<id esadecimale di un utente D attivo e non nel cestino>`. Il PSA sceglie qualsiasi valore ammesso; il D solo nessuno, `aruba` o `aruba__<proprio id>` (l'hub di un altro dealer è `403 notAllowed`); un valore attuale di un altro dealer resta invariato se il D non lo cambia. Un valore sconosciuto (forma errata, utente che non è un dealer, dealer nel cestino) è `422` con `issue: "incorrect"`. Nessuna verifica Aruba lato server.

**Rappresentazione** (la restituiscono `GET`, `POST`, `PATCH`, le `PUT` e `trash`/`restore`; i campi che il documento non ha o ha di tipo sbagliato sono `null`, `false`, `0` o `[]`, mai un `500`; le chiavi sconosciute del documento non sono mai restituite):
```json
{
  "data": {
    "id": "665f1c2e9b1d4a0012ab34b2", "groupId": "665f1c2e9b1d4a0012ab34a1",
    "name": "Azienda Esempio Srl", "vatNumber": "01114601006", "fiscalCode": null,
    "address": { "street": "Via Roma 1", "postcode": "20100", "city": "Milano", "province": "MI", "country": "IT" },
    "currency": "EUR", "email": "info@esempio.it", "phone": "+39 02 1234567",
    "status": "active", "trashed": false, "expirationDate": null,
    "createdAt": "2026-01-15T10:00:00.000Z", "updatedAt": "2026-11-13T09:30:00.000Z",
    "eInvoicing": {
      "hub": "aruba", "transmitter": { "country": "IT", "code": "01879020517" }, "eori": null, "pec": "pec@esempio.it", "recipientCode": "ABC1234",
      "professionalRegister": { "name": null, "number": null, "province": null, "date": null },
      "rea": { "office": "MI", "number": "123456", "shareCapital": "10000.50", "shareholders": "SU", "liquidation": "LN" },
      "taxRegime": "RF01"
    },
    "invoiceNumbering": { "position": "prefix", "values": [{ "name": "FE", "cash": true }], "lastInvoiceNumber": 120, "discountLines": true, "cervedLookup": false },
    "bankAccounts": [{ "id": "6a1b…", "name": "Banca", "iban": "IT60X0542811101000000123456", "abi": "05428", "cab": "11101", "bic": null, "default": true }],
    "mealVoucherIssuers": [{ "id": "6a1c…", "name": "Buoni Pasto", "cuts": [5, 10, null] }],
    "customerApp": {
      "enableLoginSignup": true, "showPrivacyPage": true, "showTermsPage": false,
      "ecommerce": { "status": true, "priceListId": "665f…", "minimumOrder": { "EUR": 25.5 }, "showProductRemainingQuantity": 3, "showProductAvailability": false, "…": "i 23 flag booleani di settings.ecommerce con i nomi del legacy (acceptOrderOutOfStock … enableFidelity)" }
    },
    "media": { "internalFileName": "", "externalUrl": "", "customersAppLogoLight": { "_id": "f00d", "basename": "logo.png", "extension": "png", "filename": "logo", "mimetype": "image/png", "title": null, "alt": null, "dirname": "/media/image", "type": "image", "filectime": 1700000000000 }, "customersAppLogoDark": null }
  }
}
```
Mapping dei nomi: `vatNumber` = `code`, `fiscalCode` = `code2` (`''` e `null` si leggono `null`), `address.street/postcode/city/province/country` = `address/postcode/city/countryAreaCode/countryCode`, `currency` = `currencyCode`, `phone` = `telephone`, `status` = `active`/`disabled` dal booleano, `trashed` = `trash`, `eInvoicing` = `fattura_elettronica` (16 chiavi stringa; `''` si legge `null`, `null` si scrive `''`), `invoiceNumbering.position/values` = `invoicesPS`/`invoicesPSValues`, `invoiceNumbering.lastInvoiceNumber/discountLines` = `settings.global.*`, `invoiceNumbering.cervedLookup` = `settings.api.cerved`, `bankAccounts` = `banks` (`abi`, `cab`, `bic` `''` → `null`), `mealVoucherIssuers` = `ticketsSuppliers`, `customerApp` = `settings.global.{enableLoginSignup,showPrivacyPage,showTermsPage}` e `settings.ecommerce` (`priceListId` = `listId`, `minimumOrder` = `minAmount`, riletto come `{ "<valuta>": numero }` e scritto come `{ code, value }`), `media` = `medias.images`.

### GET /v1/groups/{groupId}/companies
- **Autenticazione e permesso:** Bearer backoffice, `companies:read`
- **Ruoli:** PSA, D e SA nel proprio perimetro, CA le proprie aziende; il PA non ha `companies:read` (`403`)
- **Query:** parametri di lista (`sort`: `name`, default, anche `-name`; `q` cerca nel nome e nella partita IVA); `trashed` (`true` per il cestino; default `false`); `ids` (da 1 a 100 id separati da virgola, duplicati e maiuscole ignorati: risolve le aziende già scelte, sempre nel perimetro); `status` (`active`, `disabled`); `country` (ISO alpha-2 maiuscolo); `province` (codice, 1–10 caratteri). Letta dalle copie nel database common.
- **Risposta:** `200`; `vatNumber`, `city`, `province` e `country` sono `null` se mancanti
  ```json
  { "data": [ { "id": "665f1c2e9b1d4a0012ab34b2", "name": "Azienda Esempio Srl", "vatNumber": "01114601006", "city": "Milano", "province": "MI", "country": "IT", "status": "active", "trashed": false } ], "page": { "limit": 50, "next": null } }
  ```
  `id`, `name` e `trashed` sono i campi che usa `ReferenceStore` del backoffice, invariati.
- **Errori:** comuni; `422` per parametri non validi
- **Cache:** `ETag` debole e `304` con `If-None-Match` (vedi "Liste")

### GET /v1/companies
- **Autenticazione e permesso:** Bearer backoffice, `companies:read` (rotta di piattaforma, senza gruppo nel percorso)
- **Ruoli:** **PSA** (tutti i gruppi, compresi quelli nel cestino e i demo) e **D** (i gruppi del suo perimetro, cioè i gruppi disponibili del dealer); ogni altro ruolo, e la chiave di negozio, `403 FORBIDDEN`. Il perimetro lo calcola sempre il server dal chiamante: `groupId` e `dealerId` lo possono solo restringere.
- **Query:** come l'elenco del gruppo (`limit`, `cursor`, `sort`: `name`, `-name`; `q` su nome e partita IVA; `trashed`, `status`, `country`, `province`), **senza `ids`**, con `limit` da 1 a **100** (default 50) e in più `groupId` (24 caratteri esadecimali; un gruppo fuori dal perimetro dà una lista **vuota**, non un errore) e `dealerId` (24 caratteri esadecimali, solo il PSA: un D riceve `403 FORBIDDEN`; restringe ai gruppi di quel dealer, in qualunque stato). Un parametro sconosciuto, un valore non valido o un parametro ripetuto è `422`. Le aziende nel cestino seguono `trashed` come nell'elenco del gruppo.
- **Risposta:** `200`; le stesse voci dell'elenco del gruppo, più `groupId` e `groupName` (il nome del gruppo, cercato solo per i gruppi della pagina; `""` se il gruppo non ha un nome, `null` se il gruppo non esiste). Ordine, cursore e `page` come nell'elenco del gruppo. Letta dalle copie nel database common, mai le credenziali.
  ```json
  { "data": [ { "id": "665f1c2e9b1d4a0012ab34b2", "name": "Azienda Esempio Srl", "vatNumber": "01114601006", "city": "Milano", "province": "MI", "country": "IT", "status": "active", "trashed": false, "trashedAt": null, "groupId": "665f1c2e9b1d4a0012ab3400", "groupName": "Gruppo Esempio" } ], "page": { "limit": 50, "next": null } }
  ```
- **Errori:** comuni; `403 FORBIDDEN`; `422` (`cursor`/`format` per un cursore non valido per l'ordinamento); `503 SERVICE_UNAVAILABLE` se la lettura supera il tempo massimo
- **Cache:** `ETag` debole e `304` con `If-None-Match` (vedi "Liste")
- **Dettaglio e scritture** restano sulle rotte del gruppo (`/v1/groups/{groupId}/companies/{companyId}`…). La lettura non è registrata nel log delle attività (come `GET /v1/users` e la diagnostica).

### POST /v1/groups/{groupId}/companies
- **Autenticazione e permesso:** Bearer backoffice, `companies:create`
- **Ruoli:** PSA, D e SA (CA e PA `403`); il gruppo viene dal percorso
- **Header:** `Idempotency-Key` obbligatorio (UUID; stesse regole dei punti vendita, vedi "Idempotenza" in "Punti vendita")
- **Body** (`application/json`, massimo 64 KB): `name` (1–150), `vatNumber` (1–30), `address` (`street` 1–150, `postcode` 1–20, `city` 1–100, `country` ISO alpha-2 maiuscolo **obbligatori**, `province` opzionale fino a 10) sono obbligatori; opzionali `fiscalCode`, `currency` (default `EUR`), `email`, `phone` (fino a 30), `status` (`active` default), `expirationDate` (data o istante ISO 8601, `null` di default: mai l'epoca del legacy) e i blocchi `eInvoicing`, `invoiceNumbering`, `bankAccounts`, `mealVoucherIssuers`, `customerApp`, `media` con i campi che si vogliono impostare (gli altri hanno i default del legacy: `fattura_elettronica` con le 16 chiavi `''` e `regime_fiscale` `RF01`, `settings` completo con le 27 chiavi `ecommerce`, `banks`, `ticketsSuppliers` e `invoicesPSValues` vuoti, `invoicesPS` `null`, `medias.images` con le quattro chiavi). Gli id di banche e fornitori non si inviano alla creazione (li genera il server: 24 caratteri esadecimali); un id inviato è `422 incorrect`.
  ```json
  { "name": "Azienda Esempio Srl", "vatNumber": "01114601006", "address": { "street": "Via Roma 1", "postcode": "20100", "city": "Milano", "province": "MI", "country": "IT" },
    "email": "info@esempio.it", "bankAccounts": [{ "name": "Banca", "iban": "IT60 X054 2811 1010 0000 0123 456", "default": true }] }
  ```
- **Validazione:** vedi "Regole di validazione delle aziende" più sotto.
- **Header particolari:** `Location: /v1/groups/{groupId}/companies/{companyId}` e `ETag`
- **Risposta:** `201` con l'azienda (rappresentazione completa)
- **Errori:** comuni; `403 FORBIDDEN` (CA, PA; SA con `notAllowed`); `409 CONFLICT` con `details: [{ "field": "vatNumber", "issue": "taken" }]` se un'altra azienda del gruppo non nel cestino ha la stessa partita IVA normalizzata (spazi tolti, maiuscole, prefisso `IT` davanti a 11 cifre); `422`

### GET /v1/groups/{groupId}/companies/{companyId}
- **Autenticazione e permesso:** Bearer backoffice, `companies:read`
- **Risposta:** `200` con l'azienda (anche nel cestino), `ETag` forte = versione del documento del **database del gruppo** (non della copia), cioè quella che `If-Match` si aspetta
- **Errori:** comuni; `404 NOT_FOUND` identico per azienda inesistente, di un altro gruppo o (CA) di un'altra azienda; `422` per `companyId` malformato

### PATCH /v1/groups/{groupId}/companies/{companyId}
Il **salvataggio unico**: qualsiasi sottoinsieme dei campi generali e dei blocchi.
- **Autenticazione e permesso:** Bearer backoffice, `companies:update`; **`If-Match` obbligatorio**
- **Body** (massimo 64 KB): gli stessi campi della creazione, tutti opzionali (`address` e i blocchi accettano un sottoinsieme dei propri campi, anche nei sotto-oggetti `transmitter`, `professionalRegister`, `rea`, `ecommerce`); gli array (`bankAccounts`, `mealVoucherIssuers`, `invoiceNumbering.values`) sono sostituiti **per intero**; un body vuoto è `422` (`(body)` `required`). Si scrivono solo i campi il cui valore **differisce** da quello memorizzato: rimandare l'intero oggetto ricevuto da `GET` non cambia nulla (e restituisce lo stesso `ETag`).
- **Id di banche e fornitori:** un id già presente nell'azienda si conserva, un elemento senza id ne riceve uno dal server, un id sconosciuto o ripetuto è `422 incorrect` (`bankAccounts.N.id`).
- **`minimumOrder`:** le chiavi sono valute del gruppo (altrimenti `422 incorrect`, salvo un valore invariato); le chiavi già presenti di altre valute si conservano intatte.
- **Logo:** `customersAppLogoLight`/`Dark` accettano `null` (rimozione), il descrittore che l'azienda ha già (restituito da `GET`, invariato) oppure **`{ "imageId": "<24 esadecimali>" }`**, l'id di un'immagine del gruppo caricata con `POST …/media/images` (vedi "Media"). Il server costruisce il descrittore dall'immagine memorizzata, come il Media Manager del legacy (la directory è sempre `/media/image`, mai quella del documento; `_id`, `dirname`, `basename`, `extension`, `filename`, `mimetype`, `filectime`, `mmThumb: {}`, `type`, `title`, `alt`); il **CA** può usare solo un'immagine che appartiene all'azienda di cui imposta il logo (`companyId` uguale), gli altri ruoli qualunque immagine del gruppo; un'immagine inesistente, nel cestino, di un altro gruppo, non utilizzabile dal chiamante o non utilizzabile come logo (nome del file non semplice, tipo che non è `image/*`, estensione non valida) è `422` con `issue: "incorrect"` sul campo del logo; un oggetto con `imageId` e altre chiavi è `422 unknown`; un altro descrittore è `422 notAllowed`. Vale anche per la creazione, per `PUT …/media` e per `PATCH`.
- **Risposta:** `200` con l'azienda aggiornata e il nuovo `ETag`
- **Errori:** comuni; `403` (`notAllowed`); `404`; `409 CONFLICT` (`vatNumber` `taken`; oppure un blocco del documento memorizzato che non è un oggetto, per esempio `settings: null`, con un messaggio: la scrittura fallisce e non cambia nulla); `412 PRECONDITION_FAILED` (versione cambiata, anche da una scrittura del legacy dopo la lettura); `422` (`If-Match` mancante o non valido, regole di validazione)
- Un blocco mancante o vuoto nel documento (`settings: {}`) viene completato con i default delle chiavi che la richiesta non imposta; ogni altra chiave sconosciuta del documento resta com'è. Ogni scrittura registra `company.updated` nel registro delle attività con i **nomi** dei campi o blocchi cambiati e mai i valori.

### GET /v1/groups/{groupId}/companies/e-invoicing-hubs
- **Autenticazione e permesso:** Bearer backoffice, `companies:update` (route di gruppo)
- **Risposta:** `200` con `{ "data": [ { "value": "aruba", "label": "Aruba" }, { "value": "aruba__<id del dealer>", "label": "<ragione sociale del dealer, altrimenti nome e cognome>" } ] }`: gli hub che il chiamante può impostare in `eInvoicing.hub`, con la **stessa** regola della scrittura. Il PSA riceve `aruba` e tutti i dealer attivi (utenti `D` abilitati e non nel cestino, al più 500, ordinati per etichetta); il D `aruba` e se stesso; il SA e il CA una lista vuota (non possono cambiare l'hub). Non è paginata.
- **Errori:** comuni; `403` (permesso); `404` (gruppo fuori perimetro)

### PUT /v1/groups/{groupId}/companies/{companyId}/e-invoicing
### PUT …/invoice-numbering
### PUT …/bank-accounts
### PUT …/meal-voucher-issuers
### PUT …/customer-app
### PUT …/media
Sostituiscono **un blocco intero**, con le stesse regole, gli stessi errori e la stessa risposta di `PATCH` (`If-Match` obbligatorio, `companies:update`). Il body è il blocco come lo restituisce `GET`, con **tutte** le chiavi obbligatorie (anche dei sotto-oggetti): `bank-accounts` e `meal-voucher-issuers` sono array (anche `[]`). Corrispondenze: `e-invoicing` → `eInvoicing`; `invoice-numbering` → `invoiceNumbering`; `bank-accounts` → `bankAccounts`; `meal-voucher-issuers` → `mealVoucherIssuers`; `customer-app` → `customerApp`; `media` → `media`. In `media` solo `internalFileName` (vuoto o un nome di file semplice, `^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$` senza `..`), `externalUrl` (vuoto o URL `http(s)` fino a 2048) e i logo a `null` o al descrittore attuale.
  ```json
  { "position": "suffix", "values": [{ "name": "FE", "cash": true }, { "name": "NC", "cash": false }], "lastInvoiceNumber": 120, "discountLines": false, "cervedLookup": false }
  ```

### POST /v1/groups/{groupId}/companies/{companyId}/trash
### POST /v1/groups/{groupId}/companies/{companyId}/restore
- **Autenticazione e permesso:** Bearer backoffice, `companies:trash`; **`If-Match` obbligatorio**; senza body
- **Ruoli:** PSA, D e SA (il CA `403`). Il ripristino ricontrolla la partita IVA: `409` con `details: [{ "field": "vatNumber", "issue": "taken" }]` se nel frattempo un'altra azienda attiva del gruppo l'ha presa. I punti vendita dell'azienda **mantengono il riferimento**.
- **Risposta:** `200` con l'azienda e il nuovo `ETag`
- **Errori:** comuni; `404`; `409 CONFLICT` se è già nel cestino (`trash`) o non lo è (`restore`); `412`; `422` (`If-Match`)

### DELETE /v1/groups/{groupId}/companies/{companyId}
- **Autenticazione e permesso:** Bearer backoffice, `companies:delete`; **`If-Match` obbligatorio**
- **Comportamento:** elimina per sempre un'azienda **dal cestino** (database del gruppo e copia, nella stessa transazione). Registra `company.deleted`.
- **Risposta:** `204` senza body
- **Errori:** comuni; `404`; `409 CONFLICT` se non è nel cestino, oppure con `details: [{ "field": "places", "issue": "referenced" }]` se un punto vendita del gruppo (anche nel cestino) ha ancora questa `companyId` (confrontata sia come ObjectId sia come stringa esadecimale); `412`; `422` (`If-Match`)

### Regole di validazione delle aziende
Rigorose in scrittura, tolleranti in lettura. Un campo si controlla quando **cambia** (o alla creazione): un'azienda con dati legacy che non rispettano una regola resta modificabile in ciò che la regola non tocca.
- **Paese e provincia:** `address.country` deve esistere nella collection `countries` (`incorrect`); `address.province` è `''` oppure uno dei codici delle aree del paese quando il paese le elenca (`incorrect`), altrimenti testo libero fino a 10 caratteri.
- **Partita IVA** (`vatNumber`): per `country` `IT` 11 cifre con la cifra di controllo, con prefisso `IT` facoltativo conservato come inviato; per gli altri paesi 2–30 caratteri **ASCII stampabili** (`format`; niente caratteri invisibili o spazi Unicode). Anche il codice fiscale non italiano è ASCII stampabile. **Codice fiscale** (`fiscalCode`): `null`/`''`, oppure per `IT` 11 cifre con controllo o 16 caratteri con il carattere di controllo (convertito in maiuscolo), per gli altri paesi fino a 30 caratteri (`format`). Cambiare il paese riverifica la partita IVA e il codice fiscale memorizzati.
- **Valuta:** tra le valute del gruppo (`incorrect`; se manca alla creazione vale `EUR`, e il gruppo deve averla: `required`). **Listino dell'e-commerce** (`priceListId`): `null` o un listino attivo del gruppo (`incorrect`).
- **`email`, `eInvoicing.pec`:** sintassi e-mail o `null`; `phone` fino a 30 caratteri o `null`.
- **`eInvoicing`:** `recipientCode` `null` o 6–7 caratteri alfanumerici (convertiti in maiuscolo); `taxRegime` `null`, `RF01`, `RF02`, `RF04`–`RF19`; `rea.office` e `professionalRegister.province` `null` o una sigla di provincia italiana; `rea.shareholders` `SU`/`SM`; `rea.liquidation` `LS`/`LN`; `rea.shareCapital` `null` o testo decimale con al più due decimali; `professionalRegister.date` `null` o `YYYY-MM-DD` esistente; `transmitter.country` `null` o ISO alpha-2; `''` equivale a `null`.
- **`invoiceNumbering`:** `values` fino a 50 elementi con `name` univoco di 1–50 caratteri e al più uno con `cash: true` (`incorrect` sul campo dell'elemento ripetuto); `lastInvoiceNumber` `null` o intero da 0 a 2147483647 (scritto come Int32).
- **`bankAccounts`:** fino a 20; `iban` obbligatorio, normalizzato (spazi tolti, maiuscolo) con il checksum ISO 13616 (`format`); `abi` e `cab` `null`/`''` o 5 cifre; `bic` `null`/`''` o 8/11 caratteri; `name` fino a 100; al più un `default` true. **L'IBAN è restituito a chi legge l'azienda e non compare mai nei log né nel registro delle attività.**
- **`mealVoucherIssuers`:** fino a 50; `name` 1–100; `cuts` fino a 50 numeri ≥ 0 o `null` (importo libero).
- **`customerApp.ecommerce`:** l'insieme esatto delle chiavi (27 con `priceListId` e `minimumOrder`), booleani e numeri ≥ 0; `minimumOrder` ha al più 10 valute (codici di 3 lettere maiuscole).
- I numeri interi nell'intervallo Int32 sono scritti come Int32, gli altri come Double (come il legacy).

## Punti vendita (`/v1`)

Passo 7A: il punto vendita (`places` del gruppo) con le schede **Generale**, **Licenza** e **Orari**, la lista, la creazione, il cestino, l'eliminazione e la duplicazione. Le schede delle impostazioni (cassa, stampe, pagamenti, sale, prenotazioni, asporto, self ordering, kiosk, appuntamenti, display, fidelity, tabacchi, media: passo 7B, vedi "Impostazioni del punto vendita") sono nella stessa rappresentazione; la chiave di negozio (passo 7C) arriva dopo. Come per le aziende, le scritture passano dal servizio di scrittura (transazione sul database del gruppo e sulla copia del common, `groups.places` ricalcolato, `reserve_with_google`), con gli stessi tipi BSON che scrive il vecchio backoffice (`prepareData`); tutto ciò che il backend non possiede (le chiavi che il POS scrive dentro un elemento di una lista, `info` e `status` di un dispositivo, `view.subtables` di una sala, e ogni chiave sconosciuta o storica) **non viene mai restituito né toccato**. Dal passo 7F il dettaglio comprende anche dispositivi, postazioni comanda, sale, depositi, integrazioni (credenziali **mai restituite**: solo i flag `…Set`) e impostazioni rivenditore (solo PSA e D). Tutte le route sono **route di gruppo** (`groupId` verificato rispetto al perimetro prima del permesso). Un punto vendita inesistente, di un altro gruppo o fuori dal perimetro (un CA raggiunge i punti vendita delle proprie aziende, un PA il proprio) è lo stesso `404`. Errori comuni: `401 UNAUTHENTICATED` / `TOKEN_EXPIRED`, `403 FORBIDDEN`, `403 PASSWORD_CHANGE_REQUIRED`, `404 NOT_FOUND`, `413 PAYLOAD_TOO_LARGE` (body oltre 256 KB), `415`, `422 VALIDATION_ERROR` (per campo; `unknown` per le proprietà non previste, `forbiddenKey` per gli operatori).

**Permessi per ruolo.** Solo **PSA e D creano e duplicano** i punti vendita (`places:create` è nel loro tetto soltanto: il SA non li crea, `403`). PSA, D e SA leggono, modificano, mettono nel cestino ed eliminano nel proprio perimetro (la matrice dell'utente restringe il SA); il CA e il PA leggono e modificano (tutte le schede del punto vendita, il CA quelli delle proprie aziende, il PA il proprio) ma non creano né cestinano né eliminano (`403`). `places:trash` e il nuovo `places:delete` sono nel tetto di PSA, D e SA soltanto. Un utente con la matrice legacy `places.w` ottiene solo i permessi del tetto del proprio ruolo.

**Idempotenza.** `POST …/places` e `POST …/places/{placeId}/duplicate` (come `POST …/companies`) richiedono l'header **`Idempotency-Key`** con un UUID: senza è `422` (`field: "Idempotency-Key"`, `issue: "required"`), non valido `422` `format`. La stessa chiave con lo stesso body dà **la stessa risposta salvata** (stato, body, `Location`, `ETag`) e non crea nulla; la stessa chiave con un body diverso dà `409` (`issue: "reused"`); mentre la prima richiesta è ancora in corso una seconda con la stessa chiave dà `409`. Le chiavi sono per utente e per route (percorso compreso) e durano 24 ore; una richiesta che fallisce libera la chiave, così si può rinviare. La risposta salvata è quella già priva di credenziali.

**Campi riservati.** `license.plan` e `license.sentry`: solo PSA; **alla creazione il piano lo sceglie anche il D, ma solo tra `basic`, `advanced`, `enterprice` e `tgm-secondary`**: `desk-secondary` è del solo PSA, anche alla creazione (`403 notAllowed` per il D). `license.expirationDate` e `license.status`: PSA e D. Per i ruoli non ammessi un valore **diverso** da quello attuale dà `403 FORBIDDEN` con `details: [{ "field": "license.plan", "issue": "notAllowed" }, …]`; rimandare il valore attuale è accettato (così il salvataggio unico può rinviare l'intero oggetto). Alla creazione il confronto è con i default (`plan` `basic`, `expirationDate` `null`, `status` `active`, `sentry` `false`). Un piano storico (`professional`, `''`) resta finché un PSA non lo cambia, e si può rimandare invariato.

**Rappresentazione** (la restituiscono `GET`, `POST`, `PATCH`, le `PUT`, `trash`, `restore` e `duplicate`; oltre ai campi qui sotto ci sono i tredici blocchi delle impostazioni del passo 7B, descritti più avanti; i campi che il documento non ha o ha di tipo sbagliato sono `null`, `false` o `[]`, mai un `500`, nemmeno sui `null` che il legacy lascia sull'indirizzo di un punto vendita cestinato):
```json
{
  "data": {
    "id": "665f1c2e9b1d4a0012ab34b3", "groupId": "665f1c2e9b1d4a0012ab34a1",
    "name": "Bar Roma", "companyId": "665f1c2e9b1d4a0012ab34b2",
    "address": { "street": "Via Roma 1", "postcode": "20100", "city": "Milano", "province": "MI", "country": "IT" },
    "contactName": "Mario Rossi", "email": "bar@esempio.it", "phone": "+39 02 1234567",
    "priceListId": "665f…", "ecommercePriceListId": null, "invoiceSeries": "FE",
    "priceLists": [{ "id": "665f…", "allYouCanEat": true, "ayceCode1": "12", "ayceCode2": null }],
    "trashed": false, "createdAt": "2026-01-15T10:00:00.000Z", "updatedAt": "2026-11-13T09:30:00.000Z",
    "license": { "plan": "advanced", "expirationDate": "2030-01-01T00:00:00.000Z", "status": "active", "sentry": false },
    "openingHours": {
      "timezone": "Europe/Rome",
      "week": { "0": { "active": false, "values": [] }, "1": { "active": true, "values": [{ "start": "09:00", "end": "18:00" }] }, "2": "…", "3": "…", "4": "…", "5": "…", "6": "…" },
      "special": { "2026-12-25": { "closed": true, "values": [] } },
      "deliveryTime": { "week": { "0": "…", "…": "…" }, "special": {} }
    }
  }
}
```
Mapping dei nomi: `address.street/postcode/city/province/country` = `address/postcode/city/countryAreaCode/countryCode`, `contactName` = `contact`, `phone` = `telephone`, `priceListId` = `listId`, `ecommercePriceListId` = `ecommerceListId`, `invoiceSeries` = `invoicePS` (il nome di una serie dell'azienda, `null`, oppure `false` dove il legacy lo ha memorizzato così: un valore che si può rimandare invariato ma non impostare), `priceLists` = `general.priceLists`, `trashed` = `trash`, `license.plan/expirationDate/status/sentry` = `plan/expirationDate/status/platform.sentry` (`plan` è il valore memorizzato così com'è, anche storico; `status` `active`/`disabled` dal booleano), `openingHours.timezone` = `timezone`, `week` = `openingTime.weekGeneric` (sempre le sette chiavi `0` = domenica … `6`, ciascuna `{ active, values: [{ start, end }] }` con orari `HH:mm`), `special` = `openingTime.daySpecial` (solo le chiavi `YYYY-MM-DD`, `{ closed, values }`), `deliveryTime` = `delivery.time` (stessa forma).

### GET /v1/groups/{groupId}/places
- **Autenticazione e permesso:** Bearer backoffice, `places:read`
- **Ruoli:** PSA, D e SA nel proprio perimetro, CA i punti vendita delle proprie aziende, PA il proprio
- **Query:** parametri di lista (`sort`: `name`, default, `-name`, `expirationDate`, `-expirationDate`; l'ordinamento è applicato **prima** della paginazione, con l'id come spareggio stabile; senza data i punti vendita vengono per primi in ordine crescente e per ultimi in ordine decrescente; `q` cerca nel nome e nella città, come testo letterale senza distinguere le maiuscole); `trashed` (`true` per il cestino; default `false`); `companyId`; `ids` (da 1 a 100 id separati da virgola, duplicati e maiuscole ignorati: risolve i punti vendita già scelti, sempre nel perimetro; un id fuori perimetro non è restituito); `status` (`active`, `disabled`); `plan` (il piano memorizzato, `^[A-Za-z0-9_-]{1,30}$`); `country` (ISO alpha-2 maiuscolo); `province` (1–10 caratteri). Un'azienda fuori dal perimetro del chiamante non dà errore: la lista è **vuota**. Letta dalle copie nel database common.
- **Risposta:** `200`; `companyId`, `plan`, `city`, `province`, `country` ed `expirationDate` sono `null` se mancanti o di tipo sbagliato
  ```json
  { "data": [ { "id": "665f1c2e9b1d4a0012ab34b3", "name": "Bar Roma", "companyId": "665f1c2e9b1d4a0012ab34b2", "trashed": false, "plan": "advanced", "status": "active", "city": "Milano", "province": "MI", "country": "IT", "expirationDate": "2030-01-01T00:00:00.000Z" } ], "page": { "limit": 50, "next": null } }
  ```
  `id`, `name`, `companyId` e `trashed` sono i campi che usa `ReferenceStore` del backoffice, invariati.
- **Errori:** comuni; `404 NOT_FOUND` (gruppo); `422` per parametri non validi (`cursor`/`format` per un cursore non valido per l'ordinamento)
- **Cache:** `ETag` debole e `304` con `If-None-Match` (vedi "Liste")

### GET /v1/places
- **Autenticazione e permesso:** Bearer backoffice, `places:read` (rotta di piattaforma, senza gruppo nel percorso)
- **Ruoli:** **PSA** (tutti i gruppi, compresi quelli nel cestino e i demo) e **D** (i gruppi del suo perimetro); ogni altro ruolo, e la chiave di negozio, `403 FORBIDDEN`. Il perimetro lo calcola sempre il server: `groupId` e `dealerId` lo possono solo restringere.
- **Query:** come l'elenco del gruppo (`limit`, `cursor`, `sort`: `name`, `-name`, `expirationDate`, `-expirationDate`; `q` su nome e città; `trashed`, `companyId`, `status`, `plan`, `country`, `province`), **senza `ids`**, con `limit` da 1 a **100** (default 50) e in più `groupId` e `dealerId` (solo il PSA; un D riceve `403 FORBIDDEN`), con le stesse regole di `GET /v1/companies`. Un `groupId` o un `companyId` fuori dal perimetro dà una lista **vuota**. Un parametro sconosciuto o non valido è `422`.
- **Risposta:** `200`; le stesse voci dell'elenco del gruppo, più `groupId` e `groupName` (come `GET /v1/companies`). Il nome dell'azienda non c'è (come nell'elenco del gruppo). Letta dalle copie nel database common, mai le integrazioni, i dispositivi o altre credenziali.
  ```json
  { "data": [ { "id": "665f1c2e9b1d4a0012ab34b3", "name": "Bar Roma", "companyId": "665f1c2e9b1d4a0012ab34b2", "trashed": false, "trashedAt": null, "plan": "advanced", "status": "active", "city": "Milano", "province": "MI", "country": "IT", "expirationDate": "2030-01-01T00:00:00.000Z", "groupId": "665f1c2e9b1d4a0012ab3400", "groupName": "Gruppo Esempio" } ], "page": { "limit": 50, "next": null } }
  ```
- **Errori:** comuni; `403 FORBIDDEN`; `422`; `503 SERVICE_UNAVAILABLE`
- **Cache:** `ETag` debole e `304` con `If-None-Match` (vedi "Liste")
- **Dettaglio e scritture** restano sulle rotte del gruppo (`/v1/groups/{groupId}/places/{placeId}`…).

### POST /v1/groups/{groupId}/places
- **Autenticazione e permesso:** Bearer backoffice, `places:create`
- **Ruoli:** PSA e D (SA, CA e PA `403`); il gruppo viene dal percorso
- **Header:** `Idempotency-Key` obbligatorio (vedi "Idempotenza")
- **Body** (`application/json`, massimo 256 KB): `name` (1–150), `companyId` (24 esadecimali: un'azienda **del gruppo**, non nel cestino e nel perimetro del chiamante) e `address` (`street` 1–150, `postcode` 1–20, `city` 1–100, `country` ISO alpha-2 maiuscolo **obbligatori**, `province` opzionale fino a 10) sono obbligatori; opzionali `contactName` (fino a 100), `email`, `phone` (fino a 30), `priceListId`, `ecommercePriceListId`, `invoiceSeries`, `priceLists` (fino a 50 elementi `{ id, allYouCanEat?, ayceCode1?, ayceCode2? }` con id univoci), `license` (`plan`, `expirationDate`, `status`), `dealerSettings` (`sentry`, `serverIp`, `connectorAddress`), `integrations` e `openingHours` (`timezone`, `week`, `special`, `deliveryTime`) con i campi che si vogliono impostare. **Il documento creato è il punto vendita completo nella forma che salva il vecchio backoffice**, con tutti i blocchi e i loro default (impostazioni di cassa, stampe, pagamenti, sale e prenotazioni, asporto e consegna, self ordering, kiosk con `mode` `sale`, appuntamenti, display, fidelity, tabacchi, media, `integrations.*` con tutti gli interruttori spenti e nessuna credenziale, `platform: { sentry }`, `server: { ip: null }`), `plan` `basic`, `timezone` `Europe/Rome`, le due settimane (orari e consegna) di sette giorni chiusi, **un deposito** `{ id, name: "Deposito 1", cash: true, ecommerce: false }`, `status` `active`, `expirationDate` `null` (mai l'epoca del legacy). Il listino delle vendite scelto è sempre tra i listini del punto vendita (`priceLists`), come fa il vecchio backoffice.
  ```json
  { "name": "Bar Roma", "companyId": "665f1c2e9b1d4a0012ab34b2", "address": { "street": "Via Roma 1", "postcode": "20100", "city": "Milano", "province": "MI", "country": "IT" },
    "priceListId": "665f…", "license": { "plan": "advanced", "expirationDate": "2030-01-01" } }
  ```
- **Header particolari:** `Location: /v1/groups/{groupId}/places/{placeId}` e `ETag`
- **Risposta:** `201` con il punto vendita (rappresentazione completa)
- **Errori:** comuni; `403 FORBIDDEN` (SA, CA, PA; D con `notAllowed` sui campi riservati); `409` (chiave riusata con un altro body o richiesta con la stessa chiave in corso); `422` (`Idempotency-Key` mancante o non valido, regole di validazione più sotto; `companyId` `incorrect` se l'azienda non è del gruppo, è nel cestino, non esiste o è fuori dal perimetro)

### GET /v1/groups/{groupId}/places/{placeId}
- **Autenticazione e permesso:** Bearer backoffice, `places:read`. Una **chiave di negozio** riceve `403 FORBIDDEN` (per il server di negozio il punto vendita si legge solo da `GET /v1/store-context/place`, con le credenziali in chiaro).
- **Risposta:** `200` con il punto vendita (anche nel cestino), `ETag` forte = versione del documento del **database del gruppo** (non della copia), cioè quella che `If-Match` si aspetta. **Non restituisce mai una credenziale** (le credenziali di integrazioni e dispositivi sono solo scrivibili: la risposta ha `<chiave>Set: true|false`), né le chiavi che scrive il POS negli elementi. `dealerSettings` (indirizzo del server di negozio e del Connector, Sentry) è nella risposta **solo per PSA e D**; il negozio lo riceve da `GET /v1/store-context/place`, non da questa route.
- **Errori:** comuni; `404 NOT_FOUND` identico per punto vendita inesistente, di un altro gruppo o fuori dal perimetro; `422` per `placeId` malformato

### PATCH /v1/groups/{groupId}/places/{placeId}
Il **salvataggio unico** delle schede Generale, Licenza e Orari: qualsiasi sottoinsieme dei campi e dei blocchi.
- **Autenticazione e permesso:** Bearer backoffice, `places:update`; **`If-Match` obbligatorio**
- **Body** (massimo **1 MB**, per le sale con i tavoli): gli stessi campi della creazione più i blocchi di lista (`devices`, `printStations`, `rooms`, `storages`), tutti opzionali (`address`, `license` e `openingHours` accettano un sottoinsieme dei propri campi, anche `deliveryTime`); gli elenchi e le settimane (`priceLists`, `openingHours.week`, `openingHours.deliveryTime.week`) sono sostituiti **per intero**, i giorni speciali (`special`) si sostituiscono come mappa (le date non inviate vengono rimosse, le chiavi che non sono date restano); un body vuoto è `422` (`(body)` `required`). Si scrivono solo i campi il cui valore **differisce** da quello memorizzato: rimandare l'intero oggetto ricevuto da `GET` non cambia nulla (e restituisce lo stesso `ETag`). Ogni valore si scrive **per percorso puntato** (`general.priceLists`, `platform.sentry`, `openingTime.weekGeneric`…): le altre chiavi dei blocchi, anche scritte dal POS o dal legacy, restano com'erano; un blocco mancante o vuoto viene completato con i default delle chiavi che la richiesta non imposta.
- **Perimetro del cambio di azienda:** `companyId` può cambiare solo verso un'azienda dello stesso gruppo, non nel cestino e nel perimetro del chiamante (il CA solo tra le proprie aziende, il PA non può cambiarla): altrimenti `422 incorrect`.
- **Risposta:** `200` con il punto vendita aggiornato e il nuovo `ETag`
- **Errori:** comuni; `403` (`notAllowed`); `404`; `409 CONFLICT` (un blocco del documento memorizzato che non è un oggetto, per esempio `platform: "web"` quando si scrive `dealerSettings.sentry`: nulla viene scritto); `412 PRECONDITION_FAILED` (versione cambiata, anche da una scrittura del legacy a un campo posseduto dopo la lettura; una scrittura del POS a `devices[i].info` o `devices[i].status` o ad altre chiavi non possedute **non** cambia la versione; una a `rooms` (la riscrive intera) **sì**, come una a `suspendedToday`); `422` (`If-Match` mancante o non valido, regole di validazione)
- Ogni scrittura registra `place.updated` nel registro delle attività con i **nomi** dei campi o blocchi cambiati (`license`, `openingHours`, `address.city`, `priceLists`…) e mai i valori.

### PUT /v1/groups/{groupId}/places/{placeId}/license
### PUT …/opening-hours
Sostituiscono **un blocco intero**, con le stesse regole, gli stessi errori e la stessa risposta di `PATCH` (`If-Match` obbligatorio, `places:update`; per la licenza valgono i campi riservati). Il body è il blocco come lo restituisce `GET`, con **tutte** le chiavi obbligatorie: `license` → `{ plan, expirationDate, status }` (lo switch Sentry è passato a `dealerSettings`) (il piano è un testo: i valori ammessi si controllano solo se cambia); `opening-hours` → `{ timezone, week, special, deliveryTime: { week, special } }` (le settimane con tutti e sette i giorni).
  ```json
  { "plan": "advanced", "expirationDate": "2031-01-01", "status": "active" }
  ```

### POST /v1/groups/{groupId}/places/{placeId}/trash
### POST /v1/groups/{groupId}/places/{placeId}/restore
- **Autenticazione e permesso:** Bearer backoffice, `places:trash`; **`If-Match` obbligatorio**; senza body
- **Ruoli:** PSA, D e SA (CA e PA `403`). Il cestino **revoca la chiave di negozio** del punto vendita (motivo `placeTrashed`; il ripristino non la restituisce: serve una nuova attivazione) e mette `trash: true` e **non azzera l'indirizzo** (il difetto del legacy non si replica), toglie il punto vendita dal feed di Reserve with Google e ricalcola `groups.places`; il ripristino rimette il feed solo se l'integrazione è attiva e completa. Registrano `place.trashed` e `place.restored`.
- **Risposta:** `200` con il punto vendita e il nuovo `ETag`
- **Errori:** comuni; `404`; `409 CONFLICT` se è già nel cestino (`trash`) o non lo è (`restore`); `412`; `422` (`If-Match`)

### DELETE /v1/groups/{groupId}/places/{placeId}
- **Autenticazione e permesso:** Bearer backoffice, `places:delete` (stessi ruoli e tetti di `places:trash`: PSA, D e SA, mai CA e PA); **`If-Match` obbligatorio**
- **Comportamento:** elimina per sempre un punto vendita **dal cestino** (database del gruppo, copia, feed di Reserve with Google e `groups.places`, nella stessa transazione). Revoca anche l'eventuale chiave di negozio rimasta (`placeDeleted`). Registra `place.deleted`. Il controllo dei riferimenti riguarda solo gli utenti; restano altri riferimenti all'id che l'eliminazione non toglie: `tgm.placeId` dei punti vendita secondari, `placesIds` di promozioni e tipi di carta nel documento del gruppo, `storages[].id` nei movimenti di magazzino, vendite e documenti.
- **Risposta:** `204` senza body
- **Errori:** comuni; `404`; `409 CONFLICT` se non è nel cestino, oppure con `details: [{ "field": "users", "issue": "referenced" }]` se un utente del gruppo, anche nel cestino, ha ancora il punto vendita nel proprio perimetro (`placeId` o `placesId`); `412`; `422` (`If-Match`)

### POST /v1/groups/{groupId}/places/{placeId}/duplicate
- **Autenticazione e permesso:** Bearer backoffice, `places:create` (nel tetto di PSA e D soltanto: SA, CA e PA `403`); `Idempotency-Key` obbligatorio (vedi "Idempotenza"); senza body e senza `If-Match`
- **Comportamento:** replica **tutto** il punto vendita, "perché serve a riportare una situazione uguale": ogni chiave, i dispositivi, le sale, i depositi **con gli stessi id** (come il legacy), le integrazioni con le loro credenziali (copiate sul server, **mai restituite** né scritte nei log) e le chiavi che il backend non conosce. Cambiano solo `_id`, `insertDate` e `updateDate` (adesso), `trash: false`, `groupId` (quello verificato) e il nome, che è `<nome> (Copy)` come nel legacy. Nella stessa transazione: inserimento, copia nel common, feed di Reserve with Google (come l'`insertOne` del legacy, se l'integrazione è attiva e completa) e `groups.places`. **La chiave di negozio** (passo 7C) **non si copia mai**: va creata di nuovo per il nuovo punto vendita. Registra `place.duplicated` con l'id dell'origine nei metadati (`sourceId`). **Attenzione:** la copia condivide con l'origine le credenziali dei pagamenti (Stripe, Satispay, Dojo, Plateform…), quelle della cassa automatica e gli id di dispositivi e depositi, quindi pagamenti e movimenti possono confluire sugli stessi account e identificativi: dopo una duplicazione vanno riviste le integrazioni. Un D che duplica copia anche `platform.sentry` (che solo il PSA imposta) e un `plan` storico o `desk-secondary` dell'origine: è lo stato di un punto vendita del suo gruppo, non una scelta nuova.
- **Header particolari:** `Location: /v1/groups/{groupId}/places/{nuovo id}` e `ETag`
- **Risposta:** `201` con il nuovo punto vendita (rappresentazione completa, senza credenziali)
- **Errori:** comuni; `403`; `404`; `409 CONFLICT` se il punto vendita di origine è nel cestino, se la chiave è già usata con un'altra richiesta o ancora in corso, oppure con `details: [{ "field": "companyId", "issue": "incorrect" }]` se la sua azienda non esiste o è nel cestino

### GET /v1/groups/{groupId}/places/{placeId}/invoice-series
- **Autenticazione e permesso:** Bearer backoffice, `places:update` (PSA, D, SA, CA e PA); scope come il punto vendita (un punto vendita fuori dal perimetro del chiamante è `404`, come per il dettaglio)
- **Comportamento:** le serie di fatturazione (`invoicesPSValues`) dell'azienda **attuale** del punto vendita, per scegliere `invoiceSeries` nella scheda Generale. Il PA, che non ha `companies:read`, le legge comunque; non restituisce nient'altro dell'azienda.
- **Risposta:** `200`, `{ "data": [{ "name": "FE", "cash": true }, { "name": "NC", "cash": false }] }`, nell'ordine memorizzato, senza paginazione; `[]` se l'azienda non ha serie o non esiste; `cash` è `true` solo se il valore memorizzato lo è
- **Errori:** comuni; `403`; `404`; `422` (`placeId`)
- **Cache:** `ETag` e `304`

### Impostazioni del punto vendita (passo 7B)
Le schede delle impostazioni sono **tredici blocchi** della rappresentazione del punto vendita (`GET`), parte del `PATCH` unico e della creazione, e ciascuno ha la propria `PUT` che lo sostituisce per intero. Tutte le `PUT` richiedono `If-Match` e il permesso `places:update` (CA i punti vendita delle proprie aziende, PA il proprio), hanno le stesse regole, gli stessi errori e la stessa risposta del `PATCH` e registrano `place.updated` con i **nomi** dei blocchi cambiati (`cashSettings`, `printing`, `payments`, `tables`, `reservations`, `delivery`, `selfOrdering`, `kiosk`, `appointments`, `externalDisplay`, `fidelity`, `tobacco`, `media`), mai i valori. Le impostazioni non dipendono dalle feature del gruppo: il backend non rifiuta una scrittura perché una scheda è nascosta (lo fa il backoffice). Come per il resto: un campo si valida solo quando **cambia**, un blocco rimandato com'è non scrive nulla, e ogni chiave si scrive sul **proprio percorso** con i tipi BSON del vecchio backoffice (interi Int32 o `null`, numeri Int32 se interi e Double altrimenti, stringhe vuote dove le scrive il form): le chiavi sconosciute o storiche (`ordering.fontSize`, `ordering.sequentialNumber`, `payments.paymentDiscountAuto`…) restano e non sono mai restituite.

| Blocco | `PUT` | Chiavi legacy |
|---|---|---|
| `cashSettings` | `…/settings/cash` | `general.*` tranne `priceLists`, e `advancedReport.logs` (`advancedReportLogs`) |
| `printing` | `…/settings/printing` | `receipt`, `prebilling`, `ordering` (oggetti `printing.receipt`, `.prebilling`, `.ordering`) |
| `payments` | `…/settings/payments` | `payments` (`defaultType`, `cheque`, `tickets`, `paymentDiscount`) e `paymentTypes` (`payments.paymentTypes`) |
| `tables` | `…/settings/tables` | `roomsSettings.*` tranne `reservation` |
| `reservations` | `…/settings/reservations` | `roomsSettings.reservation.*`, **`suspendedToday` compreso** |
| `delivery` | `…/settings/delivery` | `deliveryTakeAway` (`delivery.takeAway`) e `delivery` tranne `time` (che è in `openingHours.deliveryTime`) |
| `selfOrdering` | `…/settings/self-ordering` | `selfOrdering` |
| `kiosk` | `…/settings/kiosk` | `kiosk` |
| `appointments` | `…/settings/appointments` | `appointment` |
| `externalDisplay` | `…/settings/external-display` | `externalDisplay` |
| `fidelity` | `…/settings/fidelity` | `fidelity` |
| `tobacco` | `…/settings/tobacco` | `tgm` |
| `media` | `…/media` | `medias.images.*` |

- **Forme.** I nomi dei campi sono quelli del legacy dentro il blocco. Interruttori booleani; testi `null` se vuoti (`value || null`); interi `null` o numeri; `font` `R-C` con R e C da 1 a 3; colori `#rrggbb`; orari `HH:mm` o `null`; enumerazioni chiuse (`ordering.productsSorting` `cart`/`alphabetical`/`position`, `cashSettings.localWarehouseOutOfStock` `disabled`/`enabled`/`alert`, `receiptsCancellation` `sync`/`notSync`/`null`, `payments.defaultType` `cash`/`electronic`, `delivery.takeAway.sendOrderOnSave*` `ask`/`never`/`always`, `kiosk.mode` `sale`/`catalog`, `kiosk.catalogLayout` `cols-4`/`cols-3`/`list`, i `*Placeholder` `none`/`optional`/`required`, `fidelity.type` `advanced`/`base`/`null`, `appointments.type` `single`/`multiple`, `reservations.webWidget.brightness` `light`/`dark`/`auto`). Un valore memorizzato fuori forma si legge come il default del form (mai un `500`). **La forma di orari `HH:mm`, font e colori si controlla solo quando il valore cambia** (`422` `pattern`, nel service): un valore storico rimandato invariato è accettato; lo schema fissa solo i limiti di lunghezza.
- **Elenchi e mappe, tutti con limiti** (al più 500 elementi, salvo i limiti indicati): `workshiftNames` (20 testi), `tables.tipValues` (20 `{ type: 'v'|'p', value }`), `tables.tableGroups` (`{ status, name, autoCreateFirst }`; la forma booleana storica si legge come `status`), `reservations.timeBlocks` (50 `{ weekDays: 0–6 univoci, start, end }`), `payments.paymentTypes` (50), `delivery.takeAway.shippingCosts` (50 `{ taxed, toKm }`), `delivery.minAmount` (valute di 3 lettere maiuscole, 10), `selfOrdering.priceListsConfig` (per listino, 50), `kiosk.productsCategories`, i cinque testi del kiosk per lingua (`{ it: '…' }`, 20 lingue di 2 lettere). Le mappe per valuta, lingua o listino rifiutano operatori, percorsi e chiavi di prototipo (`forbiddenKey`).
- **Chiavi copiate (deprecate).** Il server calcola, come il form, `roomsSettings.delivery`, `deliveryAutoOrderingTime` e `deliverySendPrebillingOnSave` (copie di `deliveryTakeAway`) e `roomsSettings.tableGroups` (oggetto intero con `mergeProductsPrint`, copia di `ordering.mergeProductsPrint`) e `tableGroupName`: si scrivono a ogni scrittura delle chiavi che copiano e non fanno parte di nessuna richiesta.
- **`payments.paymentTypes`.** Gli `id` sono stabili: un elemento con `id` deve essere uno di quelli del punto vendita (altrimenti `422 incorrect` su `payments.paymentTypes.N.id`, anche se ripetuto); un elemento senza `id` ne riceve uno dal server nella forma dell'`createId` del vecchio backoffice (7 caratteri base 36, un numero a 32 bit, il tempo in millisecondi). `electronicInvoiceMode` è `MP01`–`MP23` o `null` (`fattura_elettronica.ModalitaPagamento`).
- **Riferimenti, verificati dove cambiano:** i `templateId` (`reservations.*.templateId`, `appointments.email.templateId`) sono ObjectId di `email_templates` del gruppo (`incorrect`); `delivery.takeAway.deliveryListId`/`takeAwayListId`, `kiosk.listId` e le chiavi di `selfOrdering.priceListsConfig` sono listini **attivi** del gruppo; `delivery.minAmount` ha valute del gruppo (le altre valute già presenti restano); `kiosk.upsellingCategoryId`, `kiosk.productsCategories[]._id` e le categorie di `priceListsConfig` esistono in `products_categories` e non sono nel cestino; i testi del kiosk sono in lingue del gruppo (`settings.languages`, `it` se manca: le lingue già presenti restano e i testi inviati si fondono con quelli memorizzati); `tobacco.companyId` e `tobacco.placeId`: un valore invariato è sempre accettato; uno cambiato è un'azienda del gruppo non nel cestino e nel perimetro del chiamante (per il PA, che non ha aziende nello scope, quella del proprio punto vendita) e un punto vendita del gruppo **non nel cestino** e nel perimetro (per il PA, il proprio). Se la stessa richiesta cambia `companyId` e questo è rifiutato, le regole che dipendono dall'azienda (`tobacco.companyId`, immagini) usano l'azienda che il punto vendita ha, mai quella rifiutata. Il PA salva quindi tutte le schede del proprio punto vendita. Valori `incorrect` come per gli altri campi.
- **`selfOrdering.additionalInfo` e `additionalInfoLabel`:** nei 26 documenti in cui sono oggetti (forma multilingua storica) si leggono `null` e il valore memorizzato **resta com'è** finché il client non invia un testo.
- **`media`:** `internalFileName`, `internalFileNameLogo` (nome di file semplice o vuoto), `externalUrl`, `externalUrlLogo` (URL `http(s)` o vuoto) e i cinque spazi immagine `logoLight`, `coverLight`, `logoKiosk`, `coverKiosk`, `productPlaceholderKiosk`: `null`, `{ "imageId": "<24 esadecimali>" }` di un'immagine del gruppo (il server costruisce il descrittore dal file memorizzato come per i loghi delle aziende) oppure il descrittore invariato; un altro descrittore è `422 notAllowed`. **Regola del 6B:** un CA o un PA può usare solo le immagini dell'azienda del punto vendita (`companyId` dell'immagine uguale; per il PA l'azienda del proprio punto vendita), gli altri ruoli qualunque immagine del gruppo.
- **Campi riservati** (`403 notAllowed` per un valore diverso dall'attuale, accettato se uguale; alla creazione il confronto è con il default `false`): **`appointments.webWidgetStatus`**, solo PSA e D. Gli interruttori delle integrazioni e le impostazioni rivenditore sono descritti nel passo 7F, qui sotto.
- **Concorrenza.** I percorsi delle impostazioni sono posseduti: una scrittura **del POS** a `roomsSettings.reservation.suspendedToday` (o a qualunque altra chiave posseduta) tra `GET` e `PUT` dà `412`, mentre una a `devices.<i>.info` o `devices.<i>.status` no (una a `rooms` sì: vedi 7F).

### Liste, integrazioni e impostazioni rivenditore (passo 7F)
Sei blocchi in più nel dettaglio, nel `PATCH` unico (non nella creazione: un nuovo punto vendita ha il template) e con una `PUT` ciascuno (`If-Match` obbligatorio, `places:update`, stesse regole, errori e risposta del `PATCH`; `place.updated` registra solo il **nome** del blocco).

| Blocco | `PUT` | Forma | Chiavi legacy |
|---|---|---|---|
| `devices` | `…/devices` | `{ items: [...] }` | `devices[]` |
| `printStations` | `…/print-stations` | `{ stations: [...], productionCenters: [...] }` | `printStations[]`, `productionCenter[]` |
| `rooms` | `…/rooms` (limite 1 MB) | `{ items: [...] }` | `rooms[]` con `tables[]` e `view` |
| `storages` | `…/storages` | `{ items: [...] }` | `storages[]` |
| `integrations` | `…/integrations` | oggetto per provider | `integrations.*` (17 provider) |
| `dealerSettings` | `…/settings/dealer` | `{ sentry, serverIp, connectorAddress }` | `platform.sentry`, `server.ip`, `connectorAddress` |

**Liste (regole comuni).** L'elenco inviato **sostituisce** quello memorizzato: un elemento assente è rimosso, l'ordine è quello della richiesta. Gli elementi sono identificati dal loro `id` stabile: con `id` deve essere uno dei punti vendita (altrimenti `422 incorrect`, anche se ripetuto), senza `id` ne riceve uno nella forma `createId` del vecchio backoffice (per i depositi un `ObjectId`). Ogni chiave è opzionale (un elemento nuovo prende i default, uno esistente tiene il valore); si scrivono solo le chiavi che cambiano, e il server le **sovrappone all'elemento memorizzato dentro la transazione**: le chiavi non possedute (`info` e `status` dei dispositivi scritti dal POS, `view.subtables`, `__index`, `__listName`, qualunque chiave futura) restano, e un valore invariato mantiene il tipo BSON esatto. **Elementi senza `id` o con `id` ripetuto.** Se la lista memorizzata contiene un elemento senza `id` utilizzabile o due elementi con lo stesso `id` (anche un tavolo dentro una sala), la lista **non è scrivibile**, per non perdere l'elemento: `GET` la restituisce con `editable: false` (`devices`, `rooms`, `storages`; `stationsEditable` e `productionCentersEditable` per le postazioni) e l'elemento compare in sola lettura con `id: ""` e `withoutId: true`. Il blocco rimandato identico (`PUT` o dentro il `PATCH`) non fa nulla; qualsiasi modifica è `409 CONFLICT` con `details: [{ "field": "<blocco>", "issue": "incorrect" }]` e il messaggio "The stored list has an item without an id and cannot be changed", e non scrive nulla. Il resto del punto vendita resta modificabile. Le regole si applicano solo agli elementi nuovi o cambiati.
- **Dispositivi.** Tutte le chiavi del form del vecchio backoffice (`server`, `type`, `name`, `driver`, `host`, `serialNumber`, `epsonProtocol17`, `epsonEreceipt`, `DLN502017Rounding`, `secondaryDriver/Host`, `automaticCash*`, `posProtocol17*`, `posDojoTerminalId`, `multisafepayAppStatus`, `multisafepayQrStatus`, `multisafepayTerminals`, `externalDisplayId`, `secondaryCompanyPrinterId`, `favoritesId`, `scaleDialog0204*`, `barcodePriceRule`, `orderingPrintSingleProduct*`, `printStations`). `externalDisplayName`, `secondaryCompanyPrinterName` e `favoritesGroupName` li calcola il server. Regole: nome obbligatorio e univoco senza distinguere le maiuscole (`required`, `taken`); `type` tra i nove tipi, e per il piano come nel legacy (`desk` sempre; `basic` anche `waiting-list`, `external-display`, `kiosk`, `tgm`; `advanced` tutti; altri piani solo `desk`; un tipo storico rimandato invariato è accettato); un solo `server: true`; driver nelle liste del vecchio backoffice; `externalDisplayId` un dispositivo `external-display`, `secondaryCompanyPrinterId` uno `tgm`, `favoritesId` una lista preferiti del gruppo, `printStations` postazioni del punto vendita (`incorrect`, solo dove cambiano). Rimuovere un dispositivo è permesso, ma **`409` con `devices.items` `busy`** se il POS lo segnala occupato (`status.busy`). I nuovi dispositivi ricevono `status: { busy: false, userName: '' }` una sola volta (lo legge il vecchio backoffice). **Il POS scrive `devices.<i>.info` per indice:** rimuovere o riordinare sposta gli indici, come nel legacy.
- **Impostazioni di sala nuove** (blocco `tables`, `PUT …/settings/tables`, chiavi `roomsSettings.*`; tutte presenti in lettura, mai `null`): `tableIdleMinutes` (intero 15, 20 o 30, default 30: altro valore `422 enum`), `variantsPerRow` (boolean, default `true`), `discountReasons` e `deleteReasons` (elenchi di testi, default `[]`; ogni motivo 1–100 caratteri senza caratteri di controllo e **senza `;`** (`format`; il vecchio backoffice li unisce e li separa con `;`; in lettura i valori salvati restano come sono), spazi ai bordi tolti, un doppione senza distinguere le maiuscole è `incorrect` sul suo indice, al massimo 50 per elenco, `tooMany`) e `reasonsFreeText` (boolean, default `true`). Un punto vendita creato ha i valori predefiniti, il duplicato copia quelli dell'originale. Le scrive chiunque possa modificare il punto vendita.
- **Terminali MultiSafepay** (`multisafepayTerminals`): elenco di `{ "terminalId", "name" }`, sostituito per intero a ogni scrittura (quindi `[]` lo svuota); al massimo 20 per dispositivo (`tooMany`), `terminalId` 1–64 caratteri `A-Za-z0-9_-` (`minLength`, `maxLength`, `pattern`) e **unico nel dispositivo** (il ripetuto è `incorrect`, campo `items.N.multisafepayTerminals.M.terminalId`), `name` 1–100 caratteri senza caratteri di controllo (`minLength`, `maxLength`, `format`), spazi ai bordi tolti. In lettura le voci senza `terminalId` testuale sono ignorate e un nome vuoto è il `terminalId`. Il legacy non ha più `multisafepayTerminalId` e `multisafepayName`: il backend non li legge né li scrive e, se il documento li ha, restano come sono.
- **Credenziali dei dispositivi** (`automaticCashUsername`, `automaticCashPassword`): **solo scrivibili**. Un testo le imposta, `null` o `''` le cancella (`null` memorizzato), assenti restano; la risposta ha `automaticCashUsernameSet` e `automaticCashPasswordSet`. Mai in risposte, errori, registro delle attività o log.
- **Postazioni comanda.** Postazione: `name`, `driver` (`EPSON-EPOS-PRINT`, `ESCPOS`), `host` obbligatori (`required`), `pulseNumber`, `pulseNumberSecondary`, `upsideDown`, `exitsCut`, `summaryCategoriesIds` (categorie di `products_categories`, non nel cestino), `summaryPrintStationsIds` (postazioni del punto vendita, mai se stessa). Centro di produzione: `name` e `capacity` (intero ≥ 0).
- **Sale.** Sala: `name` (univoco senza distinguere le maiuscole), `listId` (listino attivo del gruppo), `service` (0–100), `tax` (aliquota del gruppo), `deviceId` (dispositivo `desk`), i cinque interruttori, `printStations`, `tables[]` (`name` univoco nella sala, `seats`, `userId` [un utente del gruppo, non nel cestino, con il punto vendita in scope: `incorrect` dove cambia], `view` `{ w, h, x, y, shape: rect|round }`; `roomId` lo imposta il server) e `view` `{ type: grid|'', status, h, w }` (celle da 1 a 50; un tavolo con `x` e `y` deve stare nella griglia). Una sala senza `view` si legge con i default dell'editor (`grid`, spenta, 8×8) ma **non** si riscrive finché non cambia. Limiti: 30 sale, 200 tavoli per sala, 1000 in tutto (`tooMany`). **Il POS riscrive l'intero array `rooms`**: `rooms` fa parte della versione, quindi una scrittura del POS tra `GET` e salvataggio dà `412` (nel legacy vince l'ultimo che scrive, decisione 5.6.4). `view.subtables` e ogni altra chiave del POS per id di sala e di tavolo si conservano. Gli artefatti dell'interfaccia (`__index`, `__listName`, `__printStationsLabels`) non si scrivono mai; quelli memorizzati restano.
- **Depositi.** `name`, `cash`, `ecommerce`; gli `id` esistenti restano (`ObjectId`, mai rigenerati), i nuovi sono `ObjectId`. Regole del legacy: almeno un deposito, **esattamente uno** `cash`, **al più uno** `ecommerce` (`incorrect`/`required` su `storages.items`). La rimozione è permessa; i riferimenti dal magazzino **non sono ancora verificati**.
- **Integrazioni.** Provider: `floodPay` (`stripe`, `qrCodePayment`, `tapToPay`), `bizerba`, `googleMaps`, `reserveWithGoogle`, `easyappear`, `yellgo`, `leggimenu`, `plateform`, `cooperto`, `dojo`, `satispay`, `qodeup`, `tomatoai`, `keenon`, `tsh`, `phlex`, `multisafepay` (`status`, `terminalGroupId` 1–64 caratteri `A-Za-z0-9_-` o `null` (vuoto = `null`, `pattern` dove cambia), `qrSecondsActive` intero 60–31 536 000 default 600, `qrStatus`, e le credenziali `terminalGroupApiKey` e `websiteApiKey`). Le chiavi non segrete sono leggibili (`stripe.publicKey`, `bizerba.*`, `tsh.propertyId`, `categoriesMap`…); `tsh.categories` (elenco del provider) è solo lettura (si può rimandare, è ignorato). **Credenziali dei pagamenti (solo PSA e D):** `stripe.publicKey`, `stripe.privateKey`, `stripe.webhookPrivateKey`, `dojo.apiKey`, `satispay.activationCode`, `satispay.keyId`, `qodeup.apiKey`, `multisafepay.terminalGroupApiKey`, `multisafepay.websiteApiKey`: impostarle, cambiarle o cancellarle da un altro ruolo è `403 notAllowed` (con il percorso); una richiesta che le lascia fuori è accettata, e gli altri ruoli vedono solo `…Set`. **Credenziali, solo scrivibili** con il flag `…Set` nella risposta (non tagliate: uno spazio all'inizio o alla fine è `422 pattern`): `stripe.privateKey`, `stripe.webhookPrivateKey`, `easyappear.appToken`, `yellgo/leggimenu/cooperto/dojo/qodeup/tomatoai.apiKey`, `plateform.username/password`, `satispay.activationCode/keyId`, `tsh.id/secret`, `phlex.username/password`, `multisafepay.terminalGroupApiKey/websiteApiKey`. Formati: chiavi Stripe `pk_`, `sk_`/`rk_`, `whsec_`; codice Satispay alfanumerico; le altre testo stampabile senza spazi (fino a 512). Gli interruttori `…status` dei 17 provider e `multisafepay.qrStatus` sono **riservati** a PSA e D (`403 notAllowed` se un altro ruolo li cambia). `reserveWithGoogle.url` deve essere `https://…` e `telephone` fatto di cifre, spazi, `+`, `-`, `(`, `)` (controllati dove cambiano). Con `reserveWithGoogle` attivo i dati devono essere completi (`required`; latitudine e longitudine `0` valgono come mancanti, come nel feed) e a ogni modifica di quelle chiavi o dell'azienda il feed `reserve_with_google` viene **inserito o aggiornato se attivo e completo, altrimenti rimosso** (stesso risultato per un punto vendita nel cestino), nella stessa transazione. Le chiavi che nessuno possiede (`integrations.floodOrders`, `plateform.locationId`, `tsh.tshCategories`…) restano.
- **Impostazioni rivenditore.** Solo **PSA e D** le ricevono e le scrivono (altri ruoli: `403 notAllowed` su `dealerSettings`); `sentry` solo PSA. `serverIp` (testo fino a 64 di `A-Za-z0-9.:-[]`, `null` se vuoto), `connectorAddress` (URL `http(s)` fino a 255 o `''`); la forma si controlla solo dove cambia. Questi dati non vanno mai nei log.
- **Concorrenza.** Versione = tutti i campi posseduti; per i dispositivi si considerano solo le chiavi possedute (il battito del POS non dà `412`), per le sale l'array intero.
- **Import/esporta JSON:** è del client; il `PATCH` unico accetta tutti i blocchi coperti dal JSON del legacy (`cashSettings` = `general`, `printing` = `receipt`/`prebilling`/`ordering`, `tables` = `roomsSettings`).

### Regole di validazione dei punti vendita
Rigorose in scrittura, tolleranti in lettura. Un campo si controlla quando **cambia** (o alla creazione): un punto vendita con dati legacy che non rispettano una regola resta modificabile in ciò che la regola non tocca.
- **Azienda:** `companyId` è un'azienda del gruppo, non nel cestino e nel perimetro del chiamante; un'azienda che non esiste, di un altro gruppo, nel cestino o fuori perimetro è `422` con `issue: "incorrect"` sul campo `companyId` (non `404`: la risorsa è il punto vendita).
- **Paese e provincia:** come per le aziende (`address.country` esiste in `countries`; `address.province` è `''` o una delle aree del paese quando le elenca; `incorrect`). `email` come per le aziende, `phone` fino a 30 caratteri.
- **Listini:** `priceListId`, `ecommercePriceListId` (`null`/`''` per nessuno) e gli `id` di `priceLists` sono l'id di un listino **attivo** del gruppo (`incorrect`; un listino già usato dal punto vendita non si rigiudica quando rimandato invariato). `priceLists` ha id univoci (`incorrect`).
- **Serie delle fatture:** `invoiceSeries` è `null`/`''` oppure il `name` di una serie (`invoicePS`) **dell'azienda che il punto vendita avrà** (`incorrect`); `false` si accetta solo invariato.
- **Licenza:** `plan` è uno tra `basic`, `advanced`, `enterprice`, `tgm-secondary`, `desk-secondary` quando cambia (`incorrect`); `expirationDate` data o istante ISO 8601 oppure `null`; `status` `active`/`disabled`; `sentry` booleano.
- **Orari:** `timezone` è un fuso IANA di `Intl.supportedValuesOf('timeZone')` (più `UTC`) quando cambia (`incorrect`). Gli orari dei turni sono `HH:mm` (`format`, con il percorso `openingHours.week.3.values.0.start`) e le date dei giorni speciali sono `YYYY-MM-DD` che esistono (`format`), controllati **solo per i giorni che cambiano**; al più 8 turni al giorno e 400 giorni speciali per ognuno dei due calendari (`tooMany`); la settimana ha sempre i sette giorni `0`–`6` (`required`).
- I numeri interi nell'intervallo Int32 sono scritti come Int32, gli altri come Double (come il legacy).

## Chiave di negozio (`/v1`)

La credenziale con cui il **server di punto vendita** (app separata, D-22) chiama il cloud (D-24, passo 7C; `doc/Security-Model.md` §5): **una chiave per punto vendita**, una sola attiva (una nuova attivazione revoca subito la precedente), **nessuna scadenza fino a revoca**. Si gestisce solo da PSA e D (`storeKeys:read`, `storeKeys:manage`, nel tetto dei due ruoli: SA, CA e PA ricevono `403`; un D fuori dai propri gruppi `404`). Le route di gestione sono di gruppo (`group: true`), con `:placeId` di un punto vendita del gruppo non nel cestino (altrimenti `404`).

> **Flusso.** 1) Dal backoffice PSA o D genera un **codice di attivazione** del punto vendita (valido 24 ore, un solo uso, mostrato una sola volta). 2) Il tecnico lo digita sull'app del server di negozio. 3) L'app lo scambia, senza credenziali, con `POST /v1/store-activations` e riceve la **chiave** (`fc_sk_…`, mostrata una sola volta). 4) Da qui ogni richiesta porta `Authorization: Bearer fc_sk_…`. Se l'app perde la risposta dello scambio, il codice è consumato: ne serve uno nuovo. Lo stesso vale per un `5xx` sullo scambio: la transazione può essere stata completata (la chiave precedente già revocata e la nuova creata) senza che l'app abbia ricevuto il segreto; serve un nuovo codice, e la chiave creata e mai consegnata resta attiva finché il nuovo scambio non la sostituisce.
>
> **Requisiti per l'app del negozio** (fuori scope, vincolanti per chi la scrive): conservare la chiave nel **keystore del sistema operativo** (Keychain, DPAPI, Android Keystore, libsecret); usare la **verifica TLS obbligatoria**; non scrivere mai la chiave nei log né mandarla ai dispositivi del negozio; **non cancellarla** su `403 STORE_DISABLED` (la chiave è buona, il punto vendita è solo temporaneamente non operativo e riprende da solo); considerarla persa solo su `401`.
>
> **Stati del negozio a ogni richiesta.** `401 UNAUTHENTICATED` (identico) per chiave assente, malformata, sconosciuta o revocata, o gruppo inesistente: serve una nuova attivazione. `403 STORE_DISABLED` (nulla è revocato) per gruppo sospeso o nel cestino, punto vendita disattivato o con licenza scaduta (`expirationDate` passata rispetto all'orologio del server), azienda nel cestino: riprende da solo con la riattivazione, il ripristino o il rinnovo. Un punto vendita nel cestino (anche dal legacy) o eliminato **revoca** la chiave (`401`): un punto vendita ripristinato non la riottiene. `403 FORBIDDEN` per una route che non ammette il negozio (oggi ogni route di `/v1` salvo `/store-context`, le sue letture e il catalogo del negozio, il dettaglio del punto vendita e le route del catalogo del backoffice comprese). Limite: 600 richieste al minuto per chiave (`429` con `Retry-After`), contate a ogni richiesta di una chiave attiva, anche quelle rifiutate con `403` e quelle di un negozio bloccato. Le risposte portano il contesto del negozio solo in `GET /v1/store-context`.

### GET /v1/groups/{groupId}/places/{placeId}/store-key
- **Autenticazione e permesso:** Bearer backoffice, `storeKeys:read` (PSA e D)
- **Risposta:** `200`
  ```json
  { "data": {
    "status": "active",
    "key": { "id": "6650…", "hint": "fc_sk_AbC1…", "activatedAt": "2026-11-13T10:00:00.000Z", "activatedBy": { "id": "…", "role": "D" },
      "installation": { "userAgent": "…", "appVersion": "2.0.1", "platform": "windows" },
      "lastSeenAt": "2026-11-13T12:31:00.000Z", "lastSeenIp": "203.0.113.7" },
    "pendingActivation": { "createdAt": "…", "expiresAt": "…", "createdBy": { "id": "…", "role": "PSA" } },
    "lastRevoked": { "revokedAt": "…", "reason": "replaced" }
  } }
  ```
  `status` è `none` (mai attivata, o l'ultima è revocata: `key: null`) o `active` (**è il campo che dice se il punto vendita ha una chiave attiva**: `status === "active"`); `pendingActivation` è `null` senza un codice valido (un codice scaduto non si mostra); `lastRevoked` (`reason`: `revoked`, `replaced`, `placeTrashed`, `placeDeleted`) è `null` se nessuna chiave è mai stata revocata. Mai la chiave né il suo hash.
- **Errori:** comuni; `403`; `404`; `422` (`placeId`)

### POST /v1/groups/{groupId}/places/{placeId}/store-key/activation-codes
- **Autenticazione e permesso:** Bearer backoffice, `storeKeys:manage` (PSA e D); body vuoto (nessun body o `{}`) oppure `{ "confirmReplaceActiveKey": true }` (booleano; ogni altra proprietà è `422`); 20 al minuto per utente
- **Conferma obbligatoria con una chiave attiva:** se il punto vendita ha una **chiave attiva** (`status: "active"` in `GET …/store-key`), senza `confirmReplaceActiveKey: true` la risposta è `409 CONFLICT` con `details: [{ "field": "confirmReplaceActiveKey", "issue": "required" }]` e **nessun codice** viene generato né registrato. Per un punto vendita senza chiave attiva il campo è ignorabile. Il backoffice legge prima lo stato (`GET …/store-key`, campo `status`) e chiede conferma **prima** di generare.
- **Comportamento:** genera il codice (16 simboli, 80 bit) e **sostituisce** quello pendente del punto vendita (ne esiste uno solo). **Non tocca la chiave attiva**: il negozio continua a funzionare finché il nuovo server non si attiva. Registra `store.activationCodeCreated` e, se il punto vendita aveva una chiave attiva (e quindi la conferma), l'**allerta** `store.activationCodeForActivePlace` (`keyHint` della chiave attiva, mai il codice). La risposta non è mai compressa.
- **Header particolari:** `Location: /v1/groups/{groupId}/places/{placeId}/store-key`
- **Risposta:** `201`
  ```json
  { "data": { "code": "7KQ2-M9XD-4TPA-H3WN", "expiresAt": "2026-11-14T10:00:00.000Z" } }
  ```
  Il codice si mostra **una volta**: non si può rileggere (il server conserva solo il suo hash).
- **Errori:** comuni; `403`; `404` (punto vendita non raggiungibile o nel cestino); `409 CONFLICT` se un codice non servirebbe a nulla (gruppo sospeso o nel cestino, punto vendita disattivato o con licenza scaduta, azienda nel cestino); `422`; `429`

### DELETE /v1/groups/{groupId}/places/{placeId}/store-key/activation-code
- **Autenticazione e permesso:** Bearer backoffice, `storeKeys:manage`; registra `store.activationCodeCancelled`
- **Risposta:** `204` senza body
- **Errori:** comuni; `403`; `404` (punto vendita non raggiungibile, o nessun codice pendente)

### DELETE /v1/groups/{groupId}/places/{placeId}/store-key
- **Autenticazione e permesso:** Bearer backoffice, `storeKeys:manage`
- **Comportamento:** revoca la chiave attiva (motivo `revoked`): il negozio riceve `401` alla richiesta successiva. Il codice pendente, se c'è, resta (serve a riattivare). Non richiede `If-Match`. Registra `store.keyRevoked`.
- **Risposta:** `204` senza body
- **Errori:** comuni; `403`; `404` (punto vendita non raggiungibile, o nessuna chiave attiva)

### POST /v1/store-activations
- **Autenticazione e permesso:** **anonimo** (il server di negozio non ha ancora una credenziale: il codice di attivazione è la credenziale); rate limit **10 al minuto per IP**, prima della lettura del body; body massimo 2 KB; la risposta non è mai compressa
- **Body:**
  ```json
  { "activationCode": "7KQ2-M9XD-4TPA-H3WN", "installation": { "appVersion": "2.0.1", "platform": "windows" } }
  ```
  `activationCode` come lo digita una persona (maiuscole o minuscole, con o senza trattini e spazi; `O` è letta come `0`, `I` e `L` come `1`); `installation` è facoltativo e dichiara `appVersion` e `platform` (stringhe di al più 64 caratteri con lettere, cifre e `. _ + - ` e spazio); lo user agent si legge dall'header.
- **Comportamento:** in una transazione consuma il codice (un solo vincitore tra scambi concorrenti), verifica che gruppo, azienda e punto vendita siano operativi, **revoca la chiave attiva** del punto vendita (motivo `replaced`) e crea la nuova. Registra `store.activated`.
- **Header particolari:** `Location: /v1/store-context`
- **Risposta:** `201`
  ```json
  { "data": { "key": "fc_sk_…", "keyId": "6650…", "groupId": "665f…", "companyId": "665f…", "placeId": "665f…" } }
  ```
  `key` si mostra **una volta**: il server conserva solo il suo hash.
- **Errori:** `401 INVALID_CREDENTIALS`, **identico** per ogni fallimento (codice malformato, sconosciuto, scaduto, già usato, o punto vendita non operativo: in quest'ultimo caso il codice è comunque consumato); `413`; `415`; `422` (body malformato nella forma: proprietà sconosciute, tipi, dichiarazioni non ammesse; mai con il valore ricevuto); `429`

### GET /v1/store-context
- **Autenticazione e permesso:** solo la **chiave di negozio**; nessun permesso del catalogo (il profilo del negozio è fisso: `places:read`, oggi senza route che lo usino oltre a queste). Un access token di un utente è `403 FORBIDDEN`.
- **Risposta:** `200`; serve all'app per verificare la chiave e per ricavare l'azienda attuale del punto vendita senza leggere dati
  ```json
  { "data": { "groupId": "665f…", "companyId": "665f…", "placeId": "665f…", "keyId": "6650…", "activatedAt": "2026-11-13T10:00:00.000Z" } }
  ```
- **Errori:** `401`; `403 STORE_DISABLED`; `403 FORBIDDEN` (non è una chiave di negozio); `429`

### GET /v1/store-context/group · /company · /place
La **configurazione completa** del gruppo, dell'azienda e del punto vendita della chiave, per il server di negozio (casse e palmari ne combinano le impostazioni). Senza parametri di percorso: gli id vengono dal principal della chiave (l'azienda è quella **attuale** del punto vendita), mai dal client.
- **Autenticazione e permesso:** solo la **chiave di negozio**; nessun permesso del catalogo. Un access token di un utente, di qualunque ruolo, è `403 FORBIDDEN`.
- **Risposta:** `200 { "data": … }`, sempre `Cache-Control: no-store`, **mai compressa** (contiene credenziali in chiaro), con `ETag` e `304` su `If-None-Match` corrispondente (valutato dopo l'autenticazione). L'`ETag` è quello **forte** della versione del documento per azienda e punto vendita (lo stesso del dettaglio del backoffice); per il gruppo, che non ha una versione, è un tag **forte calcolato con HMAC-SHA-256 sul contenuto** con la chiave segreta delle versioni (mai un hash semplice del corpo, che contiene credenziali: non si può ricalcolare dal solo corpo). Un errore (`401`, `403`, `404`, `429`) non porta mai `ETag` e non è mai un `304`. L'azienda è quella indicata ora dal documento del punto vendita nel database del gruppo.
  - **`/place`:** la stessa rappresentazione del dettaglio del punto vendita (anagrafica, licenza, orari, i tredici blocchi di impostazioni, dispositivi, postazioni e centri di produzione, sale con tavoli, depositi, integrazioni) più `dealerSettings`, ma con le **credenziali in chiaro**: dove il backoffice ha `<chiave>Set: true|false` il negozio ha la chiave stessa (testo, o `null` se assente o vuota) e **nessun flag** (integrazioni: `integrations.dojo.apiKey`, `…satispay.keyId`, `…floodPay.stripe.privateKey` e le altre; dispositivi: `automaticCashUsername`, `automaticCashPassword`).
  - **`/company`:** la stessa rappresentazione del dettaglio dell'azienda, completa. Oggi il modello dell'azienda non contiene credenziali, quindi coincide con quella del backoffice.
  - **`/group`:** `id`, `name`, `description`, `status`, `trashed`, `trashedAt`, `demo`, `features`, `languages`, `statsSettings`, `integrations` (per ogni provider `{ enabled, apiKey }`, la chiave in chiaro o `null`), `legacyApiKey` (**temporaneo**: la chiave di gruppo del legacy; sarà rimosso quando le chiamate ai vecchi servizi saranno migrate), `createdAt`, `updatedAt` e tutti i cataloghi del documento del gruppo, ciascuno nei limiti del proprio massimo: `priceLists`, `taxes`, `currencies`, `measureUnits`, `warehouseRules`, `fidelityCardRules`, `cardTypes`, `pointsCollections`, `prizeCatalogues`, `productFavorites`, `promotions` (con i nomi delle rispettive sotto-risorse).
  - **Mai restituiti, nemmeno al negozio:** `publicApi` e tutto ciò che riguarda le API pubbliche, `dealerId`, `dataCluster`, `databaseHost`, `filesHost`, chiavi di negozio, hash, utenti, i campi del documento che il backend non modella. Le letture vanno ai documenti del database del gruppo (azienda e punto vendita) e di quello comune (gruppo), con tempo massimo; i valori assenti o non validi arrivano come `null`, `false`, `[]`.
  - **Esempio** (`/place`, estratto):
    ```json
    { "data": { "id": "665f…", "name": "Bar Roma", "integrations": { "dojo": { "status": true, "apiKey": "…" } }, "devices": { "items": [{ "id": "d1", "name": "Cassa", "automaticCashUsername": "…", "automaticCashPassword": "…" }] }, "dealerSettings": { "sentry": false, "serverIp": "10.0.0.1", "connectorAddress": "" } } }
    ```
- **Errori:** `401`; `403 STORE_DISABLED`; `403 FORBIDDEN` (non è una chiave di negozio); `404` (il documento non esiste più); `429`. Nessun segreto compare in log, registro delle attività o messaggi d'errore. `/group`, `/place` e `/users` (che portano credenziali) registrano, solo su `200`, l'evento di sicurezza `store.configurationRead` con la risorsa letta (`group`, `place` o `users`) e gli id di azienda e punto vendita, al più uno all'ora per chiave, risorsa e indirizzo del client (una lettura da un indirizzo nuovo è un evento nuovo); `/company` non lo registra (oggi senza credenziali: da rivedere quando ne avrà). Un `304`, un errore o `/store-context` non registrano nulla.

### GET /v1/store-context/users
Gli **utenti coinvolti nel punto vendita** della chiave, con il loro **PIN in chiaro** (decisione dell'utente del 2026-11-23: il PIN è salvato in chiaro perché il POS legacy lo confronta da sé; la password non esce mai). Nessun parametro di percorso.
- **Autenticazione e permesso:** solo la **chiave di negozio**; un utente è `403 FORBIDDEN`. Risposta mai compressa (`compress: false`) e `Cache-Control: no-store`.
- **Chi si riceve** (calcolato dal server dalla sola chiave: gruppo, punto vendita e azienda **attuale** del punto vendita, letta dal documento del punto vendita nel database del gruppo): gli utenti del gruppo non nel cestino che sono `E` (un ruolo mancante vale `E`) o `PA` con il punto vendita in `placeId` o `placesId`; i `CA` la cui `companyId` è l'azienda attuale del punto vendita; i `SA` del gruppo. **Mai** PSA, D, utenti di altri gruppi, utenti nel cestino, utenti con ruolo sconosciuto, `E`/`PA` di altri punti vendita, `CA` di altre aziende. Gli utenti **disattivati** (non nel cestino) sono inclusi, con `status: "disabled"`, perché il negozio possa bloccarli.
- **Query:** solo `limit` (1–200, default 50) e `cursor` (opaco); l'ordine è quello dell'elenco utenti (per nome utente, poi `_id`). Nessun filtro né ricerca né ordinamento: ogni altro parametro, un cursore non valido o un `limit` fuori limite sono `422`.
- **Risposta:** `200 { "data": [ utente… ], "page": { "limit": 50, "next": null | "<cursore>" } }`. Ogni utente ha le stesse chiavi del dettaglio utente del backoffice (`id`, `username`, `firstName`, `lastName`, `email`, `phone`, `role`, `groupId`, `companyIds`, `placeIds`, `status`, `trashed`, `trashedAt`, `language`, `theme`, `hiddenInStats`, `description`, `hasAvatar`, `serviceIds`, `permissions`, `pos` con `enabled`, `grants` e `options`, `shiftTime`, `createdAt`, `updatedAt`), con queste differenze: `pin` (testo, oppure `null` se manca, è vuoto o non è un testo) al posto di `pinSet`; **niente** `avatar` (resta `hasAvatar`) né `dealerId`. Non arrivano mai password, hash, token, sessioni, credenziali o campi del documento non modellati.
- **ETag:** **forte**, HMAC-SHA-256 del corpo della pagina (`data` e `page`) con la chiave segreta delle versioni, quindi non ricalcolabile dal solo corpo (il corpo contiene PIN). Ogni pagina ha il suo tag; `304` su `If-None-Match` corrispondente, valutato dopo autenticazione e rate limit; mai su un errore.
- **Registro:** `store.configurationRead` con `resource: "users"` (al più uno all'ora per chiave, risorsa e indirizzo del client, solo su `200`), mai un PIN o altro valore.
- **Errori:** `401`; `403 STORE_DISABLED`; `403 FORBIDDEN`; `404` (il punto vendita non esiste più o non ha un'azienda); `405`; `422`; `429`.
- **Backoffice invariato:** nessuna route degli utenti restituisce il PIN (solo `pinSet`).

### GET /v1/store-context/countries
I **paesi con le loro province** (collection `countries`, dati della piattaforma uguali per tutti), per il server di negozio. Stessi dati e stessa rappresentazione di `GET /v1/countries` (stesso servizio): non c'è un gruppo né un punto vendita da indicare.
- **Autenticazione e permesso:** solo la **chiave di negozio**; nessun permesso del catalogo. Un access token di un utente è `403 FORBIDDEN`. Valgono gli stati del negozio (`401`, `403 STORE_DISABLED`, `429`).
- **Parametri:** nessuno. Non c'è paginazione: una sola risposta limitata (al più 400 paesi letti); un parametro di query, qualunque, è ignorato come nella route degli utenti.
- **Risposta:** `200 { "data": [ { "code": "IT", "name": "Italia", "areas": [ { "code": "MI", "name": "Milano" } ] } ], "page": { "limit": <numero di elementi>, "next": null } }`, ordinati per nome e poi per codice; `ETag` **debole** sul contenuto, `304` su `If-None-Match` corrispondente, `Cache-Control: no-store`. Risposta compressa come le altre (nessun segreto). Nessun evento nel registro.
- **Non aperto al negozio:** `GET /v1/countries`, il dettaglio di un paese e tutte le scritture (`403 FORBIDDEN`).
- **Errori:** `401`; `403 STORE_DISABLED`; `403 FORBIDDEN`; `405` per ogni altro metodo; `429`.

## Chiavi delle API pubbliche (`/v1`)

Le chiavi con cui un'integrazione di un gruppo chiama `/public/v1` (passo 9A; `doc/Security-Model.md` §6–7). Si gestiscono solo da **PSA e D** nei gruppi del loro perimetro (`apiKeys:read`, `apiKeys:manage`, nel tetto dei due ruoli): SA, CA e PA ricevono `403`, come la chiave di negozio e come ogni richiesta senza credenziali (`401`); un D fuori dai propri gruppi `404`. Sono route di gruppo (`group: true`). Più chiavi per gruppo (al massimo **50 attive**), ognuna con permessi, restrizioni, scadenza e limiti propri; una chiave revocata resta nell'elenco per lo storico (non c'è cancellazione). Le chiavi **non funzionano** finché il gruppo non ha acceso `publicApi.enabled` (solo il PSA, `PATCH /v1/groups/{groupId}`).

Rappresentazione di una chiave (mai l'hash né il segreto):
```json
{
  "id": "6650c0a1b2c3d4e5f6a7b8c9",
  "name": "Webshop",
  "prefix": "fc_pk_AbCdEf",
  "permissions": ["places:read", "companies:read"],
  "restrictions": { "companyIds": ["665f1c2e9b1d4a0012ab3411"], "placeIds": null },
  "rateLimitPerMinute": 60,
  "dailyQuota": 10000,
  "expiresAt": "2027-11-17T00:00:00.000Z",
  "status": "active",
  "createdAt": "2026-11-17T10:00:00.000Z",
  "createdBy": { "id": "665f1c2e9b1d4a0012ab34d1", "role": "D" },
  "lastUsedAt": "2026-11-17T12:31:00.000Z",
  "revokedAt": null,
  "revokedBy": null
}
```
`permissions` sono del catalogo **pubblico** (`places:read`, `companies:read`, `catalog:read`, `catalog:write`), non del backoffice. `catalog:read` dà la lettura del catalogo (listini, aliquote, prodotti, categorie, marche, gruppi di attributi, reparti, giacenze); `catalog:write` la scrittura di prodotti e categorie e si concede **solo** alle chiavi che devono scrivere (non implica `catalog:read`). `restrictions.companyIds` e `restrictions.placeIds` sono elenchi di id (1–100) o `null` per nessuna restrizione di quel tipo; con entrambe vale l'intersezione. `status` è `active` o `revoked`; `lastUsedAt` è aggiornato al più una volta al minuto.

### GET /v1/groups/{groupId}/api-keys
- **Autenticazione e permesso:** Bearer backoffice, `apiKeys:read` (PSA e D)
- **Query:** `limit` (1–200, default 50), `cursor` (opaco), `status` (`active` | `revoked`); ordine fisso, dalla più recente; nessun'altra proprietà (`422`)
- **Risposta:** `200` `{ "data": [chiave…], "page": { "limit": 50, "next": null } }`
- **Errori:** comuni; `403`; `404`; `422`

### POST /v1/groups/{groupId}/api-keys
- **Autenticazione e permesso:** Bearer backoffice, `apiKeys:manage` (PSA e D); 20 scritture di chiavi al minuto per utente
- **Body** (massimo 16 KB, nessun'altra proprietà):
  | Campo | Tipo | Obbligatorio | Vincoli |
  |---|---|---|---|
  | `name` | stringa | sì | 1–100 caratteri, senza caratteri di controllo |
  | `permissions` | array | sì | almeno uno, senza ripetizioni, del catalogo pubblico |
  | `restrictions` | oggetto | no | `{ "companyIds"?: id[] \| null, "placeIds"?: id[] \| null }`, 1–100 id ciascuno, tutti di aziende e punti vendita **del gruppo** e fuori dal cestino, ognuno una volta sola |
  | `expiresAt` | data ISO o `null` | no | nel futuro e al più 3 anni da ora |
  | `rateLimitPerMinute` | intero | no | 1–6000; **solo il PSA** |
  | `dailyQuota` | intero | no | 1–10 000 000; **solo il PSA** |
  ```json
  { "name": "Webshop", "permissions": ["places:read", "companies:read"], "restrictions": { "companyIds": ["665f1c2e9b1d4a0012ab3411"] }, "expiresAt": "2027-11-17T00:00:00.000Z" }
  ```
  Senza limiti nel body la chiave **eredita** quelli del gruppo (`publicApi.defaultRateLimitPerMinute` e `defaultDailyQuota`, o i default della piattaforma: 60 al minuto e 10 000 al giorno). Un D che invia un limite riceve `403` con `details: [{ "field": "rateLimitPerMinute", "issue": "notAllowed" }]` e non si crea nulla.
- **Header particolari:** nessuna `Idempotency-Key` (un nuovo invio dovrebbe conservare il segreto: ogni richiesta crea una chiave nuova); risposta `Location: /v1/groups/{groupId}/api-keys/{keyId}`, `Cache-Control: no-store`, **mai compressa**
- **Risposta:** `201` con la chiave **più `secret`**, mostrato **una sola volta**: il server conserva solo il suo hash e non può rimostrarlo. Se si perde, si crea una chiave nuova e si revoca la vecchia.
  ```json
  { "data": { "id": "6650c0a1b2c3d4e5f6a7b8c9", "name": "Webshop", "prefix": "fc_pk_AbCdEf", "…": "…", "secret": "fc_pk_AbCdEf…" } }
  ```
  Registra `apiKey.created` (nome e i sei caratteri dopo `fc_pk_`, `keyHint`, mai il segreto).
- **Errori:** comuni; `400`, `413`, `415`; `403` (limite inviato da un D); `404`; `409 CONFLICT` (il gruppo ha già 50 chiavi attive: non revocate e non scadute; il tetto è un conteggio prima dell'inserimento, quindi due creazioni simultanee possono superarlo di una); `422` per campo (anche `expiresAt` con `minimum` se non è nel futuro e `maximum` oltre i 3 anni; `restrictions.companyIds.<n>` o `restrictions.placeIds.<n>` con `incorrect` per un'azienda o un punto vendita che il gruppo non ha, che è nel cestino o che è ripetuto); `429`

### GET /v1/groups/{groupId}/api-keys/{keyId}
- **Autenticazione e permesso:** Bearer backoffice, `apiKeys:read`
- **Risposta:** `200` con la chiave
- **Errori:** comuni; `403`; `404` (una chiave che il gruppo non ha); `422` (`keyId`)

### PATCH /v1/groups/{groupId}/api-keys/{keyId}
- **Autenticazione e permesso:** Bearer backoffice, `apiKeys:manage`; 20 scritture di chiavi al minuto per utente
- **Body** (JSON Merge Patch, massimo 16 KB, almeno un campo): `name`, `permissions`, `restrictions`, `expiresAt` (`null` toglie la scadenza), `rateLimitPerMinute` e `dailyQuota` (**solo il PSA**, altrimenti `403` come alla creazione, anche se il valore è lo stesso), con i vincoli della creazione. `restrictions` cambia solo gli elenchi nominati (`{ "placeIds": null }` toglie la restrizione sui punti vendita e lascia le aziende); le altre proprietà (`hash`, `prefix`, `status`, `groupId`, `secret`…) sono `422 unknown`. Una richiesta che non cambia nessun valore non scrive e non registra nulla.
- **Risposta:** `200` con la chiave aggiornata; registra `apiKey.updated` con il nome, `keyHint` e i nomi dei campi cambiati. Una modifica ha effetto alla richiesta successiva della chiave.
- **Errori:** comuni; `400`, `413`, `415`; `403`; `404`; `409 CONFLICT` (la chiave è revocata **o scaduta**: una chiave scaduta non si riattiva spostandone la scadenza, se ne crea una nuova); `422`; `429`

### POST /v1/groups/{groupId}/api-keys/{keyId}/revoke
- **Autenticazione e permesso:** Bearer backoffice, `apiKeys:manage`; nessun body (o `{}`); 20 scritture di chiavi al minuto per utente
- **Comportamento:** revoca la chiave (`revokedAt`, `revokedBy`): la richiesta successiva della chiave è `401`. **Idempotente**: su una chiave già revocata risponde `200` con lo stato com'è e non registra altro. Registra `apiKey.revoked` una volta sola.
- **Risposta:** `200` con la chiave (`status: "revoked"`)
- **Errori:** comuni; `403`; `404`; `422`; `429`

### GET /v1/groups/{groupId}/api-keys/{keyId}/usage
- **Autenticazione e permesso:** Bearer backoffice, `apiKeys:read`
- **Query:** `from` e `to` (`YYYY-MM-DD`, giorni UTC, entrambi inclusi, date reali); senza `to` vale oggi, senza `from` i 30 giorni che finiscono in `to`; l'intervallo è al più di **92 giorni** e `from` non è dopo `to`
- **Risposta:** `200`; le righe sono per giorno e route, in ordine di giorno e route; il conteggio si scrive a blocchi (ogni 30 secondi), quindi può essere in ritardo di qualche secondo
  ```json
  { "data": {
    "keyId": "6650c0a1b2c3d4e5f6a7b8c9", "from": "2026-10-19", "to": "2026-11-17",
    "totals": { "calls": 18, "errors4xx": 2, "errors5xx": 1, "rateLimited": 1, "aborted": 0 },
    "rows": [{ "day": "2026-11-17", "route": "GET /public/v1/places", "calls": 10, "errors4xx": 2, "errors5xx": 0, "rateLimited": 1, "aborted": 0 }]
  } }
  ```
  `calls` conta ogni richiesta di una chiave valida (anche quelle rifiutate); `errors4xx` le risposte `4xx` diverse da `429`; `rateLimited` i `429` (limite al minuto o quota, della chiave o del gruppo); `aborted` le richieste che il client ha interrotto prima della fine della risposta (contate anche in `calls`, qualunque fosse lo stato); `route` è il pattern, mai il percorso concreto. Le richieste con una chiave sconosciuta o rifiutata non si contano.
- **Errori:** comuni; `403`; `404`; `422` (`from`/`to` con `format` per una data che non esiste o `pattern`; `from` con `incorrect` se è dopo `to` e `maximum` oltre i 92 giorni)

## Media (`/v1`)

Le immagini di un gruppo (`files` del database del gruppo, oggetti nel bucket di Google Cloud Storage nel formato `<groupId>/media/image/<xs|s|m|l|xl>/<basename>` del legacy). Route di gruppo (`group: true`), permesso **`companies:update`** (l'elenco dei permessi ammessi crescerà con le altre entità che hanno immagini): PSA, D e SA nel proprio perimetro, il CA, mai il PA. **Proprietario.** Ogni immagine caricata ha un proprietario: `companyId` (l'azienda a cui appartiene, oppure `null` per un'immagine di tutto il gruppo) e, nel documento, `createdBy` (l'utente che l'ha caricata). Il **CA** carica, elenca e legge **solo le immagini delle proprie aziende** (un'immagine senza `companyId`, come ogni immagine del legacy, non è sua: `404` in lettura, assente dall'elenco); PSA, D e SA vedono tutte le immagini del gruppo. Qualsiasi ruolo può filtrare l'elenco con `companyId`. In questo passo le immagini non si modificano, né si mettono nel cestino, né si eliminano.

**Rappresentazione dell'immagine** (tollerante: un documento legacy a cui manca un campo dà `''` o `null`, mai un `500`; `companyId` è l'id esadecimale dell'azienda o `null`):
```json
{
  "data": {
    "id": "6734a1c2e9b1d4a0012ab3f1", "name": "Logo Bar", "title": "Logo Bar", "alt": "Logo Bar", "companyId": null,
    "extension": "png", "mimetype": "image/png", "createdAt": "2026-11-13T10:00:00.123Z",
    "urls": {
      "xs": "https://files.esempio.it/665f1c2e9b1d4a0012ab34a1/media/image/xs/logo-bar-1a2b3c4d.png",
      "s": "…/s/logo-bar-1a2b3c4d.png", "m": "…/m/…", "l": "…/l/…", "xl": "…/xl/…"
    }
  }
}
```
`urls` è `${filesHost del gruppo}/${groupId}/media/image/${taglia}/${basename}` (il nome del file codificato per URL) quando `filesHost` del gruppo è un URL `https` valido (senza credenziali, query o frammento), altrimenti `null`. Le taglie sono larghezze di 100, 250, 500, 800 e 1200 pixel (mai ingrandite: un'immagine più piccola ha la sua larghezza in tutte le taglie), nello stesso formato del file caricato.

### POST /v1/groups/{groupId}/media/images
- **Autenticazione e permesso:** Bearer backoffice, `companies:update`. Limiti, oltre a quello generale: 30 upload al minuto per utente (`RATE_LIMIT_MEDIA_UPLOAD_PER_USER`), **300 al giorno per utente** (`RATE_LIMIT_MEDIA_UPLOAD_PER_USER_DAILY`) e **2000 al giorno per gruppo** (`RATE_LIMIT_MEDIA_UPLOAD_PER_GROUP_DAILY`, conta solo le richieste arrivate al gruppo dopo la verifica del permesso); `429 RATE_LIMITED` con `Retry-After` (fino a un giorno per le quote giornaliere). Le finestre giornaliere sono fisse (24 ore UTC).
- **Query:** `companyId` (24 esadecimali, opzionale): l'azienda a cui appartiene l'immagine. Il **CA deve darlo** e solo per le proprie aziende (`422 companyId required` se manca, `404` se non è una sua azienda); PSA, D e SA possono ometterlo (immagine di tutto il gruppo). L'azienda deve esistere nel gruppo e non essere nel cestino (`422 companyId incorrect`). Una query con altri parametri o con `companyId` ripetuto è `422`; la query si controlla **prima** di leggere il body.
- **Body:** `multipart/form-data` con **un solo file nel campo `file`** e nessun altro campo o parte; al massimo 10 MB. Il tipo si riconosce **dai byte** del file (JPEG, PNG o WebP), non dal tipo dichiarato né dal nome: SVG, GIF e tutto il resto sono rifiutati. L'immagine ha al massimo 40 megapixel e un lato di al più 16383 pixel.
- **Comportamento:** l'immagine viene decodificata, raddrizzata secondo l'orientamento EXIF e **privata di ogni metadato** (EXIF, posizione, profili, commenti); si producono le cinque taglie; il nome del file è generato dal server (`<nome originale ridotto a lettere minuscole, cifre e trattini>-<8 esadecimali casuali>.<jpg|png|webp>`) e `title` e `alt` sono il nome originale senza estensione. L'immagine va **nel gruppo dell'URL** (anche per un PSA o un D), mai nel gruppo dell'utente. Non è una transazione: in caso di errore vengono rimossi **solo gli oggetti caricati da questa richiesta** (mai un oggetto preesistente con lo stesso nome: se il nome è occupato si riprova una volta con un altro suffisso) e non resta alcun documento. Ogni upload ha una scadenza complessiva di 60 secondi sullo storage; il server elabora poche immagini alla volta.
- **Risposta:** `201` con l'immagine, header `Location` (`/v1/groups/{groupId}/media/images/{imageId}`)
- **Errori:** comuni; `403`; `404` (gruppo fuori perimetro); `413` (più di 10 MB); `415` (la richiesta non è `multipart/form-data`, oppure il file non è un JPEG, PNG o WebP); `422` (`details`: `file` `required` senza file; `file` `unknown` file in un campo diverso da `file`; `(body)` `unknown` campi di testo o più file; `file` `incorrect` immagine danneggiata, con più di 40 megapixel o con un lato oltre 16383 pixel, o WebP animato: anche un file troncato o con avvisi del decodificatore); `400 BAD_REQUEST` (body multipart non valido); `429`; `503 SERVICE_UNAVAILABLE` se lo storage non è configurato (`MEDIA_STORAGE=disabled`, prima di leggere il body), non risponde, oppure il server ha troppi upload in corso (con `Retry-After: 5`); `422` anche per `companyId` (`required`, `incorrect`)

### GET /v1/groups/{groupId}/media/images
- **Autenticazione e permesso:** Bearer backoffice, `companies:update`
- **Query:** `companyId` (filtra per azienda), `limit` (1–50, predefinito 50), `cursor`, `sort` (`createdAt` o `-createdAt`, predefinito `-createdAt`: le più recenti per prime; `name`, `-name`), `q` (ricerca letterale, senza distinzione di maiuscole, su nome, titolo e nome del file)
- **Risposta:** `200` con `{ data: [immagine…], page: { limit, next } }`: solo immagini non nel cestino
- **Errori:** comuni; `403`; `404`; `422` (parametri non validi, cursore non valido)

### GET /v1/groups/{groupId}/media/images/{imageId}
- **Autenticazione e permesso:** Bearer backoffice, `companies:update`
- **Risposta:** `200` con l'immagine
- **Errori:** comuni; `403`; `404 NOT_FOUND` per un'immagine inesistente, nel cestino, che non è un'immagine o di un altro gruppo; `422` per `imageId` malformato

## Gruppi (`/v1`)

Il gruppo è il cliente della piattaforma. Tutte le route di questa sezione sono **route di gruppo**: `groupId` (24 caratteri esadecimali minuscoli) è verificato rispetto al perimetro del chiamante **prima** del permesso. Un id malformato, inesistente o fuori perimetro dà lo **stesso** `404 NOT_FOUND`: un dealer raggiunge solo i propri gruppi, un SA solo il proprio, CA e PA non hanno i permessi dei gruppi (`403 FORBIDDEN`); un gruppo sospeso o nel cestino è raggiungibile solo dal PSA (`404` per gli altri). L'elenco è `GET /v1/groups` ("Dati di riferimento"). Errori comuni: `401 UNAUTHENTICATED` / `TOKEN_EXPIRED`, `403 FORBIDDEN`, `403 PASSWORD_CHANGE_REQUIRED`, `404 NOT_FOUND`.

Rappresentazione del gruppo:
```json
{
  "id": "665f1c2e9b1d4a0012ab34a1",
  "name": "Gruppo Esempio",
  "description": null,
  "dealerId": "665f1c2e9b1d4a0012ab34d1",
  "status": "active",
  "trashed": false,
  "demo": false,
  "features": { "cash": true, "rooms": true, "ordering": false, "warehouse": true, "tobaccosGamesMonopoly": false, "productsVariants": true, "services": false, "appointments": false, "customersApp": false, "media": false, "email": false, "scales": false, "delivery": false, "autoDepartments": false, "advancedProducts": false },
  "languages": ["it", "en"],
  "statsSettings": { "openingTime": "05:00", "compressProductsCategories": false, "timeSlots": [{ "from": "09:00", "to": "13:00" }] },
  "integrations": {
    "easyappear": { "enabled": false, "apiKeySet": false },
    "yellgo": { "enabled": true, "apiKeySet": true },
    "leggimenu": { "enabled": false, "apiKeySet": false },
    "plateform": { "enabled": false, "apiKeySet": false },
    "cooperto": { "enabled": false, "apiKeySet": false },
    "qodeup": { "enabled": false, "apiKeySet": false },
    "statmanager": { "enabled": false, "apiKeySet": false }
  },
  "publicApi": { "enabled": false, "defaultRateLimitPerMinute": 60, "defaultDailyQuota": 10000, "groupRateLimitPerMinute": 120, "groupDailyQuota": 20000 },
  "priceLists": [{ "id": "Zk3vQ0aT9bX2mN7pLw4HcA", "name": "Listino base", "enabled": true, "isDefault": true }],
  "taxes": [{ "id": "n1P8xQwR2cV5tYb7KdLm0g", "rate": 22, "department": 1, "description": null, "vatNature": null }],
  "currencies": [{ "code": "EUR", "symbol": "€" }],
  "measureUnits": [{ "id": "q7HfT1uE4sA9zB3nXkC6Mw", "value": "pz" }],
  "warehouseRules": [{ "id": "b2JdU8oY5rG1vF6hPzL3Qe", "type": "load", "name": "Carico da fornitore", "quantity": "+", "value": "+", "useLoadUnit": false, "counterpart": "suppliers", "isDefault": true, "cashLoad": false, "cashUnload": false }],
  "fidelityCardRules": [{ "currency": "EUR", "pointValue": null, "discountPercentage": null }],
  "dataCluster": "cluster0",
  "createdAt": "2024-02-01T10:00:00.000Z",
  "updatedAt": "2026-11-06T08:30:00.000Z"
}
```
`features` ha sempre le 15 feature del catalogo, `false` se nel documento mancano o non sono booleane. `description` e le date possono essere `null`. `languages` sono codici ISO 639-1. `statsSettings.timeSlots` ha ore intere (`from` da `00:00` a `23:00`, `to` da `01:00` a `24:00`). `integrations` ha sempre i sette provider (`easyappear`, `yellgo`, `leggimenu`, `plateform`, `cooperto`, `qodeup`, `statmanager`): `apiKeySet` dice solo se una chiave è impostata, **la chiave non è mai restituita**. `dataCluster` (l'id del cluster con i dati del gruppo, `null` per il cluster di default) è presente **solo per il PSA**. `publicApi` (le API pubbliche del gruppo, passo 9A: `enabled` è l'interruttore, spento se assente; i due limiti sono quelli che le nuove chiavi del gruppo ereditano, e valgono i default della piattaforma se il gruppo non ne ha) è presente **solo per PSA e D**: il SA non lo vede. I sei cataloghi della scheda gruppo (`priceLists` … `fidelityCardRules`) sono nel dettaglio; fidelity, preferiti e promozioni si leggono dalle loro route (sezione "Cataloghi del gruppo"). Non sono mai esposti `apiKey`, host dei dati e dei file, `type`, `plan`, scadenza, elenco dei punti vendita del sistema precedente.

### GET /v1/groups/{groupId}
- **Superficie:** backoffice
- **Autenticazione e permesso:** Bearer backoffice, `groups:read`
- **Ruoli:** PSA, D (propri gruppi) e SA (proprio gruppo); CA e PA `403`
- **Header particolari:** risposta con `ETag: W/"…"` (debole, SHA-256 del contenuto della risposta per il ruolo del chiamante) e `Cache-Control: no-store` come le altre: il browser non conserva copie; il client tiene la propria copia in memoria e la rivalida con `If-None-Match`. Con `If-None-Match` contenente il tag (anche `*` o un elenco) la risposta è `304` **senza body**. Il tag cambia a ogni modifica visibile del gruppo; due ruoli diversi possono avere tag diversi (solo il PSA vede `dataCluster`).
- **Risposta:** `200` con il gruppo (esempio sopra), oppure `304`
- **Errori:** comuni; `403 FORBIDDEN` (CA, PA)

### PATCH /v1/groups/{groupId}
- **Superficie:** backoffice
- **Autenticazione e permesso:** Bearer backoffice, `groups:update`
- **Ruoli e campi** (D-13): ogni ruolo può inviare solo i campi della propria colonna; un campo non ammesso dà `403 FORBIDDEN` con `details: [{ "field": "demo", "issue": "notAllowed" }]` e non si scrive nulla.
  | Campo | PSA | D | SA |
  |---|---|---|---|
  | `name`, `description`, `languages`, `statsSettings` | sì | sì | sì |
  | `features`, `integrations` | sì | sì | no |
  | `demo` | sì | no | no |
  | `publicApi` | sì | solo a parità di valori | no |
  Lo stato (sospensione) e il cestino non si modificano da qui: hanno le loro azioni, riservate al PSA.
- **Body** (JSON Merge Patch, massimo 16 KB, almeno un campo, nessun'altra proprietà):
  | Campo | Tipo | Vincoli |
  |---|---|---|
  | `name` | stringa | 1–200 caratteri, senza caratteri di controllo |
  | `description` | stringa o `null` | 1–1000 caratteri; `null` la svuota |
  | `languages` | array di stringhe | codici ISO 639-1 minuscoli, fino a 10, senza ripetizioni; `[]` svuota |
  | `statsSettings.openingTime` | stringa o `null` | `HH:mm` |
  | `statsSettings.compressProductsCategories` | booleano | |
  | `statsSettings.timeSlots` | array | fino a 48 elementi `{ "from": "HH:00", "to": "HH:00" }`, ore intere (`from` 00–23, `to` 01–24); se inviato sostituisce l'elenco |
  | `features` | oggetto | parziale: solo le feature inviate cambiano (le 15 del catalogo, booleani) |
  | `integrations` | oggetto | parziale per provider: `{ "<provider>": { "enabled": bool, "apiKey": string o null } }`; `apiKey` è la chiave del provider (16–256 caratteri ASCII stampabili, senza spazi), **solo impostabile**: non è mai restituita né registrata, `null` la rimuove |
  | `demo` | booleano | |
  | `publicApi` | oggetto | parziale, **solo il PSA** cambia un valore: `{ "enabled": bool, "defaultRateLimitPerMinute": intero 1–6000, "defaultDailyQuota": intero 1–10 000 000, "groupRateLimitPerMinute": intero 1–6000, "groupDailyQuota": intero 1–10 000 000 }`, ognuno facoltativo (i due `group…` sono il tetto di tutte le chiavi del gruppo insieme, default 120 al minuto e 20 000 al giorno), nessun'altra proprietà. Un D che invia un valore **diverso** dall'attuale riceve `403` con `details: [{ "field": "publicApi.enabled", "issue": "notAllowed" }]` (uno per campo cambiato) e non si scrive nulla; con gli stessi valori la richiesta è accettata. Il SA non può inviare `publicApi` (`403`, `publicApi` `notAllowed`). |
  ```json
  { "description": null, "features": { "services": true }, "integrations": { "yellgo": { "enabled": true, "apiKey": "<chiave del provider>" } } }
  ```
- **Risposta:** `200` con il gruppo aggiornato (stessa forma del dettaglio, senza `ETag`). Una richiesta che non cambia nessun valore non scrive e non registra nulla. Viene registrato `group.updated` con i valori prima e dopo (per le integrazioni solo lo stato e se la chiave è impostata, mai la chiave).
- **Errori:** comuni; `400 MALFORMED_JSON`, `413 PAYLOAD_TOO_LARGE`, `415 UNSUPPORTED_MEDIA_TYPE`; `403 FORBIDDEN` (campo non ammesso per il ruolo); `409 CONFLICT` (il documento del gruppo contiene un contenitore delle impostazioni che non è un oggetto e non può accogliere la modifica); `422 VALIDATION_ERROR` (per campo; `(body)`/`required` per body vuoto)

### POST /v1/groups/{groupId}/suspension
- **Superficie:** backoffice
- **Autenticazione e permesso:** Bearer backoffice, `groups:suspend`; solo **PSA**
- **Body:** nessuno
- **Risposta:** `200` con il gruppo (`status: "suspended"`). Il gruppo è rifiutato a tutti tranne al PSA; **tutte le sessioni degli utenti del gruppo sono revocate** (a lotti) e i loro token legacy svuotati. Eventi di sicurezza `group.suspended` e `session.revoked`.
- **Errori:** comuni; `403 FORBIDDEN`; `409 CONFLICT` (già sospeso)

### DELETE /v1/groups/{groupId}/suspension
- **Autenticazione e permesso:** Bearer backoffice, `groups:suspend`; solo **PSA**
- **Risposta:** `204` senza body. Il gruppo torna attivo; le sessioni revocate dalla sospensione restano revocate (gli utenti rifanno il login) e una sessione ancora aperta per una gara con la sospensione viene chiusa prima della riattivazione. Evento `group.reactivated`.
- **Errori:** comuni; `403 FORBIDDEN`; `409 CONFLICT` (non è sospeso)

### POST /v1/groups/{groupId}/trash
- **Autenticazione e permesso:** Bearer backoffice, `groups:trash`; solo **PSA**
- **Body:** nessuno
- **Risposta:** `200` con il gruppo (`trashed: true`), con la stessa revoca delle sessioni della sospensione. Eventi `group.trashed` (sicurezza e dati) e `session.revoked`. Nessuna API elimina definitivamente un gruppo: l'eliminazione avviene solo con lo strumento da riga di comando `purge:trashed-groups` (`doc/Technical-Guide.md`).
- **Errori:** comuni; `403 FORBIDDEN`; `409 CONFLICT` (già nel cestino)

### POST /v1/groups/{groupId}/restore
- **Autenticazione e permesso:** Bearer backoffice, `groups:trash`; solo **PSA**
- **Body:** nessuno
- **Risposta:** `200` con il gruppo (`trashed: false`); come la riattivazione chiude prima le sessioni rimaste aperte. Eventi `group.restored` (sicurezza e dati).
- **Errori:** comuni; `403 FORBIDDEN`; `409 CONFLICT` (non è nel cestino)

### GET /v1/groups/{groupId}/services
- **Superficie:** backoffice
- **Autenticazione e permesso:** Bearer backoffice, `users:read`; il gruppo deve avere la feature `services` (altrimenti `403 FEATURE_DISABLED`)
- **Ruoli:** i ruoli con il permesso, nel proprio perimetro
- **Query:** `limit` (1–100, default 50), `cursor`, `sort` (`name`, anche `-name`; default `name`), `q` come nelle "Liste"; `q` cerca nel nome
- **Risposta:** `200`: i servizi del gruppo (prodotti di tipo servizio non nel cestino) in forma compatta, per la scelta di `serviceIds` nella scheda utente. `name` è il nome nella lingua dell'utente che chiama, o nella prima lingua disponibile (stringa vuota se manca)
  ```json
  { "data": [{ "id": "665f1c2e9b1d4a0012ab34f0", "name": "Taglio donna" }], "page": { "limit": 50, "next": null } }
  ```
- **Errori:** comuni; `403 FORBIDDEN`, `403 FEATURE_DISABLED`; `422` (parametri o cursore non validi)

### GET /v1/groups/{groupId}/lookup/products
### GET /v1/groups/{groupId}/lookup/product-categories
### GET /v1/groups/{groupId}/lookup/customers
### GET /v1/groups/{groupId}/lookup/contact-groups
- **Superficie:** backoffice. Letture compatte **in sola lettura** per i selettori dei preferiti e delle promozioni (in attesa dei domini completi), sul modello di `/services`.
- **Autenticazione e permesso:** Bearer backoffice, `products:read` (lo stesso di preferiti e promozioni, che le usano: PSA e D sempre, gli altri ruoli secondo `products.r`); route di gruppo (stesso perimetro e stessi `404` delle altre); **nessuna feature richiesta**.
- **Query:** `limit` (1–100, default 50), `cursor`, `sort` (`name`, anche `-name`; default `name`), `q` (cerca nel nome, testo letterale senza distinzione di maiuscole), `ids` (facoltativo: da 1 a 100 id separati da virgola, per risolvere i nomi degli elementi già scelti; id di altri gruppi, inesistenti o nel cestino non compaiono; si combina con `q` e con la paginazione). Solo `/lookup/products` accetta anche `type` (`product`, `service`, `exempt`, `tobaccos`, `games`, `monopoly`; altro valore è `422`) e `modifier` (`true` o `false`, altro valore o parametro ripetuto `422`): con `true` solo i prodotti-variante non cestinati (`variant.status` esattamente `true`, i prodotti che una categoria può avere come modificatori), con `false` solo gli altri (`variant.status` assente o diverso da `true`), senza il parametro tutti i prodotti non cestinati come prima; si combina con `q`, `ids`, `type` e il cursore, forma della risposta invariata. Parametri sconosciuti, `ids` non valido o con più di 100 id: `422`.
- **Risposta:** `200`, elenco ordinato per nome con `page` (`limit`, `next`); solo i campi sotto, mai altri dati del documento:
  | Route | Elemento | Elementi inclusi |
  |---|---|---|
  | `/lookup/products` | `{ "id", "name", "type" }` | prodotti non nel cestino; `name` per lingua come i servizi (lingua dell'utente, ripiego sulla prima disponibile, `""` se manca); `type` è `null` se assente o non testo |
  | `/lookup/product-categories` | `{ "id", "name" }` | categorie non nel cestino; `name` per lingua come sopra |
  | `/lookup/customers` | `{ "id", "name" }` | contatti con `customer: true` non nel cestino (i fornitori non compaiono); `name` è la ragione sociale, altrimenti "nome cognome"; i valori nel formato cifrato del vecchio sistema non si mostrano (`""` se non resta nulla); nessuna email, telefono o indirizzo |
  | `/lookup/contact-groups` | `{ "id", "name" }` | gruppi di contatti (senza cestino); `name` è una stringa |
  ```json
  { "data": [{ "id": "665f1c2e9b1d4a0012ab34f0", "name": "Shampoo", "type": "product" }], "page": { "limit": 50, "next": null } }
  ```
- **Errori:** comuni; `403 FORBIDDEN`; `404` (gruppo fuori perimetro); `422` (parametri o cursore non validi)
- **Cache:** `ETag` e `304` con `If-None-Match` (vedi "Liste")
- `/services` resta invariato (permesso `users:read` e feature `services`, per la scheda utente).

### GET /v1/groups/{groupId}/lookup/price-lists
- **Superficie:** backoffice. Elenco compatto dei listini del gruppo, per assegnarli agli utenti e ai tipi di carta (CA e PA non hanno `groups:read`); la modifica dei listini resta a PSA, D, SA (`/price-lists`).
- **Autenticazione e permesso:** Bearer backoffice, **almeno uno** tra `users:read`, `fidelity:read` e `groups:read` (l'elenco compatto non è sensibile; serve alla scheda utente e ai tipi di carta fedeltà); `403` se il chiamante non ne ha nessuno. Route di gruppo (stesso perimetro e stessi `404` delle altre); nessuna feature richiesta.
- **Risposta:** `200`, `{ "data": [{ "id", "name", "enabled", "isDefault" }] }`, senza paginazione (al massimo 50 listini, come `GET /price-lists`); solo i listini, mai altri dati del gruppo.
  ```json
  { "data": [{ "id": "665f1c2e9b1d4a0012ab34f0", "name": "Listino 1", "enabled": true, "isDefault": true }] }
  ```
- **Errori:** comuni; `403 FORBIDDEN`; `404` (gruppo fuori perimetro)
- **Cache:** `ETag` e `304` con `If-None-Match` (vedi "Liste")

### GET /v1/groups/{groupId}/lookup/email-templates
- **Superficie:** backoffice. Elenco compatto dei modelli di e-mail del gruppo (`email_templates`), per scegliere i `templateId` delle prenotazioni e degli appuntamenti di un punto vendita (passo 7D).
- **Autenticazione e permesso:** Bearer backoffice, `places:update` (PSA, D, SA, CA e PA: chi può salvare un punto vendita). Nessuna feature.
- **Query:** come le altre letture compatte (`limit` 1–100, `cursor`, `sort=name`, `q`, `ids` 1–100).
- **Risposta:** `200`, `{ "data": [{ "id", "name" }], "page": { "limit", "next" } }`, per nome, senza i modelli nel cestino; mai il testo né l'HTML. Un nome che non è un testo è `""`.
- **Errori:** comuni; `403`; `404` (gruppo fuori perimetro); `422`
- **Cache:** `ETag` e `304` con `If-None-Match` (vedi "Liste")

### GET /v1/groups/{groupId}/lookup/taxes
- **Superficie:** backoffice, route di gruppo, non aperta alla chiave di negozio. **Permesso:** almeno uno tra `products:read` e `groups:read` (così un CA o un PA che gestisce i reparti sceglie l'aliquota senza `groups:read`). Senza paginazione (al massimo 30 aliquote), con `ETag`.
- **Risposta:** `200` `{ data: [{ id, rate, department, vatNature, description }] }`, gli stessi nomi di `/taxes`, letti in modo tollerante e **nessun altro dato del gruppo**. **Errori:** `401`, `403`, `404` (gruppo fuori perimetro).

### GET /v1/groups/{groupId}/lookup/languages
- **Superficie:** backoffice. Le lingue del gruppo (`settings.languages`), per i testi del kiosk (CA e PA non hanno `groups:read`).
- **Autenticazione e permesso:** Bearer backoffice, **almeno uno** tra `places:update`, `groups:read` e `products:read`.
- **Risposta:** `200`, `{ "data": [{ "code": "it" }, { "code": "en" }] }`, senza paginazione; solo i codici che sono testi, `[{ "code": "it" }]` se il gruppo non ne ha.
- **Errori:** comuni; `403`; `404`
- **Cache:** `ETag` e `304`

## Nuovo cliente (`/v1`, passo 8A)

Sostituisce il form "Nuovo cliente" e `groups/generate` del legacy: **una sola operazione atomica e idempotente** che crea il gruppo, il suo super amministratore (SA), la prima azienda, il primo punto vendita e i reparti, in una transazione sul cluster comune. Il gruppo nasce sempre sul cluster comune (D-25): `dataCluster` non è accettato.

### POST /v1/groups
- **Superficie:** backoffice
- **Autenticazione e permesso:** Bearer backoffice, `groups:create` (nel tetto di PSA e D soltanto: SA, CA, PA ed E `403`)
- **Header:** `Idempotency-Key` obbligatorio (UUID, vedi "Idempotenza" in "Punti vendita"): la stessa chiave con lo stesso body dà la stessa risposta e **non crea un secondo gruppo**; con un body diverso `409` (`issue: "reused"`). Una richiesta che fallisce libera la chiave. Limite per utente come le creazioni di utenti (ogni creazione calcola un hash scrypt): oltre la soglia `429 RATE_LIMITED` con `Retry-After`
- **Body** (`application/json`, massimo 32 KB; allowlist: ogni chiave non elencata è `422` `unknown`):
  - `group`: `name` (1–200, obbligatorio); `features` (facoltativo, oggetto con le 15 feature del catalogo, ognuna booleana e facoltativa: libere per PSA e D; senza indicazione valgono `cash` e `productsVariants` accese, le altre spente); `demo` (booleano, **solo PSA**); `dealerId` (24 esadecimali, **solo PSA**).
  - `company`: `name` (1–150) e `vatNumber` (1–30) obbligatori; `address` con `street`, `postcode`, `city`, `country` (ISO alpha-2 maiuscolo) obbligatori e `province` facoltativa; `fiscalCode`, `email`, `phone` facoltativi; `eInvoicing` facoltativo con `recipientCode` (6–7 caratteri alfanumerici, maiuscolo), `pec` (indirizzo e-mail). Il form non ha l'hub di fatturazione: è sempre vuoto (`hub` è `422` `unknown`).
  - `place`: `name` (1–150, l'insegna) obbligatorio; `address` facoltativo (`street`, `postcode`, `city` obbligatori e `province` facoltativa: è la casella "dati diversi dall'azienda" del form; senza, il punto vendita ha l'indirizzo dell'azienda; il paese è quello dell'azienda); `contactName`, `email`, `phone` facoltativi; `plan` (`basic`, `advanced`, `enterprice`, `tgm-secondary`, `desk-secondary`; senza `advanced`); `expirationDate` (data-ora ISO 8601 UTC, oppure una sola data `2030-12-31` che vale la fine di quel giorno, 23:59:59 `Europe/Rome`; senza, il 31 dicembre dell'anno corrente alle 23:59:59 `Europe/Rome`; `null` non è ammesso).
  - `user`: l'SA del nuovo gruppo, con `username` (stesse regole dello username, univoco senza distinguere maiuscole, D-15) e `password` (**provvisoria**, policy D-19: 12–128 caratteri) obbligatori; `firstName`, `lastName`, `email`, `phone` facoltativi. L'SA deve cambiare la password al primo accesso.
  - `taxes`: da 1 a 30 aliquote `{ rate (0–100), department (1–99) }`, ciascuna con il proprio reparto (reparti ripetuti `422` `incorrect` su `taxes.<i>.department`).
  - **Mai accettati**: `role`, permessi, `status`, `apiKey`, `dataCluster`, id, `groupId`, né altri campi.
  ```json
  { "group": { "name": "Nuovo Cliente", "features": { "rooms": true } },
    "company": { "name": "Cliente Srl", "vatNumber": "00743110157", "address": { "street": "Via Roma 1", "postcode": "20100", "city": "Milano", "province": "MI", "country": "IT" }, "eInvoicing": { "recipientCode": "ABC1234" } },
    "place": { "name": "Insegna Centro", "plan": "advanced" },
    "user": { "username": "mario.rossi", "password": "provvisoria-lunga", "firstName": "Mario", "lastName": "Rossi" },
    "taxes": [{ "rate": 10, "department": 1 }, { "rate": 22, "department": 2 }] }
  ```
- **Regole per ruolo** (`403 FORBIDDEN` con `details` `{ field, issue: "notAllowed" }` per ogni campo non ammesso): il **dealer** è sempre il dealer del gruppo e dell'SA (`group.dealerId` `403`); non può creare un gruppo `demo` (`group.demo`), né scegliere il piano `desk-secondary` (`place.plan`). Il **PSA** può indicare un `dealerId` (un dealer attivo e non nel cestino, altrimenti `404 NOT_FOUND`) o nessuno.
- **Regole sui dati** (`422`, tutti i campi insieme): paese esistente e provincia tra quelle del paese; partita IVA italiana con cifra di controllo (all'estero 2–30 caratteri ASCII stampabili) e codice fiscale italiano valido (maiuscolo); **un'azienda italiana ha almeno uno tra `eInvoicing.recipientCode` e `eInvoicing.pec`** (`company.eInvoicing.recipientCode` `required`); la provincia dell'indirizzo del punto vendita è del paese dell'azienda; password secondo D-19 (`user.password` con `tooShort`, `tooLong`, `sameAsUsername`).
- **Cosa viene creato**, in una sola transazione (o tutto o niente, **database del gruppo compreso**: le collection nascono con gli inserimenti): il gruppo nel formato legacy con tutte le chiavi che i lettori del legacy e del POS leggono senza controlli (feature, sette integrazioni spente, un listino predefinito, EUR, unità `pz`, tre regole di magazzino standard, aliquote, regole delle carte fedeltà, `fidelity`), l'SA con la matrice completa del suo ruolo, le opzioni della cassa con il listino predefinito e l'ambito di tutto il gruppo, l'azienda e il punto vendita con la loro copia nel common e `groups.places[]`, un reparto per aliquota nel database del gruppo. `groups.apiKey` (la chiave del gruppo che usano il POS e le app legacy) è generata dal server con 256 bit casuali: **non è mai restituita, né registrata, né accettata come credenziale da questo backend** (`401`).
- **Header particolari:** `Location: /v1/groups/{groupId}`
- **Risposta:** `201`
  ```json
  { "data": { "groupId": "665f1c2e9b1d4a0012ab34a1", "companyId": "665f1c2e9b1d4a0012ab34c1", "placeId": "665f1c2e9b1d4a0012ab34e1", "userId": "665f1c2e9b1d4a0012ab34f1" } }
  ```
  Mai la password né la chiave del gruppo. Le risorse si leggono con le route di gruppo, azienda, punto vendita e utente.
- **Registro attività:** `group.created`, `company.created`, `place.created` e `user.created` (con l'id del nuovo gruppo), senza password, chiavi né hash.
- **Errori:** comuni; `403` (ruolo, campi riservati), `404` (dealer inesistente, disattivato o nel cestino), `409` (`user.username` `taken`; chiave di idempotenza riusata con un altro body o richiesta con la stessa chiave in corso), `413` (oltre 32 KB), `415`, `422` (`Idempotency-Key` mancante o non valido, regole sopra), `429`
- **Username proposto (8.1.4):** il wizard propone lo username dal nome e cognome come il legacy (`nome.cognome` in minuscolo, senza spazi) e ne verifica la disponibilità con `GET /v1/usernames/{username}/availability` (`users:create`, nel tetto di PSA e D, stessa regola D-15 della creazione, 15 richieste al minuto): il suggerimento è del client, il server non ne aggiunge uno.

## Cataloghi del gruppo (`/v1`)

Undici elenchi custoditi nel documento del gruppo, ciascuno una sotto-risorsa REST di `/v1/groups/{groupId}`. Sono **route di gruppo** (stesso controllo di perimetro e stessi `404` della sezione precedente; un gruppo sospeso o nel cestino solo per il PSA). Regole comuni:
- **Permessi.** I sei elenchi della scheda gruppo seguono `groups:read` (lettura) e `groups:update` (scrittura): PSA, D e SA. I tipi di carta, le raccolte punti e i cataloghi premi seguono `fidelity:read` / `fidelity:update`; i preferiti e le promozioni `products:read` / `products:update`. Questi ultimi permessi li hanno PSA e D sempre e gli altri ruoli secondo la matrice dell'utente (`fidelity.r/w` e `products.r/w`).
  | Famiglia | Permessi | PSA | D | SA | CA | PA |
  |---|---|---|---|---|---|---|
  | `price-lists`, `taxes`, `currencies`, `measure-units`, `warehouse-rules`, `fidelity-card-rules` | `groups:read` / `groups:update` | sì | sì | secondo `groups.r/w` | no | no |
  | `fidelity/card-types`, `fidelity/points-collections`, `fidelity/prize-catalogues` | `fidelity:read` / `fidelity:update` | sì | sì | secondo `fidelity.r/w` | secondo `fidelity.r/w` | secondo `fidelity.r/w` |
  | `product-favorites`, `promotions` | `products:read` / `products:update` | sì | sì | secondo `products.r/w` | secondo `products.r/w` | secondo `products.r/w` |
  Con i valori predefiniti per un utente nuovo: `fidelity` è attivo solo per il SA; `products` per SA, CA e PA.
- **Operazioni.** `GET` elenco (`200`, `{ "data": [ … ] }`, senza paginazione né `page`: ogni catalogo ha un limite di elementi); `POST` crea (`201` con l'elemento e `Location: /v1/groups/{groupId}/<segmento>/{id}`; l'`id` è generato dal server e non si può inviare, tranne il codice delle valute); `PATCH /{id}` modifica (JSON Merge Patch: ciò che non è inviato resta, `null` svuota i campi nullable, un array inviato sostituisce quello salvato; almeno un campo, altrimenti `422` `(body)`/`required`; `200` con l'elemento, e una richiesta che non cambia nulla non scrive); `DELETE /{id}` (`204`). `/fidelity-card-rules` ha solo `GET` e `PUT /{currency}`. Un `{id}` sconosciuto o non valido è `404`; un metodo non previsto `405`.
- **Forma dei dati.** Gli elementi sono scritti nel formato del vecchio sistema, con i suoi tipi; i campi che il nuovo sistema non gestisce restano nel documento. Un valore memorizzato non valido si mostra come `null` o come valore predefinito e non fa fallire la lettura.
- **Concorrenza.** Ogni scrittura è una sola modifica del documento del gruppo, condizionata a non essere cambiato dopo la lettura: se due modifiche si incrociano la seconda riceve `409 CONFLICT` (senza dettagli) e può riprovare.
- **Riferimenti.** Gli id che un elemento nomina (punti vendita, prodotti, categorie, contatti, gruppi di contatti) devono esistere nel gruppo e non essere nel cestino: altrimenti `422 VALIDATION_ERROR` con `details` `{ "field": "<campo>.<indice>", "issue": "incorrect" }` (al massimo 20), verificati solo per i campi inviati. Un listino, una raccolta o un catalogo premi **non si elimina se altri elementi del gruppo lo usano**: `409 CONFLICT` con `details` `[{ "field": "cardTypes.<id>", "issue": "referenced" }, …]` (il vecchio sistema lo permetteva).
- **Limiti.** Creare oltre il limite del catalogo dà `422` `(body)`/`tooMany`; un documento che supera 8 MiB con la scrittura dà lo stesso errore (una scrittura che non lo fa crescere è sempre ammessa). Body: 100 KB di default, 256 KB per le promozioni, 1 MB per i cataloghi premi.
- **Eventi.** Ogni scrittura registra `group.<catalogo>.created|updated|deleted` con l'elemento prima e dopo.
- **Errori comuni:** `401 UNAUTHENTICATED` / `TOKEN_EXPIRED`, `403 FORBIDDEN`, `403 PASSWORD_CHANGE_REQUIRED`, `404 NOT_FOUND`, `405 METHOD_NOT_ALLOWED`, `409 CONFLICT`, `400 MALFORMED_JSON`, `413 PAYLOAD_TOO_LARGE`, `415 UNSUPPORTED_MEDIA_TYPE`, `422 VALIDATION_ERROR`.
- **Valute e fedeltà.** Per ogni valuta del gruppo esiste una regola fedeltà (`fidelity-card-rules`): si crea con la valuta e si toglie con la valuta.

### /v1/groups/{groupId}/price-lists
Listini. Elemento: `{ "id", "name", "enabled", "isDefault" }`. Limite 50.
- `POST` `{ "name": "Listino asporto", "enabled": true, "isDefault": false }`: `name` obbligatorio (1–100 caratteri), `enabled` default `true`, `isDefault` default `false`. Il **primo** listino del gruppo è per forza il predefinito (`isDefault: false` esplicito è `422` `isDefault`/`incorrect`).
- `PATCH /{id}` `{ "name"?, "enabled"?, "isDefault"? }`. Impostare `isDefault: true` toglie il flag al listino che lo aveva, nella stessa scrittura (c'è sempre esattamente un predefinito); `isDefault: false` sul predefinito è `422` `isDefault`/`incorrect`.
- Il nome è unico senza distinguere le maiuscole: `409` `name`/`taken`.
- `DELETE /{id}`: `409` con `id`/`default` per il predefinito, `id`/`last` per l'ultimo listino, `cardTypes.<id>`/`referenced` se un tipo di carta lo usa.

### /v1/groups/{groupId}/taxes
Aliquote. Elemento: `{ "id", "rate", "department", "description", "vatNature" }`. Limite 30.
- `POST` `{ "rate": 22, "department": 1, "description": "IVA ordinaria", "vatNature": null }`: `rate` obbligatorio (numero 0–100, percentuale); `department` intero 1–99 o `null` (reparto fiscale); `description` 1–200 caratteri o `null`; `vatNature` uno tra `N1`, `N2.1`, `N2.2`, `N3.1`…`N3.6`, `N4`, `N5`, `N6.1`…`N6.9` o `null` (natura IVA della fattura elettronica). Una natura memorizzata fuori elenco si mostra così com'è.
- `PATCH /{id}` con gli stessi campi, tutti facoltativi. `DELETE /{id}`.
- **Reparti** (passo C1): i reparti del gruppo tengono una copia dell'aliquota (`products_departments.tax`). Una modifica dell'aliquota **riallinea la copia** nei reparti con lo stesso `tax.id`, scrivendo **solo le cinque chiavi** `tax.id`, `tax.value`, `tax.department`, `tax.description`, `tax.natura` (le altre chiavi dell'oggetto `tax` restano; aggiorna anche la data di modifica di quei reparti, che il POS usa per gli aggiornamenti incrementali). Se il gruppo è sul cluster del database comune l'aliquota e le copie si scrivono in **una transazione**; se è su un altro cluster l'aliquota si scrive per prima e le copie subito dopo, e poiché il riallineamento tocca solo le copie che differiscono, **ripetere la stessa `PATCH`** (una richiesta che non cambia nulla) completa quanto un'interruzione avesse lasciato. `DELETE /{id}` di un'aliquota che un reparto tiene è `409 CONFLICT` con `details` `[{ "field": "productDepartments.<id>", "issue": "referenced" }]` (al massimo 20). Lo stesso riallineamento vale, dal passo C3, per i **prezzi dei prodotti** (`taxData`) e l'eliminazione di un'aliquota usata da un prezzo è `409` `products.<id>` (vedi "Catalogo: prodotti").

### /v1/groups/{groupId}/currencies
Valute. Elemento: `{ "code", "symbol" }`; l'id nell'URL è il **codice**. Limite 10.
- `POST` `{ "code": "USD", "symbol": "$" }`: `code` tre lettere maiuscole (solo la sintassi ISO 4217, il registro non è verificato), già presente `409` `code`/`taken`; `symbol` 1–8 caratteri senza `<`, `>`, `&`, `"`, `'` né caratteri di controllo. Crea anche la regola fedeltà della valuta (valori `null`).
- `PATCH /{code}` `{ "symbol" }`. `DELETE /{code}` elimina anche la regola fedeltà.
- Il vecchio sistema memorizza il simbolo come entità HTML: l'API mostra e accetta il **carattere**. Conversione solo per i simboli noti, in entrambi i versi: `&euro;` `€`, `&pound;` `£`, `&yen;` `¥`, `&cent;` `¢`, `&curren;` `¤`, `&#8377;` `₹`, `&#8381;` `₽` (`&#8364;` si legge `€`). Ogni altro simbolo si conserva così com'è.

### /v1/groups/{groupId}/measure-units
Unità di misura. Elemento: `{ "id", "value" }`. Limite 50.
- `POST` `{ "value": "kg" }`: `value` 1–20 caratteri, unico senza distinguere le maiuscole (`409` `value`/`taken`). `PATCH /{id}` `{ "value" }`. `DELETE /{id}` (i prodotti che usano il testo non sono controllati).

### /v1/groups/{groupId}/warehouse-rules
Regole di magazzino (causali). Elemento: `{ "id", "type", "name", "quantity", "value", "useLoadUnit", "counterpart", "isDefault", "cashLoad", "cashUnload" }`. Limite 50.
- `type`: `load` (carico) o `unload` (scarico); `quantity` e `value` (come un movimento cambia giacenza e valore): `=`, `+`, `-`; `counterpart`: `suppliers`, `customers`, `indoor`; `useLoadUnit` (solo per gli scarichi: usa l'unità del carico); `cashLoad` e `cashUnload`: la regola di carico (reso) e di scarico (vendita) che usa la cassa, al massimo una per gruppo. `isDefault` indica le regole standard create col gruppo.
- `POST`: `type`, `name` (1–100 caratteri), `quantity`, `value`, `counterpart` obbligatori; `useLoadUnit`, `cashLoad`, `cashUnload` facoltativi. Una regola creata dal client non è mai predefinita.
- `PATCH /{id}`: gli stessi campi tranne `type` (non si cambia). Le regole predefinite non si modificano né si eliminano: `409` `id`/`default`. `useLoadUnit: true` solo su uno scarico, `cashLoad: true` solo su un carico, `cashUnload: true` solo su uno scarico (`422` `notAllowed`); se un'altra regola ha già il flag `409` `cashLoad`/`taken` o `cashUnload`/`taken`.

### /v1/groups/{groupId}/fidelity-card-rules
Regole delle carte fedeltà, una per valuta. Elemento: `{ "currency", "pointValue", "discountPercentage" }`. Solo `GET` e `PUT`.
- `GET`: una voce per ogni valuta del gruppo (valori `null` se non impostata).
- `PUT /{currency}` `{ "pointValue": 0.05, "discountPercentage": null }`: entrambi obbligatori; `pointValue` numero ≥ 0 (quanto vale un punto in denaro) o `null`; `discountPercentage` 0–100 o `null`. Risposta `200` con la regola; `404` se la valuta non è del gruppo.

### /v1/groups/{groupId}/fidelity/card-types
Tipi di carta fedeltà. Permessi `fidelity:*`. Elemento: `{ "id", "enabled", "name", "discountPercentage", "priceListId", "prepaid": { "enabled", "type", "taxPercentage" }, "pointsCollect": { "enabled", "collectionIds" }, "placeIds" }`. Limite 50.
- `POST`: `name` obbligatorio (1–200 caratteri); facoltativi `enabled` (default `true`), `discountPercentage` (0–100, default 0), `priceListId` (id di un listino del gruppo o `null`), `prepaid` (`enabled`, `type` `multi` o `mono`, `taxPercentage` 0–100 o `null`), `pointsCollect` (`enabled`, `collectionIds`: fino a 50 id di raccolte punti del gruppo), `placeIds` (fino a 500 id di punti vendita del gruppo, univoci; i punti vendita in cui la carta vale).
- `PATCH /{id}` con gli stessi campi (le liste sostituiscono quelle salvate). Riferimenti: `priceListId` / `pointsCollect.collectionIds.N` non presenti nel gruppo `422` `incorrect`; `placeIds.N` che non esiste o è nel cestino `422` `incorrect`.
- **CA e PA** scrivono solo tipi di carta che valgono per punti vendita del proprio perimetro; una lista `placeIds` vuota (tutto il gruppo) è loro vietata: `403 FORBIDDEN` con `details` `placeIds`/`notAllowed` o `placeIds.N`/`notAllowed`. Modificare o eliminare un tipo di carta esistente che vale fuori dal loro perimetro o per tutto il gruppo è `403`.

### /v1/groups/{groupId}/fidelity/points-collections
Raccolte punti. Permessi `fidelity:*`. Elemento: `{ "id", "enabled", "name", "pointConversion", "minAmount", "dateFrom", "dateTo", "pointsExpirationDate", "prizeCatalogueId" }`. Limite 50.
- `pointConversion` è l'importo in denaro per un punto, `minAmount` l'importo minimo (numeri ≥ 0 o `null`); le date sono ISO 8601 o `null`; `prizeCatalogueId` un catalogo premi del gruppo o `null`.
- `POST`: `name` obbligatorio (1–200 caratteri), gli altri facoltativi (`enabled` default `true`). `PATCH /{id}`: gli stessi campi.
- `dateTo` prima di `dateFrom`: `422` `dateTo`/`incorrect`; `prizeCatalogueId` sconosciuto: `422` `incorrect`.
- `DELETE /{id}`: `409` `cardTypes.<id>`/`referenced` se un tipo di carta la usa.

### /v1/groups/{groupId}/fidelity/prize-catalogues
Cataloghi premi, con i premi dentro l'elemento. Permessi `fidelity:*`. Body fino a 1 MB. Limite 20 cataloghi, 200 premi ciascuno.
- Elemento: `{ "id", "enabled", "name", "prizes": [{ "id", "enabled", "name", "description", "pointsValue", "extraPrice", "redemptionConditions", "imageSet" }] }`. `imageSet` dice se il premio ha un'immagine; l'immagine non si gestisce da qui (la gestione dei file arriverà con il dominio dei media) e si conserva.
- `POST`: `name` obbligatorio (1–200), `enabled`, `prizes` (ogni premio con `name` obbligatorio, 1–200; `description` e `redemptionConditions` 1–1000 caratteri o `null`, `pointsValue` e `extraPrice` numeri ≥ 0 o `null`; gli id li genera il server).
- `PATCH /{id}`: se `prizes` è presente è **l'intero nuovo elenco**: un premio con l'`id` di uno esistente è quel premio (i campi omessi restano, l'immagine resta), uno senza `id` è nuovo (serve `name`), un premio esistente non nominato è eliminato. Un `id` sconosciuto o ripetuto: `422` `prizes.N.id`/`incorrect`; premio nuovo senza nome: `prizes.N.name`/`required`.
- `DELETE /{id}`: `409` `pointsCollections.<id>`/`referenced` se una raccolta punti lo usa.

### /v1/groups/{groupId}/product-favorites
Elenchi di prodotti preferiti. Permessi `products:*`. Elemento: `{ "id", "name", "products": [{ "productId", "position" }] }`. Limite 50 elenchi, 500 prodotti ciascuno.
- `POST`: `name` obbligatorio (1–200), `products` facoltativo (nell'ordine da mantenere; `productId` 24 caratteri esadecimali, `position` intero 0–100000 o `null`). `PATCH /{id}`: `name` e `products` (se presente sostituisce l'elenco).
- Ogni prodotto deve esistere nel gruppo e non essere nel cestino, e non può comparire due volte: `422` `products.N.productId`/`incorrect`.

### /v1/groups/{groupId}/promotions
Promozioni. Permessi `products:*`. Body fino a 256 KB. Limite 200 promozioni, liste interne fino a 500 id.
- Elemento:
  ```json
  {
    "id": "Hm4sV9kD2wQ7xN1bRzP5Ja",
    "enabled": true,
    "name": "Happy hour",
    "description": null,
    "code": "HAPPY",
    "conditions": {
      "placeIds": [], "startDate": "2026-12-01T00:00:00.000Z", "endDate": null,
      "customerIds": [], "contactGroupIds": [],
      "maxUsesPerUser": null, "maxUsesTotal": null, "minAmount": null,
      "currency": "EUR", "amountTax": "tax_included",
      "seatExcluded": false, "serviceExcluded": false, "tipExcluded": false, "deliveryExcluded": false,
      "products": { "type": "only_n", "n": 1, "qt": 1, "productIds": [] },
      "categories": { "type": null, "n": 1, "categoryIds": [] }
    },
    "actions": { "discountType": "on_total", "discountValue": 10, "discountValueType": "percentage", "productIds": [], "categoryIds": [], "freeShipping": false }
  }
  ```
- `POST`: `name` obbligatorio (1–200); gli altri campi hanno i valori predefiniti (`enabled` `true`, `currency` `EUR`, `amountTax` `tax_included`, `n` e `qt` 1, `discountValueType` `percentage`, flag `false`, liste vuote, il resto `null`). `PATCH /{id}`: gli stessi campi; gli oggetti `conditions`, `actions`, `products`, `categories` si fondono per campo, le liste inviate sostituiscono quelle salvate.
- Valori: `description` 1–1000 o `null`; `code` 1–50 o `null`; date ISO 8601 o `null` (salvate come testo, come nel vecchio sistema); `maxUsesPerUser` / `maxUsesTotal` interi ≥ 1 o `null`; `minAmount` ≥ 0 o `null`; `currency` tre lettere maiuscole; `amountTax` `tax_included` o `tax_excluded`; `conditions.products.type` `only_n`, `all` o `null`; `conditions.categories.type` `only_n` o `null`; `n` e `qt` interi 1–1.000.000; `actions.discountType` `on_total`, `on_products`, `on_categories` o `null`; `discountValue` ≥ 0; `discountValueType` `percentage` o `amount`. Liste di id (24 caratteri esadecimali, univoci, fino a 500): `conditions.placeIds`, `customerIds` (contatti), `contactGroupIds`, `products.productIds`, `categories.categoryIds`, `actions.productIds`, `actions.categoryIds`. `conditions.placeIds` vuota significa tutti i punti vendita del gruppo.
- Regole: fine prima dell'inizio `422` `conditions.endDate`/`incorrect`; sconto percentuale oltre 100 `422` `actions.discountValue`/`incorrect`; id inesistenti o nel cestino `422` `<campo>.<indice>`/`incorrect` (ad esempio `conditions.products.productIds.2`).
- **CA e PA** scrivono solo promozioni valide per punti vendita del proprio perimetro (`conditions.placeIds`, lista vuota vietata): `403 FORBIDDEN` con `details` `notAllowed`; modificare o eliminare una promozione che vale fuori perimetro o per tutto il gruppo è `403`.

## Diagnostica dei dispositivi (`/v1`, passo T1)

Sola lettura sulle **copie dei punti vendita** nel database comune (mai sui database dei gruppi): una riga per dispositivo di ogni punto vendita. Il perimetro lo applica il server dal ruolo; il client al massimo restringe con i filtri. Le route non sono aperte alla chiave di negozio (`403 FORBIDDEN`).

**Perimetro** (stesso per le due route): PSA tutti i gruppi; D i propri; SA il proprio gruppo; CA i punti vendita delle proprie aziende; PA i propri punti vendita. Sono sempre esclusi i gruppi nel cestino, i punti vendita nel cestino e quelli di un'azienda nel cestino. Per **PSA e D** sono esclusi anche i gruppi **demo** (come il legacy), a meno che la richiesta nomini quel gruppo con `groupId`; SA, CA e PA leggono il proprio gruppo anche se demo. Un `groupId`, `companyId` o `placeId` fuori dal perimetro non dà errore: il risultato è vuoto.

**Mai restituito**: credenziali della cassa automatica, integrazioni, `server.ip`, `connectorAddress`, host, numeri di serie, parametri dei POS e dei terminali di pagamento, hash, suggerimento, IP e user agent della chiave di negozio. Di ogni dispositivo escono solo i campi elencati sotto.

### GET /v1/diagnostics/devices
- **Superficie:** backoffice
- **Autenticazione e permesso:** Bearer backoffice, `places:read`
- **Query:**
  | Parametro | Tipo | Note |
  |---|---|---|
  | `limit` | intero 1–100 | default 50 |
  | `cursor` | opaco | quello di `page.next`; un cursore non emesso dal server è `422` (`cursor`/`format`) |
  | `groupId`, `companyId`, `placeId` | 24 caratteri esadecimali | restringono dentro il perimetro |
  | `type` | `desk`, `handheld`, `ordering`, `room-handheld`, `selfordering`, `waiting-list`, `external-display`, `kiosk`, `tgm` | |
  | `q` | testo 1–64 caratteri | cerca, in modo letterale e senza distinzione tra maiuscole e minuscole, nel nome del punto vendita e del dispositivo |
  Parametri sconosciuti (compresi `sort`) sono `422`. L'ordine è fisso: punti vendita per `_id`, dispositivi nell'ordine della lista del punto vendita.
- **Risposta:** `200` `{ data, page }` con `ETag` debole e `Cache-Control: no-store`; `If-None-Match` uguale dà `304` senza corpo. Ogni riga:
  ```json
  {
    "id": "665f1c2e9b1d4a0012ab3601:0",
    "groupId": "665f1c2e9b1d4a0012ab34a1", "groupName": "Gruppo Esempio",
    "companyId": "665f1c2e9b1d4a0012ab3501", "companyName": "Acme S.r.l.", "companyCode": "01234567890",
    "placeId": "665f1c2e9b1d4a0012ab3601", "placeName": "Bar Roma",
    "deviceId": "d1", "deviceName": "Cassa 1", "deviceType": "desk",
    "appVersion": "1.2.3", "server": true,
    "platform": "android", "platformVersion": "13", "model": "Pixel 7",
    "lastDataDownload": "2026-03-05T22:30:15.000Z", "lastSession": "2026-03-06T08:00:00.000Z",
    "storeKey": { "status": "active", "lastSeenAt": "2026-11-16T09:00:00.000Z", "appVersion": "4.5.6" }
  }
  ```
  `id` è `<placeId>:<posizione del dispositivo>`. `companyCode` è la partita IVA. I valori mancanti o del tipo sbagliato nel dato memorizzato sono `null` (i nomi `''`); le date sono ISO UTC (`null` se non sono date). `storeKey.status` è `active` (una chiave attiva, con ultimo uso e versione dell'app dichiarata allo scambio) o `none`.
- **Errori:** `401 UNAUTHENTICATED` / `TOKEN_EXPIRED`, `403 FORBIDDEN` (permesso mancante o chiave di negozio), `403 PASSWORD_CHANGE_REQUIRED`, `422 VALIDATION_ERROR`, `429 RATE_LIMITED`

### GET /v1/diagnostics/devices.csv
- **Superficie:** backoffice
- **Autenticazione e permesso:** come sopra; **rate limit** dedicato per utente (`RATE_LIMIT_DIAGNOSTICS_EXPORT_PER_USER`, 5 al minuto di default) oltre a quello generale.
- **Query:** gli stessi filtri (`groupId`, `companyId`, `placeId`, `type`, `q`), senza `limit` né `cursor` (`limit` è `422`).
- **Risposta:** `200` `text/csv; charset=utf-8` in streaming (a blocchi di 500 righe, con contropressione; il lavoro si ferma se il client chiude), `Content-Disposition: attachment; filename="devices-diagnostic_<AAAA-MM-GG>.csv"`, `Cache-Control: no-store`. UTF-8 con BOM, separatore `;`, fine riga CRLF, valori con `;`, `"` o a capo tra virgolette (`"` raddoppiate). Colonne, nell'ordine: `GRUPPO;AZIENDA;P.IVA;PUNTO VENDITA;DISPOSITIVO;TIPO;VERSIONE FLOOD;SERVER;SISTEMA;VERSIONE;MODELLO;ULT. DOWNLOAD;ULT. SESSIONE;CHIAVE NEGOZIO;ULT. USO CHIAVE;VERSIONE APP NEGOZIO` (le prime tredici come il legacy). `SERVER` è `Sì`/`No`; le date sono `gg-mm-aaaa HH:MM:SS` nel fuso `Europe/Rome`; `CHIAVE NEGOZIO` è `Attiva`/`Nessuna`; una partita IVA di sole cifre ha il prefisso `_` (come il legacy, per non perdere gli zeri in Excel). **Iniezione di formule**: un valore che inizia con `=`, `+`, `-`, `@`, tabulazione o ritorno a capo riceve un `'` iniziale. Senza righe il file ha solo l'intestazione.
- **Limite:** al massimo **50 000 righe**; oltre, `413 PAYLOAD_TOO_LARGE` prima del primo byte (si restringe con i filtri); il file non supera mai il tetto nemmeno se dopo il conteggio si aggiungono righe. Un solo export alla volta per utente (un secondo è `429 RATE_LIMITED`) e al massimo 5 minuti di durata (poi la connessione si chiude).
- **Errori:** `401`, `403 FORBIDDEN`, `403 PASSWORD_CHANGE_REQUIRED`, `413 PAYLOAD_TOO_LARGE`, `422 VALIDATION_ERROR`, `429 RATE_LIMITED`

## Documenti in errore (`/v1`, passo 9-ter/3)

Le **fatture e note di credito elettroniche** inviate tramite l'hub Aruba che si trovano nella **coda di invio del legacy** con un errore. Sola lettura: nessun riprova, nessun "gestita manualmente", nessuna scrittura (il `CronEngine` del legacy resta l'unico a inviare e a scrivere la coda). Ci sono solo i documenti **ancora in coda** con un `error` (il caricamento è stato rifiutato dall'hub) o con `sendStatus` tra `processingError`, `rejected`, `notDelivered`, `deliveryImpossible`, `refused`, `effectiveDate` (la stessa condizione della pagina legacy); i rifiuti SDI arriveranno con il dominio dei documenti fiscali. Le route sono solo di `/v1`: **non** esistono su `/public/v1` e non sono aperte alla chiave di negozio.

**Permesso** `errorDocuments:read`, nel tetto del solo **PSA** e dei **D**: SA, CA, PA, E e la chiave di negozio ricevono `403 FORBIDDEN`. **Perimetro** (lo decide il server): il PSA legge tutti i documenti; il D solo quelli dei gruppi **il cui `dealerId` è il suo** (i gruppi disponibili, non nel cestino, risolti da `common.groups`; il `dealerId` scritto nel documento in coda non conta mai). Un `groupId` fuori dal perimetro non dà errore: il risultato è vuoto. Se il database della coda non esiste l'elenco è vuoto (non è un errore); se una lettura supera il tempo massimo (5 s) la risposta è `503 SERVICE_UNAVAILABLE`.

**Mai restituito**: l'`XML`, i dati fiscali e anagrafici della controparte oltre al nome da mostrare, il nome del file dell'hub (`hubId`), l'oggetto `error` grezzo di Aruba e ogni altro campo.

### GET /v1/error-documents
- **Superficie:** backoffice
- **Autenticazione e permesso:** Bearer backoffice, `errorDocuments:read` (solo PSA e D)
- **Query:**
  | Parametro | Tipo | Note |
  |---|---|---|
  | `limit` | intero 1–100 | default 50 |
  | `cursor` | opaco | quello di `page.next`; un cursore non emesso dal server è `422` (`cursor`/`format`) |
  | `groupId` | 24 caratteri esadecimali | restringe a un gruppo dentro il perimetro |
  | `dealerId` | 24 caratteri esadecimali | **solo PSA**: restringe ai gruppi di quel dealer; un **D** che lo invia riceve `403 FORBIDDEN` |
  | `documentType` | `invoice`, `creditNote` | |
  | `errorCode` | `^[A-Za-z0-9]{1,10}$` | codice dell'errore dell'hub (`0034`, `0099`…), uguaglianza esatta |
  Parametri sconosciuti (compresi `sort` e `q`) o operatori sono `422`. L'ordine è fisso: `_id` decrescente (più recenti per primi).
- **Risposta:** `200` `{ data, page: { limit, next } }` con `ETag` debole e `Cache-Control: no-store`; `If-None-Match` uguale dà `304`. Ogni riga:
  ```json
  {
    "id": "6745a1b2c3d4e5f600112233",
    "groupId": "665f1c2e9b1d4a0012ab34a1", "groupName": "Gruppo Esempio", "companyName": "SUSHINISI SRL",
    "number": "105 M", "date": "2026-09-25T10:00:00.000Z",
    "documentType": "invoice", "eInvoiceType": "TD01",
    "customer": "FABIOLA FREZZA", "total": 33.8, "sendStatus": "queued",
    "error": { "code": "0034", "description": "File già inviato di recente" }
  }
  ```
  `number` è il numero **come lo mostrava il legacy**: il prefisso o il suffisso memorizzato (con il suo separatore, per esempio `/B`, ` M`, `A`) messo prima (`company.invoicesPS = prefix`) o dopo (`suffix`) il numero memorizzato, senza separatore aggiunto (`105 M`, `399/B`, `A647`); con un'altra posizione compare il solo numero. `customer` è nome e cognome per una persona (`customerType` 1) o la ragione sociale per un'azienda (2), `null` altrimenti. `documentType` è `invoice`, `creditNote` o `null`; `eInvoiceType` è il tipo del documento elettronico (`TD01`…). `total` è un importo **decimale in euro**. `groupName` è `null` se il gruppo non esiste più; `groupId` è `null` solo per un documento in coda con un `groupId` che non è un id (dato legacy anomalo, visibile solo al PSA). `error` è `null` se il documento è in elenco per il solo `sendStatus`; `error.description` è **testo semplice** (può contenere il testo di un'altra risposta, anche markup: va mostrato come testo, mai come HTML), tagliato a 2000 caratteri. I valori mancanti o del tipo sbagliato nel dato memorizzato sono `null`; le date sono ISO UTC. **Non c'è una data dell'errore**: il legacy non la memorizza.
- **Errori:** `401 UNAUTHENTICATED` / `TOKEN_EXPIRED`, `403 FORBIDDEN` (permesso mancante, chiave di negozio, `dealerId` inviato da un D), `403 PASSWORD_CHANGE_REQUIRED`, `422 VALIDATION_ERROR`, `429 RATE_LIMITED`, `503 SERVICE_UNAVAILABLE` (lettura oltre il tempo massimo)

### GET /v1/error-documents.csv
- **Superficie:** backoffice
- **Autenticazione e permesso:** come sopra; **rate limit** dedicato per utente (`RATE_LIMIT_ERROR_DOCUMENTS_EXPORT_PER_USER`, 5 al minuto di default) oltre a quello generale.
- **Query:** gli stessi filtri (`groupId`, `dealerId`, `documentType`, `errorCode`), senza `limit` né `cursor` (`limit` è `422`).
- **Risposta:** `200` `text/csv; charset=utf-8` in streaming (blocchi di 500 righe, con contropressione), `Content-Disposition: attachment; filename="error-documents_<AAAA-MM-GG>.csv"`, `Cache-Control: no-store`. UTF-8 con BOM, separatore `;`, fine riga CRLF, valori con `;`, `"` o a capo tra virgolette. Colonne, nell'ordine: `NUMERO;DATA;TIPO DOCUMENTO;TIPO FE;CLIENTE;IMPORTO;AZIENDA;GRUPPO;STATO INVIO;CODICE ERRORE;DESCRIZIONE ERRORE`. `DATA` è `gg-mm-aaaa` nel fuso `Europe/Rome`; `TIPO DOCUMENTO` è `Fattura` o `Nota di credito`; `IMPORTO` ha due decimali con la virgola e nessun separatore delle migliaia (`33,80`). **Iniezione di formule**: ogni cella di testo che inizia con `=`, `+`, `-`, `@`, tabulazione o ritorno a capo riceve un `'` iniziale (l'importo, costruito da un numero, no). La descrizione è già tagliata a 2000 caratteri. Senza righe il file ha solo l'intestazione.
- **Limite:** al massimo **50 000 righe**; oltre, `413 PAYLOAD_TOO_LARGE` prima del primo byte (si restringe con i filtri). Un solo export alla volta per utente (un secondo è `429 RATE_LIMITED`) e al massimo 5 minuti di durata.
- **Errori:** `401`, `403 FORBIDDEN`, `403 PASSWORD_CHANGE_REQUIRED`, `413 PAYLOAD_TOO_LARGE`, `422 VALIDATION_ERROR`, `429 RATE_LIMITED`, `503 SERVICE_UNAVAILABLE`

## Template e-mail del gruppo (`/v1`, passo T2)

Testi e HTML delle e-mail che il gruppo invia (conferme di prenotazione e di appuntamento, report avanzato); i punti vendita li scelgono nelle impostazioni (`GET /v1/groups/{groupId}/lookup/email-templates`). Collection `email_templates` del database del gruppo. Tutte le route sono **di gruppo** (il gruppo è verificato sul perimetro del chiamante: PSA e D sul gruppo scelto, SA, CA e PA sul proprio), richiedono la **feature `email`** del gruppo (altrimenti `403 FEATURE_DISABLED`, qualunque ruolo) e **non sono aperte alla chiave di negozio**. Permessi: lettura `places:read`, scrittura `places:update`. Un template è del gruppo, non di un punto vendita: CA e PA vedono e modificano quelli di tutto il gruppo, come nel legacy.

**L'HTML non si serve mai come HTML.** Compare solo come campo stringa di una risposta JSON (`Content-Type: application/json`, `X-Content-Type-Options: nosniff`); nessuna route risponde `text/html`. Il server **non lo sanifica** (decisione dell'utente: è il contenuto di un'e-mail): il backoffice lo mostra solo in un riquadro isolato (documento a parte, con `sandbox` senza `allow-same-origin` e una propria CSP) e mai con `innerHTML`. L'HTML e il testo non entrano mai nei log, né in quelli dell'applicazione né nel registro attività.

**Forma.** Elenco: `{ id, name, updatedAt }` (mai testo né HTML). Dettaglio: `{ id, name, text, html, createdAt, updatedAt }`, con `ETag` forte (la versione: HMAC di id, nome, testo, HTML e data dell'ultima modifica; il `If-Match` della scrittura successiva). Le date sono ISO 8601 UTC, `null` se il documento (storico) non ne ha; un campo del tipo sbagliato è `''`.

**Limiti e validazione** (per allowlist, nessun documento del client è memorizzato così com'è): `name` obbligatorio, 1–150 caratteri dopo il trim, nessun carattere di controllo; `text` al massimo 64 KB (UTF-8); `html` al massimo **256 KB** (UTF-8), stringa, **memorizzato come inviato** (nessuna normalizzazione). In `text` e `html` sono rifiutati NUL e gli altri caratteri di controllo (`U+0000–0008`, `000B`, `000C`, `000E–001F`, `007F`) tranne tabulazione, a capo e ritorno a capo: `422` con `issue` `pattern`; Unicode non ben formato `format`; troppo lungo `maxLength`; tipo sbagliato `type`; campo sconosciuto `unknown`. Il corpo ha un limite di 2 MB: oltre `413 PAYLOAD_TOO_LARGE`; un corpo che non è JSON `415`.

### GET /v1/groups/{groupId}/email-templates
- **Superficie:** backoffice. **Permesso:** `places:read` + feature `email`.
- **Query:** `limit` 1–100 (50), `cursor`, `sort` (`name` default, `-name`, `updatedAt`, `-updatedAt`), `q` (1–64 caratteri, cerca nel solo nome, in modo letterale e senza distinzione tra maiuscole e minuscole).
- **Risposta:** `200` `{ data: [{ id, name, updatedAt }], page: { limit, next } }`.
- **Errori:** `401`, `403 FORBIDDEN`, `403 FEATURE_DISABLED`, `404 NOT_FOUND` (gruppo fuori perimetro), `422 VALIDATION_ERROR`, `429`.

### POST /v1/groups/{groupId}/email-templates
- **Permesso:** `places:update` + feature `email`. **`Idempotency-Key`** obbligatoria (UUID): lo stesso invio ripetuto dà la stessa risposta; la stessa chiave con un corpo diverso `409`.
- **Body:** `{ name, text?, html? }` (`text` e `html` vuoti se mancano).
- **Risposta:** `201` `{ data }` (il dettaglio), `Location` e `ETag`. Il documento memorizzato ha le sole chiavi `name`, `text`, `html`, `insertDate`, `updateDate`. Registra `emailTemplate.created`.
- **Errori:** `401`, `403`, `409 CONFLICT` (chiave riusata con altro corpo, o richiesta ancora in corso), `413`, `415`, `422` (`Idempotency-Key` `required`/`format`, campi), `429`.

### GET /v1/groups/{groupId}/email-templates/{templateId}
- **Permesso:** `places:read` + feature `email`. **Risposta:** `200` `{ data }` con `ETag`. **Errori:** `404 NOT_FOUND` (anche un id di un altro gruppo), `422` per un id malformato.

### PATCH /v1/groups/{groupId}/email-templates/{templateId}
- **Permesso:** `places:update` + feature `email`. **`If-Match`** obbligatorio (l'`ETag` letto).
- **Body:** almeno uno tra `name`, `text`, `html` (un corpo vuoto è `422` `(body)`/`required`). Solo i campi inviati cambiano.
- **Risposta:** `200` `{ data }` con il nuovo `ETag`. Una richiesta che non cambia nulla non scrive e non registra nulla (risposta con lo stesso `ETag`). Registra `emailTemplate.updated`.
- **Errori:** `404`, `412 PRECONDITION_FAILED` (il template è cambiato dopo che l'hai letto: rileggilo), `409 CONFLICT` (cambiato mentre la richiesta girava), `413`, `415`, `422` (`If-Match` `required`/`format`, campi).

### DELETE /v1/groups/{groupId}/email-templates/{templateId}
- **Permesso:** `places:update` + feature `email`. Eliminazione definitiva (il legacy non ha un cestino per i template).
- **Rifiutata con `409 CONFLICT`** finché un punto vendita del gruppo, **cestinati compresi**, nomina il template in `appointment.email.templateId` o in `roomsSettings.reservation.{emailNotification,email,emailConfirmedStatus,emailRefusedStatus,emailChangeStatus}.templateId`; la verifica si fa sulle **copie** dei punti vendita nel database comune. `details` elenca i punti vendita **del perimetro del chiamante**, al massimo 20: `{ field: "places.<placeId>", issue: "referenced" }`. Un CA o un PA non riceve mai l'id di un punto vendita fuori dal proprio perimetro: ne vede uno solo, anonimo, `{ field: "places", issue: "referenced" }` (il `409` resta). PSA, D e SA vedono tutti.
- **Risposta:** `204` senza corpo. Registra `emailTemplate.deleted`. **Errori:** `404`, `409` (come sopra), `422` per un id malformato.

**Registro attività:** `emailTemplate.created`, `emailTemplate.updated`, `emailTemplate.deleted`, risorsa `emailTemplate` con l'id e il gruppo; `changes` contiene il nome e un'impronta troncata (`textDigest`, `htmlDigest`) del contenuto: mai il testo né l'HTML.

## Catalogo: reparti, marche e gruppi di attributi (`/v1`, passo C1)

Tre risorse del database del gruppo, tutte **route di gruppo** (il gruppo è verificato sul perimetro del chiamante: PSA e D sul gruppo scelto, SA, CA e PA sul proprio; `404` fuori perimetro), sulla sola superficie `/v1`, **non aperte alla chiave di negozio** né a `/public/v1`. Permessi: lettura `products:read`, scrittura `products:update`. Collection `products_departments`, `products_brands`, `products_attributes`.

| Risorsa | Feature del gruppo | Perimetro per punto vendita |
|---|---|---|
| `/v1/groups/{groupId}/product-departments` | `cash` (altrimenti `403 FEATURE_DISABLED`, qualunque ruolo) | sì |
| `/v1/groups/{groupId}/product-brands` | nessuna | sì |
| `/v1/groups/{groupId}/product-attribute-groups` | nessuna | no |

**Operazioni (uguali per le tre risorse).**
- `GET` elenco: `{ data: [...], page: { limit, next } }`, cursore opaco. Query: `limit` 1–100 (50), `cursor`, `sort` (`name` predefinito o `-name`; per i reparti anche `code` e `-code`), `q` (1–64 caratteri: cerca nel nome, in **tutte** le lingue, come testo letterale e senza distinzione tra maiuscole e minuscole; nessuna espressione regolare del client), `enabled` (`true` o `false`: solo reparti e marche). Il nome ordina come il testo nella lingua dell'utente che chiama (o nella prima che la voce ha); l'ordine è quello binario del database (le maiuscole prima delle minuscole), come in ogni elenco del sistema. Il codice dei reparti ordina come numero anche quando il vecchio sistema lo ha salvato come testo; un codice che non è un numero intero ordina per primo.
- `POST`: **`Idempotency-Key`** obbligatoria (UUID); `201` `{ data }` con `Location` e `ETag`. La stessa chiave con lo stesso corpo ripete la risposta, con un corpo diverso `409`.
- `GET /{id}`: `200` `{ data }` con `ETag` forte (la versione: HMAC di tutti i campi che il backend gestisce). Un id di un altro gruppo, sconosciuto o fuori dal perimetro del chiamante è `404`; malformato `422`.
- `PATCH /{id}`: **`If-Match`** obbligatorio (l'`ETag` letto; mancante `422` `If-Match`/`required`, malformato `422` `format`, non più attuale `412 PRECONDITION_FAILED`, cambiata mentre la richiesta girava `409 CONFLICT`; la scrittura richiede la `updateDate` letta così com'è memorizzata, di qualunque tipo, e sempre anche `placesAvailability` com'era: il vecchio sistema lo scrive senza toccare la data). Almeno un campo (`422` `(body)`/`required`). Solo i campi inviati cambiano; una richiesta che non cambia nulla non scrive e non registra nulla (stesso `ETag`). `200` `{ data }` con il nuovo `ETag`.
- `DELETE /{id}`: eliminazione **definitiva** (`204`; vale solo se anche `placesAvailability` è com'era quando è stata letta, altrimenti `409`), rifiutata con `409 CONFLICT` se la voce è in uso (vedi sotto). `404` se non esiste. L'eliminazione vale solo se la voce è ancora com'era quando è stata letta (stessa `updateDate`, di qualunque tipo o assente): altrimenti `409 CONFLICT` senza `details`.
- Corpi limitati a 64 KB (`413`); un corpo non JSON è `415`; campo sconosciuto `422` `unknown` (nessun oggetto del client arriva al database).
- Errori comuni: `401`, `403 FORBIDDEN`, `403 FEATURE_DISABLED`, `403 PASSWORD_CHANGE_REQUIRED`, `404`, `409`, `412`, `413`, `415`, `422`, `429`.

**Testi per lingua** (`name`, `description`, nomi degli attributi): oggetti `{ "it": "Bibite", "en": "Drinks" }`, chiavi di due lettere minuscole che siano **lingue del gruppo** (`settings.languages`, `it` se il gruppo non ne elenca; `422` `name.<lingua>`/`incorrect`). Un nome è di 1–150 caratteri dopo il trim senza caratteri di controllo; una descrizione di 0–1000 caratteri (a capo e tabulazione ammessi). Alla creazione il `name` deve avere il testo **nella lingua richiesta**: quella dell'utente che chiama se il gruppo la ha, altrimenti la prima del gruppo (`422` `name.<lingua>`/`required`). In `PATCH` i testi si fondono per lingua: una lingua inviata si imposta, una lingua con `null` si toglie, le altre restano; un nome non resta mai senza testi né perde la lingua richiesta che aveva. Una lingua già memorizzata e non più del gruppo non blocca una modifica che non la tocca.

**Punti vendita (`placeIds`)** di reparti e marche: l'elenco dei punti vendita per cui la voce vale; **vuoto vuol dire tutti i punti vendita** (come nel vecchio sistema). Ogni id deve essere un punto vendita del gruppo non nel cestino (`422` `placeIds.<indice>`/`incorrect`, verificato solo per gli id che la voce non aveva già); al massimo 200, senza ripetizioni.
- **PSA, D e SA** non hanno limiti.
- **CA e PA** lavorano nel perimetro calcolato dal server (i punti vendita delle proprie aziende, o i propri). Vedono (`GET` elenco e dettaglio) le voci con elenco vuoto o che nomina almeno un proprio punto vendita, `404` per le altre, e di queste ricevono **solo i propri punti vendita** in `placeIds`. Le risposte di reparti, marche e gruppi di attributi hanno un campo booleano in sola lettura **`editable`**, calcolato dal server: dice se il chiamante può modificare ed eliminare la voce (sempre vero per PSA, D e SA; per CA e PA vero solo se la disponibilità è **non vuota e interamente nel loro perimetro**, oppure se la voce è per tutti e il gruppo ha **un solo punto vendita fuori dal cestino** (vedi sotto)).
- **Modifica ed eliminazione per CA e PA**: solo delle voci `editable`. `PATCH` e `DELETE` di una voce per tutti i punti vendita, condivisa con punti vendita fuori perimetro o con elementi anomali in `placesAvailability` sono `403 FORBIDDEN` (senza `details`), prima di ogni altro controllo. In creazione e in modifica `placeIds` contiene solo punti vendita del proprio perimetro, almeno uno: un id fuori perimetro è `403` con `details` `placeIds.<indice>`/`notAllowed`, un elenco vuoto `403` con `[{ "field": "placeIds", "issue": "notAllowed" }]`.
- **Gruppo con un solo punto vendita (passo C5).** Se il gruppo ha **esattamente un punto vendita non nel cestino** (letto dal server a ogni richiesta, nessuna cache, **da due fonti che devono concordare**: la collection `places` del database del gruppo e la copia in `common.places`, con lo stesso unico id; in caso di disaccordo, copia mancante o lettura fallita vale la regola dei due punti vendita) e quel punto vendita è nel perimetro del chiamante (CA o PA di quel punto vendita, o la chiave di negozio), una voce **per tutti** vale come interamente propria: `editable: true`, si modifica e si elimina per intero, e se ne può **creare** una con `placeIds` vuoto o assente. Vale per reparti, marche, categorie e prodotti. Con due o più punti vendita (o se l'unico non è nel perimetro) tutto resta come descritto qui. Non cambia nulla per PSA, D e SA.
- **Una voce è "per tutti i punti vendita" solo se `placesAvailability` è assente, `null` o vuota.** Gli elementi che non sono ObjectId (anche il testo esadecimale) sono anomali: non sono punti vendita, non si mostrano, e una voce che ne contiene non è modificabile da CA e PA.
- **Gruppi di attributi**: li scrivono (`POST`, `PATCH`, `DELETE`) solo PSA, D e SA; CA e PA ricevono `403` anche con `products:update`, la lettura resta a `products:read` (`editable: false`).

**Immagine** (reparti e marche, `image`): solo se il gruppo ha la **feature `media`**; senza la feature il campo non compare nelle risposte e inviarlo è `422` `image`/`notAllowed`. Si invia `{ "imageId": "<id di un'immagine della libreria del gruppo>" }` o `null` (toglie l'immagine); un'immagine inesistente, cestinata, di un altro gruppo, non valida o che il chiamante non può vedere (un CA vede solo le immagini delle proprie aziende; un PA non ha un'azienda nel proprio perimetro ricavabile dal server e **non può scegliere alcuna immagine**: `422` `image`/`incorrect`) è `422` `image`/`incorrect`. Il server costruisce il descrittore dall'immagine salvata (mai dal corpo) e lo scrive in `medias.images.main`; il residuo `medias.images.images` del vecchio form non si legge e non si tocca. Nelle risposte `image` ha la forma delle immagini delle aziende (`_id`, `basename`, `extension`, `filename`, `mimetype`, `title`, `alt`, `dirname`, `type`, `filectime`) o `null`.

**Eliminazione e riferimenti.** Un `409 CONFLICT` elenca al massimo 20 riferimenti in `details` come `{ "field": "products.<id>", "issue": "referenced" }` (i prodotti **non cestinati**):
- *reparto*: solo se è **l'ultimo reparto attivo** (`status` vero) con il numero di reparto della sua aliquota (`tax.department`) **e** almeno un prodotto ha un prezzo con `prices[].taxData.department` uguale (il POS abbina così il reparto); altrimenti si elimina. Un reparto non attivo, o la cui aliquota non ha numero di reparto, si elimina sempre;
- *marca*: se un prodotto ha quella marca (`brandId`);
- *gruppo di attributi*: se un prodotto usa uno dei suoi attributi (`attributes` del prodotto contiene gli id degli attributi); lo stesso controllo vale quando un attributo sparisce dall'elenco in un `PATCH`.

### Reparti — `/v1/groups/{groupId}/product-departments`
Elemento: `{ id, code, name, description, taxId, tax, noDiscount, secondaryFiscalPrinter, enabled, placeIds, editable, image?, createdAt, updatedAt }`.
- `code`: numero del reparto sul registratore, intero **1–99, unico nel gruppo**, scritto come Int32. Senza indice univoco, dopo la scrittura il server rilegge i reparti con quel codice: se ne esiste un altro scritto prima (`updateDate` più vecchia, a parità `_id` minore) annulla **tutta** la propria scrittura (elimina il reparto creato, o rimette i valori precedenti di ogni campo toccato dalla `PATCH`, con guardia sulla data appena scritta) e risponde `409` `code`/`taken`; nulla viene registrato nel registro attività. Se l'annullamento non riesce si scrive un errore applicativo nei log (solo id) e la risposta è comunque `409`. Senza indice univoco resta una finestra pari allo scarto degli orologi dei server (limite noto). Un gruppo con più di 1000 reparti non può verificare il codice: errore esplicito (`500`), mai un controllo su una parte. Il confronto è numerico: `'1'` e `1` collidono, anche con un reparto scritto dal vecchio sistema come testo o come doppio; `409 CONFLICT` con `details` `[{ "field": "code", "issue": "taken" }]`. Nei dati storici può essere `null` (codice testo non numerico o `NaN`).
- `taxId`: id di un'aliquota del gruppo (`/taxes`); sconosciuto `422` `taxId`/`incorrect`. `tax` è in **sola lettura**: la copia che il reparto tiene dell'aliquota, `{ rate, department, vatNature, description }` (`null` se il documento ha un'aliquota che non è un oggetto). La copia si **riallinea** quando l'aliquota del gruppo viene modificata (vedi `/taxes`).
- `name` e `description`: testi per lingua; `noDiscount`, `secondaryFiscalPrinter`, `enabled` (stato del reparto, `status`): booleani, falsi se assenti nel documento; `placeIds` e `image`: sopra.
- `POST` richiede `code`, `name` (nella lingua richiesta) e `taxId`; `description` (predefinita `{ <lingua richiesta>: "" }`), `noDiscount`, `secondaryFiscalPrinter` (`false`), `enabled` (`true`), `placeIds` (tutti), `image` sono facoltativi. `PATCH`: gli stessi campi, tutti facoltativi; cambiare `taxId` sostituisce la copia.
- Il documento nuovo ha le sole chiavi del legacy: `code`, `tax` (`{ id, value, department, description, natura }`), `name`, `description`, `noDiscount`, `secondaryFiscalPrinter`, `medias` (`{ images: {} }`), `placesAvailability` (ObjectId), `status`, `insertDate`, `updateDate`.

### Marche — `/v1/groups/{groupId}/product-brands`
Elemento: `{ id, name, description, enabled, placeIds, editable, image?, createdAt, updatedAt }`. `POST` richiede `name`. I tre interruttori che il vecchio form mostrava senza salvarli (disponibile per cassa, per e-commerce, in evidenza) **non esistono**: inviarli è `422` `unknown`. Documento nuovo: `name`, `description`, `placesAvailability`, `medias`, `status`, `insertDate`, `updateDate`.

### Gruppi di attributi — `/v1/groups/{groupId}/product-attribute-groups`
Elemento: `{ id, name, attributes: [{ id, name }], editable, createdAt, updatedAt }`; gli attributi stanno dentro il documento del gruppo. Nessun perimetro per punto vendita: li scrivono solo PSA, D e SA (sopra). `createdAt` è `null` per i gruppi nati dal vecchio sistema (il loro upsert non scriveva `insertDate`).
- Al più **200 attributi** per gruppo; nomi di 1–150 caratteri per lingua (almeno una lingua); un elemento non leggibile del documento (senza `id` testuale) non si mostra.
- `POST`: `name` obbligatorio (nella lingua richiesta), `attributes` facoltativo come `[{ "name": { "it": "Rosso" } }]`: **l'`id` di un attributo lo genera sempre il server** (22 caratteri base64url, come gli id già memorizzati); inviarlo è `422` `attributes.<i>.id`/`unknown`.
- `PATCH`: `name` (fusione per lingua) e/o `attributes`, che si manda **intero**: un elemento con un `id` noto si aggiorna (se il nome non cambia resta com'è, con le chiavi del legacy), uno senza `id` nasce con un id nuovo, uno assente si elimina (con il controllo dei riferimenti). Gli elementi memorizzati che l'API non può indirizzare (senza `id` testuale, o che non sono oggetti) non si mostrano e **si conservano**, in coda alla lista. Un `id` sconosciuto o ripetuto è `422` `attributes.<i>.id`/`incorrect`.

**Registro attività.** `productDepartment.created|updated|deleted`, `productBrand.created|updated|deleted`, `productAttributeGroup.created|updated|deleted`, categoria `data`, risorsa con l'id della voce e il gruppo; `changes` ha i campi prima e dopo (codice, aliquota, nome e descrizione per lingua, interruttori, `placeIds`, `imageId`; per i gruppi di attributi nome e attributi): nessun altro dato.

## Catalogo: categorie di prodotto (`/v1`, passo C2)

Le categorie del gruppo formano un **albero** (collection `products_categories` del database del gruppo). Route di gruppo sulla sola superficie `/v1`, **non aperte alla chiave di negozio** né a `/public/v1`; permessi `products:read` (lettura) e `products:update` (scrittura); nessuna funzione del gruppo richiesta per la risorsa (i singoli campi sì, vedi sotto). Stesse regole di C1 per `ETag`/`If-Match`, `Idempotency-Key`, testi per lingua, perimetro di CA e PA, errori comuni (`401`, `403`, `404`, `409`, `412`, `413`, `415`, `422`, `429`); corpi fino a 128 KB.

| Route | Note |
|---|---|
| `GET /v1/groups/{groupId}/product-categories` | elenco a cursore |
| `GET /v1/groups/{groupId}/product-categories/tree` | l'albero compatto |
| `POST /v1/groups/{groupId}/product-categories` | `Idempotency-Key`; `201` con `Location` ed `ETag` |
| `GET`, `PATCH` (`If-Match`), `DELETE /v1/groups/{groupId}/product-categories/{id}` | |

**Elenco.** Query: `limit` 1–100 (50), `cursor`, `sort` (`name` predefinito, `position`, anche con `-`; una posizione che non è un numero, `NaN` compreso, ordina per prima), `q` (nome, tutte le lingue, testo letterale), `enabled`, `parentId` (un id, oppure `null` per le radici; filtra sul genitore **con cui la categoria si legge**, vedi cicli). Ogni voce ha anche `parentId`, `parentHidden`, `depth` e `cyclic`. Il filtro `parentId=<id>` di un id che il chiamante non raggiunge risponde come per un id inesistente (elenco vuoto). In un gruppo con più di 2.000 categorie `depth` è `null` e `parentId` nel filtro dà `409`.

**Albero** (`/tree`): `{ data: [ { id, name, parentId, position, enabled, children: [...] } ] }` con le radici, nella lingua dell'utente (altrimenti la prima della categoria; `null` se non ne ha), ordinate per `position` (le mancanti per ultime), nome e id. Solo le categorie nel perimetro del chiamante; una categoria il cui genitore il chiamante non raggiunge è una radice della risposta, con `parentId: null` e `parentHidden: true` (l'id del genitore non esce mai). `ETag` debole del contenuto, `Cache-Control: no-store`, `If-None-Match` uguale dà `304`. Oltre 2.000 categorie nel gruppo `409` `categories`/`tooMany`. `/tree?x=1` è `422`.

**Elemento:** `{ id, parentId, parentHidden, depth, cyclic, name, description, enabled, position, productionValue, availability?, noDiscount, requiresLegalAge, secondaryFiscalPrinter?, featured?, integrations, dining?, tobacco?, backgroundColor?, textColor, modifierIds?, modifierCategoryIds?, printStations?, counterPrintStations?, places, editable, image?, icon?, internalFileName?, externalUrl?, createdAt, updatedAt }`.
- `parentHidden`: `true` quando la categoria ha un genitore che il chiamante (CA o PA) non raggiunge: `parentId` è allora `null`, la categoria è una radice del suo perimetro e `depth` è calcolato sul solo perimetro del chiamante; sempre `false` per gli altri ruoli. Una `PATCH` che non manda `parentId` non cambia il genitore nascosto, e **neppure `parentId: null`** (è il valore che l'API mostra a CA e PA per un genitore nascosto: un form che rimanda tutti i campi non stacca la categoria); per spostarla CA e PA scelgono un genitore che raggiungono. Un `parentId` che CA o PA non raggiungono è sempre `422` `parentId`/`incorrect`, anche se è uguale al genitore nascosto memorizzato (nessun oracolo). PSA, D e SA possono staccare la categoria con `null`. `parentId`, `depth`, il filtro `parentId` e `/tree` raccontano la stessa vista del chiamante, anche attraverso un ciclo del vecchio sistema che passa da una categoria che non raggiunge.
- `enabled` = `status`; `requiresLegalAge` = `requiresGreaterAge`; `position` e `productionValue`: interi 0–1.000.000 o `null` (un `NaN` o un valore non numerico del vecchio sistema si legge `null`; si scrivono Int32, mai `NaN`).
- `integrations`: `{ floodOrders, yellgo, leggimenu }` (booleani, senza funzione richiesta). L'interruttore EasyAppear (`integrations.easyappear`, e `easyAppear` dove esiste) **non si espone e non si tocca**: il documento nuovo lo scrive `false`.
- `dining` (= `roomsSettings`): `{ endOfMeal, hiddenOnHandheld, feePercentage (numero 0–100 o null, Double se ha decimali), printGroup (intero o null), alwaysFirstCourse, notAffiliatedMenu, type: other|food|beverage }`. `tobacco` = `tgm.type`.
- `backgroundColor`, `textColor`: `#RRGGBB` (si salvano in minuscolo; `null` in lettura se il documento ha altro). Predefiniti `#000000`.
- `modifierIds` = `variants`: prodotti con `variant.status` vero, non cestinati, esistenti (`422` `modifierIds.<i>`/`incorrect`, giudicati solo gli id nuovi), al più 1.000. `modifierCategoryIds` = `variantsCategories`: categorie esistenti, al più 200; CA e PA possono usare solo categorie che raggiungono, e una che non raggiungono è giudicata come una inesistente (`422` `modifierCategoryIds.<i>`/`incorrect`: nessun modo di scoprirne l'esistenza). Nelle risposte e nel registro attività CA e PA vedono di `modifierCategoryIds` solo le categorie che raggiungono; le altre memorizzate si conservano, e una `PATCH` di CA o PA con la lista la applica alle sole categorie raggiungibili e lascia le altre. `modifierIds` non ha ancora un perimetro: arriva con il modulo prodotti.
- `printStations` (= `printStations["__<placeId>"]`, ordini di sala) e `counterPrintStations` (= `printStationsNoRooms`, ordini al banco): mappa `{ "<placeId>": ["<idPostazione>", ...] }`. Il punto vendita deve esistere nel gruppo e ogni postazione essere una di quel punto vendita (`422` `printStations.<placeId>`/`incorrect`, `printStations.<placeId>.<i>`/`incorrect`, giudicate solo le novità). In `PATCH` si nominano solo i punti vendita da cambiare: un elenco sostituisce quello del punto vendita, `null` lo toglie, gli altri restano. Per ogni chiave **che la categoria non ha già** con un elenco (**anche vuoto**, in creazione e in modifica) il punto vendita deve esistere nel gruppo (una chiave già presente, inviata uguale o modificata, resta accettata anche se il punto vendita non esiste più; per CA e PA vale comunque il perimetro) (`422` `printStations.<placeId>`/`incorrect`); un elenco vuoto per un punto vendita che la categoria non ha non scrive nulla; togliere (`null`) un punto vendita che non esiste più è sempre possibile. La mappa non cresce oltre 200 punti vendita (`422` `printStations`/`tooMany` solo se il numero di chiavi **aumenta** e supera 200: una mappa che il vecchio sistema ha lasciato oltre il limite si può ancora modificare e ridurre).
- `places` (= `placesAvailability[] = { id, position, productionCenterId }`): `[{ placeId, position (intero o null), productionCenterId (id di un centro di produzione di quel punto vendita, o null) }]`; **vuoto = tutti i punti vendita**; al più 200, nessun punto vendita ripetuto (`places.<i>.placeId`/`incorrect`, punto vendita inesistente o cestinato; `places.<i>.productionCenterId`/`incorrect`). In `PATCH` sostituisce l'elenco. Il formato storico (array di ObjectId) si legge come punti vendita senza posizione e **si riscrive nel formato attuale a ogni salvataggio** che scrive qualcosa.
- `image` = `medias.images.main`, `icon` = `medias.images.icon` (`{ imageId }` della libreria o `null`, come in C1), `internalFileName` (1–255 caratteri, una riga), `externalUrl` (solo `https`, senza utente e password, al più 2.048 caratteri; nel registro attività compare senza query string né frammento): **solo con la funzione `media`**.

**Funzioni del gruppo.** Un campo è accettato e restituito solo se il gruppo ha la funzione che lo governava nel legacy; senza, la scrittura è `422` `<campo>`/`notAllowed` (anche `null`/uguale al valore attuale) e la lettura non lo mostra: `availability.pos` e `backgroundColor` → `cash`; `availability.ecommerce` e `featured` → `customersApp`; `secondaryFiscalPrinter` e `tobacco` → `tobaccosGamesMonopoly`; `modifierIds` e `modifierCategoryIds` → `productsVariants`; `printStations` e `counterPrintStations` → `ordering`; `dining.*` → `rooms`; `image`, `icon`, `internalFileName`, `externalUrl` → `media`. `availability` si mostra solo con le chiavi permesse (assente se nessuna).

**Albero: regole.** `parentId` (id o `null` per la radice) deve essere una categoria del gruppo che il chiamante raggiunge (`422` `parentId`/`incorrect`); non può essere la categoria stessa né un suo discendente (`422` `parentId`/`incorrect`); al più **10 livelli** (`depth` da 0 a 9). **Spostare una categoria porta con sé tutti i suoi discendenti** e il controllo di profondità conta l'altezza dell'intero sottoalbero, **anche le categorie che il chiamante non vede**: `422` `parentId`/`tooDeep` può quindi scattare per livelli che CA e PA non vedono; al più **2.000 categorie** per gruppo (`409` `categories`/`tooMany` in creazione: dopo l'inserimento il server riconta e, se il gruppo ha superato il limite per richieste simultanee, **elimina la propria categoria** e risponde `409`, così il limite non resta superato; lo stesso se la rilettura dopo l'inserimento fallisce, per esempio `503`: la categoria è tolta e l'errore è quello originale, così non resta una categoria creata senza risposta né evento). Nessun vincolo di unicità sul nome. `autoDepartments` non ha alcun effetto: creare una categoria non crea reparti. **Cicli del vecchio sistema** (11 gruppi reali): la categoria con l'id più piccolo del ciclo si legge come radice (`parentId` `null`, `depth` 0, `cyclic: true`), il resto del ciclo di conseguenza; nulla si ripara nel database, e `PATCH` con `parentId: null` (o un genitore valido) la sistema. Un genitore che non esiste si legge come radice. Senza transazioni due `PATCH` simultanee potrebbero creare un ciclo: dopo la scrittura il server rilegge i genitori e, se la categoria è su un ciclo, **annulla la propria scrittura** (campi toccati rimessi come erano, con guardia sulla data scritta; se non riesce, errore nei log con i soli id) e risponde `409` `parentId`/`incorrect`.

**`POST`:** richiede `name` (nella lingua richiesta, come C1); gli altri campi sono facoltativi con i predefiniti del legacy (`description` `{ <lingua>: "" }`, flag `false`, `enabled` `true`, colori `#000000`, `places` tutti). Il documento nuovo ha le sole chiavi del legacy (`parentId`, `name`, `description`, `position`, `productionValue`, `availability`, `noDiscount`, `requiresGreaterAge`, `secondaryFiscalPrinter`, `featured`, `backgroundColor`, `textColor`, `medias`, `placesAvailability`, `variants`, `variantsCategories`, `printStations`, `printStationsNoRooms`, `roomsSettings`, `tgm`, `integrations`, `status`, `insertDate`, `updateDate`). **`PATCH`:** `If-Match`; gli oggetti `availability`, `integrations`, `dining` cambiano solo le chiavi inviate; `modifierIds`, `modifierCategoryIds` e `places` si mandano interi; una richiesta che non cambia nulla non scrive e non registra nulla (stesso `ETag`; un `NaN` memorizzato non è `null`, quindi inviare `null` lo riscrive). Le scritture usano `$set`/`$unset` dei soli campi posseduti (foglia per foglia dentro `availability`, `integrations`, `roomsSettings`, `tgm`; `medias` solo sotto `medias.images.*`; le mappe `printStations` voce per voce) e richiedono i contenitori mancanti o oggetto (un contenitore che è altro, come `integrations: null`, dà `409`); chiavi sconosciute o di una versione successiva restano.

**Perimetro di CA e PA** (come reparti e marche): vedono le categorie per tutti i punti vendita o che nominano un proprio punto vendita (anche nel formato storico), `404` le altre; di queste ricevono solo i propri punti vendita in `places` e in `printStations`/`counterPrintStations`. **Modificano ed eliminano solo** quelle con disponibilità non vuota, senza elementi anomali e interamente nel proprio perimetro, o per tutti in un gruppo con un solo punto vendita (regola di C5, sopra) (`editable` lo dice; altrimenti `403` senza `details`, prima di ogni altro controllo). In creazione e modifica `places` contiene solo punti vendita propri, almeno uno (`403` `places.<i>.placeId`/`notAllowed`, o `places`/`notAllowed` se vuoto) e anche le mappe delle postazioni nominano solo propri punti vendita (`403` `printStations.<placeId>`/`notAllowed`). Un PA non aggancia immagini (`422` `image`/`incorrect`).

**`DELETE`:** definitiva, `204`. I riferimenti si cercano **un tipo alla volta, dal meno costoso, fermandosi al primo tipo trovato**: il `409 CONFLICT` riporta solo quel tipo (`issue: "referenced"`, al massimo 20 riferimenti), poi, tolti quelli, il successivo. Ordine: sottocategorie, categorie di modificatori, promozioni, punti vendita, prodotti (tre ricerche). La categoria è rifiutata se: ha sottocategorie (`subcategories.<id>`); è in un prodotto non cestinato (`products.<id>`: `categories`; `productModifierCategories.<id>`: `variantsCategories`; `productBundles.<id>`: `selectableBundleProducts[].categoryId` e `selectableVariantsBundleProducts[].categoryId`); è tra le categorie di modificatori di un'altra categoria (`categoryModifierCategories.<id>`); è citata da una promozione (`promotions.<id>`); è citata da un punto vendita (`places.<id>`: categorie del riepilogo di una postazione comanda, kiosk `upsellingCategoryId` e `productsCategories`, self ordering `priceListsConfig.<listino>.productsCategories`, mappa `integrations.tsh.categoriesMap`; trovati con una sola query limitata sulle copie dei punti vendita). **Nessuna cascata**: i discendenti non si toccano (si rifiuta finché ci sono). CA e PA ricevono per sottocategorie, categorie di modificatori e punti vendita solo gli id che raggiungono, e un dettaglio anonimo (`subcategories`, `places`) per gli altri. Ogni lettura è limitata (`maxTimeMS`, `503`). Se la categoria è cambiata mentre la richiesta girava `409` senza `details`.

**Lookup.** `GET /v1/groups/{groupId}/lookup/product-categories` (anche con `?ids=`) restituisce a CA e PA solo le categorie che raggiungono (per tutti o con un loro punto vendita), come l'elenco.

**Registro attività.** `productCategory.created|updated|deleted` (categoria `data`), `changes` con i campi della categoria (genitore, testi, interruttori, `publishing` = interruttori delle integrazioni, `dining`, colori, modificatori, postazioni, `placeIds` e `placeDetails`, `imageId`, `iconId`, `internalFileName`, `externalUrl`); `placeIds`, `placeDetails` e le postazioni contengono solo i punti vendita nel perimetro dell'attore.

## Catalogo: prodotti (`/v1`, passo C3)

I prodotti del gruppo (collection `products` del database del gruppo; mapping completo campo API ↔ documento in `doc/Data-Model.md`). Route di gruppo sulla sola superficie `/v1`, **non aperte alla chiave di negozio** (è il passo C5) né a `/public/v1`; permessi `products:read` (lettura) e `products:update` (ogni scrittura, cestino, ripristino ed eliminazione); nessuna funzione del gruppo richiesta per la risorsa (i singoli campi e tipi sì). Stesse regole di C1 e C2 per `ETag`/`If-Match`, `Idempotency-Key`, testi per lingua, errori comuni (`401`, `403`, `404`, `409`, `412`, `413`, `415`, `422`, `429`); corpi fino a 256 KB.

| Route | Note |
|---|---|
| `GET /v1/groups/{groupId}/products` | elenco a cursore, righe compatte |
| `POST /v1/groups/{groupId}/products` | `Idempotency-Key`; `201` con `Location` ed `ETag` |
| `GET`, `PATCH` (`If-Match`) `/v1/groups/{groupId}/products/{productId}` | `ETag` |
| `POST /v1/groups/{groupId}/products/{productId}/duplicate` | `Idempotency-Key`; `201` con `Location` ed `ETag` della copia |
| `POST /v1/groups/{groupId}/products/{productId}/trash` e `…/restore` | `If-Match`; `200` con il prodotto |
| `POST /v1/groups/{groupId}/products/trash` | cestino massivo: `{ "ids": [ … ] }` (1–100); `200` `{ data: { results: [ { id, outcome: "trashed" \| "skipped", issue?: "notFound" \| "forbidden" \| "alreadyTrashed" \| "conflict" } ] } }`, nell'ordine della richiesta, id ripetuti tolti |
| `DELETE /v1/groups/{groupId}/products/{productId}` | eliminazione definitiva di un prodotto **già nel cestino**, `If-Match`, `204` |

Il ripristino e l'eliminazione definitiva dalla pagina Cestino sono anche in `POST /v1/groups/{groupId}/trash/products/restore|delete|empty` (vedi "Cestino").

**Famiglie.** Ogni prodotto appartiene a una famiglia, calcolata dal server (`family`): `modifiers` (`variant.status` vero, qualunque `type`), altrimenti `services` (`type: service`), `tgm` (`tobaccos`, `games`, `monopoly`) o `products` (`product`, `exempt`, nessun tipo e ogni tipo che il server non conosce). `type` è `product`, `service`, `exempt`, `tobaccos`, `games`, `monopoly` (o `null` in lettura se il documento non ne ha uno noto). `service` si crea o si assegna solo con la funzione `services` del gruppo, i tre tipi `tgm` solo con `tobaccosGamesMonopoly`, un modificatore (`isModifier: true`) solo con `productsVariants`: altrimenti `422` `type`/`notAllowed` o `isModifier`/`notAllowed`. `isModifier` si decide alla creazione e **non cambia** (una `PATCH` che lo cambia è `422` `isModifier`/`immutable`; ripeterlo uguale è accettato).

**Elenco.** Query: `limit` 1–100 (50), `cursor`, `sort` (`updatedAt` predefinito e **decrescente**, `code`, `name`; anche con `-`; `name` ordina sul testo nella lingua dell'utente, altrimenti sul primo che il prodotto ha), `q`, `family` (`products` predefinito; con `trashed=true` e nessuna `family` si elencano **tutte** le famiglie, per la pagina Cestino), `categoryId`, `supplierId` (`suppliers[].id`), `placeId` (disponibile in quel punto vendita o per tutti), `favorite`, `enabled`, `trashed` (`false` predefinito). `q` cerca il testo letterale nel nome (nella lingua dell'utente, altrimenti la prima del prodotto, senza distinguere le maiuscole), **oppure** il `code` esatto, **oppure** il barcode esatto. CA e PA: un `placeId` fuori dal proprio perimetro è `403` `placeId`/`notAllowed`. Ogni riga ha solo: `id`, `family`, `type`, `code`, `name` (testo nella lingua dell'utente), `enabled`, `updatedAt`, `categoryIds`, `stock` `{ quantity, composite }` (somma delle giacenze dei punti vendita che il chiamante raggiunge, a 6 decimali; `null` se il prodotto non movimenta il magazzino, è un servizio o il gruppo non ha `warehouse`; `composite` è vero con una distinta base), `price` (regola del listino predefinito del gruppo con quantità minima 1 e senza date: `price × (1 + tax/100)` meno lo sconto, 2 decimali; il prezzo con IVA della regola se il netto o l'aliquota non sono numeri; `null` se non c'è), `lastSupplierId`, `editable`, `placeEditable`, `trashed`, `trashedAt`. Mai il documento intero. Ogni lettura ha `maxTimeMS` (`503`).

Nel cestino massivo `conflict` è un prodotto cambiato (o sparito) mentre la richiesta girava, distinto da `alreadyTrashed` (già nel cestino).

**Dettaglio** (`GET`, e la risposta di ogni scrittura): tutti i campi dell'elenco della scheda, con `ETag` (la versione copre ogni campo scritto da questo backend **tranne** le giacenze `quantity.*.value` e i costi, che muove il magazzino: una vendita non cambia la versione). I campi di una funzione che il gruppo non ha **non compaiono**. Letture **tolleranti**: `NaN`, un tipo sbagliato o una chiave assente danno `null`, `false` o una lista vuota; le date si leggono sia come `Date` sia come testo ISO; un riferimento che non esiste più si mostra per id, senza errore. Schede (16 del vecchio form, quella dei prodotti figlio e quella dello staff non esistono):
- **Generale:** `enabled`, `code` (testo fino a 64, `""` se vuoto), `plu` (cifre senza zeri iniziali, fino a 6, o `null`; con `scales`), `name`, `shortName` (fino a 18 caratteri), `description`, `shortDescription` (testi per lingua), `favorite`, `favoriteHandheld` (`rooms`), `generic`, `toCheck`, `noDiscount`, `featured` (`customersApp`), `brandId`, `position`, `productionValue` (interi 0–1.000.000 o `null`), `duration` (`HH:mm`) e `maxConcurrent` (intero o `null`; `services`), `validFrom` e `validTo` (istanti ISO o `null`), `availability` `{ pos (cash), warehouse (warehouse), scales (scales), ecommerce (customersApp) }`, `integrations` `{ floodOrders, yellgo, leggimenu }` (sempre accettati), `scaleType` (`weight` o `piece`; `scales`), `loadUnit`, `unloadUnit` (valori delle unità di misura del gruppo) e `conversionRatio` (> 0; `warehouse`), `colors` `{ text, background }` (`#RRGGBB`, minuscolo; `cash`), `dining` `{ halfPortion, feePercentage, hiddenOnHandheld, affiliatedMenu, reversePrint }` (`rooms`), `modifier` (solo per un modificatore, con `productsVariants`) `{ type: addRemove | add | remove | info, pricePercentagePlus, pricePercentageMinus, description }`.
- **Barcode:** `barcodes` `[ { value (fino a 64), loadQuantity (warehouse), saleQuantity } ]`, al più 100, nessun valore ripetuto.
- **Prezzi:** `prices` (vedi sotto). **Categorie:** `categoryIds` (al più 100). **Attributi:** `attributeIds` (id degli attributi dei gruppi di attributi, al più 200).
- **Disponibilità:** `places` `[ { placeId, favorite, favoriteHandheld (rooms), position, productionCenterId } ]` (vuoto = per tutti, al più 200).
- **Varianti (modificatori)**, con `productsVariants` e mai per un modificatore: `requiredModifierIds`, `modifierIds`, `excludedModifierIds` (prodotti modificatori non cestinati, al più 500), `modifierCategoryIds` (al più 200).
- **Postazioni comanda** (`ordering`): `printStations` e `counterPrintStations`, per punto vendita, `{ "<placeId>": [idPostazione] }` (in `PATCH` `null` toglie il punto vendita; i punti vendita non nominati restano).
- **Giacenza** (`warehouse`): `stock` `{ "<placeId>": { "<storageId>": { quantity (sola lettura), min, max, location } } }`; si scrivono solo `min`, `max` e `location` (`quantity` è `422` `unknown`), mai l'oggetto intero; `costs` (sola lettura: `last`, `average`, `weightedAverage`, `lastSupplierId`, `bySupplier`).
- **Composizione:** `components` `[ { productId, quantity, waste } ]` (distinta base, al più 200; `quantity` nell'unità di carico del componente), `menu` `[ { categoryId, quantity, course (rooms), productIds } ]` e `modifierChoices` `[ { categoryId, freeQuantity, priceRule: highest | lowest, productIds } ]` (al più 50 gruppi di 500 prodotti; `modifierChoices` con `productsVariants`), `modularPriceRule` (`average` | `sum` | `fixed` | `null`; `average` è memorizzato `avarage`, il refuso che il POS si aspetta); `menu`, `modifierChoices` e `modularPriceRule` non esistono per un modificatore.
- **Media** (`media`): `image`, `gallery` (al più 20), `internalFileName`, `externalUrl` (`https:`).
- **Marginalità:** `simpleCost`. **Fornitori:** `suppliers` `[ { contactId, code, name, minQuantity, deliveryTime, deliveryTimeUnit: days | months | years, favorite, priceLists: [ { id, price, discount1, discount2, discount3 } ] } ]` (al più 50 con 20 listini ciascuno; `contactId` è un contatto del gruppo con `supplier: true` non cestinato, il filtro che il vecchio backoffice usa per i fornitori). **Spedizione:** `shipping` `{ width, height, depth, weight }`.
- **Calcolati dal server:** `family`, `isModifier`, `editable`, `placeEditable`, `trashed`, `trashedAt`, `createdAt`, `updatedAt`, `costs`, `warnings`.

**Prezzi.** `prices[] = { id, priceListId, currency, taxId, tax, net, gross, discount, validFrom, validTo, dailyFrom, dailyTo, weekDays, fromQuantity, maxSaleQuantity }` in **unità di valuta decimali** (non centesimi). In scrittura il client manda `priceListId`, `currency`, `taxId` (un'aliquota del gruppo) e `gross` **oppure** `net`: con `gross` il server calcola `net = gross / (1 + aliquota/100)` a 8 decimali; con il solo `net` calcola `gross` a 2 decimali; **se sono inviati entrambi vince `gross`**. `tax` (`rate`, `department`, `description`, `vatNature`) è la copia dell'aliquota del gruppo, **scritta sempre dal server** (non si invia). `id` lo genera il server per le regole nuove; una regola rimandata con il suo `id` conserva le chiavi che ha (anche quelle che il server non conosce), e una regola che il legacy aveva scritto senza `id` si abbina per posizione e ne riceve uno. **La lista si manda intera** e **l'ordine si conserva** (il POS modifica per indice): `PATCH` con `prices` sostituisce la lista. `discount` 0–100 (0), `validFrom`/`validTo` istanti ISO (salvati come **testo ISO**, come li scrive il vecchio backoffice; in lettura si accettano anche `Date`), `dailyFrom`/`dailyTo` `HH:mm`, `weekDays` interi 0 (domenica)–6, `fromQuantity` (1 se non inviata, `null` ammesso), `maxSaleQuantity`. Più regole per lo stesso listino sono ammesse. Mai `NaN`. Listino, valuta e aliquota devono esistere nel gruppo (`422` `prices.<i>.priceListId|currency|taxId`/`incorrect`): sono giudicati **solo** per le regole il cui insieme listino-valuta-aliquota non c'è già nel prodotto, così un vecchio listino scomparso non blocca una modifica. Al più 50 regole.

**`POST`:** richiede `name` (nella lingua richiesta, come C1); gli altri campi sono facoltativi con i predefiniti del form legacy (`type` `product`, `enabled` `true`, `availability.pos` `true` e gli altri flag `false`, `scaleType` `weight`, `conversionRatio` 1, colori `#000000`, tutte le liste vuote, `places` vuoto = per tutti). Il documento nuovo ha **tutte** le chiavi che il backoffice legacy scrive in un inserimento (58, con gli array sempre presenti), `lastAveragePrice` azzerato come fa il legacy, `tags` e `related` vuoti, `parentId` `null`, `trash` `false`, e `variant.pricePercentagePlus/Minus` salvati correttamente anche in creazione. **`PATCH`:** `If-Match`, almeno un campo; testi per lingua come JSON Merge Patch (`null` toglie una lingua), `availability`, `integrations`, `colors`, `dining`, `shipping` e `modifier` cambiano solo le chiavi inviate, le liste (`barcodes`, `prices`, `categoryIds`, `attributeIds`, `suppliers`, `components`, `menu`, `modifierChoices`, i quattro elenchi di modificatori, `gallery`, `places`) si mandano intere, `printStations`/`counterPrintStations`/`stock` si fondono per punto vendita. Un riferimento (categoria, marca, attributo, modificatore, componente, categoria o prodotto di un menu, fornitore, punto vendita, centro di produzione, postazione, deposito, immagine, unità di misura) che non esiste, è cestinato o non è nel perimetro del chiamante è `422` con `details` `<campo>.<indice>` `incorrect`; **solo i riferimenti nuovi** sono giudicati, così uno che il prodotto già ha e che è scomparso non blocca una modifica non collegata. Un componente deve essere un prodotto esistente non cestinato e **non modificatore**; **una distinta non può contenere il prodotto stesso, direttamente o attraverso altre distinte** (`422` `components.<i>.productId`/`incorrect`, oltre 1.000 prodotti da percorrere `422` `components`/`tooMany`; senza transazioni due `PATCH` simultanee potrebbero chiudere un ciclo: dopo la scrittura il server rilegge e, se trova un ciclo, **annulla la propria scrittura** e risponde `409` `components`/`incorrect`). Le postazioni devono essere del punto vendita, i centri di produzione del punto vendita, i depositi (`storages`) del punto vendita; una mappa con un punto vendita nuovo e una lista vuota si scrive in creazione, in modifica no. Le scritture usano `$set`/`$unset` dei soli campi posseduti, **foglia per foglia** dentro i contenitori (`availability`, `integrations`, `roomsSettings`, `variant`, `colors.pos`, `shippingInfo`, `modularBundle`, `medias.images`, le mappe delle postazioni, `quantity.__<place>.__<deposito>.min|max|location`) e richiedono che i contenitori mancanti siano oggetti (altrimenti `409`, mai un errore del database); ogni campo scritto deve essere ancora come è stato letto (`409` se un altro l'ha cambiato nel frattempo: il POS scrive i prezzi per indice senza toccare `updateDate`). Chiavi sconosciute, `lastAveragePrice`, `quantity.*.value`, `tags`, `related`, `parentId` e `integrations.easyappear` non si toccano mai. Una richiesta che non cambia nulla non scrive e non registra nulla (stessi `ETag` e data). Una distinta già esistente non rende un prodotto immodificabile: il controllo dei cicli dopo la scrittura parte solo se la richiesta **aggiunge** componenti. Il riferimento di un prodotto che CA e PA non raggiungono è giudicato come inesistente anche per `notModifiers` di C2 (`modifierIds` di una categoria). Un prodotto nel cestino non si modifica né si duplica (`409` `trashed`/`incorrect`).

**Funzioni del gruppo** (come C2, `422` `notAllowed` con il percorso, e il campo non compare nelle letture): `cash` (`availability.pos`, `colors`), `warehouse` (`availability.warehouse`, unità, `conversionRatio`, `stock`, `costs`, `barcodes[].loadQuantity`), `customersApp` (`availability.ecommerce`, `featured`), `rooms` (`favoriteHandheld`, `places[].favoriteHandheld`, `dining`, `menu[].course`), `scales` (`availability.scales`, `plu`, `scaleType`), `services` (`type: service`, `duration`, `maxConcurrent`), `tobaccosGamesMonopoly` (i tre tipi), `productsVariants` (modificatori, `modifier`, `modifierChoices`), `ordering` (postazioni), `media` (immagine, galleria, nome file, indirizzo).

**Perimetro di CA e PA** (regola nuova per i prodotti): vedono i prodotti **per tutti** (nessuna disponibilità, `null` o lista vuota, in entrambi i formati) o che nominano un proprio punto vendita, `404` gli altri; di questi ricevono solo i propri punti vendita in `places`, `printStations`, `counterPrintStations` e `stock`. Un prodotto con disponibilità non vuota, senza elementi anomali e **interamente** nel proprio perimetro lo **modificano per intero**, lo duplicano, lo cestinano, lo ripristinano e lo eliminano (`editable: true`). Su un prodotto **condiviso con altri punti vendita o per tutti** modificano **solo i dati dei propri punti vendita**: la propria voce di `places` (aggiungere o togliere il proprio punto vendita a un prodotto già limitato, `favorite`, `favoriteHandheld`, `position`, `productionCenterId`), le proprie chiavi di `printStations` e `counterPrintStations` e le proprie foglie di `stock`; ogni altro campo nel corpo (compresi `favorite` e `favoriteHandheld` del prodotto) è `403` con `details` `[ { "field": "<campo>", "issue": "notAllowed" } ]`, prima di ogni altro controllo; duplicare, cestinare, ripristinare ed eliminare un prodotto così è `403` senza `details`. **Non possono** (con due o più punti vendita) rendere "per tutti" un prodotto (`places` vuoto o che lo svuota: `403` `places`/`notAllowed`), né limitare un prodotto "per tutti" con `places` (stesso errore), né creare un prodotto per tutti; in un gruppo con **un solo punto vendita** (regola di C5) un prodotto per tutti è invece interamente loro, si modifica, si limita e se ne crea uno senza `places`: la creazione richiede almeno un proprio punto vendita, solo propri (`403` `places.<i>.placeId`/`notAllowed` o `places`/`notAllowed`), e così mappe delle postazioni e `stock` nominano solo propri punti vendita (`403` `printStations.<placeId>`, `stock.<placeId>`). Categorie, marche, componenti, modificatori e prodotti dei menu che non raggiungono sono giudicati come inesistenti (`422` `incorrect`). Un PA non aggancia immagini (`422` `image`/`incorrect`, come C1 e C2). `editable` (tutto) e `placeEditable` (solo i dati dei propri punti vendita, falso per un prodotto nel cestino) li calcola il server; PSA, D e SA non hanno limiti.

**Avvisi di duplicati.** Codice, PLU e barcode **non sono unici**: il salvataggio riesce sempre. Le risposte di **creazione, modifica e dettaglio** (non quelle di cestino, ripristino, duplicazione ed elenco) hanno `warnings`: `[ { "field": "code" | "plu" | "barcodes.<indice>", "issue": "duplicate", "productIds": [ … ], "others": n } ]` per ogni valore che usa anche un altro prodotto **non cestinato**: `productIds` ha al più 5 id di prodotti che il chiamante raggiunge e `others` conta gli altri (quelli che non raggiunge e quelli oltre i primi cinque; si guardano al più 100 prodotti). Valori vuoti non sono duplicati. Senza un indice la ricerca è una scansione limitata (`maxTimeMS`, `503`).

**Cestino.** `POST …/trash` e `…/restore` (`If-Match`) mettono `trash` e `trashDate` (o li tolgono) e aggiornano `updateDate`: il POS riscarica per `updateDate`. Mai bloccati dai riferimenti. Già nel cestino (o fuori del cestino per il ripristino): `409`; non interamente del chiamante: `403`. Il cestino massivo applica la stessa logica a ogni id (nessun `If-Match`, la scrittura controlla atomicamente lo stato) e riporta l'esito per elemento. `GET …/products?trashed=true` è la pagina Cestino.

**`DELETE`** (solo da cestino, `If-Match`; `409` se non è nel cestino): definitiva, `204`. I riferimenti si cercano **un tipo alla volta, dal meno costoso, fermandosi al primo tipo trovato**: il `409 CONFLICT` riporta solo quel tipo (`issue: "referenced"`, al massimo 20 riferimenti). Ordine: `productBundles.<id>` (distinta base di un altro prodotto non cestinato), `productMenus.<id>` (`selectableBundleProducts[].products`), `productModifierChoices.<id>` (`selectableVariantsBundleProducts[].products`), `productModifierLists.<id>` (`variantsRequired`, `variants`, `variantsExcluded`), `categoryModifiers.<id>` (lista `variants` di una categoria; CA e PA ricevono solo le categorie che raggiungono, e un dettaglio anonimo `categoryModifiers` per le altre), `serviceUsers.<id>` (utenti che lo hanno tra i servizi, `servicesId`, anche cestinati), `favorites.<id>` (gruppi preferiti), `promotions.<id>`. CA e PA ricevono solo gli id dei prodotti che raggiungono e un dettaglio anonimo (`productBundles`…) per gli altri, e mai gli utenti (`serviceUsers` anonimo). Se il prodotto è cambiato mentre la richiesta girava `409` senza `details`. Per C1 e C2: i `409` di eliminazione di reparti, marche, gruppi di attributi e categorie nominano ora (`products.<id>`) solo i prodotti che CA e PA raggiungono e hanno un dettaglio anonimo `products` per gli altri.

**Duplicazione** (`POST …/duplicate`, `Idempotency-Key` richiesto): copia il prodotto con il nome `<nome> (Copy)` in ogni lingua, `code` e `plu` `""`, nessun barcode, giacenze azzerate (restano `min`, `max` e `location`), `lastAveragePrice` azzerato, nuovo `_id` e nuove date, fuori dal cestino; si copiano solo i campi posseduti (non le chiavi che il server non conosce). CA e PA solo per prodotti che possono modificare per intero (`403` altrimenti). `201` con `Location` ed `ETag`.

**Registro attività:** `product.created`, `product.updated`, `product.trashed`, `product.restored`, `product.deleted`, `product.duplicated` (`metadata.sourceId`). `changes` ha i soli campi cambiati (prima e dopo); ogni lista è tagliata a 20 elementi e contata (`{ count, first }`); `integrations` è registrato come `publishing`. Per CA e PA mai id fuori dal perimetro: solo i propri punti vendita in `places`, postazioni e giacenze, e per categorie, modificatori, componenti, fornitori e marca solo il conteggio.

**Aliquote del gruppo e prodotti** (vedi anche "Reparti" in C1): una modifica di un'aliquota **riallinea la copia nei prezzi** di tutti i prodotti (anche nel cestino) con lo stesso `taxData.id`: `tax` e le cinque chiavi `taxData.id|value|department|description|natura`; se cambia la percentuale **resta fisso `taxed`** (IVA inclusa) e `price` si ricalcola a 8 decimali (un `taxed` che non è un numero lascia `price`); aggiorna `updateDate` dei prodotti toccati. A blocchi di 100 prodotti (`maxTimeMS`), nella stessa transazione dell'aliquota se il gruppo è sul cluster del common; altrimenti subito dopo, ed è ripetibile (tocca solo i prodotti che differiscono). Oltre **20.000 prodotti** da riallineare in una richiesta: nella transazione `409` `products`/`tooMany` (anche l'aliquota non si scrive); senza transazione (gruppo su un altro cluster) la `PATCH` **riesce** (l'aliquota è già scritta e registrata) e la risposta ha in più `realignment: { "complete": false, "remainingBlocks": n }` (`n` è `null` se il riallineamento è fallito; `skipped: true` se l'aliquota non è utilizzabile e i prezzi non sono stati toccati). Resta una traccia durevole: evento `group.tax.realignmentIncomplete` (esito `failure`, id dell'aliquota, blocchi rimasti o `null`, `skipped`; mai valori) oltre al log con i soli id. **Ripetere la stessa `PATCH`** (anche senza cambiare nulla) riprende da dove era arrivato. Il riallineamento tocca solo i prezzi con `taxData` oggetto e `taxData.id` testo uguale all'aliquota: forme del legacy come `taxData` o `taxData.id` che sono liste non si toccano (il ciclo converge e `updateDate` non si riscrive a vuoto). Un'aliquota con valore non finito o ≤ −100 non si usa: `422` `prices.<i>.taxId`/`incorrect` sul prezzo che la sceglie, e il riallineamento la salta (mai `Infinity` o `NaN` nei prezzi). I valori della copia (descrizione, natura…) si scrivono sempre come testo letterale, anche se iniziano con `$`. `DELETE /groups/{groupId}/taxes/{id}` di un'aliquota usata da un prezzo di un prodotto **non cestinato** è `409` con `details` `[{ "field": "products.<id>", "issue": "referenced" }]` (al massimo 20, dopo i reparti). Un'aliquota usata **solo da prodotti nel cestino** si può eliminare: il prezzo di un prodotto ripristinato avrà allora un'aliquota inesistente, che la lettura mostra (`taxId` senza aliquota nel gruppo) e che una modifica del prezzo deve sostituire.

**Letture compatte e servizi (passo C3).** `GET /v1/groups/{groupId}/lookup/products` (anche con `ids`, `type`, `modifier`, `q`) e `GET /v1/groups/{groupId}/services` mostrano a CA e PA solo i prodotti che raggiungono (per tutti o con un proprio punto vendita), come l'elenco; gli altri non compaiono, neanche per id.

**Letture compatte per il form del prodotto** (`/v1`, solo lettura, `group: true`, non aperte alla chiave di negozio):
- `GET /v1/groups/{groupId}/lookup/suppliers` (`products:read`): a cursore (`limit` ≤ 100, `cursor`, `sort`, `q` letterale sul nome, `ids`), contatti del gruppo non cestinati con `supplier: true` (lo stesso criterio con cui un prodotto valida `suppliers[].contactId`). Ogni voce è `{ "id", "name", "priceLists": [ { "id", "name" } ] }`: `name` come in `lookup/customers` (ragione sociale, altrimenti nome e cognome; mai il testo cifrato del legacy, in tal caso `""`); `priceLists` sono i `companyLists[]` del contatto (`id` e `name`, la fonte da cui il vecchio form della scheda Fornitori prende "ogni listino del fornitore"; elementi senza `id` testo scartati). Mai dati fiscali, indirizzi, recapiti né altre chiavi del contatto.
- `GET /v1/groups/{groupId}/lookup/currencies` (`products:read` o `groups:read`): `[ { "code", "symbol" } ]`. `GET …/lookup/measure-units` (stessi permessi): `[ { "id", "value", "name" } ]` (`name` è il `value`, che i prodotti memorizzano). Non paginate, `ETag` debole come `lookup/taxes`.
- `GET …/lookup/products` ha in più `categoryId` (prodotti che hanno quella categoria in `categories`, anche come testo), combinabile con `type`, `modifier`, `q`, `ids`; una categoria che il chiamante non raggiunge risponde come una inesistente (elenco vuoto). L'elenco dei prodotti ha nelle righe `lastSupplierName` (nome visualizzato del contatto `lastSupplierId`, una sola lettura per pagina; `null` se non c'è, è cestinato o non è leggibile; un contatto che non è più fornitore resta mostrato).

**Non fatto in questo passo:** l'apertura alla chiave di negozio (C5), il backoffice (C4), l'import/export, la sincronizzazione dei tabacchi.

## Catalogo per il server di punto vendita (`/v1`, passo C5)

Le route con cui il **server di punto vendita** legge il catalogo del proprio punto vendita e scrive prodotti e categorie (decisioni del 2026-11-23). Documento per chi sviluppa il negozio: `doc/Store-API.md` §4.9 (con la sequenza di primo scaricamento e di aggiornamento incrementale). Tutte sono `auth: { kind: 'store', group: true }` (chiave di negozio; un access token di un utente è `403 FORBIDDEN`), senza `groupId` né punto vendita nel percorso: il gruppo, l'azienda e il punto vendita sono quelli della chiave e nessun parametro li sceglie. **Nessuna route del catalogo del backoffice è aperta alla chiave di negozio** (`403 FORBIDDEN`): queste sono route a parte. Non esiste nulla su `/public/v1`. Passano dagli **stessi servizi** del backoffice, quindi con le stesse regole, per un chiamante limitato a un punto vendita (come un PA di quel punto vendita, con la regola del gruppo con un solo punto vendita, sezione C1).

| Metodo e percorso | Operatore | Risposta |
|---|---|---|
| `GET /v1/store-context/catalog/products` | no | `200` pagina di prodotti **interi**; query `limit` 1–50 (25), `cursor`, `family`, `updatedSince` |
| `GET /v1/store-context/catalog/products/{productId}` | no | `200` + `ETag`; `warnings` senza id di altri prodotti |
| `POST /v1/store-context/catalog/products` | sì | `201`, `Location`, `ETag`; `Idempotency-Key` |
| `PATCH /v1/store-context/catalog/products/{productId}` | sì | `200` + `ETag`; `If-Match` |
| `POST …/products/{productId}/duplicate` | sì | `201`, `Location`; `Idempotency-Key` |
| `POST …/products/{productId}/trash` · `…/restore` | sì | `200`; `If-Match` |
| `GET /v1/store-context/catalog/categories` | no | `200` pagina; query `limit` 1–100 (50), `cursor`, `updatedSince` |
| `GET …/categories/tree` | no | `200`, albero compatto, `ETag` debole e `304` |
| `GET …/categories/{categoryId}` | no | `200` + `ETag` |
| `POST …/categories` · `PATCH …/categories/{categoryId}` · `DELETE …/categories/{categoryId}` | sì | come il backoffice (`201`/`200`/`204`) |
| `GET /v1/store-context/catalog/departments` | no | `200` pagina, per nome; `403 FEATURE_DISABLED` senza la funzione `cash` |
| `GET /v1/store-context/catalog/brands` | no | `200` pagina di marche (disattivate comprese), dal meno recente; query `limit` 1–100 (50), `cursor`, `updatedSince` |
| `GET …/brands/{brandId}` | no | `200` + `ETag` |
| `POST …/brands` · `PATCH …/brands/{brandId}` · `DELETE …/brands/{brandId}` | sì | come il backoffice (`201`/`200`/`204`); corpo senza `image` (`422` `unknown`); `Idempotency-Key` in creazione, `If-Match` in modifica; `409` se un prodotto la usa |
| `GET /v1/store-context/catalog/attribute-groups` | no | `200` pagina di gruppi di attributi, dal meno recente; query `limit` 1–100 (50), `cursor`, `updatedSince`. **Nessuna route di scrittura** |
| `GET …/attribute-groups/{attributeGroupId}` | no | `200` + `ETag` |

- **Rappresentazioni.** Le stesse del backoffice (stessi mapper), viste dal punto vendita: le voci disponibili nel proprio punto vendita o per tutti (le altre sono `404`); di `places`, `printStations`, `counterPrintStations` e `stock` solo i dati del proprio punto vendita. **Esclusi per il negozio** (tipo distinto `StoreProduct`, costruito campo per campo): `costs`, `suppliers`, `simpleCost` (e `lastAveragePrice`, che non si legge) e, nei `warnings`, `productIds` e `others` (restano `field` e `issue`). I prezzi sono in **unità di valuta decimali**, come nel backoffice.
- **Elenchi** (`products`, `categories`): dal meno recente al più recente per data di modifica (`updatedAt`, a pari data per id), cursore opaco, pagina massima dichiarata (50 prodotti, 100 categorie e reparti: i prodotti sono interi). **`updatedSince`** (ISO 8601, inclusivo) restituisce le voci modificate da quell'istante **anche se disattivate e, per i prodotti, anche se nel cestino**; senza, i prodotti nel cestino non ci sono. `family` solo per i prodotti. Parametri non previsti: `422`; `limit` oltre il massimo `422`. Letture con `maxTimeMS` (5 s, oltre: `503`).
- **Parametri di percorso.** Solo `productId`, `categoryId`, `brandId` e `attributeGroupId`: il route builder verifica che siano un id (24 caratteri esadecimali, `422` `<nome>`/`format` altrimenti) subito dopo l'accesso al gruppo; ogni altro parametro nel percorso di una route del negozio blocca l'avvio.
- **Operatore** (solo scritture). Header **`X-Operator-Id`** con l'id dell'utente che opera in cassa. Il builder esegue il controllo (`operator` della route, dichiarato **esattamente** dalle route che scrivono) dopo il gruppo e **prima di leggere il corpo**. L'operatore è **dichiarato dal negozio, non autenticato dal cloud** (non concede nulla oltre la chiave); il cloud verifica che sia nell'insieme degli utenti che il negozio riceve da `GET /v1/store-context/users` (stesso filtro `storeUsersFilter`: `E` e `PA` del punto vendita, `CA` dell'azienda attuale, `SA` del gruppo; mai PSA o D, cestinati o di altri gruppi), **attivo**, con `permissions.products.w` nella propria matrice memorizzata. Ogni altro caso è la stessa risposta `403 OPERATOR_NOT_ALLOWED` (`{ "error": { "code": "OPERATOR_NOT_ALLOWED", "message": "Operator not allowed" } }`, senza `details`): nessun oracolo sugli utenti. L'evento di sicurezza `store.operatorRejected` (attore `store` con l'id della chiave; metadati `reason`: `missing`, `malformed`, `notFound`, `disabled`, `noPermission`, e `operatorId` se ben formato) è scritto al più una volta all'ora per chiave e indirizzo del client (`storeOperatorRejected:key`).
- **Registro delle attività.** Gli eventi `product.created|updated|trashed|restored|duplicated`, `productCategory.created|updated|deleted` e `productBrand.created|updated|deleted` dei servizi del backoffice, con **attore `store`** (id della chiave di negozio, nessun ruolo) e, tra i metadati, **`operatorId`** (mai come attore).
- **Idempotenza.** `Idempotency-Key` come nel backoffice, ma **legata alla chiave di negozio** (a differenza degli utenti, il principal del record è `store:<id della chiave>`): la stessa chiave usata da un utente è un'altra richiesta.
- **Limiti di frequenza.** `api:store` (600 al minuto per chiave) si applica a ogni richiesta della chiave, quindi anche a queste. Le 11 route di scrittura (prodotti, categorie e marche) dichiarano in più la regola **`store-catalog-write:store`**: `RATE_LIMIT_STORE_CATALOG_WRITE_PER_STORE`, default 120 al minuto per chiave (1–1.000.000), `429` con `Retry-After`, evento `rateLimit.exceeded` con attore `store` e `bucket` al primo eccesso. Gira prima del controllo dell'operatore (conta anche gli operatori rifiutati) e prima della lettura del corpo.
- **Corpi di scrittura.** Quelli del backoffice senza `simpleCost`, `suppliers`, `image` e `gallery` per i prodotti (`storeCreateProductBody`, `storePatchProductBody`) senza `image` e `icon` per le categorie (`storeCreateCategoryBody`, `storePatchCategoryBody`) e senza `image` per le marche (`storeCreateBrandBody`, `storePatchBrandBody`): `422` `unknown` per queste chiavi, nulla scritto. La duplicazione copia costi e fornitori dell'origine senza mostrarli.
- **Non esistono** per il negozio: eliminazione definitiva di un prodotto (`DELETE` e `…/trash` multiplo rispondono `404`/`405`), svuotamento del cestino, scritture su reparti e gruppi di attributi, sincronizzazione dei tabacchi (passo C7: solo dal backoffice).
- **Errori:** `401`; `403 STORE_DISABLED`; `403 FORBIDDEN` (non è una chiave di negozio, o campo di una voce condivisa; `details` con il campo); `403 OPERATOR_NOT_ALLOWED`; `403 FEATURE_DISABLED` (reparti); `404 NOT_FOUND` (voce inesistente, di un altro punto vendita o di un altro gruppo: la stessa risposta); `409`; `412`; `413` (prodotto 256 KB, categoria 128 KB); `415`; `422`; `429`; `503`.

## Catalogo: import ed export XLSX (`/v1`, passo C6)

Un solo file XLSX a **tre fogli**, riconosciuti per nome (`Prodotti`, `Varianti`, `Categorie`, in qualsiasi ordine), con le **stesse colonne e intestazioni del modello del legacy** (63, 64 e 9 colonne fisse) più le colonne dei punti vendita. Serve a tre usi: modello vuoto, esportazione del catalogo, importazione. Permessi `products:read` (modello ed esportazione) e `products:update` (importazione); `group: true`; **non aperte alla chiave di negozio** (`403`). Errori comuni: `401`, `403 FORBIDDEN`, `404` (gruppo non raggiungibile), `429 RATE_LIMITED`.

### GET /v1/groups/{groupId}/catalog-export/template
Il modello: i tre fogli con le sole intestazioni. Le colonne dei punti vendita sono una per ogni punto vendita **non cestinato nel perimetro del chiamante** (SA/D/PSA tutti, CA e PA solo i propri): `DISPO | <nome>` in `Prodotti` e `Varianti`; `POSTAZIONI SALA | <nome>`, `POSTAZIONI BANCO | <nome>` e `DISPO | <nome>` in `Categorie` (in quest'ordine, tutte le sale, poi tutti i banchi, poi tutte le disponibilità). Più di 60 punti vendita nel perimetro: `413`. Risposta `200`, `Content-Type` XLSX, `Content-Disposition: attachment; filename="products-variants-categories-model.xlsx"` (nome fatto dal server), `Cache-Control: no-store`.

### GET /v1/groups/{groupId}/catalog-export?references=ids|names
Il catalogo raggiungibile dal chiamante, ordinato per nome (lingua `it`): in `Prodotti` i prodotti **abilitati e non cestinati** di tipo prodotto, servizio ed esente; in `Varianti` le varianti abilitate; in `Categorie` le categorie abilitate. **Restano fuori** i tabacchi/giochi/monopoli (hanno la loro sincronizzazione, passo C7), i prodotti cestinati e, come nel legacy, i **disattivati** (il file non ha una colonna di stato: la riattivazione resta nel backoffice, quindi nulla diventa irraggiungibile).
- `references` (predefinito `ids`): vale per tutte le colonne che ammettono id o nome: categorie del prodotto, categorie di varianti, genitore, listini e aliquote (con `names` l'aliquota è la **percentuale**). Un nome sconosciuto (listino non più esistente) resta l'id. Le intestazioni dei punti vendita e i nomi delle postazioni sono sempre per nome.
- Tutte le celle sono **testo** (inline): id, barcode, PLU e codici non perdono gli zeri né diventano numeri. Le celle che un foglio di calcolo leggerebbe come formula (iniziano con `=`, `+`, `-`, `@` o le forme a larghezza piena `＝ ＋ － ＠`, anche dopo spazi o spazi non separabili, oppure con tabulazione o ritorno a capo) sono precedute da un apostrofo; l'importazione lo toglie (la coppia è esatta: esporta e reimporta restituisce il valore).
- Tetto: più di **20 000** prodotti (o varianti) → `413` prima del primo byte. Un'esportazione alla volta per utente (`429`), 30 all'ora per utente (bucket `catalog-export:user`), scrittura in streaming con limite di 5 minuti.
- Registro attività: `catalog.exported` con `references` e il numero di righe dei tre fogli (mai nomi o id).

### POST /v1/groups/{groupId}/catalog-import[?dryRun=true]
`multipart/form-data` con **un solo file** nel campo `file` (altro campo, secondo file o parte: `422`), fino a 10 MB (`413`), che deve cominciare con la firma ZIP (`415` altrimenti, `415` se non è multipart). `Idempotency-Key` (UUID) obbligatoria: la stessa chiave con lo stesso file (e lo stesso `dryRun`) rilegge la stessa risposta; con un file diverso `409`. Limite di frequenza per utente: **6 all'ora** per le importazioni reali e **20 all'ora** per le verifiche (`dryRun=true`), in bucket distinti (`catalog-import:user`, `catalog-import-dry-run:user`). Una sola operazione alla volta sul catalogo **per gruppo, su qualunque istanza**: il blocco con scadenza `CATALOG_LOCK:<groupId>` in `common.settings` è **condiviso con la sincronizzazione dei tabacchi** (passo C7) e si prende prima della transazione, anche con `dryRun=true`; se un'importazione o una sincronizzazione è in corso `409` con `details: [{ "field": "group", "issue": "busy" }]` (messaggio "An import or a synchronization of this group is already running"), se il database non risponde `503`. Le altre richieste dello stesso gruppo attendono nel cancello del caricamento (al più 2 in coda per gruppo, poi `503` con `Retry-After`; un gruppo non ferma gli altri; al più 4 in elaborazione per processo).
- Limiti del file (lettore XLSX nativo): 1000 righe dati per foglio e 1500 in tutto (`422` `file`/`tooMany`), al più 189 colonne, 20 milioni di caratteri di testo, nessuna voce con rapporto di compressione oltre 100, nessuna DTD né entità; un file che non è un XLSX valido, senza nessuno dei tre fogli o con un foglio solo con l'intestazione (il modello vuoto) è `422` `file`/`incorrect`. Un foglio mancante o senza righe è semplicemente saltato (come nel legacy).
- **Tutto o niente.** Il file si applica per intero dentro **una transazione MongoDB** (snapshot, `w: majority`) sul cluster del gruppo, passando per **gli stessi service** delle route del catalogo (perimetro di CA e PA campo per campo, negozio unico, funzioni del gruppo, riferimenti, limiti, cestino). Si raccolgono i problemi di tutte le righe; con anche un solo problema, o con `dryRun=true`, la transazione si annulla e non resta nulla. Oltre **15 secondi** l'importazione si ferma con `413` (dividere il file). **Effetto sui blocchi:** Durante un'importazione o una verifica (`dryRun=true`, che esegue la stessa transazione e poi la annulla, quindi tiene gli stessi blocchi) vengono trattenuti **solo i prodotti e le categorie che il file modifica davvero**: le **scritture sul cloud** sugli stessi documenti (aggiornamento della giacenza quando una vendita arriva al cloud, modifiche al catalogo fatte dalla cassa o dal backoffice) attendono la fine dell'operazione, **al massimo 15 secondi**, e poi vengono applicate senza perdite. La vendita in cassa non ne risente (le casse lavorano su una copia locale del catalogo). Se molte scritture toccano gli stessi prodotti mentre l'importazione è in corso, l'importazione può non completarsi entro il tempo e va ripetuta. Le letture non sono bloccate.
- Ordine: categorie (create per prime e poi aggiornate con i riferimenti, così un genitore o una categoria di varianti creati nello stesso file si risolvono per nome), varianti, prodotti, e per ultima la **cancellazione delle categorie** (così si può cancellare una categoria nel file che ne sposta i prodotti).
- **Successo `200`:** `{ "data": { "dryRun": false, "sheets": { "products": {...}, "variants": {...}, "categories": {...} } } }` con, per foglio, i documenti **realmente** `inserted`, `updated` (cambiati), `removed` (prodotti cestinati, categorie eliminate) e `unchanged`. Con `dryRun=true` sono i conteggi previsti e non si scrive nulla.
- **File con problemi `422`:** `{ "error": { "code": "VALIDATION_ERROR", "message": "...", "details": [ { "field": "Prodotti!7!ALIQUOTA 1 (ID / VALORE)", "issue": "notFoundReference" } ], "rows": [ { "sheet": "Prodotti", "row": 7, "column": "ALIQUOTA 1 (ID / VALORE)", "code": "notFoundReference", "message": "..." } ], "errorCount": 3, "moreErrors": false } }`. `rows` elenca al più **200** problemi (`moreErrors: true` se ce ne sono altri; si smette di leggere dopo 1000). `row` è il numero di riga del foglio (`null` per un problema di tutto il foglio), `column` l'intestazione. Il testo è fisso: del file non si riporta mai altro che l'intestazione della colonna. **Forma estesa dell'envelope:** `code`, `message` e `details` (`{ field, issue }`, qui `field` = `foglio!riga!colonna`, `issue` = codice) sono quelli di ogni `422` (`doc/API-Guidelines.md`); `rows`, `errorCount` e `moreErrors` sono l'estensione di questa route (la risposta non passa dal gestore centrale perché porta l'elenco strutturato).
- Registro attività: i service scrivono le loro voci (`product.created/updated/trashed`, `productCategory.created/updated/deleted`, con prima e dopo come nelle route, stesso `requestId` e stesso autore) in un registro che le accumula e le **scrive dopo il commit**, seguite dalla voce riassuntiva `catalog.imported` (conteggi e `dryRun`); nulla su rollback e in `dryRun` (solo il riepilogo, con esito). Ogni esito negativo lascia `catalog.imported` con `outcome: failure` e un `reason` chiuso: `file`, `rows` (con `errors`), `tooSlow`, `error`, `busy`. Se la scrittura delle voci dopo il commit fallisce l'importazione resta valida e l'errore va al logger.

### Regole di colonna
Le colonne si riconoscono **dall'intestazione** (confronto senza maiuscole, spazi ripetuti e lo spazio prima di `)` ignorati), non dalla posizione. **Una colonna assente non modifica il dato; una colonna presente lo aggiorna** (cella vuota inclusa, dove indicato). Un'intestazione sconosciuta o ripetuta è un problema del foglio (`unknownColumn`, `duplicateColumn`) e il foglio non si legge. Si aggiorna solo ciò che il file rappresenta: i testi **in lingua `it`** (le altre lingue restano), il **primo** barcode (restano gli altri e le quantità), i prezzi per listino (restano sconto, periodi, fasce, `id` e gli altri prezzi), percentuali e descrizione delle varianti; le righe che non cambiano nulla non scrivono (esporta e reimporta lascia i documenti identici).

Legenda delle fonti: `L:` = `Controller_v_1.0.mjs` del legacy, import XLSX (`importXLSX` 2382, che usa `_productsImport` 1537 e `_categoriesImport` 2074); il legacy è un riferimento funzionale, non codice copiato.

| Colonna | Foglio | Regola | Fonte legacy |
|---|---|---|---|
| `ID` | tutti | vuoto = inserimento; pieno = aggiornamento (24 esadecimali, altrimenti `invalidId`; due volte nel foglio `duplicateId`); inesistente, cestinato, non raggiungibile o di un altro foglio/tipo (tabacchi) = errore di riga (`notFound`, `trashed`, `wrongSheet`, `notImportable`), mai ignorato | L:1559–1574, 2095–2105 (il legacy ignorava in silenzio un id inesistente e andava in errore 500 su un id non esadecimale) |
| `CANCELLAZIONE (X)` | tutti | con `ID` pieno e `X`: il prodotto va **nel cestino** (mai eliminato); la categoria si **elimina** solo se non in uso e senza sottocategorie (stessi `409` del backoffice, qui come `conflict` con i motivi), altrimenti errore di riga. `X` senza `ID`: `deleteWithoutId`. Qualsiasi altro testo: `invalidValue` | L:1570, 2101 (il legacy eliminava definitivamente, anche i discendenti) |
| `POSIZIONE` | tutti | numero intero ≥ 0 (solo cifre); vuoto = nessuna posizione | L:1759 `parseInt` |
| `NOME` | tutti | lingua `it`, obbligatorio (cella vuota `required`); colonna assente in un inserimento = `required`. Con più lingue nel gruppo vale la regola del backoffice sulla lingua richiesta | L:1659 |
| `NOME BREVE` | prodotti, varianti | `it`; vuoto toglie il testo. **Massimo 18 caratteri** (limite del form attuale); il legacy troncava a 15 in silenzio: qui un testo più lungo è un errore di riga, per non alterare in silenzio un nome | L:1655 `substring(0, 15)` |
| `CATEGORIE (ID / NOME)` | prodotti, varianti | valori separati da `\|`, ognuno tagliato; **prima l'id** (testo esatto), **poi il nome** (confronto esatto: maiuscole, spazi interni e accenti contano; nome in lingua `it`). I valori vuoti sono scartati (come nel legacy). Nome di due categorie: `ambiguousName`; nessuna corrispondenza: `notFoundReference` (il legacy scartava in silenzio e prendeva la prima). Si confronta come insieme: stesso insieme = nessuna modifica. Una categoria creata nello stesso file si risolve per nome | L:1657–1665 (id poi nome), 1768–1776, 1883–1891 |
| `GENITORE` | categorie | un solo riferimento, stessa regola id poi nome; vuoto = radice | L:2107–2116 `getCategory` (id poi nome, nome tagliato su entrambi i lati) |
| `CATEGORIE VARIANTI (ID / NOME)` | categorie | come `CATEGORIE`, per le categorie di varianti | L:2179–2186 |
| `LISTINO n (ID / NOME )`, `PREZZO n`, `ALIQUOTA n (ID / VALORE)` (n = 1…15) | prodotti, varianti | terna per listino. Una terna con le tre celle vuote è ignorata; incompleta = `incompletePrice`. Listino: **prima l'id, poi il nome esatto**; prezzo ivato con punto o virgola (`12,5`), altrimenti `invalidValue`; aliquota: **prima l'id, poi la percentuale** (`22`, `22,5`); due aliquote con la stessa percentuale = `ambiguousName`, **a meno che** il prezzo che si aggiorna abbia già una di esse (resta quella). Lo stesso listino in due terne: `duplicatePriceList`. L'imponibile si calcola come nel legacy (`ivato / (1 + aliquota/100)`, 8 decimali); valuta dei prezzi nuovi: `EUR` se il gruppo la ha, altrimenti la prima | L:1576–1618 `createPrice` (listino: chiave poi nome; aliquota: id poi `parseFloat` del valore, prima aliquota trovata), colonne 1620 e 1846 |
| `DISPONIBILE CASSA`, `PREFERITO`, `PREFERITO PALMARE`, `MOVIMENTA MAGAZZINO`, `DISPONIBILE BILANCIA`, `DISPONIBILE E-COMMERCE` (`(X)`) | prodotti, varianti (`DISPONIBILE CASSA` anche categorie) | `X` o `x` = sì, **vuoto = no, sia per una voce nuova sia per una esistente** (come nel legacy, che scriveva `cols[n] ? true : false` anche negli inserimenti: una colonna presente con la cella vuota spegne il flag, anche il predefinito del service per una voce nuova); **colonna assente** = predefinito del service per una voce nuova e nessuna modifica per una esistente; **altro testo = `invalidValue`** (il legacy considerava sì qualunque testo non vuoto). Per una voce esistente si scrive solo se cambia; un "no" per una funzione che il gruppo non ha non si invia, una `X` sì e il service la rifiuta | L:1689–1694, 1799 (`cols[n] ? true : false`) |
| `PLU` | prodotti, varianti | vuoto = nessun PLU; regole del backoffice (fino a 6 cifre) | L:1695 |
| `PEZZO/PESO (p / w)` | prodotti, varianti | `w` = a peso, `p` = a pezzo (senza maiuscole); vuoto: nessuna modifica, salvo un prodotto a peso che torna a pezzo; altro = `invalidValue` (il legacy: qualunque testo diverso da `w` era pezzo) | L:1697, 1807, 1923 |
| `DESCRIZIONE`, `DESCRIZIONE BREVE` | prodotti, varianti, categorie (`DESCRIZIONE`) | lingua `it`; vuoto toglie il testo | L:1706 |
| `CODICE` | prodotti, varianti | testo; i doppioni sono avvisi, mai errori (regola del catalogo) | L:1709 |
| `BARCODE` | prodotti, varianti | il **primo** barcode; vuoto lo toglie; un barcode già presente tra gli altri sale in prima posizione con le sue quantità; gli altri e le quantità restano | L:1710 (il legacy sostituiva l'elenco con uno solo) |
| `TIPO (pm / p / m / i)` | varianti | `pm`, `p`, `m`, `i` (senza maiuscole); vuoto: nessuna modifica (nuova variante: `pm`); altro = `invalidValue`. Percentuali e descrizione della variante restano | L:1937, 2048 `cols[1] \|\| 'pm'` (il legacy non validava) |
| `COLORE (1-12 / HEX)` | categorie | 1…12 = colore della tavolozza del legacy (`#ff8064`, `#ffbf77`, `#c69aff`, `#f7bed3`, `#ff7c9f`, `#a2624e`, `#c6a599`, `#ac9879`, `#b0b279`, `#91bcb4`, `#407674`, `#5c98b1`), oppure `#rrggbb`; altro = `invalidValue` (il legacy accettava qualunque testo per un errore di confronto); vuoto: nessuna modifica | L:2118–2127 `getColor` |
| `DISPO \| <punto vendita>` | prodotti, varianti, categorie | `X` = disponibile in quel punto vendita; **assenza di `X` toglie** quel punto vendita **conservando** preferito, posizione e centro di produzione di quelli che restano; **colonna assente = nessuna modifica**; nessuna `X` nelle colonne presenti e nessun altro punto vendita memorizzato = "per tutti" (CA e PA che non possono rendere una voce per tutti: `forbidden`, regola del negozio unico compresa). **Un CA/PA manda al service solo i punti vendita del proprio perimetro**: le voci degli altri punti vendita restano memorizzate (come con la `PATCH`), così togliere il proprio punto vendita da una voce condivisa funziona. La colonna deve nominare **un punto vendita non cestinato del perimetro**: inesistente, fuori perimetro o con il nome di due punti vendita = problema del foglio (`unknownPlace`, `ambiguousPlace`) che nomina la colonna | L:1640–1647, 1666–1680 (il legacy cercava per nome, falliva con 500 se non lo trovava e azzerava preferiti e posizioni) |
| `POSTAZIONI SALA \| <pv>`, `POSTAZIONI BANCO \| <pv>` | categorie | nomi delle postazioni di stampa del punto vendita separati da `\|` (tagliati, confronto esatto); un nome inesistente = `unknownStation`, due postazioni con lo stesso nome = `ambiguousName`; cella vuota svuota l'elenco di quel punto vendita; colonna assente = nessuna modifica | L:2143–2170 (il legacy andava in errore 500 su una postazione sconosciuta) |

**Codici di errore di riga** (stabili): `unknownColumn`, `duplicateColumn`, `unknownPlace`, `ambiguousPlace`, `invalidId`, `duplicateId`, `notFound`, `trashed`, `wrongSheet`, `notImportable`, `deleteWithoutId`, `required`, `invalidValue`, `notFoundReference`, `ambiguousName`, `incompletePrice`, `duplicatePriceList`, `notRepresentable`, `unknownStation`, `invalid` (un campo rifiutato dal service: nel testo `campo: motivo`), `forbidden`, `conflict`.

**Prezzi non rappresentabili senza ambiguità.** Una riga ha una terna per listino. Se un prodotto ha **più regole nello stesso listino** (per quantità, periodo, giorno) il file rappresenta e aggiorna solo la **regola base** (quantità minima 1, senza date, giorni né orari; altrimenti la prima di quel listino); le altre non si toccano. Se ha **più di 15 listini** si esportano i primi 15 (per ordine di comparsa) e gli altri restano. Un prezzo non si cancella mai con il file (cella vuota = nessuna modifica). Se un prezzo memorizzato non ha listino, valuta o aliquota (dato anomalo del legacy) e il file ne tocca i prezzi, la riga è `notRepresentable` e non si cambia nulla.

**Transazione.** Una sola transazione sul cluster del gruppo (`session.withTransaction`, riprovata dal driver sugli errori transitori), perché tutte le scritture stanno nel database del gruppo; non serve la transazione comune. Se il cluster non è un replica set (solo sviluppo) l'operazione fallisce con `500`.

## Catalogo: sincronizzazione dei tabacchi (`/v1`, passo C7)

Porta il **listino nazionale** (`common.tobaccos`, vedi "Listino Tabacchi") nei **prodotti del gruppo** di tipo tabacchi, e crea le categorie dei tabacchi che mancano: è la `sync-tgm` del legacy, con i difetti corretti. Due route sullo stesso percorso, permesso **`tobaccos:sync`** (solo PSA, dealer e amministratore di gruppo, quest'ultimo con il flag `products.w`; PSA e dealer lo hanno sempre), `group: true`. CA, PA ed E ricevono `403 FORBIDDEN` anche con la matrice più larga; la **chiave di negozio** `403` (non aperte al negozio); **non esistono** su `/public/v1`. Errori comuni: `401`, `403 FORBIDDEN`, `404` (gruppo non raggiungibile), `429 RATE_LIMITED`.

### GET /v1/groups/{groupId}/tobacco-sync
Lo stato, senza scrivere. `200`: `{ "data": { "available": true, "reasons": [], "warehouseAllowed": true, "tobaccoPlaces": [ { "id": "...", "name": "Bar Alfa" } ], "list": { "entries": 12738, "importedAt": "2026-11-24T08:00:00.000Z" }, "lastSync": { "at": "2026-11-24T09:00:00.000Z", "counts": { "inserted": 3, ... } } } }`.
- `available` è vero solo se **nessuna** di queste ragioni (`reasons`, nomi stabili) vale: `featureDisabled` (il gruppo non ha la funzione `tobaccosGamesMonopoly`), `noTobaccoPlace` (nessun punto vendita non cestinato con i tabacchi attivi, `tgm.status`), `noZeroTaxRate` (nessuna aliquota allo 0% nella scheda del gruppo), `noPriceList` (nessun listino), `emptyList` (il listino nazionale è vuoto).
- `warehouseAllowed`: il gruppo ha la funzione `warehouse` (l'opzione `warehouse` della richiesta è ammessa). `tobaccoPlaces`: i punti vendita con i tabacchi attivi (al più 200).
- `list.importedAt`: la data di creazione dell'ultimo documento del listino (il listino si sostituisce per intero a ogni importazione), `null` se è vuoto. `lastSync` (letta con l'indice `action_1_at_-1` del registro): l'ultima sincronizzazione **che ha scritto** (non una prova a secco) dal registro attività, con i conteggi della voce `tobaccos.synced`; `null` se non c'è (il registro conserva le voci per un tempo limitato).

### POST /v1/groups/{groupId}/tobacco-sync[?dryRun=true]
Corpo JSON **obbligatorio** (si manda `{}` per i valori di default), chiavi sconosciute `422`:

| Campo | Tipo | Default | Significato |
|---|---|---|---|
| `warehouse` | boolean | `false` | "Movimenta magazzino": `availability.warehouse` dei prodotti. Ammesso solo con la funzione `warehouse` del gruppo, altrimenti `422` `warehouse`/`notAllowed` |
| `noDiscount` | boolean | `false` | "Non scontabile" dei prodotti e delle categorie create |
| `placeIds` | elenco di id, al più 200 | `[]` | I punti vendita di disponibilità. **Vuoto o assente: tutti i punti vendita** (`placesAvailability: []`). Devono esistere nel gruppo, non essere cestinati e **avere i tabacchi attivi** (quelli di `tobaccoPlaces` del `GET`): `422` `placeIds.<indice>`/`notFound` (non esiste o è cestinato) o `notTobaccoPlace` (esiste ma senza i tabacchi); le ripetizioni si ignorano |
| `confirmMassDisable` | boolean | `false` | Conferma una sincronizzazione che **disattiverebbe più del 20%** dei tabacchi attivi del gruppo (vedi sotto). Registrato nel riepilogo `tobaccos.synced` |

`Idempotency-Key` (UUID) obbligatoria: la stessa chiave con lo stesso corpo (e lo stesso `dryRun`) rilegge la stessa risposta, con un corpo o una modalità diversi `409`. Limite per utente: **6 all'ora** per le sincronizzazioni e **20 all'ora** per le prove a secco, in bucket distinti (`tobacco-sync:user`, `tobacco-sync-dry-run:user`). **Una sola operazione alla volta sul catalogo di un gruppo, su qualunque istanza del server**: un **blocco con scadenza** nel database (`common.settings`, chiave `CATALOG_LOCK:<groupId>`, preso con una scrittura condizionata atomica, scadenza e confronto sull'orologio del database, rilasciato in ogni caso, libero se scaduto) **condiviso con l'importazione XLSX** (`catalog-import`): finché una delle due è in corso l'altra, e ogni nuova sincronizzazione del gruppo, risponde `409 CONFLICT` con `details: [{ "field": "group", "issue": "busy" }]`. Il blocco si prende **prima** di leggere e della transazione, **anche con `dryRun=true`**; se il database non risponde `503`. Un gruppo non ferma gli altri.

**Precondizioni** (nell'ordine; nessuna scrive niente e ogni rifiuto lascia `tobaccos.synced` con `outcome: failure` e il `reason`): funzione assente `403 FEATURE_DISABLED`; `warehouse` senza funzione `422`; nessun punto vendita con i tabacchi attivi `409` (`details`: `group`/`noTobaccoPlace`); **nessuna aliquota allo 0%** `409` (`group`/`noZeroTaxRate`, messaggio "The group needs a tax rate of 0% in its tax rates": nessun prodotto si crea senza prezzo); nessun listino `409` (`noPriceList`); `placeIds` non validi `422` (`notFound`, `notTobaccoPlace`); listino nazionale vuoto `409` (`emptyList`: altrimenti disattiverebbe tutti i tabacchi del gruppo); listino con più di 20 000 voci, più di 60 000 prodotti TGM o 10 000 categorie nel gruppo `413`.

**Regole.** Per ogni voce del listino nazionale (una per codice, la prima per id; le voci **fuori dai limiti del catalogo** si **saltano** e si contano in `skipped`: codice di 1–64 caratteri; nome e categoria tagliati agli spazi, al più 150 caratteri; nessun carattere di controllo in codice, nome, categoria e barcode; barcode al più 64 caratteri, al più 100 per voce, senza doppioni (il secondo uguale si ignora); quantità del barcode intera da 1 a 100 000 (altrimenti `null`, oltre il tetto la voce si salta); prezzo da 0 a 1 000 000 000; una descrizione non valida è vuota. Il codice di una voce saltata **non fa disattivare** il prodotto che lo ha):
- **Categorie.** Per ogni categoria del listino senza una categoria del gruppo con lo stesso `name.it` (senza distinguere maiuscole né spazi ai bordi) se ne crea una: `secondaryFiscalPrinter: true`, `tgm.type: true`, `availability.pos: true`, `status: true`, `noDiscount` dal parametro, disponibilità da `placeIds`, e il resto nella forma di una categoria nuova del catalogo. Se più categorie hanno lo stesso nome si usa la prima per `_id` e `categories.duplicateNames` le conta. Una categoria già esistente e riusata **non si tocca** (nemmeno la disponibilità). Una voce senza categoria (vuota) dà un prodotto senza categorie.
- **Abbinamento.** Per `code` (uguaglianza esatta) tra i prodotti del gruppo di tipo `tobaccos`, `games` e `monopoly`. Si aggiornano **tutti** i prodotti **non cestinati** con quel codice, di qualunque dei tre tipi (così nessuno resta con il prezzo vecchio); se non ce n'è nessuno, si aggiorna quello **nel cestino** con l'`_id` minore (come il legacy). `duplicateCodes` conta i prodotti del gruppo oltre il primo che hanno un codice del listino.
- **Aggiornamento** (come il legacy): `noDiscount`, `availability.warehouse`, `name.it`, `description.it`, `shortName.it` e `shortDescription.it` (azzerati a `''`), `categories` (sostituito con la sola categoria TGM), `prices` (sostituito), `barcode` (sostituito **solo se** il listino ne ha; barcode ripuliti dagli spazi, `qtLoad: null`, `qtSale` = la quantità intera o `null`), `updateDate`. Non tocca `trash`, `type` né gli altri campi. **Differenza dal legacy:** anche `placesAvailability` si **sovrascrive per intero** con i `placeIds` della richiesta (anche nei prodotti già esistenti: eventuali preferiti, posizione e centro di produzione per punto vendita si perdono).
- **Inserimento** se non abbinato: `type: 'tobaccos'`, `availability.pos: true`, `status: true`, `availability.warehouse` dal parametro (**il legacy lo lasciava sempre `false`**), disponibilità da `placeIds`, gli altri campi nella forma di un prodotto nuovo del catalogo; `shortName.it` e `shortDescription.it` sono `''` (come l'aggiornamento: così una seconda sincronizzazione non trova nulla da cambiare).
- **Prezzi.** Un prezzo per **ogni** listino del gruppo (anche disattivato): valuta `EUR`, prezzo ivato = prezzo del listino nazionale, aliquota **del gruppo di valore 0** (se ce n'è più d'una: quella con la natura IVA, altrimenti la prima), imponibile = ivato, sconto 0, quantità minima 1. L'`id` di una regola dello stesso listino già presente nel prodotto si mantiene.
- **Usciti dal listino: disattivati.** Ogni prodotto di tipo `tobaccos`, **non cestinato**, con `code` non vuoto, che non è più nel listino, passa a `status: false` (`disabled`). I giochi e il monopolio non si toccano.
- **Tornati nel listino: riattivati.** Un prodotto di tipo `tobaccos`, non cestinato, **disattivato** (`status` diverso da `true`) il cui codice è nel listino torna a `status: true` (`reactivated`), **qualunque sia il motivo della disattivazione, anche se l'ha disattivato una persona**: la sincronizzazione non distingue (il documento del prodotto non ha nessuna chiave in più). Chi vuole tenere spento un tabacco deve toglierlo dal listino o accettare che la sincronizzazione lo riaccenda.
- **Non scrive ciò che non cambia:** un prodotto già uguale a quanto la sincronizzazione scriverebbe non viene toccato (nemmeno `updateDate`) e si conta in `unchanged`.

**Tutto o niente.** Una **transazione** sul cluster del gruppo (snapshot, `w: majority`); il listino nazionale (cluster comune) si legge prima. Misurata in locale: 20 000 inserimenti 1,3 s, 20 000 aggiornamenti 1,2 s. **Oltre 15 secondi** (come l'importazione), contati **dalla presa del blocco e compresa la lettura del listino nazionale**, si ferma con `413` e non resta nulla; il tempo che resta è anche il limite (`maxTimeMS`) di ogni lettura. Scritture a blocchi di 500 operazioni nella stessa transazione. **Effetto sui blocchi:** durante la sincronizzazione sono trattenuti solo i prodotti e le categorie che scrive davvero: le **scritture sul cloud** sugli stessi documenti (giacenze, modifiche del catalogo dalla cassa o dal backoffice) attendono la fine, **al massimo 15 secondi**, e poi si applicano senza perdite; la vendita in cassa non ne risente (lavora su una copia locale); le letture non sono bloccate. Con `dryRun=true` **non si apre nessuna transazione e non si scrive nulla**: il piano si calcola dalle letture e non tiene blocchi.

**Soglia di disattivazione.** Se la sincronizzazione disattiverebbe **più del 20%** dei tabacchi attivi del gruppo (non cestinati, `status: true`, calcolato sul piano) **si ferma senza scrivere** e risponde `409 CONFLICT`: `{ "error": { "code": "CONFLICT", "message": "...", "details": [ { "field": "group", "issue": "massDisable" } ], "disabled": 2, "active": 5, "thresholdPercent": 20 } }`. Per procedere si ripete la richiesta (con una nuova `Idempotency-Key`) con `confirmMassDisable: true`. Il `dryRun` non si ferma: risponde `200` con i conteggi e `massDisable: { "active": 5, "exceeded": true }` (la soglia sarebbe superata).

**Successo `200`:** `{ "data": { "dryRun": false, "products": { "inserted": 12, "updated": 3, "disabled": 1, "reactivated": 0, "unchanged": 12722, "skipped": 0 }, "categories": { "inserted": 2, "duplicateNames": 0 }, "duplicateCodes": 0, "massDisable": { "active": 12000, "exceeded": false } } }`. Un prodotto ha **un solo esito** (`reactivated` e `disabled` non si sommano a `updated`). Con `dryRun=true` sono i conteggi previsti, la transazione si annulla e non si scrive nulla.

**Registro attività.** Voce riassuntiva `tobaccos.synced` (`dryRun`, `warehouse`, `noDiscount`, `confirmMassDisable`, `places`, i conteggi, `massDisableExceeded`, `entries` e `entriesOmitted`, oppure `outcome: failure` con `reason` chiuso: `featureDisabled`, `warehouse`, `noTobaccoPlace`, `noZeroTaxRate`, `noPriceList`, `places`, `emptyList`, `tooLarge`, `tooSlow`, `busy`, `massDisable`, `error` (anche ogni fallimento fuori dalla transazione); mai contenuti del listino) e, dopo il commit, le voci `productCategory.created`, `product.created` e `product.updated` (anche per le disattivazioni e le riattivazioni) con prima e dopo e lo stesso `requestId`: **al più 500** voci per sincronizzazione, le altre sono contate in `entriesOmitted`. Nulla su rollback e in `dryRun` (solo il riepilogo).

## Listino Tabacchi (`/v1`, passo T3)

Il listino nazionale dei tabacchi (il file ufficiale ADM), **unico per tutta la piattaforma**: collection `tobaccos` del database comune, la stessa che il legacy riempie e legge (la sincronizzazione del catalogo, con il dominio Catalogo). Le due route sono **solo del PSA** (`tobaccos:read` e `tobaccos:import` sono solo nel suo tetto, concessi dai flag `groups.r` / `groups.w` come i permessi `dealers:*`): ogni altro ruolo riceve `403 FORBIDDEN`, anche con la matrice più larga, e la chiave di negozio `403` (le route non sono aperte al negozio). Errori comuni: `401 UNAUTHENTICATED` / `TOKEN_EXPIRED`, `403 FORBIDDEN`, `403 PASSWORD_CHANGE_REQUIRED`, `429 RATE_LIMITED`.

### GET /v1/tobaccos
- **Superficie:** backoffice
- **Autenticazione e permesso:** Bearer backoffice, `tobaccos:read`; solo PSA
- **Query** (sconosciuti: `422`):
  | Parametro | Valori | Note |
  |---|---|---|
  | `limit` | 1–100 | default 50 |
  | `cursor` | opaco | quello di `page.next`, valido solo per lo stesso `sort`; altro è `422` `cursor`/`format` |
  | `sort` | `code` (default), `name`, `category`, `priceKg`, `price`, `barcode`, ciascuno anche con `-` | `barcode` è il primo barcode del prodotto; un valore mancante o del tipo sbagliato (il legacy scriveva ciò che trovava nel file) viene prima in ordine crescente; a parità l'ordine è per `_id` |
  | `q` | testo 1–64 caratteri | cerca nel nome e nel codice, in modo letterale e senza distinzione tra maiuscole e minuscole |
  | `category` | testo 1–100 caratteri | categoria uguale (confronto esatto) |
- **Risposta:** `200` `{ data, page: { limit, next } }` con `ETag` debole e `Cache-Control: no-store`; `If-None-Match` uguale dà `304` senza corpo. Ogni riga è la proiezione delle colonne della tabella (barcode secondari, peso, pezzi e descrizione non escono):
  ```json
  { "id": "665f1c2e9b1d4a0012ab3701", "code": "0001", "name": "Marlboro Red 20", "shortName": "MARLBORO R", "category": "Sigarette",
    "priceKg": 380, "price": 7.6, "barcode": "8000000000017" }
  ```
  `priceKg` e `price` sono numeri o `null`; i testi mancanti o del tipo sbagliato sono `''`; `barcode` è `null` se il prodotto non ne ha.
- **Errori:** `401`, `403 FORBIDDEN`, `422 VALIDATION_ERROR`, `429`

### POST /v1/tobaccos/import
- **Superficie:** backoffice
- **Autenticazione e permesso:** Bearer backoffice, `tobaccos:import`; solo PSA. **`Idempotency-Key`** obbligatoria (UUID, controllata **prima** di leggere il file: `422` `Idempotency-Key`/`required` o `format`). La stessa chiave con lo stesso file risponde di nuovo la stessa risposta senza rifare nulla; la stessa chiave con un file diverso è `409 CONFLICT`. **Rate limit** dedicato per utente: `RATE_LIMIT_TOBACCOS_IMPORT_PER_USER`, **5 all'ora** di default (`429` con `Retry-After`), oltre a quello generale.
- **Body:** `multipart/form-data` con **un solo** file nel campo `file` (l'`.xlsx` del listino ADM) e nient'altro. Il file sta in memoria (mai su disco), al massimo **10 MB**; si accetta solo se i primi byte sono la firma ZIP `PK\x03\x04` (il nome e il tipo dichiarati non contano). Un'importazione alla volta nel processo, due in attesa: oltre, `503` con `Retry-After`.
- **Formato del file** (prima riga di intestazione, primo foglio): colonne 1 categoria, 2 codice, 3 nome, 4 nome breve, 5 prezzo/kg, 6 prezzo, 7 peso unitario, 8 numero pezzi, 9 descrizione, da 10 a 29 fino a dieci coppie (barcode, quantità per confezione). Le righe vuote e quelle di soli spazi si saltano; una coppia con il barcode vuoto si salta con la sua quantità, come nel legacy.
- **Regole, tutte verificate su ogni riga prima di scrivere** (il legacy non verificava nulla): codice e nome obbligatori; codice unico nel file (`^[A-Za-z0-9._/ -]{1,40}$`); testi tagliati agli spazi, senza caratteri di controllo (tranne tabulazione e a capo), al massimo 100 (categoria, nome breve), 200 (nome), 1000 (descrizione) caratteri; prezzo/kg, prezzo e peso: numeri finiti, **non negativi**, fino a 1 000 000 000, vuoti = `null` (come testo si accetta la virgola decimale); numero di pezzi e quantità: interi (quantità fino a 100 000); barcode **`^[0-9]{8,14}$`** (anche se la cella è un numero); al massimo **20 000** prodotti (il listino nazionale ne ha poche migliaia).
- **Limiti del lettore per questo file:** 25 000 righe, 29 colonne, 20 MB per voce e 30 MB in tutto da decomprimere, 32 767 caratteri per cella e 20 milioni di caratteri di testo in tutto (un riferimento a una stringa condivisa conta quanto il suo testo); oltre, `422` `file`/`incorrect`.
- **Cosa succede.** Solo se **l'intero file è valido** l'intero listino è sostituito in **una transazione** sul cluster comune (`deleteMany({})` e `insertMany` a blocchi di 1000, con `readConcern snapshot` e `writeConcern majority`): chi legge vede il listino vecchio o il nuovo, mai una via di mezzo, e un errore a metà lascia il vecchio intatto. Documenti come nel legacy: `{ category, code, name, shortName, priceKg, price, unitWeight, numPieces, description, barcodes: [{ barcode, quantity }] }`.
- **Risposta:** `200` `{ data: { inserted, previous, elapsedMs } }` (prodotti del nuovo listino, di quello sostituito, millisecondi impiegati dalla lettura del file alla fine della sostituzione). Registra `tobaccos.imported` (solo i due conteggi, nessun prodotto); un file rifiutato (`422`) registra `tobaccos.imported` con esito `failure` e il solo motivo (`file` o `rows`). Il PSA ha sempre l'intero tetto del ruolo (D-28): i flag `groups.r`/`groups.w` della sua matrice non lo limitano.
- **Errori:**
  - `413 PAYLOAD_TOO_LARGE`: file oltre 10 MB.
  - `415 UNSUPPORTED_MEDIA_TYPE`: la richiesta non è `multipart/form-data`, o il file non comincia con la firma ZIP.
  - `422 VALIDATION_ERROR`:
    - `file`/`required`: nessun file, o nessun prodotto nel file;
    - `file`/`tooMany`: più di 20 000 prodotti;
    - `file`/`unknown` (un file in un altro campo) e `(body)`/`unknown` (più file o un campo di testo);
    - `file`/`incorrect`, con un messaggio fisso (mai un byte del file): non è un XLSX, è danneggiato, usa ZIP64 o la cifratura, ha un nome di voce non sicuro (assoluto, con `..`, duplicato), contiene una `<!DOCTYPE`, supera i limiti del lettore (50 voci, 50 MB per voce e 100 MB in tutto da decomprimere, rapporto di compressione 100, 100 000 righe, 50 colonne);
    - **righe non valide**: un dettaglio per problema, al massimo 50, con `field` `rows[<riga del foglio>].<campo>` (`category`, `code`, `name`, `shortName`, `priceKg`, `price`, `unitWeight`, `numPieces`, `description`, oppure `barcodes[<n>].barcode` / `barcodes[<n>].quantity`, con `n` da 0) e `issue` tra `required`, `type`, `minimum`, `maximum`, `maxLength`, `pattern`, `format`, `taken` (codice già presente nel file). La riga 1 è l'intestazione. Il listino resta com'era.
  - `400 BAD_REQUEST`: corpo multipart non valido. `409 CONFLICT`: chiave già usata con un altro file o richiesta ancora in corso. `429 RATE_LIMITED`. `503 SERVICE_UNAVAILABLE`: troppe importazioni in coda.

## Ricerca di un'azienda per P.IVA (`/v1`, passo 8.1.5)

Compila il wizard "Nuovo cliente" con i dati che Cerved ha di un'azienda italiana. Una sola route, **solo per chi crea clienti**: permesso `groups:create` (in pratica **PSA e D**); SA, CA e PA ricevono `403 FORBIDDEN`, la chiave di negozio `403` (la route non è aperta al negozio) e non esiste su `/public/v1`. **Non è una route di gruppo.** Errori comuni: `401 UNAUTHENTICATED` / `TOKEN_EXPIRED`, `403 FORBIDDEN`, `403 PASSWORD_CHANGE_REQUIRED`.

### GET /v1/vat-lookups/{vatNumber}
- **Superficie:** backoffice
- **Autenticazione e permesso:** Bearer backoffice, `groups:create`. **Rate limit** dedicato per utente: `RATE_LIMIT_CERVED_LOOKUP_PER_USER`, **10 al minuto** di default e un tetto giornaliero `RATE_LIMIT_CERVED_LOOKUP_PER_USER_DAILY`, **200 al giorno** (finestra di 24 ore) di default: superato uno dei due, `429 RATE_LIMITED` con `Retry-After`, prima di chiamare il provider; si aggiungono a quello generale: ogni ricerca sono due chiamate a pagamento al provider. Il conteggio vale anche per le richieste con una P.IVA non valida.
- **Parametro:** `vatNumber`, una P.IVA italiana: **11 cifre con la cifra di controllo giusta**. Si accetta con gli spazi ai lati e con il prefisso `IT` (in qualunque combinazione di maiuscole e minuscole); la risposta riporta sempre le sole 11 cifre.
- **Cosa fa.** Controlla la P.IVA (senza chiamare nessuno), cerca il soggetto su Cerved e prende **solo** quello la cui `partita_iva` è **esattamente** quella richiesta (mai il primo della lista); poi legge il profilo per la PEC. **Nessuna cache**: ogni ricerca è una chiamata nuova. Timeout di 8 secondi per ogni chiamata, nessuna ripetizione.
- **Risposta:** `200`
  ```json
  { "data": { "vatNumber": "12345678903", "name": "ROSSI SRL", "fiscalCode": "12345678903",
              "address": { "street": "VIA ROMA 1", "postcode": "20100", "city": "MILANO", "province": "MI", "country": "IT" },
              "pec": "rossi@pec.example" } }
  ```
  Ogni testo è tagliato agli spazi; un dato che Cerved non dà è `null`. `province` è la sigla di due lettere (maiuscola), `null` se Cerved dà altro. `country` è sempre `IT`. **Non ci sono** il codice destinatario (Cerved non lo fornisce), il codice ATECO né la forma giuridica. Se la lettura del profilo fallisce (errore, timeout, risposta illeggibile) la risposta è comunque `200` con `pec: null`.
- **Errori:**
  - `422 VALIDATION_ERROR`: `details: [{ "field": "vatNumber", "issue": "format" | "checksum" }]`: `format` se non sono 11 cifre (dopo l'eventuale `IT`: una P.IVA estera è `format`), `checksum` se la cifra di controllo non torna. Il provider non è chiamato.
  - `404 NOT_FOUND`: Cerved non ha nessun soggetto con **quella** P.IVA (anche se ne restituisce altri).
  - `429 RATE_LIMITED`: troppe ricerche al minuto o nel giorno (`Retry-After` in secondi).
  - `503 SERVICE_UNAVAILABLE`: `CERVED_API_KEY` non è configurata (la route resta montata), oppure Cerved ha risposto con un errore, una risposta che non è quella attesa o troppo grande (oltre 1 MB), non ha risposto in 8 secondi o non è raggiungibile. Il corpo e il messaggio del provider non sono mai riportati.
- **Registro attività:** ogni ricerca registra `vatLookup.performed` (categoria `data`; `resource` `{ type: "vatLookup", id: <P.IVA> }`; metadati `{ outcome: "found" | "notFound" | "unavailable" }`; esito `success` per `found` e `notFound`, `failure` per `unavailable`). Le richieste rifiutate prima della ricerca (`401`, `403`, `422`, `429`) non la registrano. Nessun dato dell'azienda, nessuna chiave. La P.IVA non compare mai nei log applicativi: nel log degli accessi il percorso è `/v1/vat-lookups/:vatNumber` (anche con un target di richiesta in forma assoluta o con segmenti `.`; un target illeggibile è registrato come `/:unparseable`).

## Registro attività ed errori (`/v1`)

### GET /v1/activity-log
- **Superficie:** backoffice
- **Autenticazione e permesso:** Bearer backoffice, `activityLog:read`
- **Ruoli e perimetro:** PSA: tutto il registro; D: le voci dei propri gruppi (attivi); SA: le voci del proprio gruppo; CA e PA: **solo le proprie azioni, escluse le segnalazioni di allerta** (`rateLimit.sustainedExceeded`: non le leggono mai, nemmeno se riguardano loro). La categoria `error` (e le sue azioni, come `client.error`) è **riservata al PSA**: per gli altri ruoli `category=error` o un'`action` di quella categoria dà `403 FORBIDDEN`. Un `groupId` fuori dal perimetro non dà errore: la pagina è vuota.
- **Query:**
  | Parametro | Tipo | Note |
  |---|---|---|
  | `limit`, `cursor` | come nelle "Liste" | l'ordine è fisso: più recenti prima (data decrescente); nessun `sort` né `q` |
  | `category` | `data`, `security`, `error` | |
  | `action` | uno dei nomi del catalogo delle azioni (es. `auth.loginFailed`, `user.created`, `client.error`, `rateLimit.sustainedExceeded`) | un nome sconosciuto è `422` (`enum`) |
  | `alerts` | `true` (nessun altro valore: `422`) | seleziona le **azioni di allerta** decise dal server (oggi `rateLimit.sustainedExceeded`, `request.nonBrowser`, `settings.securityPolicyUpdated`, `store.activationCodeForActivePlace`, `store.activeKeyReplaced`, `store.activeKeyRevoked`; le stesse di `GET /v1/activity-log/alerts/count`), nello stesso perimetro e combinabile con gli altri filtri (con `action` vale l'intersezione) |
  | `outcome` | `success`, `failure`, `denied` | |
  | `actorId`, `groupId` | 24 caratteri esadecimali | |
  | `requestId` | stringa 1–128 caratteri | l'id della richiesta (`X-Request-Id`) che ha generato la voce |
  | `from`, `to` | data `2026-11-01` o data-ora UTC `2026-11-01T08:00:00.000Z` | estremi **inclusivi**; `to` precedente a `from` o intervallo oltre **400 giorni** è `422` su `to` (`minimum` / `maximum`) |
- **Risposta:** `200` `{ data, page }`. Ogni voce ha: `id`, `at` (ISO UTC), `category`, `action`, `outcome`, `actor` (`kind` `user` / `anonymous` / `system`, `id`, `role`, `username`), `groupId`, `resource` (`type`, `id`) o `null`, `changes` (modifiche di campo `field`, `before`, `after`, con `redacted` / `truncated` quando il valore è oscurato o troncato), `requestId`, `ip`, `metadata` (valori semplici) e, solo sulle voci `client.error`, `error` (`name`, `message`, `stack`). Se l'attore ha un **ruolo superiore** a chi guarda, `actor.id`, `actor.username` e `ip` sono `null` (il ruolo resta visibile); `username` è `null` anche per attori non utente o utenti non più esistenti.
  ```json
  {
    "data": [
      {
        "id": "665f1c2e9b1d4a0012ab3500",
        "at": "2026-11-04T09:12:30.000Z",
        "category": "data",
        "action": "user.updated",
        "outcome": "success",
        "actor": { "kind": "user", "id": "665f1c2e9b1d4a0012ab34ce", "role": "SA", "username": "mario.rossi" },
        "groupId": "665f1c2e9b1d4a0012ab34a1",
        "resource": { "type": "user", "id": "665f1c2e9b1d4a0012ab34d2" },
        "changes": [{ "field": "phone", "before": null, "after": "+39 02 1234567" }],
        "requestId": "0b9f3c2a-7e1d-4c55-9a38-2f6d1e8b7a10",
        "ip": "203.0.113.10",
        "metadata": {}
      }
    ],
    "page": { "limit": 50, "next": null }
  }
  ```
- **Errori:** `401 UNAUTHENTICATED` / `TOKEN_EXPIRED`, `403 FORBIDDEN` (permesso mancante, categoria o azione `error` per i non PSA), `403 PASSWORD_CHANGE_REQUIRED`, `422 VALIDATION_ERROR` (parametri non validi, intervallo, `cursor`/`format`)

### GET /v1/activity-log/alerts/count
- **Superficie:** backoffice
- **Autenticazione e permesso:** Bearer backoffice, `activityLog:read`. **Non** aperta alla chiave di negozio (`403 FORBIDDEN`).
- **Scopo:** il numero di allerte recenti per il badge sulla voce di menu del registro. Le **azioni di allerta** sono un insieme chiuso deciso dal server (oggi `rateLimit.sustainedExceeded`: un utente ha superato il limite orario o giornaliero su `/v1`; `request.nonBrowser`: una richiesta con le credenziali di un utente non sembra di un browser; `store.activationCodeForActivePlace`: generato un codice di attivazione per un punto vendita con una chiave attiva; `store.activeKeyReplaced`: un'attivazione ha sostituito la chiave attiva; `store.activeKeyRevoked`: revoca manuale di una chiave attiva; `settings.securityPolicyUpdated`: la politica di sicurezza è stata cambiata). Per l'elenco: `GET /v1/activity-log?alerts=true`.
- **Perimetro:** lo stesso di `GET /v1/activity-log`: PSA tutto; D i propri gruppi; SA il proprio gruppo. **CA e PA non vedono mai le allerte** (nemmeno quelle che li riguardano): per loro il conteggio è sempre `0` e `GET /v1/activity-log` non le elenca. Il conteggio riguarda solo ciò che il registro mostra a chi chiede.
- **Query:** `since` (obbligatorio): data-ora UTC `2026-11-23T08:00:00.000Z` o data `2026-11-23`; non più di **30 giorni** indietro (`422` su `since`, `minimum`); mancante `422` (`required`), non valida `422` (`format`). Nessun altro parametro.
- **Risposta:** `200` `{ "data": { "count": 3, "capped": false } }`. `count` arriva al massimo a **100**; se ce ne sono di più `count` è 100 e `capped` è `true` (da mostrare come "100+").
- **Errori:** `401`, `403`, `422`, `429 RATE_LIMITED`, `503 SERVICE_UNAVAILABLE` se la lettura supera il tempo massimo (5 s).
- **Per la lista delle allerte** si usa `GET /v1/activity-log?alerts=true&from=<ISO>`.

### POST /v1/client-errors
- **Superficie:** backoffice
- **Autenticazione e permesso:** Bearer backoffice, `clientErrors:create`, concesso **sempre** a ogni ruolo da PSA a PA. È ammessa anche con una password provvisoria da cambiare (l'errore può avvenire proprio in quella schermata).
- **Body** (`application/json`, massimo 8 KB, nessun'altra proprietà): un errore JavaScript intercettato dal backoffice.
  | Campo | Tipo | Obbligatorio | Vincoli |
  |---|---|---|---|
  | `name` | stringa | sì | 1–100 caratteri, senza caratteri di controllo (es. `TypeError`) |
  | `message` | stringa | sì | fino a 300 caratteri (anche vuota) |
  | `stack` | stringa | no | fino a 4000 caratteri |
  | `route` | stringa | sì | 1–200 caratteri; il **pattern** della route, non l'URL concreto: `/` oppure segmenti che sono un nome letterale (`A-Za-z0-9_-`), un parametro `:nome` o `**`. Query string, frammenti, segmenti numerici e id esadecimali di 24 caratteri sono rifiutati (`pattern`), es. `/groups/:groupId/users` |
  | `appVersion` | stringa | sì | 1–32 caratteri tra lettere, cifre, `.`, `+`, `-` (es. `1.4.2`) |
  | `occurredAt` | data ISO 8601 | no | validata, ma non conservata |
  ```json
  { "name": "TypeError", "message": "Cannot read properties of undefined", "stack": "TypeError: …\n    at …", "route": "/groups/:groupId/users", "appVersion": "1.4.2" }
  ```
- **Header particolari:** `RateLimit-*` (**30 richieste al minuto per utente** di default)
- **Risposta:** `202` senza body. Viene salvata una voce `client.error` (categoria `error`, esito `failure`) nel registro attività, attribuita all'utente e al suo gruppo, con `route`, `appVersion` e `User-Agent` (troncato a 120 caratteri) nei `metadata`, e `name`, `message`, `stack` in `error`; il testo è redatto dei dati sensibili e limitato in lunghezza. Lo stesso errore (stesso utente, nome, messaggio e prima riga dello stack) non viene salvato di nuovo per **10 minuti**; oltre un tetto di voci al minuto sul server le segnalazioni in eccesso sono scartate. In entrambi i casi la risposta è comunque `202`: la segnalazione non fallisce mai la richiesta.
- **Errori:** `401 UNAUTHENTICATED` / `TOKEN_EXPIRED`, `403 FORBIDDEN`, `400 MALFORMED_JSON`, `413 PAYLOAD_TOO_LARGE`, `415 UNSUPPORTED_MEDIA_TYPE`, `422 VALIDATION_ERROR` (per campo, `route` / `appVersion` `pattern`), `429 RATE_LIMITED` con `Retry-After`

## Dealer (`/v1`, solo PSA)

Anagrafica aziendale dei dealer. Un dealer è un documento anagrafico con **lo stesso id** del suo utente `D`: `dealerId` coincide con l'`id` dell'utente. Le route richiedono i permessi `dealers:*`, che hanno solo i PSA: ogni altro ruolo riceve `403 FORBIDDEN`. Errori comuni: `401 UNAUTHENTICATED` / `TOKEN_EXPIRED`, `403 FORBIDDEN`, `403 PASSWORD_CHANGE_REQUIRED`, `400 MALFORMED_JSON`, `413 PAYLOAD_TOO_LARGE` (16 KB), `415 UNSUPPORTED_MEDIA_TYPE`, `422 VALIDATION_ERROR`.

Rappresentazione di un dealer:
```json
{
  "id": "665f1c2e9b1d4a0012ab34d1",
  "businessName": "Dealer Nord Srl",
  "vatNumber": "01234567890",
  "fiscalCode": "01234567890",
  "address": { "street": "Via Roma 1", "postcode": "20100", "city": "Milano", "province": "MI", "countryCode": "IT" },
  "pec": "dealernord@pec.example.com",
  "sdiCode": "ABC1234",
  "email": "info@dealernord.example.com",
  "phone": "+39 02 1234567",
  "source": "manual",
  "createdAt": "2026-11-04T09:00:00.000Z",
  "updatedAt": "2026-11-04T09:00:00.000Z",
  "user": { "id": "665f1c2e9b1d4a0012ab34d1", "username": "dealer.nord", "status": "active" }
}
```
`source` indica l'origine (`manual` creato da un PSA, `migration`, `user` creato insieme a un utente `D` da `POST /v1/users`). Tutti i campi anagrafici tranne `businessName` e `id` possono essere `null`; `user` è `null` solo se l'utente collegato non esiste più.

**Regole di validazione dei dati aziendali** (applicate sul risultato finale, dopo il merge). Codici e partita IVA sono salvati in maiuscolo.
- `businessName` 1–200 caratteri; `vatNumber`, `fiscalCode` solo lettere e cifre (max 30); `sdiCode` max 7; `email`, `pec` sintassi ordinaria; `phone` come nel profilo.
- Paese italiano (`address.countryCode` `IT`, o indirizzo assente): `vatNumber` 11 cifre; `fiscalCode` 16 caratteri alfanumerici o 11 cifre; `address.province` obbligatoria, 2 lettere. Altri paesi: `vatNumber` e `fiscalCode` 2–30 lettere e cifre. `sdiCode` sempre 7 caratteri alfanumerici. Violazioni: `pattern` (o `required` per la provincia).
- `address` (`street` 1–200, `postcode` 1–16, `city` 1–100, `province` fino a 8, `countryCode` 2 lettere, default `IT`): una volta presente richiede `street`, `postcode` e `city` (`required` su `address.street`, … se mancanti). `province` può essere `null` fuori dall'Italia.
- La partita IVA è **univoca** tra i dealer: se già in uso `409 CONFLICT` con `details: [{ "field": "vatNumber", "issue": "taken" }]` (in creazione `company.vatNumber`).

### GET /v1/dealers
- **Autenticazione e permesso:** Bearer backoffice, `dealers:read`; solo PSA
- **Query:** `limit`, `cursor`, `sort`, `q` come nelle "Liste". `sort`: `businessName` (default, anche `-businessName`). `q` cerca nella ragione sociale e nella partita IVA.
- **Risposta:** `200` `{ "data": [ <dealer> ], "page": { "limit": 50, "next": null } }`
- **Errori:** comuni; `422` su parametri o cursore non validi

### GET /v1/dealers/{dealerId}
- **Autenticazione e permesso:** Bearer backoffice, `dealers:read`; solo PSA
- **Parametri di percorso:** `dealerId` (24 caratteri esadecimali)
- **Risposta:** `200` con il dealer
- **Errori:** comuni; `404 NOT_FOUND`; `422` se `dealerId` non è un id valido

### POST /v1/dealers
- **Autenticazione e permesso:** Bearer backoffice, `dealers:create` e `users:create`; solo PSA
- **Body** (`application/json`, massimo 16 KB, nessun'altra proprietà). L'anagrafica e l'utente `D` sono creati in un'unica transazione; l'utente ha lo stesso id del dealer, nessun gruppo né perimetro, e una **password provvisoria** da cambiare al primo accesso.
  | Campo | Tipo | Obbligatorio | Vincoli |
  |---|---|---|---|
  | `company.businessName` | stringa | sì | 1–200 |
  | `company.vatNumber`, `fiscalCode`, `sdiCode`, `pec`, `email`, `phone` | stringa o `null` | no | vedi le regole di validazione |
  | `company.address` | oggetto o `null` | no | `street`, `postcode`, `city`, `province`, `countryCode` |
  | `user.username` | stringa | sì | ASCII 3–64, come per gli utenti |
  | `user.password` | stringa | sì | provvisoria, policy 12–128 caratteri, diversa dallo username |
  | `user.firstName`, `lastName`, `email`, `phone` | stringa o `null` | no | come per gli utenti |
  | `user.language` | stringa | no | `it` |
  ```json
  {
    "company": { "businessName": "Dealer Nord Srl", "vatNumber": "01234567890", "address": { "street": "Via Roma 1", "postcode": "20100", "city": "Milano", "province": "MI" } },
    "user": { "username": "dealer.nord", "password": "<password provvisoria>" }
  }
  ```
- **Header particolari:** risposta con `Location: /v1/dealers/{dealerId}`; `RateLimit-*` (stesso limite per utente delle creazioni e dei reset password, 20 al minuto di default)
- **Risposta:** `201` con il dealer creato (esempio sopra)
- **Errori:** comuni; `409 CONFLICT` con `username`/`taken` o `company.vatNumber`/`taken`; `422` per campo (`company.vatNumber` `pattern`, `company.address.province` `required`, `user.password` con le issue di policy, …); `429 RATE_LIMITED` con `Retry-After`

### PATCH /v1/dealers/{dealerId}
- **Autenticazione e permesso:** Bearer backoffice, `dealers:update`; solo PSA
- **Body** (JSON Merge Patch, massimo 16 KB, almeno un campo): i soli campi anagrafici `businessName`, `vatNumber`, `fiscalCode`, `address`, `pec`, `sdiCode`, `email`, `phone`; un campo assente resta invariato, `null` lo azzera. `address` si fonde **parzialmente** con quello salvato (le parti omesse restano); `address: null` lo rimuove. Le regole del paese sono verificate sul risultato. L'utente `D` si modifica con `PATCH /v1/users/{userId}`.
  ```json
  { "pec": "nuova@pec.example.com", "address": { "city": "Torino", "province": "TO" } }
  ```
- **Risposta:** `200` con il dealer aggiornato (invariato se nessun valore cambia)
- **Errori:** comuni; `404 NOT_FOUND`; `409 CONFLICT` (`vatNumber`/`taken`); `422` (anche `(body)`/`required` per body vuoto)

## Superficie pubblica — `/public/v1`

Realizzata nel passo 9A (`doc/Security-Model.md` §6–7; la versione per gli integratori esterni è `doc/Public-API.md`). Le chiavi si gestiscono da `/v1` (sezione "Chiavi delle API pubbliche"). Regole comuni:
- **Autenticazione:** solo l'header `X-Api-Key: fc_pk_…` (mai query, cookie o `Authorization`). **Ogni** rifiuto è lo stesso `401 UNAUTHENTICATED` (`{ "error": { "code": "UNAUTHENTICATED", "message": "Authentication required" } }`): chiave assente, malformata, sconosciuta, revocata, scaduta, o gruppo con le API spente, sospeso, nel cestino o eliminato. Un token del backoffice o una chiave di negozio non autenticano qui; la chiave pubblica non autentica su `/v1`. Le autenticazioni fallite contano in un limite per IP **proprio della superficie pubblica** (300 al minuto di default, `429` oltre), separato da quello di `/v1`.
- **Nessun header CORS**, nemmeno nelle risposte al preflight (`OPTIONS` risponde `405` o `404` come ogni altro metodo non previsto): solo da server a server.
- **Permessi:** ogni route dichiara un permesso del catalogo pubblico (`places:read`, `companies:read`, `catalog:read`, `catalog:write`) o nessuno (`GET /me`); senza il permesso `403 FORBIDDEN`. Ogni lettura è filtrata dal gruppo della chiave e dalle sue restrizioni: ciò che è fuori, o non esiste, o è nel cestino, è lo stesso `404 NOT_FOUND`.
- **Limiti:** quattro conteggi atomici, nell'ordine: minuto della chiave (default 60), minuto del gruppo (tetto di tutte le chiavi insieme, default 120), giorno UTC della chiave (default 10 000), giorno UTC del gruppo (default 20 000). `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` descrivono il più stretto dei due limiti al minuto; oltre uno dei due `429 RATE_LIMITED` con `Retry-After` e gli header del limite superato. Oltre una quota giornaliera `429 QUOTA_EXCEEDED` con `Retry-After` fino a mezzanotte UTC e **senza** header `RateLimit-*` (descrivono solo il minuto). Una richiesta rifiutata da un limite al minuto non consuma alcuna quota giornaliera; una chiave che ha già esaurito la propria quota giornaliera (verificata con una lettura prima dei contatori del gruppo) è rifiutata subito e incrementa solo il proprio contatore, quindi non toglie capacità al minuto del gruppo alle altre chiavi; una rifiutata dal tetto giornaliero del gruppo ha già usato un'unità della quota della propria chiave (i contatori sono incrementi separati, mai annullati). Il primo eccesso di una finestra è registrato (`rateLimit.exceeded`, attore `apiKey` con l'id della chiave, `bucket` `public:key`, `public:group`, `public:quota` o `public:group-quota`).
- **Liste:** `limit` 1–100 (default 50) e `cursor`; ordine per nome. Nessun filtro, ordinamento o ricerca (`422` per ogni altro parametro, anche sulle route di dettaglio e su `/me`).
- **Errori comuni:** `401`, `403`, `404`, `405`, `422`, `429`; `500` senza dettagli.

### GET /public/v1/me
- **Superficie:** pubblica; **permesso:** nessuno (ogni chiave valida)
- **Risposta:** `200`
  ```json
  { "data": {
    "key": { "id": "6650c0a1b2c3d4e5f6a7b8c9", "name": "Webshop", "prefix": "fc_pk_AbCdEf", "permissions": ["places:read", "companies:read"], "restrictions": { "companyIds": null, "placeIds": null }, "expiresAt": null },
    "group": { "id": "665f1c2e9b1d4a0012ab34a1", "name": "Gruppo Esempio" },
    "limits": { "rateLimitPerMinute": 60, "dailyQuota": 10000, "group": { "rateLimitPerMinute": 120, "dailyQuota": 20000 } },
    "usageToday": { "calls": 42 }
  } }
  ```
  `limits.group` è il tetto di tutte le chiavi del gruppo insieme. `usageToday.calls` sono le richieste contate oggi (giorno UTC) contro la quota, **questa compresa** (lette dal contatore della quota: esatte anche con più istanze del server).

### GET /public/v1/places
- **Permesso:** `places:read`; **query:** `limit`, `cursor`
- **Risposta:** `200` con i punti vendita del gruppo non nel cestino e dentro le restrizioni della chiave, per nome
  ```json
  { "data": [{
    "id": "665f1c2e9b1d4a0012ab3421", "name": "Bar Roma", "companyId": "665f1c2e9b1d4a0012ab3411",
    "address": { "street": "Via Roma 1", "postcode": "20100", "city": "Milano", "province": "MI", "country": "IT" },
    "phone": "+39 02 1234567", "email": "bar@example.com", "status": "active", "timezone": "Europe/Rome"
  }], "page": { "limit": 50, "next": null } }
  ```
  Proiezione **esplicita** (`public.mapper.ts`): mai credenziali, impostazioni del rivenditore, dati di rete, chiavi o dispositivi. Un campo mancante è `null`. Camere e tavoli non sono esposti in questo passo.
- **Errori:** comuni; `403`; `422`; `429`

### GET /public/v1/places/{placeId}
- **Permesso:** `places:read`
- **Risposta:** `200` con un punto vendita (stessa forma)
- **Errori:** comuni; `403`; `404` (non esiste, è nel cestino, è di un altro gruppo o fuori dalle restrizioni: la stessa risposta); `422` (`placeId`)

### GET /public/v1/companies e GET /public/v1/companies/{companyId}
- **Permesso:** `companies:read`; stesse regole dei punti vendita (query, paginazione, `404`)
- **Risposta:** `200` con le aziende del gruppo non nel cestino. Una chiave ristretta ai punti vendita vede le aziende di quei punti vendita; una ristretta alle aziende solo quelle (con entrambe, l'intersezione)
  ```json
  { "data": [{
    "id": "665f1c2e9b1d4a0012ab3411", "name": "Acme S.r.l.", "vatNumber": "01114601006", "fiscalCode": "01114601006",
    "address": { "street": "Via Roma 1", "postcode": "20100", "city": "Milano", "province": "MI", "country": "IT" },
    "email": "info@acme.example", "phone": "+39 02 1234567"
  }], "page": { "limit": 50, "next": null } }
  ```
  Mai banche, IBAN, impostazioni o dati di fatturazione.

### GET /public/v1/price-lists e GET /public/v1/taxes
- **Permesso:** `catalog:read`; nessun parametro
- **Risposta:** `200` con **tutte** le voci del gruppo (al più 50 listini e 30 aliquote), senza `page`; non sono ristrette dalle restrizioni della chiave (sono del gruppo)
  ```json
  { "data": [{ "id": "Zk3vQ0aT9bX2mN7pLw4HcA", "name": "Listino base", "enabled": true, "isDefault": true }] }
  ```
  ```json
  { "data": [{ "id": "n1P8xQwR2cV5tYb7KdLm0g", "rate": 22, "department": 1, "description": null, "vatNature": null }] }
  ```
  `rate` è una percentuale; `vatNature` è un codice di natura IVA (`N1`…`N6.9`) o `null`.


### Catalogo pubblico (`/public/v1`, decisioni del 2026-11-24)

Letture con `catalog:read`, scritture con `catalog:write` (permessi indipendenti: una chiave di sola scrittura riceve la voce scritta nella risposta ma non legge il catalogo). Tutte le route sono `auth: { kind: 'apiKey', permission, group: true }`: il builder emette l'accesso al **solo gruppo della chiave** (`requireApiKeyGroupAccess`). La versione per gli integratori, con gli esempi completi, è `doc/Public-API.md` ("Catalogo").

| Metodo e percorso | Permesso | Risposta |
|---|---|---|
| `GET /public/v1/products` | `catalog:read` | `200` pagina di prodotti **interi**; query `limit` 1–50 (25), `cursor`, `family` (`products`, `services`, `tgm`, `modifiers`), `updatedSince`, `ecommerce=true` |
| `GET /public/v1/products/{productId}` | `catalog:read` | `200` + `ETag`; `warnings` solo `{ field, issue }` |
| `GET /public/v1/products/{productId}/stock` | `catalog:read` | `200` giacenze del prodotto; `403 FEATURE_DISABLED` senza la funzione `warehouse` |
| `GET /public/v1/stock` | `catalog:read` | `200` pagina di giacenze dei prodotti che muovono il magazzino (query `limit` 1–50 (25), `cursor`) |
| `POST /public/v1/products` | `catalog:write` | `201`, `Location`, `ETag`; `Idempotency-Key` |
| `PATCH /public/v1/products/{productId}` | `catalog:write` | `200` + `ETag`; `If-Match` |
| `POST …/products/{productId}/trash` · `…/restore` | `catalog:write` | `200` + `ETag`; `If-Match` |
| `GET /public/v1/categories` | `catalog:read` | `200` pagina; query `limit` 1–100 (50), `cursor`, `updatedSince` |
| `GET …/categories/tree` | `catalog:read` | `200` albero compatto, `ETag` debole e `304` |
| `GET …/categories/{categoryId}` | `catalog:read` | `200` + `ETag` |
| `POST …/categories` · `PATCH …/categories/{categoryId}` · `DELETE …/categories/{categoryId}` | `catalog:write` | `201`/`200`/`204`; `Idempotency-Key` in creazione, `If-Match` in modifica; `409` se la categoria è usata; niente cicli (`422`) |
| `GET …/brands`, `GET …/brands/{brandId}`; `GET …/attribute-groups`, `GET …/attribute-groups/{attributeGroupId}`; `GET …/departments`, `GET …/departments/{departmentId}` | `catalog:read` | `200` pagina (query `limit` 1–100 (50), `cursor`, `updatedSince`) o voce con `ETag`; reparti: `403 FEATURE_DISABLED` senza `cash`. **Nessuna scrittura** (`405`) |

- **Chiamante dei servizi.** I servizi del catalogo non ricevono un utente ma un `ApiKeyCaller` (`product-catalog/caller.ts`), costruito dalla sola chiave verificata e dalle sue restrizioni (`public-catalog.caller.ts`): una chiave **senza restrizioni** ha lo scope `group` (vale come SA); una **con restrizioni** ha lo scope `places` con i punti vendita non nel cestino che risultano (quelli nominati; i punti vendita delle aziende nominate; l'intersezione se ci sono entrambe; al più 500) e vale come CA/PA di quei punti vendita, regola del negozio unico compresa (`withSoleLocation`). Se non risulta alcun punto vendita: `404` su ogni route del catalogo. Le letture rispettano lo stesso perimetro; le voci fuori perimetro sono `404`.
- **Rappresentazioni** (`public-catalog.mapper.ts`, un tipo per ciascuna: `PublicProduct`, `PublicCategory`, `PublicCategoryNode`, `PublicBrand`, `PublicAttributeGroup`, `PublicDepartment`, `PublicStock`), costruite campo per campo. Il prodotto non ha mai `costs`, `suppliers`, `simpleCost`, `lastAveragePrice`, `stock` (è una risorsa a parte), `components`, `printStations`, `counterPrintStations`, `productionCenterId`, `productionValue`, `colors`, `dining`, `integrations`, `toCheck`, `favoriteHandheld`, `image`, `gallery`, `internalFileName`, `externalUrl`, `placeEditable`, `trashed`; ha `status` (`active`, `disabled`, `trashed`) al posto di `enabled` e `trashed`. Gli id di altri prodotti (`modifierIds`, `requiredModifierIds`, `excludedModifierIds`, `menu[].productIds`, `modifierChoices[].productIds`; nelle categorie `modifierIds`) ci sono solo se il prodotto è raggiungibile dalla chiave (una lettura per pagina: `ProductsService.reachableIds`). I campi delle funzioni del gruppo (`plu`, `duration`, `availability`, `featured`, `scaleType`, `loadUnit`…) ci sono solo se il gruppo ha la funzione.
- **Prezzi in centesimi interi, IVA inclusa.** In lettura ogni regola ha `grossCents` (l'importo con IVA letto dal prezzo lordo, arrotondato al centesimo), `taxId`, `taxRatePercent` (sola lettura), `priceListId`, `currency`, `discountPercent` e le condizioni (`validFrom`, `validTo`, `dailyFrom`, `dailyTo`, `weekDays`, `fromQuantity`, `maxSaleQuantity`). In scrittura si manda `grossCents` (intero, 0–100 000 000 000: il massimo del backoffice, un miliardo di unità di valuta) e `taxId`: il server scrive `taxed = grossCents / 100` e calcola l'imponibile con `netOf` (8 decimali) alla stessa aliquota del gruppo. Una regola riletta e rimandata identica (senza `taxRatePercent`) non cambia nulla: nessuna scrittura, stessa versione. `gross`, `net` e `taxRatePercent` in scrittura sono `422` (`unknown`).
- **Ciò che la chiave non vede resta.** Nel passaggio dal corpo pubblico a quello dei servizi (`public-catalog.preserve.ts`) un campo assente significa **conserva**: la `loadQuantity` dei barcode (per `value`), `productionCenterId` e `favoriteHandheld` dei punti vendita del prodotto e `productionCenterId` di quelli della categoria (per `placeId`), il `course` del menu (per categoria; nessun abbinamento sicuro per posizione), gli id memorizzati dei prodotti che la chiave non raggiunge (anche nel cestino) nelle liste `requiredModifierIds`, `modifierIds`, `excludedModifierIds`, `menu[].productIds`, `modifierChoices[].productIds` e `modifierIds` della categoria (rimessi alla posizione che avevano), e l'importo memorizzato di una regola di prezzo con lo stesso `id` e lo stesso `grossCents` (una frazione di centesimo del legacy non si arrotonda). Una lettura rimandata identica non scrive nulla. La modifica legge il prodotto una volta in più (`get`) per farlo. Un `favoriteHandheld` memorizzato in un gruppo senza la funzione `rooms` non si può rimandare (come nel backoffice) e viene azzerato da un `places` riscritto.
- **Corpi di scrittura dedicati** (`public-catalog.schemas.ts`): derivati dalle stesse forme dei servizi ma senza `simpleCost`, `suppliers`, `image`, `gallery`, `internalFileName`, `externalUrl`, `printStations`, `counterPrintStations`, `stock`, `components`, `productionValue`, `colors`, `dining`, `integrations`, `toCheck`, `favoriteHandheld`, `enabled` (si usa `status`: `active` o `disabled`; `trashed` no, ci sono le route) e senza `productionCenterId`, `favoriteHandheld` e `loadQuantity` dentro `places` e `barcodes`; le categorie senza `image`, `icon`, `internalFileName`, `externalUrl`, `printStations`, `counterPrintStations`, `integrations`, `dining`, `productionValue`, `secondaryFiscalPrinter`, `backgroundColor`, `textColor`, `enabled`. Ogni chiave non elencata nei corpi è `422` (`unknown`); i campi delle funzioni del gruppo che il gruppo non ha sono `422` (`notAllowed`) come nel backoffice. Nessuna route per: eliminazione definitiva di un prodotto, svuotamento del cestino, duplicazione, scritture su marche, gruppi di attributi, reparti e giacenze.
- **Elenchi e aggiornamento incrementale.** Dal meno recente al più recente per `updatedAt`, cursore opaco. **Senza `updatedSince`**: prodotti attivi e non cestinati (`status: active`; con `ecommerce=true` solo quelli disponibili per l'e-commerce); categorie, marche e reparti attivi; gruppi di attributi tutti. **Con `updatedSince`** (ISO 8601, inclusivo): ogni voce modificata da quell'istante, **anche disattivata (`status: disabled`) e, per i prodotti, nel cestino (`status: trashed`)**, perché l'integratore la tolga. Una voce eliminata per sempre (categorie, marche, gruppi di attributi) o uscita dal perimetro non compare: serve una rilettura completa periodica.
- **Giacenze** (`PublicStock`): `{ productId, code, updatedAt, stock: [{ placeId, storageId, quantity, min, max, location }] }`, una riga per deposito, solo per i punti vendita del perimetro della chiave; in sola lettura (nessuna route di scrittura, `stock` rifiutato nei corpi).
- **Registro delle attività.** Gli eventi `product.created|updated|trashed|restored` e `productCategory.created|updated|deleted` dei servizi, con **attore `apiKey`** (id della chiave) e metadato **`keyHint`** (i 6 caratteri dopo `fc_pk_`, mai il segreto né il marcatore: il registro oscura ogni testo che inizia come una chiave). Anche `rateLimit.exceeded` e `request.failed` con attore `apiKey` portano il `groupId` della chiave, quando c'è una chiave autenticata (anche prima dell'accesso al gruppo).
- **Idempotenza.** `Idempotency-Key` come nel backoffice, **legata alla chiave** (principal `apikey:<id>`).
- **Limiti.** Le 7 route di scrittura dichiarano la regola **`public-catalog-write:key`** (`RATE_LIMIT_PUBLIC_CATALOG_WRITE_PER_KEY`, default 60 al minuto per chiave, 1–1.000.000): dopo autenticazione e permesso, **prima di leggere il corpo**; `429 RATE_LIMITED` con `Retry-After`, evento `rateLimit.exceeded` con attore `apiKey` e `bucket`. Ogni richiesta, scritture comprese, conta nel limite al minuto della chiave e del gruppo, nella quota giornaliera e nell'uso per giorno e route (`apiUsage`). Corpi: prodotto fino a 256 KB, categoria fino a 128 KB (`413`); non JSON `415`. Nessun header CORS.
- **Errori:** `401` (ogni credenziale sbagliata, gruppo con le API spente); `403 FORBIDDEN` (manca `catalog:read` o `catalog:write`; campo di una voce condivisa con altri punti vendita, con `details`); `403 FEATURE_DISABLED` (reparti senza `cash`, giacenze senza `warehouse`); `404` (fuori perimetro, di un altro gruppo, inesistente, o chiave senza punti vendita); `405`; `409` (voce nel cestino o cambiata, categoria usata, `Idempotency-Key` con corpo diverso); `412`; `413`; `415`; `422`; `429`.


## Cestino (passo 9-ter/2)

Azioni sulla pagina "Cestino". **Non hanno `If-Match`**: le selezioni vengono da elenchi senza versioni; ogni elemento passa dalla **stessa logica** della route singola (perimetro, anti-escalation, controlli `409`, effetti e eventi) e la scrittura controlla atomicamente lo stato, quindi un elemento ripristinato nel frattempo non è mai eliminato. Un elemento che fallisce non ferma gli altri. Gli elenchi (`GET …/companies|places|users` con `trashed=true`, `GET /v1/groups?trashed=true`) hanno in ogni elemento `trashedAt` (ISO 8601, `null` se il legacy ha cestinato l'elemento o la data manca; solo informativa, anche in aziende, punti vendita, utenti e gruppi singoli).

**Risposta comune (`200`):** `{ "data": { "results": [ { "id": "…", "outcome": "restored" | "deleted" | "skipped", "issue"?: "notFound" | "notTrashed" | "referenced" | "taken" | "forbidden" } ] } }`. I risultati seguono l'ordine della richiesta (id duplicati tolti); `issue` c'è solo se `skipped`. Un id fuori perimetro o di un altro gruppo è `notFound` (mai rivelare l'esistenza). `notTrashed`: non è nel cestino, è già stato ripristinato o è cambiato nel frattempo (anche un `409` o `412` della route singola per lo stesso motivo). Qualunque altro conflitto (per esempio un documento con un blocco malformato) **non** è un esito dell'elemento: la chiamata risponde con l'errore (`409`/`500`) e l'evento riepilogativo ha esito `failure` con i conteggi fino a quel punto. `referenced`: azienda con punti vendita, punto vendita con utenti, prodotto usato da distinte, menu, modificatori, servizi di un utente, preferiti o promozioni (vedi "Catalogo: prodotti"), dealer con gruppi; `taken`: la P.IVA di un'azienda da ripristinare è ora di un'altra azienda; `forbidden`: utente che il chiamante vede ma non gestisce.

### POST /v1/groups/{groupId}/trash/{kind}/restore
- **`kind`:** `companies`, `places`, `users` o `products` (altro: `422` su `kind`). Per `products`: perimetro di CA e PA come per la route singola (un prodotto non interamente loro è `forbidden`, uno che non raggiungono `notFound`).
- **Autenticazione e permesso:** Bearer backoffice, `companies:trash`, `places:trash`, `users:trash` o (per `products`) `products:update` secondo `kind` (`403` altrimenti, prima della validazione del corpo); gruppo verificato (`404` se fuori perimetro)
- **Body:** `{ "ids": [ … ] }`: da 1 a 100 ObjectId esadecimali, nessuna altra chiave
- **Risposta:** `200`, risposta comune con `outcome: "restored"`. Evento per chiamata `trash.bulkRestored`.
- **Errori:** comuni; `403`; `404`; `422` (corpo o `kind`); `429` (una chiamata, una richiesta)

### POST /v1/groups/{groupId}/trash/{kind}/delete
- Come sopra, permesso `companies:delete`, `places:delete`, `users:delete` o (per `products`) `products:update`; elimina definitivamente dal cestino, con gli effetti dell'eliminazione singola. `outcome: "deleted"`. Evento per chiamata `trash.bulkDeleted`.

### POST /v1/groups/{groupId}/trash/{kind}/empty
- **Autenticazione e permesso:** Bearer backoffice, **solo PSA**: `trash:empty` (il PSA ha sempre tutti i permessi di eliminazione)
- **Body:** facoltativo: assente, `{}` oppure `{ "after": "<id esadecimale di 24 caratteri>" }`; altre chiavi: `422` `unknown`, `after` malformato: `422` `format`
- **Risposta:** `200` con `{ data: { results, remaining, next } }`: elimina al massimo **200** elementi in cestino del genere nel gruppo con `_id` maggiore di `after` (se dato), in ordine di `_id`. `remaining` è quanti ne restano in cestino dopo la chiamata (tutti, a prescindere da `after`); `next` è l'`_id` dell'ultimo elemento elaborato quando la chiamata ne ha elaborati 200 (può essercene altri oltre), altrimenti `null`. Il cliente ripete la chiamata con `after = next` finché `next !== null`: gli elementi che non si possono eliminare sono superati, non riesaminati. Evento per chiamata `trash.emptied`.
- **Errori:** comuni; `403`; `404`; `422`; `429`

### POST /v1/trash/groups/restore
- **Autenticazione e permesso:** Bearer backoffice, `groups:trash`; solo **PSA**
- **Body:** `{ "ids": [ … ] }` (1–100). Non esistono eliminazione né svuotamento dei gruppi.
- **Risposta:** `200`, risposta comune con `outcome: "restored"`; un gruppo inesistente è `notFound`, uno non in cestino `notTrashed`. Evento per chiamata `trash.bulkRestored` (senza gruppo) e per gruppo `group.restored`.
- **Errori:** comuni; `403`; `422`; `429`

## Listino, personalizzazioni e attivazioni (`/v1`, passo 9-ter/4)

Strumento con cui Flood sa quali licenze sono state attivate ogni mese e quanto deve pagare ogni dealer. Importi sempre in **centesimi di euro, IVA esclusa**. Il **mese della fattura** `I` (anno `Y`) ha due fatture per dealer: (1) le **attivazioni** dei punti vendita attivati nel mese prima di `I` (mese di `places.insertDate` in `Europe/Rome`; il mese di attivazione non si paga: ogni punto vendita paga il canone mensile per `12 − mese di attivazione` mesi, maggio 7, dicembre 0); (2) la **rata dei rinnovi**: un dodicesimo del canone annuo del parco al 31 dicembre `Y−1`, cioè la somma dei canoni mensili dei punti vendita attivati fino ad allora. Un mese **chiuso** si serve dalle chiusure e non cambia più; uno aperto si calcola al momento (la base dei rinnovi è viva finché il PSA non la congela). Tutte le risposte hanno l'envelope `{ data }`; nessuna route è su `/public/v1` né aperta alla chiave di negozio. Errori comuni: `401`, `403`, `429`, `503` (lettura oltre il limite di tempo).

Permessi: `activations:read` (PSA e D; un D vede solo i propri dati: un `dealerId` diverso dal suo, o `none`, dà `403`) e `activations:manage` (solo PSA). Rate limit: scritture `RATE_LIMIT_ACTIVATIONS_ADMIN_PER_USER` (30/min), CSV `RATE_LIMIT_ACTIVATIONS_EXPORT_PER_USER` (5/min), oltre al limite generale.

### GET /v1/settings/price-list e PUT /v1/settings/price-list
- **Permesso:** `activations:manage`.
- **GET:** `200` `{ "data": { "plans": { "basic": 2000, … }, "services": { "extraDesk": 500, "kiosk": 1500, "api": 500, "tobaccos": 1300, "reservationWidget": 1000, "floodPay": 1500, "arubaEInvoicing": 0, "reserveWithGoogle": 0, "bizerba": 0 } } }` con `ETag` forte. Senza listino salvato risponde il default.
- **PUT:** `If-Match` obbligatorio; corpo = la lista intera (`plans` con al più 30 chiavi `^[A-Za-z0-9_-]{1,30}$`, `services` con **tutte e nove** le chiavi, ogni importo intero 0–10 000 000; nient'altro). Risponde `200` come il GET con il nuovo `ETag`. Evento `priceList.updated`.
- **Errori:** `422` con campi `plans.<chiave>`, `services.<chiave>` o `If-Match`; `412` se la lista è cambiata dopo la lettura.

### GET /v1/settings/security-policy e PUT /v1/settings/security-policy
- **Permesso:** `securityPolicy:manage`, **solo PSA** (nel solo tetto del PSA: D, SA, CA, PA, chiave di negozio e API pubbliche non hanno la route o ricevono `403`); anonimo `401`.
- **Scopo:** decide che cosa succede (1) a una richiesta fatta con le credenziali di un utente che non sembra venire da un browser (`nonBrowserRequests`) e (2) alle richieste di un utente oltre i limiti orario e giornaliero di `/v1` (`sustainedLimits`).
- **GET:** `200` con `ETag` forte:
  ```json
  { "data": {
    "nonBrowserRequests": "report",
    "sustainedLimits": "report",
    "sources": { "nonBrowserRequests": "default", "sustainedLimits": "default" },
    "limits": { "perMinute": 300, "perHour": 2000, "perDay": 10000 }
  } }
  ```
  `nonBrowserRequests`: `report` (solo segnalazione, predefinito) o `block`. Con `SECURITY_POLICY_FORCE_REPORT=on` entrambi i campi valgono `report` con fonte `forced`, qualunque cosa sia salvata (via d'uscita d'emergenza: il `PUT` resta possibile ma senza effetto finché è `on`). `sustainedLimits`: `report` o `enforce`; **predefinito** `RATE_LIMIT_API_SUSTAINED_MODE` (`report` se la variabile manca). `sources` dice, per ogni campo, se il valore **effettivo** è stato salvato (`database`), è il predefinito del server (`default`) o è forzato a `report` dall'ambiente (`forced`); un valore salvato prevale sempre sulla variabile. `limits` sono le **soglie in vigore, in sola lettura**: vengono dalle variabili d'ambiente (`RATE_LIMIT_API_PER_USER`, `_HOUR`, `_DAY`) e **non sono modificabili dal backoffice** in questo passo. Il GET legge sempre il database (non la copia in memoria).
- **PUT:** `If-Match` obbligatorio; corpo `{ "nonBrowserRequests"?: "report" | "block", "sustainedLimits"?: "report" | "enforce" }`, **almeno un campo**; un campo non inviato resta com'è (salvato o predefinito); nient'altro è accettato. Risponde `200` come il GET con il nuovo `ETag`. Evento di sicurezza `settings.securityPolicyUpdated` (prima e dopo dei valori in vigore; azione di allerta). Un PUT senza variazioni non scrive né registra.
- **Blocco solo da un browser riconosciuto:** impostare `nonBrowserRequests: "block"` con una richiesta che **essa stessa** non sembra venire da un browser è `409 CONFLICT` con `details: [{ "field": "nonBrowserRequests", "issue": "browserRequired" }]`: chi accende il blocco ha la prova che il proprio backoffice lo supera. Riportare a `report` non ha questo vincolo. **Con `REQUEST_ORIGIN_SIGNAL=off` il blocco non si può accendere** (stesso `409`): un blocco non verificabile non si attiva.
- **Propagazione:** l'istanza del server che serve il PUT aggiorna subito la propria copia; le altre istanze entro **30 secondi** (scadenza della copia in memoria). Se la lettura del database fallisce si usa l'ultimo valore noto e, in mancanza (avvio a freddo con il database giù), il predefinito del server: `report` per `nonBrowserRequests` e `RATE_LIMIT_API_SUSTAINED_MODE` per `sustainedLimits` (mai un blocco delle richieste non da browser per un guasto): l'errore è registrato.
- **Errori:** `403`, `412` (versione cambiata), `409` come sopra, `422` (`If-Match`, campi, nessun campo).
- **Eventi:** `settings.securityPolicyUpdated` (allerta). Un login rifiutato dal blocco è registrato ogni volta (un refresh al più 10 volte all'ora per utente) come `auth.loginFailed` / `auth.refreshFailed` con `reason: browserRequired` (fuori dal tetto di una volta al giorno di `request.nonBrowser`).

#### Il blocco delle richieste non da browser (`nonBrowserRequests: "block"`)
Si applica alla stessa regola del segnale `request.nonBrowser` (vedi sopra): una richiesta classificata come non da browser riceve `403` con `error.code` **`BROWSER_REQUIRED`** (messaggio fisso `A browser is required`, nessun dettaglio), oltre all'evento (metadato `outcome: blocked`, esito `denied`).
- **Route `user` di `/v1`:** rifiuto prima del corpo e del controller.
- **`POST /v1/auth/login`:** **`403 BROWSER_REQUIRED` al login significa «credenziali valide»**. Dopo la verifica **riuscita** delle credenziali e dello stato dell'account, **senza creare la sessione né emettere token** e senza azzerare il contatore dei tentativi falliti (nessun effetto collaterale, nessun `auth.loginSucceeded`). Un login fallito risponde come sempre.
- **`POST /v1/auth/refresh`:** rifiuto **senza ruotare né consumare** il refresh token: il browser che lo possiede continua a usarlo e non scatta il rilevamento del riuso.
- **Mai bloccati** (solo segnalati): gli utenti **PSA** (è il PSA che può spegnere il blocco; i **D** sono bloccati come gli altri), le route esentate dai limiti orario e giornaliero (`POST /v1/auth/logout`, `logout-all`, `PUT /v1/me/password`, `PUT /v1/me/pin`, `DELETE /v1/me/sessions/{sessionId}`). **Mai valutati**: chiave di negozio, API pubbliche, scambio del codice di attivazione, le altre route anonime.
- **Emergenza:** `SECURITY_POLICY_FORCE_REPORT=on` forza **entrambe** le impostazioni a sola segnalazione qualunque sia il database; `REQUEST_ORIGIN_SIGNAL=off` disattiva segnale e blocco. Vie d'uscita se il blocco chiudesse fuori gli utenti: riavviare con una delle due.
- È un controllo **falsificabile**: uno script può mandare le stesse intestazioni di un browser; ferma l'uso ingenuo, non è una barriera.

### GET /v1/dealers/{dealerId}/price-overrides e PUT …
- **Permesso:** `activations:manage`. Prezzi che il dealer paga al posto di quelli del listino, chiave per chiave.
- **GET:** `200` `{ "data": { "overrides": { "plans"?: {…}, "services"?: {…} }, "effective": { "plans": {…}, "services": {…} } } }` con `ETag`; `404` se il dealer non esiste.
- **PUT:** `If-Match` obbligatorio; corpo `{ "plans"?: {…}, "services"?: {…} }` (sostituzione completa; `{}` toglie tutto; `services` solo le nove chiavi note). Risponde come il GET con il nuovo `ETag`. Evento `dealer.priceOverridesUpdated`. Errori: `404`, `412`, `422`.

### GET /v1/activations?month=AAAA-MM[&dealerId=<id>|none]
- **Permesso:** `activations:read`. `month` è il mese della fattura (anni 2020–2100); `dealerId` restringe a un dealer (`none` = gruppi senza rivenditore, solo PSA; `404` se il dealer non esiste, `403` per un D che ne chiede un altro).
- **Risposta:** `200`
```json
{
  "data": [
    {
      "dealer": { "id": "665f1c2e9b1d4a0012ab34d1", "name": "Dealer Nord Srl" },
      "status": "open",
      "activations": { "activityMonth": "2026-05", "places": 3, "monthlyCents": 8000, "amountCents": 56000, "projection12Cents": 96000 },
      "renewals": { "year": 2026, "places": 2, "annualCents": 60000, "instalmentCents": 5000, "frozen": false },
      "totalCents": 61000,
      "anomalies": 3
    }
  ],
  "month": "2026-06", "activityMonth": "2026-05", "status": "open",
  "totals": { "activations": { "places": 3, "monthlyCents": 8000, "amountCents": 56000, "projection12Cents": 96000 }, "renewals": { "places": 2, "annualCents": 60000, "instalmentCents": 5000 }, "totalCents": 61000, "anomalies": 3 },
  "renewalBase": { "year": 2026, "frozen": false }
}
```
Le righe (`data`) sono ordinate per nome del dealer; `dealer.id` è `null` per i gruppi senza rivenditore ("Senza rivenditore", solo PSA). Il PSA vede i dealer che hanno qualcosa (o quello richiesto); un D sempre la propria riga, anche a zeri. `projection12Cents` = canone mensile × 12 delle nuove attivazioni. `anomalies`: punti vendita esclusi perché l'azienda manca, è di un altro gruppo o è nel cestino. Contano (con segnalazione) punti vendita scaduti, gruppi sospesi e aziende disattivate; non contano gruppi demo o nel cestino, aziende e punti vendita nel cestino.
- **Errori:** `422` (formato del mese, parametri sconosciuti), `403`, `404`.

### GET /v1/activations/statements/{dealerId|none}?month=AAAA-MM&section=activations|renewals[&limit&cursor]
- **Permesso:** `activations:read` (un D solo il proprio id). `limit` 1–100 (default 50), `cursor` opaco.
- **Risposta:** `200` `{ "data": [ <riga> ], "page": { "limit": 50, "next": null }, "dealer": { "id", "name" }, "month", "activityMonth", "section", "status", "renewalBase": { "year", "frozen" }, "totals": {…}, "prices": { "plans", "services" } }`. Le righe sono ordinate per nome del gruppo, dell'azienda, del punto vendita e id. `totals` è della **sezione intera** (non della pagina): per le attivazioni `{ places, monthlyCents, amountCents, projection12Cents, anomalies }`; per i rinnovi `{ places, annualCents, instalmentCents, anomalies, amountCents, projection12Cents }` (`amountCents` = rata, `projection12Cents` = canone annuo). `prices` è il listino effettivo applicato (quello salvato nella chiusura per un mese chiuso).
- **Riga:** `{ groupId, groupName, companyId, companyName, placeId, placeName, activatedAt, plan, items: [{ key, quantity, unitCents, amountCents, providers? }], monthlyCents, months, amountCents, projection12Cents, flags, devices? }`. `items`: `plan:<piano>` (sempre; senza prezzo `unitCents: null`, importo 0, flag `unpricedPlan`, mai `NaN`), `extraDesk` (casse oltre la prima), `kiosk`, `arubaEInvoicing`, `floodPay`, `reservationWidget`, `reserveWithGoogle`, `tobaccos`, `bizerba`, `api`; **ogni servizio attivo è una voce, anche a prezzo 0**; un servizio non attivo non ha voce. La voce `api` ha in più `providers`: le integrazioni che la determinano (le chiavi dei fornitori attivi, poi `statmanager` se il gruppo lo ha attivo). Ogni riga ha `devices: { desks, kiosks, handhelds }` (casse totali, la prima inclusa nel piano; kiosk; palmari `handheld`, `palmare`, `room-handheld`, gratuiti; assente nelle righe di chiusure scritte prima). `flags` tra `unpricedPlan`, `activationDateFromId` (senza `insertDate` valida si usa la data dell'`_id`), `expired`, `groupSuspended`, `companyDisabled`. Nei rinnovi `months` è 1 e `amountCents` è la rata (= `monthlyCents`).
- **Errori:** `403`, `404`, `409` (`tooManyLines`: più di 5000 righe per il rivenditore), `422` (parametri, `cursor`/`format`).

### GET /v1/activations/statements/{dealerId|none}.csv?month=AAAA-MM&section=…
Stesse righe in CSV (BOM UTF-8, separatore `;`, CRLF, celle che iniziano come una formula rese testo con un apostrofo). Colonne: Rivenditore, Gruppo, Azienda, Punto vendita, Attivato il, Piano, Dettaglio voci, Canone mensile, Mesi, Importo, Proiezione 12 mesi, Segnalazioni (importi in euro con la virgola). File `attivazioni_<mese>_<sezione>_<dealerId|none>.csv`. Un solo export alla volta per utente (`429`), tempo massimo come gli altri CSV. Errori come il prospetto.

### GET /v1/activations/lines?[from=AAAA-MM&]to=AAAA-MM[&dealerId=<id>|none][&limit&cursor]
Dettaglio di **tutte le attivazioni** di un periodo, con le voci che compongono il prezzo. Sempre **calcolato al momento** coi prezzi effettivi correnti di ogni dealer (vista di analisi, non fattura: le chiusure non c'entrano); stesso motore, stesse regole su chi conta e stesse segnalazioni dei prospetti.
- **Permesso:** `activations:read`. `to` (obbligatorio) e `from` (**facoltativo**) sono **mesi di attivazione** (mese di `insertDate` a Roma), inclusi. Senza `from` si vedono **tutte le attivazioni dall'inizio** fino al mese `to`; un `from` vuoto o malformato è `422` (campo `from`). Se c'è, `from ≤ to`, altrimenti `422` (campo `to`, `minimum`). **Nessun massimo di mesi**: il limite è quello delle righe (5000). Un D è forzato a se stesso (`dealerId` di un altro o `none` → `403`); il PSA vede tutti o il dealer chiesto (`none` incluso, `404` se non esiste). `limit` 1–100 (default 50), `cursor` opaco.
- **Risposta:** `200` `{ "data": [ <riga> ], "page": { "limit", "next" }, "totals": { "places", "monthlyCents", "amountCents", "projection12Cents", "anomalies" }, "from", "to", "referenceYear" }`, con `referenceYear` = anno corrente (Roma) con cui sono contati i mesi, e `from` = `null` se la richiesta non lo aveva. `totals` è dell'**insieme filtrato intero**, non della pagina. La riga è quella del prospetto più `dealer: { id | null, name }`; `months` (solo in questa vista) vale `12 − mese di attivazione` per un punto vendita attivato **nell'anno corrente** (`referenceYear`; il mese di attivazione non si paga, dicembre dà 0) e **`12`** per uno attivato in un anno precedente (è ormai un rinnovo, anno intero); `amountCents` = canone × `months` e `totals.amountCents` è la somma sull'insieme filtrato intero; `projection12Cents` = canone × 12. Un `to` nel futuro non cambia nulla: un'attivazione di un anno successivo a `referenceYear` (o del suo stesso anno) conta i mesi rimasti del proprio anno. Prospetti, chiusure, basi dei rinnovi e riepilogo non cambiano. Nel CSV la colonna Mesi porta lo stesso valore.
- **Ordine:** data di attivazione decrescente, poi nome del dealer, del gruppo, del punto vendita, id. Al più 5000 righe: oltre, `409` con `details: [{ "field": "lines", "issue": "tooManyLines" }]` (restringere il periodo). Un `cursor` emesso per una richiesta con `from` non vale per una senza `from`, e viceversa: `422` su `cursor`/`format`.
- **Errori:** `401`, `403`, `404`, `422` (mesi, intervallo, parametri sconosciuti, `cursor`/`format`), `409`, `503`.

### GET /v1/activations/lines.csv?[from=…&]to=…[&dealerId=…]
Le stesse righe in CSV, stesse colonne e protezioni di quello dei prospetti (la prima colonna è il dealer di ogni riga), stesso rate limit di esportazione, un solo export alla volta per utente. File `attivazioni-dettaglio_<from>_<to>.csv`, oppure `attivazioni-dettaglio_inizio_<to>.csv` senza `from`. Stessi errori, `409 tooManyLines` oltre 5000 righe.

### PUT/DELETE /v1/activations/renewal-bases/{anno}
- **Permesso:** `activations:manage`; nessun corpo (un corpo non vuoto è `422`); anno 2020–2100.
- **PUT** congela la base dei rinnovi dell'anno (parco di ogni dealer al 31 dicembre dell'anno prima, con righe e prezzi applicati): `200` `{ "data": { "period": "2026", "dealers": 2, "lines": 40 } }`; evento `activations.renewalBaseFrozen`. `409` con `details[0].issue`: `alreadyFrozen`, `yearInFuture` (anno successivo a quello corrente in `Europe/Rome`), `empty` (nessun punto vendita da congelare), `tooManyLines`. Congelamento, sblocco, chiusura e riapertura dello stesso anno si serializzano (documento di blocco per anno): due richieste concorrenti non riescono mai entrambe in conflitto tra loro, una ha `409`.
- **DELETE** la sblocca: `204`; evento `activations.renewalBaseUnfrozen`. `409`: `notFrozen`, `monthClosed` (un mese dell'anno è chiuso).

### PUT/DELETE /v1/activations/closures/{AAAA-MM}
- **Permesso:** `activations:manage`; nessun corpo.
- **PUT** chiude il mese della fattura per tutti i dealer, in una transazione: `200` `{ "data": { "period": "2026-06", "dealers": 3, "lines": 7 } }`; evento `activations.monthClosed`. Si può chiudere dal primo giorno del mese (che fattura le attivazioni del mese prima). `409`: `baseNotFrozen`, `monthInFuture`, `alreadyClosed`, `tooManyLines`. Chiusura e sblocco della base dello stesso anno non possono riuscire insieme: la chiusura legge la base dentro la transazione. Un dealer che compare dopo la chiusura non ne fa parte: il riepilogo di un mese chiuso serve solo la chiusura (un D senza documento vede una riga a zeri).
- **DELETE** riapre il mese (cancella la chiusura, torna calcolato al momento): `204`; evento `activations.monthReopened`. `409`: `notClosed`.
