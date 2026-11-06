# Modello Dati — Database Common

> Collection di identità, tenancy e sicurezza nel database `<DB_NAME_PREFIX><APP_ENV>_common` (`doc/Architecture.md` §3).
> I campi sono il punto di partenza: si confermano nel passo che implementa ogni collection. I domini operativi (catalogo, vendite…) si documentano quando vengono affrontati.

Convenzioni: nomi in camelCase inglese; date `Date` in UTC; riferimenti `ObjectId`; `createdAt`/`updatedAt` su ogni documento; cancellazione logica con `deletedAt` dove serve conservare lo storico. Campi segreti (hash) mai restituiti dalle API.

## groups — tenant
| Campo | Tipo | Note |
|---|---|---|
| `_id` | ObjectId | anche suffisso del nome del database del gruppo |
| `name` | string | |
| `dealerId` | ObjectId \| null | dealer che ha creato il gruppo |
| `status` | `active` \| `suspended` | sospeso ⇒ tutte le credenziali del gruppo rifiutate |
| `dataCluster` | string \| assente | id del cluster MongoDB con il database del gruppo (decisione del 2026-11-06); assente ⇒ cluster di default dei gruppi; letto dal nuovo backend, scritto dalla creazione dei gruppi (area 4) |
| `createdAt`, `updatedAt`, `deletedAt` | Date | |
Indici: `dealerId`, `status`.

## users — utenti (collection legacy condivisa, D-03)
Realizzata come **lettura e scrittura compatibile con il legacy** (passo 3A): il documento resta nel formato legacy, la traduzione nel modello di dominio avviene nel repository (`backend/src/modules/users/`). Campi legacy principali e loro significato nel dominio:
| Campo legacy | Dominio | Note |
|---|---|---|
| `_id` | `id` | ObjectId |
| `userName` (in subordine `username`) | `username` | nuovi o cambiati: unici globalmente confrontando NFKC, spazi e minuscole (D-15); indice legacy `userName_1` univoco esatto, intatto |
| `name`, `surname`, `email`, `telephone` | `firstName`, `lastName`, `email`, `phone` | in chiaro (D-05) |
| `role` | `role` | PSA, D, SA, CA, PA, E; assente = E; altri valori (es. `API`) = nessun accesso |
| `groupId`, `dealerId` | idem | ObjectId |
| `companyId` | `companyIds` | lista nel dominio, scritta come primo elemento (D-08) |
| `placeId`, `placesId` | `placeIds` | unione in lettura; in scrittura `placeId` = primo, `placesId` = tutti (D-08) |
| `status`, `trash` | `status` (`active`/`disabled`), `trashed` | booleani legacy |
| `settings.language`, `settings.hiddenInStats` | `language`, `hiddenInStats` | |
| `permissions.<modulo>.{r,w}`, `permissions.status` | matrice dei permessi, `canManagePermissions` | D-06; `permissions.apps.*` conservato, mai scritto né esposto |
| `password` | — | hash legacy HMAC-SHA512 (D-04); al cambio password scritto se la coesistenza è attiva, rimosso se è spenta |
| `tokens` | — | JWT legacy; svuotato a revoca, cambio password, disattivazione (D-11) |
| `pin`, `servicesId`, `shiftTime`, `avatar` | — | conservati, mai esposti su `/v1` |
| `insertDate`, `updateDate` | `createdAt`, `updatedAt` | |
- Scrittura solo con `$set`/`$unset` dei campi posseduti (elenco nel registro delle collection del backend), mai sostituzione del documento.
- Indici aggiunti dal nuovo backend (non univoci): `groupId_1_role_1`, `dealerId_1`.

