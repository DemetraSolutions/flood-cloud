/**
 * The settings blocks of a place (`doc/Tasks.md` area 7, step 7B): for every key the backend owns below the blocks the old backoffice saves (`PD.prepareData` of `views/places/detail`), its
 * path in the domain representation, its path in the stored document and its kind. It is data only: the codecs, the schemas and the allowlist of the write service are built from it. Every key is
 * written on its own dotted path, never as the whole block, so the keys other writers add (the POS, the legacy, a later release) survive.
 */

/** The values of a settings key that is a whole list or map written in one piece. */
export type WholeName =
  | 'workshiftNames'
  | 'tipValues'
  | 'tableGroups'
  | 'timeBlocks'
  | 'paymentTypes'
  | 'shippingCosts'
  | 'minAmount'
  | 'priceListsConfig'
  | 'kioskCategories'
  | 'languageTexts'
  | 'tshCategoriesMap'
  | 'tshCategories';

/** How the value of a settings key is read, validated and written. */
export type SettingKind =
  /** A switch: `true` or `false`. */
  | { readonly t: 'flag' }
  /** A text, `null` when empty (`value || null`); `pattern` is the form it must have (checked where the value changes). */
  | { readonly t: 'text'; readonly max: number; readonly pattern?: RegExp }
  /** A text that is `''` when empty, in the domain too (the media names, the address of the Connector); `url` is a web address (always checked), `pattern` the form it must have (checked where the value changes). */
  | { readonly t: 'plain'; readonly max: number; readonly url?: true; readonly pattern?: RegExp }
  /** A credential: write-only (never read back), `null` clears it, an absent key keeps it. `pattern` is the form the provider gives it. */
  | { readonly t: 'secret'; readonly max: number; readonly pattern?: RegExp }
  /** Whether a credential is set: read-only, at the stored path of the credential. */
  | { readonly t: 'secretFlag' }
  /** One of a closed list; `def` is the value of the form when it is empty (`null` for none). */
  | { readonly t: 'enum'; readonly values: readonly string[]; readonly def: string | null }
  /** A font size `R-C` with R and C from 1 to 3. */
  | { readonly t: 'font'; readonly def: string }
  /** A color `#rrggbb`. */
  | { readonly t: 'color'; readonly def: string }
  /** A time of day `HH:mm`, `null` for none. */
  | { readonly t: 'time' }
  /** A whole number (an Int32); `def` is the value of an empty field (`null`: none). */
  | { readonly t: 'int'; readonly def: number | null; readonly min: number; readonly max: number }
  /** A number (an Int32 when it is whole, a Double otherwise), `null` for none. */
  | { readonly t: 'num'; readonly min: number; readonly max: number }
  /** The id of a document of the group (an `ObjectId`), `null` for none. */
  | { readonly t: 'id' }
  /** A text id of the group (a price list, a category), `null` in the domain for none and `empty` in the document (`''` where the form writes `''`, `null` where it writes `|| null`). */
  | { readonly t: 'ref'; readonly empty: '' | null }
  /** An image of the Media Manager: the descriptor of an image of the group, or `null`. */
  | { readonly t: 'logo' }
  | { readonly t: 'whole'; readonly name: WholeName };

/** One settings key. */
export interface SettingField {
  /** Dotted path in the domain representation (`cashSettings.fastLogin`). */
  readonly domain: string;
  /** Dotted path in the stored document (`general.fastLogin`). */
  readonly legacy: string;
  readonly kind: SettingKind;
  /** The switch is the dealers' (a PSA or a dealer): any other role gets `notAllowed` where it changes. */
  readonly reserved?: true;
  /** Read only: a request may send it back, it is never written. */
  readonly readOnly?: true;
  /** A key of an integration that receives payments (Stripe, Dojo, Satispay, Qodeup): only a PSA or a dealer sets, changes or clears it (`notAllowed`); a request that leaves it out is fine. */
  readonly payment?: true;
}

