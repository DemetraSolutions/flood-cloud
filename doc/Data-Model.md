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
Validazione `$jsonSchema`; indice univoco parziale `vatNumber_1` (solo quando è stringa). Campo **opzionale** `priceOverrides` (passo 9-ter/4): `{ plans?: { <chiavePiano>: centesimi }, services?: { <servizio>: centesimi } }`, parziale, stessi limiti del listino (al più 30 piani); assente = nessuna personalizzazione; scritto solo dal PSA (`PUT /v1/dealers/{dealerId}/price-overrides`) con un `$set` guardato dal valore letto, un insieme vuoto lo toglie (`$unset`); non compare nelle risposte dell'anagrafica. Creazione del dealer e del suo utente D nella stessa transazione; l'eliminazione definitiva dell'utente D elimina anche l'anagrafica. I dealer esistenti sono stati registrati con lo script `migrate:dealers` (ragione sociale = username) il 2026-11-06: 1 in `development`, 5 in `production`.

## userCredentials — credenziali del nuovo backend
Realizzata (passo 3A, D-03): `_id` = id dell'utente, `passwordHash` (scrypt `scrypt$N$r$p$salt$hash`, facoltativo), `legacyHashFingerprint` (SHA-256 dell'hash legacy da cui deriva, o null), `passwordChangedAt`, `failedLogins`, `lockedUntil` (blocco progressivo dal 5° fallimento: 1, 2, 4, 8, poi 15 minuti; azzerati dal reset dell'amministratore), `mustChangePassword` (password provvisoria impostata da un amministratore: va cambiata al primo accesso; passo 3B), `lastLoginAt`, `createdAt`, `updatedAt`. Validazione `$jsonSchema`; nessun indice oltre `_id`.

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

**Impostazioni (passo 7B):** tredici blocchi, ciascuno posseduto come percorsi foglia (elenco in `shared/legacy-write/place-settings.ts`): `cashSettings` ↔ `general.*` (tranne `priceLists`) e `advancedReport.logs`; `printing` ↔ `receipt`, `prebilling`, `ordering`; `payments` ↔ `payments` e `paymentTypes`; `tables` ↔ `roomsSettings.*` tranne `reservation`; `reservations` ↔ `roomsSettings.reservation.*` (anche `suspendedToday`, scritta anche dal POS: una scrittura del POS dà `412` al successivo `If-Match`); `delivery` ↔ `deliveryTakeAway` e `delivery` tranne `time`; `selfOrdering`; `kiosk`; `appointments` ↔ `appointment`; `externalDisplay`; `fidelity`; `tobacco` ↔ `tgm`; `media` ↔ `medias.images.*`. Posseduti anche, come copie calcolate, `roomsSettings.delivery`, `deliveryAutoOrderingTime`, `deliverySendPrebillingOnSave`, `tableGroupName` e `roomsSettings.tableGroups` (oggetto intero con `mergeProductsPrint`, copia di `ordering.mergeProductsPrint`). Tipi come `prepareData` (Int32 o `null` per gli interi, Int32/Double per i numeri, `''` dove il form scrive `''`, `templateId` ObjectId); le liste e le mappe si scrivono intere (le mappe per valuta e lingua fuse con le chiavi memorizzate). Le chiavi sconosciute o storiche dentro i blocchi (`ordering.fontSize`, `payments.paymentDiscountAuto`…) restano.

**Liste, integrazioni e impostazioni rivenditore (passo 7F).** `devices[]`, `printStations[]`, `productionCenter[]`, `rooms[]` (con `tables[]` e `view`) e `storages[]` sono posseduti come **array interi scritti elemento per elemento** (`shared/legacy-write/place-lists.ts`): il backend manda frammenti (id e chiavi cambiate) che il writer sovrappone all'elemento memorizzato con lo stesso id **dentro la transazione**, così restano le chiavi del POS (`devices[i].info`, `devices[i].status`, `rooms[].view.subtables` e quelle per tavolo), gli artefatti del vecchio form (`__index`, `__listName`, `__printStationsLabels`) e ogni chiave sconosciuta, e un valore invariato conserva il tipo BSON. Id: testo `createId` del vecchio backoffice (dispositivi, postazioni, centri, sale, tavoli), `ObjectId` per `storages[].id`. Forme: dispositivo (33 chiavi del form, nomi derivati `externalDisplayName`, `secondaryCompanyPrinterName`, `favoritesGroupName`, `status: { busy, userName }` creato una sola volta), postazione (`id, name, driver, host, pulseNumber, pulseNumberSecondary, upsideDown, exitsCut, summaryCategoriesIds, summaryPrintStationsIds`), centro (`id, name, capacity`), sala (`id, name, listId, service, tax, deviceId, seatsRequest, seatsRequired, autoService, priceListsRequest, handheldVisibility, printStations, tables, view { type, status, h, w }`), tavolo (`id, roomId, name, seats, userId, view { w, h, x, y, shape }`), deposito (`id, name, cash, ecommerce`). **Versione:** i dispositivi entrano nella versione solo con l'id e le chiavi possedute (il battito del POS non cambia la versione); `rooms` e `storages` per intero (il POS riscrive `rooms`: una sua scrittura dà `412`). `integrations.*` è posseduto **chiave per chiave** (16 provider; le chiavi che nessuno possiede, come `integrations.floodOrders`, `plateform.locationId` e `tsh.tshCategories`, restano e `tshCategories` si legge soltanto); le **credenziali** (Stripe `privateKey` e `webhookPrivateKey`, `appToken`, `apiKey`, `username`, `password`, `activationCode`, `keyId`, `tsh.id`/`secret`) sono scritte come testo o `null`, mai lette in memoria né restituite (solo `…Set`). `server.ip` e `connectorAddress` sono posseduti; `platform.sentry` è nelle impostazioni rivenditore. Il feed `reserve_with_google` segue le chiavi `integrations.reserveWithGoogle.*` e `companyId` (record scritto se attivo e completo e non nel cestino, altrimenti rimosso). Chiavi sconosciute o storiche (`service`, `roomsListId`, `handheldsListId`, `ordering.fontSize`…) restano e non sono restituite.

**`email_templates` (database del gruppo, `legacy-write`, passo T2):** `{ _id, name, text, html, insertDate, updateDate }`: nessun `groupId`, nessun `trash` (l'eliminazione è definitiva), nessuna copia nel common, nessun indice (il legacy non ne crea, nemmeno questo backend). Campi **posseduti** (`EMAIL_TEMPLATES_OWNED_FIELDS`): `name`, `text`, `html`, `insertDate`, `updateDate`. Il backend inserisce documenti interi (`_id` generato, le due date uguali), imposta `name`/`text`/`html`/`updateDate` con `$set` (solo se la data di aggiornamento è ancora quella letta: nessuna perdita di modifiche) ed elimina per `_id`; non scrive mai altre chiavi. `html` fino a 256 KB, `text` fino a 64 KB, `name` fino a 150 caratteri; l'HTML è memorizzato come inviato. La **versione** (`ETag`/`If-Match`) è un HMAC di `_id`, `name`, `text`, `html` e `updateDate`: una modifica del legacy a uno di essi la cambia. Gli ObjectId dei `templateId` dei punti vendita (`appointment.email.templateId`, `roomsSettings.reservation.<emailNotification|email|emailConfirmedStatus|emailRefusedStatus|emailChangeStatus>.templateId`) li verificano il salvataggio del punto vendita (`PlacesRepository.missingTemplates`) e l'eliminazione del template, che li cerca nelle **copie** dei punti vendita (`common.places`, cestinati inclusi) con una lettura fissa (`findPlacesUsingTemplate` in `group-mirror.ts`: percorsi fissi, restituisce solo `_id`, `name` e `companyId`, quest'ultimo per filtrare per perimetro; `MIRROR_FIELDS` non è stato esteso).

Scritture dal nuovo backend (passo 5.6 e 7A, servizio interno `doc/Technical-Guide.md` §7): nel database del gruppo `$set` dei soli **campi posseduti** (`PLACES_OWNED_FIELDS`): `name`, `address`, `postcode`, `city`, `countryAreaCode`, `countryCode`, `contact`, `email`, `telephone`, `companyId`, `listId`, `ecommerceListId`, `invoicePS`, `timezone`, `plan`, `status`, `trash`, `expirationDate`, `updateDate`, `trashDate` (con `trash`, passo P2) e i percorsi foglia `general.priceLists`, `platform.sentry`, `openingTime.*`, `delivery.time.*`, quelli delle impostazioni (7B), `integrations.*`, `server.ip`, `connectorAddress` e le cinque liste (`devices`, `rooms`, `storages`, `printStations`, `productionCenter`, scritte elemento per elemento, passo 7F); mai i blocchi interi né chiavi sconosciute. **Creazione** con il template completo nella forma del vecchio backoffice (`prepareData`: ogni blocco con i suoi default, `ordering.numberFontSize`, `receipt.noFiscalTaxes*`, `receipt.invoiceQt: 1`, `roomsSettings.exitsNumber: 5` con le chiavi deprecate calcolate, `kiosk.mode` `sale`, `integrations.*` senza credenziali, `platform: { sentry }`), `plan` `basic`, `timezone` `Europe/Rome`, le due settimane di sette giorni chiusi e un deposito `{ id, name, cash: true, ecommerce: false }`. **Duplicazione:** copia di tutto il documento (ogni chiave, depositi con gli stessi id, integrazioni con le credenziali) con nuovi `_id`, `insertDate`, `updateDate`, `trash: false` e il nome `<nome> (Copy)`; la chiave di negozio (passo 7C) non si copia. **Effetti collaterali** nella stessa transazione, a ogni scrittura di un punto vendita: `groups.places` ricalcolato per intero (`[{ _id, insertDate }]` di tutti i punti vendita del gruppo, cestinati inclusi, `$set`); `reserve_with_google` (common, chiave logica `(groupId, placeId)`, record `{ groupId, companyId, placeId, category, name, telephone, url, geo { latitude, longitude, address { streetAddress, locality, postalCode, country } } }`): `deleteOne` al cestino e all'eliminazione, upsert al ripristino e alla duplicazione solo se l'integrazione è attiva e completa con la regola del legacy, nulla a creazione e modifica. La concorrenza è ottimistica sulla versione dei soli campi posseduti (`_id`, campi e percorsi posseduti, `trash`, `companyId`; SHA-256 di una forma canonica): una scrittura del POS su chiavi non possedute non la cambia.

## syncIssues — discordanze tra database dei gruppi e copie
Realizzata (passo 5A), senza validatore: `_id`, `runId` (esecuzione di `sync:copies`), `detectedAt`, `kind` (`missingCopy`, `differentCopy`, `extraCopy`, `idCollision`, `invalidCopy`, `groupIdMismatch`, `orphanCompany`, `databaseWithoutGroup`, `unknownCluster`, `nonObjectId`), `collection` (`companies`, `places` o null), `groupId`, `documentId`, `repaired`. Solo id, nessun valore dei documenti né dato personale. Indici: `runId_1`, `kind_1_detectedAt_-1`, TTL `detectedAt_ttl` a 180 giorni.

## settings — impostazioni di piattaforma
Realizzata (passo 9-ter/4), collection `new` del common con validatore `$jsonSchema` (`additionalProperties: false`); **sostituisce** la `platformSettings` mai realizzata. Un documento per chiave: `{ _id, key, value, updatedAt, updatedBy }`. L'unica chiave ora è `PRICE_LIST` (il validatore ammette solo le chiavi note: una nuova chiave richiede la sua voce). Indice: `key_1` **univoco**. Solo il PSA scrive (evento `priceList.updated` nel registro attività). Senza documento vale il listino di default (i valori del legacy).

`PRICE_LIST.value` = `{ plans: { <chiavePiano>: centesimi }, services: { extraDesk, kiosk, api, tobaccos, reservationWidget, floodPay, arubaEInvoicing, reserveWithGoogle, bizerba: centesimi } }`: importi in **centesimi di euro, IVA esclusa, per punto vendita al mese**, interi da 0 a 10 000 000; la chiave di un piano rispetta `^[A-Za-z0-9_-]{1,30}$` (al più 30 piani: si può prezzare qualsiasi valore di `plan` memorizzato, es. `professional`); i nove servizi ci sono sempre tutti. Default: `basic` 2000, `advanced` 3000, `enterprice` 4000, `tgm-secondary` 0, `desk-secondary` 500; `extraDesk` 500, `kiosk` 1500, `api` 500, `tobaccos` 1300, `reservationWidget` 1000, `floodPay` 1500, gli altri 0. Non c'è storico dei prezzi: lo storico sono le chiusure (`billingClosures`), che conservano i prezzi applicati.

Oltre al listino, la collection contiene un documento di blocco per anno, chiave `BILLING_LOCK:<AAAA>` con valore `{ counter }`: congelamento e sblocco della base dei rinnovi, chiusura e riapertura di un mese lo incrementano dentro la loro transazione, così due operazioni concorrenti sullo stesso anno vanno in conflitto e una sola riesce. Non è un dato da leggere né da modificare a mano.

## billingClosures — chiusure della fatturazione per rivenditore
Realizzata (passo 9-ter/4), collection `new` del common con validatore `$jsonSchema` (`additionalProperties: false`). Un documento per chiusura e per rivenditore: `{ _id, kind, period, dealerId, dealerName, prices, activations: { lines, totals }, renewals: { lines?, totals }, closedAt, closedBy }`.
- `kind` `renewalBase` (periodo `AAAA`: il parco del rivenditore al 31 dicembre dell'anno prima, con le righe dei rinnovi) o `month` (periodo `AAAA-MM`, il **mese della fattura**: le righe delle attivazioni del mese precedente e **solo i totali** dei rinnovi, le cui righe stanno nella base dell'anno). `dealerId` è `null` per i gruppi senza rivenditore.
- `prices`: il listino **effettivo** applicato al rivenditore (listino con le sue personalizzazioni sopra), fino a 60 piani.
- Riga: `{ groupId, groupName, companyId, companyName, placeId, placeName, activatedAt, plan, items: [{ key, quantity, unitCents|null, amountCents }], monthlyCents, months, amountCents, flags }` (`flags` tra `unpricedPlan`, `activationDateFromId`, `expired`, `groupSuspended`, `companyDisabled`); al più **5000 righe** per documento (limite di 16 MB), oltre `409`. Totali delle attivazioni `{ places, monthlyCents, amountCents, projection12Cents, anomalies }`, dei rinnovi `{ places, annualCents, instalmentCents, anomalies }` (`anomalies`: i punti vendita esclusi perché l'azienda manca o è nel cestino).
- Indice: `kind_1_period_1_dealerId_1` **univoco**. Righe e importi non cambiano più dopo la scrittura; riaprire un mese o sbloccare una base cancella i documenti.

## sessions — sessioni del backoffice
Realizzata (passo 3A): un documento per famiglia di sessione. `_id` (id esposto della sessione), `userId`, `accessTokenHash` (SHA-256 del token corrente, univoco), `accessExpiresAt`, `refreshTokenHash` (corrente, univoco), `previousRefreshHashes` (ultimi 50 hash ruotati, per rilevare il riuso), `rotatedAt`, `refreshExpiresAt` (inattività), `familyExpiresAt` (durata massima), `createdAt`, `lastUsedAt`, `userAgent`, `ip`, `revokedAt`, `revokeReason`, `expiresAt` (TTL = fine famiglia + 1 giorno). Indici: `accessTokenHash_1` e `refreshTokenHash_1` univoci, `previousRefreshHashes_1`, `userId_1_revokedAt_1`, TTL `expiresAt_1`. Validazione `$jsonSchema`.

## storeActivationCodes — codici di attivazione dei server di punto vendita
Realizzata (passo 7C, D-24), collection `new` del common con validatore `$jsonSchema` (nuova, non condivisa col legacy). Un documento per codice **ancora da scambiare**, al più uno per punto vendita: `_id`, `groupId`, `companyId` (al momento della creazione, solo informativo), `placeId`, `codeHash` (SHA-256 esadecimale del codice normalizzato: mai il codice), `createdBy` (`{ userId, role: 'PSA' | 'D' }`), `createdAt`, `expiresAt` (24 ore di default). Indici: `codeHash_1` **univoco**, `placeId_1` **univoco** (la creazione è un `replaceOne` con upsert), `expiresAt_1` **TTL** (`expireAfterSeconds: 0`; il TTL è pigro, quindi la scadenza si controlla sempre anche nella query). Il documento si cancella allo scambio (`findOneAndDelete` atomico).

## storeKeys — chiavi di negozio
Realizzata (passo 7C, D-24), collection `new` del common con validatore `$jsonSchema` (`additionalProperties: false`). Un documento per chiave di un punto vendita, **al più una attiva per punto vendita**: `_id` (il `keyId` esposto), `groupId`, `placeId` (fissi per tutta la vita della chiave; **nessun `companyId`**: un punto vendita può cambiare azienda, quindi si rilegge dal punto vendita a ogni richiesta), `keyHash` (SHA-256 esadecimale di `fc_sk_…`: mai la chiave), `keyHint` (i primi 4 caratteri del corpo, per riconoscerla), `status` (`active` | `revoked`), `activatedAt`, `activatedBy` (`{ userId, role }` di chi ha generato il codice), `installation` (`{ userAgent, appVersion, platform }` dichiarati dall'app allo scambio, ripuliti e troncati a 200 caratteri, `null` se mancanti), `activationIp`, `lastSeenAt` (al più una volta al minuto), `lastSeenIp`, `lastSeenUserAgent` (IP in chiaro come per le sessioni), `revokedAt`, `revokedBy` (`{ kind: 'user', userId, role }` | `{ kind: 'system' }` | `null`), `revokeReason` (`revoked`, `replaced`, `placeTrashed`, `placeDeleted` | `null`) e, **solo sulle revocate**, `purgeAt` (`revokedAt` + 365 giorni). Indici: `keyHash_1` **univoco**; `placeId_1_active` **univoco parziale** (`partialFilterExpression: { status: 'active' }`: la regola "una sola chiave attiva" la garantisce il database); `groupId_1_placeId_1_activatedAt_-1` (storico del punto vendita); `purgeAt_1` **TTL** (le attive non hanno `purgeAt` e non scadono mai). Il documento del punto vendita non contiene nulla della chiave e la duplicazione di un punto vendita non la copia.

## apiKeys — chiavi delle API pubbliche
Realizzata (passo 9A), collection `new` del common con validatore `$jsonSchema` (`additionalProperties: false`). Un documento per chiave, **più chiavi per gruppo**, ognuna con i propri permessi, restrizioni e limiti: `_id` (il `id` esposto), `groupId`, `name` (1–100 caratteri), `prefix` (i primi 12 caratteri della chiave, `fc_pk_` e sei più, per riconoscerla), `hash` (SHA-256 esadecimale di `fc_pk_…`: **mai la chiave**), `permissions` (`places:read`, `companies:read`, `catalog:read`: il catalogo pubblico, almeno uno, senza ripetizioni), `restrictions` (`{ companyIds, placeIds }`, ciascuno un elenco di al più 100 id o `null`), `rateLimitPerMinute` (1–6000), `dailyQuota` (1–10 000 000), `expiresAt` (data o `null`), `status` (`active` | `revoked`), `revokedAt`, `revokedBy` (`{ userId, role }` | `null`), `createdAt`, `createdBy` (`{ userId, role: 'PSA' | 'D' }`), `lastUsedAt` (al più una volta al minuto). Una chiave revocata resta per lo storico: non c'è cancellazione. Indici: `hash_1` **univoco** (la ricerca di ogni richiesta), `groupId_1_createdAt_-1` (elenco e conteggio delle attive).

## idempotencyKeys — chiavi di idempotenza
Realizzata (decisione del 2026-11-13), collection `new` del common senza validatore: `{ _id, principal (id dell'utente, esadecimale), route (metodo e percorso concreto), key (UUID minuscolo), bodyHash (SHA-256 esadecimale del JSON canonico del body), state (`inProgress`/`done`), response? ({ status, body, location, etag }), createdAt, expiresAt }`. Indici: **univoco** `principal_1_route_1_key_1` e TTL `expiresAt_1` (`expireAfterSeconds: 0`); `expiresAt` è 5 minuti per una richiesta in corso e 24 ore dalla fine per una finita. Contiene le risposte delle creazioni idempotenti (aziende, punti vendita, duplicazione), già senza credenziali.

## rateLimits — contatori a finestra fissa
`_id` = `<bucket>:<SHA-256 hex della chiave>:<inizio finestra in secondi>` (username e IP mai in chiaro), `count`, `expiresAt` (fine finestra + 60 s). Indice TTL `expiresAt_1`. Realizzata (passo 2C).

## apiUsage — conteggio d'uso delle API pubbliche
Realizzata (passo 9A), collection `new` del common con validatore `$jsonSchema`: una riga per chiave, **giorno UTC** e route, scritta a blocchi (ogni 30 secondi, al raggiungimento del tetto di memoria e allo spegnimento) con `$inc` e upsert: `keyId`, `groupId`, `day` (`YYYY-MM-DD`), `route` (`<METODO> <pattern della route>`, per esempio `GET /public/v1/places/:placeId`: mai il percorso concreto), `calls` (ogni richiesta di una chiave valida, anche rifiutata), `errors4xx` (risposte `4xx` diverse da `429`), `errors5xx`, `rateLimited` (`429` per limite al minuto o quota, della chiave o del gruppo), `aborted` (richieste interrotte dal client prima della fine della risposta, contate anche in `calls`), `expireAt` (fine del giorno più 400 giorni). Indici: `keyId_1_day_1_route_1` **univoco**, `expireAt_1` **TTL**. Le richieste con una chiave sconosciuta o rifiutata non si contano. Nessuna quota mensile.

## activityEvents — registro delle attività (sostituisce `auditLog`)
Realizzata (passo 2C, decisione dell'utente del 2026-11-01; rinominata `activityEvents`, senza validatore `$jsonSchema`, la vecchia `activityLog` è abbandonata): un'unica collection per scritture sui dati, eventi di sicurezza ed errori. La collection `logs` del legacy resta intatta.
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
Validazione `$jsonSchema`. Indici: `at_-1__id_-1`, `groupId_1_at_-1__id_-1`, `actor.id_1_at_-1__id_-1`, `category_1_at_-1__id_-1` (ordinamento del monitor senza ordinamento in memoria), `requestId_1`, TTL `expiresAt_1`. Gli indici precedenti senza `_id` vengono rimossi all'avvio dopo la creazione dei nuovi.

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

## products_departments — reparti del gruppo (database del gruppo, solo inserimento)
I reparti che il POS legge senza guardia (`department.tax.value`). Collection `legacy-write` del database del gruppo (`PRODUCTS_DEPARTMENTS_OWNED_FIELDS`): in questo passo (8A) il backend **inserisce documenti interi** nella transazione che crea il gruppo, uno per aliquota; non li legge né li modifica (la loro gestione è del dominio dei prodotti). La collection non si crea prima: nasce con l'inserimento. Nessun indice, come nel legacy.

| Campo | Tipo BSON | Valore alla creazione |
|---|---|---|
| `_id` | ObjectId | nuovo |
| `groupId` | ObjectId | il gruppo nuovo (chiave **aggiuntiva**: il legacy non la scrive, e la ignora) |
| `code` | Int32 | il reparto dell'aliquota (1–99); nel legacy era `undefined` per le aliquote diverse da 4, 10 e 22 |
| `tax` | oggetto | copia dell'aliquota di `groups.taxes`: `{ id, value, department, description: null, natura: null }` (`value` Int32 se intero, Double altrimenti) |
| `name` | oggetto | `{ it: "Reparto <code>" }` |
| `description` | oggetto | `{ it: "" }` |
| `medias` | oggetto | `{ images: {} }` |
| `placesAvailability` | array | `[]` |
| `status`, `trash` | booleani | `true`, `false` |
| `insertDate`, `updateDate` | Date | istante della creazione |

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

## Collection dei database di gruppo lette dal nuovo backend
Sola lettura (`legacy-read`), solo con un accesso verificato al gruppo e sul cluster del gruppo:
| Collection | Perché | Campi usati |
|---|---|---|
| `products` | esistenza degli id di preferiti e promozioni; servizi del gruppo e verifica di `serviceIds`; letture compatte `lookup/products` | `_id`, `trash`, `type` (`product`, `service`, `exempt`, `tobaccos`, `games`, `monopoly`), `name` (oggetto per lingua) |
| `products_categories` | esistenza delle categorie nelle promozioni; lettura compatta `lookup/product-categories` | `_id`, `trash`, `name` (oggetto per lingua) |
| `contacts` | esistenza dei clienti nelle promozioni; lettura compatta `lookup/customers` | `_id`, `trash`, `customer`, `companyName`, `name`, `surname` (mai email, telefoni, indirizzi) |
| `contacts_groups` | esistenza dei gruppi di contatti nelle promozioni; lettura compatta `lookup/contact-groups` | `_id`, `name` (stringa; nessun flag di cestino) |

## Domande aperte
1. `groups.dealerId`: nel legacy riferisce l'`_id` dell'utente `D` (D-09, anagrafica nella collection `dealers`, con lo stesso `_id`). Aperto: se un dealer possa avere più utenti.
2. Migrazione di `companies` e `places`: risolta con le copie nel common (D-01, D-20), scritte dal legacy e riallineate da `sync:copies`; la dismissione delle copie nei database dei gruppi è la fase 3 (`doc/Tasks.md` 5.7).
3. Univocità: `username` globale (D-15). `vatNumber` delle aziende (`companies.code`): controllata dal servizio di scrittura tra le aziende non cestinate del gruppo (`409`), indice non univoco; i 6 doppioni esistenti restano (decisione del 2026-11-13, area 6).
