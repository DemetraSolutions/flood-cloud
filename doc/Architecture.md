# Architettura

## 1. Contesto
```
App di backoffice ─────────── /v1  (token opachi) ───────┐
                                                         │
App del server di punto vendita ─ /v1 (credenziale: D-24)┼──► Flood Cloud ──► MongoDB
  └─ casse, palmari, altri client locali                 │      (Node.js,      ├─ <env>_common
     (non parlano mai con il cloud)                      │       Express 5)    └─ <env>_<groupId>
                                                         │          │
Integrazioni di un gruppo ─── /public/v1 (API key) ──────┘          └──► provider esterni
                                                                         (fiscale, fatturazione, pagamenti…)
```
- Il cloud ha **due superfici API** (`/v1` e `/public/v1`), ciascuna con la propria credenziale (`doc/Security-Model.md` §3). L'app del server di punto vendita è un'applicazione separata, fuori scope (D-22), che usa le stesse API `/v1` del backoffice (D-23); la sua credenziale è una decisione aperta (D-24). La superficie `/store/v1` prevista in origine è **eliminata**.
- In ogni negozio c'è **un solo server di punto vendita** che centralizza casse e dispositivi: è l'unico che comunica con il cloud per quel negozio.

## 2. Stack
| Componente | Scelta |
|---|---|
| Runtime | Node.js 24 LTS, moduli ESM |
| Linguaggio | **TypeScript** eseguito direttamente da Node (type stripping nativo, nessuna compilazione); `tsc --noEmit` per il controllo dei tipi in CI (decisione dell'utente del 2026-11-01) |
| HTTP | Express 5, `body-parser`, `compression`, `multer` |
| Database | MongoDB, driver ufficiale `mongodb` (nessun ODM) |
| Crittografia | `node:crypto` |
| Test | `node:test` + coverage nativa al 100% su file `.ts`, `fetch` nativo, MongoDB reale |
| Backoffice | Angular 22 (ultima stabile), standalone, signals, zoneless (§5.3) |

Ogni altra libreria richiede approvazione (`GEMINI.md` §11).

## 3. Database
### 3.1 Nomi dipendenti dall'ambiente
I nomi dei database dipendono dall'ambiente, come nel legacy, così più ambienti convivono sullo stesso cluster:
| Database | Nome |
|---|---|
| Common | `<DB_NAME_PREFIX><APP_ENV>_common` |
| Gruppo | `<DB_NAME_PREFIX><APP_ENV>_<groupId>` |

- `APP_ENV` è **obbligatoria** e senza default (il legacy ripiegava su `development`: un errore di configurazione poteva scrivere nel database sbagliato). I valori devono coincidere con quelli dei database esistenti.
- `DB_NAME_PREFIX` è opzionale (nel legacy `DB_COLLECTION_PREFIX`).
- Il nome si costruisce in **un solo punto** del codice (`backend/src/db/names.ts`): il legacy lo ripeteva in circa 300 punti.
- `groupId` si valida come `ObjectId` prima di comporre il nome: nessun nome di database deriva da input non validato.

### 3.2 Cosa sta dove
| Common (identità, tenancy, sicurezza) | Database del gruppo (dati operativi) |
|---|---|
| `groups`, `users`, `companies`, `places` | catalogo (prodotti, reparti, categorie…) |
| `sessions` | magazzino |
| `apiKeys`, `rateLimits`, `apiUsage`, `platformSettings` | vendite e documenti fiscali |
| `auditLog` | clienti e fedeltà, prenotazioni… |

**Decisione del 2026-10-30:** `companies` e `places` passano nel **common** (nel legacy erano nei database dei gruppi e rendevano costose le liste trasversali, es. tutti i punti vendita di un dealer). La verifica di ogni credenziale e il calcolo dello scope avvengono interamente nel common, senza aprire il database del gruppo.

### 3.2.1 Più cluster (decisione dell'utente del 2026-11-06)
La piattaforma può usare più cluster MongoDB (`cluster0`, `cluster1`, …), ciascuno con **due connessioni**: lettura/scrittura e **analytics** (nodo dedicato alle letture pesanti, come statistiche e report).
- **Login e dati comuni** stanno sempre sul **cluster comune** (`MONGODB_COMMON_CLUSTER`, oggi `cluster0`).
- Ogni gruppo dichiara nel common il proprio cluster con il campo **`dataCluster`** (solo l'id, mai host o credenziali); se manca vale il cluster di default dei gruppi (`MONGODB_DEFAULT_GROUP_CLUSTER`), quindi i gruppi esistenti restano dove sono senza migrazione. Un valore non configurato dà `503`, mai un ripiego su un altro cluster.
- Le connessioni di ogni cluster stanno nella configurazione (secret manager in produzione). Senza configurazione esplicita dei cluster vale la modalità a cluster singolo.
- **Vincoli:** finché il legacy è attivo usa un solo cluster, quindi un gruppo su un cluster diverso dal comune non funzionerebbe nei client legacy; non esistono transazioni tra cluster diversi (la doppia scrittura di aziende e punti vendita, §0.3 di `doc/Tasks.md`, è atomica solo per i gruppi sul cluster comune; per gli altri vale la riconciliazione); lo spostamento di un gruppo tra cluster è un'operazione da progettare a parte.

Il campo `databaseHost` del legacy (host nel documento) **non si usa**: al suo posto `dataCluster` con il solo identificativo.

Schema delle collection del common: `doc/Data-Model.md`. I domini operativi si documentano quando vengono affrontati.

### 3.3 Accesso
- Un `MongoClient` per cluster e per tipo di connessione (lettura/scrittura, analytics), creati all'avvio; il database del gruppo si ottiene dal contesto della richiesta (`req.auth`) sul cluster del gruppo, mai da parametri del client.
- I repository dei dati di gruppo ricevono il `Db` del gruppo già risolto e non possono aprirne altri.
- Le transazioni tra common e database del gruppo sono possibili solo se stanno sullo stesso cluster (replica set) e si usano solo dove serve atomicità.

### 3.4 Coesistenza con il legacy e sincronizzazione
Il nuovo backend lavora sugli stessi cluster e database del legacy, che resta attivo durante la transizione (backend, backoffice, POS e `ms-integration-service`). Il legacy chiama l'ambiente `NODE_ENV`; il nuovo backend `APP_ENV`, con gli stessi valori (`development`, `production`). Regole in `doc/Tasks.md` §0.2 (D-03), strategia in §0.3 (D-01).
- **`users` e `groups`** sono condivise: restano nel formato legacy e la traduzione nel modello di dominio sta solo nei repository, con scritture `$set`/`$unset` dei campi posseduti e nessun indice univoco né `$jsonSchema` sulle collection condivise. I dati di sicurezza stanno in collection nuove (`userCredentials`, `sessions`).
- **`companies` e `places`**: gli originali restano nei database dei gruppi, perché il legacy li legge anche con `$lookup`. Nel common ci sono **copie intere** dei documenti (D-20), con lo stesso `_id` e `groupId` sempre dal nome del database.
- **Scrittura delle copie dal legacy**: il legacy scrive la copia nel common nella stessa transazione della scrittura originale, e rimuove la copia quando cancella (D-21). È controllata da `COMMON_COPY_ENABLED=true` e oggi è attiva **solo in development**; la produzione resta spenta per decisione dell'utente del 2026-11-13.
- **Lettura**: il nuovo backend legge aziende e punti vendita **solo dalle copie** del common, mai dagli originali.
- **Riconciliazione**: `npm run sync:copies` confronta e ripara le copie. Solo development (`--env production` è rifiutato), copia solo lo stato attuale e **non cancella mai** (le copie senza originale si segnalano in `syncIssues`). Si lancia a mano: decisione dell'utente del 2026-11-13, nessun worker periodico per ora.
- **Scritture dal nuovo backend** (fase 2): servizio interno realizzato (5.6, `shared/legacy-write/`), senza route fino alle aree 6 e 7; `If-Match` contro i conflitti di modifica (decisione dell'utente del 2026-11-13), nel legacy vale l'ultimo scrittore.
- Con più cluster (§3.2.1) la scrittura transazionale delle copie vale solo per i gruppi sul cluster comune; per gli altri resta la riconciliazione (D-25).

## 4. Superfici API
| Superficie | Prefisso | Credenziale | CORS | Note |
|---|---|---|---|---|
| Backoffice | `/v1` | Bearer `fc_at_…` + refresh | allowlist origini del backoffice | ruoli PSA, D, SA, CA, PA |
| Pubblica | `/public/v1` | `X-Api-Key: fc_pk_…` | chiuso | scope sul gruppo; rate limit e quote |

Nessuna superficie `/store/v1` per il server di punto vendita: è un'app separata, fuori scope (D-22), che usa le API `/v1` (D-23); la credenziale è una decisione aperta (D-24).

Lo stesso dominio (es. prodotti) può essere esposto su più superfici con permessi e campi diversi: il service è unico, cambiano route, autenticazione e mapper di risposta. Le regole REST sono in `doc/API-Guidelines.md`; il riferimento degli endpoint in `doc/API.md`.

## 5. Repository e struttura del codice
### 5.1 Monorepo
Decisione dell'utente del 2026-11-01: un unico repository con due componenti a rilascio indipendente.
```
flood-cloud/
  backend/                 # API Node.js + Express (questa sezione, §5.2)
  backoffice/              # SPA Angular del backoffice (§5.3)
  doc/                     # documentazione di progetto, comune
  .agents/ .claude/        # kit AI
  .github/workflows/       # backend.yml e backoffice.yml, ciascuno filtrato sulla propria cartella
```
Ogni componente ha `package.json`, lockfile, `Dockerfile` e manifest propri e viene deployato su GKE come **Deployment e Service separati**, con repliche e autoscaling indipendenti. Una modifica a una sola cartella fa partire solo la pipeline di quel componente.

### 5.2 Backend
Percorsi relativi a `backend/`:
```
src/
  server.ts              # unico punto con process.env, connessione DB, listen, arresto ordinato
  app.ts                 # createApp(deps): app Express senza effetti collaterali
  config.ts              # lettura e validazione della configurazione
  db/                    # client, nomi dei database, creazione indici
  shared/
    http/                # definizione route, envelope, errori, header, CORS, timeout
    security/            # token, hash, scrypt, policy RBAC, rate limit, audit
    validation/          # validatore per allowlist
  modules/<dominio>/     # routes, controller, service, repository, schemas, mapper, indexes
  integrations/<provider>/
test/
  unit/  integration/  helpers/
```
Pipeline di ogni route: **autenticazione → rate limit → autorizzazione → validazione → controller → service → repository**. Il builder delle route rifiuta all'avvio una route senza autenticazione dichiarata (skill `express-module-scaffold`).

### 5.3 Backoffice
SPA **Angular 22** (decisione dell'utente del 2026-11-01) che usa la superficie `/v1`. Pattern moderni: standalone, signals, zoneless, OnPush di default, `inject()`, `httpResource`, Signal Forms, routing lazy con guard funzionali (agente `angular_expert`). Percorsi relativi a `backoffice/`:
```
src/
  main.ts
  app/
    app.ts  app.config.ts  app.routes.ts
    core/                # sessione e interceptor, configurazione pubblica, tipi dell'API, shell e layout, pagine di errore
    shared/ui/           # componenti di presentazione del design system
    features/<feature>/  # <feature>.routes.ts, pagine, componenti, accesso ai dati (httpResource/HttpClient)
  styles/                # design token, temi, base
  testing/               # helper e builder di dati per i test
```
- Il gruppo di lavoro è nell'URL (`/groups/:groupId/...`); PSA e dealer lo cambiano dal selettore del gruppo.
- Access token solo in memoria, refresh automatico su `401 TOKEN_EXPIRED` (`doc/Security-Model.md` §4).
- Configurazione pubblica (URL delle API) fornita all'avvio del container, nessun segreto nella build.
- In produzione: build statica servita da un server web non root con header di sicurezza e CSP.
- Test con Vitest e copertura al 100%.

## 6. Configurazione
Tutta da variabili d'ambiente, lette e validate in `backend/src/config.ts` all'avvio; qualunque valore mancante o non valido blocca l'avvio con un messaggio chiaro. In locale da `.env` (caricato con `process.loadEnvFile`, nativo di Node) non versionato; in produzione da secret manager. `.env.example` elenca i nomi senza valori.

## 7. Ruoli di esecuzione
La stessa applicazione può girare come **api** o come **worker** (job pianificati: code di invio ai provider, pulizie), scelto da configurazione; i job girano su una sola istanza. Si introducono quando un passo li richiede.

## 8. Qualità
- Copertura dei test al **100%** (righe, rami, funzioni), applicata da `npm test`.
- Codice, JSDoc e commenti in inglese; documentazione in `doc/` in italiano (`doc/Technical-Guide.md`, `doc/API.md`, `doc/Public-API.md` mantenuti a ogni passo).
- Nessun errore silenziato; risposte d'errore con envelope standard e senza dettagli interni.