const FLAG: SettingKind = { t: 'flag' };
const TEXT: SettingKind = { t: 'text', max: 200 };
const TIME: SettingKind = { t: 'time' };
const ID: SettingKind = { t: 'id' };
const NUM: SettingKind = { t: 'num', min: 0, max: 1_000_000_000 };
/** A whole number or `null` (`parseInt(value) || null`). */
const INT: SettingKind = { t: 'int', def: null, min: 0, max: 2_147_483_647 };
const intDef = (def: number, max = 2_147_483_647): SettingKind => ({ t: 'int', def, min: 1, max });
const enumOf = (values: string, def: string | null): SettingKind => ({ t: 'enum', values: values.split(' '), def });
const font = (def = '1-1'): SettingKind => ({ t: 'font', def });
const color = (def: string): SettingKind => ({ t: 'color', def });
const whole = (name: WholeName): SettingKind => ({ t: 'whole', name });

type Entries = ReadonlyArray<readonly [string, SettingKind]>;
const flags = (names: string): Entries => names.split(' ').map((name) => [name, FLAG] as const);
const texts = (names: string): Entries => names.split(' ').map((name) => [name, TEXT] as const);
const fonts = (names: string, def: string): Entries => names.split(' ').map((name) => [name, font(def)] as const);

/** The keys of a block: `domainPrefix.<key>` ↔ `legacyPrefix.<key>`. */
const block = (domainPrefix: string, legacyPrefix: string, entries: Entries): SettingField[] =>
  entries.map(([key, kind]) => ({ domain: `${domainPrefix}.${key}`, legacy: `${legacyPrefix}.${key}`, kind }));

const email = (name: string, withTo: boolean): Entries => [
  [`${name}.status`, FLAG],
  ...(withTo ? ([[`${name}.to`, TEXT]] as Entries) : []),
  [`${name}.templateId`, ID],
  [`${name}.subject`, TEXT],
];

/** The keys of `general` the cash tab owns (`priceLists` belongs to the general tab), and `advancedReport.logs`. */
const CASH: SettingField[] = [
  ...block('cashSettings', 'general', [
    ...flags(
      'fastLogin urersLoginRequiredToReceipt urersLoginRequiredToReceiptOnlyDesk singleCartRow totalPriceCartRow combinesVariantsPrice logs workshift usersShifts usersShiftsPrintReceipt ' +
        'noTaxedProductsPrintReceipt onlyNoTaxedProductsPrintReceipt noTaxedProductsSummaryPrintReceipt returnedGoods checkoutContactNote productVariantsQuantity chargeDocument ' +
        'productsWeightKg discountPercentageOnlyNoDiscount resetPriceListOnSale deskBackoffice localWarehouse simpleWarehouse',
    ),
    ['workshiftNames', whole('workshiftNames')],
    ['chargeDocumentQt', intDef(1, 1000)],
    ['localWarehouseOutOfStock', enumOf('disabled enabled alert', 'disabled')],
    ['totalRounding', NUM],
    ['operatingTime', TIME],
    ['customDiscount', TEXT],
    ['receiptsCancellation', enumOf('sync notSync', null)],
  ]),
  { domain: 'cashSettings.advancedReportLogs', legacy: 'advancedReport.logs', kind: FLAG },
];

const PRINTING: SettingField[] = [
  ...block('printing.receipt', 'receipt', [
    ...flags(
      'user barcode mergedVariants seatsTop serviceTop subtotalServiceBottom noPrintPrice0Products price0ProductsBottom printReceiptCopy printDivisionNumber printPriceLists printUnpaidReceipt ' +
        'unpaidReceiptCustomerRequired note invoice noFiscalDefaultNoPrint noFiscalHeader noFiscalTaxes noFiscalTaxesTotal noFiscalRest giftReceipt serverPrint verifyClousures',
    ),
    ['subtotalFontSize', font()],
    ['invoiceQt', intDef(1, 1000)],
    ['noFiscalBottomText', TEXT],
  ]),
  ...block('printing.prebilling', 'prebilling', [
    ...flags('header printMergedVariants noPrintPrice0Products printCategoriesTotalizers printTableUser printUser'),
    ...texts('titleText bottomText'),
    ...fonts('sequentialNumberFontSize bottomTextFontSize customerDataFontSize', '1-1'),
    ['titleFontSize', font('1-2')],
  ]),
  ...block('printing.ordering', 'ordering', [
    ...fonts('printStationFontSize deviceFontSize piecesFontSize seatsFontSize customerNameFontSize callerFontSize involvedStationsFontSize productsFontSize variantsFontSize summaryProductsFontSize summaryVariantsFontSize', '1-1'),
    ...fonts('titleFontSize tableFontSize exitsFontSize categoriesGropusFontSize', '1-2'),
    ['numberFontSize', font('2-1')],
    ['productsSorting', enumOf('cart alphabetical position', 'cart')],
    ['startReturnNumber', { t: 'int', def: 0, min: 0, max: 2_147_483_647 }],
    ['endReturnNumber', { t: 'int', def: 0, min: 0, max: 2_147_483_647 }],
    ...texts(
      'tableText deskText takeAwayText deliveryText variantPlusText variantMinusText variantInfoText exitText proceedText removalText moveText additionText resendText changeOrderText ' +
        'cancellationOrderText noteText tableNoteText orderNoteText quiklyText involvedStationsText',
    ),
    ...flags(
      'titleReverse categoriesGropus noRemoval noRemovalOnDeleteTable noRemovalOnDeleteOrder device printStation priceListName mergeProductsPrint roomName total totalPc allPrices seatsNumber ' +
        'productsProceed firstExitOnExitsCut sequentialNumberTop sequentialNumberBottom roomsSequentialNumberTop roomsSequentialNumberBottom shortName shortDescription note tableNote ' +
        'printStationsInvolved tableBottom additionInfo productsSpace summaryExits move partialMoveProducts contactInfo tableUser productsBold productsCode',
    ),
  ]),
];

