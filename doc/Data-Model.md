# Modello Dati — Database Common

> Collection di identità, tenancy e sicurezza nel database `<DB_NAME_PREFIX><APP_ENV>_common` (`doc/Architecture.md` §3).
> I campi sono il punto di partenza: si confermano nel passo che implementa ogni collection. I domini operativi (catalogo, vendite…) si documentano quando vengono affrontati.

Convenzioni: nomi in camelCase inglese; date `Date` in UTC; riferimenti `ObjectId`; `createdAt`/`updatedAt` su ogni documento; cancellazione logica con `deletedAt` dove serve conservare lo storico. Campi segreti (hash) mai restituiti dalle API.

## groups — tenant (collection legacy condivisa, D-03)
Realizzata (passi 4B e 4B-bis) come **lettura e scrittura compatibile con il legacy**: il documento resta nel formato legacy e la traduzione nel modello di dominio avviene nel repository (`backend/src/modules/groups/`). In produzione 1271 gruppi (2026-11-06). Il modello è completo: tutti i campi della scheda del gruppo sono visibili e modificabili (D-26, D-29).
| Campo legacy | Dominio | Note |
|---|---|---|
| `_id` | `id` | ObjectId; anche suffisso del nome del database del gruppo |
| `name`, `description` | `name`, `description` | |
| `dealerId` | `dealerId` | `_id` dell'utente D (D-09) |
| `status` (booleano) | `status` (`active`/`suspended`) | `active` solo se `true`; sospeso ⇒ tutte le credenziali del gruppo rifiutate |
| `trash` | `trashed` | solo `true` vale cestino |
| `demo` | `demo` | |
| `settings.<feature>` | `features.<feature>` | 15 flag booleani (`cash`, `rooms`, `ordering`, `warehouse`, `tobaccosGamesMonopoly`, `productsVariants`, `services`, `appointments`, `customersApp`, `media`, `email`, `scales`, `delivery`, `autoDepartments`, `advancedProducts`); assente o non booleano ⇒ `false` |
| `settings.languages` (`"it;en"`) | `languages` | codici ISO 639-1 |
| `settings.stats.{openingTime, compressProductsCategories, timeSlots[{start,end}]}` | `statsSettings` | `start`/`end` interi, ore intere, `end` è l'ora che chiude (`{9,12}` ⇄ `09:00`–`13:00`) |
| `settings.integrations.<provider>.status` | `integrations.<provider>.enabled` | provider: `easyappear` (legge anche `easyAppear` se manca, mai riscritto), `yellgo`, `leggimenu`, `plateform`, `cooperto`, `qodeup`, `statmanager` |
| `settings.integrations.<provider>.apiKey` | `integrations.<provider>.apiKeySet` | **solo impostabile**, mai letta in memoria né restituita né registrata (calcolata dal database) |
| `priceLists.<id>` `{id, name, status, default}` | `priceLists[]` `{id, name, enabled, isDefault}` | mappa per id; esattamente uno `default` |
| `taxes[]` `{id, value, department, description, natura}` | `taxes[]` `{id, rate, department, description, vatNature}` | array; `{}` letto come lista vuota |
| `currencies.<code>` `{code, symbol}` | `currencies[]` `{code, symbol}` | simbolo legacy come entità HTML (`&euro;`), nel dominio il carattere |
| `measureUnits.<id>` `{id, value}` | `measureUnits[]` | mappa per id |
| `warehouseRules.<id>` `{id, type L/D, name, quantity, value, useLoadUnit, counterpart, default, cashL, cashD, …}` | `warehouseRules[]` `{type load/unload, …, isDefault, cashLoad, cashUnload}` | mappa per id; chiavi non gestite (`priceType`…) conservate |
| `fidelityCardRules.<code>` `{code, value, discountPercentage}` | `fidelityCardRules[]` `{currency, pointValue, discountPercentage}` | una per valuta |
| `fidelity.cardsTypes[]` `{id, status, name, discountPercentage, priceListId, prepaid{status,type,taxPercentage}, pointsCollect{status,collectionIds}, placesAvailability[ObjectId]}` | `cardTypes` | array; `placesAvailability` ⇄ `placeIds` |
| `fidelity.pointsCollections[]` `{id, status, name, pointConversion, minAmount, dateFrom, dateTo, pointsExpirationDate (Date), prizesCatalogId}` | `pointsCollections` | `prizesCatalogId` ⇄ `prizeCatalogueId` |
| `fidelity.prizeCatalogues[]` `{id, status, name, prizes[{id, status, name, description, pointsValue, extraPrice, redemptionConditions, medias.images.main}]}` | `prizeCatalogues` | `medias` conservato, esposto come `imageSet`, non scrivibile |
| `productsFavorites[]` `{id, name, favorites[{_id ObjectId, position}]}` | `productFavorites` `{id, name, products[{productId, position}]}` | chiavi non gestite (`count`) conservate |
| `promotions[]` `{id, status, name, description, code, conditions{placesIds, startDate, endDate (stringhe ISO), customersIds, contactsGroupsIds, useForUsers, totalAvailableNumber, minAmount, currency, amountTax, seatExcluded, serviceExcluded, tipExcluded, deliveryExcluded, products{type,n,qt,ids}, categories{type,n,ids}}, actions{discountType, discountValue, discountValueType, productsIds, categoriesIds, freeShipping}}` | `promotions` | nomi di dominio in `doc/API.md`; id interni stringa (22 caratteri, CSPRNG) |
| `dataCluster` | `dataCluster` | id del cluster MongoDB con il database del gruppo (decisione del 2026-11-06); assente ⇒ cluster di default; letto dal nuovo backend, scritto dalla creazione dei gruppi (area 8); esposto solo al PSA |
| `insertDate`, `updateDate` | `createdAt`, `updatedAt` | `updateDate` è anche la versione per la concorrenza ottimistica delle scritture dei cataloghi |
- **Campi posseduti** (`GROUPS_OWNED_FIELDS` e `GROUPS_OWNED_CATALOGS` in `backend/src/db/collections.ts`, solo `$set`/`$unset`): `name`, `description`, `demo`, `status`, `trash`, `settings.<feature>`, `settings.languages`, `settings.stats.openingTime|compressProductsCategories|timeSlots`, `settings.integrations.<provider>.status|apiKey`, `updateDate` e ogni percorso sotto `priceLists`, `taxes`, `currencies`, `measureUnits`, `warehouseRules`, `fidelityCardRules`, `fidelity.cardsTypes`, `fidelity.pointsCollections`, `fidelity.prizeCatalogues`, `productsFavorites`, `promotions`. Mai la sostituzione di `settings` o del documento.
- **Non gestiti** (restano nel documento, mai letti né scritti): `apiKey` del gruppo, `databaseHost`, `filesHost`, `type`, `plan`, `expirationDate` (deprecati, D-13), `places[]` (derivato dal dominio dei punti vendita, non esposto), i provider di integrazione sconosciuti, ogni altra chiave non elencata (anche dentro gli elementi dei cataloghi). Un documento può superare i 16 MiB solo per scritture altrui: il nuovo backend rifiuta scritture che lo portano oltre 8 MiB.
- Indici: il nuovo backend non ne aggiunge (sulle collection legacy sono vietati indici univoci e TTL).

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
| `settings.language`, `settings.hiddenInStats` | `language`, `hiddenInStats` | in lettura, se manca `settings.hiddenInStats`, vale il residuo `permissions.hiddenInStats` |
| `description` | `description` | testo libero fino a 1000 caratteri; `null` lo svuota |
| `permissions.<modulo>.{r,w}`, `permissions.status` | `permissions.modules`, `canManagePermissions` | D-06; tutti i 13 moduli (`logs` solo `r`); PSA e D mostrano i valori effettivi, tutto vero (D-28); `permissions.apps.cash` ⇄ `pos` (sotto) |
| `password` | — | hash legacy HMAC-SHA512 (D-04); al cambio password scritto se la coesistenza è attiva, rimosso se è spenta |
| `tokens` | — | JWT legacy; svuotato a revoca, cambio password, disattivazione (D-11) |
| `pin` | `pinSet` | 3–6 cifre **in chiaro** (lo richiede il POS legacy, che lo confronta lato client); **mai restituito né registrato**, l'hash arriverà con il dominio cassa; non revoca sessioni |
| `avatar` | `avatar`, `hasAvatar` | data URL PNG/JPEG/WebP verificato dai magic bytes, ≤ 200 KB; solo nel dettaglio; un valore legacy non mostrabile ⇒ `avatar: null`, `hasAvatar: true` |
| `servicesId` | `serviceIds` | ObjectId di prodotti del gruppo con `type: 'service'`; ≤ 200 |
| `shiftTime` | `shiftTime` | turni, sotto |
| `permissions.apps.cash` | `pos` | dati della cassa, sotto |
| `insertDate`, `updateDate` | `createdAt`, `updatedAt` | |
- Scrittura solo con `$set`/`$unset` dei campi posseduti (elenco nel registro delle collection del backend: `USERS_OWNED_FIELDS`, ora con `description`, `avatar`, `pin`, `servicesId`, i flag di tutti i 13 moduli, `permissions.status`, i percorsi di `permissions.apps.cash.*` uno per uno e `shiftTime.status|weeksGeneric|daySpecial`; `USERS_OWNED_TREES` per le mappe a chiavi dinamiche `permissions.apps.cash.options.priceLists.<id>` e `shiftTime.daySpecial.<data>`), mai sostituzione del documento né di `permissions`, `settings`, `shiftTime`. Le chiavi residue non gestite (`sub.productsStatus`, `sub.deleteTableProductReason`, `options.service`, `permissions.hiddenInStats`) restano. I campi nullable si svuotano davvero con `null`.
- Indici aggiunti dal nuovo backend (non univoci): `groupId_1_role_1`, `dealerId_1`.
- **Moduli della matrice** (13, ordine del form legacy): `groups`, `users`, `companies`, `places`, `documents`, `products`, `calendar`, `warehouse`, `contacts`, `fidelity`, `settings`, `stats`, `logs` (solo `r`). Assente o non booleano ⇒ `false` con anomalia (in produzione `fidelity` manca in ~950 utenti, `stats.w` in 33). Moduli del nucleo (producono permessi): `groups`, `users`, `companies`, `places`, `fidelity`, `products`, `logs`. Default per ruolo (form legacy): tabella in `doc/Technical-Guide.md` §6.

