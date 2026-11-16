---
name: store-key-auth
description: Usa quando tocchi la chiave di negozio (D-24) con cui il server di punto vendita chiama /v1: codice di attivazione monouso, scambio anonimo, chiave fc_sk_ a riposo, principal store in res.locals.store, opt-in store delle route, blocco STORE_DISABLED e revoca, profilo STORE_PROFILE, rate limit api:store, eventi store.* e test di rifiuto.
---
# Store Key Auth (server di punto vendita)

Riferimenti: `doc/Security-Model.md` §5, §7, §8.2 e §8.3; collection `storeKeys` e `storeActivationCodes` in `doc/Data-Model.md`; codice in `src/modules/store-keys/`. Decisione D-24 (2026-11-13): **una chiave per punto vendita, una sola attiva, nessuna scadenza fino a revoca, attivazione e revoca solo PSA e D**. L'app del negozio è fuori scope (D-22): chiama le stesse route `/v1` (D-23), non esiste una superficie dedicata.

## Flusso: codice monouso, poi chiave
1. PSA o D chiede il codice (`POST …/places/{placeId}/store-key/activation-codes`, `storeKeys:manage`): 16 simboli Crockford base32 da `randomBytes(16)` con `& 31` (uniforme), 80 bit, `XXXX-XXXX-XXXX-XXXX`, validità 24 ore configurabile. Si salva **solo lo SHA-256 del codice normalizzato**, uno solo pendente per punto vendita (`replaceOne` con upsert su `placeId`), mostrato una volta (route `compress: false`). La chiave attiva non si tocca.
2. L'app lo scambia con `POST /v1/store-activations` (anonima, rate limit per IP prima del body, body ≤ 2 KB). Normalizzazione: maiuscole, senza `-` e spazi, `O→0`, `I/L→1`, poi formato esatto, **altrimenti nessuna query**.
3. **Una transazione sul common**: `findOneAndDelete` del codice per hash con `expiresAt > now` (un solo vincitore), verifica dello stato (gruppo, punto vendita, azienda), revoca della chiave attiva (`replaced`), inserimento della nuova. Un codice esistente si **consuma anche** se il punto vendita non è operativo (la transazione fa commit senza altre scritture). Ogni fallimento è lo stesso `401 INVALID_CREDENTIALS`.
4. Chiave: `generateSecret('fc_sk_')` (256 bit), a riposo `hashSecret` + primi 4 caratteri (`keyHint`), mostrata una volta (`compress: false`).

## Verifica a ogni richiesta (`authenticate-store.ts`)
Lo smistatore `createCredentialDispatcher` guarda **solo il prefisso** del Bearer (`fc_sk_` → negozio, altro → utenti). Poi: formato esatto (altrimenti `401` senza query) → hash → chiave `active` (assente o revocata: `401` identico; una revocata ancora in uso registra `store.revokedKeyPresented`, 1 all'ora per chiave) → `assess` dello stato:
| Stato | Effetto |
|---|---|
| gruppo inesistente | `401` |
| gruppo sospeso o nel cestino | blocco `403 STORE_DISABLED`, nessuna revoca |
| punto vendita assente o nel cestino | **revoca** (`placeDeleted`, `placeTrashed`) e `401`: copre anche il cestino del legacy |
| punto vendita `status` diverso da `true`, `expirationDate` passata (rispetto all'orologio del server; `null` o non data = nessuna scadenza) | blocco `403` |
| azienda attuale nel cestino o senza copia | blocco `403` |
Le copie di punto vendita e azienda si leggono **solo** da `trustedGroupMirror` (proiezioni a allowlist). Il blocco finisce da solo (riattivazione, ripristino, rinnovo). Un punto vendita ripristinato non riottiene la chiave. `lastSeenAt` si aggiorna al più una volta al minuto, fuori dal percorso della risposta, con l'errore solo loggato.

## Principal e opt-in delle route
- `res.locals.store` (mai `res.locals.auth`): i middleware e i servizi tipizzati sull'utente non trovano un principal e rifiutano, quindi **nulla pensato per gli utenti è raggiungibile da un negozio per sbaglio**.
- `STORE_PROFILE` (`policy.ts`): allowlist fissa, oggi `places:read`; si estende solo per decisione, un dominio alla volta.
- Una route è aperta al negozio solo con `auth: { …, store: true }` (permesso singolo nel profilo, `group: true`, `:placeId` nel percorso, mai `allowWithPendingPasswordChange`) oppure `auth: { kind: 'store' }` (solo negozio, nessun parametro). `validateRoutes` blocca l'avvio se non è così o se la superficie non ha `storeKeys: true` e `rateLimit.storeApiRule`. Senza opt-in una chiave di negozio ha `403 FORBIDDEN` subito dopo l'autenticazione.
- Rate limit: `api:store` si applica in `authenticate-store.ts`, subito dopo la chiave attiva e prima di `assess`, così conta anche i `403` senza opt-in e i blocchi (non sta nel builder). Gli scambi falliti consumano anche `auth-fail:ip`.
- Catena del negozio: gruppo (scope `store`) → `requireStorePlace` (`:placeId` = punto vendita della chiave, altrimenti `404` identico, prima della validazione) → `requireStorePermission` → feature. **La regola `api:user` non conta un negozio** (la sua chiave è `res.locals.auth`): il builder monta `api:store` sul ramo del negozio e un test lo dimostra.

## Revoca
Una sola `findOneAndUpdate` condizionata a `status: 'active'` (idempotente, mai registrata due volte), `purgeAt` = 365 giorni. Cause: esplicita (`DELETE …/store-key`), `replaced`, `placeTrashed`, `placeDeleted` (il servizio dei punti vendita revoca subito dopo la scrittura; la verifica a ogni richiesta è la rete). Mai scritture nel documento del punto vendita.

## Segreti e log
Il logger redige per prefisso `fc_sk_` e per nome `activationCode`; il registro non contiene mai codice né chiave, solo `keyId`, `keyHint` e motivi. Eventi: `store.activationCodeCreated|Cancelled`, `store.activated`, `store.activationFailed` (≤ 10 all'ora per IP), `store.keyRevoked`, `store.revokedKeyPresented`; attore `store` con l'id della chiave.

## Test obbligatori (oltre al 100% di copertura)
Chiave assente, malformata, sconosciuta, revocata: `401` identici; `fc_sk_` su route senza opt-in `403`; credenziali dei due tipi mai confuse, `fc_pk_` su `/v1` `401`; altro punto vendita, altro gruppo, elenchi, route di utenti, gruppi e aziende; gruppo sospeso o nel cestino, punto vendita disattivato, licenza scaduta, azienda nel cestino: blocco e ripresa; cestino del punto vendita da servizio e da copia (legacy), ripristino, copia assente; duplicazione senza chiave né codice; scambio con codice scaduto (prima del TTL), già usato, sbagliato, con operatori (`{"$ne": ""}`), concorrente (un solo vincitore), con chiave attiva (`replaced`, una sola attiva); SA, CA, PA `403` sulla gestione, D fuori dai propri gruppi `404`; rate limit di scambio, `api:store` applicato anche a route rifiutate e a negozi bloccati (601 richieste ⇒ `429`) e scambi falliti nel limite per IP; nessun `fc_sk_` né codice nei log e nel registro; risposte con segreti non compresse.