const PAYMENTS: SettingField[] = [
  ...block('payments', 'payments', [['defaultType', enumOf('cash electronic', 'cash')], ...flags('cheque tickets paymentDiscount')]),
  { domain: 'payments.paymentTypes', legacy: 'paymentTypes', kind: whole('paymentTypes') },
];

/** The keys of `roomsSettings` the tables tab owns: the deprecated ones (`delivery`, `deliveryAutoOrderingTime`, `deliverySendPrebillingOnSave`, `tableGroupName`) are computed, see `DEPRECATED_ROOMS_PATHS`. */
const TABLES: SettingField[] = block('tables', 'roomsSettings', [
  ...flags(
    'exits proceedNoPrint urersLoginRequiredToTableDesk urersLoginRequiredToTable tableSeats tableUserSelect tableUserSelectPin tableUserSelectEachOpening exclusiveUserTable ' +
      'waitingPaymentTableStatus prebillingRequestTableStatus sendOrderPrebilling deskCheckoutPrintersPriority checkoutTableValue0 waitingList discountTicketsDifference ' +
      'handheldReceiptRequestDelegate roomsGridHandhelds',
  ),
  ['exitsNumber', intDef(5, 1000)],
  ['halfPortionValue', INT],
  ['halfPortionVariantsValue', INT],
  ['resetDeskNumber', INT],
  ['resetRoomsNumber', INT],
  ['resetDeliveryNumber', INT],
  ['tipValues', whole('tipValues')],
  ['tableGroups', whole('tableGroups')],
]);

/** The keys of `roomsSettings` the backend writes only as copies of other keys, as the form does (they are never part of a request). */
export const DEPRECATED_ROOMS_PATHS = Object.freeze(['roomsSettings.delivery', 'roomsSettings.deliveryAutoOrderingTime', 'roomsSettings.deliverySendPrebillingOnSave', 'roomsSettings.tableGroupName'] as const);

const RESERVATIONS: SettingField[] = block('reservations', 'roomsSettings.reservation', [
  ['status', FLAG],
  ['timeBlocks', whole('timeBlocks')],
  ['step', { t: 'int', def: 900000, min: 60_000, max: 86_400_000 }],
  ['duration', { t: 'int', def: 1800000, min: 60_000, max: 86_400_000 }],
  ['suspendedToday', FLAG],
  ['untilHours', TIME],
  ['webWidget.status', FLAG],
  ['webWidget.color', color('#000000')],
  ['webWidget.brightness', enumOf('light dark auto', 'light')],
  ...email('emailNotification', true),
  ...email('email', false),
  ...email('emailConfirmedStatus', false),
  ...email('emailRefusedStatus', false),
  ...email('emailChangeStatus', false),
]);

