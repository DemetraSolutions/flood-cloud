---
name: api-key-management
description: Usa quando crei, verifichi, ruoti o revochi API key per integrazioni server-to-server, o credenziali e codici di enrollment dei dispositivi POS: generazione con CSPRNG, hash a riposo, scope, scadenza, ultimo uso.
---
# API Key & Device Credentials

## Formato
`fc_live_` (o `fc_test_` negli ambienti non di produzione) + 32 byte casuali in base64url. Si salvano:
- `keyHash`: SHA-256 del segreto completo (indice univoco);
- `displayPrefix`: i primi 12 caratteri, per riconoscerla negli elenchi;
- `tenantId`, `name`, `scopes` (es. `['products:read', 'sales:write']`), `placeIds` opzionale, `expiresAt` opzionale, `createdBy`, `createdAt`, `lastUsedAt`, `revokedAt`.

Il segreto completo si restituisce **solo** nella risposta di creazione (201) e non è più recuperabile.

## Verifica (middleware)
1. Header `X-Api-Key` presente e con prefisso atteso, lunghezza esatta ⇒ altrimenti 401.
2. `findOne({ keyHash: hashToken(key), revokedAt: null })`; scaduta o assente ⇒ 401.
3. Tenant attivo ⇒ altrimenti 401.
4. `req.auth = { kind: 'apiKey', principalId, tenantId, permissions: new Set(scopes), scope: { placeIds } }`.
5. Rate limit per chiave.

Gli scope di una chiave non possono superare i permessi di chi la crea.

## Rotazione
Creazione della nuova chiave → periodo di sovrapposizione deciso dall'utente → revoca della vecchia. Mai modificare il segreto di una chiave esistente.

## Dispositivi POS (enrollment)
1. Un amministratore con permesso `devices:enroll` crea un **codice monouso** (8–10 caratteri alfanumerici non ambigui, scadenza in minuti, hash salvato, legato a company e place, tentativi limitati).
2. Il dispositivo chiama l'endpoint pubblico di enrollment con il codice (rate limit severo); il codice viene consumato in modo atomico (`findOneAndUpdate` con `usedAt: null`).
3. Il server crea il dispositivo e una credenziale `fc_dv_…` (hash a riposo) restituita una sola volta.
4. La credenziale si revoca dal backoffice; `lastSeenAt` si aggiorna a ogni uso.

> Dettagli del flusso dispositivi e del PIN operatore: decisione aperta (`doc/Security-Model.md` §10.6).

## Mai
Chiavi in chiaro nel database o nei documenti del tenant, `Math.random`, chiavi senza scope, chiavi inviate dal client per conto di terzi, chiavi nei log o negli URL.

## Test obbligatori
Chiave valida, assente, malformata, inesistente, revocata, scaduta, scope insufficiente (403), tenant sospeso, segreto non presente nelle risposte di elenco, codice di enrollment riusato o scaduto.
