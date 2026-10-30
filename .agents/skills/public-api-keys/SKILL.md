---
name: public-api-keys
description: Usa quando crei, verifichi, elenchi, ruoti o revochi le API key della superficie pubblica /public/v1 (una o più per gruppo): generazione con CSPRNG, hash a riposo, permessi, restrizioni di scope, scadenza, ultimo uso.
---
# Public API Keys

Riferimenti: `doc/Security-Model.md` §6, collection `apiKeys` in `doc/Data-Model.md`. Le API key valgono **solo** su `/public/v1`; i server di punto vendita usano un'altra credenziale (skill `store-server-auth`).

## Formato
`fc_pk_` + 32 byte casuali (`randomBytes(32).toString('base64url')`). Si salvano:
- `keyHash`: SHA-256 del segreto completo (indice univoco);
- `displayPrefix`: i primi 12 caratteri, per riconoscerla negli elenchi;
- `groupId`, `name`, `permissions`, `companyIds`/`placeIds` opzionali, `rateLimitPerMinute`, `monthlyQuota`, `expiresAt`, `createdBy`, `createdAt`, `lastUsedAt`, `revokedAt`.

Il segreto completo si restituisce **solo** nella risposta di creazione (`201`) e non è più recuperabile.

## Chi le gestisce
- `SA` per il proprio gruppo; `D` e `PSA` per i gruppi nel proprio scope.
- I permessi di una chiave appartengono al **catalogo pubblico** (un sottoinsieme dei permessi interni) e non possono superare quelli di chi la crea.
- Limiti e quote: default di piattaforma; solo `D` e `PSA` li modificano.

## Verifica (middleware della superficie pubblica)
1. Header `X-Api-Key` presente, con prefisso `fc_pk_` e lunghezza esatta ⇒ altrimenti `401 UNAUTHENTICATED`.
2. `findOne({ keyHash: hashToken(key), revokedAt: null })`; assente o scaduta ⇒ `401`.
3. Gruppo `active` ⇒ altrimenti `401`.
4. `req.auth = { kind: 'apiKey', principalId, groupId, permissions: new Set(permissions), scope: { companyIds, placeIds } }` congelato.
5. Rate limit e quota della chiave (skill `rate-limiting-metering`), poi conteggio d'uso.
6. `lastUsedAt` aggiornato al massimo una volta al minuto.

Il header `Authorization` su `/public/v1` viene ignorato: le credenziali delle altre superfici non valgono qui.

## Rotazione e revoca
Rotazione = nuova chiave + revoca della vecchia quando l'integrazione è aggiornata. Revoca immediata dal backoffice. Mai modificare il segreto di una chiave esistente. Creazione, modifica dei limiti e revoca vanno nell'audit log.

## Mai
Chiavi in chiaro nel database, nei documenti del gruppo, nei log o negli URL; `Math.random`; chiavi senza permessi espliciti; CORS aperto su `/public/v1`.

## Test obbligatori
Chiave valida, assente, malformata, inesistente, revocata, scaduta; permesso insufficiente (`403`); gruppo sospeso; accesso a dati di un altro gruppo (`404`); restrizione a punti vendita rispettata; segreto assente nelle risposte di elenco; credenziale del backoffice rifiutata su `/public/v1`.