## userCredentials — credenziali del nuovo backend
Realizzata (passo 3A, D-03): `_id` = id dell'utente, `passwordHash` (scrypt `scrypt$N$r$p$salt$hash`, facoltativo), `legacyHashFingerprint` (SHA-256 dell'hash legacy da cui deriva, o null), `passwordChangedAt`, `failedLogins`, `lockedUntil` (blocco progressivo dal 5° fallimento: 1, 2, 4, 8, poi 15 minuti; azzerati dal reset dell'amministratore), `mustChangePassword` (password provvisoria impostata da un amministratore: va cambiata al primo accesso; passo 3B), `lastLoginAt`, `createdAt`, `updatedAt`. Validazione `$jsonSchema`; nessun indice oltre `_id`.

## companies — soggetti giuridici
`_id`, `groupId`, `name`, `vatNumber`, `fiscalCode`, `address`, `status`, `createdAt`, `updatedAt`, `deletedAt`.
Indici: `groupId`; univocità di `vatNumber` per gruppo *(da confermare)*.

## places — punti vendita
`_id`, `groupId`, `companyId`, `name`, `address`, `status`, `createdAt`, `updatedAt`, `deletedAt`.
Indici: `groupId + companyId`.
Le parti incorporate nel legacy (depositi, sale, tavoli, dispositivi) si definiscono nei rispettivi passi.

## storeServers — server di punto vendita
| Campo | Tipo | Note |
|---|---|---|
| `_id` | ObjectId | `storeServerId` |
| `groupId`, `companyId`, `placeId` | ObjectId | scope fisso |
| `name` | string | |
| `status` | `pending` \| `active` \| `revoked` | |
| `keys` | `{ keyId, publicKey, createdAt, revokedAt }[]` | chiave pubblica Ed25519 (SPKI, base64); una sola attiva |
| `lastSeenAt`, `lastIp`, `softwareVersion`, `hostname` | | |
| `activatedAt`, `revokedAt`, `createdBy`, `createdAt`, `updatedAt` | | |
Indici: `placeId`; `groupId`; `keys.keyId` univoco.

## platformSettings — impostazioni di piattaforma
Documento unico (`_id: 'platform'`), modificabile solo da `PSA`; ogni modifica va nell'audit log.
| Campo | Tipo | Note |
|---|---|---|
| `storeServerSilenceThresholdHours` | number \| null | soglia di silenzio dei server di punto vendita; `null` o assente ⇒ nessun allarme (`doc/Security-Model.md` §5.7) |
| `updatedBy`, `updatedAt` | | |

## storeServerActivations — codici di attivazione
`_id`, `storeServerId`, `codeHash` (univoco), `expiresAt` (TTL), `attempts`, `usedAt`, `createdBy`, `createdAt`.

## storeServerNonces — anti-replay delle asserzioni
`_id` = `<storeServerId>:<jti>`, `expiresAt` (TTL, poco oltre la tolleranza di ±5 minuti).

## sessions — sessioni del backoffice
Realizzata (passo 3A): un documento per famiglia di sessione. `_id` (id esposto della sessione), `userId`, `accessTokenHash` (SHA-256 del token corrente, univoco), `accessExpiresAt`, `refreshTokenHash` (corrente, univoco), `previousRefreshHashes` (ultimi 50 hash ruotati, per rilevare il riuso), `rotatedAt`, `refreshExpiresAt` (inattività), `familyExpiresAt` (durata massima), `createdAt`, `lastUsedAt`, `userAgent`, `ip`, `revokedAt`, `revokeReason`, `expiresAt` (TTL = fine famiglia + 1 giorno). Indici: `accessTokenHash_1` e `refreshTokenHash_1` univoci, `previousRefreshHashes_1`, `userId_1_revokedAt_1`, TTL `expiresAt_1`. Validazione `$jsonSchema`.

## storeServerTokens — access token dei server di punto vendita
`_id`, `storeServerId`, `keyId`, `tokenHash` (univoco), `expiresAt` (TTL), `revokedAt`, `createdAt`.

## apiKeys — chiavi delle API pubbliche
`_id`, `groupId`, `name`, `keyHash` (univoco), `displayPrefix`, `permissions` (string[]), `companyIds`/`placeIds` (restrizione opzionale), `rateLimitPerMinute`, `monthlyQuota` (opzionale), `expiresAt`, `revokedAt`, `lastUsedAt`, `createdBy`, `createdAt`.

## rateLimits — contatori a finestra fissa
`_id` = `<bucket>:<SHA-256 hex della chiave>:<inizio finestra in secondi>` (username e IP mai in chiaro), `count`, `expiresAt` (fine finestra + 60 s). Indice TTL `expiresAt_1`. Realizzata (passo 2C).

## apiUsage — conteggio d'uso delle API pubbliche
`groupId`, `apiKeyId`, `day` (YYYY-MM-DD), `route`, `count`, `errorCount`. Indice univoco `apiKeyId + day + route`.

## activityLog — registro delle attività (sostituisce `auditLog`)
Realizzata (passo 2C, decisione dell'utente del 2026-11-01): un'unica collection per scritture sui dati, eventi di sicurezza ed errori. La collection `logs` del legacy resta intatta.
| Campo | Tipo | Note |
|---|---|---|
| `at` | Date | |
| `category` | `data` \| `security` \| `error` | |
| `action` | string | da catalogo, es. `user.updated`, `group.crossAccess`, `request.failed` |
| `outcome` | `success` \| `failure` \| `denied` | |
| `actor` | `{ kind: 'user' \| 'anonymous' \| 'system', id?, role? }` | `id` obbligatorio per `user` |
| `groupId` | ObjectId | facoltativo |
| `resource` | `{ type, id? }` | facoltativo |
| `changes` | `{ field, before?, after?, redacted?, truncated? }[]` | solo `data`; segreti oscurati |
| `requestId`, `ip` | string | |
| `metadata` | oggetto | chiavi ammesse per azione, massimo 20 valori scalari |
| `error` | `{ name, message, stack }` | solo per `client.error` (errori JavaScript del backoffice): messaggio fino a 300 caratteri, prime 10 righe dello stack di massimo 300 caratteri, redatti |
| `expiresAt` | Date | TTL: 365 giorni per `data` e `security`, 90 per `error` |
Validazione `$jsonSchema`. Indici: `at_-1__id_-1`, `groupId_1_at_-1__id_-1`, `actor.id_1_at_-1__id_-1`, `category_1_at_-1__id_-1` (ordinamento del monitor senza ordinamento in memoria), `requestId_1`, TTL `expiresAt_1`. Gli indici precedenti senza `_id` vengono rimossi all'avvio dopo la creazione dei nuovi.

## Domande aperte
1. `groups.dealerId`: nel legacy riferisce l'`_id` dell'utente `D` o un'anagrafica dealer separata? Un dealer può avere più utenti?
2. Migrazione di `companies` e `places` dai database dei gruppi al common: tempi e strategia (passo dedicato).
3. Univocità di `vatNumber` e `username`: globale o per gruppo.
