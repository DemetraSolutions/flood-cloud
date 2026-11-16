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
  | 'languageTexts';

/** How the value of a settings key is read, validated and written. */
export type SettingKind =
  /** A switch: `true` or `false`. */
  | { readonly t: 'flag' }
  /** A text, `null` when empty (`value || null`). */
  | { readonly t: 'text'; readonly max: number }
  /** A text that is `''` when empty, in the domain too (the media names). */
  | { readonly t: 'plain'; readonly max: number }
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
  ...(['internalFileNameLogo', 'externalUrlLogo', 'internalFileName', 'externalUrl'] as const).map((name) => [name, { t: 'plain', max: name.startsWith('external') ? 2048 : 255 } as SettingKind] as const),
  ...MEDIA_LOGO_SLOTS.map((name) => [name, { t: 'logo' } as SettingKind] as const),
]);

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
});

/** Every settings key of every block. */
export const SETTING_FIELDS: readonly SettingField[] = Object.freeze(Object.values(SETTING_BLOCKS).flat());

/** The stored paths of every settings key, plus the deprecated copies, which are owned too: `PLACES_OWNED_FIELDS` includes them. */
export const SETTING_LEGACY_PATHS: readonly string[] = Object.freeze([...SETTING_FIELDS.map((field) => field.legacy), ...DEPRECATED_ROOMS_PATHS]);

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