const DELIVERY: SettingField[] = [
  ...block('delivery.takeAway', 'deliveryTakeAway', [
    ...flags('status delivery autoDeliveryCost fastTakeAway callerRequired sendPrebillingOnSave printOrderNumber createOrderNumberOnSave autoOrderStatusComplete roomsProductionCenterValue'),
    ['sendOrderOnSave', enumOf('ask never always', 'ask')],
    ['sendOrderOnSaveFast', enumOf('ask never always', 'ask')],
    ['autoOrderingTime', INT],
    ['alertMaxDeliveryInStep', INT],
    ['alertMaxTakeAwayInStep', INT],
    ['step', INT],
    ['deliveryListId', { t: 'ref', empty: '' }],
    ['takeAwayListId', { t: 'ref', empty: '' }],
    ['shippingCosts', whole('shippingCosts')],
  ]),
  ...block('delivery', 'delivery', [['step', NUM], ['maxContemporary', NUM], ['radius', NUM], ['margin', NUM], ['lat', { t: 'num', min: -1000, max: 1000 }], ['lng', { t: 'num', min: -1000, max: 1000 }], ['minAmount', whole('minAmount')]]),
];

const SELF_ORDERING: SettingField[] = block('selfOrdering', 'selfOrdering', [
  ['status', FLAG],
  ['fixedMessage', { t: 'text', max: 1000 }],
  ['additionalInfoLabel', { t: 'text', max: 1000 }],
  ['additionalInfo', { t: 'text', max: 1000 }],
  ['priceListsConfig', whole('priceListsConfig')],
]);

const KIOSK: SettingField[] = block('kiosk', 'kiosk', [
  ['listId', { t: 'ref', empty: null }],
  ['mode', enumOf('sale catalog', 'sale')],
  ['catalogLayout', enumOf('cols-4 cols-3 list', 'cols-4')],
  ['tablePlaceholder', enumOf('none optional required', 'none')],
  ['takeawayPlaceholder', enumOf('none optional required', 'none')],
  ['tablePlaceholderType', enumOf('table stand pager', 'table')],
  ['takeawayPlaceholderType', enumOf('pager', 'pager')],
  ...flags(
    'eatHere takeAway deskPay posPay hideCategories hideNotAvailableProducts hidePhotos productVariants quickAddToCart unpaidNotPrint prebillingDeskPay prebillingPosPay printOrderCheckoutDefault ' +
      'autoOrderStatusComplete paperReceipt eReceiptEmail eReceiptQr paymentsCards paymentsCash paymentsSatispay manageFidelity categoriesIcons',
  ),
  ['upsellingCategoryId', { t: 'ref', empty: null }],
  ['productsCategories', whole('kioskCategories')],
  ['backgroundColor', color('#8936F7')],
  ['textColor', color('#F8F9FA')],
  ...['titleText', 'subTitleText', 'startButtonText', 'eatHereText', 'takeAwayText'].map((name) => [name, whole('languageTexts')] as const),
  ['idleTimeAlert', INT],
  ['closeSessionTime', INT],
]);

const APPOINTMENTS: SettingField[] = block('appointments', 'appointment', [
  ...flags('staffChoice staffChoiceRequired webWidgetStatus'),
  ['step', NUM],
  ['maxContemporary', INT],
  ['maxDaily', INT],
  ['type', enumOf('single multiple', 'single')],
  ['email.templateId', ID],
  ['email.from', TEXT],
  ['email.subject', TEXT],
]);

const EXTERNAL_DISPLAY: SettingField[] = block('externalDisplay', 'externalDisplay', [...flags('tips receiptType fidelity'), ['backgroundColor', color('#8936F7')], ['textColor', color('#F8F9FA')]]);

const FIDELITY: SettingField[] = block('fidelity', 'fidelity', [['type', enumOf('advanced base', null)], ...flags('showPoints showPointsCheckout printDataOnFiscalReceipt printDataOnReceipt')]);

const TOBACCO: SettingField[] = block('tobacco', 'tgm', [...flags('status printProductsOnReceipt winningsManagement'), ['companyId', ID], ['placeId', ID]]);

/** The slots of the Media Manager of the place: the five images (a descriptor of an image of the group, or `null`). */
export const MEDIA_LOGO_SLOTS = Object.freeze(['logoLight', 'coverLight', 'logoKiosk', 'coverKiosk', 'productPlaceholderKiosk'] as const);

const MEDIA: SettingField[] = block('media', 'medias.images', [
  ...(['internalFileNameLogo', 'externalUrlLogo', 'internalFileName', 'externalUrl'] as const).map((name) => [name, (name.startsWith('external') ? { t: 'plain', max: 2048, url: true } : { t: 'plain', max: 255 }) as SettingKind] as const),
  ...MEDIA_LOGO_SLOTS.map((name) => [name, { t: 'logo' } as SettingKind] as const),
]);