### users.permissions.apps.cash ⇄ `pos`
Struttura `permissions.apps.cash = { status, sub, options }` ⇄ `pos = { enabled, grants, options }`. Presente in tutti gli 8750 utenti di produzione. Un utente nuovo ha tutte le chiavi (flag falsi o `null`).
- `status` ⇄ `pos.enabled`. **Default** per ruolo: PSA e D spenta e nessun flag; SA, CA, PA, E cassa abilitata con `discount`, `priceChange`, `invoices`, `freeSale`.
- **`sub` ⇄ `pos.grants`** (permessi): 44 flag booleani. Stesso nome nel dominio e nel legacy per 32 di essi: `discount`, `discountReason`, `onlyHigherPrice`, `invoices`, `freeSale`, `contacts`, `bypassAutomaticCash`, `deleteUserShiftDetail`, `receiptCancellation`, `manageService`, `tableCheckoutActiveDesk`, `deleteTable`, `deleteTableReason`, `deleteTableProduct`, `deleteTableProductReasonNotSent`, `deleteTableProductReasonSent`, `advancedReport`, `advancedReportPin`, `reworkSale`, `sentProducts`, `notSentProducts`, `lockProducts`, `tableEngage`, `tableMerge`, `tableClose`, `checkoutPartition`, `checkoutSeparation`, `moveProducts`, `unlockTable`, `resendProducts`, `searchProducts`, `rider`. I 12 con nome diverso:
  | Dominio | Chiave legacy |
  |---|---|
  | `fiscalClosure` | `posClosure` |
  | `priceChange` | `prices` |
  | `selectSaleUser` | `selectUserSale` |
  | `printPrebill` | `preblling` (refuso legacy conservato) |
  | `printReceipt` | `receipt` |
  | `tablePrebillActions` | `tablePrebillingActions` |
  | `roomsTableQuickTotals` | `roomsTableViewQuickTotals` |
  | `roomsRoomsPrices` | `roomsRoomsViewPrices` |
  | `roomsTablePrices` | `roomsTableViewPrices` |
  | `roomsOnlyHigherSeatsQuantity` | `roomsOnlyHigherSeatsQunatity` (refuso legacy conservato) |
  | `editSentWeightQuantity` | `editQuantitySentWeightProduct` |
  | `tableSplit` | `tableSepare` |
  In più: `discountMaxPercentage` ⇄ `sub.discountMaxPercentage` (0–100, `null` = nessun tetto), `servicePercentage` ⇄ `sub.service` (0–100 o `null`), `automaticCash.<dispositivo>.<flag>` ⇄ `sub.automaticCash.…` con `glory` (`withdrawal`, `deposit`, `archive`, `archiveAll`, `unlockNote`, `unlockCoin`, `collectVerify`), `cashMatic` (`withdrawal`, `deposit`, `change`, `refill`, `archive`, `archiveAll`), `vne` (`withdrawal`, `refill`, `archive`, `archiveAll`, `tools`), `azkoyen` (`withdrawal`, `deposit`, `backoffice`, `status`), `cashSystem` (`withdrawal`).
