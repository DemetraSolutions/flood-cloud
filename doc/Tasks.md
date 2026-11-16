# Piano dei Task

> Piano di lavoro di Flood Cloud diviso per aree (entità principali) e sottoaree.
> - `[ ]` da fare · `[x]` completato.
> - Ogni task ha un identificativo stabile `<area>.<sottoarea>.<n>`: non si rinumera; i nuovi task si aggiungono in coda alla sottoarea.
> - Un task si spunta solo quando il codice funziona, i test sono al 100% con typecheck verde, la documentazione è aggiornata (skill `docs-sync-checklist`) e l'utente ha confermato (`GEMINI.md` §1).
> - Le decisioni `D-nn` (§0.4) vanno prese **prima** dei task che le citano.
> - Fonti: `doc/` del progetto e analisi del 2026-11-01 di `cloud-commerce-platform-server` e `cloud-commerce-backoffice-client`.
> - Stato al 2026-11-06: aree 1, 2 e 3 completate; area 4 (gruppi): backend realizzato (passi 4B, 4B-bis, 4U), restano 4.4.2 e il backoffice.
> - Stato al 2026-11-12: il passo 4C (backoffice dei gruppi) è diviso in **4C-1** (fatto: feature, elenco gruppi, scheda del gruppo con integrazioni e sei cataloghi), **4C-2** (form utente completo e profilo) e **4C-3** (fidelity, preferiti, promozioni, con letture compatte già nel backend); decisione dell'utente del 2026-11-12.
> - Stato al 2026-11-12 (aggiornamento): **4C-2 realizzato** (form utente a 6 tab con permessi POS, listini, servizi, turni, PIN e avatar; profilo con avatar, preferenze della cassa e PIN proprio); resta **4C-3**. Documentazione in `doc/Technical-Guide.md` §11.12.
> - Stato al 2026-11-12 (aggiornamento): **4C-3 realizzato** (fidelity, preferiti dei prodotti e promozioni nel backoffice, con vista in sola lettura per CA e PA); l'**area 4 è completata salvo 4.4.2 e 4.5.3**. Documentazione in `doc/Technical-Guide.md` §11.13.

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
- [x] **D-06** Permessi per singolo utente: ogni utente conserva la matrice `permissions.<modulo>.{r,w}` e `permissions.status` del legacy; i permessi effettivi sono quelli dell'utente limitati dal tetto del ruolo (un utente non ottiene mai permessi oltre il proprio ruolo). `permissions.apps.cash.*` resta del dominio cassa: conservato, mai esposto su `/v1`. Decisione dell'utente del 2026-11-02.
- [x] **D-07** Ruoli: PSA, D, SA, CA, PA, E. Il ruolo `API` si elimina (nessun utente lo usa, §0.4.1): lo sostituiscono le API key pubbliche. `X` e `L` non esistono (correggere `doc/Legacy-Analysis.md`, 0.5.1). Utenti `E` senza accesso al backoffice (`doc/Security-Model.md` §4). Decisione dell'utente del 2026-11-02.
- [x] **D-08** Scope multipli: nel modello di dominio liste `companyIds[]` (CA) e `placeIds[]` (PA, E), anche con un solo elemento. Lettura dal legacy: `companyId` → `companyIds`; unione di `placeId` e `placesId` → `placeIds`. Finché il legacy è attivo, a ogni scrittura il nuovo backend allinea i campi legacy: `companyId` = prima azienda, `placeId` = primo punto vendita, `placesId` = tutti. Decisione dell'utente del 2026-11-02.
- [x] **D-09** Dealer: anagrafica nella nuova collection `dealers` del common (ragione sociale completa), con `_id` uguale a quello dell'utente D collegato (così `groups.dealerId` resta valido); creare un dealer crea anche il suo utente D nella stessa transazione; il ruolo D non si assegna né si toglie con una modifica. Dealer esistenti registrati con ragione sociale = username (1 in development, 5 in production, 2026-11-06). Decisione dell'utente del 2026-11-06, realizzata nel passo 4A.
- [x] **D-10** PSA e D nei moduli operativi di un gruppo: **novità rispetto al legacy**, dove PSA e D gestivano solo gruppo, aziende e punti vendita. Selezionato un gruppo, PSA e D accedono anche ai dati operativi (prodotti, magazzino, documenti…) in lettura e scrittura per fare manutenzione. Gruppo nel percorso (`/v1/groups/:groupId/...`), verificato contro lo scope (PSA tutti, D solo i propri gruppi, gli altri ruoli solo il proprio); ogni accesso di PSA e D a un gruppo va nel registro delle attività (2.6); nel backoffice selettore del gruppo con il gruppo nell'URL; nessuna impersonazione. Decisione dell'utente del 2026-11-02.
- [x] **D-11** Sessioni legacy: il nuovo backend non accetta i JWT del legacy. Disattivazione dell'utente, cambio password e cambio di ruolo o scope fatti dal nuovo backend svuotano anche `users.tokens[]`, così il legacy disconnette subito. Decisione dell'utente del 2026-11-02.
- [x] **D-12** Refresh token del backoffice nel **body** della risposta (niente cookie), conservato dal backoffice in `sessionStorage` (sopravvive al ricaricamento, per singola scheda); access token solo in memoria. Mitigazioni: CSP stretta con Trusted Types, rotazione a ogni uso con rilevamento del riuso. Riportata in `doc/Security-Model.md` §4 e §12.1. Decisione dell'utente del 2026-11-02.
- [x] **D-13** Feature flag del gruppo: catalogo confermato con tutte le feature di 4.1 (`delivery` e `customersApp` restano, gestibili dal PSA); le feature valgono anche per PSA e D quando lavorano in un gruppo; `plan`, `type` ed `expirationDate` del gruppo sono deprecati (conservati, mai letti né esposti). Chi modifica cosa: nome, descrizione, lingue e impostazioni statistiche PSA, D, SA; feature e integrazioni PSA e D; `demo` solo PSA. Decisione dell'utente del 2026-11-06.
- [x] **D-14** Cancellazione degli utenti: cestino (`trash`) e, dal cestino, eliminazione definitiva ammessa a PSA, D e SA nel proprio perimetro e con le regole anti-escalation (permesso `users:delete`); il database è condiviso, quindi l'utente sparisce anche dal legacy. Decisione dell'utente del 2026-11-02.
- [x] **D-15** Univocità dello username: globale, confrontando NFKC, spazi e minuscole, per gli username nuovi o cambiati; i duplicati esistenti (§0.4.1) restano. Decisione dell'utente del 2026-11-02. `vatNumber` (`companies.code`): **univoco nel gruppo** tra le aziende non nel cestino (indice univoco parziale, `409` sui doppioni nuovi), dopo la verifica dei duplicati esistenti nei dati; decisione dell'utente del 2026-11-13, da realizzare nell'area 6.
- [x] **D-16** Valori ammessi di `APP_ENV`: `development` e `production`, come i database esistenti. Decisione dell'utente del 2026-11-01.
- [x] **D-17** Login solo con username: corrispondenza esatta, altrimenti senza maiuscole se esiste un solo utente con lo stesso username normalizzato. Email e telefono no (duplicati, §0.4.1). Decisione dell'utente del 2026-11-02.
- [ ] **D-18** Onboarding: preset per tipologia (risto, retail, beauty) e struttura minima del database di un gruppo nuovo richiesta dal legacy.
- [x] **D-19** Policy delle password nuove o cambiate: da 12 a 128 code point dopo NFC, nessuna regola sulle classi, diversa dallo username, nessun carattere Unicode non valido. Le password legacy esistenti restano valide. Decisione dell'utente del 2026-11-02.
- [x] **D-20** Forma della copia nel common: **documento intero** del database del gruppo, con `groupId` impostato dal nome del database. Proposta dell'utente del 2026-11-01. Il nuovo backend traduce i nomi legacy nel modello di dominio (§0.2, tabelle 6.1 e 7.1).
- [x] **D-21** Cancellazione definitiva nel legacy (`deleteMany` dal cestino): **la copia nel common si rimuove** nello stesso punto in cui il legacy cancella. Il comando `sync:copies` del nuovo backend invece non cancella mai (copia solo lo stato attuale; le copie senza originale si segnalano). Decisione dell'utente del 2026-11-12.
- [x] **D-22** Il server di punto vendita è un'applicazione separata, fuori dallo scope: questo progetto comprende solo il backend cloud e il backoffice. Decisione dell'utente del 2026-11-01.
- [x] **D-23** Nessuna superficie dedicata al server di punto vendita: l'app separata usa le stesse API del backoffice (`/v1`). La superficie `/store/v1` prevista da `doc/Architecture.md` §4 e `doc/Security-Model.md` §3 e §5 è eliminata. Decisione dell'utente del 2026-11-01.
- [x] **D-24** Credenziale con cui l'app del server di punto vendita chiama le API `/v1`. Va decisa quando si integra l'app; oggi usa l'API key del gruppo, condivisa da tutti i negozi. *Decisione dell'utente del 2026-11-13: chiave per punto vendita (una sola attiva, nessuna scadenza fino a revoca, attivazione e revoca solo PSA e D), attivata con un codice monouso; dettagli in area 7, realizzata nel passo 7C (`doc/Security-Model.md` §5).* Opzioni valutate:
  - **login di un utente:** il refresh scade dopo 7 giorni di inattività o 30 di durata massima, quindi il negozio resta bloccato dopo un lungo offline; la password resta salvata sul server del negozio; gli utenti `E` non sono ammessi;
  - **credenziale di dispositivo per punto vendita**, accettata dalle stesse route con scope fisso sul punto vendita.