/** The form of the credentials the providers give (checked where the value changes): the Stripe keys have a fixed prefix, any other secret is printable text without spaces. */
const PRINTABLE = /^[\x21-\x7E]+$/;
const secretOf = (max = 512, pattern: RegExp = PRINTABLE): SettingKind => ({ t: 'secret', max, pattern });
const PUBLIC_TEXT: SettingKind = { t: 'text', max: 255 };

/** The integrations the old tab edits, in the order of the tab. The switch of each (`status`) is the dealers'. */
const INTEGRATION_ENTRIES: ReadonlyArray<readonly [string, SettingKind]> = [
  ['floodPay.status', FLAG],
  ['floodPay.stripe.publicKey', { t: 'text', max: 255, pattern: /^pk_(?:test|live)_[A-Za-z0-9]+$/ }],
  ['floodPay.stripe.privateKey', secretOf(512, /^(?:sk|rk)_(?:test|live)_[A-Za-z0-9]+$/)],
  ['floodPay.stripe.webhookPrivateKey', secretOf(512, /^whsec_[A-Za-z0-9]+$/)],
  ['floodPay.qrCodePayment.status', FLAG],
  ['floodPay.qrCodePayment.type', enumOf('static dynamic', 'static')],
  ['floodPay.qrCodePayment.rating', FLAG],
  ['floodPay.qrCodePayment.eReceipt', FLAG],
  ['floodPay.qrCodePayment.tips', FLAG],
  ['floodPay.qrCodePayment.postPaymentText', TEXT],
  ['floodPay.tapToPay.status', FLAG],
  ['floodPay.tapToPay.tips', FLAG],
  ['bizerba.status', FLAG],
  ['bizerba.importPath', { t: 'text', max: 500 }],
  ['bizerba.exportPath', { t: 'text', max: 500 }],
  ['googleMaps.status', FLAG],
  ['reserveWithGoogle.status', FLAG],
  ['reserveWithGoogle.category', enumOf('restaurant', 'restaurant')],
  ['reserveWithGoogle.name', TEXT],
  ['reserveWithGoogle.telephone', { t: 'text', max: 32, pattern: /^(?=.*\d)[0-9 +()-]+$/ }],
  ['reserveWithGoogle.url', { t: 'text', max: 2048, pattern: /^https:\/\/[^\s]+$/i }],
  ['reserveWithGoogle.geo.latitude', { t: 'num', min: -90, max: 90 }],
  ['reserveWithGoogle.geo.longitude', { t: 'num', min: -180, max: 180 }],
  ['reserveWithGoogle.geo.address.streetAddress', TEXT],
  ['reserveWithGoogle.geo.address.locality', TEXT],
  ['reserveWithGoogle.geo.address.postalCode', { t: 'text', max: 20 }],
  ['reserveWithGoogle.geo.address.country', { t: 'text', max: 2, pattern: /^[A-Z]{2}$/ }],
  ['easyappear.status', FLAG],
  ['easyappear.appToken', secretOf()],
  ['yellgo.status', FLAG],
  ['yellgo.apiKey', secretOf()],
  ['leggimenu.status', FLAG],
  ['leggimenu.apiKey', secretOf()],
  ['plateform.status', FLAG],
  ['plateform.username', secretOf(100)],
  ['plateform.password', secretOf(100)],
  ['cooperto.status', FLAG],
  ['cooperto.apiKey', secretOf()],
  ['dojo.status', FLAG],
  ['dojo.apiKey', secretOf()],
  ['satispay.status', FLAG],
  ['satispay.activationCode', secretOf(32, /^[A-Za-z0-9]+$/)],
  ['satispay.keyId', secretOf()],
  ['satispay.type', enumOf('checkin qrcode', 'checkin')],
  ['qodeup.status', FLAG],
  ['qodeup.apiKey', secretOf()],
  ['tomatoai.status', FLAG],
  ['tomatoai.apiKey', secretOf()],
  ['keenon.status', FLAG],
  ['keenon.storeId', PUBLIC_TEXT],
  ['tsh.status', FLAG],
  ['tsh.testMode', FLAG],
  ['tsh.id', secretOf()],
  ['tsh.secret', secretOf()],
  ['tsh.propertyId', PUBLIC_TEXT],
  ['tsh.serviceName', PUBLIC_TEXT],
  ['tsh.categoriesMap', whole('tshCategoriesMap')],
  ['phlex.status', FLAG],
  ['phlex.username', secretOf(100)],
  ['phlex.password', secretOf(100)],
  ['phlex.structureId', PUBLIC_TEXT],
];

