# Architettura

## 1. Contesto
```
App di backoffice ─────────── /v1  (token opachi) ───────┐
                                                         │
Server di punto vendita ───── /store/v1 (Ed25519) ───────┼──► Flood Cloud ──► MongoDB
  └─ casse, palmari, altri client locali                 │      (Node.js,      ├─ <env>_common
     (non parlano mai con il cloud)                      │       Express 5)    └─ <env>_<groupId>
                                                         │          │
Integrazioni di un gruppo ─── /public/v1 (API key) ──────┘          └──► provider esterni
                                                                         (fiscale, fatturazione, pagamenti…)
```
- Il cloud ha **tre client**, ognuno con la propria superficie API e la propria credenziale (`doc/Security-Model.md` §3).
- In ogni negozio c'è **un solo server di punto vendita** che centralizza casse e dispositivi: è l'unico che comunica con il cloud per quel negozio.

## 2. Stack
| Componente | Scelta |
|---|---|
| Runtime | Node.js 24 LTS, moduli ESM |
| HTTP | Express 5, `body-parser`, `compression`, `multer` |
| Database | MongoDB, driver ufficiale `mongodb` (nessun ODM) |
| Crittografia | `node:crypto` |
| Test | `node:test` + coverage nativa al 100%, `fetch` nativo, MongoDB reale |

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
- Il nome si costruisce in **un solo punto** del codice (`src/db/names.js`): il legacy lo ripeteva in circa 300 punti.
- `groupId` si valida come `ObjectId` prima di comporre il nome: nessun nome di database deriva da input non validato.

### 3.2 Cosa sta dove
| Common (identità, tenancy, sicurezza) | Database del gruppo (dati operativi) |
|---|---|
| `groups`, `users`, `companies`, `places` | catalogo (prodotti, reparti, categorie…) |
| `storeServers`, `storeServerActivations` | magazzino |
| `sessions`, `storeServerTokens`, `storeServerNonces` | vendite e documenti fiscali |
| `apiKeys`, `rateLimits`, `apiUsage`, `platformSettings` | clienti e fedeltà, prenotazioni… |
| `auditLog` | |

**Decisione del 2026-10-30:** `companies` e `places` passano nel **common** (nel legacy erano nei database dei gruppi e rendevano costose le liste trasversali, es. tutti i punti vendita di un dealer). La verifica di ogni credenziale e il calcolo dello scope avvengono interamente nel common, senza aprire il database del gruppo.

Il campo `databaseHost` del legacy (cluster dedicato per gruppo) è **eliminato**: tutti i database stanno sullo stesso cluster.

Schema delle collection del common: `doc/Data-Model.md`. I domini operativi si documentano quando vengono affrontati.

### 3.3 Accesso
- Un solo `MongoClient` per processo; il database del gruppo si ottiene dal contesto della richiesta (`req.auth`), mai da parametri del client.
- I repository dei dati di gruppo ricevono il `Db` del gruppo già risolto e non possono aprirne altri.
- Le transazioni tra common e database del gruppo sono possibili sullo stesso cluster (replica set) e si usano solo dove serve atomicità.

## 4. Superfici API
| Superficie | Prefisso | Credenziale | CORS | Note |
|---|---|---|---|---|
| Backoffice | `/v1` | Bearer `fc_at_…` + refresh | allowlist origini del backoffice | ruoli PSA, D, SA, CA, PA |
| Store | `/store/v1` | Bearer `fc_st_…` ottenuto con firma Ed25519 | chiuso | scope fisso sul punto vendita; `Idempotency-Key` sulle scritture |
| Pubblica | `/public/v1` | `X-Api-Key: fc_pk_…` | chiuso | scope sul gruppo; rate limit e quote |

Lo stesso dominio (es. prodotti) può essere esposto su più superfici con permessi e campi diversi: il service è unico, cambiano route, autenticazione e mapper di risposta. Le regole REST sono in `doc/API-Guidelines.md`; il riferimento degli endpoint in `doc/API.md`.

## 5. Struttura del codice
```
src/
  server.js              # unico punto con process.env, connessione DB, listen, arresto ordinato
  app.js                 # createApp(deps): app Express senza effetti collaterali
  config.js              # lettura e validazione della configurazione
  db/                    # client, nomi dei database, creazione indici
  shared/
    http/                # definizione route, envelope, errori, header, CORS, timeout
    security/            # token, hash, scrypt, Ed25519, policy RBAC, rate limit, audit
    validation/          # validatore per allowlist
  modules/<dominio>/     # routes, controller, service, repository, schemas, mapper, indexes
  integrations/<provider>/
test/
  unit/  integration/  helpers/
```
Pipeline di ogni route: **autenticazione → rate limit → autorizzazione → validazione → controller → service → repository**. Il builder delle route rifiuta all'avvio una route senza autenticazione dichiarata (skill `express-module-scaffold`).

## 6. Configurazione
Tutta da variabili d'ambiente, lette e validate in `src/config.js` all'avvio; qualunque valore mancante o non valido blocca l'avvio con un messaggio chiaro. In locale da `.env` (caricato con `process.loadEnvFile`, nativo di Node) non versionato; in produzione da secret manager. `.env.example` elenca i nomi senza valori.

## 7. Ruoli di esecuzione
La stessa applicazione può girare come **api** o come **worker** (job pianificati: code di invio ai provider, pulizie), scelto da configurazione; i job girano su una sola istanza. Si introducono quando un passo li richiede.

## 8. Qualità
- Copertura dei test al **100%** (righe, rami, funzioni), applicata da `npm test`.
- JSDoc in italiano su ogni export; codice in inglese.
- Nessun errore silenziato; risposte d'errore con envelope standard e senza dettagli interni.
