# Riferimento API

> Documento **mantenuto a ogni passo** (`GEMINI.md` §3): descrive **tutti** gli endpoint realizzati delle tre superfici. Regole di progettazione in `doc/API-Guidelines.md`, credenziali in `doc/Security-Model.md`.
> Gli endpoint della superficie pubblica sono descritti anche in `doc/Public-API.md`, la versione per gli integratori esterni.

## Convenzioni comuni
- Envelope: `{ "data": ... }`, liste con `page`, errori `{ "error": { "code", "message", "details" } }`.
- Date ISO 8601 UTC, importi in centesimi interi, identificativi stringa.
- Codici d'errore: tabella in `doc/API-Guidelines.md` §5.
- Ogni risposta porta `X-Request-Id`, generato dal server (un valore inviato dal client non viene riutilizzato).
- Errori comuni a ogni percorso: `404 NOT_FOUND` (percorso inesistente), `405 METHOD_NOT_ALLOWED` con `Allow` (metodo non previsto), `400 BAD_REQUEST` (percorso o richiesta malformati). Sulle route con body: `400 MALFORMED_JSON`, `413 PAYLOAD_TOO_LARGE` (limite di default 100 KB), `415 UNSUPPORTED_MEDIA_TYPE` (content type diverso da `application/json` UTF-8 o body compresso).

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
- **Superficie:** backoffice | store | pubblica
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
- **Risposta:** `200`
  ```json
  {
    "data": {
      "accessToken": "fc_at_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "accessTokenExpiresAt": "2026-11-04T09:15:00.000Z",
      "refreshToken": "fc_rt_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "refreshTokenExpiresAt": "2026-11-11T09:00:00.000Z",
      "sessionId": "665f1c2e9b1d4a0012ab34cd"
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
- **Autenticazione e permesso:** Bearer backoffice, `profile:read`
- **Ruoli:** ogni utente autenticato, sul proprio profilo
- **Risposta:** `200` con il profilo. `permissions` è l'elenco dei permessi effettivi (`risorsa:azione`, ordinati alfabeticamente), calcolato dal server a ogni richiesta. `scope` riassume il perimetro dati; `scope.kind` è uno tra `platform`, `dealer` (con `groups` e `groupIds`, al massimo 100 id), `group` (con `groupId`), `companies` (con `groupId`, `companies`, `places`), `places` (con `groupId`, `places`), `none`. `group` (`id` e `name`) è `null` per i ruoli senza gruppo; `firstName`, `lastName`, `email`, `phone`, `createdAt`, `updatedAt` possono essere `null`.
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
      "permissions": ["companies:read", "places:read", "places:update", "profile:read", "profile:update", "sessions:revoke", "users:read"],
      "canManagePermissions": false,
      "scope": { "kind": "companies", "groupId": "665f1c2e9b1d4a0012ab34a1", "companies": 1, "places": 2 },
      "group": { "id": "665f1c2e9b1d4a0012ab34a1", "name": "Gruppo Esempio" },
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
- **Body** (`application/json`, massimo 8 KB, JSON Merge Patch; almeno un campo; ogni altra proprietà, come `role`, `groupId`, `permissions` o `status`, è respinta come sconosciuta):
  | Campo | Tipo | Vincoli |
  |---|---|---|
  | `firstName` | stringa o `null` | 1–100 caratteri dopo il trim, senza caratteri di controllo né override bidirezionali; `null` azzera |
  | `lastName` | stringa o `null` | come `firstName` |
  | `email` | stringa o `null` | indirizzo di sintassi ordinaria (ASCII, un solo `@`, dominio con punto), massimo 254 caratteri, salvato in minuscolo; `null` azzera |
  | `phone` | stringa o `null` | cifre, spazi, `+`, `-`, `(`, `)` con almeno una cifra, massimo 32 caratteri; `null` azzera |
  | `language` | stringa | `it` (unico valore supportato) |
  Un campo assente non viene modificato.
  ```json
  { "firstName": "Mario", "phone": null, "language": "it" }
  ```
- **Risposta:** `200` con il profilo aggiornato, stessa forma di `GET /v1/me`
- **Errori:** `401 UNAUTHENTICATED` / `TOKEN_EXPIRED`, `403 FORBIDDEN`, `404 NOT_FOUND`, `400 MALFORMED_JSON`, `413 PAYLOAD_TOO_LARGE`, `415 UNSUPPORTED_MEDIA_TYPE`, `422 VALIDATION_ERROR`:
  ```json
  { "error": { "code": "VALIDATION_ERROR", "message": "Invalid request", "details": [{ "field": "email", "issue": "format" }, { "field": "role", "issue": "unknown" }] } }
  ```
  Un body vuoto (`{}`) dà `details: [{ "field": "(body)", "issue": "required" }]`.

### PUT /v1/me/password
- **Superficie:** backoffice
- **Autenticazione e permesso:** Bearer backoffice, `profile:update`
- **Ruoli:** ogni utente autenticato, sulla propria password
- **Body** (`application/json`, massimo 8 KB, nessun'altra proprietà):
  | Campo | Tipo | Obbligatorio | Vincoli |
  |---|---|---|---|
  | `currentPassword` | stringa | sì | 1–1024 caratteri, usata esattamente come inviata |
  | `newPassword` | stringa | sì | massimo 1024 caratteri nella richiesta; la policy richiede 12–128 caratteri, diversa dallo username |
- **Header particolari:** `RateLimit-*` (limite per utente)
- **Risposta:** `204` senza body. Tutte le **altre** sessioni dell'utente vengono revocate; quella corrente resta valida.
- **Errori:** `401 UNAUTHENTICATED` / `TOKEN_EXPIRED`, `403 FORBIDDEN`, `404 NOT_FOUND`, `400 MALFORMED_JSON`, `413 PAYLOAD_TOO_LARGE`, `415 UNSUPPORTED_MEDIA_TYPE`, `429 RATE_LIMITED` con `Retry-After`, `422 VALIDATION_ERROR`:
  - password attuale errata:
    ```json
    { "error": { "code": "VALIDATION_ERROR", "message": "Invalid request", "details": [{ "field": "currentPassword", "issue": "incorrect" }] } }
    ```
  - nuova password fuori policy (uno o più `issue` su `newPassword`: `tooShort`, `tooLong`, `sameAsUsername`, `invalidCharacters`):
    ```json
    { "error": { "code": "VALIDATION_ERROR", "message": "Invalid request", "details": [{ "field": "newPassword", "issue": "tooShort" }] } }
    ```

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

## Superficie server di punto vendita — `/store/v1`
Nessun endpoint realizzato.

## Superficie pubblica — `/public/v1`
Nessun endpoint realizzato.
