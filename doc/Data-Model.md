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
| `trashDate` | `trashedAt` | data del cestino (BSON `Date`), scritta con `trash: true` e tolta al ripristino; assente nei documenti cestinati dal legacy; solo informativa (passo P2) |
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
| `publicApi` `{ enabled, defaultRateLimitPerMinute, defaultDailyQuota }` | `publicApi` | campo **di primo livello** (passo 9A), non dentro `settings`: il legacy aggiorna `settings` per intero e lo cancellerebbe, mentre scrive solo chiavi di primo livello che nomina. Impostabile **solo dal PSA**, visibile a PSA e D. `enabled` solo se esattamente `true` (assente ⇒ API pubbliche spente: nessuna chiave del gruppo funziona); `defaultRateLimitPerMinute` e `defaultDailyQuota` (interi, 1–6000 al minuto e 1–10 000 000 al giorno) sono quelli che le nuove chiavi ereditano; `groupRateLimitPerMinute` e `groupDailyQuota` (stessi estremi) sono il **tetto di tutte le chiavi del gruppo insieme**; se assenti o non validi valgono i default della piattaforma (`PUBLIC_API_DEFAULT_RATE_LIMIT_PER_MINUTE` 60, `PUBLIC_API_DEFAULT_DAILY_QUOTA` 10 000, `PUBLIC_API_DEFAULT_GROUP_RATE_LIMIT_PER_MINUTE` 120, `PUBLIC_API_DEFAULT_GROUP_DAILY_QUOTA` 20 000) |
| `dataCluster` | `dataCluster` | id del cluster MongoDB con il database del gruppo (decisione del 2026-11-06); assente ⇒ cluster di default; letto dal nuovo backend, scritto dalla creazione dei gruppi (area 8); esposto solo al PSA |
| `insertDate`, `updateDate` | `createdAt`, `updatedAt` | `updateDate` è anche la versione per la concorrenza ottimistica delle scritture dei cataloghi |
- **Campi posseduti** (`GROUPS_OWNED_FIELDS` e `GROUPS_OWNED_CATALOGS` in `backend/src/db/collections.ts`, solo `$set`/`$unset`): `name`, `description`, `demo`, `status`, `trash`, `trashDate`, `settings.<feature>`, `settings.languages`, `settings.stats.openingTime|compressProductsCategories|timeSlots`, `settings.integrations.<provider>.status|apiKey`, `publicApi.enabled|defaultRateLimitPerMinute|defaultDailyQuota|groupRateLimitPerMinute|groupDailyQuota` (`GROUPS_PUBLIC_API_FIELDS`, passo 9A), `updateDate` e ogni percorso sotto `priceLists`, `taxes`, `currencies`, `measureUnits`, `warehouseRules`, `fidelityCardRules`, `fidelity.cardsTypes`, `fidelity.pointsCollections`, `fidelity.prizeCatalogues`, `productsFavorites`, `promotions`. Mai la sostituzione di `settings` o del documento.
- **Creazione** (passo 8A, `POST /v1/groups`, `newGroupDocument`): il documento intero di un nuovo gruppo si **inserisce** in una transazione (le chiavi sono tutte quelle del legacy `groups/generate`: `name`, `description: ''`, `databaseHost: ''`, `filesHost` da `GROUP_FILES_HOST`, `type: null`, `settings` con le 15 feature (`cash` e `productsVariants` accese, le altre come scelte nel form) più `languages: null`, `stats.openingTime: null` e `integrations` con i 7 provider `{ status: false, apiKey: null }`, `status: true`, `demo`, `dealerId` (ObjectId o `null`), `apiKey`, un listino predefinito (`Listino 1`), `taxes[]`, `currencies.EUR` (`&euro;`), `measureUnits` con `pz`, tre `warehouseRules` standard (`Carico standard`, `Scarico standard`, `Reso standard`, tutte `default: true`), `fidelityCardRules.EUR`, `fidelity` vuoto, `expirationDate: null`, `places[]` ricalcolato, `trash: false`, `insertDate`, `updateDate`; mai `dataCluster`, `plan`). **`apiKey`**: 64 caratteri esadecimali da 256 bit casuali, scritta una sola volta, mai letta, restituita, registrata né accettata come credenziale; la usano solo il POS e le app legacy. È tra i campi "solo inserimento" (`GROUPS_INSERT_ONLY_FIELDS` in `db/collections.ts`: `apiKey`, `databaseHost`, `filesHost`, `type`, `expirationDate`, `insertDate`, `places`), che nessun `$set` può scrivere.
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
| `trashDate` | `trashedAt` | data del cestino, scritta e tolta con `trash` (passo P2); assente se cestinato dal legacy |
| `settings.language`, `settings.theme`, `settings.hiddenInStats` | `language`, `theme`, `hiddenInStats` | `theme` è `light`, `dark` o `system`: se manca o non è valido, in lettura vale `system` (il legacy ignora la chiave). In lettura, se manca `settings.hiddenInStats`, vale il residuo `permissions.hiddenInStats` |
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
- **Moduli della matrice** (13, ordine del form legacy): `groups`, `users`, `companies`, `places`, `documents`, `products`, `calendar`, `warehouse`, `contacts`, `fidelity`, `settings`, `stats`, `logs` (solo `r`). Assente o non booleano ⇒ `false` con anomalia (in produzione `fidelity` manca in ~950 utenti, `stats.w` in 33). Moduli del nucleo (producono permessi): `groups`, `users`, `companies`, `places`, `fidelity`, `products`, `contacts` (dal passo K1: `contacts:read` e `contacts:write`, nel tetto di PSA, D, SA, CA e PA), `documents` (dal passo V1: `documents.r` dà `sales:read`, nel tetto di PSA, D, SA, CA e PA; il flag `w` non dà nessun permesso e un attore lo concede ad altri solo se lo ha lui stesso), `logs`. Default per ruolo (form legacy): tabella in `doc/Technical-Guide.md` §6.

### users.permissions.apps.cash ⇄ `pos`
Struttura `permissions.apps.cash = { status, sub, options }` ⇄ `pos = { enabled, grants, options }`. Presente in tutti gli 8750 utenti di produzione. Un utente nuovo ha tutte le chiavi (flag falsi o `null`).
- `status` ⇄ `pos.enabled`. **Default** per ruolo: PSA e D spenta e nessun flag; SA, CA, PA, E cassa abilitata con `discount`, `priceChange`, `invoices`, `freeSale`.
- **`sub` ⇄ `pos.grants`** (permessi): 47 flag booleani. Stesso nome nel dominio e nel legacy per 35 di essi: `discount`, `discountReason`, `onlyHigherPrice`, `invoices`, `freeSale`, `contacts`, `bypassAutomaticCash`, `deleteUserShiftDetail`, `receiptCancellation`, `manageService`, `tableCheckoutActiveDesk`, `deleteTable`, `deleteTableReason`, `deleteTableProduct`, `deleteTableProductReasonNotSent`, `deleteTableProductReasonSent`, `advancedReport`, `advancedReportPin`, `reworkSale`, `sentProducts`, `notSentProducts`, `lockProducts`, `tableEngage`, `tableMerge`, `tableClose`, `checkoutPartition`, `checkoutSeparation`, `moveProducts`, `unlockTable`, `resendProducts`, `searchProducts`, `rider`, `cashEnabled`, `handheldEnabled`, `handheldWallet`. I 12 con nome diverso:
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
- **`options` ⇄ `pos.options`** (preferenze, non permessi), stesse chiavi: 34 booleani (`extendedCart`, `noSeparator`, `skipCheckoutButton`, `showLastSaleValue`, `quickPriceList`, `advancedDiscount`, `productsPagination`, `productsShortName`, `invertedCart`, `deskPrintOrderDefault`, `deliveryTakeawayCompletedDefault`, `deliveryTakeawayShowOrderDetailOnSave`, `deliveryTakeawayShowProduction`, `reducedProducts`, `reducedProductsTable`, `reducedTables`, `enlargedCategories`, `tableCartPriority`, `sendOrderRemainButton`, `viewTableStatus`, `viewTableUser`, `viewTableCustomer`, `viewTableStartDate`, `genericProductPriceFocus`, `roomsGridActive`, `roomsGridActionbarOpened`, `removeFiltersProductSelect`, `removeFiltersOnSearch`, `darkMode`, `departmentsDialog`, `skipFiscalReceiptTypeRequest`, `productsUppercase`, `productsBold`, `roomsLegend`) più: `favoritesId` (id di `groups.productsFavorites[]` del gruppo o `null`), `side` e `sideRooms` (`dx`, `sx`), `virtualKeyboard` (`''`, `pb`, `p`, `mb`, `m`), `template` (4 temi `material-tealwhite|whitepurple-light|dark` o `null`), `productsFontSize` e `productsShortNameFontSize` (`s`, `m`, `l`; in lettura anche maiuscolo), `roomsTablesColumns` (4, 5, 6, 8, `null`; in lettura anche stringa numerica), `roomsTablesColumnsHandheld` (2, 3, 4, `null`), `roomsGridZoomHandheld` (1, 1.5, 2, 2.5, 3), `productsColorStyle` (`line`, `fill`), `handheldTextZoom` (85–125 a passi di 5), `handheldCategoriesLayout` (`scroll`, `slidein`, `list`), `handheldCategoriesRows` (1, 2), `handheldProductsColumns` (1–4), `handheldMenuPosition` (`bottom`, `top`), `quickDiscount` (0–100 o `null`), `defaultPriceListId` (listino con cui il POS è partito, lo scrive il POS), `priceLists` ⇄ mappa legacy `{ <priceListId>: { status, selected } }` (`[{ priceListId, enabled, isDefault }]`). Default del form: `side`/`sideRooms` `dx`, `virtualKeyboard` `''`, `template` `material-whitepurple-light`, font `s`, zoom 2, `productsColorStyle` `line`, `handheldTextZoom` 100, `handheldCategoriesLayout` `scroll`, `handheldCategoriesRows` 2, `handheldProductsColumns` 2, `handheldMenuPosition` `bottom`, `priceLists` = tutti i listini del gruppo con `status: true` e `selected` il predefinito.
- **Default di lettura dei grant:** `cashEnabled` e `handheldEnabled` valgono **`true` quando la chiave manca** (o è `null`/non booleana, con segnalazione), come il `!== false` del form legacy; `handheldWallet` e ogni altro grant `false`. Un utente nuovo (anche `PSA` e `D`) ha `cashEnabled` e `handheldEnabled` a `true` e `handheldWallet` a `false`. I valori delle nuove preferenze sono numeri interi e testi, come li scrive il legacy; un valore fuori elenco si legge come il default.
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
Nessun validatore del database (D-32); indice univoco parziale `vatNumber_1` (solo quando è stringa). Campo **opzionale** `priceOverrides` (passo 9-ter/4): `{ plans?: { <chiavePiano>: centesimi }, services?: { <servizio>: centesimi } }`, parziale, stessi limiti del listino (al più 30 piani); assente = nessuna personalizzazione; scritto solo dal PSA (`PUT /v1/dealers/{dealerId}/price-overrides`) con un `$set` guardato dal valore letto, un insieme vuoto lo toglie (`$unset`); non compare nelle risposte dell'anagrafica. Creazione del dealer e del suo utente D nella stessa transazione; l'eliminazione definitiva dell'utente D elimina anche l'anagrafica. I dealer esistenti sono stati registrati con lo script `migrate:dealers` (ragione sociale = username) il 2026-11-06: 1 in `development`, 5 in `production`.

