# Documentazione Tecnica

> Documento **mantenuto a ogni passo** (`GEMINI.md` §3): descrive ciò che è **realizzato**, non ciò che è progettato. §1–§10 riguardano il backend, §11 il backoffice. Il progetto è in `doc/Architecture.md`, `doc/Security-Model.md`, `doc/Data-Model.md`, `doc/API-Guidelines.md`.
> Quando un passo aggiunge o cambia qualcosa, si aggiorna la sezione corrispondente; le sezioni ancora vuote restano con la nota "Nessun elemento realizzato".

## 1. Stato del progetto
Realizzate le fondamenta del backend (`doc/Tasks.md` 1.1–1.4, 1.6): progetto TypeScript, configurazione validata, applicazione Express con envelope, errori, header di sicurezza, CORS, log strutturati, builder delle route, endpoint di salute e arresto ordinato; client MongoDB sul cluster condiviso con guardia d'ambiente, registro delle collection, indici, strumento di profilazione in sola lettura del legacy, MongoDB locale per i test. Nessuna autenticazione, nessun endpoint di dominio, nessuna scrittura su database.

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
| `MONGODB_URI` | sì, segreto | inizia con `mongodb://` o `mongodb+srv://`. Con `APP_ENV=production` TLS obbligatorio: `mongodb+srv://` senza `tls`/`ssl` diversi da `true`, oppure `mongodb://` con `tls=true`; rifiutate `tlsInsecure`, `tlsAllowInvalidCertificates`, `tlsAllowInvalidHostnames`, `tlsDisableOCSPEndpointCheck`, `tlsDisableCertificateRevocationCheck` a `true` | — |
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
| `LEGACY_PASSWORD_PEPPER` | sì, segreto | non vuoto, senza spazi iniziali o finali (D-04) | — |

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
  modules/health/health.routes.ts
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
      express-locals.d.ts      # tipi di res.locals
    logging/logger.ts          # logger JSON con redazione
    security/secret.ts         # Secret
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

**Builder delle route** (`shared/http/routes.ts`): ogni route si dichiara con `defineRoute({ method, path, auth, bodyLimit?, handler })`. `mountRoutes` valida tutte le route all'avvio e **lancia** se `auth` manca o è sconosciuto, se una route anonima non ha un motivo, se il metodo non è ammesso (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`) o se due route coincidono (confronto dopo normalizzazione: minuscole, senza `/` finale, parametri equivalenti). Oggi l'unico tipo di `auth` è `{ kind: 'anonymous', reason }`. Per ogni percorso i metodi non dichiarati rispondono `405 METHOD_NOT_ALLOWED` con header `Allow` (`GET` implica `HEAD`).

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

## 7. Database
**Cluster condiviso con il legacy** (`doc/Tasks.md` §0.1–0.2): stesse credenziali Atlas (D-02), stessi database. In questo passo il backend **non scrive** su nessun database.

**Client** (`db/client.ts`): un solo `MongoClient` per processo, creato in `server.ts`: `appName: flood-cloud-backend`, `retryWrites`, `w: majority`, `readPreference: primary`, `serverSelectionTimeoutMS` e `connectTimeoutMS` = `MONGODB_SERVER_SELECTION_TIMEOUT_MS`, `maxPoolSize` = `MONGODB_MAX_POOL_SIZE`. In produzione, dopo la costruzione, si verifica che TLS sia attivo e senza opzioni insicure.

**Nomi** (`db/names.ts`): common `<DB_NAME_PREFIX><APP_ENV>_common`; gruppo `<DB_NAME_PREFIX><APP_ENV>_<groupId>` con `groupId` ObjectId o 24 caratteri esadecimali minuscoli; `parseGroupDatabaseName` ricava il `groupId` dal nome (D-20).

**Guardia d'ambiente** (`db/databases.ts`): `createDatabases(client, { prefix, appEnv })` è l'unico modo di ottenere un `Db` (`common()`, `group(groupId)`), più `listGroupIds()`, `countOtherDatabases()` e `serverVersion()` per la profilazione. Ogni nome deve corrispondere a `^<prefix><APP_ENV>_(common|[0-9a-f]{24})$` e non superare 63 byte: con `APP_ENV=development` un database `production_*` non è raggiungibile. Un test vieta in tutto `src/` fuori da `src/db/` `.db(`, `new Db(`, `['db']`, `.admin(`, `.client.`, `$out`, `$merge`, `renameCollection`; `createDatabases(` è ammesso solo in `server.ts` e nei `main` degli strumenti.

**Registro delle collection** (`db/collections.ts`):
| Database | Collection | Proprietà |
|---|---|---|
| common | `users`, `groups`, `countries` | legacy, sola lettura |
| gruppo | `companies`, `places` | legacy, sola lettura |
Proprietà possibili: `new` (collection del nuovo backend), `legacy-read`, `legacy-write` (con elenco obbligatorio dei campi posseduti). Sulle collection legacy sono vietati indici univoci e TTL. Un test vieta in `src/` nomi di collection non letterali o non registrati.

