# Riferimento API

> Documento **mantenuto a ogni passo** (`GEMINI.md` §3): descrive **tutti** gli endpoint realizzati delle tre superfici. Regole di progettazione in `doc/API-Guidelines.md`, credenziali in `doc/Security-Model.md`.
> Gli endpoint della superficie pubblica sono descritti anche in `doc/Public-API.md`, la versione per gli integratori esterni.

## Convenzioni comuni
- Envelope: `{ "data": ... }`, liste con `page`, errori `{ "error": { "code", "message", "details" } }`.
- Date ISO 8601 UTC, importi in centesimi interi, identificativi stringa.
- Codici d'errore: tabella in `doc/API-Guidelines.md` §5.
- Ogni risposta porta `X-Request-Id`, generato dal server (un valore inviato dal client non viene riutilizzato).
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
> **Password provvisoria.** Quando un amministratore crea l'utente o ne reimposta la password, il login risponde con `passwordChangeRequired: true` (come `GET /v1/me`). Finché la password non è cambiata, tutte le route con Bearer rispondono `403 PASSWORD_CHANGE_REQUIRED`, **tranne** `GET /v1/me`, `PUT /v1/me/password`, `POST /v1/auth/logout` e `POST /v1/auth/logout-all`. Il client porta l'utente alla schermata di cambio password; dopo il cambio la sessione corrente resta valida e il flag torna `false`.
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
- **Risposta:** `200` con il profilo. `permissions` è l'elenco dei permessi effettivi (`risorsa:azione`, ordinati alfabeticamente), calcolato dal server a ogni richiesta. `scope` riassume il perimetro dati; `scope.kind` è uno tra `platform`, `dealer` (con `groups` e `groupIds`, al massimo 100 id), `group` (con `groupId`), `companies` (con `groupId`, `companies`, `places`), `places` (con `groupId`, `places`), `none`. `passwordChangeRequired` è `true` finché l'utente ha una password provvisoria da cambiare (route sempre ammessa, vedi la nota sul flusso). `group` (`id` e `name`) è `null` per i ruoli senza gruppo; `firstName`, `lastName`, `email`, `phone`, `createdAt`, `updatedAt` possono essere `null`.
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
      "passwordChangeRequired": false,
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

