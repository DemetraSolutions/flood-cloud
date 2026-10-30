# Linee Guida API REST

> Regole vincolanti per ogni endpoint. Il legacy esponeva quasi solo `POST` con query MongoDB nel body: qui si applica il paradigma REST in modo rigoroso.

## 1. Risorse e URL
- Le URL identificano **risorse** (sostantivi), mai azioni: `/v1/products`, non `/v1/products/find`.
- Nomi al **plurale**, in inglese, **kebab-case**: `/v1/product-categories`.
- Collezione e elemento: `/v1/products` e `/v1/products/{productId}`.
- **Annidamento** solo per relazioni di appartenenza reali e al massimo un livello: `/v1/companies/{companyId}/places`. Una risorsa con identità propria resta raggiungibile anche dalla radice (`/v1/places/{placeId}`).
- Operazioni che non sono CRUD si modellano come **sotto-risorse** create con `POST`: `POST /v1/sales/{saleId}/refunds`, `POST /v1/store-servers/{id}/activation-codes`.
- Prefisso di superficie e versione: `/v1`, `/store/v1`, `/public/v1` (`doc/Architecture.md` §4). Una modifica incompatibile richiede una nuova versione.

## 2. Metodi
| Metodo | Uso | Sicuro | Idempotente | Successo |
|---|---|---|---|---|
| `GET` | lettura di collezione o elemento | sì | sì | `200` |
| `POST` | creazione in una collezione / sotto-risorsa azione | no | no (sì con `Idempotency-Key`) | `201` + `Location` |
| `PUT` | sostituzione completa (solo dove ha senso) | no | sì | `200` |
| `PATCH` | modifica parziale (JSON Merge Patch, RFC 7396) | no | no | `200` |
| `DELETE` | eliminazione | no | sì | `204` |
`GET` non modifica mai lo stato e non ha body.

## 3. Rappresentazioni
- `Content-Type: application/json; charset=utf-8`; richieste con altro tipo ⇒ `415`.
- Campi in **camelCase**; identificativi come stringhe (`"id"`, non `"_id"`).
- Date ISO 8601 in UTC (`2026-10-30T14:05:00.000Z`).
- **Importi in centesimi interi** con valuta esplicita dove serve (mai float per denaro).
- Nessun campo interno o segreto in uscita: ogni risposta passa da un mapper esplicito.
- Envelope: `{ "data": ... }` per i successi; `{ "data": [...], "page": {...} }` per le liste; `{ "error": {...} }` per gli errori.

## 4. Liste: filtri, ordinamento, paginazione
- **Filtri** come parametri nominati e documentati: `GET /v1/products?categoryId=…&status=active`.
- **Ricerca** testuale con `q` (escape delle regex lato server, lunghezza limitata).
- **Ordinamento** `sort=name,-createdAt` solo su campi in allowlist e indicizzati.
- **Paginazione a cursore**: `limit` (default 50, massimo 200) e `cursor` opaco; risposta `page: { limit, next }` con `next: null` all'ultima pagina.
- Nessuna query, proiezione o pipeline MongoDB dal client.

## 5. Codici di stato ed errori
| Codice | Quando | `error.code` |
|---|---|---|
| `400` | JSON malformato | `MALFORMED_JSON` |
| `401` | credenziale assente, non valida, scaduta, revocata | `UNAUTHENTICATED`, `TOKEN_EXPIRED`, `CLOCK_SKEW` |
| `403` | autenticato ma senza permesso | `FORBIDDEN` |
| `404` | inesistente **o fuori scope** | `NOT_FOUND` |
| `405` | metodo non supportato sulla risorsa (+ `Allow`) | `METHOD_NOT_ALLOWED` |
| `409` | conflitto, duplicato, stato incompatibile | `CONFLICT` |
| `412` | `If-Match` non corrispondente | `PRECONDITION_FAILED` |
| `413` | payload troppo grande | `PAYLOAD_TOO_LARGE` |
| `415` | content type non supportato | `UNSUPPORTED_MEDIA_TYPE` |
| `422` | validazione fallita (con `details` per campo) | `VALIDATION_ERROR` |
| `429` | rate limit o quota (+ `Retry-After`) | `RATE_LIMITED`, `QUOTA_EXCEEDED` |
| `500` | errore interno, senza dettagli | `INTERNAL_ERROR` |
```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Invalid request", "details": [{ "field": "price", "issue": "minimum" }] } }
```

## 6. Idempotenza e concorrenza
- **`Idempotency-Key`** (UUID) obbligatoria sulle scritture della superficie store e sulle creazioni sensibili ai doppioni (vendite, documenti, pagamenti): stessa chiave e stesso body ⇒ stessa risposta; stessa chiave e body diverso ⇒ `409`.
- **Concorrenza ottimistica** dove più utenti modificano la stessa risorsa: `ETag` in risposta e `If-Match` sulle modifiche (`412` se cambiata nel frattempo). Si introduce nel passo che ne ha bisogno.

## 7. Header
- In ingresso: `Authorization`, `X-Api-Key` (solo `/public/v1`), `Idempotency-Key`, `If-Match`, `X-Request-Id` (opzionale, altrimenti generato).
- In uscita: `X-Request-Id`, `Location` (creazioni), `ETag`, `RateLimit-*`, `Retry-After`.

## 8. Documentazione
Ogni endpoint è descritto in `doc/API.md` nello stesso passo in cui nasce: superficie, metodo e percorso, permesso, parametri e schema del body, esempio di risposta, errori possibili.
