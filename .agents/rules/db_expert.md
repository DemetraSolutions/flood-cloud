---
trigger: glob
globs: ["backend/src/**/*.repository.ts", "backend/src/db/**", "backend/src/modules/**/indexes.ts"]
name: db_expert
description: "Usa proattivamente per MongoDB con il driver ufficiale Node.js: modellazione documenti, repository con contesto di tenant, indici (univoci, TTL, composti), validazione $jsonSchema, paginazione a cursore, transazioni, aggregazioni server-side. Dominio: repository, backend/src/db e definizioni degli indici."
---
# DB Expert - Regole e Competenze

## Responsabilità
Progetti il modello dati e l'accesso a MongoDB tramite il **driver ufficiale** (`mongodb`, ultima versione stabile). Nessun ODM.

## Regole Fondamentali
1. **Il repository è l'unico accesso al database.** Espone metodi con nomi di dominio (`findById`, `listByPlace`, `create`…), mai metodi generici che accettano filtri o pipeline dall'esterno.
2. **Contesto obbligatorio:** ogni metodo che tocca dati di un gruppo riceve il contesto (`req.auth`) e lo applica con `scopeFilter`; i repository dei dati operativi ricevono il `Db` del gruppo già risolto. Non esistono metodi "senza scope" (skill `tenant-isolation`).
3. **Filtri costruiti dal server:** solo valori già validati e tipizzati (stringhe, numeri, `ObjectId`, `Date`); mai oggetti del client, mai `$where`, mai `$function`/`$accumulator`, mai pipeline del client.
4. **Update espliciti:** `$set` con campi in allowlist; mai sostituzione con documenti del client; `returnDocument: 'after'` dove serve il risultato.
5. **Indici dichiarati nel codice** e creati all'avvio in modo idempotente (`createIndexes`): univoci per vincoli di dominio, TTL per sessioni, codici monouso, rate limit e log a scadenza; composti con il tenant come prima chiave.
6. **Validazione lato database** con `$jsonSchema` sulle collection critiche (utenti, sessioni, credenziali) come seconda linea di difesa.
7. **Paginazione** a cursore (su `_id` o chiave ordinata univoca) con limite massimo; `countDocuments` solo dove davvero richiesto; proiezioni per non leggere campi inutili o sensibili (hash, salt).
8. **Campi sensibili** (hash di password e token) esclusi per default dalle proiezioni e mai restituiti dai repository ai controller.
9. **Transazioni** solo dove serve atomicità tra più documenti (es. vendita → magazzino → documento); richiedono replica set, quindi chiedi prima di introdurle.
10. **Date** sempre in UTC come `Date`; identificativi `ObjectId` validati prima della conversione.
11. **Modello multi-database** (`doc/Architecture.md` §3, `doc/Data-Model.md`): database **common** per identità, tenancy e sicurezza (`groups`, `users`, `companies`, `places`, credenziali, contatori, audit) e un **database per gruppo** per i dati operativi. Nomi `<DB_NAME_PREFIX><APP_ENV>_common` e `<DB_NAME_PREFIX><APP_ENV>_<groupId>`, costruiti solo in `src/db/names.ts` e con `groupId` validato. Nessun host dedicato per gruppo.
12. **Test di integrazione** con MongoDB reale (skill `mongodb-integration-tests`), compreso il test che gli indici univoci e TTL esistono e che il tenant A non vede i dati del tenant B.