Rappresentazione di un utente, comune a tutte le route di questa sezione:
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
  "permissions": {
    "status": false,
    "modules": {
      "groups": { "r": false, "w": false },
      "users": { "r": true, "w": false },
      "companies": { "r": true, "w": false },
      "places": { "r": true, "w": true },
      "logs": { "r": false, "w": false }
    },
    "canManagePermissions": false
  },
  "createdAt": "2026-11-04T09:00:00.000Z",
  "updatedAt": "2026-11-04T09:00:00.000Z"
}
```
Mai presenti password, hash, PIN o token. Le richieste di creazione e modifica accettano `permissions` come `{ "modules": { "<modulo>": { "r": bool, "w": bool } }, "canManagePermissions": bool }`, con i moduli `groups`, `users`, `companies`, `places`, `logs` e ogni flag opzionale.

**Regole comuni**
- **Due aree.** Gli utenti di un gruppo (ruoli `SA`, `CA`, `PA`, `E`) stanno sotto `/v1/groups/{groupId}/users`; gli utenti di piattaforma (`PSA`, `D`) sotto `/v1/users`, **gestiti solo da un PSA** (qualunque altro ruolo riceve `403 FORBIDDEN`). `GET /v1/users` è invece anche l'elenco trasversale di PSA e D.
- **Gruppo nel percorso.** `groupId` è verificato rispetto al perimetro del chiamante prima del permesso: un id malformato o fuori perimetro dà `404 NOT_FOUND`. Un PSA o un D che accede a un gruppo lascia traccia nel registro delle attività.
- **Ruoli gestibili.** PSA: tutti; D e SA: `SA`, `CA`, `PA`, `E`; CA: `CA`, `PA`, `E`; PA: `PA`, `E`; E: nessuno. Il ruolo richiesto (in creazione o modifica) fuori da questo elenco dà `403 FORBIDDEN`. Il perimetro del chiamante limita anche gli utenti visibili: un utente inesistente, di un altro gruppo o fuori perimetro dà sempre lo **stesso** `404 NOT_FOUND`.
- **Anti-escalation.** `403 FORBIDDEN` (senza dettagli) anche quando: il bersaglio è il chiamante stesso, ha un rango superiore o un perimetro non gestito dal chiamante, **ha permessi che il chiamante non possiede** (vale per creazione, modifica, disabilitazione, cestino, reset password e eliminazione; la matrice richiesta non può superare quella del chiamante).
- **Perimetro (campi `companyIds` / `placeIds`, fino a 100 id ciascuno, duplicati ignorati).** `CA`: almeno un'azienda (`required` su `companyIds`); `PA` ed `E`: almeno un punto vendita (`required` su `placeIds`); `SA`, `PSA`, `D`: nessuno dei due (`incorrect`). Un id inesistente, nel cestino, di un altro gruppo o fuori dal perimetro del chiamante, o un punto vendita che non appartiene alle aziende dell'utente, è `incorrect` sulla posizione (`companyIds.N`, `placeIds.N`), senza distinguere i casi.
- **Password provvisoria.** Creazione e reset impostano una password provvisoria: l'utente al primo accesso deve cambiarla (`passwordChangeRequired`, vedi `PUT /v1/me/password`). Policy: 12–128 caratteri, diversa dallo username; le violazioni sono `issue` su `password` (`tooShort`, `tooLong`, `sameAsUsername`, `invalidCharacters`). Un cambio di ruolo, perimetro, stato o permessi, il reset della password e il cestino **terminano le sessioni** dell'utente.
- **Username:** solo ASCII, 3–64 caratteri tra lettere, cifre, `.`, `_`, `@`, `+`, `-` (spazi ai bordi rimossi). Univoco su tutta la piattaforma: se già in uso `409 CONFLICT` con `details: [{ "field": "username", "issue": "taken" }]`.
- **Errori comuni:** `401 UNAUTHENTICATED` / `TOKEN_EXPIRED`, `403 FORBIDDEN`, `403 PASSWORD_CHANGE_REQUIRED` (l'utente ha una password provvisoria da cambiare), `404 NOT_FOUND`, `400 MALFORMED_JSON`, `413 PAYLOAD_TOO_LARGE` (16 KB sulle scritture, 4 KB sul reset password), `415 UNSUPPORTED_MEDIA_TYPE`, `422 VALIDATION_ERROR` (per campo; proprietà sconosciute `unknown`; body vuoto in PATCH `(body)`/`required`).
- **Rate limit dedicato** su creazione e reset password (ognuno costa un calcolo di hash): per utente, 20 richieste al minuto di default; oltre `429 RATE_LIMITED` con `Retry-After`, con header `RateLimit-*` sulle risposte.

### GET /v1/groups/{groupId}/users
- **Superficie:** backoffice
- **Autenticazione e permesso:** Bearer backoffice, `users:read`
- **Ruoli:** i ruoli con il permesso, entro il proprio perimetro (PSA e D dei propri gruppi; SA, CA, PA il proprio gruppo; i CA e i PA vedono gli utenti del proprio perimetro di aziende e punti vendita)
- **Parametri di percorso:** `groupId` (24 caratteri esadecimali)
- **Query:** `limit`, `cursor`, `sort`, `q` come nelle convenzioni sulle liste; `role` (`SA`, `CA`, `PA`, `E`); `status` (`active`, `disabled`); `trashed` (`true` per vedere solo il cestino; default `false`, cestino escluso). `sort`: `username` (default), `lastName`, `createdAt`, con `-` per l'ordine decrescente. `q` cerca nello username, nome, cognome, e-mail e telefono.
- **Risposta:** `200`
  ```json
  { "data": [ { "id": "665f1c2e9b1d4a0012ab34ce", "username": "mario.rossi", "role": "CA", "…": "rappresentazione completa come sopra" } ], "page": { "limit": 50, "next": null } }
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
  ```json
  { "username": "mario.rossi", "password": "<password provvisoria>", "role": "PA", "firstName": "Mario", "placeIds": ["665f1c2e9b1d4a0012ab34b3"] }
  ```
- **Header particolari:** risposta con `Location: /v1/groups/{groupId}/users/{userId}`; `RateLimit-*`
- **Risposta:** `201` con l'utente creato (rappresentazione completa)
- **Errori:** comuni; `403 FORBIDDEN` (ruolo non gestibile, permessi richiesti non posseduti); `409 CONFLICT` (`username`/`taken`); `422` per campo (`password` con le issue di policy, `companyIds`/`placeIds` `required` / `incorrect`, `companyIds.N` / `placeIds.N` `incorrect`); `429 RATE_LIMITED`

