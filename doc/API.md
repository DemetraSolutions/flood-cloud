# Riferimento API

> Documento **mantenuto a ogni passo** (`GEMINI.md` §3): descrive **tutti** gli endpoint realizzati delle tre superfici. Regole di progettazione in `doc/API-Guidelines.md`, credenziali in `doc/Security-Model.md`.
> Gli endpoint della superficie pubblica sono descritti anche in `doc/Public-API.md`, la versione per gli integratori esterni.

## Convenzioni comuni
- Envelope: `{ "data": ... }`, liste con `page`, errori `{ "error": { "code", "message", "details" } }`.
- Date ISO 8601 UTC, importi in centesimi interi, identificativi stringa.
- Codici d'errore: tabella in `doc/API-Guidelines.md` §5. Le route di un modulo che il gruppo non ha acceso rispondono `403 FEATURE_DISABLED` (qualunque sia il ruolo, PSA e D compresi), dopo il controllo del gruppo e del permesso.
- Ogni risposta porta `X-Request-Id`, generato dal server (un valore inviato dal client non viene riutilizzato).
- Ogni risposta è `Cache-Control: no-store`; `GET /v1/groups/{groupId}` porta in più `ETag` (debole) e risponde `304` a un `If-None-Match` corrispondente, per la copia in memoria del backoffice (vedi la sua descrizione).
- Errori comuni a ogni percorso: `404 NOT_FOUND` (percorso inesistente), `405 METHOD_NOT_ALLOWED` con `Allow` (metodo non previsto), `400 BAD_REQUEST` (percorso o richiesta malformati). Sulle route con body: `400 MALFORMED_JSON`, `413 PAYLOAD_TOO_LARGE` (limite di default 100 KB), `415 UNSUPPORTED_MEDIA_TYPE` (content type diverso da `application/json` UTF-8 o body compresso).

## Liste
Le collezioni paginate rispondono `200` con `{ "data": [ … ], "page": { "limit": 50, "next": "<cursore>" } }`; `next` è `null` all'ultima pagina.
- `limit`: intero 1–200, default 50.
- `cursor`: cursore **opaco**, massimo 2200 caratteri; si passa **così com'è** il valore di `page.next` della pagina precedente, senza interpretarlo né modificarlo. È valido solo con lo stesso `sort` con cui è stato emesso: un cursore non valido, alterato o di un altro ordinamento dà `422 VALIDATION_ERROR` con `details: [{ "field": "cursor", "issue": "format" }]`.
- `sort`: uno dei nomi ammessi dalla risorsa (allowlist), con prefisso `-` per l'ordine decrescente; ogni risorsa dichiara il proprio default. Un valore fuori elenco è `422` (`enum`).
- `q`: testo di ricerca, 1–64 caratteri (spazi ai bordi rimossi), cercato come testo letterale, senza distinzione tra maiuscole e minuscole, nei campi indicati dalla risorsa.
- Parametri sconosciuti o ripetuti sono `422`. Le query hanno un tempo massimo di 5 secondi.

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

Letture **compatte** (id, nome, stato) pensate per alimentare i selettori del backoffice, per esempio il gruppo, le aziende e i punti vendita nel perimetro di un utente. Le aree gruppi, aziende e punti vendita le estenderanno con le route di gestione complete. Parametri di lista comuni (`limit`, `cursor`, `sort`, `q`: vedi "Liste"); `sort` ammette solo `name` (default, anche `-name`), `q` cerca nel nome. Errori comuni a tutte e tre: `401 UNAUTHENTICATED` / `TOKEN_EXPIRED`, `403 FORBIDDEN` (permesso mancante), `403 PASSWORD_CHANGE_REQUIRED`, `422 VALIDATION_ERROR` (parametri non validi, `cursor`/`format` per un cursore non valido).

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

### GET /v1/groups/{groupId}/companies
- **Superficie:** backoffice
- **Autenticazione e permesso:** Bearer backoffice, `companies:read`
- **Ruoli:** PSA, D e SA nel proprio perimetro, CA le proprie aziende; il PA non ha `companies:read` (`403`)
- **Parametri di percorso:** `groupId` (24 caratteri esadecimali); un id malformato o fuori perimetro dà `404 NOT_FOUND`
- **Query:** parametri di lista; `trashed` (`true` per il cestino; default `false`); `ids` (da 1 a 100 id di 24 caratteri esadecimali separati da virgola, duplicati e maiuscole ignorati, stessa semantica di `lookup`): risolve i nomi delle aziende già scelte, sempre nel perimetro del chiamante (un id fuori perimetro non è restituito); `422` se malformato o oltre 100
- **Risposta:** `200`
  ```json
  {
    "data": [
      { "id": "665f1c2e9b1d4a0012ab34b2", "name": "Azienda Esempio Srl", "trashed": false }
    ],
    "page": { "limit": 50, "next": null }
  }
  ```
- **Errori:** comuni; `404 NOT_FOUND`

### GET /v1/groups/{groupId}/places
- **Superficie:** backoffice
- **Autenticazione e permesso:** Bearer backoffice, `places:read`
- **Ruoli:** i ruoli con il permesso, nel proprio perimetro
- **Parametri di percorso:** `groupId` (come sopra)
- **Query:** parametri di lista; `trashed` (default `false`); `companyId` (24 caratteri esadecimali) per limitare a un'azienda. Un'azienda fuori dal perimetro del chiamante non dà errore: la lista è **vuota**. `ids` (da 1 a 100 id separati da virgola, come per le aziende) risolve i nomi dei punti vendita già scelti, sempre nel perimetro del chiamante (un id fuori perimetro non è restituito); `422` se malformato o oltre 100.
- **Risposta:** `200`; `companyId` è `null` se il punto vendita non ha azienda
  ```json
  {
    "data": [
      { "id": "665f1c2e9b1d4a0012ab34b3", "name": "Punto Vendita Centro", "companyId": "665f1c2e9b1d4a0012ab34b2", "trashed": false },
      { "id": "665f1c2e9b1d4a0012ab34b4", "name": "Punto Vendita Nord", "companyId": null, "trashed": false }
    ],
    "page": { "limit": 50, "next": null }
  }
  ```
- **Errori:** comuni; `404 NOT_FOUND`

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
- `/services` resta invariato (permesso `users:read` e feature `services`, per la scheda utente).

### GET /v1/groups/{groupId}/lookup/price-lists
- **Superficie:** backoffice. Elenco compatto dei listini del gruppo, per assegnarli agli utenti e ai tipi di carta (CA e PA non hanno `groups:read`); la modifica dei listini resta a PSA, D, SA (`/price-lists`).
- **Autenticazione e permesso:** Bearer backoffice, **almeno uno** tra `users:read`, `fidelity:read` e `groups:read` (l'elenco compatto non è sensibile; serve alla scheda utente e ai tipi di carta fedeltà); `403` se il chiamante non ne ha nessuno. Route di gruppo (stesso perimetro e stessi `404` delle altre); nessuna feature richiesta.
- **Risposta:** `200`, `{ "data": [{ "id", "name", "enabled", "isDefault" }] }`, senza paginazione (al massimo 50 listini, come `GET /price-lists`); solo i listini, mai altri dati del gruppo.
  ```json
  { "data": [{ "id": "665f1c2e9b1d4a0012ab34f0", "name": "Listino 1", "enabled": true, "isDefault": true }] }
  ```
- **Errori:** comuni; `403 FORBIDDEN`; `404` (gruppo fuori perimetro)

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
