# Documentazione Tecnica

> Documento **mantenuto a ogni passo** (`GEMINI.md` §3): descrive ciò che è **realizzato**, non ciò che è progettato. §1–§10 riguardano il backend, §11 il backoffice. Il progetto è in `doc/Architecture.md`, `doc/Security-Model.md`, `doc/Data-Model.md`, `doc/API-Guidelines.md`.
> Quando un passo aggiunge o cambia qualcosa, si aggiorna la sezione corrispondente; le sezioni ancora vuote restano con la nota "Nessun elemento realizzato".

## 1. Stato del progetto
Realizzate le fondamenta del backend (`doc/Tasks.md` 1.1–1.4, 1.6): progetto TypeScript, configurazione validata, applicazione Express con envelope, errori, header di sicurezza, CORS, log strutturati, builder delle route, endpoint di salute e arresto ordinato; client MongoDB sul cluster condiviso con guardia d'ambiente, registro delle collection, indici, strumento di profilazione in sola lettura del legacy, MongoDB locale per i test. Nessuna autenticazione, nessun endpoint di dominio, nessuna scrittura su database.

Realizzate le primitive crittografiche e la compatibilità con le password legacy (2.1, 2.2.1–2.2.3), RBAC, scope e isolamento dei gruppi (2.3.1–2.3.3, 2.4), rate limit e registro delle attività (2.5, 2.6.1–2.6.5) (§8); validatore dell'input (1.5.1), modello utente, login, sessioni e profilo (3.1–3.3), liste a cursore e gestione degli utenti (1.5.2–1.5.3, 3.4) (§6).

Realizzate anche le fondamenta del backoffice (1.7, 1.8): progetto Angular 22.2, configurazione pubblica, accesso HTTP, lingua, design system, componenti condivisi, shell e server statico di produzione (§11).

## 2. Requisiti e avvio
- **Node.js** `>=24.20.0 <25` (TypeScript eseguito direttamente con il type stripping nativo, nessuna compilazione).
- Comandi, dalla cartella `backend/`:
  | Comando | Effetto |
  |---|---|
  | `npm ci` | installa le dipendenze dal `package-lock.json` |
  | `npm start` | avvia `node src/server.ts` |
  | `npm run typecheck` | `tsc --noEmit` |
  | `npm test` | suite `node:test` con coverage nativa e soglie al 100% (richiede il MongoDB locale, §9) |
  | `npm run profile:legacy -- [--env development\|production] [--out <file>]` | profilazione in sola lettura dei database legacy (§7) |
- **Avvio in locale:** copiare `.env.example` in `.env` (non versionato) e compilare i valori. `server.ts` carica `.env` con `process.loadEnvFile`; se il file non esiste prosegue con le sole variabili d'ambiente (altri errori di lettura bloccano l'avvio). Con `APP_ENV=production` la presenza di un `.env` blocca l'avvio: in produzione la configurazione arriva solo dal secret manager.
- **Hook di secret scanning:** `./scripts/install-git-hooks.sh` (una volta per clone) attiva `.githooks/pre-commit`, che blocca il commit se gitleaks trova segreti nei file in stage. Usa `gitleaks` se installato, altrimenti l'immagine ufficiale `ghcr.io/gitleaks/gitleaks:v8.30.1` fissata per digest (serve Docker attivo). Regole in `.gitleaks.toml`: quelle predefinite più URI MongoDB con credenziali e segreti `fc_*`; gli URI finti nei test usano host segnaposto (`host`, `h`, `localhost`, `127.0.0.1`, domini `.example`, `.invalid`, `.test`).
- **MongoDB locale** (sviluppo e test): `docker compose -f backend/compose.yaml up -d --wait` avvia un replica set a un nodo (necessario per le transazioni) su `127.0.0.1:27027`, senza autenticazione. Immagine di default `mongo:8.2.12` fissata per digest: la 8.0 non parte su Docker per Mac (kernel 6.19+, SERVER-121912); Atlas è su 8.0 e la CI usa `mongo:8.0.34` (variabile `FLOOD_CLOUD_MONGO_IMAGE`).
- **Dipendenze:** runtime `express@5.3.0`, `compression@1.8.2`, `mongodb@7.8.0`; sviluppo `typescript@7.0.2`, `@types/node@24.19.2`, `@types/express@5.0.6`, `@types/compression@1.8.1`. Il body JSON usa `express.json` (body-parser incluso in Express).

## 3. Configurazione
Lettura e validazione in `src/config.ts` (`loadConfig`, funzione pura). Tutti i problemi vengono raccolti e segnalati insieme con nome della variabile e motivo, **mai il valore**; con configurazione non valida il processo scrive l'elenco su stderr ed esce con codice 1. L'oggetto risultante è congelato. Gli interi accettano solo cifre decimali. Una variabile opzionale impostata a stringa vuota vale come non impostata (si usa il default); una obbligatoria vuota è un errore. `loadDatabaseConfig` valida solo le variabili del database (`APP_ENV`, `MONGODB_*`, `DB_NAME_PREFIX`) ed è usata dagli strumenti; `loadConfig` la compone con il resto.

| Variabile | Obbligatoria | Regola | Default |
|---|---|---|---|
| `APP_ENV` | sì | `development` \| `production` (D-16) | — |
| `PORT` | no | intero 1–65535 | `3000` |
| `MONGODB_URI` | sì in modalità a cluster singolo (vietata con `MONGODB_CLUSTERS`), segreto | inizia con `mongodb://` o `mongodb+srv://`. Con `APP_ENV=production` TLS obbligatorio: `mongodb+srv://` senza `tls`/`ssl` diversi da `true`, oppure `mongodb://` con `tls=true`; rifiutate `tlsInsecure`, `tlsAllowInvalidCertificates`, `tlsAllowInvalidHostnames`, `tlsDisableOCSPEndpointCheck`, `tlsDisableCertificateRevocationCheck` a `true` | — |
| `MONGODB_ANALYTICS_URI` | no, segreto | connessione analytics in modalità a cluster singolo (stesse regole); assente ⇒ secondo client sulla connessione principale con `secondaryPreferred` | — |
| `MONGODB_CLUSTERS` | no | elenco di id di cluster (`^[a-z][a-z0-9-]{0,31}$`, unici); assente ⇒ cluster singolo `cluster0` con `MONGODB_URI` | — |
| `MONGODB_URI_<ID>`, `MONGODB_ANALYTICS_URI_<ID>` | la prima sì per ogni cluster dell'elenco, segreti | connessioni di ogni cluster (id in maiuscolo, `-` → `_`), stesse regole di `MONGODB_URI` | — |
| `MONGODB_COMMON_CLUSTER` | no | cluster di login e dati comuni, tra quelli configurati | primo dell'elenco (`cluster0`) |
| `MONGODB_DEFAULT_GROUP_CLUSTER` | no | cluster dei gruppi senza `dataCluster` | cluster comune |
| `MONGODB_SERVER_SELECTION_TIMEOUT_MS` | no | intero 1000–60000 | `5000` |
| `MONGODB_MAX_POOL_SIZE` | no | intero 1–500 | `20` |
| `DB_NAME_PREFIX` | no | `^[A-Za-z0-9_-]{0,27}$` (i nomi di database MongoDB non superano 63 byte) | vuoto |
| `TRUST_PROXY` | no | intero 0–5, numero esatto di proxy davanti al server (il load balancer HTTP(S) esterno di Google ne aggiunge 2: da verificare in GKE) | `0` |
| `CORS_ALLOWED_ORIGINS` | no | origin esatte separate da virgola (`schema://host[:porta]`, senza path né porta di default esplicita); solo `https`, `http` ammesso per `localhost`/`127.0.0.1` con `APP_ENV=development` | vuoto (CORS chiuso) |
| `ACCESS_TOKEN_TTL_SECONDS` | no | intero > 0 | `900` |
| `REFRESH_IDLE_TTL_SECONDS` | no | intero > 0 | `604800` |
| `SESSION_MAX_TTL_SECONDS` | no | intero > 0, ≥ `REFRESH_IDLE_TTL_SECONDS` | `2592000` |
| `REQUEST_TIMEOUT_MS` | no | intero 1000–300000 | `30000` |
| `SHUTDOWN_DRAIN_MS` | no | intero 0–20000, attesa tra il segnale di arresto e la chiusura del server | `5000` |
| `RATE_LIMIT_LOGIN_PER_USERNAME` | no | intero 1–100000, tentativi di login al minuto per username | `5` |
| `RATE_LIMIT_LOGIN_PER_IP` | no | intero 1–100000, tentativi di login al minuto per IP | `15` |
| `RATE_LIMIT_REFRESH_PER_IP` | no | intero 1–100000, refresh al minuto per IP | `30` |
| `RATE_LIMIT_USERNAME_CHECK_PER_USER` | no | intero 1–100000, verifiche di disponibilità dello username al minuto per utente | `15` |
| `RATE_LIMIT_API_PER_USER` | no | intero 1–100000, richieste `/v1` al minuto per utente autenticato | `300` |
| `RATE_LIMIT_UNAUTHENTICATED_PER_IP` | no | intero 1–100000, autenticazioni fallite su `/v1` al minuto per IP | `300` |
| `ACTIVITY_LOG_RETENTION_DAYS` | no | intero 1–3650, conservazione delle voci `data` e `security` | `365` |
| `ACTIVITY_LOG_ERROR_RETENTION_DAYS` | no | intero 1–3650, conservazione delle voci `error` | `90` |
| `RATE_LIMIT_CLIENT_ERRORS_PER_USER` | no | intero 1–100000, errori JavaScript inviati al minuto per utente | `30` |
| `RATE_LIMIT_USER_CREDENTIALS_PER_USER` | no | intero 1–100000, creazioni di utenti e reset di password al minuto per amministratore | `20` |
| `REFRESH_REUSE_GRACE_SECONDS` | no | intero 0–300, finestra in cui un refresh appena ruotato che ricompare non chiude la sessione | `30` |
| `LEGACY_PASSWORD_PEPPER` | sì, segreto | non vuoto, senza spazi iniziali o finali (D-04) | — |
| `LEGACY_PASSWORD_COEXISTENCE` | no | `true` \| `false`: al cambio password si scrive anche l'hash legacy. Da spegnere solo al passaggio definitivo, e solo una volta (§8) | `true` |