/**
 * The keys of `integrations`: a credential is two keys, the write-only value (`privateKey`) and the read-only flag `privateKeySet` at the same stored path. The list the TS Hospitality
 * categories come from (`tsh.tshCategories`) is read only: it is data of the provider, which this backend does not fetch.
 */
/** The keys of the integrations that receive payments: whoever holds them is paid, so they are the dealers'. */
const PAYMENT_KEYS: ReadonlySet<string> = new Set(['floodPay.stripe.publicKey', 'floodPay.stripe.privateKey', 'floodPay.stripe.webhookPrivateKey', 'dojo.apiKey', 'satispay.activationCode', 'satispay.keyId', 'qodeup.apiKey']);

const INTEGRATIONS: SettingField[] = [
  ...INTEGRATION_ENTRIES.flatMap(([key, kind]): SettingField[] => {
    const domain = `integrations.${key}`;
    const field: SettingField = { domain, legacy: domain, kind, ...(key.endsWith('.status') ? { reserved: true as const } : {}), ...(PAYMENT_KEYS.has(key) ? { payment: true as const } : {}) };
    return kind.t === 'secret' ? [field, { domain: `${domain}Set`, legacy: domain, kind: { t: 'secretFlag' }, readOnly: true }] : [field];
  }),
  { domain: 'integrations.tsh.categories', legacy: 'integrations.tsh.tshCategories', kind: whole('tshCategories'), readOnly: true },
];

/** The dealer settings: the Sentry switch of the POS (a PSA's), the address of the server of the store and the web address of the Connector (a PSA's or a dealer's). */
const DEALER: SettingField[] = [
  { domain: 'dealerSettings.sentry', legacy: 'platform.sentry', kind: FLAG },
  { domain: 'dealerSettings.serverIp', legacy: 'server.ip', kind: { t: 'text', max: 64, pattern: /^[A-Za-z0-9.:\-[\]]+$/ } },
  { domain: 'dealerSettings.connectorAddress', legacy: 'connectorAddress', kind: { t: 'plain', max: 255, pattern: /^(?:https?:\/\/[^\s]+)?$/i } },
];

/** The domain blocks the 7B settings add to the place, in the order of the representation, with their keys. */
export const SETTING_BLOCKS: Readonly<Record<string, readonly SettingField[]>> = Object.freeze({
  cashSettings: CASH,
  printing: PRINTING,
  payments: PAYMENTS,
  tables: TABLES,
  reservations: RESERVATIONS,
  delivery: DELIVERY,
  selfOrdering: SELF_ORDERING,
  kiosk: KIOSK,
  appointments: APPOINTMENTS,
  externalDisplay: EXTERNAL_DISPLAY,
  fidelity: FIDELITY,
  tobacco: TOBACCO,
  media: MEDIA,
  integrations: INTEGRATIONS,
  dealerSettings: DEALER,
});

/** Every settings key of every block. */
export const SETTING_FIELDS: readonly SettingField[] = Object.freeze(Object.values(SETTING_BLOCKS).flat());

/** The stored paths of every settings key that is written (a credential once, its flag and the read-only keys never), plus the deprecated copies, which are owned too: `PLACES_OWNED_FIELDS` includes them. */
export const SETTING_LEGACY_PATHS: readonly string[] = Object.freeze([...new Set([...SETTING_FIELDS.filter((field) => field.readOnly !== true).map((field) => field.legacy), ...DEPRECATED_ROOMS_PATHS])]);

/** The containers of the stored document that hold settings keys (completed with defaults when missing or empty), outermost first. */
export const SETTING_CONTAINERS: readonly string[] = Object.freeze(
  [
    ...new Set(
      [...SETTING_FIELDS.map((field) => field.legacy), ...DEPRECATED_ROOMS_PATHS].flatMap((path) => {
        const parts = path.split('.');
        return parts.slice(0, -1).map((_part, index) => parts.slice(0, index + 1).join('.'));
      }),
    ),
  ].filter((container) => container !== 'roomsSettings.tableGroups'),
);