**Indici** (`db/indexes.ts`): `ensureIndexes` crea all'avvio, in modo idempotente e con nomi espliciti, gli indici del registro sul database common; rifiuta un registro non valido o indici dichiarati su collection dei gruppi. Oggi il registro non dichiara indici: nessun indice creato.

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
- **Log** (`shared/logging/logger.ts`): una riga JSON per evento (`time`, `level` tra `debug|info|warn|error`, `msg`, campi extra non in grado di sovrascrivere i tre precedenti). Redazione profonda:
  - chiavi normalizzate (minuscole, solo lettere e cifre) uguali a `pin`, `name`, `email`, `telephone`, `phone`, `surname`, `firstname`, `lastname`, `fiscalcode`, `mongodburi` o contenenti `password`, `passcode`, `secret`, `token`, `apikey`, `pepper`, `authorization`, `cookie`, `privatekey`, `credential`, `signature`;
  - valori dopo un nome sensibile negli array `rawHeaders`;
  - stringhe (anche `msg`, message e stack degli errori) con `fc_at_`, `fc_rt_`, `fc_pk_`, `mongodb://`, `mongodb+srv://`, e il dettaglio `dup key: {…}`;
  - istanze `Secret`;
  - errori MongoDB (`Mongo*`) ridotti a `{ name, code, codeName }`;
  - profondità massima 10 (`[Truncated]`), getter che falliscono (`[Unreadable]`), cicli, chiave `__proto__` conservata come campo.
- **Database**: guardia d'ambiente sui nomi dei database, TLS obbligatorio in produzione, nessuna scrittura (§7).
- **Compressione**: attiva sopra 1 KB. Le route future che restituiscono credenziali dovranno escluderla (rischio BREACH).

## 9. Test
- `npm test` dalla cartella `backend/`: `node --test` su `test/**/*.test.ts` con coverage nativa limitata a `src/**` e soglie al 100% di righe, rami e funzioni (sotto soglia la suite fallisce). Nessuna esclusione.
- **MongoDB per i test**: avviare il compose (§2) e copiare `.env.test.example` in `.env.test` (non versionato, caricato da `npm test` con `--env-file-if-exists`) impostando `FLOOD_CLOUD_TEST_MONGO_URI` all'URI del compose (`mongodb://127.0.0.1:27027/?directConnection=true`). Senza la variabile la suite fallisce. La guardia dei test (`test/helpers/mongo.ts`) rifiuta URI `mongodb+srv`, host diversi da loopback, credenziali e URI senza `directConnection=true`, e database che non siano `flood_cloud_test_<hex>` (eventualmente seguiti da `_<env>_…`). Ogni file usa database con nome casuale, eliminati alla fine. I test che avviano il server come processo figlio usano una cartella di lavoro temporanea, così un `backend/.env` con credenziali reali non viene mai caricato.
- **Fixture legacy** (`test/helpers/legacy-fixtures.ts`, Tasks 1.3.7): builder sintetici di `users`, `groups`, `countries`, `companies`, `places` nel formato del legacy, con varianti anomale (dati personali cifrati col formato legacy, password non hash, riferimenti come stringa, `groupId` discordante, `tokens` in formato vecchio) e `seedLegacyCluster` per un common con più gruppi, che crea l'indice univoco `userName_1` come in produzione. L'opzione `productionShape` riproduce le forme emerse dalla profilazione di produzione del 2026-11-01 (scope incoerenti per ruolo, PIN in vari formati, dati personali mancanti o vuoti, duplicati case-insensitive di `userName`, email, telefono e `companies.code`, valori reali di `plan` e dei tipi di dispositivo, gruppi senza database e viceversa).
- `test/unit/`: configurazione, `Secret`, logger, errori, gestore errori, middleware, builder delle route, health, errori di protocollo, nomi e registro dei database, client, guardia dei test, anti-bypass, analisi della profilazione.
- `test/integration/`: database reale (guardia, transazione tra common e gruppo, indici, readiness), profilazione e sua CLI (compreso un test che verifica l'assenza nel report di valori sentinella, chiavi di P.IVA, codici fiscali, hex e username), pipeline HTTP completa con `fetch` su porta effimera (`test/helpers/app.ts` monta l'app con route di prova e un logger in memoria), endpoint di salute, `run()` del server con processo simulato, avvio reale di `node src/server.ts` come processo figlio (avvio, `SIGTERM`, configurazione errata).
- Oltre a `FLOOD_CLOUD_TEST_MONGO_URI` nessuna variabile richiesta: i test costruiscono la configurazione con valori fittizi.
- Stato: 236 test, coverage 100%.