### GET /v1/groups/{groupId}/users/{userId}
- **Autenticazione e permesso:** Bearer backoffice, `users:read`
- **Parametri di percorso:** `groupId`, `userId` (24 caratteri esadecimali)
- **Risposta:** `200` con l'utente
- **Errori:** comuni; `404 NOT_FOUND` identico per utente inesistente, di un altro gruppo o fuori perimetro

### PATCH /v1/groups/{groupId}/users/{userId}
- **Autenticazione e permesso:** Bearer backoffice, `users:update`
- **Body** (JSON Merge Patch, massimo 16 KB, almeno un campo): gli stessi campi della creazione tranne `password`, tutti opzionali (`username`, `role`, `firstName`, `lastName`, `email`, `phone`, `language`, `companyIds`, `placeIds`, `status`, `permissions`). I flag di `permissions` inviati sostituiscono quelli salvati, gli altri restano. Il perimetro è verificato solo se cambia perimetro o ruolo. Disabilitare un utente (`status: "disabled"`) richiede di possedere almeno i permessi che l'utente ha.
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
- **Body:** come la creazione di un utente di gruppo ma `role` è `PSA` o `D`, senza `companyIds` né `placeIds` (nessun gruppo, nessun perimetro)
- **Header particolari:** `Location: /v1/users/{userId}`; `RateLimit-*`
- **Risposta:** `201` con l'utente creato
  ```json
  { "data": { "id": "665f1c2e9b1d4a0012ab34d1", "username": "dealer.nord", "role": "D", "groupId": null, "…": "rappresentazione completa" } }
  ```
- **Errori:** comuni; `403 FORBIDDEN`, `409 CONFLICT` (`username`/`taken`), `422`, `429 RATE_LIMITED`

### GET /v1/users/{userId}, PATCH /v1/users/{userId}, PUT /v1/users/{userId}/password, POST /v1/users/{userId}/trash, POST /v1/users/{userId}/restore, DELETE /v1/users/{userId}
- **Autenticazione e permesso:** Bearer backoffice, rispettivamente `users:read`, `users:update`, `users:update`, `users:trash`, `users:trash`, `users:delete`; solo **PSA**, su utenti `PSA` e `D`
- **Body, risposte ed errori:** come le route corrispondenti del gruppo (PATCH senza `companyIds` / `placeIds`, con `role` limitato a `PSA` e `D`). In più, `DELETE` di un `D` che ha ancora gruppi (anche nel cestino) dà `409 CONFLICT`. Un utente di gruppo chiesto su questo percorso è `404 NOT_FOUND`.

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
- **Query:** parametri di lista; `status` (`active`, `suspended`); `trashed` (`true` per il cestino; default `false`, cestino escluso). I filtri `status` e `trashed=true` sono riservati al PSA: un altro ruolo che li usa riceve `403 FORBIDDEN`.
- **Risposta:** `200`
  ```json
  {
    "data": [
      { "id": "665f1c2e9b1d4a0012ab34a1", "name": "Gruppo Esempio", "status": "active", "trashed": false }
    ],
    "page": { "limit": 50, "next": null }
  }
  ```
  `status` è `active` o `suspended`.
- **Errori:** comuni; `403 FORBIDDEN` anche per i filtri riservati

### GET /v1/groups/{groupId}/companies
- **Superficie:** backoffice
- **Autenticazione e permesso:** Bearer backoffice, `companies:read`
- **Ruoli:** PSA, D e SA nel proprio perimetro, CA le proprie aziende; il PA non ha `companies:read` (`403`)
- **Parametri di percorso:** `groupId` (24 caratteri esadecimali); un id malformato o fuori perimetro dà `404 NOT_FOUND`
- **Query:** parametri di lista; `trashed` (`true` per il cestino; default `false`)
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
- **Query:** parametri di lista; `trashed` (default `false`); `companyId` (24 caratteri esadecimali) per limitare a un'azienda. Un'azienda fuori dal perimetro del chiamante non dà errore: la lista è **vuota**.
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

## Superficie server di punto vendita — `/store/v1`
Nessun endpoint realizzato.

## Superficie pubblica — `/public/v1`
Nessun endpoint realizzato.
