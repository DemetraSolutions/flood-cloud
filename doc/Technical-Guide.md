# Documentazione Tecnica del Backend

> Documento **mantenuto a ogni passo** (`GEMINI.md` §3): descrive ciò che è **realizzato**, non ciò che è progettato. Il progetto è in `doc/Architecture.md`, `doc/Security-Model.md`, `doc/Data-Model.md`, `doc/API-Guidelines.md`.
> Quando un passo aggiunge o cambia qualcosa, si aggiorna la sezione corrispondente; le sezioni ancora vuote restano con la nota "Nessun elemento realizzato".

## 1. Stato del progetto
Realizzate le fondamenta del backend (`doc/Tasks.md` 1.1, 1.2, 1.4): progetto TypeScript, configurazione validata, applicazione Express con envelope, errori, header di sicurezza, CORS, log strutturati, builder delle route, endpoint di salute e arresto ordinato. Nessun database collegato, nessuna autenticazione, nessun endpoint di dominio.

## 2. Requisiti e avvio
- **Node.js** `>=24.20.0 <25` (TypeScript eseguito direttamente con il type stripping nativo, nessuna compilazione).
- Comandi, dalla cartella `backend/`:
  | Comando | Effetto |
  |---|---|
  | `npm ci` | installa le dipendenze dal `package-lock.json` |
  | `npm start` | avvia `node src/server.ts` |
  | `npm run typecheck` | `tsc --noEmit` |
  | `npm test` | suite `node:test` con coverage nativa e soglie al 100% |
- **Avvio in locale:** copiare `.env.example` in `.env` (non versionato) e compilare i valori. `server.ts` carica `.env` con `process.loadEnvFile`; se il file non esiste prosegue con le sole variabili d'ambiente (altri errori di lettura bloccano l'avvio).
- **Dipendenze:** runtime `express@5.3.0`, `compression@1.8.2`; sviluppo `typescript@7.0.2`, `@types/node@24.19.2`, `@types/express@5.0.6`, `@types/compression@1.8.1`. Il body JSON usa `express.json` (body-parser incluso in Express).

## 3. Configurazione
Lettura e validazione in `src/config.ts` (`loadConfig`, funzione pura). Tutti i problemi vengono raccolti e segnalati insieme con nome della variabile e motivo, **mai il valore**; con configurazione non valida il processo scrive l'elenco su stderr ed esce con codice 1. L'oggetto risultante è congelato. Gli interi accettano solo cifre decimali; una variabile intera presente ma vuota è un errore.

| Variabile | Obbligatoria | Regola | Default |
|---|---|---|---|
| `APP_ENV` | sì | `development` \| `production` (D-16) | — |
| `PORT` | no | intero 1–65535 | `3000` |
| `MONGODB_URI` | sì, segreto | inizia con `mongodb://` o `mongodb+srv://` (solo validata: nessuna connessione in questo passo) | — |
| `DB_NAME_PREFIX` | no | `^[A-Za-z0-9_-]{0,32}$` | vuoto |
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
  modules/health/health.routes.ts
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
  unit/  integration/  helpers/
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

**Server HTTP** (`server.ts`): `http.createServer(app)` con `requestTimeout = REQUEST_TIMEOUT_MS`, `headersTimeout = min(60 s, requestTimeout − 1)`, `keepAliveTimeout = 620 s` (oltre i 600 s di keep-alive del load balancer di Google). `trust proxy` = `TRUST_PROXY` (0 ⇒ disattivato); `X-Powered-By` ed `ETag` disattivati.

**Arresto ordinato**: su `SIGTERM`/`SIGINT` la readiness passa subito a `503`, dopo `SHUTDOWN_DRAIN_MS` il server chiude (`close()` e `closeIdleConnections()`); uscita forzata 25 s dopo il segnale. Un secondo segnale viene ignorato e registrato. `unhandledRejection`, `uncaughtException` e un errore di `listen` producono un log `error` e l'uscita con codice 1.

## 6. Moduli
### health
Endpoint di salute per GKE, fuori dalle superfici API, dichiarati anonimi nel builder (sonde dell'orchestratore). Riferimento in `doc/API.md`.
- `GET /health/live`: sempre `200` se il processo risponde.
- `GET /health/ready`: `200` se il server non è in arresto e tutti i controlli di prontezza riescono entro 2 s ciascuno; altrimenti `503 SERVICE_UNAVAILABLE` senza dettagli (il motivo va nel log `warn`). In questo passo non ci sono controlli: il ping del database arriva con 1.3.1.

## 7. Database
Nessun elemento realizzato. `MONGODB_URI` è validata ma non usata.

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
- **Compressione**: attiva sopra 1 KB. Le route future che restituiscono credenziali dovranno escluderla (rischio BREACH).

## 9. Test
- `npm test` dalla cartella `backend/`: `node --test` su `test/**/*.test.ts` con coverage nativa limitata a `src/**` e soglie al 100% di righe, rami e funzioni (sotto soglia la suite fallisce). Nessuna esclusione.
- `test/unit/`: configurazione, `Secret`, logger, errori, gestore errori, middleware, builder delle route, health, errori di protocollo.
- `test/integration/`: pipeline HTTP completa con `fetch` su porta effimera (`test/helpers/app.ts` monta l'app con route di prova e un logger in memoria), endpoint di salute, `run()` del server con processo simulato, avvio reale di `node src/server.ts` come processo figlio (avvio, `SIGTERM`, configurazione errata).
- Nessuna variabile d'ambiente richiesta: i test costruiscono la configurazione con valori fittizi.
- Stato: 127 test, coverage 100%.

**CI** (`.github/workflows/backend.yml`, su modifiche a `backend/**` o al workflow): Node 24.22.2, `npm ci --ignore-scripts`, `npm run typecheck`, `npm test`, `npm audit --audit-level=moderate`, `npm audit signatures`; job separato di secret scanning con gitleaks 8.30.1 (binario verificato con sha256) su tutta la storia del repository. Permessi `contents: read`, action pinnate per SHA.

## 10. Registro dei passi
| Data | Passo | Cosa è stato realizzato |
|---|---|---|
| 2026-11-01 | Fondamenta del backend (1.1, 1.2, 1.4) | progetto TypeScript, configurazione validata con segreti protetti, app Express con envelope ed errori, header di sicurezza, CORS, request id, log con redazione, builder delle route con autenticazione obbligatoria, health, arresto ordinato, pipeline CI con secret scanning |