## userCredentials — credenziali del nuovo backend
Realizzata (passo 3A, D-03): `_id` = id dell'utente, `passwordHash` (scrypt `scrypt$N$r$p$salt$hash`, facoltativo), `legacyHashFingerprint` (SHA-256 dell'hash legacy da cui deriva, o null), `passwordChangedAt`, `failedLogins`, `lockedUntil` (blocco progressivo dal 5° fallimento: 1, 2, 4, 8, poi 15 minuti; azzerati dal reset dell'amministratore), `mustChangePassword` (password provvisoria impostata da un amministratore: va cambiata al primo accesso; passo 3B), `lastLoginAt`, `createdAt`, `updatedAt`. Nessun indice oltre `_id`.

## companies — aziende (originale nel database del gruppo, copia nel common, D-20)
Realizzata come **lettura e scrittura compatibile con il legacy** (passi 5A, 5.6 e 6A): il documento resta nel formato legacy nel database `<env>_<groupId>` e se ne tiene una copia intera nel common (stesso `_id`, `groupId` ObjectId sempre dal nome del database), scritta solo con `replaceOne` filtrato da `{_id, groupId}` dal servizio di scrittura (`backend/src/shared/legacy-write/`), dal comando `sync:copies` (solo development) e dal legacy nel punto in cui scrive (`COMMON_COPY_ENABLED`). Nessun `$jsonSchema`. La lista legge le copie (solo tramite `group-mirror.ts`, campi in allowlist: `_id`, `name`, `trash`, `code`, `city`, `countryAreaCode`, `countryCode`, `status`); il dettaglio e le scritture usano l'originale del database del gruppo. Modello di dominio e route in `doc/API.md` ("Aziende") e `doc/Technical-Guide.md` (§6 "companies").

**Indici** (copie nel common, tutti non univoci, perché una copia non va mai rifiutata e la partita IVA non è unica nei dati: 6 doppioni noti in produzione, `doc/Tasks.md` 6.1): `groupId_1__id_1`, `groupId_1_name_1`, `groupId_1_status_1`, `groupId_1_code_1`. L'univocità della partita IVA (`code`) tra le aziende non cestinate di un gruppo è controllata dal servizio di scrittura nella transazione (forma normalizzata: spazi tolti, maiuscolo, prefisso `IT` davanti a undici cifre). Nei database dei gruppi non si aggiungono indici (collection legacy).

**Campi posseduti** (`COMPANIES_OWNED_FIELDS`, solo `$set` sul percorso foglia o sull'intero array; mai la sostituzione di `settings`, `fattura_elettronica` o `medias`):
| Legacy | Tipo BSON | Dominio |
|---|---|---|
| `name`, `code`, `code2`, `address`, `postcode`, `city`, `countryAreaCode`, `countryCode`, `currencyCode` | string (`code2` anche `''`) | `name`, `vatNumber`, `fiscalCode`, `address.street/postcode/city/province/country`, `currency` |
| `email`, `telephone` | string o `null` | `email`, `phone` |
| `status`, `trash` | boolean | `status` (`active`/`disabled`), `trashed` (`trash` solo da cestino e ripristino) |
| `trashDate` | Date (assente se cestinata dal legacy) | `trashedAt`; scritta con `trash: true` e tolta al ripristino, anche nella copia (passo P2) |
| `expirationDate` | Date o `null` | `expirationDate` (mai l'epoca del legacy) |
| `fattura_elettronica.{hub, IdTrasmittente_paese, IdTrasmittente_codice, codice_eori, email, codice_destinatario, albo_professionale, ap_numero_iscrizione, ap_provincia, ap_data_iscrizione, rea_ufficio, rea_numero, rea_capitale_sociale, rea_soci, rea_liquidazione, regime_fiscale}` | string (16 chiavi, `''` se vuote) | `eInvoicing.*` |
| `invoicesPS`, `invoicesPSValues` | `'prefix'`/`'suffix'`/`null`; array `{name, cash}` | `invoiceNumbering.position`, `.values` |
| `settings.global.lastInvoiceNumber`, `settings.global.discountLines`, `settings.api.cerved` | Int32 o `null`; boolean; boolean | `invoiceNumbering.lastInvoiceNumber`, `.discountLines`, `.cervedLookup` |
| `banks` | array `{id, name, iban, abi, cab, bic, default}` (stringhe, `id` stringa generata dal server di 24 caratteri esadecimali) | `bankAccounts` |
| `ticketsSuppliers` | array `{id, name, cuts[Int32/Double/null]}` | `mealVoucherIssuers` |
| `settings.global.{enableLoginSignup, showPrivacyPage, showTermsPage}` e `settings.ecommerce.*` (27 chiavi: 24 boolean, `listId` string, `minAmount` `{<valuta>: {code, value}}`, `showProductRemainingQuantity` numero) | boolean, string, oggetto, Int32/Double | `customerApp.*` (`listId` → `priceListId`, `minAmount` → `minimumOrder`) |
| `medias.images.{internalFileName, externalUrl, customersAppLogoLight, customersAppLogoDark}` | string, string, descrittore del file o `null` | `media.*` (i logo si rimuovono o si impostano da un'immagine del gruppo, passo 6B: descrittore di undici chiavi, vedi `files`) |
- I numeri sono scritti come il driver serializza un numero JS: intero nel range Int32 → Int32, altro → Double, come il legacy.
- **Non posseduti** (restano nel documento, mai scritti né restituiti): `groupId` (derivato dal database), `insertDate`, ogni chiave sconosciuta al primo livello, in `settings`, `settings.global|api|ecommerce`, `fattura_elettronica` e `medias`/`medias.images`, i sotto-oggetti dei descrittori dei logo (`mmThumb`…). Alla creazione il documento è completo (`fattura_elettronica` 16 chiavi con `regime_fiscale` `RF01`, `settings` con le 27 chiavi `ecommerce`, array vuoti, `invoicesPS` `null`, `medias.images` con le quattro chiavi); un blocco mancante o vuoto in un'azienda esistente è completato con i default delle chiavi non impostate dalla scrittura.
- **Versione** (`ETag`/`If-Match`): SHA-256 di `_id` e di tutti i percorsi posseduti (tranne `updateDate`), con i tipi BSON esatti.
- Dati sensibili: `banks[].iban/abi/cab/bic` sono restituiti a chi legge l'azienda e non compaiono mai nei log né nel registro delle attività; sono comunque copiati nella copia del common e negli snapshot di vendite e documenti del legacy.

## places — punti vendita (originale nel database del gruppo, copia nel common, D-20)
Copia intera del documento `places` del gruppo (collection `mirror`), comprese le parti incorporate (dispositivi, sale, magazzini, integrazioni con le loro credenziali: rischio accettato in Tasks §0.3, il backend non le legge mai: la lista legge solo i campi dell'allowlist). Indici (tutti non univoci): `groupId_1__id_1`, `groupId_1_name_1`, `groupId_1_companyId_1`, **`groupId_1_status_1`** (passo 7A).

**Modello di dominio** (passo 7A, `doc/Tasks.md` 7.1, riferimento in `doc/API.md` "Punti vendita"): Generale, Licenza e Orari; le impostazioni arrivano con il passo 7B.

| Campo di dominio | Campo legacy | Note |
|---|---|---|
| `id`, `groupId` | `_id`, (nome del database) | `groupId` dall'accesso verificato |
| `name`, `companyId` | `name`, `companyId` | `companyId` ObjectId di un'azienda del gruppo non nel cestino |
| `address.street/postcode/city/province/country` | `address`, `postcode`, `city`, `countryAreaCode`, `countryCode` | `null` dopo il cestino del legacy: letti senza errore |
| `contactName`, `email`, `phone` | `contact`, `email`, `telephone` | |
| `priceListId`, `ecommercePriceListId` | `listId`, `ecommerceListId` | id di un listino attivo del gruppo |
| `invoiceSeries` | `invoicePS` | `name` di una serie dell'azienda (`invoicesPSValues`), `null`, `false` storico |
| `priceLists` | `general.priceLists` | `[{ id, allYouCanEat, ayceCode1, ayceCode2 }]`, array intero |
| `trashed`, `createdAt`, `updatedAt` | `trash`, `insertDate`, `updateDate` | |
| `license.plan` | `plan` | valore memorizzato così com'è (`basic`, `advanced`, `enterprice`, `tgm-secondary`, `desk-secondary`, storici `professional`, `''`); solo PSA (il D alla creazione) |
| `license.expirationDate`, `license.status` | `expirationDate`, `status` | PSA e D; `status` booleano ↔ `active`/`disabled`; mai l'epoca |
| `license.sentry` | `platform.sentry` | solo PSA; il resto di `platform` non è posseduto |
| `openingHours.timezone` | `timezone` | IANA |
| `openingHours.week`, `.special` | `openingTime.weekGeneric` (chiavi `'0'`…`'6'` → `{ active, values: [{ start, end }] }`), `openingTime.daySpecial` (`'YYYY-MM-DD'` → `{ closed, values }`) | scritti come valori interi; le altre chiavi dell'oggetto memorizzato si conservano |
| `openingHours.deliveryTime.week`, `.special` | `delivery.time.weekGeneric`, `delivery.time.daySpecial` | stessa forma |

**Impostazioni (passo 7B):** tredici blocchi, ciascuno posseduto come percorsi foglia (elenco in `shared/legacy-write/place-settings.ts`): `cashSettings` ↔ `general.*` (tranne `priceLists`) e `advancedReport.logs`; `printing` ↔ `receipt`, `prebilling`, `ordering`; `payments` ↔ `payments` e `paymentTypes`; `tables` ↔ `roomsSettings.*` tranne `reservation`; `reservations` ↔ `roomsSettings.reservation.*` (anche `suspendedToday`, scritta anche dal POS: una scrittura del POS dà `412` al successivo `If-Match`); `delivery` ↔ `deliveryTakeAway` e `delivery` tranne `time`; `selfOrdering`; `kiosk`; `appointments` ↔ `appointment`; `externalDisplay`; `fidelity`; `tobacco` ↔ `tgm`; `media` ↔ `medias.images.*`. Il blocco `tables` ha anche `roomsSettings.tableIdleMinutes` (intero 15, 20 o 30, default 30), `variantsPerRow` (boolean, **default `true`** se manca), `discountReasons` e `deleteReasons` (array di testi, default `[]`: 1–100 caratteri, senza caratteri di controllo né `;` (solo in scrittura) né doppioni senza distinguere le maiuscole, al massimo 50) e `reasonsFreeText` (boolean, **default `true`** se manca); un punto vendita nuovo li riceve con questi valori e il duplicato li copia. Posseduti anche, come copie calcolate, `roomsSettings.delivery`, `deliveryAutoOrderingTime`, `deliverySendPrebillingOnSave`, `tableGroupName` e `roomsSettings.tableGroups` (oggetto intero con `mergeProductsPrint`, copia di `ordering.mergeProductsPrint`). Tipi come `prepareData` (Int32 o `null` per gli interi, Int32/Double per i numeri, `''` dove il form scrive `''`, `templateId` ObjectId); le liste e le mappe si scrivono intere (le mappe per valuta e lingua fuse con le chiavi memorizzate). Le chiavi sconosciute o storiche dentro i blocchi (`ordering.fontSize`, `payments.paymentDiscountAuto`…) restano.

**Liste, integrazioni e impostazioni rivenditore (passo 7F).** `devices[]`, `printStations[]`, `productionCenter[]`, `rooms[]` (con `tables[]` e `view`) e `storages[]` sono posseduti come **array interi scritti elemento per elemento** (`shared/legacy-write/place-lists.ts`): il backend manda frammenti (id e chiavi cambiate) che il writer sovrappone all'elemento memorizzato con lo stesso id **dentro la transazione**, così restano le chiavi del POS (`devices[i].info`, `devices[i].status`, `rooms[].view.subtables` e quelle per tavolo), gli artefatti del vecchio form (`__index`, `__listName`, `__printStationsLabels`) e ogni chiave sconosciuta, e un valore invariato conserva il tipo BSON. Id: testo `createId` del vecchio backoffice (dispositivi, postazioni, centri, sale, tavoli), `ObjectId` per `storages[].id`. Forme: dispositivo (36 chiavi del form, con `multisafepayAppStatus`, `multisafepayQrStatus` e `multisafepayTerminals[]` — array di `{ terminalId, name }` stringhe, senza id, **scritto per intero**, al massimo 20, `terminalId` unico nel dispositivo; i campi singoli rimossi dal legacy `multisafepayTerminalId` e `multisafepayName` non sono posseduti: se un documento li ha, restano com'è, nomi derivati `externalDisplayName`, `secondaryCompanyPrinterName`, `favoritesGroupName`, `status: { busy, userName }` creato una sola volta), postazione (`id, name, driver, host, pulseNumber, pulseNumberSecondary, upsideDown, exitsCut, summaryCategoriesIds, summaryPrintStationsIds`), centro (`id, name, capacity`), sala (`id, name, listId, service, tax, deviceId, seatsRequest, seatsRequired, autoService, priceListsRequest, handheldVisibility, printStations, tables, view { type, status, h, w }`), tavolo (`id, roomId, name, seats, userId, view { w, h, x, y, shape }`), deposito (`id, name, cash, ecommerce`). **Versione:** i dispositivi entrano nella versione solo con l'id e le chiavi possedute (il battito del POS non cambia la versione); `rooms` e `storages` per intero (il POS riscrive `rooms`: una sua scrittura dà `412`). `integrations.*` è posseduto **chiave per chiave** (17 provider, compreso `multisafepay`: `status`, `terminalGroupId` (`A-Za-z0-9_-`, 1–64 o `null`), `qrSecondsActive` intero 60–31 536 000 default 600, `qrStatus` e le due credenziali `terminalGroupApiKey` e `websiteApiKey`; i flag `has…ApiKey` del legacy non sono posseduti; le chiavi che nessuno possiede, come `integrations.floodOrders` e `plateform.locationId`, restano; `tsh.tshCategories` è posseduta ma la scrive solo il server con la sincronizzazione delle categorie di TS Hospitality (passo IN: `shared/legacy-write` `SERVER_WRITTEN_PATHS`), nessun campo di una richiesta la imposta, e si legge soltanto come `tsh.categories`); le **credenziali** (Stripe `privateKey` e `webhookPrivateKey`, MultiSafepay `terminalGroupApiKey` e `websiteApiKey`, `appToken`, `apiKey`, `username`, `password`, `keyId`, `tsh.id`/`secret`) sono scritte come testo o `null`, mai lette in memoria né restituite (solo `…Set`). **`satispay.activationCode` non è più posseduto** (passo IN): il codice monouso non si salva; un valore rimasto in un documento del legacy resta dov'è, non si legge né si restituisce, e l'attivazione di Satispay lo toglie (`$unset`) quando scrive `satispay.keyId` (`UNSETTABLE_PATHS`). `tsh.testMode` è riservato a PSA e D; `tsh.propertyId` è `^[A-Za-z0-9_-]{1,64}$`; i valori cambiati di `tsh.categoriesMap` devono essere id della copia `tshCategories`. `server.ip` e `connectorAddress` sono posseduti; `platform.sentry` è nelle impostazioni rivenditore. Il feed `reserve_with_google` segue le chiavi `integrations.reserveWithGoogle.*` e `companyId` (record scritto se attivo e completo e non nel cestino, altrimenti rimosso). Chiavi sconosciute o storiche (`service`, `roomsListId`, `handheldsListId`, `ordering.fontSize`…) restano e non sono restituite.

**`email_templates` (database del gruppo, `legacy-write`, passo T2):** `{ _id, name, text, html, insertDate, updateDate }`: nessun `groupId`, nessun `trash` (l'eliminazione è definitiva), nessuna copia nel common, nessun indice (il legacy non ne crea, nemmeno questo backend). Campi **posseduti** (`EMAIL_TEMPLATES_OWNED_FIELDS`): `name`, `text`, `html`, `insertDate`, `updateDate`. Il backend inserisce documenti interi (`_id` generato, le due date uguali), imposta `name`/`text`/`html`/`updateDate` con `$set` (solo se la data di aggiornamento è ancora quella letta: nessuna perdita di modifiche) ed elimina per `_id`; non scrive mai altre chiavi. `html` fino a 256 KB, `text` fino a 64 KB, `name` fino a 150 caratteri; l'HTML è memorizzato come inviato. La **versione** (`ETag`/`If-Match`) è un HMAC di `_id`, `name`, `text`, `html` e `updateDate`: una modifica del legacy a uno di essi la cambia. Gli ObjectId dei `templateId` dei punti vendita (`appointment.email.templateId`, `roomsSettings.reservation.<emailNotification|email|emailConfirmedStatus|emailRefusedStatus|emailChangeStatus>.templateId`) li verificano il salvataggio del punto vendita (`PlacesRepository.missingTemplates`) e l'eliminazione del template, che li cerca nelle **copie** dei punti vendita (`common.places`, cestinati inclusi) con una lettura fissa (`findPlacesUsingTemplate` in `group-mirror.ts`: percorsi fissi, restituisce solo `_id`, `name` e `companyId`, quest'ultimo per filtrare per perimetro; `MIRROR_FIELDS` non è stato esteso).

Scritture dal nuovo backend (passo 5.6 e 7A, servizio interno `doc/Technical-Guide.md` §7): nel database del gruppo `$set` dei soli **campi posseduti** (`PLACES_OWNED_FIELDS`): `name`, `address`, `postcode`, `city`, `countryAreaCode`, `countryCode`, `contact`, `email`, `telephone`, `companyId`, `listId`, `ecommerceListId`, `invoicePS`, `timezone`, `plan`, `status`, `trash`, `expirationDate`, `updateDate`, `trashDate` (con `trash`, passo P2) e i percorsi foglia `general.priceLists`, `platform.sentry`, `openingTime.*`, `delivery.time.*`, quelli delle impostazioni (7B), `integrations.*`, `server.ip`, `connectorAddress` e le cinque liste (`devices`, `rooms`, `storages`, `printStations`, `productionCenter`, scritte elemento per elemento, passo 7F); mai i blocchi interi né chiavi sconosciute. **Creazione** con il template completo nella forma del vecchio backoffice (`prepareData`: ogni blocco con i suoi default, `ordering.numberFontSize`, `receipt.noFiscalTaxes*`, `receipt.invoiceQt: 1`, `roomsSettings.exitsNumber: 5` con le chiavi deprecate calcolate, `kiosk.mode` `sale`, `integrations.*` senza credenziali, `platform: { sentry }`), `plan` `basic`, `timezone` `Europe/Rome`, le due settimane di sette giorni chiusi e un deposito `{ id, name, cash: true, ecommerce: false }`. **Duplicazione:** copia di tutto il documento (ogni chiave, depositi con gli stessi id, integrazioni con le credenziali) con nuovi `_id`, `insertDate`, `updateDate`, `trash: false` e il nome `<nome> (Copy)`; la chiave di negozio (passo 7C) non si copia. **Effetti collaterali** nella stessa transazione, a ogni scrittura di un punto vendita: `groups.places` ricalcolato per intero (`[{ _id, insertDate }]` di tutti i punti vendita del gruppo, cestinati inclusi, `$set`); `reserve_with_google` (common, chiave logica `(groupId, placeId)`, record `{ groupId, companyId, placeId, category, name, telephone, url, geo { latitude, longitude, address { streetAddress, locality, postalCode, country } } }`): `deleteOne` al cestino e all'eliminazione, upsert al ripristino e alla duplicazione solo se l'integrazione è attiva e completa con la regola del legacy, nulla a creazione e modifica. La concorrenza è ottimistica sulla versione dei soli campi posseduti (`_id`, campi e percorsi posseduti, `trash`, `companyId`; SHA-256 di una forma canonica): una scrittura del POS su chiavi non possedute non la cambia.

## syncIssues — discordanze tra database dei gruppi e copie
Realizzata (passo 5A), senza validatore: `_id`, `runId` (esecuzione di `sync:copies`), `detectedAt`, `kind` (`missingCopy`, `differentCopy`, `extraCopy`, `idCollision`, `invalidCopy`, `groupIdMismatch`, `orphanCompany`, `databaseWithoutGroup`, `unknownCluster`, `nonObjectId`), `collection` (`companies`, `places` o null), `groupId`, `documentId`, `repaired`. Solo id, nessun valore dei documenti né dato personale. Indici: `runId_1`, `kind_1_detectedAt_-1`, TTL `detectedAt_ttl` a 180 giorni.

## settings — impostazioni di piattaforma
Realizzata (passo 9-ter/4), collection `new` del common; **sostituisce** la `platformSettings` mai realizzata. Un documento per chiave: `{ _id, key, value, updatedAt, updatedBy }`. L'unica chiave ora è `PRICE_LIST` (il codice ammette solo le chiavi note). Indice: `key_1` **univoco**. Solo il PSA scrive (evento `priceList.updated` nel registro attività). Senza documento vale il listino di default (i valori del legacy).

`PRICE_LIST.value` = `{ plans: { <chiavePiano>: centesimi }, services: { extraDesk, kiosk, api, tobaccos, reservationWidget, floodPay, arubaEInvoicing, reserveWithGoogle, bizerba: centesimi } }`: importi in **centesimi di euro, IVA esclusa, per punto vendita al mese**, interi da 0 a 10 000 000; la chiave di un piano rispetta `^[A-Za-z0-9_-]{1,30}$` (al più 30 piani: si può prezzare qualsiasi valore di `plan` memorizzato, es. `professional`); i nove servizi ci sono sempre tutti. Default: `basic` 2000, `advanced` 3000, `enterprice` 4000, `tgm-secondary` 0, `desk-secondary` 500; `extraDesk` 500, `kiosk` 1500, `api` 500, `tobaccos` 1300, `reservationWidget` 1000, `floodPay` 1500, gli altri 0. Non c'è storico dei prezzi: lo storico sono le chiusure (`billingClosures`), che conservano i prezzi applicati.

Oltre al listino, la collection contiene un documento di blocco per anno, chiave `BILLING_LOCK:<AAAA>` con valore `{ counter }`: congelamento e sblocco della base dei rinnovi, chiusura e riapertura di un mese lo incrementano dentro la loro transazione, così due operazioni concorrenti sullo stesso anno vanno in conflitto e una sola riesce. Non è un dato da leggere né da modificare a mano.

Un secondo tipo di documento di blocco, chiave `CATALOG_LOCK:<groupId>` (passo C7), con valore `{ owner, expiresAt }` (`owner` stringa esadecimale generata per ogni presa, `expiresAt` Date): è il **blocco con scadenza**, calcolato sull'orologio del database (`$$NOW`), del catalogo di un gruppo, condiviso tra la sincronizzazione dei tabacchi e l'importazione XLSX, anche tra istanze del server. Si crea o si riprende (se `expiresAt` è passata) con una scrittura condizionata atomica sull'indice univoco `key_1`, si rinnova prima della transazione e si cancella a fine operazione solo se `owner` è lo stesso; scade da sé dopo 15 secondi più 3 minuti. È sempre assente quando nulla è in corso e non va letto né modificato a mano.

## billingClosures — chiusure della fatturazione per rivenditore
Realizzata (passo 9-ter/4), collection `new` del common. Un documento per chiusura e per rivenditore: `{ _id, kind, period, dealerId, dealerName, prices, activations: { lines, totals }, renewals: { lines?, totals }, closedAt, closedBy }`.
- `kind` `renewalBase` (periodo `AAAA`: il parco del rivenditore al 31 dicembre dell'anno prima, con le righe dei rinnovi) o `month` (periodo `AAAA-MM`, il **mese della fattura**: le righe delle attivazioni del mese precedente e **solo i totali** dei rinnovi, le cui righe stanno nella base dell'anno). `dealerId` è `null` per i gruppi senza rivenditore.
- `prices`: il listino **effettivo** applicato al rivenditore (listino con le sue personalizzazioni sopra), fino a 60 piani.
- Riga: `{ groupId, groupName, companyId, companyName, placeId, placeName, activatedAt, plan, items: [{ key, quantity, unitCents|null, amountCents }], monthlyCents, months, amountCents, flags }` (`flags` tra `unpricedPlan`, `activationDateFromId`, `expired`, `groupSuspended`, `companyDisabled`); al più **5000 righe** per documento (limite di 16 MB), oltre `409`. Totali delle attivazioni `{ places, monthlyCents, amountCents, projection12Cents, anomalies }`, dei rinnovi `{ places, annualCents, instalmentCents, anomalies }` (`anomalies`: i punti vendita esclusi perché l'azienda manca o è nel cestino).
- Indice: `kind_1_period_1_dealerId_1` **univoco**. Righe e importi non cambiano più dopo la scrittura; riaprire un mese o sbloccare una base cancella i documenti.

## sessions — sessioni del backoffice
Realizzata (passo 3A): un documento per famiglia di sessione. `_id` (id esposto della sessione), `userId`, `accessTokenHash` (SHA-256 del token corrente, univoco), `accessExpiresAt`, `refreshTokenHash` (corrente, univoco), `previousRefreshHashes` (ultimi 50 hash ruotati, per rilevare il riuso), `rotatedAt`, `refreshExpiresAt` (inattività), `familyExpiresAt` (durata massima), `createdAt`, `lastUsedAt`, `userAgent`, `ip`, `revokedAt`, `revokeReason` (anche `dpopUnbound` e `dpopKeyMismatch`, D-33), `jkt` (impronta RFC 7638 della chiave del browser legata al login, D-33: non cambia alle rotazioni, mai esposta; assente nelle sessioni precedenti, revocate al primo uso), `expiresAt` (TTL = fine famiglia + 1 giorno). Indici: `accessTokenHash_1` e `refreshTokenHash_1` univoci, `previousRefreshHashes_1`, `userId_1_revokedAt_1`, TTL `expiresAt_1`.

## storeActivationCodes — codici di attivazione dei server di punto vendita
Realizzata (passo 7C, D-24), collection `new` del common (nuova, non condivisa col legacy). Un documento per codice **ancora da scambiare**, al più uno per punto vendita: `_id`, `groupId`, `companyId` (al momento della creazione, solo informativo), `placeId`, `codeHash` (SHA-256 esadecimale del codice normalizzato: mai il codice), `createdBy` (`{ userId, role: 'PSA' | 'D' }`), `createdAt`, `expiresAt` (24 ore di default). Indici: `codeHash_1` **univoco**, `placeId_1` **univoco** (la creazione è un `replaceOne` con upsert), `expiresAt_1` **TTL** (`expireAfterSeconds: 0`; il TTL è pigro, quindi la scadenza si controlla sempre anche nella query). Il documento si cancella allo scambio (`findOneAndDelete` atomico).

## storeKeys — chiavi di negozio
Realizzata (passo 7C, D-24), collection `new` del common. Un documento per chiave di un punto vendita, **al più una attiva per punto vendita**: `_id` (il `keyId` esposto), `groupId`, `placeId` (fissi per tutta la vita della chiave; **nessun `companyId`**: un punto vendita può cambiare azienda, quindi si rilegge dal punto vendita a ogni richiesta), `keyHash` (SHA-256 esadecimale di `fc_sk_…`: mai la chiave), `keyHint` (i primi 4 caratteri del corpo, per riconoscerla), `status` (`active` | `revoked`), `activatedAt`, `activatedBy` (`{ userId, role }` di chi ha generato il codice), `installation` (`{ userAgent, appVersion, platform }` dichiarati dall'app allo scambio, ripuliti e troncati a 200 caratteri, `null` se mancanti), `activationIp`, `lastSeenAt` (al più una volta al minuto), `lastSeenIp`, `lastSeenUserAgent` (IP in chiaro come per le sessioni), `revokedAt`, `revokedBy` (`{ kind: 'user', userId, role }` | `{ kind: 'system' }` | `null`), `revokeReason` (`revoked`, `replaced`, `placeTrashed`, `placeDeleted` | `null`) e, **solo sulle revocate**, `purgeAt` (`revokedAt` + 365 giorni). Indici: `keyHash_1` **univoco**; `placeId_1_active` **univoco parziale** (`partialFilterExpression: { status: 'active' }`: la regola "una sola chiave attiva" la garantisce il database); `groupId_1_placeId_1_activatedAt_-1` (storico del punto vendita); `purgeAt_1` **TTL** (le attive non hanno `purgeAt` e non scadono mai). Il documento del punto vendita non contiene nulla della chiave e la duplicazione di un punto vendita non la copia.

## apiKeys — chiavi delle API pubbliche
Realizzata (passo 9A), collection `new` del common. Un documento per chiave, **più chiavi per gruppo**, ognuna con i propri permessi, restrizioni e limiti: `_id` (il `id` esposto), `groupId`, `name` (1–100 caratteri), `prefix` (i primi 12 caratteri della chiave, `fc_pk_` e sei più, per riconoscerla), `hash` (SHA-256 esadecimale di `fc_pk_…`: **mai la chiave**), `permissions` (`places:read`, `companies:read`, `catalog:read`, `catalog:write`: il catalogo pubblico, almeno uno, senza ripetizioni; `catalog:write` dal 2026-11-24, nessuna modifica di struttura), `restrictions` (`{ companyIds, placeIds }`, ciascuno un elenco di al più 100 id o `null`), `rateLimitPerMinute` (1–6000), `dailyQuota` (1–10 000 000), `expiresAt` (data o `null`), `status` (`active` | `revoked`), `revokedAt`, `revokedBy` (`{ userId, role }` | `null`), `createdAt`, `createdBy` (`{ userId, role: 'PSA' | 'D' }`), `lastUsedAt` (al più una volta al minuto). Una chiave revocata resta per lo storico: non c'è cancellazione. Indici: `hash_1` **univoco** (la ricerca di ogni richiesta), `groupId_1_createdAt_-1` (elenco e conteggio delle attive).

## idempotencyKeys — chiavi di idempotenza
Realizzata (decisione del 2026-11-13), collection `new` del common senza validatore: `{ _id, principal (id dell'utente, esadecimale; `store:<id della chiave di negozio>` o `apikey:<id della chiave pubblica>` per le chiavi), route (metodo e percorso concreto), key (UUID minuscolo), bodyHash (SHA-256 esadecimale del JSON canonico del body), state (`inProgress`/`done`), response? ({ status, body, location, etag }), createdAt, expiresAt }`. Indici: **univoco** `principal_1_route_1_key_1` e TTL `expiresAt_1` (`expireAfterSeconds: 0`); `expiresAt` è 5 minuti per una richiesta in corso e 24 ore dalla fine per una finita. Contiene le risposte delle creazioni idempotenti (aziende, punti vendita, duplicazione), già senza credenziali.

## rateLimits — contatori a finestra fissa
`_id` = `<bucket>:<SHA-256 hex della chiave>:<inizio finestra in secondi>` (username e IP mai in chiaro), `count`, `expiresAt` (fine finestra + 60 s). Indice TTL `expiresAt_1`. Realizzata (passo 2C).

## apiUsage — conteggio d'uso delle API pubbliche
Realizzata (passo 9A), collection `new` del common: una riga per chiave, **giorno UTC** e route, scritta a blocchi (ogni 30 secondi, al raggiungimento del tetto di memoria e allo spegnimento) con `$inc` e upsert: `keyId`, `groupId`, `day` (`YYYY-MM-DD`), `route` (`<METODO> <pattern della route>`, per esempio `GET /public/v1/places/:placeId`: mai il percorso concreto), `calls` (ogni richiesta di una chiave valida, anche rifiutata), `errors4xx` (risposte `4xx` diverse da `429`), `errors5xx`, `rateLimited` (`429` per limite al minuto o quota, della chiave o del gruppo), `aborted` (richieste interrotte dal client prima della fine della risposta, contate anche in `calls`), `expireAt` (fine del giorno più 400 giorni). Indici: `keyId_1_day_1_route_1` **univoco**, `expireAt_1` **TTL**. Le richieste con una chiave sconosciuta o rifiutata non si contano. Nessuna quota mensile.

## activityEvents — registro delle attività (sostituisce `auditLog`)
Realizzata (passo 2C, decisione dell'utente del 2026-11-01; rinominata `activityEvents`, senza validatore del database, la vecchia `activityLog` è abbandonata): un'unica collection per scritture sui dati, eventi di sicurezza ed errori. La collection `logs` del legacy resta intatta.
| Campo | Tipo | Note |
|---|---|---|
| `at` | Date | |
| `category` | `data` \| `security` \| `error` | |
| `action` | string | da catalogo, es. `user.updated`, `group.crossAccess`, `request.failed`, `store.keyRevoked` (eventi `store.*` del passo 7C: solo id, `keyHint` e motivi, mai codici né chiavi; eventi `apiKey.created`/`updated`/`revoked` del passo 9A: categoria `security`, risorsa `apiKey`, metadati `name`, `keyHint` (i sei caratteri dopo `fc_pk_`: il registro oscura ogni testo che inizia come una chiave) e, per l'aggiornamento, `fields` con i nomi dei campi cambiati, mai la chiave) |
| `outcome` | `success` \| `failure` \| `denied` | |
| `actor` | `{ kind: 'user' \| 'anonymous' \| 'system' \| 'store' \| 'apiKey', id?, role? }` | `id` obbligatorio per `user` (l'utente), per `store` (l'id della chiave di negozio, passo 7C) e per `apiKey` (l'id della chiave pubblica, passo 9A) |
| `groupId` | ObjectId | facoltativo |
| `resource` | `{ type, id? }` | facoltativo |
| `changes` | `{ field, before?, after?, redacted?, truncated? }[]` | solo `data`; segreti oscurati |
| `requestId`, `ip` | string | |
| `metadata` | oggetto | chiavi ammesse per azione, massimo 20 valori scalari |
| `error` | `{ name, message, stack }` | solo per `client.error` (errori JavaScript del backoffice): messaggio fino a 300 caratteri, prime 10 righe dello stack di massimo 300 caratteri, redatti |
| `expiresAt` | Date | TTL: 365 giorni per `data` e `security`, 90 per `error` |
Indici: `at_-1__id_-1`, `groupId_1_at_-1__id_-1`, `actor.id_1_at_-1__id_-1`, `category_1_at_-1__id_-1` (ordinamento del monitor senza ordinamento in memoria), `requestId_1`, TTL `expiresAt_1`. Gli indici precedenti senza `_id` vengono rimossi all'avvio dopo la creazione dei nuovi.

## files — immagini del gruppo (database del gruppo, solo originale)
Le immagini del Media Manager. Collection `legacy-write` del database del gruppo (`FILES_OWNED_FIELDS`): in questo passo (6B) il backend **inserisce documenti interi** con l'upload e li legge; non modifica documenti esistenti (modifica di `alt`/`title`, cestino ed eliminazione arriveranno con il dominio media). **Nessuna copia nel common** (D-20 riguarda solo `companies` e `places`). **Nessun indice**: il legacy non ne crea e `ensureIndexes` non ammette indici sui database dei gruppi.

| Campo | Tipo BSON | Valore nell'upload |
|---|---|---|
| `_id` | ObjectId | nuovo |
| `groupId` | ObjectId | gruppo dell'URL (accesso verificato) |
| `basename` | string | `<slug>-<8 esadecimali>.<jpg\|png\|webp>`, anche nome dell'oggetto |
| `name` | string | nome originale senza estensione (ripulito, al più 150 caratteri) |
| `extension` | string | `jpg`, `png` o `webp` (dal formato reale) |
| `dirname` | string | `/media/image` |
| `type` | string | `image` |
| `mimetype` | string | `image/jpeg`, `image/png` o `image/webp` (dal formato reale) |
| `filectime` | double | `Date.now()` in millisecondi |
| `alt`, `title` | string | uguali a `name` |
| `trash` | boolean | `false` |
| `insertDate`, `updateDate` | Date | istante dell'upload |
| `createdBy` | ObjectId | utente che ha caricato l'immagine (chiave **aggiuntiva** di questo backend, decisione dell'utente del 2026-11-13) |
| `companyId` | ObjectId o `null` | azienda proprietaria dell'immagine, `null` per un'immagine di tutto il gruppo (chiave **aggiuntiva**): il CA vede e usa solo le immagini delle proprie aziende; i documenti legacy non hanno la chiave e un CA non li vede |

Chiavi e ordine come nel legacy; `createdBy` e `companyId` seguono `updateDate`. Sono **additive**: il legacy le ignora (legge solo le chiavi che conosce) e non le tocca. Un documento legacy può mancare di campi (nessuno schema): la lettura è tollerante. Gli oggetti stanno nel bucket in `<groupId>/media/image/<xs|s|m|l|xl>/<basename>` e si raggiungono con `groups.filesHost` (letto, mai scritto: `https` valido, altrimenti nessun URL). **Descrittore nei loghi dell'azienda** (`companies.medias.images.customersAppLogoLight|Dark`): `{ _id (string esadecimale), dirname, basename, extension, filename (= name), mimetype, filectime (double), mmThumb ({}), type ('image'), title, alt }` in quest'ordine. Il backend non si fida di un documento `files`, che il legacy lascia riscrivere a qualunque utente: per un logo la directory è sempre `/media/image`, il `basename` deve essere un nome semplice (un solo segmento, senza `/`, `\`, `..`, `?`, `#`, `%`, caratteri di controllo né punto iniziale), `mimetype` un `image/*` e l'estensione lettere e cifre, altrimenti l'immagine non è utilizzabile (`422`).

## products_departments — reparti del gruppo (database del gruppo)
I reparti che il POS legge senza guardia (`department.tax.value`) e che il backoffice gestisce dal passo C1. Collection `legacy-write` del database del gruppo (`PRODUCTS_DEPARTMENTS_OWNED_FIELDS`): il backend **inserisce documenti interi** (alla creazione del gruppo, uno per aliquota, nel passo 8A; con `POST /v1/groups/{groupId}/product-departments`, passo C1), **modifica** solo i campi posseduti con `$set`/`$unset` (ogni altra chiave del documento resta) ed **elimina** (definitivamente). La collection non si crea prima: nasce con l'inserimento. Nessun indice, come nel legacy (la regola `ensureIndexes` vieta gli indici sulle collection dei gruppi): l'unicità del codice è un controllo applicativo.

| Campo | Tipo BSON | Dati reali (profilo di produzione, 150 gruppi: 351 reparti, 1–8 per gruppo) e valore alla creazione |
|---|---|---|
| `_id` | ObjectId | nuovo |
| `groupId` | ObjectId | solo nei documenti dell'onboarding (chiave **aggiuntiva**: il legacy non la scrive); i reparti creati dalle route non la scrivono e non la toccano |
| `code` | Int32 (anche stringa, Double, `NaN`) | Int32 in 235 documenti, **stringa in 110**, Double `NaN` in 6; nessun codice duplicato nel gruppo. Le route scrivono un Int32 da 1 a 99, unico nel gruppo **per valore numerico**; la lettura è tollerante (stringa di cifre → numero, `NaN`/non numerico/assente → `null`) |
| `tax` | oggetto | sempre `{ id, value, department, description, natura }`: copia dell'aliquota di `groups.taxes` (`value` Int32 se intero, Double altrimenti); il POS legge `tax.value` e `tax.department`. Si **riallinea** quando l'aliquota del gruppo cambia (`updateMany` sui reparti con lo stesso `tax.id`, solo se la copia differisce, con `$set` delle sole cinque chiavi `tax.id`, `tax.value`, `tax.department`, `tax.description`, `tax.natura`: le altre chiavi di `tax` restano) |
| `name`, `description` | oggetti per lingua | `{ it: "Reparto <code>" }` e `{ it: "" }` dall'onboarding; dalle route le lingue del gruppo |
| `noDiscount`, `secondaryFiscalPrinter` | booleani | presenti solo in 65 documenti; assenti = `false`; le route li scrivono sempre nei documenti nuovi |
| `medias` | oggetto | `{ images: {} }`; **nessuna immagine salvata** nei dati reali (`medias.images.images` è un oggetto vuoto lasciato da un bug del vecchio form: non si legge né si tocca). Con la feature `media` l'immagine scelta dalla libreria sta in `medias.images.main` (descrittore come quello dei loghi delle aziende: `_id` testo, `dirname`, `basename`, `extension`, `filename`, `mimetype`, `filectime` Double, `mmThumb: {}`, `type`, `title`, `alt`); se `medias` o `medias.images` mancano o non sono oggetti si scrive il contenitore più piccolo che contiene il percorso |
| `placesAvailability` | array di ObjectId | vuoto o assente in 331 documenti (= tutti i punti vendita); gli elementi sono ObjectId semplici; **assente, `null` o vuoto** vuol dire tutti i punti vendita (e solo questo), ogni altro elemento (anche il testo esadecimale) è anomalo: non è un punto vendita, si conserva e rende la voce di sola lettura per CA e PA |
| `status` | booleano | stato del reparto (`enabled` nell'API); il POS non lo filtra |
| `trash` | booleano | presente in 276 documenti dall'onboarding, **mai letto dal legacy** e mai letto né scritto dalle route |
| `insertDate`, `updateDate` | Date | istante della creazione; `updateDate` si aggiorna a ogni modifica (anche da un riallineamento dell'aliquota) e protegge la scrittura da modifiche concorrenti |

Chiavi che il backend non gestisce restano intatte in ogni modifica. Un reparto con `tax` non oggetto (reparti del codice morto del legacy) si legge con `tax: null`.

## products_brands — marche del gruppo (database del gruppo)
Collection `legacy-write` (`PRODUCTS_BRANDS_OWNED_FIELDS`, passo C1): il backend inserisce documenti interi (`POST /v1/groups/{groupId}/product-brands`), modifica i campi posseduti con `$set`/`$unset` ed elimina. 4 documenti nei dati reali. Nessun cestino, nessun indice.

| Campo | Tipo BSON | Note |
|---|---|---|
| `_id` | ObjectId | |
| `name`, `description` | oggetti per lingua | `name` obbligatorio nella lingua richiesta |
| `placesAvailability` | array di ObjectId | vuoto = tutti i punti vendita (come i reparti) |
| `medias` | oggetto | `{ images: {} }`; immagine in `medias.images.main` come nei reparti |
| `status` | booleano | `enabled` nell'API |
| `insertDate`, `updateDate` | Date | |

I tre interruttori che il vecchio form mostrava (disponibile per cassa, per e-commerce, in evidenza) non erano salvati e non esistono. Una marca è usata da `products.brandId` (ObjectId): non si elimina se un prodotto non cestinato la ha.

## products_attributes — gruppi di attributi (database del gruppo)
Collection `legacy-write` (`PRODUCTS_ATTRIBUTES_OWNED_FIELDS`, passo C1): il backend inserisce documenti interi (`POST /v1/groups/{groupId}/product-attribute-groups`), imposta i campi posseduti con `$set` (la lista `attributes` si sostituisce per intero) ed elimina. 2 documenti nei dati reali. Nessun indice.

| Campo | Tipo BSON | Note |
|---|---|---|
| `_id` | ObjectId | |
| `name` | oggetto per lingua | nome del **gruppo** |
| `attributes` | array di `{ id, name }` | `id` testo generato dal server (22 caratteri base64url, come gli id degli altri elenchi); `name` oggetto per lingua; al più 200 elementi. Gli elementi con altre chiavi le conservano finché il nome non cambia; gli elementi senza `id` testuale (o non oggetti) non si mostrano e si conservano in coda a ogni sostituzione della lista |
| `insertDate` | Date | **assente** nei gruppi nati dall'upsert del vecchio sistema |
| `updateDate` | Date | |

L'uso dei prodotti: `products.attributes` è un array di testi, gli `id` degli elementi di `attributes`; né un attributo né un gruppo si eliminano se un prodotto non cestinato ne usa uno.

## products_categories — categorie di prodotto (database del gruppo)
Collection `legacy-write` (`PRODUCTS_CATEGORIES_OWNED_FIELDS` e `PRODUCTS_CATEGORIES_OWNED_TREES`, passo C2): il backend inserisce documenti interi nella forma del legacy (`POST /v1/groups/{groupId}/product-categories`), modifica solo i campi posseduti con `$set`/`$unset` ed elimina (definitivamente). Dati reali (150 gruppi): 3.867 categorie, al massimo 101 per gruppo. Nessun indice, nessun cestino (`trash` c'è in 22 documenti, mai usato: non si legge né si scrive).

| Campo | Tipo BSON | Dati reali e scrittura |
|---|---|---|
| `parentId` | ObjectId o `null` | albero; nessun genitore orfano, **cicli in 11 gruppi**. Le route impediscono nuovi cicli; la lettura è tollerante (vedi `doc/API.md`) |
| `name`, `description` | oggetti per lingua | `name` obbligatorio nella lingua richiesta |
| `position`, `productionValue` | Int32 o `null` | `position`: Double (con `NaN`) in 1.098, Int32 in 1.993, `null` in 776; `productionValue`: Double (`NaN`) in 2.602. Le route scrivono Int32 o `null`, mai `NaN`; la lettura rende `null` un `NaN` o un valore non numerico |
| `availability.pos`, `availability.ecommerce` | booleani | `ecommerce` assente in 1.127 documenti (assente = `false`) |
| `noDiscount`, `requiresGreaterAge`, `secondaryFiscalPrinter`, `featured` | booleani | chiavi non sempre presenti (assente = `false`) |
| `backgroundColor`, `textColor` | testo `#RRGGBB` | predefinito `#000000`; il legacy accetta qualunque testo, la lettura rende `null` ciò che non è un colore |
| `integrations.floodOrders`, `.yellgo`, `.leggimenu`, `.easyappear` | booleani | `easyappear` (anche `easyAppear` in 51 documenti): conservato e mai esposto né modificato; i nuovi documenti lo scrivono `false`; `integrations` assente in 58 documenti |
| `roomsSettings.endMeal`, `.handheldHidden`, `.percentageFee`, `.printGroup`, `.alwaysFirstExit`, `.notAffiliatedMenu`, `.type` | booleani, numero o `null`, testo | `percentageFee` Int32 se intero, Double con decimali (il legacy usa `parseFloat`); `printGroup` Int32 o `null`; `type` `other`/`food`/`beverage` |
| `tgm.type` | booleano | `tgm` assente in 1.522 documenti |
| `medias.images.main`, `.icon`, `.internalFileName`, `.externalUrl` | descrittore, testo | posseduti per percorso esatto (più i contenitori di ripiego `medias.images` e `medias`); `externalUrl` solo `https`; descrittori come nei loghi delle aziende; il residuo `medias.images.images` non si legge né si tocca; se `medias` o `medias.images` mancano o non sono oggetti si scrive il contenitore più piccolo che contiene il percorso |
| `placesAvailability` | array | **due forme**: elementi `{ id: ObjectId, position: Int32 o null, productionCenterId: testo o null }` (3.535) oppure ObjectId semplici, formato storico (307); vuoto o assente = tutti i punti vendita. Le route scrivono sempre la forma attuale (gli elementi di un punto vendita già presente conservano le loro altre chiavi) e riscrivono il formato storico a ogni salvataggio; elementi anomali si conservano |
| `variants` | array di ObjectId | modificatori: prodotti con `variant.status` vero |
| `variantsCategories` | array di ObjectId | categorie di modificatori |
| `printStations`, `printStationsNoRooms` | mappe `{ "__<placeId>": [idPostazione] }` | possedute come alberi (`PRODUCTS_CATEGORIES_OWNED_TREES`): si scrive o si toglie la voce di un solo punto vendita; le chiavi che non sono `__` e un id si conservano e non si mostrano |
| `status` | booleano | `enabled` nell'API |
| `insertDate`, `updateDate` | Date | `updateDate` protegge la scrittura da modifiche concorrenti |

Riferimenti alla categoria (controllati prima di eliminarla, vedi `doc/API.md`): `products_categories.parentId` e `variantsCategories`; `products.categories`, `products.variantsCategories`, `products.selectableBundleProducts[].categoryId`, `products.selectableVariantsBundleProducts[].categoryId`; `groups.promotions[]` (`conditions.categories.ids`, `actions.categoriesIds`); nei punti vendita (letti dalle copie in `common.places`) `printStations[].summaryCategoriesIds`, `kiosk.upsellingCategoryId`, `kiosk.productsCategories[]._id`, `selfOrdering.priceListsConfig.<listino>.productsCategories[]._id`, `integrations.tsh.categoriesMap.<idCategoria>`. Degli id dei punti vendita (postazioni di stampa, centri di produzione) si leggono solo `printStations[].id` e `productionCenter[].id`.

## products — prodotti del gruppo (database del gruppo)
Collection `legacy-write` (`PRODUCTS_OWNED_FIELDS`, `PRODUCTS_OWNED_TREES`, `PRODUCTS_STOCK_LEAVES` e `PRODUCTS_INSERT_ONLY_FIELDS`, passo C3): il backend inserisce documenti interi nella forma che scrive il backoffice legacy (`POST /v1/groups/{groupId}/products`, 58 chiavi, array sempre presenti), modifica solo i campi posseduti con `$set`/`$unset` (per **percorso foglia** dentro `availability`, `variant`, `modularBundle`, `colors.pos`, `shippingInfo`, `roomsSettings`, `integrations`, `medias.images`; le mappe `printStations` e `printStationsNoRooms` come alberi, una voce per punto vendita; `quantity` solo alle foglie `quantity.__<placeId>.__<storageId>.min|max|location`), imposta `trash`/`trashDate` ed elimina (definitivamente, solo dal cestino). **Mai scritti**: `quantity.*.value`, `quantity` come oggetto intero (nel registro è solo-inserimento e lettura, come `lastAveragePrice`: l'ultima barriera rifiuta `quantity`, `quantity.__p`, `quantity.__p.__s` e `quantity.__p.__s.value`; si scrivono solo le foglie `min|max|location`) e `lastAveragePrice` (li muove il magazzino; `lastAveragePrice` si scrive solo azzerato in un documento nuovo), `tags`, `related`, `parentId` (sempre vuoti, solo in un documento nuovo), `integrations.easyappear` (`false` in un documento nuovo), e ogni chiave che il registro non elenca (quelle del POS e delle integrazioni restano). I prezzi (`prices`) sono scritti dalle route del prodotto e, nella sola copia dell'aliquota, dal riallineamento di un'aliquota del gruppo (`prices[].tax` e `prices[].taxData`, con `price` ricalcolato). Nessun indice (a oggi in 29 database su 150 ci sono `barcode.value_1` e `code_1`, creati altrove; le ricerche per `code`, barcode e PLU sono scansioni limitate con `maxTimeMS`). Dati reali del 2026-11-23: 94.437 prodotti, fino a 5.172 per gruppo e 28 KB per documento, 16.159 nel cestino.

**Sincronizzazione dei tabacchi (passo C7).** Scrive questa collection con `bulkWrite` in una transazione, **senza nessuna chiave nuova**: inserisce prodotti interi di `type: 'tobaccos'` e, sui prodotti `tobaccos`/`games`/`monopoly` abbinati per `code`, imposta soltanto `noDiscount`, `availability.warehouse`, `name.it`, `shortName.it`, `description.it`, `shortDescription.it`, `categories`, `prices`, `barcode` (se il listino ne ha), `placesAvailability` e `updateDate`, più `status` (disattivazione dei tabacchi usciti dal listino, riattivazione di quelli tornati). Tutti campi già posseduti.

Mapping campo API ↔ campo del documento (le chiavi senza funzione del gruppo non compaiono nell'API; "tollerante" = lettura che rende `null`, `false` o lista vuota per `NaN`, tipo sbagliato o chiave assente):

| Campo API | Campo del documento | Tipo BSON e dati reali |
|---|---|---|
| `id` | `_id` | ObjectId |
| `type`, `family`, `isModifier` | `type`; calcolata; `variant.status` | `type`: `product` 81.455, `tobaccos` 12.738, `games` 122, `service` 38, `exempt` 14, `null` 70 (letto `null`); `variant.status` vero in 14.020, assente in 285; `isModifier` non cambia dopo la creazione |
| `enabled` | `status` | booleano |
| `code` | `code` | testo; `null` in 2.393 (letto `null`); `""` in un documento nuovo |
| `plu` | `plu` | testo (40.578), `null` (52.506), assente (1.353); scritto come testo di cifre senza zeri iniziali o `null` (il POS lo confronta come stringa) |
| `barcodes[]` `{ value, loadQuantity, saleQuantity }` | `barcode[] { value, qtLoad, qtSale }` | array; `qtLoad` solo con `warehouse`; elementi che non sono oggetti con `value` testo si ignorano |
| `name`, `shortName`, `description`, `shortDescription` | stessi nomi | oggetti per lingua; `shortName` fino a 18 caratteri |
| `favorite`, `favoriteHandheld`, `generic`, `toCheck`, `noDiscount`, `featured` | stessi nomi | booleani; assenti = `false` |
| `brandId` | `brandId` | ObjectId o `null` |
| `categoryIds[]` | `categories[]` | ObjectId (o testo esadecimale, letto): 3.706 riferimenti orfani, mostrati per id |
| `attributeIds[]` | `attributes[]` | testi (id di `products_attributes.attributes[]`) |
| `position`, `productionValue` | stessi nomi | Int32 o `null` |
| `duration`, `maxConcurrent` | `time`, `max` | `HH:mm` o `""`/`null`; `max` Int32 o `null` (`NaN` in 2.307, letto `null`) |
| `validFrom`, `validTo` | `startDate`, `endDate` | `Date` o `null` (in lettura anche testo ISO) |
| `availability.pos\|warehouse\|scales\|ecommerce` | `availability.pos\|warehouse\|scales\|ecommerce` | booleani |
| `integrations.floodOrders\|yellgo\|leggimenu` | `integrations.floodOrders\|yellgo\|leggimenu` | booleani; `integrations.easyappear` non esposta né toccata |
| `scaleType` | `scaleType` | Int32 `0` (`weight`) o `1` (`piece`); `NaN` in 8.416 (letto `null`) |
| `loadUnit`, `unloadUnit`, `conversionRatio` | `measureLoad`, `measureDownload`, `measureConversionRatio` | testi (il `value` di `groups.measureUnits[]`, non l'id), numero (`NaN` possibile) |
| `colors.text`, `colors.background` | `colors.pos.text`, `colors.pos.background` | `#RRGGBB` |
| `dining.halfPortion`, `.hiddenOnHandheld`, `.affiliatedMenu`, `.reversePrint`, `.feePercentage` | `roomsSettings.halfPortion`, `.handheldHidden`, `.affiliatedMenu`, `.reversePrint`, `.percentageFee` | booleani, numero o `null` |
| `modifier.type`, `.pricePercentagePlus`, `.pricePercentageMinus`, `.description` | `variant.type`, `.pricePercentagePlus`, `.pricePercentageMinus`, `.description` | `pm`/`p`/`m`/`i` ↔ `addRemove`/`add`/`remove`/`info`; `variant.type` `null`, assente (13.156) e altri testi (438) si leggono `null`; numeri o `null` |
| `requiredModifierIds`, `modifierIds`, `excludedModifierIds`, `modifierCategoryIds` | `variantsRequired`, `variants`, `variantsExcluded`, `variantsCategories` | array di ObjectId; assenti in molti documenti |
| `components[] { productId, quantity, waste }` | `bundleProducts[] { _id, quantity, waste }` | `quantity` nell'unità di carico del componente |
| `menu[] { categoryId, quantity, course, productIds }` | `selectableBundleProducts[] { categoryId, quantity, exit, products[{ _id }] }` | `exit` `NaN` in 13 (letto `null`); si scrive solo con `rooms` |
| `modifierChoices[] { categoryId, freeQuantity, priceRule, productIds }` | `selectableVariantsBundleProducts[] { categoryId, freeQt, priceType, products[{ _id }] }` | `h`/`l` ↔ `highest`/`lowest` |
| `modularPriceRule` | `modularBundle.priceRule` | `average` ↔ **`avarage`** (refuso conservato), `sum`, `fixed`, `null` |
| `prices[]` | `prices[] { id, listId, currency, tax, taxData{ id, value, department, description, natura }, price, taxed, discount, startDate, endDate, startTimeDaily, endTimeDaily, weekDays, fromQt, maxQtSell }` | vedi sotto |
| `places[] { placeId, favorite, favoriteHandheld, position, productionCenterId }` | `placesAvailability[] { id, favorite, favoriteHandheld, position, productionCenterId }` | **due forme**: oggetti (69.305 elementi) e ObjectId semplici (78, formato storico, riscritti nella forma attuale solo quando si scrive `places`); vuota o assente in 30.996 documenti = per tutti; 78 riferimenti a punti vendita inesistenti |
| `printStations`, `counterPrintStations` | `printStations`, `printStationsNoRooms` | mappe `{ "__<placeId>": [idPostazione] }` |
| `stock { <placeId> { <storageId> { quantity, min, max, location } } }` | `quantity { "__<placeId>" { "__<storageId>" { value, min, max, location } } }` | `value` sola lettura (`$inc` del magazzino); si scrivono `min`, `max`, `location` |
| `costs` | `lastAveragePrice { lastSupplierId, total{ lastPrice, averagePrice, weightedAveragePrice, … }, suppliers{ <id> { … } } }` | solo lettura; zero in un documento nuovo |
| `simpleCost` | `simpleCost` | numero o `null` |
| `suppliers[] { contactId, code, name, minQuantity, deliveryTime, deliveryTimeUnit, favorite, priceLists[] }` | `suppliers[] { id, code, name, minQt, deliveryTime, deliveryTimeUnit, favorite, companyLists[{ id, price, discount1, discount2, discount3 }] }` | `id` ObjectId (o testo, scritto dal magazzino), `delivetyTime` (refuso del magazzino) letto come `deliveryTime`; le chiavi sconosciute di un elemento restano |
| `shipping.width\|height\|depth\|weight` | `shippingInfo.width\|height\|depth\|weight` | numeri o `null` |
| `image`, `gallery[]`, `internalFileName`, `externalUrl` | `medias.images.main`, `.gallery[]`, `.internalFileName`, `.externalUrl` | descrittori come i loghi delle aziende; contenitori di ripiego `medias.images` e `medias` |
| `trashed`, `trashedAt` | `trash`, `trashDate` | `trash` booleano (16.159 veri); `trashDate` solo nei documenti cestinati da questo backend |
| `createdAt`, `updatedAt` | `insertDate`, `updateDate` | Date; `updateDate` è la versione per il POS |

**Prezzi.** `price` è il netto (8 decimali), `taxed` il prezzo con IVA (2 decimali dal form, fino a 8 dall'import), in **unità di valuta decimali**; `tax` la percentuale; `taxData` la copia dell'aliquota del gruppo (`id`, `value`, `department`, `description`, `natura`). `listId` e `taxData.id` sono sempre testi; `startDate`/`endDate` sono **`Date` (735) o testo ISO (784)** o `null`, e le route scrivono il testo ISO come il backoffice legacy. 6 prezzi hanno `price`/`taxed` `NaN` (letti `null`); più prezzi per lo stesso listino in 2.008 prodotti; 44 listini e 2 aliquote inesistenti; `taxData` diversa dall'aliquota attuale in 528 prezzi (la riallinea una modifica dell'aliquota). L'indice dell'array è stabile (il POS modifica `prices.<n>`).

**Guardie di concorrenza.** `updateDate` (e `placesAvailability`) devono essere ancora quelli letti, e ogni campo che la scrittura imposta deve avere ancora il valore letto (`sameAs`): il POS scrive i prezzi per indice senza toccare `updateDate`. I contenitori di ogni foglia scritta devono essere mancanti o oggetti. La versione (`ETag`) copre i campi scritti dal backend tranne `quantity` (di cui entrano solo `min`, `max` e `location`), `lastAveragePrice`, `tags`, `related`, `parentId` e `integrations.easyappear`.

Riferimenti al prodotto (controllati prima di eliminarlo, vedi `doc/API.md`): `products.bundleProducts[]._id`, `products.selectableBundleProducts[].products[]._id`, `products.selectableVariantsBundleProducts[].products[]._id`, `products.variantsRequired`, `products.variants`, `products.variantsExcluded`, `products_categories.variants`, `users.servicesId`, `groups.productsFavorites[].favorites[]._id`, `groups.promotions[].conditions.products.ids` e `actions.productsIds`. Un prodotto fa riferimento a: `brandId` (`products_brands`), `categories`, `variantsCategories`, `selectableBundleProducts[].categoryId` e `selectableVariantsBundleProducts[].categoryId` (`products_categories`), `attributes` (`products_attributes.attributes[].id`), `suppliers[].id` (`contacts` con `supplier: true`), `placesAvailability[].id`, `printStations`, `quantity` (copie dei punti vendita in `common.places`: `printStations[].id`, `productionCenter[].id`, `storages[].id`), `prices[].listId` (`groups.priceLists`), `prices[].currency` (`groups.currencies`), `prices[].taxData.id` (`groups.taxes`), `measureLoad`/`measureDownload` (`groups.measureUnits[].value`), `medias.images.main|gallery` (`files`).

## tobaccos — listino nazionale dei tabacchi (database common, collection legacy condivisa)
Il listino ufficiale ADM, **unico per la piattaforma**, che il legacy sostituisce per intero a ogni importazione (`ms-tgm-service`) e che legge la sincronizzazione del catalogo. Collection `legacy-write` (`TOBACCOS_OWNED_FIELDS`): il nuovo backend **inserisce documenti interi** e **cancella tutto**, sempre insieme, in una transazione (passo T3); non modifica mai un documento. Nessuna chiave aggiuntiva, nessun validatore (i documenti del legacy possono avere tipi diversi).

| Campo | Tipo BSON | Note |
|---|---|---|
| `_id` | ObjectId | |
| `category` | stringa | colonna 1 del file; `''` se vuota |
| `code` | stringa | colonna 2; obbligatorio e unico nel file (l'unicità non è un indice: il legacy non la garantiva) |
| `name`, `shortName` | stringhe | colonne 3 e 4 |
| `priceKg`, `price`, `unitWeight` | numero (Int32 se intero, Double altrimenti) o `null` | colonne 5, 6, 7; mai negativi né `NaN` (il legacy poteva scrivere `NaN`: la lettura lo mostra come `null`) |
| `numPieces` | numero intero o `null` | colonna 8 |
| `description` | stringa | colonna 9 |
| `barcodes` | array di `{ barcode: stringa, quantity: intero \| null }` | colonne 10–29, fino a dieci coppie; `barcode` è `^[0-9]{8,14}$` |

Indici creati all'avvio (non univoci, la collection è del legacy): `name_1`, `code_1`. Le letture sono pagine con limite 100 e proiezione.

Dal passo C7 il listino è anche **la sorgente della sincronizzazione dei tabacchi** (`doc/API.md`, "Catalogo: sincronizzazione dei tabacchi"): una lettura sola, in ordine di `_id`, dei campi `code`, `name`, `category`, `price`, `description` e `barcodes`, con ogni valore trattato come dato esterno (tipo e lunghezza controllati); la data dell'ultima importazione è il tempo di creazione dell'`_id` più recente.

## countries — paesi e province (database common, collection legacy condivisa)
Passo 9-ter. Letta da tutti (select del backoffice, POS), scritta dal solo PSA. Il POS scarica l'intero elenco e cerca per `code`: la forma è quella del legacy.

| Campo | Tipo | Note |
|---|---|---|
| `_id` | ObjectId | |
| `code` | string | 2 lettere maiuscole, **mai modificabile**; univoco (vedi sotto) |
| `name` | string | 1–100 caratteri (nei dati esistenti fino a 32) |
| `areas` | array di `{ code, name }` | province; `code` 2 lettere maiuscole, mai modificabile, univoco nel paese; solo l'Italia ne ha (110 in development); un `areas` che non è un elenco (`null`, `'none'`) si legge come vuoto e al primo inserimento diventa un elenco |
| `insertDate` | Date | alla creazione dal nuovo backend; i documenti di development non l'hanno |
| `updateDate` | Date \| null | `null` alla creazione, poi la data dell'ultima scrittura |

Campi posseduti (`COUNTRIES_OWNED_FIELDS`): `code`, `name`, `areas`, `insertDate`, `updateDate`; ogni altra chiave di un paese o di una provincia è del legacy e non si tocca mai. Scritture: inserimento di un documento intero (`areas: []`), `$set` di `name` e `updateDate`, `$push` / `$pull` / `$set` posizionale (`arrayFilters`) su `areas`, `deleteOne`. L'inserimento di una provincia è **un solo update atomico** condizionato dall'assenza di quel `code` tra le province: l'elenco non si legge e riscrive mai. **Indici:** nessuno. L'unicità del `code` di paese è garantita dalle scritture (controllo prima e dopo l'inserimento); l'indice univoco aspetta il conteggio dei duplicati in produzione, non ancora fatto (in development nessun duplicato su 240 paesi). Un paese o una provincia **in uso** (`countryCode`, e `countryAreaCode`, di una azienda o di un punto vendita nelle copie del common, cestinati compresi) non si elimina; i contatti dei gruppi non si controllano.

## documents — coda di invio del legacy (database esterno `<prefisso><env>_queue`, sola lettura)
Passo 9-ter/3. Non è un database di Flood Cloud: è la **coda delle fatture e note di credito elettroniche** del legacy (`ms-documents-service`, `ms-sales-service` e `CronEngine`, che è l'unico a inviare). Sta sul cluster del database common (`APP_ENV` e `DB_NAME_PREFIX` come gli altri, nome costruito solo da `src/db/names.ts`), collection `documents`, registrata `legacy-read`. Il backend la legge **solo** dal repository dei documenti in errore, attraverso `Databases.queue()` (connessione di analisi, sola lettura: nessun metodo di scrittura, nessuna aggregazione `$out`/`$merge`); **non scrive nulla e non crea nessun indice** (oggi esiste solo `_id`; in produzione non è stata profilata, per questo ogni query ha `maxTimeMS`, un limite e il cursore su `_id`). Un database o una collection assenti si leggono come vuoti.

Un documento in coda è una **copia intera** del documento fiscale del gruppo più `groupId` e `dealerId`. Campi che il backend legge (proiezione fissa, ogni valore trattato come dato legacy non fidato: il tipo sbagliato diventa `null`):

| Campo | Tipo atteso | Uso |
|---|---|---|
| `_id` | ObjectId | ordine e cursore (un `_id` di altro tipo non si elenca) |
| `groupId` | ObjectId | perimetro (mai `dealerId`) e nome del gruppo |
| `type` | `invoice` \| `credit-note` | tipo documento e filtro |
| `number`, `prefixSuffix`, `company.invoicesPS` | numero o stringa; `prefix` \| `suffix` | numero mostrato |
| `date`, `total` | Date, numero | data e importo |
| `customerType`, `counterpart.name`, `counterpart.surname`, `counterpart.companyName` | 1 \| 2, stringhe | nome del cliente (mai gli altri dati della controparte) |
| `fattura_elettronica.tipo`, `company.name` | stringhe | tipo FE e azienda |
| `sendStatus`, `error` (`errorCode`, `errorDescription`) | stringa; oggetto | condizione di elenco, stato e dettaglio dell'errore |

Non si leggono mai `XML`, `hubId`, `sent`, `dealerId` né gli altri dati della controparte. Condizione di elenco (quella del legacy): `error` presente e non nullo, oppure `sendStatus` in `processingError`, `rejected`, `notDelivered`, `deliveryImpossible`, `refused`, `effectiveDate`.

## contacts — contatti del gruppo (database del gruppo, collection legacy condivisa, passo K1)

Clienti, fornitori e contatti generici (né l'uno né l'altro): una sola collection per gruppo, condivisa da tutti i punti vendita. Collection `legacy-write` (`CONTACTS_OWNED_FIELDS`): le crea, modifica, cestina ed elimina `/v1/groups/{groupId}/contacts`; il POS e il vecchio backoffice la scrivono ancora. **Nessun indice nuovo** (il legacy ha indici univoci parziali su `account.email` e `account.telephone`, che questo backend non crea e di cui mappa il rifiuto in `409 taken`). Nomi API in inglese (`doc/API.md`); il documento resta nella forma legacy. Una scrittura imposta `$set`/`$unset` dei soli campi posseduti, mai l'array `fidelities`.

| API | Documento | Note |
|---|---|---|
| `id` | `_id` | |
| `code` | `contactCode` | testo, `''` se vuoto |
| `customer`, `supplier` | `customer`, `supplier` | booleani; entrambi falsi: "Generico" |
| `contactGroupId` | `cGroupId` | `ObjectId` o `null`; in lettura anche testo esadecimale (`''` ⇒ `null`) |
| `priceListId` | `listId` | id di un listino di `groups.priceLists` o `null` |
| `notes` | `note` | testo o `null` |
| `person.firstName`, `person.lastName` | `name`, `surname` | `''` se vuoti; testo cifrato del legacy (`<hex>$<hex>`) mostrato come `''`, mai decifrato |
| `person.taxCode` | `code` | codice fiscale, maiuscolo |
| `person.birthDate` | `birthDate` | `Date` a mezzanotte UTC o `null`; in lettura anche testo ISO |
| `person.address.street`, `.postcode`, `.city`, `.countryCode`, `.areaCode` | `address`, `postcode`, `city`, `countryCode`, `countryAreaCode` | paese di `common.countries`, provincia tra le sue aree |
| `person.phones[]`, `person.emails[]` | `telephone[]`, `email[]` | al più 10 ciascuno |
| `person.discountPercent` | `discount` | `Double` 0–100 o `null` |
| `person.associatedCompanyId` | `associatedCompanyId` | `ObjectId` (o testo in lettura) di un contatto con `companyName` o `null`; la copia `associatedCompany` che il POS salva **non si legge né si scrive** |
| `company.name` | `companyName` | |
| `company.vatNumber`, `company.taxCode` | `companyCode`, `companyCode2` | P.IVA e codice fiscale, maiuscoli |
| `company.address.*` | `companyAddress`, `companyPostcode`, `companyCity`, `companyCountryCode`, `companyCountryAreaCode` | come sopra |
| `company.phones[]`, `.emails[]`, `.faxes[]` | `companyTelephone[]`, `companyEmail[]`, `companyFax[]` | |
| `company.discountPercent` | `companyDiscount` | |
| `company.supplierPriceLists[]` `{ id, name, favorite }` | `companyLists[]` `{ id, name, favorite }` | gli `id` sono quelli che `products.suppliers[].companyLists[].id` cita; mappa fornitore ↔ prodotto in "products" |
| `eInvoicing.transmissionFormat` | `fattura_elettronica.formato_trasmissione` | `FPR12` o `FPA12` |
| `eInvoicing.channel` | `fattura_elettronica.identificativo` | `CD` o `PEC` |
| `eInvoicing.recipientCode`, `.pec` | `fattura_elettronica.codice_destinatario`, `.pec` | `''` per nessuno |
| `eInvoicing.paymentTerms`, `.paymentMethod`, `.taxRegime` | `fattura_elettronica.condizioni_pagamento`, `.modalita_pagamento`, `.regime_fiscale` | `TP01`–`TP03`, `MP01`–`MP23`, `RF01`, `RF02`, `RF04`–`RF19`; `''` per nessuno |
| `eInvoicing.administrationReference` | `fattura_elettronica.riferimento_amministrazione` | |
| `eInvoicing.splitPayment`, `.requirePurchaseOrderData` | `fattura_elettronica.split_payment`, `.richiedi_dati_ordine_acquisto` | booleani |
| `fidelityCards[]` `{ code, points }` | `fidelities[]` `{ code, points }` | `code` si scrive solo aggiungendo un elemento con zero punti o togliendolo per codice (un solo `updateOne` a pipeline che riparte dagli elementi del server, mai dall'array del client); `points` lo muovono le vendite e le rettifiche (`$inc` su `fidelities.$[carta].points`), mai una scrittura del contatto | In lettura ogni elemento ha anche `advanced` (la carta di `fidelity_cards` con quel codice, vedi sotto), mai scritto. **Nessuna unicità del codice tra contatti** (più contatti possono avere la stessa carta).
| `services[]` `{ productId, duration }` | `services[]` `{ id, time }` | `id` `ObjectId` di un prodotto `type: service`, `time` `HH:mm` |
| `account.email`, `account.phone` | `account.email`, `account.telephone` | **nessuna chiave** quando vuoti (gli indici univoci parziali del legacy rifiutano un valore vuoto ripetuto); `account.password` e `account.tokens` sono morti e **mai** letti né scritti |
| `trashed`, `trashedAt` | `trash`, `trashDate` | |
| `createdAt`, `updatedAt` | `insertDate`, `updateDate` | il POS scarica per `updateDate` |
| `displayName` (calcolato) | `companyName`, altrimenti `name` e `surname` | la regola di `lookup/customers` |

Mai letti né scritti: `account.password`, `account.tokens`, `cGroup`, `associatedCompany` (copie spurie che il POS salva dentro il contatto) e ogni chiave sconosciuta (restano come sono). Un contatto nuovo ha tutte le chiavi sopra (liste vuote, `fattura_elettronica` completa con `FPR12`/`CD`, `fidelities: []`, `services: []`, `trash: false`, `insertDate` e `updateDate`), senza `account`. Versione (`ETag`): HMAC dei campi posseduti con `fidelities` ridotto ai soli codici (il saldo non cambia la versione). Eliminazione definitiva: riferimenti controllati nelle collection elencate in "Collection dei database di gruppo lette dal nuovo backend".

## fidelity_cards — carte fedeltà avanzate (database del gruppo, collection legacy condivisa, passo F1)

Collection `legacy-write` (`FIDELITY_CARDS_OWNED_FIELDS`), nessun cestino. **Indice univoco `{ code: 1 }` (`code_1`, `unique`)**: è la definizione del legacy (`ms-fidelity-service`) e il nuovo backend la crea identica, così `createIndex` è idempotente: alla creazione del gruppo (onboarding, dopo il commit) e, se manca, prima della prima carta scritta (una volta per gruppo e processo; con doppioni esistenti non si crea, errore nel log senza i codici). Un `E11000` su `code` è `409 taken`. Il legame con il contatto è **il codice** in `contacts.fidelities[].code` (nessun `customerId`). Un codice di un contatto è "avanzato" se esiste qui.

| API | Documento | Note |
|---|---|---|
| `id` | `_id` | |
| `code` | `code` | scritto solo alla creazione, mai cambiato |
| `cardTypeId` | `cardTypeId` | id di `groups.fidelity.cardsTypes[]`; `cardType` si calcola dal catalogo |
| `enabled` | `status` | booleano |
| `balance` | `balance` | `Double`, **mai** scritto con `$set` (creazione a parte): solo con l'aggiornamento a pipeline `$round($add)` delle rettifiche (2 decimali) o con le vendite |
| `points[]` | `pointsCollections.<idRaccolta>` | numeri; solo `$inc` (la creazione scrive i punti iniziali); le chiavi che non sono raccolte del gruppo restano |
| `totalPoints` | calcolato | somma delle raccolte attive |
| `contacts`, `contactsCount` | calcolati | contatti non cestinati con il codice in `fidelities[].code` |
| `createdAt`, `updatedAt` | `insertDate`, `updateDate` | `updateDate` cambia solo con `cardTypeId` e `status` |

Versione (`ETag`): `code`, `cardTypeId`, `status`. Chiavi sconosciute del legacy: conservate, mai lette.

## fidelity_cards_movements — storia delle carte avanzate (database del gruppo, collection legacy condivisa, passo F1)

Collection `legacy-write` (`FIDELITY_CARDS_MOVEMENTS_OWNED_FIELDS`) in **sola inserzione** di movimenti `manually` (mai modificati; inseriti nella stessa transazione della carta o del `$inc` che spiegano) e, dal passo K3, di movimenti `import`: il credito e i punti iniziali di una carta **creata dal file XLSX** (`doc/API.md` "Carte fedeltà avanzate: import ed export XLSX"), uno per componente, scritti nella transazione dell'importazione con `userId` di chi importa; `balance` e `points` con segno come per `manually`. Nessun indice nuovo. Le vendite del legacy vi scrivono `sale` e `canceled_sale`: si leggono, non si scrivono.

| API | Documento | Note |
|---|---|---|
| `id` | `_id` | |
| `date` | `date` | `Date` |
| `type` | `type` | testo (`manually` per le rettifiche e i valori iniziali della creazione dal backoffice, `import` per i valori iniziali di una carta creata dal file XLSX; `sale` e `canceled_sale` sono del legacy) |
| `balance` | `balance` | credito mosso, con segno (`0` se solo punti) |
| `points` | `points` | punti mossi, con segno (`0` se solo credito) |
| `collection` | `pointsCollectionId` | id testo di una raccolta o `null` |
| `operator` | `userId` | `ObjectId` dell'utente che ha scritto, risolto nel solo nome visualizzato; `null` per un movimento creato da una **chiave API pubblica** (passo K4) |
| (non esposto come id nell'API pubblica) | `apiKeyId` | `ObjectId` della chiave API pubblica che ha scritto il movimento (passo K4, solo con `userId` `null`); il nome si legge da `apiKeys` del common filtrato per gruppo; il legacy non lo legge né lo riscrive |
| `operator.store` (`true`, solo in `/v1`) | `storeKeyId` | `ObjectId` della chiave di negozio del server di punto vendita che ha scritto il movimento (passo K5; con `userId` = l'operatore dichiarato in `X-Operator-Id`): il backoffice può mostrarlo come fatto dalla cassa; non esposto nell'API pubblica; il legacy non lo legge né lo riscrive |
| (non esposto) | `cardId`, `cardCode` | i movimenti si cercano per l'uno **o** l'altro |

## contacts_groups — gruppi di contatti (database del gruppo, collection legacy condivisa, passo K1)

Collection `legacy-write` (`CONTACTS_GROUPS_OWNED_FIELDS`): nessun cestino, nessun indice nuovo.

| API | Documento | Note |
|---|---|---|
| `id` | `_id` | |
| `name` | `name` | 1–100, non unico |
| `priceListId` | `priceListId` | id di un listino attivo del gruppo o `null` |
| `discountPercent` | `discountPercentage` | `Double` 0–100 o `null` |
| `contactsCount` (solo dettaglio) | calcolato | `contacts` con `cGroupId` uguale (`ObjectId` o testo), non cestinati, fino a 10.000 |
| `createdAt`, `updatedAt` | `insertDate`, `updateDate` | |

Eliminazione: rifiutata con `409` se un contatto (anche cestinato) ha `cGroupId` uguale o una promozione cita il gruppo in `conditions.contactsGroupsIds`.

## Collection dei database di gruppo lette dal nuovo backend
Sola lettura (`legacy-read`), solo con un accesso verificato al gruppo e sul cluster del gruppo:
| Collection | Perché | Campi usati |
|---|---|---|
| `products` | esistenza degli id di preferiti e promozioni; servizi del gruppo e verifica di `serviceIds`; letture compatte `lookup/products`; controllo dei riferimenti prima di eliminare un reparto, una marca o un attributo (passo C1: al massimo 20 prodotti, solo `_id`, `trash` diverso da `true`); dal passo C3 collection `legacy-write` (`PRODUCTS_OWNED_FIELDS`, sezione `products`) | `_id`, `trash`, `type` (`product`, `service`, `exempt`, `tobaccos`, `games`, `monopoly`), `name` (oggetto per lingua), `brandId` (ObjectId), `attributes` (array di id di attributi), `prices[].taxData.department` (numero del reparto dell'aliquota) |
| `products_categories` | esistenza delle categorie nei cataloghi del gruppo; lettura compatta `lookup/product-categories`; dal passo C2 collection `legacy-write` gestita da `/product-categories` (vedi la sua sezione) | `_id`, `trash`, `name` (oggetto per lingua) |
| `contacts` | esistenza dei clienti nelle promozioni; letture compatte `lookup/customers` e `lookup/suppliers` (solo `_id`, `trash`, `customer`, `supplier`, `companyName`, `name`, `surname`, `companyLists`: mai email, telefoni, indirizzi); dal passo K1 collection `legacy-write` gestita da `/contacts` (vedi la sua sezione); `contactAssociations` per l'eliminazione di un altro contatto (solo `_id`, filtro su `associatedCompanyId`) | tutti i campi di `CONTACTS_OWNED_FIELDS` per il dettaglio, `_id` per i controlli |
| `contacts_groups` | esistenza dei gruppi di contatti nelle promozioni; lettura compatta `lookup/contact-groups`; dal passo K1 collection `legacy-write` gestita da `/contact-groups` (vedi la sua sezione) | `_id`, `name`, `priceListId`, `discountPercentage`, `insertDate`, `updateDate` (nessun flag di cestino) |
| `fidelity_cards`, `fidelity_cards_movements` | dal passo F1 `legacy-write` (sezioni qui sopra); lette anche dai contatti (`advanced` di `fidelityCards[]`, la rettifica dei punti del contatto) e per rifiutare l'eliminazione di un tipo di carta o di una raccolta punti in uso | `code`, `cardTypeId`, `status`, `balance`, `pointsCollections` |
| `documents`, `calendar`, `table_reservation`, `warehouse` | **sola lettura**, solo per rifiutare l'eliminazione definitiva di un contatto che citano (passo K1): una ricerca per id alla volta, `limit` 20, `maxTimeMS` 5 s (`503` oltre: l'eliminazione non procede). Nessun indice creato né scrittura. `documents` del gruppo è un'altra collection di quella della coda di invio (database `queue`, stesso nome) |
| `sales` | **sola lettura** (nessuna scrittura né cancellazione). Dal passo K1 per rifiutare l'eliminazione definitiva di un contatto (`customer._id`, `appointment.customerId`); dal passo V1 anche dal modulo `sales` (sezione sotto: elenco, riepilogo e dettaglio, con `sales:read` e il perimetro del ruolo). **Un solo indice creato dal nuovo backend**: `{ customer._id: 1, date: -1 }` (sezione sotto) | `_id`; filtri su `sales.customer._id` e `sales.appointment.customerId`, `documents.counterpart._id`, `calendar.customerId`, `table_reservation.customerId`, `warehouse.supplierId` (ogni id come `ObjectId` **e** come testo esadecimale) |
| `products` (passo K1) | il controllo dei riferimenti di un contatto: `suppliers[].id`, `lastAveragePrice.lastSupplierId` (anche prodotti cestinati) e i listini fornitore citati `suppliers[].companyLists[].id` (solo non cestinati); i servizi di un contatto (`type: service`) | `_id`, `type`, `trash`, `suppliers.id`, `suppliers.companyLists.id`, `lastAveragePrice.lastSupplierId` |

## sales — vendite del punto vendita (database del gruppo, passo V1)
Collection del **legacy** (`legacy-read`): il documento lo ricostruisce il server legacy alla sincronizzazione del POS (`ms-sales-service`, `insertOne`); il nuovo backend lo **legge soltanto**, sempre filtrato dal perimetro del ruolo (CA: `companyId` nelle proprie aziende; PA: `placeId` nei propri punti vendita), con proiezioni fisse, `maxTimeMS` 5 s (`503` oltre) e un limite a ogni lettura. Gli importi sono in **unità di valuta** (numeri a virgola mobile, nessun campo valuta: la valuta è una per gruppo), `date` è un istante UTC. Una lettura è **tollerante**: un campo mancante o di tipo sbagliato (compreso un `NaN`) vale `null`, `0` o `[]`.

| Campo letto | Uso |
|---|---|
| `_id`, `date` | id e istante della vendita; ordine dell'elenco (`date` e `_id` decrescenti) e filtro del periodo; senza una `date` valida la vendita non si legge mai |
| `receiptType` | `receipt`, `invoice`, `charge`; `partitioned` (conto madre di un tavolo diviso) è **sempre escluso** da elenco, riepilogo e dettaglio |
| `sType` | vendita non fiscale ("Preventivo"): è fiscale solo con `false`, `null` o campo assente, ogni altro valore (anche `"true"`, `1`) è non fiscale; esclusa di default da elenco, riepilogo e dettaglio (`nonFiscal=exclude`) |
| `fiscalState` | `''`/assente, `canceled` (esclusa dal riepilogo), `refunded` (anche un reso parziale) |
| `refund[]` | `fiscalReceiptInfo.reportNumber/number/date/amount` del reso, `returnedGoodsValue.priceTaxed` (importo reso, sottratto dal riepilogo) |
| `status` | `invoiced` = scontrino incluso in una fattura differita (TD24) |
| `fiscalReceiptInfo` | `reportNumber`, `number` (numero della vendita), `date`, `amount` |
| `unpaid`, `finalTotalCheckout`, `finalTotalTaxable`, `finalTotalTax` | importo non pagato e totali (`finalTotalCheckout` è il totale della vendita) |
| `cashAmount`, `electronicAmount`, `chequeAmount`, `ticketsAmount`, `paymentDiscountAmount` | pagamenti (`paymentDiscountAmount` = credito fidelity) |
| `adjustmentType`, `discountPercentage`, `discountValue` | sconto o maggiorazione sul totale |
| `companyId`, `placeId` | perimetro e filtri; `ObjectId` (confrontati anche come testo, dati vecchi) |
| `userId` | l'operatore: il nome si legge dagli utenti del gruppo (`common.users`, `groupId` della vendita, una lettura per pagina) |
| `device.settings.name`, `table.originalTable.name` | cassa e tavolo (solo i nomi) |
| `customer._id` | il cliente (filtro `contactId` e indice, `ObjectId` e testo); `customer.companyName/name/surname`: **copia** del contatto, solo per il nome visualizzato (i testi nel formato cifrato del legacy non si mostrano) |
| `products[]` | righe del dettaglio: `_id`, `code`, `name` (oggetto per lingua), `qt`, `price.taxed`, `price.discount`, `selectedVariants.{plus,minus,info}[].name/qt` |
| `fidelityCard.code`, `savedCheckoutsNote` | carta fedeltà e nota del dettaglio |

**Mai letti:** `lotteryId`, `delivery`, `reservation`, `hotel`, `posTerminalId`, `tickets`, `appointment`, `customer.*` oltre al nome, `device.companyData/placeData`, e le forme dismesse (`paymentType`, `cashAmountValue`, `XML`, `returnedGoods`). Nessun campo si scrive.

**Indici.** Il legacy crea (a ogni vendita sincronizzata) `timestampId`, `companyId`, `placeId`, `date`, `{ sType, date }`, un composto multikey e `{ receiptType, sType, date: -1 }`; **nessuno su `customer._id`**. Il nuovo backend crea l'indice **`{ customer._id: 1, date: -1 }`** (nome `customer._id_1_date_-1`, non univoco) **a runtime** alla prima lettura con `contactId` di un gruppo (una volta per gruppo e per processo, senza far attendere la richiesta; `IndexBuildAlreadyInProgress` e gli indici equivalenti già presenti sono `info` nel log, ogni altro errore è `error` con il gruppo e mai dati) e alla creazione del cliente (onboarding, come l'indice delle carte). È la prima eccezione, decisa dall'utente, alla regola "nessun indice sulle collection delle vendite del legacy".

**Difetti noti del legacy.** Le vendite con un cliente creato al volo al POS restano senza `customer._id` (non compaiono tra gli acquisti di un cliente: per la migrazione serve una decisione, fuori dal passo V1). Uno scontrino incluso in una fattura differita (TD24) può contare due volte nei totali.

## settings — impostazioni della piattaforma (database common)
Un documento per chiave, collection nuova (la scrive solo il PSA tramite il backoffice): `{ key, value, updatedAt, updatedBy }`, indice univoco su `key`.
- `PRICE_LIST`: il listino delle attivazioni (vedi `doc/API.md`).
- `SECURITY_POLICY`: la politica di sicurezza, `value` = `{ nonBrowserRequests?: 'report' | 'block', sustainedLimits?: 'report' | 'enforce' }`. **Ogni campo è presente solo dopo che il PSA lo ha salvato**: un campo assente (o con un valore non valido, ignorato) vale il predefinito del server, cioè `report` per `nonBrowserRequests` e, per `sustainedLimits`, `RATE_LIMIT_API_SUSTAINED_MODE` (`report` se la variabile manca); un valore salvato prevale sempre sulla variabile. Un documento assente vale tutti i predefiniti. Con `SECURITY_POLICY_FORCE_REPORT=on` il valore salvato non ha effetto (la politica in vigore è `report`, fonte `forced`). Mai altri campi (le soglie restano nelle variabili d'ambiente). Le istanze del server tengono una copia in memoria di 30 secondi.

## Domande aperte
1. `groups.dealerId`: nel legacy riferisce l'`_id` dell'utente `D` (D-09, anagrafica nella collection `dealers`, con lo stesso `_id`). Aperto: se un dealer possa avere più utenti.
2. Migrazione di `companies` e `places`: risolta con le copie nel common (D-01, D-20), scritte dal legacy e riallineate da `sync:copies`; la dismissione delle copie nei database dei gruppi è la fase 3 (`doc/Tasks.md` 5.7).
3. Univocità: `username` globale (D-15). `vatNumber` delle aziende (`companies.code`): controllata dal servizio di scrittura tra le aziende non cestinate del gruppo (`409`), indice non univoco; i 6 doppioni esistenti restano (decisione del 2026-11-13, area 6).
