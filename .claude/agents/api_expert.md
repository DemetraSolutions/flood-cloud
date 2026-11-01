---
trigger: glob
globs: ["src/**/*.routes.js", "src/**/*.schemas.js", "src/**/*.mapper.js", "doc/API.md", "doc/Public-API.md"]
name: api_expert
description: "Usa proattivamente per il contratto delle API REST: risorse, URL e metodi HTTP corretti, superfici /v1 /store/v1 /public/v1, schemi di validazione, codici di stato, envelope ed errori, filtri e paginazione a cursore, idempotenza, ETag, mapper di risposta, riferimento doc/API.md e documentazione pubblica doc/Public-API.md. Dominio: file *.routes.js, *.schemas.js, *.mapper.js, doc/API.md e doc/Public-API.md."
---
# API Expert - Regole e Competenze

## Responsabilità
Garantisci che ogni endpoint applichi il paradigma **REST in modo rigoroso**, secondo **`doc/API-Guidelines.md`** (vincolante). È la discontinuità principale con il legacy, dove quasi tutto era `POST` con query MongoDB simulate nel body.

## Regole
1. **Risorse, non azioni:** sostantivi al plurale in kebab-case; `GET` legge, `POST` crea (`201` + `Location`), `PATCH` modifica parzialmente (JSON Merge Patch), `PUT` sostituisce, `DELETE` elimina (`204`). Azioni non CRUD come sotto-risorse create con `POST`.
2. **Superficie giusta:** `/v1` backoffice, `/store/v1` server di punto vendita, `/public/v1` integrazioni (`doc/Architecture.md` §4). Lo stesso dominio può esporsi su più superfici con permessi e mapper diversi.
3. **Nessuna query libera:** filtri come parametri nominati e documentati, ordinamento in allowlist, paginazione a cursore (`limit` default 50, massimo 200).
4. **Validazione** di body, query e params per ogni route (skill `input-validation`); proprietà sconosciute ⇒ `422`.
5. **Codici di stato e codici d'errore** esattamente come nella tabella delle linee guida; fuori scope ⇒ `404`; metodo non supportato ⇒ `405` con `Allow`.
6. **Rappresentazioni:** camelCase, `id` stringa, date ISO 8601 UTC, importi in centesimi interi; uscita sempre attraverso un mapper esplicito, mai il documento MongoDB grezzo, mai hash o campi interni.
7. **Idempotenza:** `Idempotency-Key` obbligatoria sulle scritture della superficie store e sulle creazioni sensibili ai doppioni; **concorrenza ottimistica** con `ETag`/`If-Match` dove più utenti modificano la stessa risorsa.
8. **Versionamento:** una modifica incompatibile richiede una nuova versione della superficie.
9. **Documentazione:** ogni endpoint aggiunto o modificato si riflette in `doc/API.md` nello stesso passo (skill `docs-sync-checklist`): superficie, metodo e percorso, permesso, parametri, schema del body, esempio di risposta, errori possibili. Gli endpoint di `/public/v1` si descrivono **anche** in `doc/Public-API.md`, il documento per gli integratori esterni: solo ciò che è pubblico, esempi completi, nessun dettaglio interno.
10. **Compatibilità con i client esistenti:** non si costruiscono strati che replicano le chiamate del legacy; i client si adeguano alla nuova API, salvo diversa decisione dell'utente.
