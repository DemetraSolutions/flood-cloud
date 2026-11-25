# Linee Guida API REST

> Regole vincolanti per ogni endpoint. Il legacy esponeva quasi solo `POST` con query MongoDB nel body: qui si applica il paradigma REST in modo rigoroso.

## 1. Risorse e URL
- Le URL identificano **risorse** (sostantivi), mai azioni: `/v1/products`, non `/v1/products/find`.
- Nomi al **plurale**, in inglese, **kebab-case**: `/v1/product-categories`.
- Collezione e elemento: `/v1/products` e `/v1/products/{productId}`.
- **Annidamento** solo per relazioni di appartenenza reali e al massimo un livello: `/v1/companies/{companyId}/places`. Una risorsa con identità propria resta raggiungibile anche dalla radice (`/v1/places/{placeId}`).
- Operazioni che non sono CRUD si modellano come **sotto-risorse** create con `POST`: `POST /v1/sales/{saleId}/refunds`, `POST /v1/groups/{groupId}/suspension`.
- Prefisso di superficie e versione: `/v1` e `/public/v1` (la superficie `/store/v1` è eliminata, D-23) (`doc/Architecture.md` §4). Una modifica incompatibile richiede una nuova versione.

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
| `400` | richiesta malformata (percorso, dimensione o protocollo) | `BAD_REQUEST` |
| `304` | rivalidazione riuscita (`If-None-Match` corrisponde all'`ETag`), senza body; oggi solo `GET /v1/groups/{groupId}` | — |
| `401` | credenziale assente, non valida, scaduta, revocata | `UNAUTHENTICATED`, `TOKEN_EXPIRED`, `CLOCK_SKEW` |
| `401` | credenziali di login errate o account non ammesso (risposta identica per ogni caso) | `INVALID_CREDENTIALS` |
| `403` | autenticato ma senza permesso | `FORBIDDEN` |
| `403` | password provvisoria da cambiare (consentite solo profilo, cambio password e logout) | `PASSWORD_CHANGE_REQUIRED` |
| `403` | il gruppo non ha acceso il modulo a cui appartiene la route (vale per ogni ruolo, PSA e D compresi; dopo il controllo di gruppo e permesso) | `FEATURE_DISABLED` |
| `403` | il server di punto vendita ha una chiave valida ma il punto vendita non è operativo (gruppo sospeso o nel cestino, punto vendita disattivato o con licenza scaduta, azienda nel cestino): nulla è revocato, riprende da solo | `STORE_DISABLED` |
| `404` | inesistente **o fuori scope** | `NOT_FOUND` |
| `405` | metodo non supportato sulla risorsa (+ `Allow`) | `METHOD_NOT_ALLOWED` |
| `409` | conflitto, duplicato, stato incompatibile | `CONFLICT` |
| `409` | unicità violata, con `details: [{ "field": "username", "issue": "taken" }]` | `CONFLICT` |
| `409` | eliminazione rifiutata: elemento predefinito o ultimo (`default`, `last`) o ancora usato da altri elementi (`referenced`, un `details` per elemento che lo usa) | `CONFLICT` |
| `412` | `If-Match` non corrispondente | `PRECONDITION_FAILED` |
| `413` | payload troppo grande | `PAYLOAD_TOO_LARGE` |
| `415` | content type non supportato | `UNSUPPORTED_MEDIA_TYPE` |
| `422` | validazione fallita (con `details` per campo) | `VALIDATION_ERROR` |
| `429` | rate limit o quota (+ `Retry-After`) | `RATE_LIMITED`, `QUOTA_EXCEEDED` |
| `500` | errore interno, senza dettagli | `INTERNAL_ERROR` |
| `502` | errore di un provider esterno (irraggiungibile, timeout, risposta inattesa), senza dettagli del provider; distinto da `503` (integrazione non configurata o sganciata) e da `422` (credenziali rifiutate dal provider, sul campo della credenziale) | `PROVIDER_ERROR` |
| `503` | servizio non pronto (readiness, arresto in corso) | `SERVICE_UNAVAILABLE` |
```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Invalid request", "details": [{ "field": "price", "issue": "minimum" }] } }
```

`issue` possibili nei `details` dei `422`: `required`, `type`, `minLength`, `maxLength`, `pattern`, `minimum`, `maximum`, `enum`, `unknown`, `forbiddenKey`, `format`, `tooDeep`, `tooMany` (anche un elenco o un documento oltre il limite), `incorrect` (valore o riferimento non valido; anche un elemento ripetuto in un elenco di elementi univoci), `reused`, `immutable`, `notAllowed` (il campo non è consentito in quel contesto: anche nei `details` dei `403` quando un ruolo invia un campo che non può dare); `taken` compare invece nei `details` dei `409` di unicità, e `default`, `last`, `referenced` in quelli dei `409` di eliminazione rifiutata.

## 6. Idempotenza e concorrenza
- **`Idempotency-Key`** (UUID) obbligatoria sulle scritture del server di punto vendita (chiave di negozio, D-24: oggi il negozio non scrive) e sulle creazioni sensibili ai doppioni (vendite, documenti, pagamenti): stessa chiave e stesso body ⇒ stessa risposta; stessa chiave e body diverso ⇒ `409`. Come è realizzata (`shared/http/idempotency.ts`; oggi su `POST` di aziende e punti vendita e sulla duplicazione di un punto vendita): header mancante `422` (`required`), non UUID `422` (`format`); la stessa chiave con lo stesso body restituisce stato, body, `Location` ed `ETag` della prima risposta di successo, senza rieseguire; body diverso `409` (`reused`), prima richiesta ancora in corso `409`; chiavi per utente e per route, conservate 24 ore; una richiesta che fallisce libera la chiave.
- **Concorrenza ottimistica** dove più utenti modificano la stessa risorsa: `ETag` in risposta e `If-Match` sulle modifiche (`412` se cambiata nel frattempo). Si introduce nel passo che ne ha bisogno.

## 7. Header
- In ingresso: `Authorization` (Bearer: token del backoffice o chiave di negozio `fc_sk_…`; nessun header dedicato alla chiave di negozio), `X-Api-Key` (solo `/public/v1`), `Idempotency-Key`, `If-Match`, `X-Request-Id` (opzionale, altrimenti generato).
- In uscita: `X-Request-Id`, `Location` (creazioni), `ETag`, `RateLimit-*`, `Retry-After`.

## 8. Documentazione
Ogni endpoint è descritto in `doc/API.md` nello stesso passo in cui nasce: superficie, metodo e percorso, permesso, parametri e schema del body, esempio di risposta, errori possibili.