**CI** (`.github/workflows/backend.yml`): **disattivata** per decisione dell'utente del 2026-11-01, parte solo a mano (`workflow_dispatch`); i trigger su `push` e `pull_request` sono commentati nel file. Contenuto: MongoDB `mongo:8.0.34` col compose, Node 24.22.2, `npm ci --ignore-scripts`, `npm run typecheck`, `npm test`, `npm audit --audit-level=moderate`, `npm audit signatures`; job separato di secret scanning con gitleaks 8.30.1 (binario verificato con sha256) su tutta la storia del repository. Permessi `contents: read`, action pinnate per SHA.

## 10. Registro dei passi
| Data | Passo | Cosa è stato realizzato |
|---|---|---|
| 2026-11-01 | Fondamenta del backend (1.1, 1.2, 1.4) | progetto TypeScript, configurazione validata con segreti protetti, app Express con envelope ed errori, header di sicurezza, CORS, request id, log con redazione, builder delle route con autenticazione obbligatoria, health, arresto ordinato, pipeline CI con secret scanning |
| 2026-11-01 | Database e infrastruttura di test (1.3, 1.4.8, 1.6) | client MongoDB, guardia d'ambiente sui nomi, registro delle collection, indici, readiness sul database, TLS obbligatorio in produzione, profilazione in sola lettura del legacy, fixture legacy sintetiche, MongoDB locale con compose, hook pre-commit gitleaks |
| 2026-11-01 | Fondamenta del backoffice (1.7, 1.8) | progetto Angular 22.2 con test al 100%, configurazione pubblica all'avvio, accesso HTTP con errori tipizzati, lingua a runtime (solo italiano), design token con temi chiaro e scuro, componenti condivisi per form e tabelle, shell accessibile, server statico Node con CSP a nonce e Trusted Types, Dockerfile non root, CI disattivata |

## 11. Backoffice
SPA **Angular 22.2** in `backoffice/` (Tasks 1.7, 1.8), rilasciata separatamente dal backend. Nessun login né pagina di dominio: sessione, guard e permessi arrivano con l'area 3.

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
- **Route** lazy dentro la shell: `''` (home), `forbidden` (403), `error` (errore generico con request id opzionale), `**` (404).
- **Errori imprevisti**: `ErrorHandler` globale che scrive in console e mostra un toast generico.

### 11.6 Server statico e container
- **Server** (`server/`): Node 24 senza dipendenze, TypeScript con type stripping. Configurazione validata all'avvio: `API_BASE_URL` (obbligatoria, stesse regole di `apiBaseUrl`), `PORT` (default 8080), `STATIC_ROOT`.
  - `GET /config.json` generato in memoria (`no-store`); `GET /healthz` per GKE.
  - File statici solo con `GET`/`HEAD` (altri metodi 405 con `Allow`), risoluzione sicura dei percorsi (400 per encoding errati, null byte, backslash, segmenti `.`/`..` e segmenti oltre 255 byte; 414 oltre 2048 caratteri; 404 per symlink fuori dalla root), MIME da tabella, `ETag`/304, precompressi `.br`/`.gz` con `Vary`. Asset con hash `immutable`, il resto `no-cache`. Fallback su `index.html` per le navigazioni.
  - Header su ogni risposta, anche sugli errori di protocollo di Node: CSP `default-src 'none'; script-src 'self'; style-src 'self' 'nonce-…'; img-src 'self' data:; font-src 'self'; connect-src 'self' <origine API>; manifest-src 'self'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types angular angular#bundler`, HSTS, `X-Frame-Options: DENY`, `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, COOP, CORP, `Permissions-Policy`, `X-Request-Id` generato dal server. Il nonce (16 byte casuali per richiesta) sostituisce `__CSP_NONCE__` in `index.html`, servito `no-store`; il build di produzione non inserisce stili critici inline (`inlineCritical: false`).
  - Timeout: header 15 s, richiesta 30 s, inattività del socket 30 s, keep-alive 5 s. Log JSON di accesso (percorso senza query, troncato a 256 caratteri). Arresto ordinato su `SIGTERM` (drenaggio 5 s, uscita forzata 25 s).
- **Container** (`backoffice/Dockerfile`, contesto `backoffice/`): build su `node:24.22.2-bookworm`, runtime `node:24.22.2-bookworm-slim` (entrambe per digest) senza npm, npx e corepack, utente 1000, solo `dist/` e `server/`, compatibile con filesystem in sola lettura, porta 8080. `.dockerignore` esclude dipendenze, build, `.env*`, chiavi e log a ogni livello.
- **CI** (`.github/workflows/backoffice.yml`): disattivata come quella del backend (solo `workflow_dispatch`). Contenuto: `npm ci --ignore-scripts`, test Angular, test e typecheck del server, build, `npm audit --audit-level=moderate`, `npm audit signatures`.
- **Stato dei test**: 257 test Angular e 56 del server, coverage 100%.
