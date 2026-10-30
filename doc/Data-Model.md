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
| `createdAt`, `updatedAt`, `deletedAt` | Date | |
Indici: `dealerId`, `status`.

## users — utenti
| Campo | Tipo | Note |
|---|---|---|
| `_id` | ObjectId | |
| `username` | string | univoco, normalizzato |
| `email` | string | |
| `passwordHash` | string | `scrypt$N$r$p$salt$hash`; assente per utenti `E` se non accedono mai con password |
| `role` | `PSA` \| `D` \| `SA` \| `CA` \| `PA` \| `E` | |
| `groupId` | ObjectId \| null | null solo per `PSA` e `D` |
| `dealerId` | ObjectId \| null | per gli utenti `D`: identificativo del dealer |
| `companyIds` | ObjectId[] | per `CA` |
| `placeIds` | ObjectId[] | per `PA` ed `E` |
| `status` | `active` \| `disabled` | |
| `passwordChangedAt`, `lastLoginAt` | Date | |
| `failedLogins`, `lockedUntil` | number, Date | blocco progressivo |
| `createdBy`, `createdAt`, `updatedAt`, `deletedAt` | | |
Indici: `username` univoco; `groupId + role`; `dealerId`.
Vincoli: `PSA`/`D` senza `groupId`; tutti gli altri con `groupId`; `CA` con almeno una azienda; `PA`/`E` con almeno un punto vendita.

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
`_id`, `userId`, `groupId`, `familyId`, `accessTokenHash` (univoco), `accessExpiresAt`, `refreshTokenHash` (univoco), `refreshExpiresAt` (TTL), `refreshUsedAt`, `familyExpiresAt`, `revokedAt`, `revokedReason`, `ip`, `userAgent`, `createdAt`, `lastUsedAt`.

## storeServerTokens — access token dei server di punto vendita
`_id`, `storeServerId`, `keyId`, `tokenHash` (univoco), `expiresAt` (TTL), `revokedAt`, `createdAt`.

## apiKeys — chiavi delle API pubbliche
`_id`, `groupId`, `name`, `keyHash` (univoco), `displayPrefix`, `permissions` (string[]), `companyIds`/`placeIds` (restrizione opzionale), `rateLimitPerMinute`, `monthlyQuota` (opzionale), `expiresAt`, `revokedAt`, `lastUsedAt`, `createdBy`, `createdAt`.

## rateLimits — contatori a finestra fissa
`_id` = `<superficie>:<soggetto>:<inizioFinestra>`, `count`, `expiresAt` (TTL).

## apiUsage — conteggio d'uso delle API pubbliche
`groupId`, `apiKeyId`, `day` (YYYY-MM-DD), `route`, `count`, `errorCount`. Indice univoco `apiKeyId + day + route`.

## auditLog — eventi di sicurezza
`at`, `actor` (`{ kind, id }`), `groupId`, `action`, `target`, `ip`, `outcome`, `metadata` (senza segreti). Indici: `groupId + at`, `actor.id + at`; durata di conservazione da decidere (`doc/Security-Model.md` §12).

## Domande aperte
1. `groups.dealerId`: nel legacy riferisce l'`_id` dell'utente `D` o un'anagrafica dealer separata? Un dealer può avere più utenti?
2. Migrazione di `companies` e `places` dai database dei gruppi al common: tempi e strategia (passo dedicato).
3. Univocità di `vatNumber` e `username`: globale o per gruppo.