- **`options` ⇄ `pos.options`** (preferenze, non permessi), stesse chiavi: 31 booleani (`extendedCart`, `noSeparator`, `skipCheckoutButton`, `showLastSaleValue`, `quickPriceList`, `advancedDiscount`, `productsPagination`, `productsShortName`, `invertedCart`, `deskPrintOrderDefault`, `deliveryTakeawayCompletedDefault`, `deliveryTakeawayShowOrderDetailOnSave`, `deliveryTakeawayShowProduction`, `reducedProducts`, `reducedProductsTable`, `reducedTables`, `enlargedCategories`, `tableCartPriority`, `sendOrderRemainButton`, `viewTableStatus`, `viewTableUser`, `viewTableCustomer`, `viewTableStartDate`, `genericProductPriceFocus`, `roomsGridActive`, `roomsGridActionbarOpened`, `removeFiltersProductSelect`, `removeFiltersOnSearch`, `darkMode`, `departmentsDialog`, `skipFiscalReceiptTypeRequest`) più: `favoritesId` (id di `groups.productsFavorites[]` del gruppo o `null`), `side` e `sideRooms` (`dx`, `sx`), `virtualKeyboard` (`''`, `pb`, `p`, `mb`, `m`), `template` (4 temi `material-tealwhite|whitepurple-light|dark` o `null`), `productsFontSize` e `productsShortNameFontSize` (`s`, `m`, `l`; in lettura anche maiuscolo), `roomsTablesColumns` (4, 5, 6, 8, `null`; in lettura anche stringa numerica), `roomsTablesColumnsHandheld` (2, 3, 4, `null`), `roomsGridZoomHandheld` (1, 1.5, 2, 2.5, 3), `quickDiscount` (0–100 o `null`), `defaultPriceListId` (listino con cui il POS è partito, lo scrive il POS), `priceLists` ⇄ mappa legacy `{ <priceListId>: { status, selected } }` (`[{ priceListId, enabled, isDefault }]`). Default del form: `side`/`sideRooms` `dx`, `virtualKeyboard` `''`, `template` `material-whitepurple-light`, font `s`, zoom 2, `priceLists` = tutti i listini del gruppo con `status: true` e `selected` il predefinito.
- Chiavi legacy non gestite, conservate: `sub.productsStatus`, `sub.deleteTableProductReason`, `options.service`, `permissions.hiddenInStats`.