I segreti sono avvolti nella classe `Secret` (`src/shared/security/secret.ts`): il valore si legge solo con `reveal()`; `toString`, `toJSON` e `util.inspect` restituiscono `[REDACTED]`. La chiave di decifratura dei dati personali legacy (D-05) non fa parte della configurazione dell'applicazione. `.env.example` elenca gli stessi nomi, senza valori.

## 4. Struttura del codice
Percorsi relativi a `backend/`:
```
src/
  server.ts                    # unico punto con process.env: .env, config, logger, http.Server, segnali
  app.ts                       # createApp(deps): app Express senza effetti collaterali
  config.ts                    # loadConfig, ConfigError, tipo Config
  db/
    client.ts                  # createMongoClient: opzioni del client, controllo TLS in produzione
    names.ts                   # unico punto che costruisce e interpreta i nomi dei database
    databases.ts               # createDatabases: unico accesso a un Db, guardia d'ambiente
    collections.ts             # registro della proprietà delle collection
    indexes.ts                 # ensureIndexes all'avvio
    ping.ts                    # controllo di readiness sul database common
  composition.ts               # composizione dei moduli del backoffice (servizi, repository, authenticate)
  modules/
    health/health.routes.ts
    users/                     # modello utente (mapper legacy ↔ dominio, repository) e gestione degli utenti (route, service, regole di accesso)
    auth/                      # login, refresh, logout, middleware Bearer, stato dell'account
    sessions/                  # repository e audit delle sessioni
    me/                        # profilo, cambio password, proprie sessioni
    reference/                 # letture compatte di gruppi, aziende e punti vendita per i selettori
    dealers/                   # anagrafica dei dealer (solo PSA)
    activity-log/              # monitor del registro delle attività (GET /v1/activity-log)
    client-errors/             # ricezione degli errori JavaScript del backoffice
  tools/migrate-dealers/       # registrazione dei dealer esistenti (npm run migrate:dealers)
  tools/profile-legacy/        # CLI di profilazione in sola lettura (cli.ts → main.ts → profile.ts e analisi)
  shared/
    http/
      errors.ts                # AppError e tabella codice → status
      envelope.ts              # sendData, sendPage
      error-handler.ts         # gestore centrale degli errori
      routes.ts                # defineRoute, mountRoutes (auth obbligatoria, 405, parser per route)
      request-id.ts            # X-Request-Id generato dal server
      security-headers.ts      # header di sicurezza
      cors.ts                  # CORS in allowlist per /v1
      compression.ts           # compression con soglia
      access-log.ts            # log di accesso
      client-error.ts          # risposte agli errori di protocollo di Node (clientError)
      error-activity.ts        # errori 5xx nel registro delle attività
      express-locals.d.ts      # tipi di res.locals
    logging/logger.ts          # logger JSON con redazione
    activity-log/              # registro delle attività: catalogo, servizio, cambi prima/dopo, accessi trasversali
    validation/                # validatore per allowlist e middleware validateBody/Query/Params
    http/list.ts               # parametri di lista e paginazione a cursore
    security/
      rate-limit/              # contatori, middleware e regole di rate limit (anche cambio password per utente)
      username.ts              # normalizzazione dello username
      client-ip.ts             # chiave IP per i limiti (IPv4, IPv6 /64)
      secret.ts                # Secret
      secrets.ts               # segreti fc_at_/fc_rt_/fc_pk_: generazione, parse, hash
      compare.ts               # confronto a tempo costante
      scrypt.ts                # hash e verifica scrypt, rehash, verifica fittizia
      password-policy.ts       # policy delle password nuove (D-19)
      legacy-password.ts       # hash HMAC-SHA512 del legacy e sua impronta
      password-verifier.ts     # verifica con coesistenza legacy/scrypt
      password-change.ts       # dati da scrivere al cambio password
      frozen.ts                # insiemi e array immutabili
      rbac/                    # catalogo dei permessi, tetti per ruolo, matrice utente, requirePermission, anti-escalation
      scope/                   # principal, scope, filtri di scope, gruppo nel percorso, repository di gruppi e punti vendita
test/
  unit/  integration/  helpers/   # helpers: app.ts (HTTP), mongo.ts (database usa e getta), legacy-fixtures.ts
compose.yaml                      # MongoDB locale per sviluppo e test
```

## 5. Pipeline delle richieste
Ordine reale in `createApp`:
1. **Request id**: `crypto.randomUUID()` generato **sempre** dal server, restituito in `X-Request-Id` e presente in `res.locals.requestId`. Un `X-Request-Id` del client conforme a `^[A-Za-z0-9._:-]{8,128}$` viene solo registrato come `clientRequestId` nel log di accesso.
2. **Log di accesso**: un record `info` a fine risposta con `requestId`, `clientRequestId`, metodo, percorso **senza query string**, status, durata, IP; un solo record con `aborted: true` se la connessione si chiude prima. Mai body, query o header. Le richieste a `/health` con esito 2xx non si registrano.
3. **Header di sicurezza** su ogni risposta, errori compresi (§8).
4. **Compressione** (`compression`, soglia 1024 byte).
5. **`/health`**: endpoint di salute (§6).
6. **`/v1`**: CORS in allowlist (§8), poi le route della superficie backoffice (nessuna in questo passo).
7. **`/public/v1`**: route della superficie pubblica, senza CORS (nessuna in questo passo).
8. **404** `NOT_FOUND` per ogni percorso non registrato.
9. **Gestore centrale degli errori**.

La superficie `/store/v1` non esiste (D-23).

