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
> **Header comuni:** dove è applicato un rate limit la risposta porta `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` (secondi alla riapertura della finestra); oltre il limite `429 RATE_LIMITED` aggiunge `Retry-After` (secondi).
> **Server di punto vendita.** L'app del negozio chiama le stesse route con una **chiave di negozio** (`Authorization: Bearer fc_sk_…`, sezione "Chiave di negozio" più sotto), ma solo quelle che la ammettono (oggi `GET /v1/groups/{groupId}/places/{placeId}` e `GET /v1/store-context`): ogni altra route risponde `403 FORBIDDEN` a una chiave di negozio. Una chiave valida con un punto vendita non operativo riceve `403 STORE_DISABLED`.
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

`pos`: `{ "enabled": bool, "grants": {…}, "options": {…} }`, tutto facoltativo, in modifica si fonde con i valori salvati (i singoli flag inviati cambiano, gli altri restano). `grants` sono **permessi**: 44 flag booleani (nomi in `doc/Data-Model.md`), `discountMaxPercentage` e `servicePercentage` (0–100 o `null` per nessun tetto), `automaticCash` per i dispositivi `glory`, `cashMatic`, `vne`, `azkoyen`, `cashSystem` (flag booleani). `options` sono preferenze di interfaccia, non permessi: 31 booleani più `favoritesId` (id di un elenco di `GET /v1/groups/{groupId}/product-favorites` del gruppo dell'utente, o `null`), `side` e `sideRooms` (`dx`, `sx`), `virtualKeyboard` (`""`, `pb`, `p`, `mb`, `m`), `template` (`material-tealwhite-light`, `material-tealwhite-dark`, `material-whitepurple-light`, `material-whitepurple-dark` o `null`), `productsFontSize` e `productsShortNameFontSize` (`s`, `m`, `l`), `roomsTablesColumns` (4, 5, 6, 8 o `null`), `roomsTablesColumnsHandheld` (2, 3, 4 o `null`), `roomsGridZoomHandheld` (1, 1.5, 2, 2.5, 3), `quickDiscount` (0–100 o `null`), `defaultPriceListId` (listino di un elenco di `GET /v1/groups/{groupId}/price-lists`, o `null`) e `priceLists`, l'elenco `[{ "priceListId", "enabled", "isDefault" }]` dei listini che l'utente può usare (fino a 50, al massimo uno `isDefault`, tutti del gruppo dell'utente, senza ripetizioni; se inviato, sostituisce l'elenco salvato). Riferimenti non validi: `pos.options.favoritesId`, `pos.options.defaultPriceListId`, `pos.options.priceLists.N.priceListId` o `.isDefault` `incorrect` (un riferimento che l'utente ha già non è ricontrollato). Un utente senza gruppo (PSA, D) non può riferirsi ad alcun elenco.
- **Chi può dare i permessi della cassa** (`pos.enabled`, `pos.grants`): serve `canManagePermissions`, altrimenti `403 FORBIDDEN` senza dettagli. `PSA`, `D` e `SA` li impostano tutti. `CA` e `PA` concedono **solo ciò che hanno loro**: un flag diventa `true` solo se lo hanno, non abilitano la cassa se non è abilitata per loro, e se hanno un tetto di sconto non possono impostare `null` né un valore maggiore: `403 FORBIDDEN` con `details: [{ "field": "pos.grants.discount", "issue": "notAllowed" }]` (anche `pos.enabled`, `pos.grants.discountMaxPercentage`, `pos.grants.automaticCash.<dispositivo>.<flag>`). Chi crea senza poter gestire i permessi dà all'utente il solo default del ruolo (per `CA` e `PA` limitato a ciò che possiedono). Le `options` non sono permessi: le cambia chiunque possa modificare l'utente.
- **Default alla creazione.** Senza `permissions`, la matrice è quella del ruolo nel modulo di creazione del vecchio sistema (tabella in `doc/Technical-Guide.md` §6, limitata a ciò che possiede chi crea); senza `pos`, `PSA` e `D` hanno la cassa spenta e nessun flag, gli altri ruoli la cassa abilitata con `discount`, `priceChange`, `invoices` e `freeSale`; le preferenze hanno i valori predefiniti (`side` e `sideRooms` `dx`, `virtualKeyboard` `""`, `template` `material-whitepurple-light`, font `s`, `roomsGridZoomHandheld` 2, il resto spento o `null`) e `priceLists` contiene tutti i listini del gruppo abilitati, con selezionato il predefinito del gruppo (vuoto per chi non ha gruppo). Ciò che l'utente invia sostituisce i default. Il documento creato ha tutte le chiavi del vecchio sistema.
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
- **Body** (JSON Merge Patch, massimo 512 KB, almeno un campo): gli stessi campi della creazione tranne `password`, tutti opzionali (`username`, `role`, `firstName`, `lastName`, `email`, `phone`, `language`, `companyIds`, `placeIds`, `status`, `permissions`, `description`, `avatar`, `pin`, `hiddenInStats`, `serviceIds`, `pos`, `shiftTime`). I flag di `permissions` e di `pos` inviati sostituiscono quelli salvati, gli altri restano; le scritture sono per singolo valore, quindi le informazioni dell'utente che il sistema non gestisce restano intatte. Un `pin` inviato è sempre scritto. Il perimetro è verificato solo se cambia perimetro o ruolo. Disabilitare un utente (`status: "disabled"`) richiede di possedere almeno i permessi che l'utente ha.
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
- **Errori:** comuni; `403 FORBIDDEN` (inclusi i permessi del bersaglio non posseduti), `404`, `409 CONFLICT` (l'utente **non è nel cestino**)

### GET /v1/users
- **Autenticazione e permesso:** Bearer backoffice, `users:read`
- **Ruoli:** **PSA** (tutti gli utenti) e **D** (gli utenti dei gruppi del dealer); ogni altro ruolo `403 FORBIDDEN`
- **Query:** come l'elenco del gruppo, con `role` su tutti i ruoli (`PSA`, `D`, `SA`, `CA`, `PA`, `E`) e in più `groupId` e `dealerId` (24 caratteri esadecimali). `dealerId` è riservato al PSA (un D riceve `403 FORBIDDEN`).
- **Risposta:** `200` `{ "data": [ … ], "page": { "limit": 50, "next": "…" } }`
- **Errori:** comuni; `403 FORBIDDEN`; `422`

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
- **Body, risposte ed errori:** come le route corrispondenti del gruppo (PATCH senza `companyIds` / `placeIds` / `serviceIds`, con `role` limitato a `PSA` e `D`). In più: `DELETE` di un `D` che ha ancora gruppi (anche nel cestino) dà `409 CONFLICT`, altrimenti elimina anche la sua anagrafica dealer; un `PATCH` che porta il ruolo **da o verso `D`** dà `422` con `details: [{ "field": "role", "issue": "immutable" }]` (il ruolo `D` non si cambia). Un utente di gruppo chiesto su questo percorso è `404 NOT_FOUND`.

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
- **Autenticazione e permesso:** Bearer backoffice, `places:read`; oppure la **chiave di negozio** del punto vendita (solo il proprio: qualunque altro `placeId` o gruppo è `404` identico; `403 STORE_DISABLED` se il punto vendita non è operativo), con la stessa rappresentazione e lo stesso `ETag`
- **Risposta:** `200` con il punto vendita (anche nel cestino), `ETag` forte = versione del documento del **database del gruppo** (non della copia), cioè quella che `If-Match` si aspetta. **Non restituisce mai una credenziale** (le credenziali di integrazioni e dispositivi sono solo scrivibili: la risposta ha `<chiave>Set: true|false`), né le chiavi che scrive il POS negli elementi. `dealerSettings` (indirizzo del server di negozio e del Connector, Sentry) è nella risposta **solo per PSA e D**; la chiave di negozio non lo riceve.
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
| `integrations` | `…/integrations` | oggetto per provider | `integrations.*` (16 provider) |
| `dealerSettings` | `…/settings/dealer` | `{ sentry, serverIp, connectorAddress }` | `platform.sentry`, `server.ip`, `connectorAddress` |

**Liste (regole comuni).** L'elenco inviato **sostituisce** quello memorizzato: un elemento assente è rimosso, l'ordine è quello della richiesta. Gli elementi sono identificati dal loro `id` stabile: con `id` deve essere uno dei punti vendita (altrimenti `422 incorrect`, anche se ripetuto), senza `id` ne riceve uno nella forma `createId` del vecchio backoffice (per i depositi un `ObjectId`). Ogni chiave è opzionale (un elemento nuovo prende i default, uno esistente tiene il valore); si scrivono solo le chiavi che cambiano, e il server le **sovrappone all'elemento memorizzato dentro la transazione**: le chiavi non possedute (`info` e `status` dei dispositivi scritti dal POS, `view.subtables`, `__index`, `__listName`, qualunque chiave futura) restano, e un valore invariato mantiene il tipo BSON esatto. **Elementi senza `id` o con `id` ripetuto.** Se la lista memorizzata contiene un elemento senza `id` utilizzabile o due elementi con lo stesso `id` (anche un tavolo dentro una sala), la lista **non è scrivibile**, per non perdere l'elemento: `GET` la restituisce con `editable: false` (`devices`, `rooms`, `storages`; `stationsEditable` e `productionCentersEditable` per le postazioni) e l'elemento compare in sola lettura con `id: ""` e `withoutId: true`. Il blocco rimandato identico (`PUT` o dentro il `PATCH`) non fa nulla; qualsiasi modifica è `409 CONFLICT` con `details: [{ "field": "<blocco>", "issue": "incorrect" }]` e il messaggio "The stored list has an item without an id and cannot be changed", e non scrive nulla. Il resto del punto vendita resta modificabile. Le regole si applicano solo agli elementi nuovi o cambiati.
- **Dispositivi.** Tutte le chiavi del form del vecchio backoffice (`server`, `type`, `name`, `driver`, `host`, `serialNumber`, `epsonProtocol17`, `epsonEreceipt`, `DLN502017Rounding`, `secondaryDriver/Host`, `automaticCash*`, `posProtocol17*`, `posDojoTerminalId`, `externalDisplayId`, `secondaryCompanyPrinterId`, `favoritesId`, `scaleDialog0204*`, `barcodePriceRule`, `orderingPrintSingleProduct*`, `printStations`). `externalDisplayName`, `secondaryCompanyPrinterName` e `favoritesGroupName` li calcola il server. Regole: nome obbligatorio e univoco senza distinguere le maiuscole (`required`, `taken`); `type` tra i nove tipi, e per il piano come nel legacy (`desk` sempre; `basic` anche `waiting-list`, `external-display`, `kiosk`, `tgm`; `advanced` tutti; altri piani solo `desk`; un tipo storico rimandato invariato è accettato); un solo `server: true`; driver nelle liste del vecchio backoffice; `externalDisplayId` un dispositivo `external-display`, `secondaryCompanyPrinterId` uno `tgm`, `favoritesId` una lista preferiti del gruppo, `printStations` postazioni del punto vendita (`incorrect`, solo dove cambiano). Rimuovere un dispositivo è permesso, ma **`409` con `devices.items` `busy`** se il POS lo segnala occupato (`status.busy`). I nuovi dispositivi ricevono `status: { busy: false, userName: '' }` una sola volta (lo legge il vecchio backoffice). **Il POS scrive `devices.<i>.info` per indice:** rimuovere o riordinare sposta gli indici, come nel legacy.
- **Credenziali dei dispositivi** (`automaticCashUsername`, `automaticCashPassword`): **solo scrivibili**. Un testo le imposta, `null` o `''` le cancella (`null` memorizzato), assenti restano; la risposta ha `automaticCashUsernameSet` e `automaticCashPasswordSet`. Mai in risposte, errori, registro delle attività o log.
- **Postazioni comanda.** Postazione: `name`, `driver` (`EPSON-EPOS-PRINT`, `ESCPOS`), `host` obbligatori (`required`), `pulseNumber`, `pulseNumberSecondary`, `upsideDown`, `exitsCut`, `summaryCategoriesIds` (categorie di `products_categories`, non nel cestino), `summaryPrintStationsIds` (postazioni del punto vendita, mai se stessa). Centro di produzione: `name` e `capacity` (intero ≥ 0).
- **Sale.** Sala: `name` (univoco senza distinguere le maiuscole), `listId` (listino attivo del gruppo), `service` (0–100), `tax` (aliquota del gruppo), `deviceId` (dispositivo `desk`), i cinque interruttori, `printStations`, `tables[]` (`name` univoco nella sala, `seats`, `userId` [un utente del gruppo, non nel cestino, con il punto vendita in scope: `incorrect` dove cambia], `view` `{ w, h, x, y, shape: rect|round }`; `roomId` lo imposta il server) e `view` `{ type: grid|'', status, h, w }` (celle da 1 a 50; un tavolo con `x` e `y` deve stare nella griglia). Una sala senza `view` si legge con i default dell'editor (`grid`, spenta, 8×8) ma **non** si riscrive finché non cambia. Limiti: 30 sale, 200 tavoli per sala, 1000 in tutto (`tooMany`). **Il POS riscrive l'intero array `rooms`**: `rooms` fa parte della versione, quindi una scrittura del POS tra `GET` e salvataggio dà `412` (nel legacy vince l'ultimo che scrive, decisione 5.6.4). `view.subtables` e ogni altra chiave del POS per id di sala e di tavolo si conservano. Gli artefatti dell'interfaccia (`__index`, `__listName`, `__printStationsLabels`) non si scrivono mai; quelli memorizzati restano.
- **Depositi.** `name`, `cash`, `ecommerce`; gli `id` esistenti restano (`ObjectId`, mai rigenerati), i nuovi sono `ObjectId`. Regole del legacy: almeno un deposito, **esattamente uno** `cash`, **al più uno** `ecommerce` (`incorrect`/`required` su `storages.items`). La rimozione è permessa; i riferimenti dal magazzino **non sono ancora verificati**.
- **Integrazioni.** Provider: `floodPay` (`stripe`, `qrCodePayment`, `tapToPay`), `bizerba`, `googleMaps`, `reserveWithGoogle`, `easyappear`, `yellgo`, `leggimenu`, `plateform`, `cooperto`, `dojo`, `satispay`, `qodeup`, `tomatoai`, `keenon`, `tsh`, `phlex`. Le chiavi non segrete sono leggibili (`stripe.publicKey`, `bizerba.*`, `tsh.propertyId`, `categoriesMap`…); `tsh.categories` (elenco del provider) è solo lettura (si può rimandare, è ignorato). **Credenziali dei pagamenti (solo PSA e D):** `stripe.publicKey`, `stripe.privateKey`, `stripe.webhookPrivateKey`, `dojo.apiKey`, `satispay.activationCode`, `satispay.keyId`, `qodeup.apiKey`: impostarle, cambiarle o cancellarle da un altro ruolo è `403 notAllowed` (con il percorso); una richiesta che le lascia fuori è accettata, e gli altri ruoli vedono solo `…Set`. **Credenziali, solo scrivibili** con il flag `…Set` nella risposta (non tagliate: uno spazio all'inizio o alla fine è `422 pattern`): `stripe.privateKey`, `stripe.webhookPrivateKey`, `easyappear.appToken`, `yellgo/leggimenu/cooperto/dojo/qodeup/tomatoai.apiKey`, `plateform.username/password`, `satispay.activationCode/keyId`, `tsh.id/secret`, `phlex.username/password`. Formati: chiavi Stripe `pk_`, `sk_`/`rk_`, `whsec_`; codice Satispay alfanumerico; le altre testo stampabile senza spazi (fino a 512). Gli interruttori `…status` dei 16 provider sono **riservati** a PSA e D (`403 notAllowed` se un altro ruolo li cambia). `reserveWithGoogle.url` deve essere `https://…` e `telephone` fatto di cifre, spazi, `+`, `-`, `(`, `)` (controllati dove cambiano). Con `reserveWithGoogle` attivo i dati devono essere completi (`required`; latitudine e longitudine `0` valgono come mancanti, come nel feed) e a ogni modifica di quelle chiavi o dell'azienda il feed `reserve_with_google` viene **inserito o aggiornato se attivo e completo, altrimenti rimosso** (stesso risultato per un punto vendita nel cestino), nella stessa transazione. Le chiavi che nessuno possiede (`integrations.floodOrders`, `plateform.locationId`, `tsh.tshCategories`…) restano.
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
> **Stati del negozio a ogni richiesta.** `401 UNAUTHENTICATED` (identico) per chiave assente, malformata, sconosciuta o revocata, o gruppo inesistente: serve una nuova attivazione. `403 STORE_DISABLED` (nulla è revocato) per gruppo sospeso o nel cestino, punto vendita disattivato o con licenza scaduta (`expirationDate` passata rispetto all'orologio del server), azienda nel cestino: riprende da solo con la riattivazione, il ripristino o il rinnovo. Un punto vendita nel cestino (anche dal legacy) o eliminato **revoca** la chiave (`401`): un punto vendita ripristinato non la riottiene. `403 FORBIDDEN` per una route che non ammette il negozio; `404` per un punto vendita o un gruppo che non sono il suo. Limite: 600 richieste al minuto per chiave (`429` con `Retry-After`), contate a ogni richiesta di una chiave attiva, anche quelle rifiutate con `403` e quelle di un negozio bloccato. Le risposte portano il contesto del negozio solo in `GET /v1/store-context`.

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
  `status` è `none` (mai attivata, o l'ultima è revocata: `key: null`) o `active`; `pendingActivation` è `null` senza un codice valido (un codice scaduto non si mostra); `lastRevoked` (`reason`: `revoked`, `replaced`, `placeTrashed`, `placeDeleted`) è `null` se nessuna chiave è mai stata revocata. Mai la chiave né il suo hash.
- **Errori:** comuni; `403`; `404`; `422` (`placeId`)

### POST /v1/groups/{groupId}/places/{placeId}/store-key/activation-codes
- **Autenticazione e permesso:** Bearer backoffice, `storeKeys:manage` (PSA e D); body vuoto (nessun body o `{}`: ogni proprietà è `422`); 20 al minuto per utente
- **Comportamento:** genera il codice (16 simboli, 80 bit) e **sostituisce** quello pendente del punto vendita (ne esiste uno solo). **Non tocca la chiave attiva**: il negozio continua a funzionare finché il nuovo server non si attiva. Registra `store.activationCodeCreated`. La risposta non è mai compressa.
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
- **Autenticazione e permesso:** solo la **chiave di negozio**; nessun permesso del catalogo (il profilo del negozio è fisso: oggi la sola lettura del proprio punto vendita). Un access token di un utente è `403 FORBIDDEN`.
- **Risposta:** `200`; serve all'app per verificare la chiave e per ricavare l'azienda attuale del punto vendita senza leggere dati
  ```json
  { "data": { "groupId": "665f…", "companyId": "665f…", "placeId": "665f…", "keyId": "6650…", "activatedAt": "2026-11-13T10:00:00.000Z" } }
  ```
- **Errori:** `401`; `403 STORE_DISABLED`; `403 FORBIDDEN` (non è una chiave di negozio); `429`

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
`features` ha sempre le 15 feature del catalogo, `false` se nel documento mancano o non sono booleane. `description` e le date possono essere `null`. `languages` sono codici ISO 639-1. `statsSettings.timeSlots` ha ore intere (`from` da `00:00` a `23:00`, `to` da `01:00` a `24:00`). `integrations` ha sempre i sette provider (`easyappear`, `yellgo`, `leggimenu`, `plateform`, `cooperto`, `qodeup`, `statmanager`): `apiKeySet` dice solo se una chiave è impostata, **la chiave non è mai restituita**. `dataCluster` (l'id del cluster con i dati del gruppo, `null` per il cluster di default) è presente **solo per il PSA**. I sei cataloghi della scheda gruppo (`priceLists` … `fidelityCardRules`) sono nel dettaglio; fidelity, preferiti e promozioni si leggono dalle loro route (sezione "Cataloghi del gruppo"). Non sono mai esposti `apiKey`, host dei dati e dei file, `type`, `plan`, scadenza, elenco dei punti vendita del sistema precedente.

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
- **Risposta:** `200` con il gruppo (`trashed: true`), con la stessa revoca delle sessioni della sospensione. Eventi `group.trashed` (sicurezza e dati) e `session.revoked`. I gruppi non si eliminano mai definitivamente.
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
- **Query:** `limit` (1–100, default 50), `cursor`, `sort` (`name`, anche `-name`; default `name`), `q` (cerca nel nome, testo letterale senza distinzione di maiuscole), `ids` (facoltativo: da 1 a 100 id separati da virgola, per risolvere i nomi degli elementi già scelti; id di altri gruppi, inesistenti o nel cestino non compaiono; si combina con `q` e con la paginazione). Solo `/lookup/products` accetta anche `type` (`product`, `service`, `exempt`, `tobaccos`, `games`, `monopoly`; altro valore è `422`). Parametri sconosciuti, `ids` non valido o con più di 100 id: `422`.
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

### GET /v1/groups/{groupId}/lookup/languages
- **Superficie:** backoffice. Le lingue del gruppo (`settings.languages`), per i testi del kiosk (CA e PA non hanno `groups:read`).
- **Autenticazione e permesso:** Bearer backoffice, **almeno uno** tra `places:update` e `groups:read`.
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

## Registro attività ed errori (`/v1`)

### GET /v1/activity-log
- **Superficie:** backoffice
- **Autenticazione e permesso:** Bearer backoffice, `activityLog:read`
- **Ruoli e perimetro:** PSA: tutto il registro; D: le voci dei propri gruppi (attivi); SA: le voci del proprio gruppo; CA e PA: **solo le proprie azioni**. La categoria `error` (e le sue azioni, come `client.error`) è **riservata al PSA**: per gli altri ruoli `category=error` o un'`action` di quella categoria dà `403 FORBIDDEN`. Un `groupId` fuori dal perimetro non dà errore: la pagina è vuota.
- **Query:**
  | Parametro | Tipo | Note |
  |---|---|---|
  | `limit`, `cursor` | come nelle "Liste" | l'ordine è fisso: più recenti prima (data decrescente); nessun `sort` né `q` |
  | `category` | `data`, `security`, `error` | |
  | `action` | uno dei nomi del catalogo delle azioni (es. `auth.loginFailed`, `user.created`, `client.error`) | un nome sconosciuto è `422` (`enum`) |
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
Nessun endpoint realizzato.