### users.shiftTime ⇄ `shiftTime`
| Legacy | Dominio | Note |
|---|---|---|
| `shiftTime.status` (in lettura anche `ststus`, 64 documenti) | `enabled` | |
| `shiftTime.weeksGeneric[]` `{start, end, days{"0".."6"{active, values[{start,end}]}}}` (in lettura anche `weekGeneric`, 20 documenti, un blocco senza date) | `weeks[]` `{from, to, days{"0".."6"{active, slots[{start,end}]}}}` | `start`/`end` del blocco sono date (`Date`); senza date = blocco predefinito (uno solo) |
| `shiftTime.daySpecial.<YYYY-MM-DD>` `{free, values[]}` | `specialDays[]` `{date, dayOff, slots}` | mappa per data |
Orari `HH:mm`. Limiti: 20 blocchi, 10 fasce per giorno, 366 giorni speciali. `0` è la domenica.

## dealers — anagrafica dei dealer
Realizzata (passo 4A, D-09, decisione dell'utente del 2026-11-06): una ragione sociale per ogni dealer. **`_id` = `_id` dell'utente D collegato**, così `groups.dealerId` (id dell'utente D) resta valido.
| Campo | Tipo | Note |
|---|---|---|
| `businessName` | string | ragione sociale, 1–200 |
| `vatNumber` | string \| null | P.IVA: IT 11 cifre, altri paesi 2–30 alfanumerici; univoca quando presente |
| `fiscalCode` | string \| null | IT: 16 alfanumerici o 11 cifre |
| `address` | `{ street, postcode, city, province, countryCode }` \| null | IT: provincia di 2 lettere; `countryCode` ISO 3166-1 alpha-2 |
| `pec`, `email` | string \| null | |
| `sdiCode` | string \| null | codice destinatario, 7 caratteri |
| `phone` | string \| null | |
| `source` | `manual` \| `migration` \| `user` | creato da "Nuovo dealer", dalla migrazione o dalla creazione di un utente D |
| `createdAt`, `updatedAt`, `createdBy` | | |
Validazione `$jsonSchema`; indice univoco parziale `vatNumber_1` (solo quando è stringa). Creazione del dealer e del suo utente D nella stessa transazione; l'eliminazione definitiva dell'utente D elimina anche l'anagrafica. I dealer esistenti sono stati registrati con lo script `migrate:dealers` (ragione sociale = username) il 2026-11-06: 1 in `development`, 5 in `production`.

## userCredentials — credenziali del nuovo backend
Realizzata (passo 3A, D-03): `_id` = id dell'utente, `passwordHash` (scrypt `scrypt$N$r$p$salt$hash`, facoltativo), `legacyHashFingerprint` (SHA-256 dell'hash legacy da cui deriva, o null), `passwordChangedAt`, `failedLogins`, `lockedUntil` (blocco progressivo dal 5° fallimento: 1, 2, 4, 8, poi 15 minuti; azzerati dal reset dell'amministratore), `mustChangePassword` (password provvisoria impostata da un amministratore: va cambiata al primo accesso; passo 3B), `lastLoginAt`, `createdAt`, `updatedAt`. Validazione `$jsonSchema`; nessun indice oltre `_id`.

## companies — copie delle aziende (collection `mirror`, D-20)
Realizzata (passo 5A): copia intera del documento `companies` del database del gruppo, stesso `_id`, `groupId` (ObjectId) sempre dal nome del database. Scritta solo con `replaceOne` filtrato da `{_id, groupId}`: dal comando `sync:copies` (solo development) e, in futuro, dal legacy nel punto in cui scrive (specifica in `doc/Technical-Guide.md` §7). Nessun `$jsonSchema`. Indici: `groupId_1__id_1`, `groupId_1_name_1`. Il modello di dominio (`doc/Tasks.md` 6.1) arriva con l'area 6.

## places — copie dei punti vendita (collection `mirror`, D-20)
Realizzata (passo 5A): come `companies`, copia intera del documento `places` del gruppo, comprese le parti incorporate (dispositivi, sale, magazzini, integrazioni con le loro credenziali: rischio accettato in Tasks §0.3, il backend non le legge mai). Indici: `groupId_1__id_1`, `groupId_1_name_1`, `groupId_1_companyId_1`. Il modello di dominio (Tasks 7.1) arriva con l'area 7.

## syncIssues — discordanze tra database dei gruppi e copie
Realizzata (passo 5A), senza validatore: `_id`, `runId` (esecuzione di `sync:copies`), `detectedAt`, `kind` (`missingCopy`, `differentCopy`, `extraCopy`, `idCollision`, `invalidCopy`, `groupIdMismatch`, `orphanCompany`, `databaseWithoutGroup`, `unknownCluster`, `nonObjectId`), `collection` (`companies`, `places` o null), `groupId`, `documentId`, `repaired`. Solo id, nessun valore dei documenti né dato personale. Indici: `runId_1`, `kind_1_detectedAt_-1`, TTL `detectedAt_ttl` a 180 giorni.

## platformSettings — impostazioni di piattaforma
Documento unico (`_id: 'platform'`), modificabile solo da `PSA`; ogni modifica va nell'audit log.
| Campo | Tipo | Note |
|---|---|---|
| `updatedBy`, `updatedAt` | | |

## sessions — sessioni del backoffice
Realizzata (passo 3A): un documento per famiglia di sessione. `_id` (id esposto della sessione), `userId`, `accessTokenHash` (SHA-256 del token corrente, univoco), `accessExpiresAt`, `refreshTokenHash` (corrente, univoco), `previousRefreshHashes` (ultimi 50 hash ruotati, per rilevare il riuso), `rotatedAt`, `refreshExpiresAt` (inattività), `familyExpiresAt` (durata massima), `createdAt`, `lastUsedAt`, `userAgent`, `ip`, `revokedAt`, `revokeReason`, `expiresAt` (TTL = fine famiglia + 1 giorno). Indici: `accessTokenHash_1` e `refreshTokenHash_1` univoci, `previousRefreshHashes_1`, `userId_1_revokedAt_1`, TTL `expiresAt_1`. Validazione `$jsonSchema`.

## apiKeys — chiavi delle API pubbliche
`_id`, `groupId`, `name`, `keyHash` (univoco), `displayPrefix`, `permissions` (string[]), `companyIds`/`placeIds` (restrizione opzionale), `rateLimitPerMinute`, `monthlyQuota` (opzionale), `expiresAt`, `revokedAt`, `lastUsedAt`, `createdBy`, `createdAt`.

## rateLimits — contatori a finestra fissa
`_id` = `<bucket>:<SHA-256 hex della chiave>:<inizio finestra in secondi>` (username e IP mai in chiaro), `count`, `expiresAt` (fine finestra + 60 s). Indice TTL `expiresAt_1`. Realizzata (passo 2C).

## apiUsage — conteggio d'uso delle API pubbliche
`groupId`, `apiKeyId`, `day` (YYYY-MM-DD), `route`, `count`, `errorCount`. Indice univoco `apiKeyId + day + route`.

## activityEvents — registro delle attività (sostituisce `auditLog`)
Realizzata (passo 2C, decisione dell'utente del 2026-11-01; rinominata `activityEvents`, senza validatore `$jsonSchema`, la vecchia `activityLog` è abbandonata): un'unica collection per scritture sui dati, eventi di sicurezza ed errori. La collection `logs` del legacy resta intatta.
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

## Collection dei database di gruppo lette dal nuovo backend
Sola lettura (`legacy-read`), solo con un accesso verificato al gruppo e sul cluster del gruppo:
| Collection | Perché | Campi usati |
|---|---|---|
| `companies`, `places` | scope di CA e PA, selettori, verifica di `placeIds` dei cataloghi e delle promozioni | `_id`, `name`, `trash`, `companyId` |
| `products` | esistenza degli id di preferiti e promozioni; servizi del gruppo e verifica di `serviceIds`; letture compatte `lookup/products` | `_id`, `trash`, `type` (`product`, `service`, `exempt`, `tobaccos`, `games`, `monopoly`), `name` (oggetto per lingua) |
| `products_categories` | esistenza delle categorie nelle promozioni; lettura compatta `lookup/product-categories` | `_id`, `trash`, `name` (oggetto per lingua) |
| `contacts` | esistenza dei clienti nelle promozioni; lettura compatta `lookup/customers` | `_id`, `trash`, `customer`, `companyName`, `name`, `surname` (mai email, telefoni, indirizzi) |
| `contacts_groups` | esistenza dei gruppi di contatti nelle promozioni; lettura compatta `lookup/contact-groups` | `_id`, `name` (stringa; nessun flag di cestino) |

## Domande aperte
1. `groups.dealerId`: nel legacy riferisce l'`_id` dell'utente `D` o un'anagrafica dealer separata? Un dealer può avere più utenti?
2. Migrazione di `companies` e `places` dai database dei gruppi al common: tempi e strategia (passo dedicato).
3. Univocità di `vatNumber` e `username`: globale o per gruppo.