**Builder delle route** (`shared/http/routes.ts`): ogni route si dichiara con `defineRoute({ method, path, auth, bodyLimit?, handler })`. `mountRoutes` valida tutte le route all'avvio e **lancia** se `auth` manca o è sconosciuto, se una route anonima non ha un motivo, se il metodo non è ammesso (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`) o se due route coincidono (confronto dopo normalizzazione: minuscole, senza `/` finale, parametri equivalenti). Tipi di `auth`: `{ kind: 'anonymous', reason }` e `{ kind: 'user', permission, group? }`. Ogni superficie dichiara i tipi ammessi (`allowedAuth`): le route `user` sono ammesse solo su `/v1`; `/health` e `/public/v1` le rifiutano all'avvio. Una route `user` richiede un permesso del catalogo e un `authenticate` iniettato (oggi solo nei test: quello reale arriva con l'area 3), altrimenti l'avvio fallisce. `group: true` è obbligatorio se e solo se il percorso contiene `:groupId`; un segmento `/groups/:<nome>` con un nome diverso da `groupId` blocca l'avvio. Catena di una route `user`: `authenticate` → controllo del gruppo (`requireGroupAccess`) → `requirePermission` (401 senza contesto, 403 senza permesso) → controllo del content type e parser → handler. Per ogni percorso i metodi non dichiarati rispondono `405 METHOD_NOT_ALLOWED` con header `Allow` (`GET` implica `HEAD`).

**Body**: solo le route `POST`, `PUT`, `PATCH` hanno un parser, creato per route con `express.json({ limit, strict: true, inflate: false })`; limite di default `100kb`, modificabile per route. Con un body presente il content type deve essere `application/json` con charset assente o `utf-8`, altrimenti `415`; un `Content-Encoding` diverso da identity dà `415`. Un body con `Content-Length: 0` è ammesso e lascia `req.body` indefinito: la validazione delle route deve gestirlo.

**Gestore centrale** (`shared/http/error-handler.ts`), risposta sempre `{ error: { code, message, details? } }` senza stack né messaggi interni:
| Errore | Risposta | Log |
|---|---|---|
| `AppError` | status e header del codice | — |
| JSON non valido (`entity.parse.failed`) | `400 MALFORMED_JSON` | — |
| `request.size.invalid`, `URIError` (percorso malformato), altri 400 esposti | `400 BAD_REQUEST` | — |
| body oltre il limite | `413 PAYLOAD_TOO_LARGE` | — |
| charset o encoding non supportati | `415 UNSUPPORTED_MEDIA_TYPE` | — |
| richiesta interrotta dal client (`request.aborted`) | nessuna (socket chiuso) | `debug` |
| altri errori 4xx esposti | `500 INTERNAL_ERROR` | `warn` |
| qualsiasi altro errore | `500 INTERNAL_ERROR` | `error` con stack |
| errore dopo l'invio degli header | socket chiuso | `error` |
| errore dentro il gestore stesso | `500` JSON scritto a mano | `error` |

L'app imposta sempre `env = production`, così il gestore predefinito di Express non mostra mai lo stack.

**Errori di protocollo di Node** (`clientError`, `shared/http/client-error.ts`): risposta minima JSON `BAD_REQUEST` con status 400, 408 (timeout della richiesta) o 431 (header troppo grandi), header di sicurezza e `Connection: close`; `ECONNRESET` o socket non scrivibile: sola chiusura.

**Avvio** (`server.ts`): configurazione → logger → client MongoDB e `connect()` → `ensureIndexes` → app con il controllo di readiness sul database → `listen`. Un errore di creazione o connessione del client o degli indici produce il log `database startup failed` con il solo nome dell'errore (mai URI né host) e l'uscita con codice 1.

**Server HTTP** (`server.ts`): `http.createServer(app)` con `requestTimeout = REQUEST_TIMEOUT_MS`, `headersTimeout = min(60 s, requestTimeout − 1)`, `keepAliveTimeout = 620 s` (oltre i 600 s di keep-alive del load balancer di Google). `trust proxy` = `TRUST_PROXY` (0 ⇒ disattivato); `X-Powered-By` ed `ETag` disattivati.

**Arresto ordinato**: su `SIGTERM`/`SIGINT` la readiness passa subito a `503`, dopo `SHUTDOWN_DRAIN_MS` il server chiude (`close()` e `closeIdleConnections()`), poi si chiude il client MongoDB (un errore di chiusura porta all'uscita con codice 1); uscita forzata 25 s dopo il segnale. Un secondo segnale viene ignorato e registrato. `unhandledRejection`, `uncaughtException` e un errore di `listen` producono un log `error` e l'uscita con codice 1.

## 6. Moduli
### health
Endpoint di salute per GKE, fuori dalle superfici API, dichiarati anonimi nel builder (sonde dell'orchestratore). Riferimento in `doc/API.md`.
- `GET /health/live`: sempre `200` se il processo risponde.
- `GET /health/ready`: `200` se il server non è in arresto e tutti i controlli di prontezza riescono entro 2 s ciascuno; altrimenti `503 SERVICE_UNAVAILABLE` senza dettagli (il motivo va nel log `warn`). Controllo attivo: `ping` sul database common.

### users, auth, sessions, me (passo 3A)
Riferimento delle route in `doc/API.md`.
- **Validatore** (`shared/validation/`): schemi componibili per allowlist (`string`, `personName`, `integer`, `boolean`, `enumOf`, `objectId`, `isoDate`, `email`, `phone`, `nullable`, `optional`, `object`, `array`) con tipi derivati (`Infer`). Rifiuta proprietà sconosciute, chiavi `$…`, con `.`, `__proto__`/`constructor`/`prototype`, profondità oltre 8, Unicode non valido; lunghezze sempre limitate; i nomi rifiutano caratteri di controllo e override bidi. Errori `422 VALIDATION_ERROR` con `details` `{ field, issue }` (massimo 50, mai il valore ricevuto). Middleware `validateBody`, `validateQuery`, `validateParams`; valori in `res.locals.input`.
- **Modello utente** (`modules/users/`): `fromLegacy` traduce il documento legacy nel dominio con raccolta delle anomalie (ruolo non valido, stato non booleano, username mancante, dati cifrati, riferimenti non validi, scope mancante); `toLegacyUpdate` produce solo `$set`/`$unset` dei campi posseduti (mai `apps`, mai ruolo `API`); `updateOwned` rifiuta operatori diversi e campi non posseduti; `toResponse` è un'allowlist senza segreti. Ricerca per il login: corrispondenza esatta su `userName`, altrimenti ricerca senza maiuscole (regex ancorata ed escapata) accettata solo se c'è un solo utente con lo stesso username normalizzato.
- **Login** (`POST /v1/auth/login`): limiti di input (1–1024 unità, body 4 KB) prima di ogni hash; ricerca utente; account bloccato, password errata, utente inesistente, disattivato, cestinato, ruolo E o non valido, SA/CA/PA senza gruppo o con gruppo sospeso o cestinato ⇒ sempre `401 INVALID_CREDENTIALS` con una sola scrypt (la riscrittura dell'hash avviene solo dopo il controllo dello stato). Blocco progressivo in `userCredentials`. Eventi `auth.loginSucceeded`/`auth.loginFailed` con il motivo nei metadata, mai lo username.
- **Sessioni**: access token `fc_at_` (15 minuti) e refresh `fc_rt_` (7 giorni di inattività, 30 giorni di durata massima della famiglia) nel body della risposta, mai compresso; a riposo solo SHA-256. Refresh con rotazione atomica; un refresh già ruotato che ricompare entro `REFRESH_REUSE_GRACE_SECONDS` (30 s) riceve 401 senza token e senza chiudere la sessione (`auth.refreshRaceTolerated`), oltre o se più vecchio la famiglia viene revocata (`auth.refreshReuseDetected`, registrato solo se la revoca è avvenuta). Logout della sessione corrente e da tutti i dispositivi (svuota anche `tokens` legacy).
- **Middleware Bearer** (`modules/auth/authenticate.ts`): `Authorization: Bearer fc_at_…`; formato errato, sconosciuto o revocato ⇒ `UNAUTHENTICATED`; scaduto ⇒ `TOKEN_EXPIRED`; a ogni richiesta rilegge utente e gruppo (disattivazione o sospensione ⇒ revoca e 401 immediato) e ricostruisce principal e scope; `lastUsedAt` al massimo una volta al minuto. Il backoffice deve fare il refresh solo su `TOKEN_EXPIRED`.
- **Profilo** (`/v1/me`): profilo con permessi effettivi, `canManagePermissions`, riepilogo dello scope (per i dealer al massimo 100 id più il totale) e gruppo `{ id, name }` per SA, CA, PA; mai segreti. Modifica di nome, cognome, email, telefono, lingua (`user.updated` con prima/dopo). Cambio password: password attuale (errata ⇒ `422` `currentPassword`/`incorrect` ed evento `auth.passwordCheckFailed`), policy D-19, scrypt più hash legacy con coesistenza attiva (rimosso con coesistenza spenta), revoca delle altre sessioni, `tokens` legacy svuotati; rate limit per utente con la soglia del login. Elenco e revoca delle proprie sessioni (`404` su sessioni altrui). Permessi `profile:read`, `profile:update` e `sessions:*`, sempre concessi a PSA–PA.

### Gestione utenti (passo 3B)
Riferimento delle route in `doc/API.md`.
- **Liste** (`shared/http/list.ts`): `limit` 1–200 (default 50), `cursor` opaco (base64url di versione, ordinamento, valore e `_id`; validato e lungo al massimo 2200 caratteri), `sort` in allowlist per risorsa, `q` fino a 64 caratteri con escape della regex sui campi ammessi. La lista è una pipeline di aggregazione: filtro di scope e filtri (sempre con `withScope`), chiave di ordinamento calcolata (`__sortKey`: il valore se ha il tipo atteso, altrimenti null, così valori legacy anomali non ripetono pagine), spareggio su `_id`, `limit + 1`. `maxTimeMS` su ogni query, nessun conteggio totale.
- **Utenti di gruppo** (`/v1/groups/{groupId}/users`) e **di piattaforma** (`/v1/users`, utenti PSA e D gestiti solo dal PSA; elenco trasversale per PSA e dealer): elenco con filtri (ruolo, stato, cestino; gruppo e dealer solo per il PSA) e ordinamenti, dettaglio (`404` identico fuori perimetro), creazione, modifica (JSON Merge Patch), reset della password, cestino e ripristino, eliminazione definitiva, disponibilità dello username.
- **Regole** (`users/user-access.ts`, `rbac/user-management.ts`): ruolo gestibile e perimetro (`canManageUser`), anti-escalation sullo stato prima e dopo (`checkUserChange`), nessuna auto-modifica (per sé stessi si usa `/v1/me`); per qualunque modifica, reset, cestino ed eliminazione l'attore deve avere almeno tutti i permessi del bersaglio (`holdsEverythingOf`, decisione dell'utente del 2026-11-05: un pari con meno permessi non può toccare un pari più forte). Scope obbligatorio per ruolo (D-08) con aziende e punti vendita esistenti, non cestinati e nel perimetro dell'attore: inesistente, fuori perimetro, cestinato o di altro gruppo danno lo stesso `422` `companyIds.N`/`placeIds.N` `incorrect`. `dealerId` calcolato dal server. Username nuovi o cambiati solo ASCII (`A-Z a-z 0-9 . _ @ + -`, 3–64), unici globalmente senza distinzione di maiuscole (`409` `username`/`taken`); la policy della password si controlla prima dell'unicità.
- **Scritture**: documento legacy completo dei soli campi posseduti (mai `role: 'API'`), in transazione con `userCredentials` (creazione), revoca delle sessioni e `tokens` legacy svuotati (cambio di ruolo, scope, stato, permessi, cestino, reset), eliminazione definitiva solo di un utente nel cestino (`deleteOne` condizionato) insieme a credenziali e sessioni. Un dealer ancora assegnato a gruppi non si elimina (`409`). Eventi `user.created`, `user.updated` (prima/dopo, password oscurata), `user.trashed`, `user.restored`, `user.deleted` (senza dati personali) ed eventi di sicurezza su ruolo, scope, stato e permessi.
- **Password provvisoria** (decisione dell'utente del 2026-11-05): creazione e reset impostano una password secondo D-19 con `mustChangePassword` (per tutti i ruoli); il reset azzera anche il blocco del login. Il login e `GET /v1/me` riportano `passwordChangeRequired`; finché è vero il builder, dopo i rate limit, ammette solo le route dichiarate `allowWithPendingPasswordChange` (`GET /v1/me`, `PUT /v1/me/password`, logout, logout-all) e risponde `403 PASSWORD_CHANGE_REQUIRED` alle altre. La nuova password non può coincidere con l'attuale (`422` `newPassword`/`reused`). Limite noto: con la coesistenza attiva la password provvisoria vale anche nel legacy senza obbligo di cambio.
- **Transazioni**: `Databases.transaction` sul common (replica set).
- **Rate limit dedicati**: creazioni e reset 20 al minuto per amministratore (`RATE_LIMIT_USER_CREDENTIALS_PER_USER`, ogni operazione costa uno scrypt); disponibilità dello username 15 al minuto per utente.

### activity-log e client-errors (passo 2D)
Riferimento in `doc/API.md`.
- **Monitor** (`GET /v1/activity-log`, `activityLog:read`): lista a cursore ordinata per data decrescente (spareggio `_id`), filtri per categoria, azione, esito, attore, gruppo (PSA e dealer), request id e periodo (massimo 400 giorni). Perimetro (decisione dell'utente del 2026-11-05): PSA tutto; dealer le voci dei propri gruppi attivi; SA quelle del proprio gruppo; CA e PA solo le proprie azioni. La categoria `error` (e le sue azioni) è visibile solo al PSA: chiederla da un altro ruolo dà `403`. Per gli attori di ruolo superiore a chi guarda si restituiscono solo il ruolo (id, username e IP nulli). Username risolti in blocco per la pagina; indici con `at` e `_id` e hint sull'indice di perimetro, così l'ordinamento non avviene in memoria.
- **Errori JavaScript** (`POST /v1/client-errors`, permesso `clientErrors:create` sempre concesso a PSA–PA, ammesso anche con password provvisoria pendente): risposta `202`; voce `error`/`client.error` con nome, messaggio (300 caratteri), prime 10 righe dello stack (300 caratteri ciascuna, la prima ricostruita col messaggio troncato), route come pattern (`/groups/:groupId/users`: rifiutati id, cifre, query), versione dell'app e browser abbreviato, tutto redatto. Limiti: 30 al minuto per utente, lo stesso errore dello stesso utente salvato al massimo una volta ogni 10 minuti, 100 voci al minuto per processo; il resto solo su stdout. La scrittura non fa mai fallire la risposta.

### dealers (passo 4A)
Anagrafica dei dealer (D-09, decisione dell'utente del 2026-11-06). Riferimento in `doc/API.md`, collection in `doc/Data-Model.md`.
- Route solo per il PSA: elenco, dettaglio, creazione e modifica dei dati anagrafici. Permessi `dealers:read`, `dealers:create`, `dealers:update` nel solo tetto del PSA, concessi dai flag `groups.r`/`groups.w` della sua matrice. La regola anti-escalation conta solo i permessi che il ruolo dell'attore può avere, così D e SA continuano a concedere `groups.r`/`groups.w` senza poter concedere `dealers:*`.
- `POST /v1/dealers` crea in transazione l'utente D (stesse regole degli utenti di piattaforma, password provvisoria) e l'anagrafica con lo stesso `_id`. `POST /v1/users` con ruolo D crea anche un'anagrafica minima; l'eliminazione definitiva di un D (solo dal cestino, `409` se ha gruppi) la elimina. Il ruolo D non si assegna né si toglie con una modifica (`422` `role`/`immutable`). P.IVA univoca (`409`). Eventi `dealer.created`, `dealer.updated`, `dealer.deleted` con prima/dopo.
- `GET /v1/me` per un D include `dealer: { id, businessName }`.
- **Script** `npm run migrate:dealers -- --env <development|production> [--apply]`: per default solo conteggi senza scritture; con `--apply` crea con `$setOnInsert` (idempotente) un'anagrafica per ogni utente D che non ne ha una, con ragione sociale uguale allo username. Scrive solo su `dealers`, apre solo il cluster comune, `--env` deve coincidere con `APP_ENV`, l'output contiene solo conteggi.

### reference (passo 3D)
Letture compatte per i selettori del backoffice (decisione dell'utente del 2026-11-05), estese poi dalle aree 4, 6 e 7. Riferimento in `doc/API.md`.
- `GET /v1/groups` (`groups:read`): PSA tutti i gruppi con filtri `status` e `trashed`; D i propri gruppi attivi e non cestinati; SA il proprio; per chi non è PSA i filtri `status` e `trashed=true` danno 403 e il filtro aggiunge sempre `status: true` e non cestinato.
- `GET /v1/groups/{groupId}/companies` (`companies:read`) e `GET /v1/groups/{groupId}/places` (`places:read`, filtro `companyId`): nel perimetro (`withScope` con i filtri di scope), non cestinati per default.
- Liste a cursore standard con ricerca sul nome; proiezioni e mapper in allowlist (`id`, `name`, `status`, `trashed`, `companyId`): apiKey del gruppo, integrazioni e credenziali dei punti vendita non vengono mai lette.

## 7. Database
**Cluster condiviso con il legacy** (`doc/Tasks.md` §0.1–0.2): stesse credenziali Atlas (D-02), stessi database. Il backend scrive solo nelle collection nuove e, su `users`, nei soli campi posseduti.

**Più cluster** (`db/clusters.ts`, decisione dell'utente del 2026-11-06, `doc/Architecture.md` §3.2.1): per ogni cluster configurato un client di lettura/scrittura e uno analytics (sola lettura: `readPreference: secondary` verso la connessione dedicata, oppure `secondaryPreferred` sulla principale se manca). All'avvio il cluster comune deve collegarsi (altrimenti uscita con codice 1); gli altri si collegano in background con errori loggati col solo id. La readiness controlla solo il cluster comune. Il database di un gruppo si apre sul cluster indicato da `groups.dataCluster` (assente ⇒ cluster di default; non configurato ⇒ `503` con log `error`, mai ripiego); `requireGroupAccess` legge `dataCluster` insieme allo stato e il `GroupAccess` verificato porta il cluster. Accessi analytics (`analyticsCommon`, `analyticsGroup`) di sola lettura per i futuri report: espongono solo letture, rifiutano aggregazioni con `$out` o `$merge` e non danno accesso al client sottostante. Come difesa in profondità le connessioni analytics vanno configurate con un utente MongoDB con il solo ruolo `read`. Transazioni solo sul cluster comune.

**Client** (`db/client.ts`): opzioni di ogni `MongoClient`, creato in `server.ts`: `appName: flood-cloud-backend`, `retryWrites`, `w: majority`, `readPreference: primary`, `serverSelectionTimeoutMS` e `connectTimeoutMS` = `MONGODB_SERVER_SELECTION_TIMEOUT_MS`, `maxPoolSize` = `MONGODB_MAX_POOL_SIZE`. In produzione, dopo la costruzione, si verifica che TLS sia attivo e senza opzioni insicure.

**Nomi** (`db/names.ts`): common `<DB_NAME_PREFIX><APP_ENV>_common`; gruppo `<DB_NAME_PREFIX><APP_ENV>_<groupId>` con `groupId` ObjectId o 24 caratteri esadecimali minuscoli; `parseGroupDatabaseName` ricava il `groupId` dal nome (D-20).

**Guardia d'ambiente** (`db/databases.ts`): `createDatabases(client, { prefix, appEnv })` è l'unico modo di ottenere un `Db` (`common()`, `group(groupId)`), più `listGroupIds()`, `countOtherDatabases()` e `serverVersion()` per la profilazione. Ogni nome deve corrispondere a `^<prefix><APP_ENV>_(common|[0-9a-f]{24})$` e non superare 63 byte: con `APP_ENV=development` un database `production_*` non è raggiungibile. Un test vieta in tutto `src/` fuori da `src/db/` `.db(`, `new Db(`, `['db']`, `.admin(`, `.client.`, `$out`, `$merge`, `renameCollection`; `createDatabases(` è ammesso solo in `server.ts` e nei `main` degli strumenti.

**Registro delle collection** (`db/collections.ts`):
| Database | Collection | Proprietà |
|---|---|---|
| common | `users`, `groups`, `countries` | legacy, sola lettura |
| common | `users` | legacy, scrivibile solo nei campi posseduti (passo 3A) |
| common | `rateLimits`, `activityLog`, `userCredentials`, `sessions` | nuove (indici e validazione `$jsonSchema` dove prevista) |
| gruppo | `companies`, `places` | legacy, sola lettura |
Proprietà possibili: `new` (collection del nuovo backend), `legacy-read`, `legacy-write` (con elenco obbligatorio dei campi posseduti). Sulle collection legacy sono vietati indici univoci e TTL. Un test vieta in `src/` nomi di collection non letterali o non registrati.

**Indici** (`db/indexes.ts`): `ensureIndexes` crea all'avvio, in modo idempotente e con nomi espliciti, gli indici del registro sul database common; rifiuta un registro non valido o indici dichiarati su collection dei gruppi. Crea anche le collection nuove con il loro validatore (`createCollection`); su una collection esistente il validatore si riapplica con `collMod` solo se è cambiato. L'utente Atlas condiviso con il legacy (`readWriteAnyDatabase`) non ha il privilegio `collMod`: in quel caso l'avvio prosegue con un log `error` che segnala il validatore non aggiornato (la validazione nel codice resta attiva); per aggiornarlo serve dare all'utente il ruolo `dbAdmin` sul database common; il validatore è vietato sulle collection legacy. Indici creati: `rateLimits` TTL su `expiresAt`; `activityLog` `groupId+at`, `actor.id+at`, `category+at`, `requestId`, TTL su `expiresAt`. Prima del primo rilascio va verificato che nel common legacy non esistano già `rateLimits` o `activityLog`.

**Profilazione del legacy** (`tools/profile-legacy/`, Tasks 1.3.6):
- uso: `npm run profile:legacy -- [--env development|production] [--out <file>]`. Senza `--env` vale `development`; `--env` deve coincidere con `APP_ENV` (per la produzione, senza toccare `.env`: `APP_ENV=production npm run profile:legacy -- --env production`). La produzione è ammessa per decisione dell'utente del 2026-11-01, sempre in sola lettura. Legge solo la configurazione del database (`loadDatabaseConfig`), non i segreti dell'applicazione;
- su stderr: ambiente, numero di database dei gruppi trovati e avanzamento ogni 50 (solo numeri); legge con `readPreference: secondaryPreferred`, a cursore (`batchSize`), con `maxTimeMS` su ogni operazione e un database di gruppo alla volta;
- solo letture (`find`, `aggregate` senza `$out`/`$merge`, `countDocuments`, `listIndexes`, `listDatabases`, `buildInfo`), verificato da un test sui sorgenti;
- report JSON (default `backend/reports/legacy-profile-<env>-<timestamp>.json`, cartella ignorata da git; dentro il repository sono ammessi solo percorsi in `backend/reports/`; il file non viene sovrascritto ed è creato con permessi 0600) con: versione del server, conteggi dei database, inventario dei campi e dei tipi di `users`, `groups`, `countries`, `companies`, `places`, enum in allowlist, forma di password, PIN, dati personali e apiKey (in chiaro o cifrati col formato legacy), duplicati di `userName`, `email`, `telephone`, `companies.code`, tipi e orfani dei riferimenti, `groupId` dei documenti diverso dal database, coerenza ruolo/scope, `tokens[]`, indici esistenti;
- il report non contiene mai valori, `_id`, nomi dei database dei gruppi o URI: chiavi di mappa che sembrano identificativi o dati personali diventano `<key>`, percorsi ed enum presenti in meno di 3 documenti sono solo contati. Gli errori stampano solo il nome (e il codice) dell'errore. I documenti interi transitano in memoria sul computer che esegue lo strumento per essere classificati.

## 8. Sicurezza implementata
- **Header** su ogni risposta: `Strict-Transport-Security: max-age=63072000; includeSubDomains`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, `Cross-Origin-Resource-Policy: same-origin`, `Cache-Control: no-store`; niente `X-Powered-By`.
- **CORS** solo su `/v1`, middleware proprio: origin confrontata in modo esatto con `CORS_ALLOWED_ORIGINS`; se ammessa `Access-Control-Allow-Origin: <origin>` ed `Access-Control-Expose-Headers` (`X-Request-Id`, `Location`, `ETag`, `RateLimit-*`, `Retry-After`); preflight ammesso ⇒ `204` con metodi `GET, POST, PUT, PATCH, DELETE`, header `Authorization, Content-Type, Idempotency-Key, If-Match, If-None-Match, X-Request-Id`, `Max-Age: 600`. `Vary: Origin` sempre su `/v1`. Nessun `Access-Control-Allow-Credentials` (dipende da D-12). Origin non ammessa: nessun header CORS. `/public/v1` e `/health` non hanno mai header CORS.
- **Deny by default**: una route senza dichiarazione di autenticazione blocca l'avvio.
- **RBAC** (`security/rbac/`, D-06, D-07):
  - catalogo `risorsa:azione`: `groups` (read, create, update, suspend, trash), `companies`, `places`, `users` (read, create, update, trash), `activityLog:read`, `sessions` propri (read, revoke);
  - tetto per ruolo: PSA tutto; D e SA come PSA senza `groups:suspend`, `groups:trash` (e SA senza `groups:create`); CA `companies` read e update, `places` e `users` completi; PA `places` read e update, `users` completi; tutti `activityLog:read` e le proprie sessioni; E nessun permesso (niente backoffice). Sospendere, cestinare e ripristinare un gruppo è solo del PSA;
  - matrice dell'utente dal legacy `permissions.<modulo>.{r,w}` (`r` → read, `w` → tutte le scritture del modulo; `logs.r` → `activityLog:read`), letta per allowlist senza eseguire getter; modulo assente o non booleano = nessun permesso; i moduli non core si conservano ma non danno permessi. Permessi effettivi = tetto ∩ matrice; un ruolo non valido non ha permessi. `permissions.status` è l'interruttore "gestisce i permessi altrui" (`canManagePermissions`), ora imposto dal server;
  - matrice di default per ruolo (dal legacy) per chi crea utenti senza `canManagePermissions`, limitata ai flag del creatore;
  - tetti, ruoli gestibili e permessi sono immutabili (`frozen.ts`).
- **Scope** (`security/scope/`, D-08, D-10): calcolato dal server per ruolo: PSA `platform`; D i gruppi attivi e non cestinati con `dealerId` uguale al proprio `_id` (ObjectId); SA il proprio gruppo; CA le proprie aziende e i punti vendita di quelle aziende (letti dal database del gruppo, cestinati compresi); PA i propri punti vendita (`placeId` ∪ `placesId`); E e utenti senza gruppo nessuno. CA senza aziende o PA senza punti vendita hanno scope vuoto e l'anomalia viene segnalata. Oltre 10.000 gruppi o 20.000 punti vendita il calcolo si blocca invece di troncare.
- **Filtri di scope** sulle collection legacy, combinati sempre con `withScope` (`$and`): `users` limitati anche ai ruoli gestibili (un SA non vede PSA né D); per il CA, i CA delle sue aziende e i PA/E dei suoi punti vendita (il `companyId` legacy di PA ed E è ignorato); `companies` per il CA le sue aziende, nessuna per il PA; `places` per il CA quelli delle sue aziende, per il PA i suoi.
- **Gruppo nel percorso** (`/v1/groups/:groupId/...`, D-10): `:groupId` di 24 caratteri esadecimali minuscoli; gruppo inesistente o fuori perimetro → 404 identico; gruppi sospesi o cestinati raggiungibili solo dal PSA. Il database del gruppo si apre solo da un accesso verificato (`groupDatabaseFor`), con un'unica altra eccezione documentata: il calcolo dei punti vendita del CA, che usa il `groupId` del documento utente. Per PSA e D l'accesso è "trasversale": dopo il controllo del permesso viene notificato con l'esito a un callback (oggi senza destinazione: lo collegherà il registro delle attività, passo 2C); un errore del callback fa fallire la richiesta.
- **Anti-escalation** (`rbac/user-management.ts`): ruoli gestibili PSA → tutti; D → SA, CA, PA, E; SA → SA, CA, PA, E; CA → CA, PA, E; PA → PA, E; bersaglio dentro il perimetro (CA: aziende del bersaglio ⊆ proprie; PA ed E: punti vendita del bersaglio ⊆ propri e senza riferimenti orfani). Nessuno modifica il proprio ruolo, perimetro, permessi o stato; ogni flag concesso deve essere posseduto; cambiare la matrice salvata (anche moduli non core e `status`) richiede `canManagePermissions`. Vincolo per l'area 3: la matrice si scrive solo con `$set` puntuali di `permissions.<modulo>.r|w` e `permissions.status`, conservando `apps.cash.*`; `/v1` rifiuta modifiche ad `apps`.
- **Log** (`shared/logging/logger.ts`): una riga JSON per evento (`time`, `level` tra `debug|info|warn|error`, `msg`, campi extra non in grado di sovrascrivere i tre precedenti). Redazione profonda:
  - chiavi normalizzate (minuscole, solo lettere e cifre) uguali a `pin`, `name`, `email`, `telephone`, `phone`, `surname`, `firstname`, `lastname`, `fiscalcode`, `mongodburi` o contenenti `password`, `passcode`, `secret`, `token`, `apikey`, `pepper`, `authorization`, `cookie`, `privatekey`, `credential`, `signature`;
  - valori dopo un nome sensibile negli array `rawHeaders`;
  - stringhe (anche `msg`, message e stack degli errori) con `fc_at_`, `fc_rt_`, `fc_pk_`, `mongodb://`, `mongodb+srv://`, e il dettaglio `dup key: {…}`;
  - istanze `Secret`;
  - errori MongoDB (`Mongo*`) ridotti a `{ name, code, codeName }`;
  - profondità massima 10 (`[Truncated]`), getter che falliscono (`[Unreadable]`), cicli, chiave `__proto__` conservata come campo.
- **Database**: guardia d'ambiente sui nomi dei database, TLS obbligatorio in produzione, nessuna scrittura (§7).
- **Segreti emessi dal server** (`secrets.ts`): prefisso (`fc_at_` access, `fc_rt_` refresh, `fc_pk_` API key pubblica) più 32 byte casuali in base64url; a riposo solo SHA-256 in hex. Nessun prefisso per la superficie store (D-23). Ogni confronto di segreti usa `safeEqual` (SHA-256 dei due valori e `timingSafeEqual`).
- **scrypt** (`scrypt.ts`): `N=2^16`, `r=8`, `p=2`, salt 16 byte, chiave 32 byte, formato `scrypt$N$r$p$salt$hash` (base64url); circa 250 ms per hash su un portatile. Le password si normalizzano in NFC. Un record con parametri diversi dai correnti va riscritto (`needsRehash`). I record malformati o fuori limite (N non potenza di 2, `N·r·p` > 2^22, memoria > 128 MiB, parametri rifiutati da OpenSSL) danno `false` senza eccezioni, sempre dopo uno scrypt fittizio.
- **Policy delle password nuove** (D-19, `password-policy.ts`): da 12 a 128 code point dopo NFC, nessuna regola sulle classi, diversa dallo username (confronto senza maiuscole e spazi), nessun carattere Unicode non valido (`invalidCharacters`). Le password legacy esistenti restano valide al login anche fuori policy.
- **Password legacy** (D-04, `legacy-password.ts`): HMAC-SHA512 con chiave `LEGACY_PASSWORD_PEPPER`, password senza normalizzazione (deve coincidere byte per byte con il legacy), hex minuscolo di 128 caratteri. L'impronta di un hash legacy è il suo SHA-256.
- **Verifica con coesistenza** (`password-verifier.ts`, solo logica: la persistenza arriva con `userCredentials` in area 3):
  - nessuna credenziale nuova: decide l'hash legacy; se è giusta si produce lo scrypt con l'impronta dell'hash legacy da salvare;
  - credenziale con impronta uguale a quella dell'hash legacy attuale, o hash legacy assente: decide scrypt (con eventuale rehash);
  - impronta diversa: la password è stata cambiata dal legacy, decide l'hash legacy e si ricalcola scrypt;
  - impronta nulla (cambio password con coesistenza spenta): decide solo scrypt, il vecchio hash legacy non vale più. Per questo la coesistenza si spegne una sola volta, al passaggio definitivo: riaccendendola, i cambi password fatti dal legacy verrebbero ignorati per chi ha impronta nulla.
  - Ogni fallimento costa uno scrypt (anche quando decide l'hash legacy o manca ogni hash) e un utente inesistente si verifica con `verifyDummyPassword`, il cui hash fittizio è precalcolato all'avvio: i tempi di risposta non rivelano se un utente esiste.
- **Cambio password** (`password-change.ts`): policy, poi scrypt più, se `LEGACY_PASSWORD_COEXISTENCE=true`, l'hash legacy e la sua impronta.
- **Limiti del login** (applicati nel passo 3A): password e username da 1 a 1024 unità UTF-16 e body del login di 4 KB, validati prima di ogni hash; rate limit per username e IP.
- **Rate limit** (`security/rate-limit/`): finestra fissa di 1 minuto con contatori in `rateLimits` (`_id` = `<bucket>:<SHA-256 della chiave>:<inizio finestra>`, un solo `findOneAndUpdate` atomico, TTL a fine finestra più 60 s): username e IP mai in chiaro. Header `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`; oltre soglia `429 RATE_LIMITED` con `Retry-After`; se il database non risponde la richiesta fallisce (fallire chiusi). Regole: login per username (normalizzato con NFKC, trim e minuscole, conteggiato dopo il parser) e per IP, refresh per IP, verifica dello username per utente, `/v1` per utente autenticato (sempre presente sulle route `user`, dopo l'autenticazione e prima di gruppo e permesso), autenticazioni fallite per IP (controllate prima di `authenticate`, consumate solo sui 401, così un ufficio dietro lo stesso IP non viene bloccato dalle richieste valide). Ogni route anonima deve dichiarare una regola che giri prima del parser; solo `/health` ne è esente con un motivo dichiarato. Chiave IP: IPv4 mappati ricondotti a IPv4, IPv6 per prefisso /64. In produzione con `TRUST_PROXY=0` l'avvio segnala che tutti i client avrebbero l'IP del load balancer. Rischio accettato: 5 tentativi al minuto per username permettono a un terzo di bloccare il login di un utente specifico.
- **Registro delle attività** (`shared/activity-log/`, collection `activityLog`): una voce ha `at`, `category` (`data`, `security`, `error`), `action` da catalogo, `outcome` (`success`, `failure`, `denied`), `actor` (`user` con id e ruolo, `anonymous`, `system`), `groupId`, `resource`, `changes`, `requestId`, `ip` (in chiaro, legittimo interesse alla sicurezza), `metadata` (chiavi ammesse per azione, massimo 20 valori scalari), `expiresAt` (TTL: 365 giorni per `data` e `security`, 90 per `error`). Validazione per allowlist nel servizio e `$jsonSchema` nel database. Le scritture non fanno mai fallire una richiesta: una voce malformata o un errore del database finiscono redatti su stdout.
  - **Cambi prima/dopo** (`computeChanges`, `recordDataChange` per lo strato service): percorsi fino a profondità 4, array e sottoalberi più profondi confrontati per intero, massimo 200 cambi per voce, stringhe troncate a 1000 caratteri. I segreti sono oscurati per chiave a ogni livello (password, PIN, token, chiavi, credenziali, firme…) e per prefisso (`integrations`, `settings.integrations`, `fattura_elettronica`, `settings.email`, anche sul campo stesso). Nome, email e telefono restano in chiaro (decisione dell'utente del 2026-11-02); su stdout invece sono redatti.
  - **Eventi collegati oggi:** accessi trasversali di PSA e dealer a un gruppo (`group.crossAccess`, con esito, al massimo una voce ogni 15 minuti per attore, gruppo ed esito per processo); primo superamento di un rate limit in una finestra (`rateLimit.exceeded`, senza la chiave); errori 5xx (`request.failed`, con metodo, pattern della route, nome e codice dell'errore, mai messaggio, stack o percorso concreto; al massimo 100 voci al minuto per processo, il resto solo su stdout). Gli eventi di login, sessioni e utenti sono collegati dall'area 3, gli errori JavaScript del backoffice dal passo 2D; quelli dei gruppi li emetterà l'area 4.
- **Compressione**: attiva sopra 1 KB. Le route future che restituiscono credenziali dovranno escluderla (rischio BREACH).

## 9. Test
- `npm test` dalla cartella `backend/`: `node --test` su `test/**/*.test.ts` con coverage nativa limitata a `src/**` e soglie al 100% di righe, rami e funzioni (sotto soglia la suite fallisce). Nessuna esclusione.
- **MongoDB per i test**: avviare il compose (§2) e copiare `.env.test.example` in `.env.test` (non versionato, caricato da `npm test` con `--env-file-if-exists`) impostando `FLOOD_CLOUD_TEST_MONGO_URI` all'URI del compose (`mongodb://127.0.0.1:27027/?directConnection=true`). Senza la variabile la suite fallisce. La guardia dei test (`test/helpers/mongo.ts`) rifiuta URI `mongodb+srv`, host diversi da loopback, credenziali e URI senza `directConnection=true`, e database che non siano `flood_cloud_test_<hex>` (eventualmente seguiti da `_<env>_…`). Ogni file usa database con nome casuale, eliminati alla fine. I test che avviano il server come processo figlio usano una cartella di lavoro temporanea, così un `backend/.env` con credenziali reali non viene mai caricato.
- **Fixture legacy** (`test/helpers/legacy-fixtures.ts`, Tasks 1.3.7): builder sintetici di `users`, `groups`, `countries`, `companies`, `places` nel formato del legacy, con varianti anomale (dati personali cifrati col formato legacy, password non hash, riferimenti come stringa, `groupId` discordante, `tokens` in formato vecchio) e `seedLegacyCluster` per un common con più gruppi, che crea l'indice univoco `userName_1` come in produzione. L'opzione `productionShape` riproduce le forme emerse dalla profilazione di produzione del 2026-11-01 (scope incoerenti per ruolo, PIN in vari formati, dati personali mancanti o vuoti, duplicati case-insensitive di `userName`, email, telefono e `companies.code`, valori reali di `plan` e dei tipi di dispositivo, gruppi senza database e viceversa).
- `test/unit/`: configurazione, `Secret`, logger, errori, gestore errori, middleware, builder delle route, health, errori di protocollo, nomi e registro dei database, client, guardia dei test, anti-bypass, analisi della profilazione.
- `test/integration/`: database reale (guardia, transazione tra common e gruppo, indici, readiness), profilazione e sua CLI (compreso un test che verifica l'assenza nel report di valori sentinella, chiavi di P.IVA, codici fiscali, hex e username), pipeline HTTP completa con `fetch` su porta effimera (`test/helpers/app.ts` monta l'app con route di prova e un logger in memoria), endpoint di salute, `run()` del server con processo simulato, avvio reale di `node src/server.ts` come processo figlio (avvio, `SIGTERM`, configurazione errata).
- Oltre a `FLOOD_CLOUD_TEST_MONGO_URI` nessuna variabile richiesta: i test costruiscono la configurazione con valori fittizi.
- **Isolamento** (`test/helpers/isolation.ts`): cluster legacy con due dealer e due gruppi ciascuno e casi standard (altro gruppo, altro dealer, CA fuori azienda, PA fuori punto vendita, E, gruppo sospeso, cestinato o inesistente) da riusare per ogni endpoint.
- Stato: 1242 test, coverage 100%.

**CI** (`.github/workflows/backend.yml`): **disattivata** per decisione dell'utente del 2026-11-01, parte solo a mano (`workflow_dispatch`); i trigger su `push` e `pull_request` sono commentati nel file. Contenuto: MongoDB `mongo:8.0.34` col compose, Node 24.22.2, `npm ci --ignore-scripts`, `npm run typecheck`, `npm test`, `npm audit --audit-level=moderate`, `npm audit signatures`; job separato di secret scanning con gitleaks 8.30.1 (binario verificato con sha256) su tutta la storia del repository. Permessi `contents: read`, action pinnate per SHA.

## 10. Registro dei passi
| Data | Passo | Cosa è stato realizzato |
|---|---|---|
| 2026-11-01 | Fondamenta del backend (1.1, 1.2, 1.4) | progetto TypeScript, configurazione validata con segreti protetti, app Express con envelope ed errori, header di sicurezza, CORS, request id, log con redazione, builder delle route con autenticazione obbligatoria, health, arresto ordinato, pipeline CI con secret scanning |
| 2026-11-01 | Database e infrastruttura di test (1.3, 1.4.8, 1.6) | client MongoDB, guardia d'ambiente sui nomi, registro delle collection, indici, readiness sul database, TLS obbligatorio in produzione, profilazione in sola lettura del legacy, fixture legacy sintetiche, MongoDB locale con compose, hook pre-commit gitleaks |
| 2026-11-01 | Fondamenta del backoffice (1.7, 1.8) | progetto Angular 22.2 con test al 100%, configurazione pubblica all'avvio, accesso HTTP con errori tipizzati, lingua a runtime (solo italiano), design token con temi chiaro e scuro, componenti condivisi per form e tabelle, shell accessibile, server statico Node con CSP a nonce e Trusted Types, Dockerfile non root, CI disattivata |
| 2026-11-02 | Primitive crittografiche e password legacy (2.1, 2.2.1–2.2.3) | segreti con hash a riposo, confronto a tempo costante, scrypt con limiti contro record manomessi, policy D-19, verifica dell'hash legacy con coesistenza e impronta, cambio password, tempi uniformi contro l'enumerazione degli utenti |
| 2026-11-02 | RBAC, scope e isolamento dei gruppi (2.3.1–2.3.3, 2.4) | catalogo dei permessi e tetti per ruolo, matrice per utente con default, route con permesso e gruppo dichiarativi, scope calcolato dal server con filtri sulle collection legacy, gruppo nel percorso con 404 fuori perimetro, anti-escalation con regola dei pari, modello di test di isolamento |
| 2026-11-02 | Rate limit e registro delle attività (2.5, 2.6.1–2.6.5) | contatori atomici con chiavi hashate e TTL, regole per login, refresh, username, utente e autenticazioni fallite, collection activityLog con validazione e conservazione per categoria, cambi prima/dopo con segreti oscurati, accessi trasversali ed errori 5xx registrati |
| 2026-11-04 | Autenticazione e profilo (1.5.1, 3.1–3.3) | validatore per allowlist, modello utente compatibile con il legacy, userCredentials con blocco progressivo, login con risposte e tempi uniformi, sessioni con rotazione, rilevamento del riuso e finestra di grazia, middleware Bearer con ricontrollo a ogni richiesta, profilo, cambio password e proprie sessioni |
| 2026-11-05 | Liste a cursore e gestione utenti (1.5.2–1.5.3, 3.4) | paginazione a cursore stabile anche con dati legacy anomali, utenti di gruppo e di piattaforma con perimetro e anti-escalation (anche sui permessi del bersaglio), password provvisoria con cambio obbligatorio, transazioni, eliminazione definitiva dal cestino, rate limit dedicati |
| 2026-11-05 | Sessione e profilo nel backoffice (3.5.1–3.5.5) | servizio di sessione con access token in memoria e refresh condiviso, sessione esclusiva per scheda, login, password provvisoria, guard per sessione e permesso, profilo, cambio password e proprie sessioni |
| 2026-11-05 | Gestione utenti nel backoffice e letture di riferimento (3.5.6–3.5.8) | selettore del gruppo, elenco e form utenti, azioni con conferma, letture compatte di gruppi, aziende e punti vendita |
| 2026-11-05 | Errori JavaScript e monitor dei log (2.6.6–2.6.7) | ricezione redatta e limitata degli errori del backoffice, monitor del registro con perimetro per ruolo, errori solo al PSA, staff nascosto ai clienti, pagina del monitor con dettaglio dei cambi |
| 2026-11-06 | Multicluster MongoDB | cluster multipli con connessioni di lettura/scrittura e analytics, cluster comune per login e dati comuni, `dataCluster` del gruppo con default, 503 per cluster non configurato, readiness sul solo cluster comune, profilazione di tutti i cluster |
| 2026-11-06 | Anagrafica dei dealer (4A) | collection dealers con stesso id dell'utente D, gestione per il PSA, creazione in transazione, ruolo D immutabile, script di registrazione dei dealer esistenti eseguito su development e production, validatori riapplicati solo se cambiati |

## 11. Backoffice
SPA **Angular 22.2** in `backoffice/` (Tasks 1.7, 1.8), rilasciata separatamente dal backend. Realizzati: fondamenta (1.7, 1.8), sessione, login, guard, profilo e proprie sessioni (3.5.1–3.5.5), gestione degli utenti con selettore del gruppo (3.5.6–3.5.8).

### 11.1 Comandi e dipendenze
Dalla cartella `backoffice/`:
| Comando | Effetto |
|---|---|
| `npm ci` | installa le dipendenze |
| `npm start` | `ng serve` (usa `public/config.json` con `http://localhost:3000`) |
| `npm run build` | build di produzione in `dist/backoffice/browser/` |
| `npm test` | Vitest con `@angular/build:unit-test`, coverage con soglie al 100% di statement, rami, funzioni e righe in `angular.json` |
| `npm run start:server` | server statico di produzione (§11.6); richiede `API_BASE_URL` |
| `npm run test:server` / `typecheck:server` | test (`node:test`, coverage 100%) e controllo dei tipi del server statico |

Dipendenze: pacchetti `@angular/*` 22.2.4 (CLI e build 22.2.5), `rxjs`, `tslib`; sviluppo TypeScript 6.0.3 (la versione richiesta da Angular), Vitest 5.0.5, `@vitest/coverage-v8`, jsdom, `prettier` (generato da `ng new`, tenuto per decisione dell'utente) e `@types/node` 24.19.2 per il server statico. Versioni esatte (`.npmrc` con `save-exact=true`). Nessuna libreria UI: tutti i componenti sono nostri.

### 11.2 Struttura
```
src/
  index.html                 # <fc-root ngCspNonce="__CSP_NONCE__"> (nonce sostituito dal server)
  styles/                    # styles.css → tokens.css, themes.css, base.css
  app/
    app.ts app.config.ts app.routes.ts
    core/
      api/                   # tipi dell'envelope, ApiError, interceptor base URL ed errori
      config/                # AppConfig e validazione di /config.json
      startup/               # inizializzazione, stato e pagina d'errore di avvio
      i18n/                  # I18nService, pipe t, formattazione Intl
      theme/                 # ThemeService
      layout/                # shell, menu, titoli e annunci di pagina
      errors/                # ErrorHandler globale
      storage.ts             # lettura/scrittura sicura di localStorage
    shared/ui/               # componenti condivisi (§11.5)
    features/                # home, pagine d'errore
  testing/                   # helper dei test
public/
  config.json                # solo sviluppo locale
  i18n/it.json               # dizionario italiano
server/                      # server statico di produzione (§11.6)
```

### 11.3 Avvio, configurazione e HTTP
- All'avvio (`provideAppInitializer`) si caricano in parallelo `/config.json` e il dizionario della lingua. `/config.json` contiene solo `apiBaseUrl` (URL assoluto `https:`, `http:` solo per `localhost`/`127.0.0.1`, senza credenziali, query né hash). Se uno dei due fallisce l'errore va in console e l'app mostra una pagina d'errore di avvio con "Riprova" al posto del router; i suoi testi hanno un fallback in italiano nel codice, l'unico ammesso, perché il dizionario potrebbe non esserci.
- `provideHttpClient` con due interceptor: `api-base-url` prefissa con `apiBaseUrl` solo le richieste relative che iniziano con `/v1/` e le marca come chiamate API; `api-error` trasforma gli errori delle sole chiamate API in `ApiError` (`status`, `code`, `message`, `details`, `requestId` da `X-Request-Id`): rete assente → `NETWORK_ERROR`, corpo non conforme → `UNKNOWN_ERROR` senza esporlo. `fieldErrors()` estrae gli errori per campo dei `422`.
- Tipi del contratto: `ApiData<T>`, `ApiPage<T>`, `ApiErrorBody`, `ApiErrorCode` (codici di `doc/API-Guidelines.md` §5).

### 11.4 Lingua e tema
- **Lingua** senza i18n di Angular: dizionari JSON annidati in `public/i18n/<lingua>.json`, scaricati a runtime e appiattiti (`COMMON.RETRY`); cambio lingua senza ricaricare. Lingue supportate: solo `it` (`SUPPORTED_LANGUAGES`). Lingua iniziale: preferenza salvata (`fc.language`), poi lingua del browser se supportata, poi `it`; `document.documentElement.lang` aggiornato. `t(key, params)` con interpolazione `{name}`; una chiave mancante appare come `⟦CHIAVE⟧` con un avviso in console. Un test verifica che ogni chiave usata esista, che tutti i dizionari abbiano le stesse chiavi, che ogni codice d'errore abbia un messaggio e che nei template non ci sia testo cablato. Date, numeri e importi (centesimi → valuta) con `Intl`.
- **Tema** chiaro, scuro o di sistema (`ThemeService`, preferenza `fc.theme`, attributo `data-theme` su `<html>`). In `localStorage` ci sono solo queste due preferenze.

### 11.5 Design system e shell
- **Token** in OKLCH (`tokens.css`, `themes.css`): palette neutra con primario blu, token semantici di colore, spaziature, raggi, ombre, tipografia `system-ui`, durate; animazioni disattivate con `prefers-reduced-motion`. Un test converte i colori in sRGB e verifica 23 coppie in entrambi i temi (testo ≥ 4.5:1, componenti e focus ≥ 3:1; es. testo su sfondo 16.6/15.8, primario su superficie 6.2/6.9).
- **Componenti** (`shared/ui/`, standalone, input/output a signal, elementi nativi, nessuna chiamata HTTP): `button` (varianti primary, secondary, danger, ghost; stato di caricamento), `icon-button` (etichetta obbligatoria), `icon` (17 SVG inline propri), campi `text-field`, `select`, `checkbox` (label, hint ed errore collegati con `aria-describedby`/`aria-invalid`), `data-table` (colonne dichiarative, caption, ordinamento con `aria-sort`, celle e azioni di riga con template, caricamento e stato vuoto), `cursor-paginator` (precedente/successiva e righe per pagina, nessun numero di pagina), `dialog` (su `<dialog>` nativo), `confirm-dialog`, `toast` (regione `aria-live`, massimo 5), `status-badge`, `empty-state`, `skeleton`, `error-state` (con "Riprova" e request id).
- **Shell** (`core/layout/`): link "Salta al contenuto", header con selettori di tema e lingua, menu laterale che sotto 48rem diventa un cassetto (pulsante di chiusura, sfondo cliccabile, Esc, pagina dietro `inert`, focus restituito al pulsante Menu), annuncio del cambio pagina in una regione live, titoli di pagina tradotti. Il menu è una configurazione (`menu.ts`) filtrata da `visibleMenu(items, can, hasFeature)`; oggi i predicati lasciano tutto visibile, finché sessione e feature del gruppo non arrivano (3.5.4, 4.5.2). Voci: Home.
- **Route** lazy: `/login` fuori dalla shell (solo anonimi); dentro la shell (solo autenticati) `''` (home), `/change-password`, `/profile` e `/profile/sessions` (permesso `profile:read`), `forbidden` (403), `error` (errore generico con request id opzionale), `**` (404).

### 11.6 Server statico e container
- **Server** (`server/`): Node 24 senza dipendenze, TypeScript con type stripping. Configurazione validata all'avvio: `API_BASE_URL` (obbligatoria, stesse regole di `apiBaseUrl`), `PORT` (default 8080), `STATIC_ROOT`.
  - `GET /config.json` generato in memoria (`no-store`); `GET /healthz` per GKE.
  - File statici solo con `GET`/`HEAD` (altri metodi 405 con `Allow`), risoluzione sicura dei percorsi (400 per encoding errati, null byte, backslash, segmenti `.`/`..` e segmenti oltre 255 byte; 414 oltre 2048 caratteri; 404 per symlink fuori dalla root), MIME da tabella, `ETag`/304, precompressi `.br`/`.gz` con `Vary`. Asset con hash `immutable`, il resto `no-cache`. Fallback su `index.html` per le navigazioni.
  - Header su ogni risposta, anche sugli errori di protocollo di Node: CSP `default-src 'none'; script-src 'self'; style-src 'self' 'nonce-…'; img-src 'self' data:; font-src 'self'; connect-src 'self' <origine API>; manifest-src 'self'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types angular angular#bundler`, HSTS, `X-Frame-Options: DENY`, `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, COOP, CORP, `Permissions-Policy`, `X-Request-Id` generato dal server. Il nonce (16 byte casuali per richiesta) sostituisce `__CSP_NONCE__` in `index.html`, servito `no-store`; il build di produzione non inserisce stili critici inline (`inlineCritical: false`).
  - Timeout: header 15 s, richiesta 30 s, inattività del socket 30 s, keep-alive 5 s. Log JSON di accesso (percorso senza query, troncato a 256 caratteri). Arresto ordinato su `SIGTERM` (drenaggio 5 s, uscita forzata 25 s).
- **Container** (`backoffice/Dockerfile`, contesto `backoffice/`): build su `node:24.22.2-bookworm`, runtime `node:24.22.2-bookworm-slim` (entrambe per digest) senza npm, npx e corepack, utente 1000, solo `dist/` e `server/`, compatibile con filesystem in sola lettura, porta 8080. `.dockerignore` esclude dipendenze, build, `.env*`, chiavi e log a ogni livello.
- **CI** (`.github/workflows/backoffice.yml`): disattivata come quella del backend (solo `workflow_dispatch`). Contenuto: `npm ci --ignore-scripts`, test Angular, test e typecheck del server, build, `npm audit --audit-level=moderate`, `npm audit signatures`.
- **Stato dei test**: 880 test Angular e 56 del server, coverage 100%.

### 11.7 Sessione e autenticazione (passo 3C)
- **Token** (D-12): access token solo in memoria nel `SessionService` (mai in storage, URL, log o errori); refresh token, scadenza e id della sessione in `sessionStorage` (`fc.session`), validati in lettura (formato `fc_rt_` + 43 caratteri) e rimossi a logout e scadenza. `localStorage` contiene solo le preferenze di tema e lingua.
- **Interceptor** (ordine `apiBaseUrl → auth → apiError`): `Authorization: Bearer` solo sulle richieste verso l'API (`/v1/…`, mai su `config.json`, dizionari o altri host), escluse login e refresh. `401 TOKEN_EXPIRED` ⇒ un unico refresh condiviso tra le richieste concorrenti e un solo nuovo tentativo; altri `401` ⇒ fine sessione e login con `returnUrl` interno validato; `403 PASSWORD_CHANGE_REQUIRED` ⇒ pagina di cambio password. Un refresh rifiutato (4xx) chiude la sessione; errori di rete, 429 e 5xx la lasciano intatta.
- **Avvio**: dopo configurazione e dizionario, se c'è una sessione salvata si fa refresh e `GET /v1/me`; rifiutata ⇒ anonimo; errore transitorio ⇒ pagina d'errore di avvio con "Riprova".
- **Una sessione per scheda** (decisione dell'utente del 2026-11-05): la scheda che usa una sessione ne tiene un lock (Web Locks API, `fc.session:<sessionId>`) per tutta la vita della pagina; una scheda duplicata, che eredita lo `sessionStorage`, trova il lock occupato e mostra il login senza chiamare il refresh (niente revoche né falsi allarmi di riuso). Senza Web Locks resta il comportamento precedente, con un avviso in console.
- **Guard** `canMatch`: sessione (`authenticated`), solo anonimi (`anonymousOnly`), password provvisoria (con il cambio pendente si raggiunge solo `/change-password`), permesso (`permission(p)` ⇒ `/forbidden`). Menu filtrato dai permessi della sessione; direttiva `*fcCan` per le azioni. Il backend resta l'autorità.
- **Pagine**: login (Signal Forms, messaggio generico per credenziali errate, attesa indicata con i secondi di `Retry-After` sul 429, password svuotata e nascosta dopo un errore); cambio password obbligatorio o volontario con gli errori del backend sui campi; profilo con modifica di nome, cognome, email, telefono e lingua (solo i campi cambiati); elenco e revoca delle proprie sessioni; menu utente con Esci ed Esci da tutti i dispositivi. Se il caricamento del profilo fallisce dopo il login, la sessione viene revocata anche sul server.
- **Errori imprevisti**: `ErrorHandler` globale che scrive in console e mostra un toast generico.

### 11.8 Gestione utenti (passo 3D)
- **Contesto del gruppo** (D-10, `core/groups/group-context.ts`): il gruppo di lavoro è nell'URL (`/groups/:groupId/...`). SA, CA e PA usano il gruppo del profilo; PSA e dealer lo scelgono dal selettore nell'header (combobox accessibile con ricerca su `GET /v1/groups`) o dalla pagina `/groups`. Il gruppo diventa quello di lavoro solo dopo una risposta positiva del backend; la preferenza (`fc.lastGroupId` e nome) sta in `sessionStorage`, validata in lettura e rimossa al logout.
- **Menu e route**: "Utenti" (`users:read`) verso `/groups/{gruppo}/users`; "Utenti di piattaforma" solo per il PSA (`/platform/users`). Route lazy `groups/:groupId/users`, `.../new`, `.../:userId` e `platform/users[...]`; guard per permesso e ruolo (il backend resta l'autorità).
- **Elenco** (`features/users/users-list`): filtri `q`, ruolo, stato e cestino, ordinamento e paginazione a cursore nell'URL; quattro stati; azioni di riga in un menu compatto (`shared/ui/actions-menu`) secondo i permessi, nascoste sulla riga dell'utente corrente; selezione multipla con cestino e ripristino in blocco ed esiti per riga. La pagina non scorre in orizzontale (tabella in un contenitore scorrevole con `position: relative`, colonne ridotte sotto 800 px di contenitore).
- **Form** (`user-form`): ruoli proposti in base a chi opera; perimetro scelto dalle letture di riferimento (CA: aziende; PA ed E: punti vendita, filtrabili per azienda se l'utente può leggere le aziende); username ASCII con verifica di disponibilità; password provvisoria con generatore locale (`crypto.getRandomValues`, 16 caratteri, mostrata una volta, mai salvata né loggata); matrice dei permessi modificabile solo con `canManagePermissions`, altrimenti i default del ruolo limitati a quelli di chi crea, mostrati in sola lettura; errori `422`, `409` e `403` sui campi.
- **Azioni** (`user-actions`): reset della password (dialog ricreato a ogni apertura, password azzerata alla chiusura), attiva e disattiva, cestino e ripristino, eliminazione definitiva solo dal cestino con conferma digitando lo username; tutte con conferma e messaggio di esito.

### 11.9 Errori JavaScript e monitor dei log (passo 2D)
- **Segnalazione** (`core/errors/client-error-reporter.ts`, chiamata dal `GlobalErrorHandler` dopo il toast e senza mai interromperlo): solo con utente autenticato e solo per errori JavaScript (non per gli errori HTTP, già noti al server). Invia nome, messaggio (300 caratteri) e prime 10 righe dello stack (300 caratteri ciascuna, prima riga ricostruita col messaggio troncato, frammenti tra virgolette oltre 20 caratteri sostituiti da `"…"`), route come pattern della configurazione del router, versione dell'app (dalla sola `version` di `package.json`, il resto del file non entra nel bundle) e ora. Deduplica per 60 secondi, massimo 10 invii per caricamento di pagina; un invio fallito va solo in console.
- **Monitor** (`features/activity-log/`, voce "Registro attività", permesso `activityLog:read`): tabella con data, categoria, azione tradotta, esito, attore (solo il ruolo per lo staff nascosto dal server), request id; filtri nell'URL (categoria ed errori solo per il PSA, esito, azione, periodo, request id, attore, gruppo corrente per PSA e dealer), paginazione a cursore, quattro stati; dettaglio in un dialog con cambi prima/dopo (valori oscurati indicati come tali), metadata e, per gli errori, nome, messaggio e stack resi come testo.