- [x] **D-25** Multicluster MongoDB: più cluster, ciascuno con connessione di lettura/scrittura e analytics; login e dati comuni sempre sul cluster comune; ogni gruppo indica il proprio cluster con `groups.dataCluster` (solo l'id; assente ⇒ cluster di default). Finché il legacy è attivo i gruppi restano sul cluster comune; nessuna transazione tra cluster (per i gruppi su altri cluster la copia di companies e places si affida alla riconciliazione). Dettagli in `doc/Architecture.md` §3.2.1. Decisione dell'utente del 2026-11-06, realizzata.

- [x] **D-26** Modello completo delle entità: ogni entità gestita ha **da subito** il modello completo e compatibile col legacy, con tutti i campi visibili e modificabili ("deve valere per ogni entity che gestiamo, man mano il modello delle entity deve essere già completo e compatibile"). Le scritture avvengono per percorso, le chiavi sconosciute si conservano; i campi nullable si svuotano davvero con `null` e gli array con `[]`, diversamente dal legacy. Decisione dell'utente del 2026-11-06, realizzata nei passi 4B-bis e 4U.
- [x] **D-27** Utente (modello completo): PIN impostabile e mai mostrato (in chiaro in `users.pin` per il POS legacy, hash con il dominio cassa; il proprio PIN con `PUT /v1/me/pin` e password attuale); avatar data URL PNG/JPEG/WebP verificato dai magic bytes, ≤ 200 KB (avatar legacy non mostrabili ⇒ `avatar: null` con `hasAvatar: true`); `servicesId` con lettura compatta dei servizi del gruppo; turni senza vincolo di feature; dal proprio profilo solo le preferenze della cassa (non i listini né `defaultPriceListId`), i listini utilizzabili si cambiano dalla scheda dell'utente; permessi della cassa: serve "Gestione permessi", PSA, D e SA li danno liberamente, CA e PA solo ciò che hanno e senza alzare il tetto di sconto; un cambio di `pos.enabled` o `pos.grants` è un cambio di permessi (evento di sicurezza `user.permissionsChanged`, revoca delle sessioni, `tokens[]` legacy svuotati); default per ruolo = tabella del form legacy (`setDefaultPermissions`) su 13 moduli. Decisione dell'utente del 2026-11-06, realizzata nel passo 4U.
- [x] **D-28** PSA e D hanno tutto (estende D-10): i loro permessi effettivi sono l'intero tetto del ruolo, senza la matrice legacy del loro documento, e `canManagePermissions` è sempre vero; le risposte mostrano i valori effettivi; nessuna modifica ai documenti. Decisione dell'utente del 2026-11-06.
- [x] **D-29** Gruppo (modello completo): perimetro "tutto" (scheda gruppo, fidelity, preferiti e promozioni come sotto-risorse); `apiKey` delle integrazioni solo impostabili (`apiKeySet`), `groups.apiKey` mai gestita; `databaseHost` e `filesHost` non gestiti; `places[]` derivato, non esposto; fidelity con permesso `fidelity`, preferiti e promozioni con `products`, scrivibili anche da CA e PA se la loro matrice lo concede; CA e PA limitati al proprio perimetro di punti vendita su promozioni e tipi di carta (lista vuota = tutto il gruppo ⇒ vietata a CA/PA); eliminazione di elementi referenziati rifiutata con `409` (il legacy la permetteva); budget del documento del gruppo 8 MiB. Decisione dell'utente del 2026-11-06, realizzata nel passo 4B-bis.
- [x] **D-30** Profilazione mirata dei sotto-oggetti di `users` e `groups` in produzione (`npm run profile:legacy -- --focus subobjects`), in sola lettura, eseguita il 2026-11-06: ha fornito le frequenze reali delle chiavi per i modelli completi.
- [x] **D-31** Listini del gruppo (4C-2): chi legge gli utenti (`users:read`) li legge in forma compatta (`GET /v1/groups/{groupId}/lookup/price-lists`) per assegnarli agli utenti; la modifica dei listini resta a PSA, D e SA (`groups:update`). Decisione dell'utente del 2026-11-12, realizzata nel passo 4C-2.

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
- [x] **0.5.1** `doc/Legacy-Analysis.md`, correzioni:
  - i ruoli `X` e `L` non esistono, esiste `API`;
  - il JWT scade dopo `TOKEN_DURATION_DAYS` giorni;
  - `databaseHost` apre un client per ogni richiesta;
  - `ms-integration-service` lavora sugli stessi database;
  - l'ambiente si chiama `NODE_ENV`.
  *Fatto il 2026-11-13.*
- [x] **0.5.2** `doc/Architecture.md` §3: coesistenza con il legacy e strategia di sincronizzazione (D-01, D-03). *Fatto il 2026-11-13: nuovo §3.4.*
- [x] **0.5.3** `doc/Data-Model.md`:
  - `users` e `groups` compatibili con i documenti legacy;
  - `companies` e `places` nel common come copie dei documenti dei gruppi (D-20);
  - nuove collection `userCredentials` e `syncIssues`;
  - risposte alle domande aperte.
  *Fatto il 2026-11-13: verificato, aggiunte solo le risposte alle domande aperte e il riferimento a `COMMON_COPY_ENABLED`.*
- [x] **0.5.4** `doc/Security-Model.md`: compatibilità di password e dati personali legacy (D-04, D-05), sessioni legacy (D-11). *Fatto il 2026-11-12 con l'aggiornamento del documento.*
- [x] **0.5.5** `GEMINI.md` e `AGENTS.md`: aggiungere `doc/Tasks.md` alla tabella dei documenti. *Fatto il 2026-11-13.*
- [x] **0.5.6** `doc/Product-Scope.md`, `doc/Architecture.md` §4, `doc/Security-Model.md` §3 e §5, `doc/Data-Model.md` (collection `storeServer*`): eliminare la superficie `/store/v1` e indicare che l'app del server di punto vendita è separata e usa le API `/v1` (D-22, D-23, D-24). *Il 2026-11-12 aggiornati `doc/Security-Model.md`, `doc/Data-Model.md` e `doc/API.md`; restano `doc/Product-Scope.md` e `doc/Architecture.md` §4. Fatto il 2026-11-13: verificati e allineati entrambi.*

### 0.6 Rischi del legacy in produzione (fuori da questo repository)
- [ ] **0.6.1** Valutare la rotazione delle credenziali Atlas: oggi sono scritte nel repository legacy (ConfigMap, `launch.json`). Dopo una rotazione vanno aggiornati il legacy e il `.env` locale (D-02). *Decisione dell'utente del 2026-11-13: la valuta e la esegue l'utente fuori da questo progetto; non blocca le aree successive.*
- [x] **0.6.2** Valutare correzioni urgenti nel legacy. *Decisione dell'utente del 2026-11-13: rimandate, il legacy non si tocca; rischi accettati fino alla dismissione (5.7).*
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
- [x] **1.5.1** Validatore per allowlist (skill `input-validation`):
  - controlla tipi, lunghezze, enum, ObjectId e date;
  - rifiuta le proprietà sconosciute e le chiavi con `$` o `.`;
  - risponde `422` con dettagli per campo.
- [x] **1.5.2** Parametri delle liste: `limit` (default 50, massimo 200), `cursor` opaco, `sort` in allowlist, ricerca `q` con escape della regex lato server e lunghezza limitata.
- [x] **1.5.3** Paginazione a cursore con ordinamento stabile (spareggio su `_id`), ordinamento applicato **prima** della pagina (nel legacy i punti vendita erano ordinati solo dentro la pagina).
- [x] **1.5.4** Supporto a `ETag` e `If-None-Match` (`304`) per le liste compatte usate come cache dal backoffice. *Realizzato: helper `shared/http/etag.ts` (`sendRevalidated` per il dettaglio del gruppo, `sendRevalidatedPage` per le liste); `ETag` debole sull'intero body e `304` su `GET /v1/groups`, `companies`, `places` e tutte le `lookup/*`; il confronto viene dopo autenticazione, permesso e validazione.*

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

Passi decisi dall'utente il 2026-11-02: **2A** = 2.1 e 2.2; **2B** = 2.3 e 2.4; **2C** = 2.5 e 2.6.1–2.6.5; 2.6.6–2.6.7 dopo l'area 3 (richiedono il login).

### 2.1 Primitive crittografiche (`node:crypto`)
- [x] **2.1.1** Generazione dei segreti: prefisso più 32 byte casuali in base64url (`fc_at_`, `fc_rt_`, `fc_pk_` e `fc_sk_`, la chiave di negozio del passo 7C; nessun `fc_st_`, D-23), hash SHA-256 a riposo, ricerca per indice univoco.
- [x] **2.1.2** Confronto a tempo costante (`timingSafeEqual`) per ogni segreto.
- [x] **2.1.3** scrypt: hash, verifica e necessità di rehash nel formato `scrypt$N$r$p$salt$hash`; policy delle password (D-19).

### 2.2 Compatibilità con le credenziali legacy (D-04, D-05)
- [x] **2.2.1** Verifica dell'hash legacy delle password (HMAC-SHA512 con pepper) a tempo costante.
- [x] **2.2.2** *(logica di verifica realizzata; la scrittura in `userCredentials` arriva con 3.1.4 e 3.2)* Al login riuscito, hash scrypt in `userCredentials` insieme all'impronta (SHA-256) dell'hash legacy da cui deriva. Ai login successivi:
  - se l'impronta coincide con l'hash legacy attuale, si verifica con scrypt;
  - se non coincide, la password è stata cambiata dal legacy: si verifica l'hash legacy e si ricalcola scrypt.
- [x] **2.2.3** Cambio password: scrittura di scrypt più hash legacy finché il flag di coesistenza è attivo; flag da spegnere al passaggio definitivo.
- [x] **2.2.4** *Non necessario: la profilazione (§0.4.1) non ha trovato dati personali cifrati.* Migrazione una tantum dei dati personali cifrati (D-05). Se la profilazione (1.3.6) trova valori nel formato `<hex>$<ivhex>`, uno script li decifra e li riscrive in chiaro con `$set`. Prevede una modalità di prova e un report; un valore non decifrabile si segnala, senza sovrascriverlo.
- [x] **2.2.5** *Non necessario: l'analisi del legacy del 2026-11-01 conferma che nessuna scrittura attiva cifra i dati personali.* Verifica con il `legacy_analyst` che il legacy non cifri più i dati personali in scrittura; se lo fa ancora, la cifratura va disattivata nel legacy prima della migrazione 2.2.4.

### 2.3 RBAC
- [x] **2.3.1** Catalogo dei permessi `risorsa:azione` dei domini core: `users`, `groups`, `companies`, `places`, `sessions`, `auditLog`.
- [x] **2.3.2** Policy centralizzata ruolo → permessi; ogni route dichiara il permesso richiesto; test della matrice completa ruolo × permesso.
- [x] **2.3.3** Restrizioni per utente (D-06): mappatura delle chiavi legacy `permissions.<modulo>.{r,w}` e calcolo dei permessi effettivi.
- [x] **2.3.4** *(realizzato con l'area 4, D-13)* Requisito di feature del gruppo dichiarabile sulla route (4.2.2): una route di un modulo spento risponde `403`.

### 2.4 Scope e isolamento dei tenant
- [x] **2.4.1** Calcolo dello scope alla verifica della credenziale:
  - PSA: tutto;
  - D: i gruppi con il proprio `dealerId`;
  - SA: il proprio gruppo;
  - CA: le proprie aziende;
  - PA: i propri punti vendita.
- [x] **2.4.2** Contesto `req.auth` tipizzato; helper dei repository che applicano lo scope a ogni query; database del gruppo risolto dal contesto.
- [x] **2.4.3** `groupId` nel percorso verificato contro lo scope, `404` fuori scope (anche per gruppo inesistente); gruppi sospesi o cestinati raggiungibili solo dal PSA (decisione dell'utente del 2026-11-02); audit degli accessi di PSA e D a un gruppo: segnale pronto, scrittura nel registro con il passo 2C.
- [x] **2.4.4** Regola anti-escalation (decisione dell'utente del 2026-11-02): ruoli gestibili PSA → tutti; D → SA, CA, PA, E; SA → SA, CA, PA, E; CA → CA, PA, E; PA → PA, E (pari ammessi), sempre dentro il proprio scope; nessuno modifica il proprio ruolo, scope, permessi o stato; nessuno concede permessi che non ha; cambiare la matrice altrui richiede `permissions.status`; chi non ce l'ha crea utenti con i permessi di default del ruolo. Tetti per ruolo approvati: tabella in `doc/Technical-Guide.md` §8.
- [x] **2.4.5** Modello di test di isolamento riusabile per ogni endpoint: altro gruppo, altro dealer, CA fuori azienda, PA fuori punto vendita.

### 2.5 Rate limit
- [x] **2.5.1** Collection `rateLimits` con contatori a finestra fissa, `$inc` atomico con upsert e TTL.
- [x] **2.5.2** Header `RateLimit-*`, `429 RATE_LIMITED` con `Retry-After`.
- [x] **2.5.3** Soglie (decisione dell'utente del 2026-11-02, configurabili): login 5 per username e 15 per IP, refresh 30 per IP, verifica dello username 15 per utente, `/v1` 300 per utente, autenticazioni fallite 300 per IP (conteggiate solo sui 401).

### 2.6 Registro delle attività, audit e monitor degli errori
Decisione dell'utente del 2026-11-01: una sola collection nuova nel common per attività degli utenti, eventi di sicurezza ed errori, consultabile da un monitor del backoffice. La collection `logs` del legacy resta intatta. Gli errori si scrivono anche su stdout, così non si perdono se MongoDB non risponde.
- [x] **2.6.1** Collection `activityLog` (al posto di `auditLog`; dal 2026-11-06 `activityEvents`, senza validatore del database) con categoria `data` | `security` | `error`, gruppo, attore, azione, risorsa, esito, `requestId`; indici `groupId + at`, `actor.id + at`, `category + at`, `requestId`; servizio di scrittura senza segreti.
- [x] **2.6.2** *(catalogo e servizio pronti; collegati oggi accessi trasversali di PSA e D e superamenti dei rate limit; login, sessioni, utenti e gruppi si collegano nelle aree 3 e 4)* Eventi:
  - login riusciti e falliti;
  - refresh e riuso rilevato;
  - revoche;
  - cambi di ruolo, scope e stato;
  - accessi di PSA e D ad altri gruppi;
  - sospensioni.
- [x] **2.6.3** Durata di conservazione con TTL (decisione dell'utente del 2026-11-02): `data` e `security` 365 giorni, `error` 90, configurabili. IP in chiaro (legittimo interesse alla sicurezza, da riportare nell'informativa privacy).
- [x] **2.6.4** *(funzioni pronte per lo strato service; usate dai domini delle aree 3+)* Registro delle scritture (inserimenti, modifiche, cancellazioni): chi, quando, risorsa e campi cambiati con valore precedente e nuovo; dei campi sensibili (password, token, credenziali) solo il nome; nome, email e telefono in chiaro (decisione dell'utente del 2026-11-02). Scritto dallo strato service, mai dai controller. Le letture non si registrano.
- [x] **2.6.5** Errori del backend nel registro, collegati a `requestId` e utente; un fallimento della scrittura non blocca la risposta e resta su stdout.
- [x] **2.6.6** Endpoint per ricevere gli errori JavaScript del backoffice, con validazione, limiti di dimensione e rate limit.
- [x] **2.6.7** Monitor nel backoffice: elenco filtrabile per gruppo, utente, categoria, periodo e `requestId`, con permesso dedicato. Visibilità decisa dall'utente il 2026-11-05: PSA tutto, D propri gruppi, SA proprio gruppo, CA e PA solo le proprie azioni; errori solo al PSA; staff di ruolo superiore mostrato solo col ruolo. Errori JavaScript deduplicati per 10 minuti.

### 2.7 Chiusura
- [x] **2.7.1** Revisione del `security_expert` sulle aree 2.1–2.6 *(fatta a ogni passo 2A, 2B, 2C; 2.6.6–2.6.7 la avranno dopo l'area 3)*.
- [x] **2.7.2** `doc/Technical-Guide.md` §8 e `doc/Data-Model.md` aggiornati; conferma dell'utente.

---

## 3. Autenticazione e utenti

Passi decisi dall'utente il 2026-11-02: **3A** = 1.5.1, 3.1, 3.2, 3.3; **3B** = 1.5.2–1.5.3 e 3.4; **3C** = 3.5.1–3.5.5; **3D** = 3.5.6–3.5.8, poi 2.6.6–2.6.7.

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
| `hiddenInStats` | boolean | `settings.hiddenInStats` | in lettura anche il residuo `permissions.hiddenInStats` |
| `description` | string \| null | `description` | passo 4U |
| `avatar`, `hasAvatar` | string \| null, boolean | `avatar` | data URL PNG/JPEG/WebP ≤ 200 KB; solo nel dettaglio (D-27) |
| `pinSet` | boolean | `pin` | il PIN non è mai mostrato (D-27) |
| `serviceIds` | string[] | `servicesId` | servizi del gruppo (D-27) |
| `permissions` | restrizioni per 13 moduli | `permissions.<modulo>.{r,w}`, `permissions.status` | D-06; PSA e D mostrano i valori effettivi (D-28) |
| `pos` | `{ enabled, grants, options }` | `permissions.apps.cash` | permessi e preferenze della cassa (D-27) |
| `shiftTime` | turni | `shiftTime` | D-27 |
| `createdAt`, `updatedAt` | Date | `insertDate`, `updateDate` | |

- **Conservati e mai esposti su `/v1`:** `password` e `tokens[]` (e il valore del PIN, di cui si mostra solo `pinSet`). Dal passo 4U (D-27) sono invece **gestiti**: `pin`, `permissions.apps.cash.*`, `servicesId`, `shiftTime` e `avatar`; restano conservate e non esposte solo le chiavi residue (`sub.productsStatus`, `sub.deleteTableProductReason`, `options.service`, `permissions.hiddenInStats`).
- **Collection nuova `userCredentials`** (D-03, permanente): `_id` = `userId`, `passwordHash` (scrypt), `legacyHashFingerprint` (impronta dell'hash legacy da cui deriva, 2.2.2), `passwordChangedAt`, `failedLogins`, `lockedUntil`, `lastLoginAt`, `createdAt`, `updatedAt`.

Task:
- [x] **3.1.1** Tipi `User` (dominio) e `LegacyUserDocument` (tutti i campi facoltativi, tipi reali dalla profilazione).
- [x] **3.1.2** Mapper legacy → dominio con raccolta delle anomalie (ruolo sconosciuto, scope incoerente, dati non decifrabili).
- [x] **3.1.3** Mapper dominio → aggiornamento legacy: solo `$set` dei campi posseduti, conversione di stato, cestino e scope (D-08). Matrice dei permessi scritta solo con `$set` puntuali di `permissions.<modulo>.r|w` e `permissions.status` (moduli in allowlist), conservando `apps.cash.*`; `/v1` rifiuta con `422` le modifiche ad `apps` (revisione del passo 2B).
- [x] **3.1.4** Collection `userCredentials` con `$jsonSchema` e indici.
- [x] **3.1.5** Mapper di risposta `/v1` con allowlist esplicita dei campi.
- [x] **3.1.6** Indici su `users` verificati con `getIndexes()`; aggiunta dei soli indici non univoci approvati (`groupId + role`, `dealerId`).

### 3.2 Login e sessioni (backend)
- [x] **3.2.1** `POST /v1/auth/login` con username e password (D-17) e risposta `INVALID_CREDENTIALS` identica per ogni fallimento. Rifiuta, con la stessa risposta:
  - utente disattivato o cestinato;
  - ruolo `E` (il ruolo `API` non esiste più, D-07);
  - gruppo sospeso o cestinato.

  Limiti validati prima di ogni hash (revisione del passo 2A): `username` e `password` da 1 a 1024 unità UTF-16, body del login di pochi KB; oltre i limiti la stessa risposta di credenziali errate. Per gli utenti inesistenti `verifyDummyPassword`.
- [x] **3.2.2** Blocco progressivo con `failedLogins` e `lockedUntil` in `userCredentials`.
- [x] **3.2.3** Collection `sessions` con indici univoci sugli hash e TTL sulla scadenza del refresh.
- [x] **3.2.4** Access token di 15 minuti; refresh con rotazione a ogni uso e rilevamento del riuso (revoca della famiglia e audit); scadenza per inattività e durata massima della famiglia.
- [x] **3.2.5** `POST /v1/auth/refresh` e `POST /v1/auth/logout`; logout da tutti i dispositivi.
- [x] **3.2.6** Trasporto del refresh token secondo D-12 (con finestra di grazia di 30 s per i refresh ripetuti, decisione dell'utente del 2026-11-04): nel body di login e refresh, nessun cookie; il backoffice lo conserva in `sessionStorage`. Compressione disattivata sulle risposte che contengono token.
- [x] **3.2.7** Middleware Bearer di `/v1`:
  - distingue `TOKEN_EXPIRED` da `UNAUTHENTICATED`;
  - a ogni richiesta ricontrolla lo stato di utente e gruppo, con proiezione minima: disattivato ⇒ `401` immediato, come nel legacy.
- [x] **3.2.8** Revoca delle sessioni a cambio password, cambio di ruolo o scope, disattivazione dell'utente e sospensione del gruppo; svuotamento di `users.tokens[]` legacy (D-11).

### 3.3 Profilo e avvio della sessione
- [x] **3.3.1** `GET /v1/me`, riletto a ogni avvio del backoffice. Restituisce:
  - profilo, ruolo, permessi effettivi, riepilogo dello scope;
  - per SA, CA e PA anche il contesto del gruppo (4.3).

  **Mai segreti**: il legacy restituiva l'intero gruppo con le API key e il PIN dell'utente.
- [x] **3.3.2** `PATCH /v1/me`: nome, cognome, email, telefono, lingua e, dal passo 4U, avatar e preferenze della cassa (`pos.options`).
- [x] **3.3.3** Cambio della propria password: richiede la password attuale, revoca le altre sessioni, scrive secondo D-04.
- [x] **3.3.4** Elenco e revoca delle proprie sessioni (dispositivo, IP, ultimo uso). Route del profilo con i permessi `profile:read` e `profile:update` (decisione dell'utente del 2026-11-04); con coesistenza spenta il cambio password rimuove `users.password`.

### 3.4 Gestione utenti (backend)
URL realizzati (passo 3B): utenti di un gruppo sotto `/v1/groups/{groupId}/users`; utenti di piattaforma (PSA, D) sotto `/v1/users`, gestiti solo dal PSA, con elenco trasversale per PSA e D; `GET /v1/usernames/{username}/availability`. Decisioni dell'utente del 2026-11-05: password provvisoria con cambio obbligatorio al primo accesso (per tutti i ruoli); utente nuovo attivo; username nuovi solo ASCII; chi non ha almeno tutti i permessi del bersaglio non può modificarlo, resettarne la password, cestinarlo o eliminarlo; un dealer con gruppi non si elimina.
- [x] **3.4.1** Elenco:
  - filtri per ruolo, stato, cestino, dealer e gruppo (solo PSA e D);
  - ricerca `q` su username, nome, cognome, email e telefono;
  - paginazione a cursore e ordinamenti in allowlist.
- [x] **3.4.2** Dettaglio di un utente nello scope (`404` fuori scope).
- [x] **3.4.3** Creazione:
  - ruolo gestibile da chi crea (pari ammessi, 2.4.4) e scope dentro il suo;
  - scope obbligatorio per ruolo (D-08);
  - username univoco (`409`, D-15);
  - password iniziale secondo la policy (D-19);
  - scrittura compatibile con il legacy (§0.2).
- [x] **3.4.4** Modifica parziale: nessuna modifica del proprio ruolo o scope; i cambi di ruolo, scope o stato revocano le sessioni (3.2.8).
- [x] **3.4.5** Reset della password di un utente subordinato, con revoca delle sue sessioni, password provvisoria e azzeramento del blocco del login.
- [x] **3.4.6** Attivazione e disattivazione.
- [x] **3.4.7** Cestino e ripristino (`trash` legacy); eliminazione definitiva dal cestino secondo D-14 (PSA, D, SA), con credenziali e sessioni.
- [x] **3.4.8** Verifica della disponibilità dello username, con rate limit (sostituisce il controllo a ogni tasto del legacy).
- [x] **3.4.9** Test di isolamento (2.4.5) e di escalation su ogni endpoint.
- [x] **3.4.10** Modello completo dell'utente (passo 4U, D-26, D-27, D-28): 13 moduli della matrice, PIN mai mostrato, avatar, descrizione, servizi, turni, permessi e preferenze della cassa con le regole per CA e PA, creazione con il documento legacy completo e i default del form, scritture per percorso, PSA e D con tutti i permessi.
- [x] **3.4.11** `GET /v1/groups/{groupId}/services`: lettura compatta dei servizi del gruppo (feature `services`), e verifica dei `serviceIds` di un utente.
- [x] **3.4.12** `PUT /v1/me/pin`: cambio del proprio PIN con la password attuale.

### 3.5 Backoffice
- [x] **3.5.1** Pagina di login (Signal Forms, errori accessibili, messaggio di rate limit).
- [x] **3.5.2** Servizio di sessione (sessione esclusiva per scheda con Web Locks: una scheda duplicata chiede il login, decisione dell'utente del 2026-11-05):
  - access token solo in memoria;
  - refresh unico condiviso su `401 TOKEN_EXPIRED`;
  - ripristino della sessione all'avvio;
  - logout.
- [x] **3.5.3** Avvio dell'app con `GET /v1/me`; stato della sessione a signal.
- [x] **3.5.4** Guard `canMatch` per sessione e permesso, direttiva o helper `hasPermission` per menu e azioni (le route sono protette, non solo i menu come nel legacy).
- [x] **3.5.5** Profilo, cambio password, elenco e revoca delle sessioni (con avatar, preferenze della cassa e PIN proprio dal passo 4C-2).
- [x] **3.5.6** Elenco utenti: filtri nell'URL, paginazione a cursore, quattro stati della vista, selezione multipla con conferma.
- [x] **3.5.7** Dettaglio, creazione e modifica dell'utente (con letture compatte di gruppi, aziende e punti vendita aggiunte nel passo 3D per decisione dell'utente del 2026-11-05, da estendere nelle aree 4, 6, 7):
  - ruoli proposti in base a chi crea;
  - scope scelto dai dati di riferimento (4.5.3);
  - errori `422` e `409` sui campi;
  - modello completo a 6 tab con un solo `PATCH`, PIN, avatar, servizi, cassa, listini e turni (passo 4C-2, D-26, D-27, D-31).
- [x] **3.5.8** Reset della password, disattivazione, cestino e ripristino dall'interfaccia.

### 3.6 Chiusura
- [x] **3.6.1** `doc/API.md`, `doc/Technical-Guide.md`, `doc/Data-Model.md` (`users`, `userCredentials`, `sessions`, `rateLimits`, `auditLog`).
- [x] **3.6.2** Revisione del `security_expert` (a ogni passo 3A–3D); conferma dell'utente.

---

## 4. Gruppi

Passi decisi dall'utente il 2026-11-06: **4A** = anagrafica dealer (D-09, realizzata, con le pagine dei dealer nel backoffice per il PSA); **4B** = gruppi nel backend (4.1–4.4, 2.3.4); **4C** = backoffice (4.5).

### 4.1 Modello gruppo
Il modello comprende `dataCluster` (D-25): letto dal nuovo backend; impostato alla creazione (8.1.2); modificabile solo con una procedura di spostamento da progettare a parte.

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
| `integrations` | `Record<Provider, { enabled, apiKeySet }>` | `settings.integrations.<p>.status` | le chiavi sono solo impostabili (D-29), mai esposte |
| `priceLists`, `taxes`, `currencies`, `measureUnits`, `warehouseRules`, `fidelityCardRules` | cataloghi della scheda gruppo | omonimi | sotto-risorse REST (D-29, 4.4.8) |
| fidelity (`cardTypes`, `pointsCollections`, `prizeCatalogues`), `productFavorites`, `promotions` | cataloghi del gruppo | `fidelity.*`, `productsFavorites`, `promotions` | solo nelle sotto-risorse (4.4.9) |
| `createdAt`, `updatedAt` | Date | `insertDate`, `updateDate` | |

- **Feature:** `cash`, `rooms`, `ordering`, `warehouse`, `tobaccosGamesMonopoly`, `productsVariants`, `services`, `appointments`, `customersApp`, `media`, `email`, `scales`, `delivery`, `autoDepartments`, `advancedProducts`.
- **Solo legacy, conservati e mai gestiti né esposti:**
  - `apiKey`, `databaseHost`, `filesHost`;
  - `type`, `plan`, `expirationDate`;
  - `places[]`, mantenuto dal legacy per le statistiche (derivato, D-29).
- **Impostabili ma mai letti:** `settings.integrations.*.apiKey` (si espone solo `apiKeySet`).
- **Cataloghi** (`priceLists`, `taxes`, `currencies`, `measureUnits`, `warehouseRules`, `fidelityCardRules`, `fidelity`, `promotions`, `productsFavorites`): gestiti dal passo 4B-bis come sotto-risorse; restano nel documento del gruppo.

Task:
- [x] **4.1.1** Tipi `Group` e `LegacyGroupDocument`; mapper nei due versi con raccolta delle anomalie.
- [x] **4.1.2** Catalogo delle feature con significato e default; validazione delle lingue.
- [x] **4.1.3** Mapper di risposta senza campi solo legacy né segreti; test che lo verifica su un documento legacy completo.

### 4.2 Feature flag
- [x] **4.2.1** Elenco confermato (D-13) con descrizione di cosa abilita ogni flag.
- [x] **4.2.2** Applicazione lato server: le route dei moduli dichiarano la feature richiesta (2.3.4); comportamento per PSA e D secondo D-13.

### 4.3 Contesto del gruppo
- [x] **4.3.1** `GET /v1/groups/{groupId}` con anagrafica, feature, lingue e impostazioni statistiche; `ETag` e `If-None-Match`.
- [x] **4.3.2** Contesto riletto a ogni avvio e a ogni cambio di gruppo. Nel legacy era una fotografia scattata al login: i flag cambiati da PSA o D arrivavano solo al login successivo.

### 4.4 Gestione gruppi (backend, PSA e D)
- [x] **4.4.1** Elenco:
  - un D vede solo il proprio `dealerId`;
  - filtri per dealer (solo PSA), stato, demo, ricerca sul nome;
  - paginazione a cursore.
- [x] **4.4.2** Conteggi di aziende, punti vendita e utenti per gruppo, letti dal common (dopo l'area 5). *Fatto (backend, 2026-11-13): `counts` con attivi e nel cestino in ogni elemento di `GET /v1/groups` (non nel dettaglio), tre aggregazioni per pagina sugli indici esistenti.*
- [x] **4.4.3** Modifica parziale (campi scalari delle impostazioni comprese). Chi modifica cosa (D-13):
  - nome e descrizione;
  - feature e integrazioni abilitate: PSA e D;
  - `demo`: PSA;
  - lingue e impostazioni statistiche.
- [x] **4.4.4** Sospensione e riattivazione (solo PSA, decisione del 2026-11-02): revoca di tutte le sessioni del gruppo, `status` legacy aggiornato (il legacy lo legge a ogni richiesta), audit.
- [x] **4.4.5** Cestino e ripristino, solo PSA (decisione del 2026-11-02, D-14). `groups:update` di D e SA non può toccare `status` né `trash` (allowlist dei campi).
- [x] **4.4.6** Elenco dei dealer per il filtro di PSA: `GET /v1/dealers` con l'utente D collegato (passo 4A).
- [x] **4.4.7** Test di isolamento: un D non vede né modifica gruppi di un altro dealer (nel legacy poteva farlo con `?groupId=`).
- [x] **4.4.8** Cataloghi della scheda gruppo come sotto-risorse REST (D-26, D-29): `price-lists`, `taxes`, `currencies`, `measure-units`, `warehouse-rules`, `fidelity-card-rules`, in forma legacy esatta, con integrità (predefinito, ultimo, referenziati), concorrenza ottimistica e permessi `groups:*`.
- [x] **4.4.9** Fidelity (`card-types`, `points-collections`, `prize-catalogues`), preferiti (`product-favorites`) e promozioni (`promotions`) come sotto-risorse, con verifica dei riferimenti, permessi `fidelity:*` e `products:*` e perimetro dei punti vendita per CA e PA.
- [x] **4.4.10** Chiavi delle integrazioni impostabili (`apiKey` nel `PATCH` del gruppo, `apiKeySet` nelle risposte), mai lette né registrate.

### 4.5 Backoffice
- [x] **4.5.1** Selettore del gruppo per PSA e D, con il gruppo nell'URL `/groups/:groupId/...` (D-10), voce "Tutti i gruppi" e vista trasversale degli utenti (passo 3D e richiesta dell'utente del 2026-11-06).
- [x] **4.5.2** Feature nel client: menu, route e sezioni condizionati dalle feature del gruppo corrente (guard e direttiva).
- [x] **4.5.3** *(prime letture compatte e selettore del gruppo già realizzati nel passo 3D)* Store dei dati di riferimento del gruppo (sostituisce lo store in memoria del legacy):
  - liste compatte per gruppo, con ETag;
  - riconvalida all'avvio e al cambio di gruppo;
  - invalidazione dopo ogni creazione, modifica o cancellazione;
  - estendibile ad altre entità (categorie, utenti…).
  - *Fatto: `ReferenceStore` (`core/reference`), una pagina per gruppo, lista e parametri con il proprio `ETag`; tabella `REFERENCE_ENDPOINTS` per aggiungere entità; invalidazione dopo le scritture sui listini; svuotato al logout. Documentazione in `doc/Technical-Guide.md` §11.14. Le aziende e i punti vendita non hanno ancora scritture nel backoffice (6.3.3, 7.3.3).*
- [x] **4.5.4** Elenco gruppi con conteggi e dettaglio espandibile (aziende e punti vendita). *Fatto l'elenco con i conteggi (4.4.2); il dettaglio espandibile è sostituito dalla scheda del gruppo (4.5.5).*
- [x] **4.5.5** Dettaglio e modifica del gruppo con la scheda delle feature; pagina "Account › Gruppo" per il SA.

### 4.6 Chiusura
- [x] **4.6.1** `doc/API.md`, `doc/Technical-Guide.md`, `doc/Data-Model.md` (`groups`). *Aggiornati per il backend (passi 4B, 4B-bis, 4U) e per le pagine del backoffice (4C: Technical-Guide §11.11–§11.14).*
- [x] **4.6.2** Revisione del `security_expert`; conferma dell'utente. *Revisione del security_expert del 2026-11-13 senza bloccanti; I-1 corretto; M-1 accettato dall'utente (conteggi visibili senza users:read).*

---

## 5. Aziende e punti vendita nel common: migrazione e sincronizzazione
Strategia in §0.3 (D-01, D-20). I task di 5.3 si fanno nel repository legacy `cloud-commerce-platform-server`, con il suo rilascio; tutti gli altri in questo repository.

> Passo **5A** (2026-11-12): realizzati 5.1, 5.2, 5.4 e 5.5.1/5.5.3 con il comando `npm run sync:copies` (`doc/Technical-Guide.md` §7). Decisioni dell'utente del 2026-11-12: il comando **copia solo lo stato attuale e non cancella mai**; gira **solo in development**, mai in produzione; i database senza documento del gruppo sono solo segnalati; nel legacy la scrittura nel common è semplice (nel punto in cui scrive, scrive lo stesso dato anche nel common), senza altri cambi di comportamento. Caricamento eseguito su development. Passo **5B** (stesso giorno, decisione dell'utente): il backend legge aziende e punti vendita dalle copie del common (`group-mirror.ts`). Restano: 5.3 (repository legacy), 5.5.2 (chiuso il 2026-11-13: niente worker), 5.6, 5.7, 5.8.2.

### 5.1 Prerequisiti
- [x] **5.1.1** Verificare la versione di MongoDB e le transazioni tra database diversi sul cluster Atlas, con i loro limiti di durata.
- [x] **5.1.2** Credenziali Atlas esistenti nel `.env` locale (D-02); guardia 1.3.3 attiva e testata prima di qualunque scrittura.
- [x] **5.1.3** Elenco verificato, con il `legacy_analyst`, di tutti i punti di scrittura su companies e places nel legacy, compresi gli endpoint chiamati dal POS e `groups/generate`.

### 5.2 Collection nel common
- [x] **5.2.1** Collection `companies` e `places`: copia del documento intero, stesso `_id` del database del gruppo (i riferimenti esistenti restano validi), `groupId` dal nome del database (D-20).
- [x] **5.2.2** Indici: `groupId`, `groupId + name`, `groupId + companyId` per i punti vendita. Nessun `$jsonSchema` rigido, che bloccherebbe i salvataggi del legacy su dati sporchi: al massimo `groupId` obbligatorio e di tipo ObjectId.
- [x] **5.2.3** Collection `syncIssues` per le discordanze trovate (`groupId` diverso, copia mancante o diversa), con il motivo e senza dati personali.
- [x] **5.2.4** Specifica del blocco di copia (passi, transazione, errori), scritta prima di toccare il legacy e validata dal `security_expert`.

### 5.3 Doppia scrittura nel legacy (repository legacy)
- [x] **5.3.1** Blocco di copia unico (§0.3, punto 1):
  - lettura degli `_id` coinvolti prima della scrittura;
  - scrittura originale invariata;
  - rilettura dei documenti interi e `replaceOne` con upsert nel common, `groupId` sempre dal nome del database;
  - rimozione della copia per le cancellazioni (D-21).
- [x] **5.3.2** companies: `insertOne`, `updateOne`, `updateMany` e `deleteMany` in transazione con il blocco di copia.
- [x] **5.3.3** places: `insertOne`, `updateOne`, `updateMany` e `deleteMany` in transazione con il blocco di copia. Valgono anche per gli aggiornamenti del POS: `devices.<i>.info`, `rooms`, `suspendedToday`. La `session` va passata a ogni operazione, compresi gli aggiornamenti di `groups.places[]` e `reserve_with_google`.
- [x] **5.3.4** `groups/generate`: inserimento di azienda e punto vendita dentro la transazione, con il blocco di copia.
- [x] **5.3.5** `updateOne` eseguito sull'`_id` risolto prima della scrittura; con `upsert` si copia anche il documento creato. *Decisione dell'utente del 2026-11-13: non si applica; l'`updateOne` dei places resta fuori transazione come nel legacy e le discrepanze le segnala la riconciliazione (5.5).*
- [x] **5.3.6** Blocco di `$out` e `$merge` nelle `aggregate` del legacy. *Rifiuto di `$out`/`$merge` nelle aggregate dei servizi companies e places del legacy (decisione dell'utente del 2026-11-13).*
- [x] **5.3.7** Nessun errore silenziato: se la copia fallisce, la transazione si annulla e la richiesta risponde con un errore; il motivo va nel log.
- [x] **5.3.8** Interruttore da variabile d'ambiente per attivare la copia ambiente per ambiente (prima development, poi produzione).
- [x] **5.3.9** Test del blocco di copia su replica set locale: ogni tipo di scrittura, filtri arbitrari, scritture concorrenti, errore della copia con annullamento.
- [ ] **5.3.10** Rilascio in development, verifica con la riconciliazione (5.5), poi rilascio in produzione. *Per decisione dell'utente del 2026-11-13 la produzione resta spenta (`COMMON_COPY_ENABLED` non attivo).*
  *Stato al 2026-11-13: realizzati nel legacy (non committati) il modulo `modules/CommonCopy.mjs` e la copia nei 10 punti di scrittura, attiva solo con `COMMON_COPY_ENABLED=true`. Secondo la regola dell'utente ("scrivere lo stesso dato anche in common", nessun'altra modifica al legacy):*
  - *companies e `updateMany`/`deleteMany` dei places: scrittura originale e copia nella stessa transazione, con gli `_id` letti col filtro prima della scrittura;*
  - *`insertOne` e `updateOne` dei places: la copia entra nella transazione che il legacy già usa. L'`updateOne` del legacy resta fuori transazione (difetto preesistente): se la copia fallisce l'aggiornamento resta salvato e la riconciliazione lo segnala;*
  - *`groups/generate`: gli inserimenti di azienda e punto vendita restano fuori transazione come nel legacy; le copie si scrivono nella transazione del gruppo, rileggendo gli originali fuori da essa;*
  - *5.3.5 (`updateOne` sull'`_id` risolto) e 5.3.6 non applicati: cambierebbero il comportamento del legacy; nel codice non ci sono `$out` né `$merge`;*
  - *rifiuto con 400 di un `groupId` non esadecimale nelle scritture di companies e places, anche a interruttore spento; vecchi router e modelli rimossi; prove: 16 casi;*
  - *prove: 14 casi (poi 16) su replica set locale usa-e-getta (ogni scrittura, cestino, cancellazione, errore della copia con annullamento, interruttore spento, `groupId` non valido, `generate`); `sync:copies` in development senza differenze.*

### 5.4 Caricamento iniziale (nuovo backend)
- [x] **5.4.1** Comando CLI idempotente, da eseguire dopo l'attivazione della doppia scrittura:
  - elenca i database dell'ambiente filtrati per regex;
  - per ogni gruppo copia i documenti a blocchi, con cursore limitato;
  - ogni blocco gira in transazione, così le scritture concorrenti del legacy vengono serializzate e il caricamento non sovrascrive dati più recenti.
- [x] **5.4.2** Modalità di prova senza scritture, con report per gruppo: conteggi, `groupId` incoerenti, riferimenti orfani.

### 5.5 Riconciliazione (nuovo backend)
- [x] **5.5.1** Comando che confronta, gruppo per gruppo, il database del gruppo e il common: insiemi di `_id` e hash del documento con `groupId` normalizzato. Ripara le differenze e scrive le discordanze in `syncIssues`.
- [x] **5.5.2** Esecuzione periodica nel ruolo `worker` (`doc/Architecture.md` §7), con istanza unica e frequenza da decidere. Allarme se trova differenze: indicano un percorso di scrittura non coperto. *Chiuso per decisione dell'utente del 2026-11-13: niente worker periodico per ora, solo il comando `npm run sync:copies`.*
- [x] **5.5.3** Test su replica set locale: copie mancanti, diverse o in eccesso; gruppi nuovi; database rimossi.

### 5.6 Scritture dal nuovo backend (fase 2)
- [x] **5.6.1** Servizio di scrittura in **transazione** con la stessa regola del legacy:
  - nel database del gruppo, `$set` dei soli campi posseduti, nel formato legacy;
  - poi rilettura del documento intero e copia nel common.
  - *Realizzato il 2026-11-13 come servizio interno **senza route**, usato dall'area 6 (aziende) e dall'area 7 (punti vendita): `backend/src/shared/legacy-write/`, `doc/Technical-Guide.md` §7.*
- [x] **5.6.2** Effetti collaterali che il legacy si aspetta: aggiornamento di `groups.places[]` alla creazione e alla cancellazione di un punto vendita; nessuna modifica a `reserve_with_google`. *Decisione dell'utente del 2026-11-13: `groups.places[]` ricalcolato per intero a ogni scrittura di un punto vendita (creazione, modifica, cestino, ripristino, eliminazione; tutti i punti vendita, cestinati inclusi, `$set`); `reserve_with_google`: `deleteOne` al cestino e all'eliminazione, upsert al ripristino solo se l'integrazione è attiva e completa, nulla a creazione e modifica. Realizzato nel servizio, senza route.*
- [x] **5.6.3** Default compatibili per i documenti creati dal nuovo backend: le strutture che il legacy legge senza controlli (`general`, `openingTime`, `settings.*`…), verificate sul codice legacy. *Decisione dell'utente del 2026-11-13: forma voluta dell'`insertOne` del legacy, senza i campi copiati per errore, più `timezone: 'Europe/Rome'`, `weekGeneric` a sette voci e almeno un deposito. Realizzato nel servizio, senza route.*
- [x] **5.6.4** Politica sui conflitti con modifiche concorrenti dal legacy: `If-Match` lato nuovo backend e ultimo scrittore vince lato legacy, oppure modifica disabilitata nel backoffice legacy. *Decisione dell'utente del 2026-11-13: `If-Match` nel nuovo backend, ultimo scrittore vince nel legacy; da realizzare con la fase 2.*
- [x] **5.6.5** Test: le parti incorporate non possedute (`devices`, `rooms`, `storages`, impostazioni, integrazioni) sopravvivono a ogni scrittura.

### 5.7 Dismissione (fase 3)
- [ ] **5.7.1** Checklist di passaggio:
  - legacy e POS spenti, doppia scrittura rimossa;
  - common unica fonte di verità;
  - conversione dei documenti dal formato legacy al modello di dominio;
  - rimozione delle copie nei database dei gruppi.

### 5.8 Chiusura
- [x] **5.8.1** `doc/Technical-Guide.md` (comandi, riconciliazione, allarmi) e `doc/Data-Model.md`.
- [x] **5.8.2** Revisione del `security_expert` (privilegi, guardie, blocco di copia); conferma dell'utente. *Revisione del 2026-11-13: nuovo backend approvato; i rilievi bloccanti del legacy (B1, B2) corretti; gli altri rilievi del legacy non si correggono: le nuove API non accettano query MongoDB dal client (indicazione dell'utente del 2026-11-13).*

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

**Decisioni dell'utente del 2026-11-13** (analisi completa del legacy nella sessione del 2026-11-13):
- **Modello completo:** si gestiscono **tutti** i dati della company del legacy ("se faccio un salvataggio dal nuovo backoffice il dato deve essere identico e gestibile"): oltre alla tabella, `invoicesPS`, `invoicesPSValues`, `settings.global.*` (`discountLines`, `lastInvoiceNumber`, `enableLoginSignup`, `showPrivacyPage`, `showTermsPage`), `settings.api.cerved`, `settings.ecommerce.*` (27 chiavi, `minAmount` per valuta), `banks`, `ticketsSuppliers`, `medias.images.*`. Tipi BSON identici al legacy (stringhe `''` in `fattura_elettronica`, array sempre presenti, interi o `null`); le chiavi sconosciute si conservano. Gli errori del vecchio backoffice non si replicano (hub azzerato, `minAmount` svuotato, scadenza 1970).
- **Salvataggio:** una sotto-risorsa per scheda (Generale, Fattura elettronica, Numerazione fatture, Banche, Buoni pasto, App clienti ed e-commerce, Media), ciascuna con `If-Match`, **e** un salvataggio unico dell'intera azienda.
- **Permessi:** come la matrice. PSA, D e SA creano, modificano e cestinano nel proprio perimetro; il CA modifica tutte le schede della propria azienda, senza creare né cestinare; `hub`, `IdTrasmittente_*`, `status` ed `expirationDate` solo PSA e D.
- **Hub:** lista chiusa, `aruba` e `aruba__<id>` di un dealer esistente; il PSA sceglie qualsiasi valore ammesso, il D solo `aruba` o il proprio; un valore attuale non ammesso per il D resta invariato se il D non lo cambia. Nessuna verifica Aruba lato server in questa area.
- **P.IVA:** univocità controllata dal servizio (`409` se una P.IVA nuova o cambiata è già usata da un'altra azienda non nel cestino del gruppo); in produzione esistono 6 doppioni (13 aziende in 5 gruppi, conteggio in sola lettura del 2026-11-13) che restano; indice **non** univoco `groupId + code`.
- **IBAN:** validato con il checksum in scrittura, visibile a chi legge l'azienda, mai nei log.
- **`minAmount`:** si modificano le valute del gruppo; le chiavi di valute non più presenti si conservano.
- **Revisione di sicurezza del passo 6A (decisioni dell'utente del 2026-11-13):**
  - (a) nuovo permesso `companies:delete` per `DELETE …/companies/{companyId}`, con gli stessi ruoli e tetti di `companies:trash` (PSA, D, SA; mai CA e PA), derivato dal modulo `companies` della matrice come `users:delete`;
  - (b) `invoiceNumbering.cervedLookup` (`settings.api.cerved`) è un campo riservato a PSA e D come `hub` e `status`: un valore invariato è accettato, uno cambiato dà `403 notAllowed`, alla creazione si confronta con il default (`false`);
  - (c) la corsa sull'univocità della partita IVA (due transazioni concorrenti) è un rischio accettato, senza collection di lock.
- **Media** (decisioni del 2026-11-13, dopo l'analisi dell'upload legacy: in produzione il legacy copia l'originale in tutte e 5 le taglie, con `Content-Encoding: gzip`): stesso bucket GCS e stessi percorsi (`<groupId>/media/image/<xs|s|m|l|xl>/<basename>`) e documento nella collection `files` del gruppo come il legacy; ridimensionamento reale con `sharp` (nuova dipendenza approvata) alle larghezze 100/250/500/800/1200 senza ingrandire, stesso formato; solo JPEG, PNG e WebP verificati dai magic bytes, al massimo 10 MB e 40 megapixel (SVG e GIF rifiutati); nome del file generato dal server (nome originale ridotto a lettere, cifre e trattini, più un suffisso casuale ed estensione dal formato reale); upload nel gruppo dell'URL; credenziali GCS con Workload Identity su GKE e un service account dedicato con permessi minimi in sviluppo (file indicato da variabile d'ambiente), via `fetch` senza SDK; upload ed elenco delle immagini ammessi a chi ha un permesso di modifica di un'entità con immagini (oggi `companies:update`). Il passo 6B comprende upload ed elenco per la scelta dei loghi; modifica, cestino e cancellazione dei file arrivano con il dominio media.

Task:
- [x] **6.1.1** Tipi, mapper e validatori fiscali (P.IVA, codice fiscale, codice destinatario, PEC, regime fiscale), rigorosi in scrittura e tolleranti in lettura. *Passo 6A: tabella unica di mapping legacy ↔ dominio (`company.mapper.ts`), validatori di P.IVA, codice fiscale, IBAN, BIC, ABI/CAB, codice destinatario, regimi fiscali e province (`validators.ts`).*
- [x] **6.1.2** Indici del common: `groupId + status`, `groupId + name`; `vatNumber` univoco per gruppo sulle aziende non nel cestino (D-15), dopo la verifica dei duplicati esistenti. *Passo 6A, secondo la decisione del 2026-11-13: indici non univoci `groupId_1_status_1`, `groupId_1_name_1` (già presente) e `groupId_1_code_1`; l'univocità è controllata dal servizio di scrittura nella transazione (`409 taken`).*

### 6.2 Backend
- [x] **6.2.1** Elenco delle aziende di un gruppo nello scope: filtri per stato, cestino, paese e provincia, ricerca, paginazione a cursore. *Passo 6A: `GET /v1/groups/{groupId}/companies` (filtri `status`, `country`, `province`, `trashed`, `ids`, ricerca su nome e P.IVA).*
- [x] **6.2.2** Lista compatta per i dati di riferimento (`id`, `name`, `status`, `trashed`) con `ETag`. *Passo 6A: è la stessa route, spostata dal modulo `reference` a `companies`, con `id`, `name`, `trashed` invariati per lo `ReferenceStore`.*
- [x] **6.2.3** Dettaglio; CA solo sulle proprie aziende (`404` fuori scope). *Passo 6A: letto dal documento del database del gruppo, `ETag` forte = versione di `If-Match`.*
- [x] **6.2.4** Creazione (PSA e D; da confermare per SA) tramite il servizio 5.6.1. *Passo 6A: PSA, D e SA (decisione del 2026-11-13), `201` con `Location` ed `ETag`.*
- [x] **6.2.5** Modifica parziale dei dati anagrafici e fiscali con validazione; `groupId` immutabile; `hub`, `status` ed `expirationDate` solo PSA e D. *Passo 6A: `PATCH` come salvataggio unico di tutti i campi e blocchi e sei `PUT` per scheda, tutti con `If-Match`; `hub`, `transmitter`, `status` ed `expirationDate` solo PSA e D (un valore invariato è accettato).*
- [x] **6.2.6** Cestino e ripristino; i punti vendita collegati mantengono il riferimento e l'interfaccia lo segnala. *Passo 6A: `POST …/trash` e `…/restore`, più `DELETE` dal cestino (`409 referenced` se un punto vendita, anche cestinato, la usa); i punti vendita mantengono il riferimento.*
- [x] **6.2.7** Test di isolamento e di compatibilità con il legacy (documento rileggibile dal legacy dopo ogni scrittura). *Passo 6A: test di isolamento per ruolo e gruppo, di compatibilità dei tipi BSON con il legacy (documento originale e copia identica), `412` per una scrittura del legacy tra `GET` e `PATCH`.*

### 6.3 Backoffice
- [x] **6.3.1** Elenco aziende con filtri nell'URL. *Passo 6C: `groups/:groupId/companies` con `q`, `status`, `trashed`, `country`, `province`, paginazione a cursore, ordinamento per nome, cestino, ripristino ed eliminazione (dal cestino, con conferma) per permesso; la versione (`If-Match`) si legge dal dettaglio prima di ogni azione; voce di menu "Aziende" per chi ha `companies:read`.*
- [x] **6.3.2** Dettaglio e modifica con le schede Generale e Dati fiscali; errori `422` sui campi. *Passo 6C: tutte le sette schede come route figlie (Generale, Fattura elettronica, Numerazione fatture con il Cerved, Banche, Buoni pasto, App clienti ed e-commerce, Media), "Salva" per scheda (`PATCH` per la scheda Generale, `PUT` per i blocchi) e "Salva tutto" (`PATCH` unico), stato delle schede nella pagina, conferma prima di uscire con modifiche non salvate, errori `422`, `409`, `403` e `412` come da specifica, scelta e caricamento dei loghi dalla libreria dei media.*
- [x] **6.3.3** Aziende nello store dei dati di riferimento (4.5.3), usate da filtri e select. *Passo 6C: ogni scrittura sulle aziende (creazione, nome o stato, cestino, ripristino, eliminazione) invalida le aziende del gruppo nello `ReferenceStore`; paesi e province da `GET /v1/countries` (`Countries`), valute e listini dai dati del gruppo.*

Passi dell'area (proposta del 2026-11-13): **6A** backend dell'azienda (6.1, 6.2, tutte le schede tranne l'upload dei media); **6B** upload dei media (collection `files`, GCS, `sharp`); **6C** backoffice (6.3); **6D** chiusura (6.4).

*Passo 6B realizzato (2026-11-13, confermato dall'utente):* adattatore Google Cloud Storage (`src/integrations/gcs/`, `fetch`, nessun SDK), upload ed elenco delle immagini di un gruppo (`POST`/`GET /v1/groups/{groupId}/media/images`, più `GET …/{imageId}` per il `Location`) con `sharp`, collection `files` nel registro come `legacy-write` (senza indici: i database dei gruppi non ne ammettono), loghi dell'azienda da `{ imageId }`, nuove variabili `MEDIA_STORAGE`, `GCS_MEDIA_BUCKET`, `GCS_AUTH`, `GCS_SERVICE_ACCOUNT_FILE` e `RATE_LIMIT_MEDIA_UPLOAD_PER_USER`. Documentazione: `doc/Technical-Guide.md` §6 "media", `doc/API.md` "Media", `doc/Data-Model.md` `files`. Il punto 6.4 resta aperto.

*Revisione di sicurezza del 6B (2026-11-13), correzioni applicate:* rollback per generation e MD5, `failOn` predefinito di sharp, gate sugli upload, decodifica unica e limite di lato (16383), quote giornaliere (utente 300, gruppo 2000), descrittore del logo con directory fissa e nome semplice, token invalidato su 401, `redirect: 'error'`, scadenza complessiva, gestione dell'insert ambiguo, titoli ripuliti. **Decisione D1 dell'utente:** le immagini hanno un proprietario (`createdBy`, `companyId`), il CA vede e usa solo le immagini delle proprie aziende. **Letture per il 6C:** `GET /v1/countries` e `GET /v1/groups/{groupId}/companies/e-invoicing-hubs`. Non realizzato: un test del timeout di 10 secondi delle pipeline sharp (non riproducibile senza rallentare la suite); il timeout della richiesta intera resta quello di `REQUEST_TIMEOUT_MS`.

*Passo 6C realizzato (2026-11-13, confermato dall'utente):* backoffice delle aziende (6.3.1–6.3.3), documentato in `doc/Technical-Guide.md` §11.15.

### 6.4 Chiusura
- [x] **6.4.1** `doc/API.md`, `doc/Technical-Guide.md`, `doc/Data-Model.md` (`companies`); conferma dell'utente. *Confermato dall'utente il 2026-11-13.*

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

**Decisioni dell'utente del 2026-11-13** (analisi completa del legacy nella sessione del 2026-11-13; superano l'elenco "Restano nel documento" qui sopra dove lo contraddicono):
- **Modello completo:** si possiedono subito tutti i blocchi che oggi scrive solo il backoffice, ciascuno con la sua scheda, salvataggio per scheda e salvataggio unico con `If-Match`, scritture per percorso puntato, tipi BSON identici al vecchio backoffice (`prepareData`), chiavi sconosciute e storiche conservate:
  - Generale (anagrafica, `companyId`, `listId`, `ecommerceListId`, `invoicePS`, `general.priceLists`);
  - Licenza (`plan`, `expirationDate`, `status`, `platform.sentry`);
  - Orari (`timezone`, `openingTime`, `delivery.time`);
  - impostazioni di cassa (`general.*`, `advancedReport.logs`), stampe (`receipt`, `prebilling`, `ordering`), pagamenti (`payments`, `paymentTypes` con id stabili), sale (`roomsSettings` senza `reservation`), prenotazioni (`roomsSettings.reservation`), asporto e consegna, self ordering, kiosk, appuntamenti, display esterno, fidelity, tabacchi (`tgm`), media.
- **Al POS o ai domini successivi:** `devices[]`, `rooms[]`, `storages[]`, `printStations[]` e `productionCenter[]` non si scrivono (si conservano); `integrations.*`, le credenziali delle casse automatiche, `server.ip` e `connectorAddress` sono **esclusi** dall'area 7 (mai restituiti né scritti), arrivano con il dominio integrazioni come campi solo impostabili.
- **`suspendedToday`:** modificabile anche dal nuovo backoffice, con scrittura puntata.
- **Template di creazione:** l'oggetto completo del punto vendita con tutti i suoi campi, nella forma che il vecchio backoffice salva e i dispositivi leggono (supera la 5.6.3 dove differisce: `ordering.numberFontSize`, `receipt.noFiscalTaxes*`, `receipt.invoiceQt: 1`, `roomsSettings.exitsNumber: 5`…).
- **Permessi:** come il legacy. PSA, D e SA creano e cestinano; il CA modifica tutte le schede dei punti vendita delle proprie aziende, il PA quelle del proprio; `plan` lo modifica solo il PSA, ma il D lo sceglie in creazione; `expirationDate`, `status` e le impostazioni dealer solo PSA e D. Valori storici di `plan` conservati finché un PSA non li cambia.
- **Stato:** esposto come `active`/`disabled`, modificabile da PSA e D, filtro negli elenchi.
- **Duplica:** prevista (PSA e D), replica **tutto** il punto vendita (dispositivi, sale, depositi, integrazioni compresi) tranne la chiave di negozio, che va ricreata dopo la duplicazione.
- **D-24 (deciso):** una **chiave per punto vendita**. La nuova app ha un solo server locale per punto vendita che parla con il cloud; i dispositivi parlano solo con il server di negozio, con sicurezza interna fuori da questo progetto. Una sola chiave attiva per punto vendita: una nuova attivazione revoca subito la precedente; nessuna scadenza fino a revoca; attivazione e revoca solo PSA e D. Un punto vendita disattivato o con licenza scaduta (`expirationDate` passata) è bloccato (`403`) finché non viene riattivato o la data non viene spostata; il gruppo sospeso o nel cestino blocca senza revocare.

**Decisioni dell'utente del 2026-11-16** (revisione del dettaglio del punto vendita; superano le decisioni del 2026-11-13 dove le contraddicono):
- **Organizzazione identica al legacy:** nove schede nell'ordine del legacy (Generale, Dispositivi, Postazioni comanda, Sale, Depositi, Orari, Media, Impostazioni, Integrazioni); la scheda Impostazioni ha il menu laterale del legacy (4 gruppi, 14 voci: rivenditore, generali, ristorazione; asporto e consegna, prenotazione tavoli, self ordering, display esterno, kiosk, appuntamenti, fidelity, tabacchi e giochi; stampa e layout; altre impostazioni, pagamenti); ordine, sezioni ed etichette dei campi come il legacy; PSA e D vedono sempre tutte le voci, gli altri ruoli secondo le feature del gruppo (analisi in `backend/reports/place-tabs-legacy.md`, non versionata).
- **Licenza e chiave di negozio come il legacy:** piano, scadenza e stato nella scheda Generale; Sentry e chiave di negozio nella voce "Impostazioni rivenditore" (PSA e D).
- **Salvataggio unico come il legacy:** un solo Salva nella testata (salvataggio unico con le schede modificate); menu ⋮ per PSA e D con scarica e carica JSON completo come il legacy.
- **Tutte le schede modificabili ora:** dispositivi, postazioni comanda e centri di produzione, sale con l'editor della disposizione dei tavoli, depositi, integrazioni (credenziali solo impostabili, mai restituite) e impostazioni rivenditore (`server.ip`, `connectorAddress`), anticipati dai domini successivi.

**Nota 7F (2026-11-16, backend delle schede anticipate).** Realizzati nel backend: dispositivi, postazioni comanda e centri di produzione, sale con tavoli e layout, depositi, integrazioni (16 provider, credenziali solo scrivibili con flag `…Set`, interruttori riservati a PSA e D, feed Reserve with Google riallineato) e impostazioni rivenditore (`server.ip`, `connectorAddress`, `platform.sentry` che passa da `license` a `dealerSettings`). Scelte oltre la specifica: `status` di un nuovo dispositivo creato una volta; rimozione di un dispositivo occupato `409`; nomi derivati dei dispositivi calcolati dal server; feed RWG rimosso (non lasciato com'è) se l'integrazione è attiva ma incompleta; i riferimenti pendenti dopo una rimozione restano come nel legacy; `userId` dei tavoli solo nel formato; `tsh.tshCategories` solo lettura. Documentato in `doc/API.md` ("passo 7F"), `doc/Technical-Guide.md` §6 e `doc/Data-Model.md`. **Caso noto da contare in produzione prima del rilascio:** liste con elementi senza `id` o con `id` ripetuto (dispositivi, postazioni, centri, sale, tavoli, depositi). Quella lista è di sola lettura (`editable: false`, elementi con `withoutId: true`) e ogni modifica è `409`; va contato quanti punti vendita reali la hanno e decisa una bonifica dei dati. **Revisione di sicurezza 7F e decisioni dell'utente del 2026-11-16:** **(a)** la versione (`ETag`) del writer diventa **HMAC-SHA256** con la nuova variabile obbligatoria `VERSION_HMAC_KEY` (base64/base64url, almeno 32 byte; il server non parte senza): vale per aziende e punti vendita, gli unici che usano `versionOf`; utenti e cataloghi del gruppo non la usano. **(b)** le credenziali dei **pagamenti** (Stripe: `publicKey`, `privateKey`, `webhookPrivateKey`; Dojo `apiKey`; Satispay `activationCode`, `keyId`; Qodeup `apiKey`) sono riservate a **PSA e D** (`403 notAllowed` se un altro ruolo le imposta, cambia o cancella; assenti sono accettate); non incluse: le credenziali della cassa automatica dei dispositivi, Plateform, Cooperto, Yellgo, Leggimenu, Tomato Ai, Easy Appear, TSH e Phlex (non incassano pagamenti del punto vendita). Corretti: id ripetuti come id mancanti (C3), dispositivo occupato anche nella transazione (C4), commento del registro (C5), formato delle credenziali dei dispositivi e niente `trim` (S1, S2), URL `https` e telefono per il feed di Google (S3), utente dei tavoli verificato dove cambia (S4), default di Sentry alla creazione (S5), test per risposta idempotente, chiavi vietate, dealer, limiti (S6, S8). **Scostamento accettato (C2):** il dettaglio legge ancora il documento intero (credenziali comprese) in memoria e le scarta nel mapper, invece di calcolare i flag `…Set` nel database come D-29: il writer ne ha bisogno per calcolare la versione (che comprende le credenziali), e una proiezione obbligherebbe a escluderle dalla versione; da rivedere insieme al §12 punto 8 della sicurezza. **Aperto (S7):** le copie nel common contengono ancora il documento intero (credenziali comprese); `sync:copies` e `profile:legacy` stampano solo conteggi e non documenti (non verificato nei dettagli per `profile:legacy`). In attesa di conferma dell'utente.

**Nota 7G (2026-11-16, backoffice del dettaglio identico al legacy).** Realizzati nove schede in alto, menu laterale delle impostazioni (14 voci), salvataggio unico con menu ⋮ (JSON), dispositivi, postazioni, sale con editor della disposizione, depositi, integrazioni e impostazioni rivenditore (con chiave di negozio). Scelte oltre la specifica: card orari asporto per PSA/D o `rooms`; area di consegna sempre visibile (il legacy la lega a Google Maps); nessun `permissions.calendar.w` per gli appuntamenti; niente QR code dei tavoli (il legacy portava la chiave API del gruppo nell'URL); riordino con pulsanti su/giù al posto del drag and drop; la pagina di un nuovo punto vendita mostra solo Generale; le azioni dei provider (scansione terminali Dojo, KeyId Satispay, categorie TS Hospitality, config del Connector) non hanno API e non sono realizzate. Documentato in `doc/Technical-Guide.md` §11.16. In attesa di conferma dell'utente.

Passi dell'area (proposta del 2026-11-13): **7A** backend del punto vendita, Generale, Licenza, Orari, elenco, creazione, cestino, duplica; **7B** backend delle schede di impostazioni; **7C** chiave di negozio (D-24); **7D** backoffice; **7E** chiusura.

Task:
- [x] **7.1.1** Tipi, mapper e validatori; controllo dell'appartenenza di `companyId` al gruppo. *Passo 7A: `place.types.ts`, tabella unica `PLACE_LEAVES` (`place.mapper.ts`) con la lettura tollerante e la scelta delle chiavi da scrivere, schemi per allowlist, validatori delle aziende riusati (paese, provincia, e-mail), `companyId` controllato nel gruppo, non nel cestino e nel perimetro (`writer.companyOfPlace`, `422 incorrect`).*
- [x] **7.1.2** Indici del common: `groupId + companyId`, `groupId + status`, `groupId + name`. *Passo 7A: aggiunto `groupId_1_status_1` (gli altri due c'erano già).*

### 7.2 Backend
- [x] **7.2.1** Elenco dei punti vendita di un gruppo nello scope:
  - filtri per azienda, stato, piano, cestino, paese e provincia;
  - ricerca;
  - ordinamento prima della paginazione.
  *Passo 7A: `GET /v1/groups/{groupId}/places` (filtri `companyId`, `status`, `plan`, `trashed`, `country`, `province`, `ids`; `q` su nome e città; `sort` `name`, `-name`, `expirationDate`, `-expirationDate`, applicato prima della paginazione con l'id come spareggio).*
- [x] **7.2.2** Lista compatta per i dati di riferimento (`id`, `name`, `companyId`, `plan`, `status`, `trashed`) con `ETag`. *Passo 7A: è la stessa route, spostata dal modulo `reference` a `places`, con `id`, `name`, `companyId`, `trashed` invariati per lo `ReferenceStore` e in più `plan`, `status`, `city`, `province`, `country`, `expirationDate`.*
- [x] **7.2.3** Dettaglio; CA e PA solo nel proprio scope. *Passo 7A: letto dal documento del database del gruppo, `ETag` forte = versione di `If-Match`; mai integrazioni, credenziali, `server.ip`, `connectorAddress`, dispositivi, sale, depositi.*
- [x] **7.2.4** Creazione (PSA e D) tramite il servizio 5.6.1, con aggiornamento di `groups.places[]` (5.6.2). *Passo 7A: solo PSA e D (decisione del 2026-11-13; SA, CA e PA `403`), con `Idempotency-Key`; documento completo nella forma del vecchio backoffice, `201` con `Location` ed `ETag`; il piano lo scelgono PSA e D (il D senza `desk-secondary`).*
- [x] **7.2.5** Modifica parziale dei dati anagrafici; cambio di azienda solo all'interno del gruppo. *Passo 7A: `PATCH` come salvataggio unico di Generale, Licenza e Orari e `PUT` per Licenza e Orari, tutti con `If-Match`; scrittura per percorsi foglia; `companyId` solo verso aziende del gruppo, non cestinate e nel perimetro.*
- [x] **7.2.6** Sotto-risorsa per piano (solo PSA) e scadenza (PSA e D): permette il rinnovo inline come nel legacy. *Passo 7A: `PUT …/license` (`plan`, `expirationDate`, `status`, `sentry`); `plan` e `sentry` PSA, `expirationDate` e `status` PSA e D (un valore invariato è accettato); piano storico conservato.*
- [x] **7.2.7** Cestino e ripristino. *Passo 7A: `POST …/trash` e `…/restore`, più `DELETE` dal cestino con il nuovo permesso `places:delete` (`409 referenced` se un utente del gruppo ha il punto vendita nel perimetro) e `POST …/duplicate` (PSA e D, replica tutto salvo la chiave di negozio). Il cestino non azzera l'indirizzo.*
- [x] **7.2.8** Test di isolamento e di sopravvivenza delle parti incorporate (5.6.5). *Passo 7A: isolamento per ruolo, gruppo e dealer su ogni route; sopravvivenza byte per byte di `devices[i].info`, `rooms[].tables`, `storages[].id`, `suspendedToday`, `integrations.*`, chiavi sconosciute e tipi BSON esatti dopo ogni scrittura; una scrittura del POS tra `GET` e `PATCH` non dà `412`, una del legacy a un percorso posseduto sì; copia identica, `groups.places` e feed di Reserve with Google verificati.*

**Decisioni dell'utente del 2026-11-13, dopo la revisione di sicurezza del 7A:**
- **(a)** `desk-secondary` è del solo PSA, anche alla creazione: il D sceglie solo tra `basic`, `advanced`, `enterprice` e `tgm-secondary`, altrimenti `403 notAllowed`.
- **(b)** **Il SA non crea punti vendita**: `places:create` è nel tetto di PSA e D soltanto (la duplicazione resta di PSA e D). Il SA mantiene lettura, modifica, cestino ed eliminazione.
- **(c)** **Idempotenza** su `POST …/places`, `POST …/places/{placeId}/duplicate` e, per coerenza, `POST …/companies`: header `Idempotency-Key` (UUID) obbligatorio (`422 required`), stessa chiave e stesso body ⇒ stessa risposta salvata (stato, body, `Location`, `ETag`), body diverso ⇒ `409`, chiavi per utente e per route, collection `idempotencyKeys` con indice univoco e TTL di 24 ore, richiesta concorrente con la stessa chiave ⇒ `409` finché la prima è in corso (`shared/http/idempotency.ts`).
- Correzioni di sicurezza applicate: nessuna lettura delle serie di un'azienda rifiutata (C1), perimetro applicato nel `gate` e in `duplicatePlace` del writer (C2), conteggio dei giorni speciali che ignora le chiavi conservate che non sono date (S5), note su duplicazione, riferimenti all'eliminazione e chiave di negozio (7C) in `doc/`.

*Passo 7A realizzato (2026-11-13, confermato dall'utente il 2026-11-16):* backend del punto vendita con Generale, Licenza e Orari, documentato in `doc/Technical-Guide.md` §6 "places" e `doc/API.md` "Punti vendita". *Passo 7B realizzato (2026-11-13, confermato dall'utente il 2026-11-16):* tredici blocchi di impostazioni (cassa, stampe, pagamenti, sale, prenotazioni, asporto e consegna, self ordering, kiosk, appuntamenti, display esterno, fidelity, tabacchi, media) nel dettaglio, nel `PATCH` e con una `PUT` ciascuno, a percorsi foglia con i tipi del vecchio backoffice; `roomsSettings.reservation.suspendedToday` posseduto; collection `email_templates` nel registro (`legacy-read`); campo riservato `appointments.webWidgetStatus`; documentato in `doc/API.md` ("Impostazioni del punto vendita"), `doc/Technical-Guide.md` §6 e `doc/Data-Model.md`. Restano 7C (chiave di negozio) e il backoffice (7.3).

**Decisioni dell'agente oltre la specifica, da confermare:** `UTC` accettato oltre ai valori di `Intl.supportedValuesOf('timeZone')` (l'elenco di ICU non lo comprende); orari `HH:mm` e date dei giorni speciali controllati solo dove cambiano; `special` conserva le chiavi memorizzate che non sono date e `week` le chiavi non `0`–`6`; il listino delle vendite è aggiunto a `priceLists` come fa il vecchio backoffice; un punto vendita nel cestino non si duplica (`409`) e la duplicazione con azienda inesistente o nel cestino dà `409`; `groupId` della copia = quello verificato; template di creazione: `connectorAddress: ''`, testi del kiosk `{ it: '' }`, `delivery.minAmount: {}`, `prebilling.sequentialNumberFontSize` `1-1` come il form; tetti di CA e PA ridotti a lettura e modifica (il CA aveva creazione e cestino) e, per decisione (b), del SA senza creazione; il controllo dei riferimenti prima dell'eliminazione considera anche gli utenti nel cestino.

**Passo 7C: chiave di negozio (D-24), decisioni dell'utente del 2026-11-13 sul disegno del `security_expert`:**
- **Q1** la chiave precedente si revoca **allo scambio** del nuovo codice (transazione dello scambio, motivo `replaced`), non alla generazione: nessun fermo durante la sostituzione dell'hardware. **Q2** il codice vale **24 ore** (`STORE_ACTIVATION_CODE_TTL_MINUTES`, 5…10080). **Q3** gruppo sospeso o nel cestino: la chiave è **bloccata, non revocata**. **Q4** punto vendita `disabled` e **licenza scaduta** (`expirationDate` passata rispetto all'orologio del server, `null` = nessuna scadenza) **bloccano**: `403 STORE_DISABLED`, nulla è revocato, riprende dopo il rinnovo; anche l'azienda nel cestino blocca. **Q5** stato della chiave (ultimo contatto, versione, IP) visibile **solo a PSA e D**. **Q6** codice distinto `403 STORE_DISABLED`. **Q7** IP dell'ultimo contatto in chiaro, come per le sessioni. **Q8** route `GET /v1/store-context` solo per il negozio. **Q9** `api:store` a **600 al minuto per chiave**.
- **Scelte dell'agente dove il disegno lasciava libertà (raccomandate), da confermare:** la revoca per cestino o eliminazione del punto vendita avviene **subito dopo** la scrittura del servizio (non nella sua transazione), con la verifica a ogni richiesta come rete di sicurezza; la chiave sostituita ha come autore della revoca l'utente che ha generato il nuovo codice; la creazione di un codice è rifiutata (`409`) anche per un punto vendita con licenza scaduta o azienda nel cestino; `store.activationFailed` è registrato al più 10 volte all'ora per IP; `store.revokedKeyPresented` al più una all'ora per chiave; filtri e `companyInScope` dello scope `store` come da disegno, ma `companiesScopeFilter`, `groupsScopeFilter` e il registro delle attività non hanno il caso `store` (tipizzati sullo scope degli utenti: nessun negozio può arrivarci).
- [x] **7.2.9** Collection `storeActivationCodes` e `storeKeys` (validatori, indici: univoci su hash e codice, **una chiave attiva per punto vendita** con indice univoco parziale, TTL).
- [x] **7.2.10** Codice di attivazione (generazione, normalizzazione, hash), scambio anonimo `POST /v1/store-activations` in transazione, principal `store` (`res.locals.store`), smistatore del Bearer per prefisso, verifica a ogni richiesta con blocco e revoca, `STORE_PROFILE` (`places:read`), `GET /v1/store-context`, regola `api:store`, opt-in `store: true` del builder con controlli all'avvio.
- [x] **7.2.11** Gestione (solo PSA e D): stato, generazione e annullamento del codice, revoca; revoca al cestino e all'eliminazione del punto vendita; eventi `store.*` e attore `store` nel registro; redazione di `fc_sk_` e `activationCode`.
- [x] **7.2.13** Revisione di sicurezza 7B/7C applicata (2026-11-13): `api:store` applicata dall'autenticazione della chiave a ogni richiesta di una chiave attiva (anche le rifiutate con `403` e i negozi bloccati; test con 601 richieste), scambi falliti contati in `auth-fail:ip`, revoca della chiave dopo l'evento di dati del cestino o dell'eliminazione e con errore registrato senza cambiare l'esito, regole delle impostazioni che non usano l'azienda rifiutata, `tobacco.placeId` che rifiuta un punto vendita nel cestino, lettore separato dallo scrittore (`companiesPlacesReader`), `.gitleaks.toml` (confine finale, `st` tolto). Residui in `doc/Security-Model.md` §5 e `doc/API.md`; da verificare prima del rilascio con il `legacy_analyst`: punti vendita con `expirationDate` all'epoca del legacy (bloccherebbero il negozio).
- [x] **7.2.14** Tre letture per il backoffice (7D): `GET /v1/groups/{groupId}/lookup/email-templates`, `GET …/lookup/languages` e `GET …/places/{placeId}/invoice-series` (`places:update`, scope del punto vendita), con `ETag` e `304`; `doc/API.md`, `doc/Technical-Guide.md` §6.
- [x] **7.2.12** Test di rifiuto (401 identici, 403 senza opt-in, 404 fuori dal proprio punto vendita, blocchi e riprese, revoche, concorrenza degli scambi, rate limit) e documentazione (`doc/Security-Model.md` §3, §5, §7, §8, §10, §12, `doc/Architecture.md`, `doc/API-Guidelines.md`, `doc/API.md`, `doc/Technical-Guide.md`, `doc/Data-Model.md`, skill `store-key-auth`).

*Passo 7C realizzato (2026-11-13, confermato dall'utente il 2026-11-16):* chiave di negozio documentata in `doc/Security-Model.md` §5, `doc/Technical-Guide.md` §6 "store-keys" e `doc/API.md` ("Chiave di negozio"). Interfaccia nel backoffice (riquadro "Server di negozio" della scheda del punto vendita) con il passo 7D. Prerequisito di produzione: copie del common affidabili (`COMMON_COPY_ENABLED`).

### 7.3 Backoffice
- [x] **7.3.1** Elenco punti vendita con filtri nell'URL e rinnovo inline della scadenza. *Passo 7D: `places-list`, rinnovo inline (PSA e D), cestino, ripristino, eliminazione, duplica con conferma, voce di menu; `Idempotency-Key` anche sulla creazione delle aziende.*
- [x] **7.3.2** Dettaglio e modifica. *Passo 7D: sedici schede (Generale, Licenza, Orari, Cassa, Stampe con import/export JSON, Pagamenti, Sale, Prenotazioni, Asporto e consegna, Self ordering, Kiosk, Appuntamenti, Display esterno, Fidelity, Tabacchi, Media), vedi `doc/Technical-Guide.md` §11.16. Secondo giro: select dei modelli e-mail, lingue e serie fatture dalle nuove letture compatte; scheda Chiave di negozio (7C) per PSA e D con genera/annulla codice e revoca.*
- [x] **7.3.3** Punti vendita nello store dei dati di riferimento (4.5.3); scope di CA e PA applicato dal server, non dal client. *Passo 7D: ogni scrittura che cambia nome, azienda, stato, cestino, o crea/duplica invalida `places` nello `ReferenceStore`.*
- [ ] **7.3.4** Riquadro "Server di negozio" nella scheda del punto vendita, visibile con `storeKeys:read`: stato, ultimo contatto (con avviso oltre 24 ore), versione, piattaforma, IP, chi ha attivato; codice pendente con "Annulla codice"; "Genera codice di attivazione" (`storeKeys:manage`) con dialog che mostra il codice una sola volta, "Copia", scadenza, e che alla chiusura lo toglie dalla memoria (mai in `httpResource`, cache o store dei riferimenti); "Revoca" con conferma esplicita.

### 7.4 Chiusura
- [x] **7.4.1** `doc/API.md`, `doc/Technical-Guide.md`, `doc/Data-Model.md` (`places`); conferma dell'utente. *Confermato dall'utente il 2026-11-16.*

---

## 8. Onboarding di un nuovo cliente
Sostituisce il wizard "Nuovo cliente" e `groups/generate` del legacy, che non era atomico.
- [ ] **8.1.1** Analisi del `legacy_analyst`: collection e documenti minimi che un database di gruppo nuovo deve avere perché legacy, POS e `ms-integration-service` funzionino (D-18).
- [ ] **8.1.2** Creazione atomica e idempotente (`Idempotency-Key`) di gruppo, azienda, punto vendita, utente SA e database del gruppo, con scelta del cluster (`dataCluster`, D-25; default finché il legacy è attivo).
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
- **Accesso dell'app del server di punto vendita alle API `/v1`:** la credenziale è la chiave di negozio (D-24, passo 7C); restano da decidere, con i domini che apriranno le scritture del negozio, l'attribuzione dell'operatore e le route che il negozio può chiamare.
- **Catalogo:** prodotti, categorie (albero, da aggiungere allo store dei dati di riferimento), reparti, brand, attributi, varianti, import/export, TGM. *(Listini, aliquote, unità di misura, preferiti e promozioni sono già gestiti come cataloghi del gruppo, passo 4B-bis.)*
- **Magazzino:** depositi del punto vendita, causali, movimenti, giacenze.
- **Dispositivi del punto vendita:** casse, palmari, stampanti fiscali, casse automatiche (credenziali cifrate), bilance, display.
- **Ristorazione:** sale e tavoli, postazioni comanda, centri di produzione, prenotazioni dei tavoli.
- **Vendite e cassa:** chiusure, turni, checkout, permessi e preferenze dell'app di cassa (`permissions.apps.cash`), operatori `E` e PIN (`doc/Security-Model.md` §12.2), modalità UM e `sType`.
- **Documenti fiscali:** fatture, scontrini, sezionali, coda e-fatture Aruba, Fiskaly, allarmi dei documenti in errore.
- **Clienti e fedeltà:** contatti, gruppi di contatti, carte, raccolte punti, template e-mail.
- **Calendario e appuntamenti:** servizi e turni degli utenti *(i turni e l'elenco dei servizi di un utente sono già nel suo modello, passo 4U)*.
- **Media e file:** upload sicuro, avatar, immagini.
- **Statistiche e report**, log, cestino, diagnostica.
- **Integrazioni:** pagamenti (Satispay, Dojo, Flood Pay), canali (EasyAppear, Yellgo, LeggiMenu, Plateform, Cooperto, Qodeup), Reserve with Google, gestionali alberghieri, Cerved.
- **Piattaforma:** paesi e province, attivazioni e canoni, release, fLite, app pubbliche (prenotazioni, Flood Pay).
