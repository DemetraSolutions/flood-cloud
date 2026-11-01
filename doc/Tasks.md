# Piano dei Task

> Piano di lavoro di Flood Cloud diviso per aree (entità principali) e sottoaree.
> - `[ ]` da fare · `[x]` completato.
> - Ogni task ha un identificativo stabile `<area>.<sottoarea>.<n>`: non si rinumera; i nuovi task si aggiungono in coda alla sottoarea.
> - Un task si spunta solo quando il codice funziona, i test sono al 100% con typecheck verde, la documentazione è aggiornata (skill `docs-sync-checklist`) e l'utente ha confermato (`GEMINI.md` §1).
> - Le decisioni `D-nn` (§0.4) vanno prese **prima** dei task che le citano.
> - Fonti: `doc/` del progetto e analisi del 2026-11-01 di `cloud-commerce-platform-server` e `cloud-commerce-backoffice-client`.
> - Stato al 2026-11-01: area 1 (fondamenta di backend e backoffice) completata.

## Indice
0. [Decisioni e coesistenza con il legacy](#0-decisioni-e-coesistenza-con-il-legacy)
1. [Fondamenta](#1-fondamenta)
2. [Sicurezza trasversale](#2-sicurezza-trasversale)
3. [Autenticazione e utenti](#3-autenticazione-e-utenti)
4. [Gruppi](#4-gruppi)
5. [Aziende e punti vendita nel common: migrazione e sincronizzazione](#5-aziende-e-punti-vendita-nel-common-migrazione-e-sincronizzazione)
6. [Aziende](#6-aziende)
7. [Punti vendita](#7-punti-vendita)
8. [Onboarding di un nuovo cliente](#8-onboarding-di-un-nuovo-cliente)
9. [API pubbliche](#9-api-pubbliche-publicv1)
10. [Aree successive](#10-aree-successive-da-dettagliare)

---

## 0. Decisioni e coesistenza con il legacy

### 0.1 Contesto
- Il nuovo backend lavora sullo **stesso cluster MongoDB Atlas del legacy**: con `APP_ENV=development` usa `development_common` e `development_<groupId>`. Sullo stesso cluster ci sono anche i database `production_*`.
- Il legacy resta attivo sugli stessi database durante tutta la transizione: backend, backoffice, POS e `ms-integration-service`.
- `users` e `groups` del common sono **condivisi** con il legacy e hanno lo schema legacy: booleani `status`/`trash`, `userName`, hash `password`, `tokens[]`, `companyId`/`placeId`/`placesId`, `settings` e `permissions` liberi. Il modello attuale di `doc/Data-Model.md` non è compatibile con questi documenti.
- `companies` e `places` oggi stanno nei database dei gruppi. Il legacy li legge anche con `$lookup` (statistiche, log, documenti, POS), quindi le copie nei database dei gruppi devono restare finché il legacy è attivo.
- Nel legacy l'ambiente si chiama `NODE_ENV` (default `development`), il prefisso `DB_COLLECTION_PREFIX` è vuoto e i nomi sono `<env>_common`, `<env>_<groupId>`, `<env>_flite_common`, `<env>_queue`.
- Le nuove collection previste nel common non collidono con quelle del legacy, tranne `users` e `groups`, che sono condivise per scelta.

### 0.2 Regole di coesistenza (D-03, decise)
1. **Modello di dominio pulito nel codice, documenti legacy intatti.** La traduzione legacy ↔ dominio avviene solo nei repository (strato anticorruzione). Nessun tipo legacy esce dal repository.
2. Sui documenti legacy si scrive solo con `$set`/`$unset` dei campi posseduti. Mai `replaceOne`, mai rimozione, rinomina o cambio di tipo di un campo legacy.
3. Sulle collection condivise niente `$jsonSchema` e niente indici univoci senza profilazione dei dati e decisione esplicita: bloccherebbero le scritture del legacy.
4. I nuovi dati di sicurezza (hash scrypt, blocco, sessioni) stanno in **collection nuove**, mai nei documenti legacy.
5. **Lettura tollerante, scrittura rigorosa.** Un documento legacy non valido si legge con i campi sani e si segnala (log e report). Non si scarta in silenzio e non si "corregge" in automatico. Le scritture nuove si validano per allowlist.
6. `groupId` sempre dal contesto autenticato o dal nome del database, mai dal campo del documento (nel legacy il `groupId` di un place arriva dal body del client).
7. Ogni scrittura su dati letti anche dal legacy è coperta da test con fixture in formato legacy reale, rese anonime.

### 0.3 Strategia per companies e places (D-01, decisa)
**Doppia scrittura nel legacy, in transazione, più caricamento iniziale e riconciliazione periodica.** Decisione dell'utente del 2026-11-01. L'alternativa con i change stream è stata valutata e scartata.

| Fase | Fonte di verità | Chi scrive | Copia nel common |
|---|---|---|---|
| 1. Solo lettura dal nuovo backend | database del gruppo | solo il legacy, che scrive database del gruppo **e** common nella stessa transazione | aggiornata dal legacy a ogni scrittura; il nuovo backend fa il caricamento iniziale e la riconciliazione |
| 2. Gestione dal nuovo backoffice | database del gruppo (invariato) | legacy e nuovo backend, ognuno su entrambe le copie in transazione | aggiornata da entrambi |
| 3. Dismissione del legacy | common | solo il nuovo backend | copie nei database dei gruppi rimosse |

Come funziona la doppia scrittura nel legacy:
1. **Un solo blocco di copia, indipendente dalla query.** Avvolge ogni scrittura su companies e places: 5 punti per entità in 3 file, compreso `groups/generate`. Non replica la query del client: dopo la scrittura **rilegge il documento intero** dal database del gruppo e lo riscrive nel common (D-20). Passi, nella stessa transazione:
   - **prima della scrittura** legge gli `_id` coinvolti con lo stesso filtro della richiesta. Serve con `updateOne`, `updateMany` e `deleteMany`, che accettano filtri arbitrari. Per `insertOne` basta l'id inserito. `updateOne` si esegue poi sull'`_id` trovato, così il documento scritto è certo;
   - esegue la scrittura originale, invariata;
   - rilegge per `_id` i documenti interi e li riscrive nel common con `replaceOne` e upsert. Il `groupId` si imposta **sempre** dal nome del database, non solo se manca: oggi il `groupId` di un place arriva dal client e può essere diverso. La discordanza si segnala;
   - per le cancellazioni rimuove la copia (D-21).
2. **Transazione su entrambi i database** (stesso replica set Atlas): scrittura originale e copia riescono o falliscono insieme.
   - Le scritture concorrenti sullo stesso documento, per esempio backoffice e POS sullo stesso punto vendita, vengono serializzate dai conflitti di scrittura e ritentate da `withTransaction`.
   - Ogni operazione deve passare la `session`: oggi il legacy spesso la dimentica.
3. **`$out` e `$merge` bloccati** nelle `aggregate` del legacy: è anche una correzione di sicurezza, e senza blocco una scrittura sfuggirebbe alla copia.
4. **Riconciliazione obbligatoria dal nuovo backend**: confronta e ripara le copie. Copre i percorsi che la doppia scrittura non vede: modifiche da Compass o da script manuali, punti di scrittura dimenticati, bug.

Rischi accettati:
- modifiche a un codice senza test, rilasciate in produzione;
- latenza leggermente maggiore delle scritture;
- se la copia fallisce, fallisce anche il salvataggio dell'utente: nessuna divergenza, ma un errore visibile;
- con il documento intero, le credenziali dei punti vendita (integrazioni, casse automatiche) sono duplicate nel common. Il nuovo backend non le legge mai (proiezioni in allowlist); i rispettivi domini le sposteranno in un archivio cifrato.

Non si usa una migrazione automatica all'avvio dell'API: le repliche sono più d'una, l'avvio diventerebbe lento, il deploy resterebbe legato ai dati e un errore a metà non si potrebbe controllare.

### 0.4 Decisioni
- [x] **D-01** Strategia di migrazione e sincronizzazione di companies e places: doppia scrittura nel legacy in transazione, con caricamento iniziale e riconciliazione (§0.3). Decisione dell'utente del 2026-11-01.
- [x] **D-02** Credenziali del database: le stesse credenziali Atlas del legacy, in un `.env` locale non versionato; in produzione da secret manager. Con queste credenziali si può scrivere anche su `production_*`: la protezione è la guardia nel codice sui nomi dei database (1.3.3), obbligatoria prima di qualunque scrittura. Decisione dell'utente del 2026-11-01.
- [x] **D-03** Coesistenza su `users` e `groups` con le regole di §0.2: il formato dei documenti resta quello attuale. I dati di sicurezza stanno in collection proprie (`userCredentials`, `sessions`), anche dopo la dismissione del legacy. Motivo: il legacy restituisce ai client e lascia modificare quasi tutto il documento utente, e la funzione "Duplica" lo copia per intero. `doc/Data-Model.md` va rivisto di conseguenza (0.5.3). Decisione dell'utente del 2026-11-01.
- [x] **D-04** Le password legacy (HMAC-SHA512 con pepper globale, senza salt) continuano a funzionare, sia nel nuovo backend sia nel legacy (2.2). Decisione dell'utente del 2026-11-01.
  - il nuovo backend verifica l'hash legacy con il pepper;
  - al cambio password scrive anche l'hash legacy finché il legacy è attivo;
  - a ogni login riuscito calcola anche l'hash scrypt, che servirà al passaggio definitivo.
- [x] **D-05** Dati personali (`email`, `telephone`, `name`, `surname`) in chiaro. Se la profilazione trova valori ancora cifrati con il formato legacy, si decifrano e si riscrivono in chiaro con una migrazione una tantum (2.2.4). Decisione dell'utente del 2026-11-01.
- [ ] **D-06** Permessi per utente (`permissions.<modulo>.{r,w}` e `permissions.status`, `doc/Security-Model.md` §12.5). *Raccomandato in transizione:* permessi effettivi = permessi del ruolo ∩ matrice dell'utente. `permissions.apps.cash.*` resta del dominio cassa: conservato, mai esposto su `/v1`.
- [ ] **D-07** Ruoli:
  - `X` e `L` non esistono (correggere `doc/Legacy-Analysis.md`);
  - ruolo `API`: eliminarlo, perché lo sostituiscono le API key pubbliche (raccomandato);
  - utenti `E`: niente accesso al backoffice (`doc/Security-Model.md` §4). Oggi vedono il Calendario: confermare.
- [ ] **D-08** Scope multipli. Il legacy ha un solo `companyId` per CA e `placeId` (singolo) più `placesId[]`. *Raccomandato:* modello con array; finché il legacy è attivo CA limitato a una azienda e PA scritto come `placeId` = primo elemento, `placesId` = tutti.
- [ ] **D-09** Dealer. Oggi il dealer è un utente `D` e `groups.dealerId` è l'`_id` di quell'utente: questo chiude la domanda 1 di `doc/Data-Model.md`. Serve un'anagrafica dealer con più utenti?
- [ ] **D-10** PSA e D nei moduli operativi di un gruppo. *Raccomandato:* contesto di gruppo nell'URL con audit (`doc/Security-Model.md` §8.2), al posto del multi-account del legacy.
- [ ] **D-11** Sessioni legacy. *Raccomandato:*
  - il nuovo backend non accetta i JWT legacy;
  - disattivazione dell'utente, cambio password e cambio di ruolo svuotano anche `users.tokens[]`, così il legacy disconnette subito.
- [ ] **D-12** Trasporto del refresh token: cookie `HttpOnly` (raccomandato) o body (`doc/Security-Model.md` §12.1).
- [ ] **D-13** Feature flag del gruppo:
  - conferma dell'elenco (4.1);
  - `delivery` e `customersApp`, oggi nascosti: si vendono ancora?
  - `autoDepartments` e `advancedProducts`: diventano modificabili?
  - `plan`, `type` ed `expirationDate` del gruppo sono deprecati;
  - i flag valgono anche per PSA e D?
- [ ] **D-14** Cancellazione: cestino (`trash`) sempre; eliminazione definitiva solo PSA o mai finché il legacy è attivo (raccomandato: mai).
- [ ] **D-15** Univocità di `username` e `vatNumber`: globale o per gruppo, decisa sui dati reali dopo la profilazione (1.3.6).
- [x] **D-16** Valori ammessi di `APP_ENV`: `development` e `production`, come i database esistenti. Decisione dell'utente del 2026-11-01.
- [ ] **D-17** Login: solo `username` (come `doc/Security-Model.md` §4) oppure anche email e telefono, come oggi nel legacy.
- [ ] **D-18** Onboarding: preset per tipologia (risto, retail, beauty) e struttura minima del database di un gruppo nuovo richiesta dal legacy.
- [ ] **D-19** Policy delle password: lunghezza minima e massima, eventuali classi di caratteri (oggi 8–16 caratteri con classi, imposta solo dal client).
- [x] **D-20** Forma della copia nel common: **documento intero** del database del gruppo, con `groupId` impostato dal nome del database. Proposta dell'utente del 2026-11-01. Il nuovo backend traduce i nomi legacy nel modello di dominio (§0.2, tabelle 6.1 e 7.1).
- [ ] **D-21** Cancellazione definitiva nel legacy (`deleteMany` dal cestino): la copia nel common si rimuove (raccomandato: la copia resta uno specchio esatto) oppure si marca come cancellata. Collegata a D-14.
- [x] **D-22** Il server di punto vendita è un'applicazione separata, fuori dallo scope: questo progetto comprende solo il backend cloud e il backoffice. Decisione dell'utente del 2026-11-01.
- [x] **D-23** Nessuna superficie dedicata al server di punto vendita: l'app separata usa le stesse API del backoffice (`/v1`). La superficie `/store/v1` prevista da `doc/Architecture.md` §4 e `doc/Security-Model.md` §3 e §5 è eliminata. Decisione dell'utente del 2026-11-01.
- [ ] **D-24** Credenziale con cui l'app del server di punto vendita chiama le API `/v1`. Va decisa quando si integra l'app; oggi usa l'API key del gruppo, condivisa da tutti i negozi. Opzioni:
  - **login di un utente:** il refresh scade dopo 7 giorni di inattività o 30 di durata massima, quindi il negozio resta bloccato dopo un lungo offline; la password resta salvata sul server del negozio; gli utenti `E` non sono ammessi;
  - **credenziale di dispositivo per punto vendita**, accettata dalle stesse route con scope fisso sul punto vendita.

### 0.4.1 Esiti della profilazione (1.3.6, 2026-11-01)
Profilazione in sola lettura di `development_*` e, con consenso esplicito dell'utente, di `production_*` (MongoDB 8.0.34). Dati aggregati, senza valori. Servono a prendere le decisioni aperte, non le sostituiscono.
- **Volumi in produzione:** 8711 utenti, 1267 gruppi, 1268 database di gruppo (1 gruppo senza database, 2 database senza gruppo), 1362 aziende, 1655 punti vendita. `development` contiene solo 9 utenti e 3 gruppi: non è rappresentativo.
- **D-04:** tutte le 8711 password sono HMAC-SHA512 (128 hex): nessuna in chiaro.
- **D-05:** nessun dato personale cifrato col formato legacy: la migrazione 2.2.4 non serve. Email presenti solo in 650 utenti, telefoni in 1471.
- **PIN:** in chiaro; 4039 numerici di 4–8 cifre, 2415 in altri formati, 2257 assenti.
- **D-07:** ruoli in uso SA 3940, E 2513, PA 2058, CA 194, D 5, PSA 1. Nessun utente `API`, `X` o `L`.
- **D-08:** E quasi sempre con `placesId` (2350) e a volte `placeId` (799); PA con `placeId` (2047) e a volte `placesId` (301); 8 CA senza `companyId`; SA con `companyId` (141), `placeId` (54) o `placesId` (91) residui. Riferimenti orfani: `companyId` 2, `placeId` 10, `placesId` 6.
- **D-09:** 3 gruppi con `dealerId` che non è un utente `D`; 2 gruppi con `dealerId` null e 3 senza.
- **D-13:** `groups.type` quasi sempre null (924) o vuoto (63), `basic` 280; `groups.plan` advanced 496, basic 174, enterprice 7, null 137. `places.plan` anche `professional`, `desk-secondary`, `tgm-secondary`. Tipi di dispositivo: desk, handheld, selfordering, room-handheld, palmare (56, valore storico), external-display, kiosk, waiting-list, tgm, ordering.
- **D-15:** `userName` univoco in modo esatto (indice `userName_1` unique), ma 110 valori duplicati ignorando le maiuscole (239 utenti, 225 non nel cestino). `companies.code`: 143 valori condivisi tra gruppi diversi, 13 duplicati nello stesso gruppo (11 gruppi).
- **D-17:** email duplicate (124 valori, 571 utenti) e telefoni duplicati (260 valori, 1256 utenti): il login con email o telefono sarebbe ambiguo.
- **Coerenza:** `groupId` di aziende e punti vendita sempre uguale al database; `places.companyId` senza orfani. `tokens[]` con 213 elementi nel formato stringa vecchio.
- **Indici esistenti:** solo `_id_` ovunque, più `userName_1` (unique) su `users`.

### 0.5 Documentazione da aggiornare (richiede la richiesta esplicita dell'utente, `GEMINI.md` §7)
- [ ] **0.5.1** `doc/Legacy-Analysis.md`, correzioni:
  - i ruoli `X` e `L` non esistono, esiste `API`;
  - il JWT scade dopo `TOKEN_DURATION_DAYS` giorni;
  - `databaseHost` apre un client per ogni richiesta;
  - `ms-integration-service` lavora sugli stessi database;
  - l'ambiente si chiama `NODE_ENV`.
- [ ] **0.5.2** `doc/Architecture.md` §3: coesistenza con il legacy e strategia di sincronizzazione (D-01, D-03).
- [ ] **0.5.3** `doc/Data-Model.md`:
  - `users` e `groups` compatibili con i documenti legacy;
  - `companies` e `places` nel common come copie dei documenti dei gruppi (D-20);
  - nuove collection `userCredentials` e `syncIssues`;
  - risposte alle domande aperte.
- [ ] **0.5.4** `doc/Security-Model.md`: compatibilità di password e dati personali legacy (D-04, D-05), sessioni legacy (D-11).
- [ ] **0.5.5** `GEMINI.md` e `AGENTS.md`: aggiungere `doc/Tasks.md` alla tabella dei documenti.
- [ ] **0.5.6** `doc/Product-Scope.md`, `doc/Architecture.md` §4, `doc/Security-Model.md` §3 e §5, `doc/Data-Model.md` (collection `storeServer*`): eliminare la superficie `/store/v1` e indicare che l'app del server di punto vendita è separata e usa le API `/v1` (D-22, D-23, D-24).

### 0.6 Rischi del legacy in produzione (fuori da questo repository)
- [ ] **0.6.1** Valutare la rotazione delle credenziali Atlas: oggi sono scritte nel repository legacy (ConfigMap, `launch.json`). Dopo una rotazione vanno aggiornati il legacy e il `.env` locale (D-02).
- [ ] **0.6.2** Valutare correzioni urgenti nel legacy:
  - `signup` pubblico, che crea utenti con qualsiasi ruolo;
  - con la sola API key di un POS si elencano tutti i gruppi con le loro API key e si modificano utenti di altri tenant;
  - `?groupId=` di un dealer non verificato;
  - un gruppo sospeso esegue comunque le richieste.

---

## 1. Fondamenta

### 1.1 Progetto backend
- [x] **1.1.1** `backend/package.json`: ESM, Node 24, dipendenze approvate a versione esatta, `package-lock.json` versionato.
- [x] **1.1.2** `tsconfig.json` per il type stripping (sintassi cancellabile, import con estensione `.ts`, `noEmit`) e script `typecheck`.
- [x] **1.1.3** Script `test` con `node --test` e coverage nativa con soglie al 100% di righe, rami e funzioni.
- [x] **1.1.4** `.env.example` con i soli nomi delle variabili, `.env` ignorato da git.
- [x] **1.1.5** Pipeline `backend.yml` filtrata su `backend/**`: typecheck, test, `npm audit`, secret scanning. *Disattivata per decisione dell'utente del 2026-11-01 (solo avvio manuale); il secret scanning locale è garantito dall'hook pre-commit gitleaks.*

### 1.2 Configurazione
- [x] **1.2.1** `config.ts`: lettura e validazione di tutte le variabili, errore chiaro e arresto se qualcosa manca; `.env` caricato con `process.loadEnvFile` solo in locale.
- [x] **1.2.2** `APP_ENV` obbligatoria, in allowlist (D-16), con valori identici a quelli dei database legacy.
- [x] **1.2.3** Variabili `MONGODB_URI`, `DB_NAME_PREFIX` (vuoto per i database attuali), porta, `TRUST_PROXY`, origini CORS, durate di token e sessioni.
- [x] **1.2.4** Segreti di compatibilità legacy:
  - pepper delle password (D-04), necessario all'applicazione;
  - chiave di decifratura dei dati personali (D-05), solo per lo script 2.2.4 e mai nella configurazione dell'applicazione.

  In locale stanno nel `.env`, in produzione nel secret manager. Mai loggati, mai valori in `.env.example`.

### 1.3 Database sul cluster condiviso
- [x] **1.3.1** Un solo `MongoClient` per processo, con `retryWrites`, `w: majority`, timeout e chiusura ordinata.
- [x] **1.3.2** `db/names.ts`: unico punto di costruzione dei nomi dei database; `groupId` validato come ObjectId.
- [x] **1.3.3** Guardia d'ambiente: rifiuto di qualunque database che non corrisponda a `^<prefix><APP_ENV>_(common|[0-9a-f]{24})$`. Protegge `production_*` quando si lavora con `APP_ENV=development`.
- [x] **1.3.4** Registro della proprietà delle collection, verificato da test:
  - collection nuove;
  - collection legacy in sola lettura;
  - collection legacy scrivibili, con l'elenco dei campi posseduti.
- [x] **1.3.5** Creazione idempotente degli indici solo sulle collection nuove; sulle collection condivise solo indici non univoci approvati.
- [x] **1.3.6** Script di profilazione **in sola lettura** dei database `development_*` (`users`, `groups`, `companies`, `places`, `countries`):
  - conteggi, campi presenti e loro tipi, valori degli enum (ruoli, piani, flag);
  - duplicati di `userName` ed `email`;
  - dati personali cifrati e in chiaro;
  - `groupId` dei documenti diverso da quello del database, riferimenti orfani;
  - indici esistenti (`getIndexes()`).

  L'output non contiene dati personali.
- [x] **1.3.7** Fixture di test in formato legacy derivate dalla profilazione, sintetiche e senza dati reali.

### 1.4 HTTP, errori e osservabilità
- [x] **1.4.1** `createApp(deps)` senza effetti collaterali; `server.ts` unico punto con `process.env`, connessione e `listen`.
- [x] **1.4.2** Envelope `{ data }`, `{ data, page }`, `{ error }`, classe `AppError` con i codici di `doc/API-Guidelines.md` §5 e gestore centrale senza stack trace.
- [x] **1.4.3** `400 MALFORMED_JSON`, `413`, `415`, `404`, `405` con header `Allow`; limiti di dimensione del body per route.
- [x] **1.4.4** Header di sicurezza (`doc/Security-Model.md` §10), niente `X-Powered-By`, CORS in allowlist solo su `/v1`.
- [x] **1.4.5** `X-Request-Id` e log strutturati con redazione di token, password, header `Authorization` e `X-Api-Key`, dati personali.
- [x] **1.4.6** Timeout delle richieste, `trust proxy` sul numero esatto di proxy, arresto ordinato su `SIGTERM`.
- [x] **1.4.7** Builder delle route che rifiuta all'avvio una route senza autenticazione dichiarata.
- [x] **1.4.8** Endpoint di liveness e readiness per GKE (readiness con ping del database), dichiarati esplicitamente anonimi. Readiness con `ping` sul database common.

### 1.5 Validazione dell'input e liste
- [ ] **1.5.1** Validatore per allowlist (skill `input-validation`):
  - controlla tipi, lunghezze, enum, ObjectId e date;
  - rifiuta le proprietà sconosciute e le chiavi con `$` o `.`;
  - risponde `422` con dettagli per campo.
- [ ] **1.5.2** Parametri delle liste: `limit` (default 50, massimo 200), `cursor` opaco, `sort` in allowlist, ricerca `q` con escape della regex lato server e lunghezza limitata.
- [ ] **1.5.3** Paginazione a cursore con ordinamento stabile (spareggio su `_id`), ordinamento applicato **prima** della pagina (nel legacy i punti vendita erano ordinati solo dentro la pagina).
- [ ] **1.5.4** Supporto a `ETag` e `If-None-Match` (`304`) per le liste compatte usate come cache dal backoffice.

### 1.6 Infrastruttura di test del backend
- [x] **1.6.1** MongoDB locale usa e getta (docker compose, replica set a un nodo per le transazioni), database `test_<casuale>` con pulizia.
- [x] **1.6.2** Guardia della suite: rifiuta URI non locali e database con prefisso d'ambiente reale (`development_`, `production_`…).
- [x] **1.6.3** Helper HTTP con `fetch` su porta effimera e builder di documenti legacy e di dominio.

### 1.7 Progetto backoffice
- [x] **1.7.1** `ng new` Angular 22: standalone, zoneless, OnPush di default, strict, struttura `core/`, `shared/ui/`, `features/`.
- [x] **1.7.2** Vitest con `@angular/build:unit-test` e soglie al 100% in `angular.json`.
- [x] **1.7.3** Configurazione pubblica (URL delle API) letta all'avvio del container, nessun segreto nella build.
- [x] **1.7.4** Accesso HTTP di base: tipi dell'envelope, mappatura degli errori del backend, `X-Request-Id`.
- [x] **1.7.5** Pipeline `backoffice.yml` filtrata su `backoffice/**`; Dockerfile con server statico non root, header di sicurezza e CSP. *Server statico Node scritto da noi, senza dipendenze (decisione dell'utente). Pipeline disattivata come quella del backend.*

### 1.8 Design system e shell del backoffice
- [x] **1.8.1** Design token, tema chiaro e scuro.
- [x] **1.8.2** Componenti condivisi: pulsante, campo, tabella, dialog, toast, badge, stati vuoto, caricamento ed errore.
- [x] **1.8.3** Shell: layout, menu costruito da configurazione (permessi e feature, 3.5.4 e 4.5.2), pagine 403, 404 ed errore. *Il filtro del menu c'è; i predicati di permessi e feature si collegano con 3.5.4 e 4.5.2.*
- [x] **1.8.4** Accessibilità WCAG 2.2 AA: tastiera, focus, contrasto, annunci.

---

## 2. Sicurezza trasversale

### 2.1 Primitive crittografiche (`node:crypto`)
- [ ] **2.1.1** Generazione dei segreti: prefisso più 32 byte casuali in base64url (`fc_at_`, `fc_rt_`, …), hash SHA-256 a riposo, ricerca per indice univoco.
- [ ] **2.1.2** Confronto a tempo costante (`timingSafeEqual`) per ogni segreto.
- [ ] **2.1.3** scrypt: hash, verifica e necessità di rehash nel formato `scrypt$N$r$p$salt$hash`; policy delle password (D-19).

### 2.2 Compatibilità con le credenziali legacy (D-04, D-05)
- [ ] **2.2.1** Verifica dell'hash legacy delle password (HMAC-SHA512 con pepper) a tempo costante.
- [ ] **2.2.2** Al login riuscito, hash scrypt in `userCredentials` insieme all'impronta (SHA-256) dell'hash legacy da cui deriva. Ai login successivi:
  - se l'impronta coincide con l'hash legacy attuale, si verifica con scrypt;
  - se non coincide, la password è stata cambiata dal legacy: si verifica l'hash legacy e si ricalcola scrypt.
- [ ] **2.2.3** Cambio password: scrittura di scrypt più hash legacy finché il flag di coesistenza è attivo; flag da spegnere al passaggio definitivo.
- [ ] **2.2.4** Migrazione una tantum dei dati personali cifrati (D-05). Se la profilazione (1.3.6) trova valori nel formato `<hex>$<ivhex>`, uno script li decifra e li riscrive in chiaro con `$set`. Prevede una modalità di prova e un report; un valore non decifrabile si segnala, senza sovrascriverlo.
- [ ] **2.2.5** Verifica con il `legacy_analyst` che il legacy non cifri più i dati personali in scrittura; se lo fa ancora, la cifratura va disattivata nel legacy prima della migrazione 2.2.4.

### 2.3 RBAC
- [ ] **2.3.1** Catalogo dei permessi `risorsa:azione` dei domini core: `users`, `groups`, `companies`, `places`, `sessions`, `auditLog`.
- [ ] **2.3.2** Policy centralizzata ruolo → permessi; ogni route dichiara il permesso richiesto; test della matrice completa ruolo × permesso.
- [ ] **2.3.3** Restrizioni per utente (D-06): mappatura delle chiavi legacy `permissions.<modulo>.{r,w}` e calcolo dei permessi effettivi.
- [ ] **2.3.4** Requisito di feature del gruppo dichiarabile sulla route (4.2.2): una route di un modulo spento risponde `403`.

### 2.4 Scope e isolamento dei tenant
- [ ] **2.4.1** Calcolo dello scope alla verifica della credenziale:
  - PSA: tutto;
  - D: i gruppi con il proprio `dealerId`;
  - SA: il proprio gruppo;
  - CA: le proprie aziende;
  - PA: i propri punti vendita.
- [ ] **2.4.2** Contesto `req.auth` tipizzato; helper dei repository che applicano lo scope a ogni query; database del gruppo risolto dal contesto.
- [ ] **2.4.3** `groupId` nel percorso verificato contro lo scope, `404` fuori scope; audit degli accessi di PSA e D a un gruppo.
- [ ] **2.4.4** Regola anti-escalation: si gestiscono solo utenti di ruolo inferiore (PSA > D > SA > CA > PA > E) e dentro il proprio scope; nessuno modifica il proprio ruolo o scope.
- [ ] **2.4.5** Modello di test di isolamento riusabile per ogni endpoint: altro gruppo, altro dealer, CA fuori azienda, PA fuori punto vendita.

### 2.5 Rate limit
- [ ] **2.5.1** Collection `rateLimits` con contatori a finestra fissa, `$inc` atomico con upsert e TTL.
- [ ] **2.5.2** Header `RateLimit-*`, `429 RATE_LIMITED` con `Retry-After`.
- [ ] **2.5.3** Soglie per login (per IP e per username), refresh e verifica della disponibilità dello username.

### 2.6 Registro delle attività, audit e monitor degli errori
Decisione dell'utente del 2026-11-01: una sola collection nuova nel common per attività degli utenti, eventi di sicurezza ed errori, consultabile da un monitor del backoffice. La collection `logs` del legacy resta intatta. Gli errori si scrivono anche su stdout, così non si perdono se MongoDB non risponde.
- [ ] **2.6.1** Collection `activityLog` (al posto di `auditLog`) con categoria `data` | `security` | `error`, gruppo, attore, azione, risorsa, esito, `requestId`; indici `groupId + at`, `actor.id + at`, `category + at`, `requestId`; servizio di scrittura senza segreti.
- [ ] **2.6.2** Eventi:
  - login riusciti e falliti;
  - refresh e riuso rilevato;
  - revoche;
  - cambi di ruolo, scope e stato;
  - accessi di PSA e D ad altri gruppi;
  - sospensioni.
- [ ] **2.6.3** Durata di conservazione con TTL, eventualmente diversa per categoria (`doc/Security-Model.md` §12.6; il legacy teneva 90 giorni).
- [ ] **2.6.4** Registro delle scritture (inserimenti, modifiche, cancellazioni): chi, quando, risorsa e campi cambiati con valore precedente e nuovo; dei campi sensibili (password, token, credenziali) solo il nome. Scritto dallo strato service, mai dai controller. Le letture non si registrano.
- [ ] **2.6.5** Errori del backend nel registro, collegati a `requestId` e utente; un fallimento della scrittura non blocca la risposta e resta su stdout.
- [ ] **2.6.6** Endpoint per ricevere gli errori JavaScript del backoffice, con validazione, limiti di dimensione e rate limit.
- [ ] **2.6.7** Monitor nel backoffice: elenco filtrabile per gruppo, utente, categoria, periodo e `requestId`, con permesso dedicato.

### 2.7 Chiusura
- [ ] **2.7.1** Revisione del `security_expert` sulle aree 2.1–2.6.
- [ ] **2.7.2** `doc/Technical-Guide.md` §8 e `doc/Data-Model.md` aggiornati; conferma dell'utente.

---

## 3. Autenticazione e utenti

### 3.1 Modello utente
Modello di dominio ↔ documento legacy `<env>_common.users` (D-03):

| Campo di dominio | Tipo | Campo legacy | Regole |
|---|---|---|---|
| `id` | string | `_id` | ObjectId |
| `username` | string | `userName` (in subordine `username`) | obbligatorio; univocità decisa con D-15 |
| `firstName`, `lastName` | string \| null | `name`, `surname` | in chiaro (D-05) |
| `email` | string \| null | `email` | formato email; in chiaro |
| `phone` | string \| null | `telephone` | in chiaro |
| `role` | `PSA` \| `D` \| `SA` \| `CA` \| `PA` \| `E` (\| `API`, D-07) | `role` | se assente vale `E`, come nel legacy |
| `groupId` | string \| null | `groupId` | null solo per PSA e D |
| `dealerId` | string \| null | `dealerId` | `_id` dell'utente D di riferimento |
| `companyIds` | string[] | `companyId` (singolo) | CA: almeno una (cardinalità D-08) |
| `placeIds` | string[] | `placeId` + `placesId[]` | PA ed E: almeno uno |
| `status` | `active` \| `disabled` | `status` (booleano) | |
| `trashed` | boolean | `trash` (booleano) | cestino |
| `language` | string | `settings.language` | oggi solo `it` |
| `hiddenInStats` | boolean | `settings.hiddenInStats` | |
| `permissions` | restrizioni per modulo | `permissions.<modulo>.{r,w}`, `permissions.status` | D-06 |
| `createdAt`, `updatedAt` | Date | `insertDate`, `updateDate` | |

- **Conservati e mai esposti su `/v1`:**
  - `password`, `pin`, `tokens[]`;
  - `permissions.apps.cash.*` (dominio cassa);
  - `servicesId`, `shiftTime` (calendario);
  - `avatar` (oggi un data URL nel documento; dominio file).
- **Collection nuova `userCredentials`** (D-03, permanente): `_id` = `userId`, `passwordHash` (scrypt), `legacyHashFingerprint` (impronta dell'hash legacy da cui deriva, 2.2.2), `passwordChangedAt`, `failedLogins`, `lockedUntil`, `lastLoginAt`, `createdAt`, `updatedAt`.

Task:
- [ ] **3.1.1** Tipi `User` (dominio) e `LegacyUserDocument` (tutti i campi facoltativi, tipi reali dalla profilazione).
- [ ] **3.1.2** Mapper legacy → dominio con raccolta delle anomalie (ruolo sconosciuto, scope incoerente, dati non decifrabili).
- [ ] **3.1.3** Mapper dominio → aggiornamento legacy: solo `$set` dei campi posseduti, conversione di stato, cestino e scope (D-08).
- [ ] **3.1.4** Collection `userCredentials` con `$jsonSchema` e indici.
- [ ] **3.1.5** Mapper di risposta `/v1` con allowlist esplicita dei campi.
- [ ] **3.1.6** Indici su `users` verificati con `getIndexes()`; aggiunta dei soli indici non univoci approvati (`groupId + role`, `dealerId`).

### 3.2 Login e sessioni (backend)
- [ ] **3.2.1** `POST /v1/auth/login` con username e password (D-17) e risposta `INVALID_CREDENTIALS` identica per ogni fallimento. Rifiuta, con la stessa risposta:
  - utente disattivato o cestinato;
  - ruolo `E` o `API`;
  - gruppo sospeso o cestinato.
- [ ] **3.2.2** Blocco progressivo con `failedLogins` e `lockedUntil` in `userCredentials`.
- [ ] **3.2.3** Collection `sessions` con indici univoci sugli hash e TTL sulla scadenza del refresh.
- [ ] **3.2.4** Access token di 15 minuti; refresh con rotazione a ogni uso e rilevamento del riuso (revoca della famiglia e audit); scadenza per inattività e durata massima della famiglia.
- [ ] **3.2.5** `POST /v1/auth/refresh` e `POST /v1/auth/logout`; logout da tutti i dispositivi.
- [ ] **3.2.6** Trasporto del refresh token secondo D-12 (cookie `HttpOnly; Secure; SameSite=Strict; Path=/v1/auth` con verifica dell'`Origin`).
- [ ] **3.2.7** Middleware Bearer di `/v1`:
  - distingue `TOKEN_EXPIRED` da `UNAUTHENTICATED`;
  - a ogni richiesta ricontrolla lo stato di utente e gruppo, con proiezione minima: disattivato ⇒ `401` immediato, come nel legacy.
- [ ] **3.2.8** Revoca delle sessioni a cambio password, cambio di ruolo o scope, disattivazione dell'utente e sospensione del gruppo; svuotamento di `users.tokens[]` legacy (D-11).

### 3.3 Profilo e avvio della sessione
- [ ] **3.3.1** `GET /v1/me`, riletto a ogni avvio del backoffice. Restituisce:
  - profilo, ruolo, permessi effettivi, riepilogo dello scope;
  - per SA, CA e PA anche il contesto del gruppo (4.3).

  **Mai segreti**: il legacy restituiva l'intero gruppo con le API key e il PIN dell'utente.
- [ ] **3.3.2** `PATCH /v1/me`: nome, cognome, email, telefono, lingua.
- [ ] **3.3.3** Cambio della propria password: richiede la password attuale, revoca le altre sessioni, scrive secondo D-04.
- [ ] **3.3.4** Elenco e revoca delle proprie sessioni (dispositivo, IP, ultimo uso).

### 3.4 Gestione utenti (backend)
URL definitivi da concordare con `api_expert`: utenti di un gruppo sotto `/v1/groups/{groupId}/users`, elenco trasversale per PSA e D.
- [ ] **3.4.1** Elenco:
  - filtri per ruolo, stato, cestino, dealer e gruppo (solo PSA e D);
  - ricerca `q` su username, nome, cognome, email e telefono;
  - paginazione a cursore e ordinamenti in allowlist.
- [ ] **3.4.2** Dettaglio di un utente nello scope (`404` fuori scope).
- [ ] **3.4.3** Creazione:
  - ruolo inferiore a quello di chi crea e scope dentro il suo;
  - scope obbligatorio per ruolo (D-08);
  - username univoco (`409`, D-15);
  - password iniziale secondo la policy (D-19);
  - scrittura compatibile con il legacy (§0.2).
- [ ] **3.4.4** Modifica parziale: nessuna modifica del proprio ruolo o scope; i cambi di ruolo, scope o stato revocano le sessioni (3.2.8).
- [ ] **3.4.5** Reset della password di un utente subordinato, con revoca delle sue sessioni.
- [ ] **3.4.6** Attivazione e disattivazione.
- [ ] **3.4.7** Cestino e ripristino (`trash` legacy); eliminazione definitiva secondo D-14.
- [ ] **3.4.8** Verifica della disponibilità dello username, con rate limit (sostituisce il controllo a ogni tasto del legacy).
- [ ] **3.4.9** Test di isolamento (2.4.5) e di escalation su ogni endpoint.

### 3.5 Backoffice
- [ ] **3.5.1** Pagina di login (Signal Forms, errori accessibili, messaggio di rate limit).
- [ ] **3.5.2** Servizio di sessione:
  - access token solo in memoria;
  - refresh unico condiviso su `401 TOKEN_EXPIRED`;
  - ripristino della sessione all'avvio;
  - logout.
- [ ] **3.5.3** Avvio dell'app con `GET /v1/me`; stato della sessione a signal.
- [ ] **3.5.4** Guard `canMatch` per sessione e permesso, direttiva o helper `hasPermission` per menu e azioni (le route sono protette, non solo i menu come nel legacy).
- [ ] **3.5.5** Profilo, cambio password, elenco e revoca delle sessioni.
- [ ] **3.5.6** Elenco utenti: filtri nell'URL, paginazione a cursore, quattro stati della vista, selezione multipla con conferma.
- [ ] **3.5.7** Dettaglio, creazione e modifica dell'utente:
  - ruoli proposti in base a chi crea;
  - scope scelto dai dati di riferimento (4.5.3);
  - errori `422` e `409` sui campi.
- [ ] **3.5.8** Reset della password, disattivazione, cestino e ripristino dall'interfaccia.

### 3.6 Chiusura
- [ ] **3.6.1** `doc/API.md`, `doc/Technical-Guide.md`, `doc/Data-Model.md` (`users`, `userCredentials`, `sessions`, `rateLimits`, `auditLog`).
- [ ] **3.6.2** Revisione del `security_expert`; conferma dell'utente.

---

## 4. Gruppi

### 4.1 Modello gruppo
Modello di dominio ↔ documento legacy `<env>_common.groups`:

| Campo di dominio | Tipo | Campo legacy | Regole |
|---|---|---|---|
| `id` | string | `_id` | suffisso del database del gruppo |
| `name` | string | `name` | obbligatorio |
| `description` | string \| null | `description` | |
| `dealerId` | string \| null | `dealerId` | `_id` dell'utente D (D-09) |
| `status` | `active` \| `suspended` | `status` (booleano) | sospeso ⇒ credenziali del gruppo rifiutate |
| `trashed` | boolean | `trash` | |
| `demo` | boolean | `demo` | modificabile solo da PSA |
| `features` | `Record<Feature, boolean>` | `settings.<flag>` | default `false` (D-13) |
| `languages` | string[] | `settings.languages` (`"it;en"`) | codici ISO 639-1 |
| `statsSettings` | `{ openingTime, compressProductsCategories, timeSlots[] }` | `settings.stats` | |
| `integrations` | `Record<Provider, { enabled }>` | `settings.integrations.<p>.status` | le chiavi non sono mai esposte |
| `createdAt`, `updatedAt` | Date | `insertDate`, `updateDate` | |

- **Feature:** `cash`, `rooms`, `ordering`, `warehouse`, `tobaccosGamesMonopoly`, `productsVariants`, `services`, `appointments`, `customersApp`, `media`, `email`, `scales`, `delivery`, `autoDepartments`, `advancedProducts`.
- **Solo legacy, conservati e mai esposti:**
  - `apiKey`, `databaseHost`, `filesHost`;
  - `type`, `plan`, `expirationDate`;
  - `places[]`, mantenuto dal legacy per le statistiche;
  - `settings.integrations.*.apiKey`.
- **Dei domini successivi:**
  - `priceLists`, `taxes`, `currencies`, `measureUnits` (catalogo e fiscale);
  - `warehouseRules` (magazzino);
  - `fidelityCardRules`, `fidelity`, `promotions`, `productsFavorites`.

Task:
- [ ] **4.1.1** Tipi `Group` e `LegacyGroupDocument`; mapper nei due versi con raccolta delle anomalie.
- [ ] **4.1.2** Catalogo delle feature con significato e default; validazione delle lingue.
- [ ] **4.1.3** Mapper di risposta senza campi solo legacy né segreti; test che lo verifica su un documento legacy completo.

### 4.2 Feature flag
- [ ] **4.2.1** Elenco confermato (D-13) con descrizione di cosa abilita ogni flag.
- [ ] **4.2.2** Applicazione lato server: le route dei moduli dichiarano la feature richiesta (2.3.4); comportamento per PSA e D secondo D-13.

### 4.3 Contesto del gruppo
- [ ] **4.3.1** `GET /v1/groups/{groupId}` con anagrafica, feature, lingue e impostazioni statistiche; `ETag` e `If-None-Match`.
- [ ] **4.3.2** Contesto riletto a ogni avvio e a ogni cambio di gruppo. Nel legacy era una fotografia scattata al login: i flag cambiati da PSA o D arrivavano solo al login successivo.

### 4.4 Gestione gruppi (backend, PSA e D)
- [ ] **4.4.1** Elenco:
  - un D vede solo il proprio `dealerId`;
  - filtri per dealer (solo PSA), stato, demo, ricerca sul nome;
  - paginazione a cursore.
- [ ] **4.4.2** Conteggi di aziende, punti vendita e utenti per gruppo, letti dal common (dopo l'area 5).
- [ ] **4.4.3** Modifica parziale. Chi modifica cosa (da confermare):
  - nome e descrizione;
  - feature e integrazioni abilitate: PSA e D;
  - `demo`: PSA;
  - lingue e impostazioni statistiche.
- [ ] **4.4.4** Sospensione e riattivazione: revoca di tutte le sessioni del gruppo, `status` legacy aggiornato (il legacy lo legge a ogni richiesta), audit.
- [ ] **4.4.5** Cestino e ripristino (D-14).
- [ ] **4.4.6** Elenco dei dealer (utenti D) per il filtro di PSA.
- [ ] **4.4.7** Test di isolamento: un D non vede né modifica gruppi di un altro dealer (nel legacy poteva farlo con `?groupId=`).

### 4.5 Backoffice
- [ ] **4.5.1** Selettore del gruppo per PSA e D, con il gruppo nell'URL `/groups/:groupId/...` (D-10).
- [ ] **4.5.2** Feature nel client: menu, route e sezioni condizionati dalle feature del gruppo corrente (guard e direttiva).
- [ ] **4.5.3** Store dei dati di riferimento del gruppo (sostituisce lo store in memoria del legacy):
  - liste compatte per gruppo, con ETag;
  - riconvalida all'avvio e al cambio di gruppo;
  - invalidazione dopo ogni creazione, modifica o cancellazione;
  - estendibile ad altre entità (categorie, utenti…).
- [ ] **4.5.4** Elenco gruppi con conteggi e dettaglio espandibile (aziende e punti vendita).
- [ ] **4.5.5** Dettaglio e modifica del gruppo con la scheda delle feature; pagina "Account › Gruppo" per il SA.

### 4.6 Chiusura
- [ ] **4.6.1** `doc/API.md`, `doc/Technical-Guide.md`, `doc/Data-Model.md` (`groups`).
- [ ] **4.6.2** Revisione del `security_expert`; conferma dell'utente.

---

## 5. Aziende e punti vendita nel common: migrazione e sincronizzazione
Strategia in §0.3 (D-01, D-20). I task di 5.3 si fanno nel repository legacy `cloud-commerce-platform-server`, con il suo rilascio; tutti gli altri in questo repository.

### 5.1 Prerequisiti
- [ ] **5.1.1** Verificare la versione di MongoDB e le transazioni tra database diversi sul cluster Atlas, con i loro limiti di durata.
- [ ] **5.1.2** Credenziali Atlas esistenti nel `.env` locale (D-02); guardia 1.3.3 attiva e testata prima di qualunque scrittura.
- [ ] **5.1.3** Elenco verificato, con il `legacy_analyst`, di tutti i punti di scrittura su companies e places nel legacy, compresi gli endpoint chiamati dal POS e `groups/generate`.

### 5.2 Collection nel common
- [ ] **5.2.1** Collection `companies` e `places`: copia del documento intero, stesso `_id` del database del gruppo (i riferimenti esistenti restano validi), `groupId` dal nome del database (D-20).
- [ ] **5.2.2** Indici: `groupId`, `groupId + name`, `groupId + companyId` per i punti vendita. Nessun `$jsonSchema` rigido, che bloccherebbe i salvataggi del legacy su dati sporchi: al massimo `groupId` obbligatorio e di tipo ObjectId.
- [ ] **5.2.3** Collection `syncIssues` per le discordanze trovate (`groupId` diverso, copia mancante o diversa), con il motivo e senza dati personali.
- [ ] **5.2.4** Specifica del blocco di copia (passi, transazione, errori), scritta prima di toccare il legacy e validata dal `security_expert`.

### 5.3 Doppia scrittura nel legacy (repository legacy)
- [ ] **5.3.1** Blocco di copia unico (§0.3, punto 1):
  - lettura degli `_id` coinvolti prima della scrittura;
  - scrittura originale invariata;
  - rilettura dei documenti interi e `replaceOne` con upsert nel common, `groupId` sempre dal nome del database;
  - rimozione della copia per le cancellazioni (D-21).
- [ ] **5.3.2** companies: `insertOne`, `updateOne`, `updateMany` e `deleteMany` in transazione con il blocco di copia.
- [ ] **5.3.3** places: `insertOne`, `updateOne`, `updateMany` e `deleteMany` in transazione con il blocco di copia. Valgono anche per gli aggiornamenti del POS: `devices.<i>.info`, `rooms`, `suspendedToday`. La `session` va passata a ogni operazione, compresi gli aggiornamenti di `groups.places[]` e `reserve_with_google`.
- [ ] **5.3.4** `groups/generate`: inserimento di azienda e punto vendita dentro la transazione, con il blocco di copia.
- [ ] **5.3.5** `updateOne` eseguito sull'`_id` risolto prima della scrittura; con `upsert` si copia anche il documento creato.
- [ ] **5.3.6** Blocco di `$out` e `$merge` nelle `aggregate` del legacy.
- [ ] **5.3.7** Nessun errore silenziato: se la copia fallisce, la transazione si annulla e la richiesta risponde con un errore; il motivo va nel log.
- [ ] **5.3.8** Interruttore da variabile d'ambiente per attivare la copia ambiente per ambiente (prima development, poi produzione).
- [ ] **5.3.9** Test del blocco di copia su replica set locale: ogni tipo di scrittura, filtri arbitrari, scritture concorrenti, errore della copia con annullamento.
- [ ] **5.3.10** Rilascio in development, verifica con la riconciliazione (5.5), poi rilascio in produzione.

### 5.4 Caricamento iniziale (nuovo backend)
- [ ] **5.4.1** Comando CLI idempotente, da eseguire dopo l'attivazione della doppia scrittura:
  - elenca i database dell'ambiente filtrati per regex;
  - per ogni gruppo copia i documenti a blocchi, con cursore limitato;
  - ogni blocco gira in transazione, così le scritture concorrenti del legacy vengono serializzate e il caricamento non sovrascrive dati più recenti.
- [ ] **5.4.2** Modalità di prova senza scritture, con report per gruppo: conteggi, `groupId` incoerenti, riferimenti orfani.

### 5.5 Riconciliazione (nuovo backend)
- [ ] **5.5.1** Comando che confronta, gruppo per gruppo, il database del gruppo e il common: insiemi di `_id` e hash del documento con `groupId` normalizzato. Ripara le differenze e scrive le discordanze in `syncIssues`.
- [ ] **5.5.2** Esecuzione periodica nel ruolo `worker` (`doc/Architecture.md` §7), con istanza unica e frequenza da decidere. Allarme se trova differenze: indicano un percorso di scrittura non coperto.
- [ ] **5.5.3** Test su replica set locale: copie mancanti, diverse o in eccesso; gruppi nuovi; database rimossi.

### 5.6 Scritture dal nuovo backend (fase 2)
- [ ] **5.6.1** Servizio di scrittura in **transazione** con la stessa regola del legacy:
  - nel database del gruppo, `$set` dei soli campi posseduti, nel formato legacy;
  - poi rilettura del documento intero e copia nel common.
- [ ] **5.6.2** Effetti collaterali che il legacy si aspetta: aggiornamento di `groups.places[]` alla creazione e alla cancellazione di un punto vendita; nessuna modifica a `reserve_with_google`.
- [ ] **5.6.3** Default compatibili per i documenti creati dal nuovo backend: le strutture che il legacy legge senza controlli (`general`, `openingTime`, `settings.*`…), verificate sul codice legacy.
- [ ] **5.6.4** Politica sui conflitti con modifiche concorrenti dal legacy: `If-Match` lato nuovo backend e ultimo scrittore vince lato legacy, oppure modifica disabilitata nel backoffice legacy (da decidere).
- [ ] **5.6.5** Test: le parti incorporate non possedute (`devices`, `rooms`, `storages`, impostazioni, integrazioni) sopravvivono a ogni scrittura.

### 5.7 Dismissione (fase 3)
- [ ] **5.7.1** Checklist di passaggio:
  - legacy e POS spenti, doppia scrittura rimossa;
  - common unica fonte di verità;
  - conversione dei documenti dal formato legacy al modello di dominio;
  - rimozione delle copie nei database dei gruppi.

### 5.8 Chiusura
- [ ] **5.8.1** `doc/Technical-Guide.md` (comandi, riconciliazione, allarmi) e `doc/Data-Model.md`.
- [ ] **5.8.2** Revisione del `security_expert` (privilegi, guardie, blocco di copia); conferma dell'utente.

---

## 6. Aziende

### 6.1 Modello azienda
Common `companies` ↔ legacy `<env>_<groupId>.companies`:

| Campo di dominio | Tipo | Campo legacy | Regole |
|---|---|---|---|
| `id` | string | `_id` | identico nel database del gruppo |
| `groupId` | string | (nome del database) | immutabile |
| `name` | string | `name` | obbligatorio |
| `vatNumber` | string | `code` | in scrittura, checksum della P.IVA se il paese è IT |
| `fiscalCode` | string \| null | `code2` | 11 o 16 caratteri, con controllo |
| `address` | `{ street, postcode, city, province, country }` | `address`, `postcode`, `city`, `countryAreaCode`, `countryCode` | `country` ISO 3166-1 alpha-2 dalla collection `countries` |
| `currency` | string | `currencyCode` | ISO 4217 |
| `email`, `phone` | string \| null | `email`, `telephone` | |
| `status` | `active` \| `disabled` | `status` | |
| `trashed` | boolean | `trash` | |
| `expirationDate` | Date \| null | `expirationDate` | PSA e D |
| `eInvoicing` | vedi sotto | `fattura_elettronica.*` | `hub` modificabile solo da PSA e D |
| `createdAt`, `updatedAt` | Date | `insertDate`, `updateDate` | |

Campi di `eInvoicing`:
- `hub`;
- `recipientCode` (codice destinatario, 7 caratteri), `pec`;
- `taxRegime` (RF01–RF19), `eori`;
- `transmitter { country, code }`;
- `rea { office, number, shareCapital, shareholders SU|SM, liquidation LS|LN }`;
- `professionalRegister { name, province, number, date }`.

Restano nel documento (e nella sua copia), fuori dal modello di dominio e non esposti, fino ai rispettivi domini: `invoicesPS`, `invoicesPSValues`, `banks`, `ticketsSuppliers`, `settings.*` (globali, e-commerce, Cerved), `medias`.

Task:
- [ ] **6.1.1** Tipi, mapper e validatori fiscali (P.IVA, codice fiscale, codice destinatario, PEC, regime fiscale), rigorosi in scrittura e tolleranti in lettura.
- [ ] **6.1.2** Indici del common: `groupId + status`, `groupId + name`; `vatNumber` univoco per gruppo solo dopo D-15.

### 6.2 Backend
- [ ] **6.2.1** Elenco delle aziende di un gruppo nello scope: filtri per stato, cestino, paese e provincia, ricerca, paginazione a cursore.
- [ ] **6.2.2** Lista compatta per i dati di riferimento (`id`, `name`, `status`, `trashed`) con `ETag`.
- [ ] **6.2.3** Dettaglio; CA solo sulle proprie aziende (`404` fuori scope).
- [ ] **6.2.4** Creazione (PSA e D; da confermare per SA) tramite il servizio 5.6.1.
- [ ] **6.2.5** Modifica parziale dei dati anagrafici e fiscali con validazione; `groupId` immutabile; `hub`, `status` ed `expirationDate` solo PSA e D.
- [ ] **6.2.6** Cestino e ripristino; i punti vendita collegati mantengono il riferimento e l'interfaccia lo segnala.
- [ ] **6.2.7** Test di isolamento e di compatibilità con il legacy (documento rileggibile dal legacy dopo ogni scrittura).

### 6.3 Backoffice
- [ ] **6.3.1** Elenco aziende con filtri nell'URL.
- [ ] **6.3.2** Dettaglio e modifica con le schede Generale e Dati fiscali; errori `422` sui campi.
- [ ] **6.3.3** Aziende nello store dei dati di riferimento (4.5.3), usate da filtri e select.

### 6.4 Chiusura
- [ ] **6.4.1** `doc/API.md`, `doc/Technical-Guide.md`, `doc/Data-Model.md` (`companies`); conferma dell'utente.

---

## 7. Punti vendita

### 7.1 Modello punto vendita
Common `places` ↔ legacy `<env>_<groupId>.places`:

| Campo di dominio | Tipo | Campo legacy | Regole |
|---|---|---|---|
| `id` | string | `_id` | identico nel database del gruppo |
| `groupId` | string | (nome del database) | il campo `groupId` legacy può essere incoerente: va segnalato |
| `companyId` | string | `companyId` | azienda dello stesso gruppo |
| `name` | string | `name` (insegna) | obbligatorio |
| `address` | `{ street, postcode, city, province, country }` | `address`, `postcode`, `city`, `countryAreaCode`, `countryCode` | |
| `contactName` | string \| null | `contact` | |
| `email`, `phone` | string \| null | `email`, `telephone` | |
| `timezone` | string | `timezone` | IANA, validato con `Intl.supportedValuesOf('timeZone')` |
| `plan` | `basic` \| `advanced` \| `enterprice` \| `tgm-secondary` \| `desk-secondary` | `plan` | valori reali dalla profilazione; modificabile solo da PSA |
| `expirationDate` | Date \| null | `expirationDate` | scadenza della licenza; PSA e D |
| `status` | `active` \| `disabled` | `status` | |
| `trashed` | boolean | `trash` | |
| `createdAt`, `updatedAt` | Date | `insertDate`, `updateDate` | |

Restano nel documento (e nella sua copia), fuori dal modello di dominio, fino ai rispettivi domini. Il nuovo backend non li espone e non li sovrascrive mai:
- catalogo: `listId`, `ecommerceListId`;
- documenti: `invoicePS`;
- orari: `openingTime`, `general.*`;
- magazzino: `storages[]`;
- dispositivi: `devices[]`;
- ristorazione e comande: `rooms[]`, `printStations[]`, `productionCenter[]`;
- pagamenti: `paymentTypes[]`, `payments`;
- stampe: `receipt`, `prebilling`, `ordering`;
- altre funzioni: `roomsSettings`, `selfOrdering`, `kiosk`, `externalDisplay`, `deliveryTakeAway`, `delivery`, `appointment`, `fidelity`, `tgm`;
- integrazioni con credenziali: `integrations.*`;
- media: `medias`;
- tecnici: `platform`, `server`, `connectorAddress`.

Task:
- [ ] **7.1.1** Tipi, mapper e validatori; controllo dell'appartenenza di `companyId` al gruppo.
- [ ] **7.1.2** Indici del common: `groupId + companyId`, `groupId + status`, `groupId + name`.

### 7.2 Backend
- [ ] **7.2.1** Elenco dei punti vendita di un gruppo nello scope:
  - filtri per azienda, stato, piano, cestino, paese e provincia;
  - ricerca;
  - ordinamento prima della paginazione.
- [ ] **7.2.2** Lista compatta per i dati di riferimento (`id`, `name`, `companyId`, `plan`, `status`, `trashed`) con `ETag`.
- [ ] **7.2.3** Dettaglio; CA e PA solo nel proprio scope.
- [ ] **7.2.4** Creazione (PSA e D) tramite il servizio 5.6.1, con aggiornamento di `groups.places[]` (5.6.2).
- [ ] **7.2.5** Modifica parziale dei dati anagrafici; cambio di azienda solo all'interno del gruppo.
- [ ] **7.2.6** Sotto-risorsa per piano (solo PSA) e scadenza (PSA e D): permette il rinnovo inline come nel legacy.
- [ ] **7.2.7** Cestino e ripristino.
- [ ] **7.2.8** Test di isolamento e di sopravvivenza delle parti incorporate (5.6.5).

### 7.3 Backoffice
- [ ] **7.3.1** Elenco punti vendita con filtri nell'URL e rinnovo inline della scadenza.
- [ ] **7.3.2** Dettaglio e modifica: per ora solo la scheda Generale; le altre schede arrivano con i rispettivi domini.
- [ ] **7.3.3** Punti vendita nello store dei dati di riferimento (4.5.3); scope di CA e PA applicato dal server, non dal client.

### 7.4 Chiusura
- [ ] **7.4.1** `doc/API.md`, `doc/Technical-Guide.md`, `doc/Data-Model.md` (`places`); conferma dell'utente.

---

## 8. Onboarding di un nuovo cliente
Sostituisce il wizard "Nuovo cliente" e `groups/generate` del legacy, che non era atomico.
- [ ] **8.1.1** Analisi del `legacy_analyst`: collection e documenti minimi che un database di gruppo nuovo deve avere perché legacy, POS e `ms-integration-service` funzionino (D-18).
- [ ] **8.1.2** Creazione atomica e idempotente (`Idempotency-Key`) di gruppo, azienda, punto vendita, utente SA e database del gruppo.
- [ ] **8.1.3** Preset per tipologia (feature e dati iniziali, D-18).
- [ ] **8.1.4** Username proposto e verifica di disponibilità (3.4.8).
- [ ] **8.1.5** Lookup Cerved sulla P.IVA, che dipende dall'area integrazioni.
- [ ] **8.1.6** Wizard nel backoffice.
- [ ] **8.1.7** Chiusura: documentazione, revisione del `security_expert`, conferma dell'utente.

---

## 9. API pubbliche (`/public/v1`)
Specifica in `doc/Security-Model.md` §6–7.
- [ ] **9.1.1** Collection `apiKeys`: creazione, elenco e revoca da SA (e da D e PSA per i loro gruppi); chiave mostrata una sola volta.
- [ ] **9.1.2** Middleware `X-Api-Key` con scope sul gruppo e restrizioni ad aziende e punti vendita; CORS chiuso.
- [ ] **9.1.3** Rate limit per chiave e quote (`QUOTA_EXCEEDED`).
- [ ] **9.1.4** Conteggio d'uso aggregato a blocchi (`apiUsage`) e consultazione dal backoffice.
- [ ] **9.1.5** Pagine del backoffice per la gestione delle chiavi.
- [ ] **9.1.6** `doc/Public-API.md` e `doc/API.md`; revisione del `security_expert`; conferma dell'utente.

---

## 10. Aree successive (da dettagliare)
Ogni area parte con l'analisi del `legacy_analyst` (skill `legacy-module-analysis`) e si dettaglia in task prima di iniziare. Il server di punto vendita è un'applicazione separata, fuori da questo progetto (D-22), e usa le API del backoffice (D-23).
- **Accesso dell'app del server di punto vendita alle API `/v1`:** credenziale da decidere (D-24).
- **Catalogo:** prodotti, categorie (albero, da aggiungere allo store dei dati di riferimento), reparti, brand, attributi, varianti, preferiti, promozioni, listini, aliquote, unità di misura, import/export, TGM.
- **Magazzino:** depositi del punto vendita, causali, movimenti, giacenze.
- **Dispositivi del punto vendita:** casse, palmari, stampanti fiscali, casse automatiche (credenziali cifrate), bilance, display.
- **Ristorazione:** sale e tavoli, postazioni comanda, centri di produzione, prenotazioni dei tavoli.
- **Vendite e cassa:** chiusure, turni, checkout, permessi e preferenze dell'app di cassa (`permissions.apps.cash`), operatori `E` e PIN (`doc/Security-Model.md` §12.2), modalità UM e `sType`.
- **Documenti fiscali:** fatture, scontrini, sezionali, coda e-fatture Aruba, Fiskaly, allarmi dei documenti in errore.
- **Clienti e fedeltà:** contatti, gruppi di contatti, carte, raccolte punti, template e-mail.
- **Calendario e appuntamenti:** servizi e turni degli utenti.
- **Media e file:** upload sicuro, avatar, immagini.
- **Statistiche e report**, log, cestino, diagnostica.
- **Integrazioni:** pagamenti (Satispay, Dojo, Flood Pay), canali (EasyAppear, Yellgo, LeggiMenu, Plateform, Cooperto, Qodeup), Reserve with Google, gestionali alberghieri, Cerved.
- **Piattaforma:** paesi e province, attivazioni e canoni, release, fLite, app pubbliche (prenotazioni, Flood Pay).
