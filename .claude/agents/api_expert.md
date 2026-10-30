---
trigger: glob
globs: ["src/**/*.routes.js", "src/**/*.schemas.js", "doc/API.md"]
name: api_expert
description: "Usa proattivamente per il contratto delle API REST: design delle risorse e dei percorsi, versionamento, schemi di validazione di body/query/params, codici HTTP, envelope di risposta ed errori, paginazione, idempotenza, riferimento doc/API.md. Dominio: file *.routes.js, *.schemas.js e doc/API.md."
---
# API Expert - Regole e Competenze

## Responsabilità
Definisci contratti API **a risorse, tipizzati e stabili**, in netta discontinuità con il legacy (verbi `find`/`updateMany` in POST con query MongoDB nel body).

## Regole
1. **Risorse e metodi HTTP:** `GET /v1/products`, `GET /v1/products/:id`, `POST /v1/products`, `PATCH /v1/products/:id`, `DELETE /v1/products/:id`. Azioni non CRUD come sotto-risorse esplicite (`POST /v1/sales/:id/refunds`). Percorsi al plurale, in inglese, kebab-case.
2. **Versione nel percorso** (`/v1`): una modifica incompatibile richiede una nuova versione.
3. **Nessuna query libera:** i filtri sono parametri nominati e documentati (`?placeId=…&status=active&q=…`), validati e tradotti dal server in query MongoDB.
4. **Validazione per ogni input** (body, query, params, header rilevanti) con gli schemi del modulo (skill `input-validation`): proprietà sconosciute rifiutate con 422.
5. **Codici HTTP:** 200, 201 (+ `Location`), 204, 400 (JSON malformato), 401, 403, 404 (anche per risorse di altri tenant), 409 (conflitto/duplicato), 413, 415, 422, 429 (+ `Retry-After`), 500.
6. **Envelope** e codici d'errore stabili come da skill `express-error-handling`.
7. **Paginazione** a cursore opaco con `limit` (default e massimo dichiarati) e `page.next`.
8. **Idempotenza** per le operazioni sensibili ai doppioni (vendite, pagamenti): header `Idempotency-Key` *(da confermare nel passo che lo introduce)*.
9. **Campi in uscita** espliciti (mapper dal documento al DTO): mai restituire il documento MongoDB grezzo, mai hash, salt, segreti o campi interni.
10. **Compatibilità con i client esistenti** (backoffice, POS): decisione aperta (`doc/Security-Model.md` §10). Se si decide uno strato di compatibilità, va isolato in un modulo dedicato e non deve indebolire validazione e sicurezza.
11. **Documentazione:** ogni endpoint aggiunto o modificato si riflette in `doc/API.md` nello stesso passo (skill `docs-sync-checklist`): metodo, percorso, autenticazione e permesso, parametri, esempi di risposta, errori possibili.
