import { FeatureName } from '../../core/groups/feature-catalog';
import { SettingsBlockName } from './place.types';

/** How a settings key is edited. */
export type FieldType =
  /** A switch. */
  | 'flag'
  /** A text, empty for none. */
  | 'text'
  /** A longer text. */
  | 'long'
  /** A text that is never `null` (the media file names and URLs). */
  | 'plain'
  /** A number, empty for none. */
  | 'number'
  /** A whole number, empty for none (or for `def`). */
  | 'int'
  /** A length of time kept in milliseconds and edited in minutes. */
  | 'duration'
  /** One of a closed list of values. */
  | 'select'
  /** A font size `R-C`. */
  | 'font'
  /** A color `#rrggbb`. */
  | 'color'
  /** A time of day `HH:mm`. */
  | 'time'
  /** A price list of the group. */
  | 'priceList'
  /** A product category of the group. */
  | 'category'
  /** An email template of the group. */
  | 'template'
  /** A company of the group. */
  | 'company'
  /** A place of the group. */
  | 'place'
  /** A credential: write-only, never returned (only whether it is set). */
  | 'secret';

/** One settings key of a tab. */
export interface FieldDef {
  /** Path of the key below its block (`receipt.user`). */
  readonly key: string;
  readonly type: FieldType;
  /** The fieldset the key is in. */
  readonly group: string;
  /** The values of a `select`. */
  readonly values?: readonly string[];
  /** A `select` whose empty choice is stored as `null`. */
  readonly nullable?: boolean;
  /** The value an empty `int` or `duration` stands for when the key cannot be `null`. */
  readonly def?: number;
  /** The feature the group must have for the key to be shown (platform administrators and dealers always see it). */
  readonly needs?: FeatureName;
  /** Dictionary key of the text of the empty choice of a `select`, when it is not the generic one. */
  readonly noneKey?: string;
  /** Only platform administrators and dealers may change the key. */
  readonly reserved?: boolean;
  /** A payment credential: only platform administrators and dealers may set or remove it (the others see whether it is set). */
  readonly privilegedOnly?: boolean;
}

/** The font sizes of a printout: rows by columns, each from 1 to 3. */
export const FONT_SIZES: readonly string[] = [1, 2, 3].flatMap((rows) =>
  [1, 2, 3].map((columns) => `${rows}-${columns}`),
);

/**
 * The scalar keys of every settings block, in the display order of the legacy backoffice: each key
 * has the group (card) it is in, the groups follow one another as in the old page, and the keys
 * inside a group keep the old order. The lists and maps (workshift names, payment types, time
 * blocks…) are not here: the tabs edit them with their own controls. The names are the keys of the
 * API, below the block. The groups are named in English; the legends and labels are in the
 * dictionary (`PLACES.G`, `PLACES.F`).
 */
export const FIELDS: Readonly<Record<SettingsBlockName, readonly FieldDef[]>> = {
  cashSettings: [
    { key: 'fastLogin', type: 'flag', group: 'GENERAL' },
    { key: 'urersLoginRequiredToReceipt', type: 'flag', group: 'GENERAL' },
    { key: 'urersLoginRequiredToReceiptOnlyDesk', type: 'flag', group: 'GENERAL' },
    { key: 'singleCartRow', type: 'flag', group: 'GENERAL' },
    { key: 'totalPriceCartRow', type: 'flag', group: 'GENERAL' },
    { key: 'combinesVariantsPrice', type: 'flag', group: 'GENERAL' },
    { key: 'logs', type: 'flag', group: 'GENERAL', needs: 'rooms' },
    { key: 'advancedReportLogs', type: 'flag', group: 'GENERAL', needs: 'rooms' },
    { key: 'workshift', type: 'flag', group: 'GENERAL' },
    { key: 'usersShifts', type: 'flag', group: 'GENERAL' },
    { key: 'usersShiftsPrintReceipt', type: 'flag', group: 'GENERAL' },
    { key: 'noTaxedProductsPrintReceipt', type: 'flag', group: 'GENERAL' },
    { key: 'onlyNoTaxedProductsPrintReceipt', type: 'flag', group: 'GENERAL' },
    { key: 'noTaxedProductsSummaryPrintReceipt', type: 'flag', group: 'GENERAL' },
    { key: 'returnedGoods', type: 'flag', group: 'GENERAL' },
    { key: 'checkoutContactNote', type: 'flag', group: 'GENERAL' },
    { key: 'productVariantsQuantity', type: 'flag', group: 'GENERAL', needs: 'productsVariants' },
    { key: 'chargeDocument', type: 'flag', group: 'GENERAL', needs: 'productsVariants' },
    { key: 'chargeDocumentQt', type: 'int', group: 'GENERAL', def: 1, needs: 'productsVariants' },
    { key: 'productsWeightKg', type: 'flag', group: 'GENERAL' },
    { key: 'discountPercentageOnlyNoDiscount', type: 'flag', group: 'GENERAL' },
    { key: 'resetPriceListOnSale', type: 'flag', group: 'GENERAL' },
    { key: 'deskBackoffice', type: 'flag', group: 'GENERAL' },
    { key: 'localWarehouse', type: 'flag', group: 'GENERAL', needs: 'warehouse' },
    { key: 'simpleWarehouse', type: 'flag', group: 'GENERAL', needs: 'warehouse' },
    {
      key: 'localWarehouseOutOfStock',
      type: 'select',
      group: 'GENERAL',
      values: ['disabled', 'enabled', 'alert'],
      needs: 'warehouse',
    },
    { key: 'totalRounding', type: 'number', group: 'GENERAL' },
    { key: 'operatingTime', type: 'time', group: 'GENERAL' },
    { key: 'customDiscount', type: 'text', group: 'GENERAL' },
    {
      key: 'receiptsCancellation',
      type: 'select',
      group: 'OTHER',
      values: ['sync', 'notSync'],
      nullable: true,
      noneKey: 'PLACES.NONE_OF.RECEIPTS_CANCELLATION',
    },
  ],
  printing: [
    { key: 'receipt.serverPrint', type: 'flag', group: 'RECEIPT_GENERAL' },
    { key: 'receipt.verifyClousures', type: 'flag', group: 'RECEIPT_GENERAL' },
    { key: 'receipt.giftReceipt', type: 'flag', group: 'RECEIPT_GENERAL' },
    { key: 'receipt.mergedVariants', type: 'flag', group: 'RECEIPT_GENERAL' },
    { key: 'receipt.seatsTop', type: 'flag', group: 'RECEIPT_GENERAL', needs: 'rooms' },
    { key: 'receipt.serviceTop', type: 'flag', group: 'RECEIPT_GENERAL', needs: 'rooms' },
    {
      key: 'receipt.subtotalServiceBottom',
      type: 'flag',
      group: 'RECEIPT_GENERAL',
      needs: 'rooms',
    },
    { key: 'receipt.user', type: 'flag', group: 'RECEIPT_GENERAL' },
    { key: 'receipt.barcode', type: 'flag', group: 'RECEIPT_GENERAL' },
    { key: 'receipt.note', type: 'flag', group: 'RECEIPT_GENERAL' },
    { key: 'receipt.noPrintPrice0Products', type: 'flag', group: 'RECEIPT_GENERAL' },
    { key: 'receipt.price0ProductsBottom', type: 'flag', group: 'RECEIPT_GENERAL' },
    { key: 'receipt.printReceiptCopy', type: 'flag', group: 'RECEIPT_GENERAL' },
    { key: 'receipt.printDivisionNumber', type: 'flag', group: 'RECEIPT_GENERAL' },
    { key: 'receipt.printPriceLists', type: 'flag', group: 'RECEIPT_GENERAL' },
    { key: 'receipt.unpaidReceiptCustomerRequired', type: 'flag', group: 'RECEIPT_UNPAID' },
    { key: 'receipt.printUnpaidReceipt', type: 'flag', group: 'RECEIPT_UNPAID' },
    { key: 'receipt.subtotalFontSize', type: 'font', group: 'RECEIPT_LAYOUT' },
    { key: 'receipt.invoice', type: 'flag', group: 'RECEIPT_COURTESY_INVOICE' },
    { key: 'receipt.invoiceQt', type: 'int', group: 'RECEIPT_COURTESY_INVOICE', def: 1 },
    { key: 'receipt.noFiscalDefaultNoPrint', type: 'flag', group: 'RECEIPT_NO_FISCAL' },
    { key: 'receipt.noFiscalHeader', type: 'flag', group: 'RECEIPT_NO_FISCAL' },
    { key: 'receipt.noFiscalTaxes', type: 'flag', group: 'RECEIPT_NO_FISCAL' },
    { key: 'receipt.noFiscalTaxesTotal', type: 'flag', group: 'RECEIPT_NO_FISCAL' },
    { key: 'receipt.noFiscalRest', type: 'flag', group: 'RECEIPT_NO_FISCAL' },
    { key: 'receipt.noFiscalBottomText', type: 'text', group: 'RECEIPT_NO_FISCAL' },
    { key: 'prebilling.header', type: 'flag', group: 'PREBILLING_GENERAL', needs: 'ordering' },
    {
      key: 'prebilling.printMergedVariants',
      type: 'flag',
      group: 'PREBILLING_GENERAL',
      needs: 'ordering',
    },
    {
      key: 'prebilling.noPrintPrice0Products',
      type: 'flag',
      group: 'PREBILLING_GENERAL',
      needs: 'ordering',
    },
    {
      key: 'prebilling.printCategoriesTotalizers',
      type: 'flag',
      group: 'PREBILLING_GENERAL',
      needs: 'ordering',
    },
    {
      key: 'prebilling.printTableUser',
      type: 'flag',
      group: 'PREBILLING_GENERAL',
      needs: 'ordering',
    },
    { key: 'prebilling.printUser', type: 'flag', group: 'PREBILLING_GENERAL', needs: 'ordering' },
    { key: 'prebilling.bottomText', type: 'text', group: 'PREBILLING_GENERAL', needs: 'ordering' },
    { key: 'prebilling.titleText', type: 'text', group: 'PREBILLING_LAYOUT', needs: 'ordering' },
    {
      key: 'prebilling.titleFontSize',
      type: 'font',
      group: 'PREBILLING_LAYOUT',
      needs: 'ordering',
    },
    {
      key: 'prebilling.sequentialNumberFontSize',
      type: 'font',
      group: 'PREBILLING_LAYOUT',
      needs: 'ordering',
    },
    {
      key: 'prebilling.bottomTextFontSize',
      type: 'font',
      group: 'PREBILLING_LAYOUT',
      needs: 'ordering',
    },
    {
      key: 'prebilling.customerDataFontSize',
      type: 'font',
      group: 'PREBILLING_LAYOUT',
      needs: 'ordering',
    },
    {
      key: 'ordering.productsSorting',
      type: 'select',
      group: 'ORDERING_GENERAL',
      values: ['cart', 'alphabetical', 'position'],
      needs: 'ordering',
    },
    {
      key: 'ordering.categoriesGropus',
      type: 'flag',
      group: 'ORDERING_GENERAL',
      needs: 'ordering',
    },
    {
      key: 'ordering.mergeProductsPrint',
      type: 'flag',
      group: 'ORDERING_GENERAL',
      needs: 'ordering',
    },
    { key: 'ordering.device', type: 'flag', group: 'ORDERING_INFO', needs: 'ordering' },
    { key: 'ordering.printStation', type: 'flag', group: 'ORDERING_INFO', needs: 'ordering' },
    { key: 'ordering.priceListName', type: 'flag', group: 'ORDERING_INFO', needs: 'ordering' },
    { key: 'ordering.roomName', type: 'flag', group: 'ORDERING_INFO', needs: 'ordering' },
    { key: 'ordering.tableUser', type: 'flag', group: 'ORDERING_INFO', needs: 'ordering' },
    { key: 'ordering.contactInfo', type: 'flag', group: 'ORDERING_INFO', needs: 'ordering' },
    { key: 'ordering.totalPc', type: 'flag', group: 'ORDERING_INFO', needs: 'ordering' },
    { key: 'ordering.seatsNumber', type: 'flag', group: 'ORDERING_INFO', needs: 'ordering' },
    { key: 'ordering.note', type: 'flag', group: 'ORDERING_INFO', needs: 'ordering' },
    { key: 'ordering.tableNote', type: 'flag', group: 'ORDERING_INFO', needs: 'ordering' },
    {
      key: 'ordering.printStationsInvolved',
      type: 'flag',
      group: 'ORDERING_INFO',
      needs: 'ordering',
    },
    { key: 'ordering.shortName', type: 'flag', group: 'ORDERING_PRODUCTS', needs: 'ordering' },
    {
      key: 'ordering.shortDescription',
      type: 'flag',
      group: 'ORDERING_PRODUCTS',
      needs: 'ordering',
    },
    { key: 'ordering.productsCode', type: 'flag', group: 'ORDERING_PRODUCTS', needs: 'ordering' },
    { key: 'ordering.productsBold', type: 'flag', group: 'ORDERING_PRODUCTS', needs: 'ordering' },
    { key: 'ordering.productsSpace', type: 'flag', group: 'ORDERING_PRODUCTS', needs: 'ordering' },
    { key: 'ordering.summaryExits', type: 'flag', group: 'ORDERING_PRODUCTS', needs: 'ordering' },
    { key: 'ordering.total', type: 'flag', group: 'ORDERING_PRICES', needs: 'ordering' },
    { key: 'ordering.allPrices', type: 'flag', group: 'ORDERING_PRICES', needs: 'ordering' },
    { key: 'ordering.noRemoval', type: 'flag', group: 'ORDERING_REMOVAL', needs: 'ordering' },
    {
      key: 'ordering.noRemovalOnDeleteTable',
      type: 'flag',
      group: 'ORDERING_REMOVAL',
      needs: 'ordering',
    },
    {
      key: 'ordering.noRemovalOnDeleteOrder',
      type: 'flag',
      group: 'ORDERING_REMOVAL',
      needs: 'ordering',
    },
    { key: 'ordering.productsProceed', type: 'flag', group: 'ORDERING_EXITS', needs: 'ordering' },
    {
      key: 'ordering.firstExitOnExitsCut',
      type: 'flag',
      group: 'ORDERING_EXITS',
      needs: 'ordering',
    },
    { key: 'ordering.move', type: 'flag', group: 'ORDERING_MOVE', needs: 'ordering' },
    {
      key: 'ordering.partialMoveProducts',
      type: 'flag',
      group: 'ORDERING_MOVE',
      needs: 'ordering',
    },
    {
      key: 'ordering.sequentialNumberTop',
      type: 'flag',
      group: 'ORDERING_SEQUENTIAL',
      needs: 'ordering',
    },
    {
      key: 'ordering.sequentialNumberBottom',
      type: 'flag',
      group: 'ORDERING_SEQUENTIAL',
      needs: 'ordering',
    },
    {
      key: 'ordering.roomsSequentialNumberTop',
      type: 'flag',
      group: 'ORDERING_SEQUENTIAL',
      needs: 'ordering',
    },
    {
      key: 'ordering.roomsSequentialNumberBottom',
      type: 'flag',
      group: 'ORDERING_SEQUENTIAL',
      needs: 'ordering',
    },
    { key: 'ordering.tableBottom', type: 'flag', group: 'ORDERING_OTHER', needs: 'ordering' },
    { key: 'ordering.additionInfo', type: 'flag', group: 'ORDERING_OTHER', needs: 'ordering' },
    { key: 'ordering.titleReverse', type: 'flag', group: 'ORDERING_OTHER', needs: 'ordering' },
    {
      key: 'ordering.titleFontSize',
      type: 'font',
      group: 'ORDERING_LAYOUT_TITLE',
      needs: 'ordering',
    },
    {
      key: 'ordering.tableFontSize',
      type: 'font',
      group: 'ORDERING_LAYOUT_TITLE',
      needs: 'ordering',
    },
    {
      key: 'ordering.numberFontSize',
      type: 'font',
      group: 'ORDERING_LAYOUT_INFO',
      needs: 'ordering',
    },
    {
      key: 'ordering.piecesFontSize',
      type: 'font',
      group: 'ORDERING_LAYOUT_INFO',
      needs: 'ordering',
    },
    {
      key: 'ordering.seatsFontSize',
      type: 'font',
      group: 'ORDERING_LAYOUT_INFO',
      needs: 'ordering',
    },
    {
      key: 'ordering.printStationFontSize',
      type: 'font',
      group: 'ORDERING_LAYOUT_INFO',
      needs: 'ordering',
    },
    {
      key: 'ordering.deviceFontSize',
      type: 'font',
      group: 'ORDERING_LAYOUT_INFO',
      needs: 'ordering',
    },
    {
      key: 'ordering.customerNameFontSize',
      type: 'font',
      group: 'ORDERING_LAYOUT_INFO',
      needs: 'ordering',
    },
    {
      key: 'ordering.callerFontSize',
      type: 'font',
      group: 'ORDERING_LAYOUT_INFO',
      needs: 'ordering',
    },
    {
      key: 'ordering.involvedStationsFontSize',
      type: 'font',
      group: 'ORDERING_LAYOUT_INFO',
      needs: 'ordering',
    },
    {
      key: 'ordering.productsFontSize',
      type: 'font',
      group: 'ORDERING_LAYOUT_BODY',
      needs: 'ordering',
    },
    {
      key: 'ordering.variantsFontSize',
      type: 'font',
      group: 'ORDERING_LAYOUT_BODY',
      needs: 'ordering',
    },
    {
      key: 'ordering.summaryProductsFontSize',
      type: 'font',
      group: 'ORDERING_LAYOUT_BODY',
      needs: 'ordering',
    },
    {
      key: 'ordering.summaryVariantsFontSize',
      type: 'font',
      group: 'ORDERING_LAYOUT_BODY',
      needs: 'ordering',
    },
    {
      key: 'ordering.exitsFontSize',
      type: 'font',
      group: 'ORDERING_LAYOUT_BODY',
      needs: 'ordering',
    },
    {
      key: 'ordering.categoriesGropusFontSize',
      type: 'font',
      group: 'ORDERING_LAYOUT_BODY',
      needs: 'ordering',
    },
    {
      key: 'ordering.startReturnNumber',
      type: 'int',
      group: 'ORDERING_HEADER_FOOTER',
      def: 0,
      needs: 'ordering',
    },
    {
      key: 'ordering.endReturnNumber',
      type: 'int',
      group: 'ORDERING_HEADER_FOOTER',
      def: 0,
      needs: 'ordering',
    },
    { key: 'ordering.tableText', type: 'text', group: 'ORDERING_TEXTS', needs: 'ordering' },
    { key: 'ordering.deskText', type: 'text', group: 'ORDERING_TEXTS', needs: 'ordering' },
    { key: 'ordering.takeAwayText', type: 'text', group: 'ORDERING_TEXTS', needs: 'ordering' },
    { key: 'ordering.deliveryText', type: 'text', group: 'ORDERING_TEXTS', needs: 'ordering' },
    { key: 'ordering.variantPlusText', type: 'text', group: 'ORDERING_TEXTS', needs: 'ordering' },
    { key: 'ordering.variantMinusText', type: 'text', group: 'ORDERING_TEXTS', needs: 'ordering' },
    { key: 'ordering.variantInfoText', type: 'text', group: 'ORDERING_TEXTS', needs: 'ordering' },
    { key: 'ordering.exitText', type: 'text', group: 'ORDERING_TEXTS', needs: 'ordering' },
    { key: 'ordering.proceedText', type: 'text', group: 'ORDERING_TEXTS', needs: 'ordering' },
    { key: 'ordering.removalText', type: 'text', group: 'ORDERING_TEXTS', needs: 'ordering' },
    { key: 'ordering.moveText', type: 'text', group: 'ORDERING_TEXTS', needs: 'ordering' },
    { key: 'ordering.additionText', type: 'text', group: 'ORDERING_TEXTS', needs: 'ordering' },
    { key: 'ordering.resendText', type: 'text', group: 'ORDERING_TEXTS', needs: 'ordering' },
    { key: 'ordering.changeOrderText', type: 'text', group: 'ORDERING_TEXTS', needs: 'ordering' },
    {
      key: 'ordering.cancellationOrderText',
      type: 'text',
      group: 'ORDERING_TEXTS',
      needs: 'ordering',
    },
    { key: 'ordering.noteText', type: 'text', group: 'ORDERING_TEXTS', needs: 'ordering' },
    { key: 'ordering.tableNoteText', type: 'text', group: 'ORDERING_TEXTS', needs: 'ordering' },
    { key: 'ordering.orderNoteText', type: 'text', group: 'ORDERING_TEXTS', needs: 'ordering' },
    { key: 'ordering.quiklyText', type: 'text', group: 'ORDERING_TEXTS', needs: 'ordering' },
    {
      key: 'ordering.involvedStationsText',
      type: 'text',
      group: 'ORDERING_TEXTS',
      needs: 'ordering',
    },
  ],
  payments: [
    { key: 'defaultType', type: 'select', group: 'DEFAULTS', values: ['cash', 'electronic'] },
    { key: 'cheque', type: 'flag', group: 'DEFAULTS' },
    { key: 'tickets', type: 'flag', group: 'DEFAULTS' },
    { key: 'paymentDiscount', type: 'flag', group: 'DEFAULTS' },
  ],
  tables: [
    { key: 'exits', type: 'flag', group: 'GENERAL' },
    { key: 'proceedNoPrint', type: 'flag', group: 'GENERAL' },
    { key: 'exitsNumber', type: 'int', group: 'GENERAL', def: 5 },
    { key: 'urersLoginRequiredToTableDesk', type: 'flag', group: 'GENERAL' },
    { key: 'urersLoginRequiredToTable', type: 'flag', group: 'GENERAL' },
    { key: 'tableSeats', type: 'flag', group: 'GENERAL' },
    { key: 'tableUserSelect', type: 'flag', group: 'GENERAL' },
    { key: 'tableUserSelectPin', type: 'flag', group: 'GENERAL' },
    { key: 'tableUserSelectEachOpening', type: 'flag', group: 'GENERAL' },
    { key: 'exclusiveUserTable', type: 'flag', group: 'GENERAL' },
    { key: 'waitingPaymentTableStatus', type: 'flag', group: 'GENERAL' },
    { key: 'prebillingRequestTableStatus', type: 'flag', group: 'GENERAL' },
    { key: 'sendOrderPrebilling', type: 'flag', group: 'GENERAL' },
    { key: 'deskCheckoutPrintersPriority', type: 'flag', group: 'GENERAL' },
    { key: 'checkoutTableValue0', type: 'flag', group: 'GENERAL' },
    { key: 'waitingList', type: 'flag', group: 'GENERAL' },
    { key: 'discountTicketsDifference', type: 'flag', group: 'GENERAL' },
    { key: 'handheldReceiptRequestDelegate', type: 'flag', group: 'GENERAL' },
    { key: 'halfPortionValue', type: 'int', group: 'GENERAL' },
    { key: 'halfPortionVariantsValue', type: 'int', group: 'GENERAL' },
    { key: 'resetDeskNumber', type: 'int', group: 'GENERAL' },
    { key: 'resetRoomsNumber', type: 'int', group: 'GENERAL' },
    { key: 'resetDeliveryNumber', type: 'int', group: 'GENERAL' },
    { key: 'roomsGridHandhelds', type: 'flag', group: 'GENERAL' },
    { key: 'tableGroups.status', type: 'flag', group: 'TABLE_GROUPS' },
    { key: 'tableGroups.name', type: 'flag', group: 'TABLE_GROUPS' },
    { key: 'tableGroups.autoCreateFirst', type: 'flag', group: 'TABLE_GROUPS' },
  ],
  reservations: [
    { key: 'status', type: 'flag', group: 'MASTER' },
    { key: 'step', type: 'duration', group: 'GENERAL', def: 900000 },
    { key: 'duration', type: 'duration', group: 'GENERAL', def: 1800000 },
    { key: 'emailNotification.status', type: 'flag', group: 'EMAIL_NOTIFICATION' },
    { key: 'emailNotification.to', type: 'text', group: 'EMAIL_NOTIFICATION' },
    { key: 'emailNotification.templateId', type: 'template', group: 'EMAIL_NOTIFICATION' },
    { key: 'emailNotification.subject', type: 'text', group: 'EMAIL_NOTIFICATION' },
    { key: 'email.status', type: 'flag', group: 'EMAIL' },
    { key: 'email.templateId', type: 'template', group: 'EMAIL' },
    { key: 'email.subject', type: 'text', group: 'EMAIL' },
    { key: 'emailConfirmedStatus.status', type: 'flag', group: 'EMAIL_CONFIRMED' },
    { key: 'emailConfirmedStatus.templateId', type: 'template', group: 'EMAIL_CONFIRMED' },
    { key: 'emailConfirmedStatus.subject', type: 'text', group: 'EMAIL_CONFIRMED' },
    { key: 'emailRefusedStatus.status', type: 'flag', group: 'EMAIL_REFUSED' },
    { key: 'emailRefusedStatus.templateId', type: 'template', group: 'EMAIL_REFUSED' },
    { key: 'emailRefusedStatus.subject', type: 'text', group: 'EMAIL_REFUSED' },
    { key: 'emailChangeStatus.status', type: 'flag', group: 'EMAIL_CHANGE' },
    { key: 'emailChangeStatus.templateId', type: 'template', group: 'EMAIL_CHANGE' },
    { key: 'emailChangeStatus.subject', type: 'text', group: 'EMAIL_CHANGE' },
    { key: 'suspendedToday', type: 'flag', group: 'WEB_WIDGET' },
    { key: 'untilHours', type: 'time', group: 'WEB_WIDGET' },
    { key: 'webWidget.color', type: 'color', group: 'WEB_WIDGET_THEME' },
    {
      key: 'webWidget.brightness',
      type: 'select',
      group: 'WEB_WIDGET_THEME',
      values: ['light', 'dark', 'auto'],
    },
    { key: 'webWidget.status', type: 'flag', group: 'WEB_WIDGET_THEME' },
  ],
  delivery: [
    { key: 'takeAway.status', type: 'flag', group: 'MASTER' },
    { key: 'takeAway.delivery', type: 'flag', group: 'DELIVERY' },
    { key: 'takeAway.autoDeliveryCost', type: 'flag', group: 'DELIVERY' },
    { key: 'takeAway.fastTakeAway', type: 'flag', group: 'TAKEAWAY' },
    { key: 'takeAway.callerRequired', type: 'flag', group: 'TAKEAWAY' },
    {
      key: 'takeAway.sendOrderOnSave',
      type: 'select',
      group: 'SEND_PRINT',
      values: ['ask', 'never', 'always'],
    },
    { key: 'takeAway.autoOrderingTime', type: 'int', group: 'SEND_PRINT' },
    {
      key: 'takeAway.sendOrderOnSaveFast',
      type: 'select',
      group: 'SEND_PRINT',
      values: ['ask', 'never', 'always'],
    },
    { key: 'takeAway.sendPrebillingOnSave', type: 'flag', group: 'SEND_PRINT' },
    { key: 'takeAway.printOrderNumber', type: 'flag', group: 'SEND_PRINT' },
    { key: 'takeAway.autoOrderStatusComplete', type: 'flag', group: 'ORDERS_STATUS' },
    { key: 'takeAway.createOrderNumberOnSave', type: 'flag', group: 'ORDERS_STATUS' },
    { key: 'takeAway.step', type: 'duration', group: 'LOAD_ALERT' },
    { key: 'takeAway.alertMaxDeliveryInStep', type: 'int', group: 'LOAD_ALERT' },
    { key: 'takeAway.alertMaxTakeAwayInStep', type: 'int', group: 'LOAD_ALERT' },
    { key: 'takeAway.roomsProductionCenterValue', type: 'flag', group: 'LOAD_ALERT' },
    { key: 'takeAway.deliveryListId', type: 'priceList', group: 'PRICE_LISTS' },
    { key: 'takeAway.takeAwayListId', type: 'priceList', group: 'PRICE_LISTS' },
    { key: 'step', type: 'number', group: 'DELIVERY_AREA' },
    { key: 'maxContemporary', type: 'number', group: 'DELIVERY_AREA' },
    { key: 'lat', type: 'number', group: 'DELIVERY_AREA' },
    { key: 'lng', type: 'number', group: 'DELIVERY_AREA' },
    { key: 'radius', type: 'number', group: 'DELIVERY_AREA' },
    { key: 'margin', type: 'number', group: 'DELIVERY_AREA' },
  ],
  selfOrdering: [
    { key: 'status', type: 'flag', group: 'GENERAL' },
    { key: 'fixedMessage', type: 'long', group: 'GENERAL' },
    { key: 'additionalInfoLabel', type: 'long', group: 'GENERAL' },
    { key: 'additionalInfo', type: 'long', group: 'GENERAL' },
  ],
  kiosk: [
    { key: 'listId', type: 'priceList', group: 'GENERAL' },
    { key: 'mode', type: 'select', group: 'GENERAL', values: ['sale', 'catalog'] },
    { key: 'idleTimeAlert', type: 'int', group: 'GENERAL' },
    { key: 'closeSessionTime', type: 'int', group: 'GENERAL' },
    { key: 'eatHere', type: 'flag', group: 'SERVICES' },
    { key: 'takeAway', type: 'flag', group: 'SERVICES' },
    { key: 'deskPay', type: 'flag', group: 'PAYMENT_MODE' },
    { key: 'posPay', type: 'flag', group: 'PAYMENT_MODE' },
    { key: 'paymentsCards', type: 'flag', group: 'PAYMENTS' },
    { key: 'paymentsCash', type: 'flag', group: 'PAYMENTS' },
    { key: 'paymentsSatispay', type: 'flag', group: 'PAYMENTS' },
    {
      key: 'catalogLayout',
      type: 'select',
      group: 'CATALOG',
      values: ['cols-4', 'cols-3', 'list'],
    },
    { key: 'hideCategories', type: 'flag', group: 'CATALOG' },
    { key: 'hideNotAvailableProducts', type: 'flag', group: 'CATALOG' },
    { key: 'hidePhotos', type: 'flag', group: 'CATALOG' },
    { key: 'productVariants', type: 'flag', group: 'CATALOG' },
    { key: 'quickAddToCart', type: 'flag', group: 'CATALOG' },
    { key: 'upsellingCategoryId', type: 'category', group: 'CATALOG' },
    { key: 'unpaidNotPrint', type: 'flag', group: 'PRINTERS' },
    { key: 'prebillingDeskPay', type: 'flag', group: 'PRINTERS' },
    { key: 'prebillingPosPay', type: 'flag', group: 'PRINTERS' },
    { key: 'printOrderCheckoutDefault', type: 'flag', group: 'PRINTERS' },
    { key: 'autoOrderStatusComplete', type: 'flag', group: 'ORDERS_STATUS' },
    { key: 'paperReceipt', type: 'flag', group: 'DOCUMENTS' },
    { key: 'eReceiptEmail', type: 'flag', group: 'DOCUMENTS' },
    { key: 'eReceiptQr', type: 'flag', group: 'DOCUMENTS' },
    {
      key: 'tablePlaceholder',
      type: 'select',
      group: 'OTHER',
      values: ['none', 'optional', 'required'],
    },
    {
      key: 'tablePlaceholderType',
      type: 'select',
      group: 'OTHER',
      values: ['table', 'stand', 'pager'],
    },
    {
      key: 'takeawayPlaceholder',
      type: 'select',
      group: 'OTHER',
      values: ['none', 'optional', 'required'],
    },
    { key: 'takeawayPlaceholderType', type: 'select', group: 'OTHER', values: ['pager'] },
    { key: 'manageFidelity', type: 'flag', group: 'OTHER' },
    { key: 'backgroundColor', type: 'color', group: 'LAYOUT' },
    { key: 'textColor', type: 'color', group: 'LAYOUT' },
    { key: 'categoriesIcons', type: 'flag', group: 'LAYOUT' },
  ],
  appointments: [
    { key: 'staffChoice', type: 'flag', group: 'GENERAL' },
    { key: 'staffChoiceRequired', type: 'flag', group: 'GENERAL' },
    { key: 'step', type: 'duration', group: 'GENERAL' },
    { key: 'maxContemporary', type: 'int', group: 'GENERAL' },
    { key: 'maxDaily', type: 'int', group: 'GENERAL' },
    { key: 'type', type: 'select', group: 'GENERAL', values: ['single', 'multiple'] },
    { key: 'email.templateId', type: 'template', group: 'GENERAL' },
    { key: 'email.from', type: 'text', group: 'GENERAL' },
    { key: 'email.subject', type: 'text', group: 'GENERAL' },
    { key: 'webWidgetStatus', type: 'flag', group: 'GENERAL', reserved: true },
  ],
  externalDisplay: [
    { key: 'tips', type: 'flag', group: 'GENERAL' },
    { key: 'receiptType', type: 'flag', group: 'GENERAL' },
    { key: 'fidelity', type: 'flag', group: 'GENERAL' },
    { key: 'backgroundColor', type: 'color', group: 'LAYOUT' },
    { key: 'textColor', type: 'color', group: 'LAYOUT' },
  ],
  fidelity: [
    {
      key: 'type',
      type: 'select',
      group: 'GENERAL',
      values: ['advanced', 'base'],
      nullable: true,
      noneKey: 'PLACES.NONE_OF.FIDELITY_TYPE',
    },
    { key: 'showPoints', type: 'flag', group: 'GENERAL' },
    { key: 'showPointsCheckout', type: 'flag', group: 'GENERAL' },
    { key: 'printDataOnFiscalReceipt', type: 'flag', group: 'GENERAL' },
    { key: 'printDataOnReceipt', type: 'flag', group: 'GENERAL' },
  ],
  tobacco: [
    { key: 'status', type: 'flag', group: 'MASTER' },
    { key: 'printProductsOnReceipt', type: 'flag', group: 'PRINT' },
    { key: 'companyId', type: 'company', group: 'SECONDARY_COMPANY' },
    { key: 'placeId', type: 'place', group: 'SECONDARY_COMPANY' },
    { key: 'winningsManagement', type: 'flag', group: 'SCRATCH_AND_WIN' },
  ],
  media: [
    { key: 'internalFileNameLogo', type: 'plain', group: 'FILES' },
    { key: 'externalUrlLogo', type: 'plain', group: 'FILES' },
    { key: 'internalFileName', type: 'plain', group: 'FILES' },
    { key: 'externalUrl', type: 'plain', group: 'FILES' },
  ],
  integrations: [
    { key: 'floodPay.status', type: 'flag', group: 'FLOOD_PAY', reserved: true },
    { key: 'floodPay.stripe.publicKey', type: 'text', group: 'FLOOD_PAY', reserved: true },
    { key: 'floodPay.stripe.privateKey', type: 'secret', group: 'FLOOD_PAY', privilegedOnly: true },
    {
      key: 'floodPay.stripe.webhookPrivateKey',
      type: 'secret',
      group: 'FLOOD_PAY',
      privilegedOnly: true,
    },
    {
      key: 'floodPay.qrCodePayment.status',
      type: 'flag',
      group: 'QR_CODE_PAYMENT',
      reserved: true,
    },
    {
      key: 'floodPay.qrCodePayment.type',
      type: 'select',
      group: 'QR_CODE_PAYMENT',
      values: ['static', 'dynamic'],
    },
    { key: 'floodPay.qrCodePayment.rating', type: 'flag', group: 'QR_CODE_PAYMENT' },
    { key: 'floodPay.qrCodePayment.eReceipt', type: 'flag', group: 'QR_CODE_PAYMENT' },
    { key: 'floodPay.qrCodePayment.tips', type: 'flag', group: 'QR_CODE_PAYMENT' },
    { key: 'floodPay.qrCodePayment.postPaymentText', type: 'text', group: 'QR_CODE_PAYMENT' },
    { key: 'floodPay.tapToPay.status', type: 'flag', group: 'TAP_TO_PAY', reserved: true },
    { key: 'floodPay.tapToPay.tips', type: 'flag', group: 'TAP_TO_PAY' },
    { key: 'dojo.status', type: 'flag', group: 'DOJO', reserved: true },
    { key: 'dojo.apiKey', type: 'secret', group: 'DOJO', privilegedOnly: true },
    { key: 'satispay.status', type: 'flag', group: 'SATISPAY', reserved: true },
    { key: 'satispay.activationCode', type: 'secret', group: 'SATISPAY', privilegedOnly: true },
    { key: 'satispay.type', type: 'select', group: 'SATISPAY', values: ['checkin', 'qrcode'] },
    { key: 'satispay.keyId', type: 'secret', group: 'SATISPAY', privilegedOnly: true },
    { key: 'qodeup.status', type: 'flag', group: 'QODEUP', reserved: true },
    { key: 'qodeup.apiKey', type: 'secret', group: 'QODEUP', privilegedOnly: true },
    { key: 'bizerba.status', type: 'flag', group: 'BIZERBA', reserved: true },
    { key: 'bizerba.importPath', type: 'text', group: 'BIZERBA' },
    { key: 'bizerba.exportPath', type: 'text', group: 'BIZERBA' },
    { key: 'googleMaps.status', type: 'flag', group: 'GOOGLE_MAPS', reserved: true },
    { key: 'reserveWithGoogle.status', type: 'flag', group: 'RESERVE_WITH_GOOGLE', reserved: true },
    {
      key: 'reserveWithGoogle.category',
      type: 'select',
      group: 'RESERVE_WITH_GOOGLE',
      values: ['restaurant'],
    },
    { key: 'reserveWithGoogle.name', type: 'text', group: 'RESERVE_WITH_GOOGLE' },
    { key: 'reserveWithGoogle.telephone', type: 'text', group: 'RESERVE_WITH_GOOGLE' },
    { key: 'reserveWithGoogle.url', type: 'text', group: 'RESERVE_WITH_GOOGLE' },
    { key: 'reserveWithGoogle.geo.latitude', type: 'number', group: 'RESERVE_WITH_GOOGLE' },
    { key: 'reserveWithGoogle.geo.longitude', type: 'number', group: 'RESERVE_WITH_GOOGLE' },
    {
      key: 'reserveWithGoogle.geo.address.streetAddress',
      type: 'text',
      group: 'RESERVE_WITH_GOOGLE',
    },
    { key: 'reserveWithGoogle.geo.address.locality', type: 'text', group: 'RESERVE_WITH_GOOGLE' },
    { key: 'reserveWithGoogle.geo.address.postalCode', type: 'text', group: 'RESERVE_WITH_GOOGLE' },
    { key: 'reserveWithGoogle.geo.address.country', type: 'text', group: 'RESERVE_WITH_GOOGLE' },
    { key: 'easyappear.status', type: 'flag', group: 'EASY_APPEAR', reserved: true },
    { key: 'easyappear.appToken', type: 'secret', group: 'EASY_APPEAR' },
    { key: 'yellgo.status', type: 'flag', group: 'YELLGO', reserved: true },
    { key: 'yellgo.apiKey', type: 'secret', group: 'YELLGO' },
    { key: 'leggimenu.status', type: 'flag', group: 'LEGGIMENU', reserved: true },
    { key: 'leggimenu.apiKey', type: 'secret', group: 'LEGGIMENU' },
    { key: 'plateform.status', type: 'flag', group: 'PLATEFORM', reserved: true },
    { key: 'plateform.username', type: 'secret', group: 'PLATEFORM' },
    { key: 'plateform.password', type: 'secret', group: 'PLATEFORM' },
    { key: 'cooperto.status', type: 'flag', group: 'COOPERTO', reserved: true },
    { key: 'cooperto.apiKey', type: 'secret', group: 'COOPERTO' },
    { key: 'tomatoai.status', type: 'flag', group: 'TOMATO_AI', reserved: true },
    { key: 'tomatoai.apiKey', type: 'secret', group: 'TOMATO_AI' },
    { key: 'keenon.status', type: 'flag', group: 'KEENON', reserved: true },
    { key: 'keenon.storeId', type: 'text', group: 'KEENON' },
    { key: 'tsh.status', type: 'flag', group: 'TSH', reserved: true },
    { key: 'tsh.testMode', type: 'flag', group: 'TSH' },
    { key: 'tsh.id', type: 'secret', group: 'TSH' },
    { key: 'tsh.secret', type: 'secret', group: 'TSH' },
    { key: 'tsh.propertyId', type: 'text', group: 'TSH' },
    { key: 'tsh.serviceName', type: 'text', group: 'TSH' },
    { key: 'phlex.status', type: 'flag', group: 'PHLEX', reserved: true },
    { key: 'phlex.username', type: 'secret', group: 'PHLEX' },
    { key: 'phlex.password', type: 'secret', group: 'PHLEX' },
    { key: 'phlex.structureId', type: 'text', group: 'PHLEX' },
  ],
  dealerSettings: [
    { key: 'sentry', type: 'flag', group: 'TRACKING' },
    { key: 'serverIp', type: 'text', group: 'SERVER' },
    { key: 'connectorAddress', type: 'plain', group: 'CONNECTOR' },
  ],
};

/** The groups (fieldsets) of a block, in order of appearance. */
export function groupsOf(block: SettingsBlockName): string[] {
  return [...new Set(FIELDS[block].map((definition) => definition.group))];
}

/** `camelCase` as `UPPER_SNAKE_CASE`, the form of the keys of the dictionary. */
export const snake = (text: string): string =>
  text.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();

/** Dictionary key of the label of a settings key. */
export function fieldLabelKey(block: SettingsBlockName, key: string): string {
  return `PLACES.F.${snake(block)}.${key.split('.').map(snake).join('.')}`;
}

/** Dictionary key of the legend of a group of a block. */
export function groupLabelKey(block: SettingsBlockName, group: string): string {
  return `PLACES.G.${snake(block)}.${group}`;
}

/** Dictionary key of the label of a value of a `select` key. */
export function optionLabelKey(key: string, value: string): string {
  const last = key.split('.').at(-1) as string;
  return `PLACES.OPTION.${snake(last)}.${snake(value.replace(/-/g, '_'))}`;
}

/** What the interface knows about the user and the group to decide what to show. */
export interface Visibility {
  /** Platform administrator or dealer. */
  readonly privileged: boolean;
  /** Whether the group has a feature. */
  readonly feature: (name: FeatureName) => boolean;
}

/**
 * Whether a key is shown: platform administrators and dealers always see it, the others when the
 * group has the feature it needs. A hidden key keeps its stored value.
 */
export function isVisible(definition: FieldDef, visibility: Visibility): boolean {
  return (
    definition.needs === undefined || visibility.privileged || visibility.feature(definition.needs)
  );
}

/** Dictionary key of the title of a part of a block (the receipt, the pre-bill and the order of the printouts). */
export function partOf(block: SettingsBlockName, group: string): string | null {
  if (block !== 'printing') {
    return null;
  }
  return `PLACES.PART.PRINT_${group.split('_')[0]}`;
}

// Values of the form, from and to the API.

/** A value of the form: a switch, or the text of any other control. */
export type FieldValue = string | boolean;

/** The values of the scalar keys of a block, by key. */
export type Scalars = Record<string, FieldValue>;

/** Value at a dotted path of a block of the API, `undefined` where the path does not exist. */
export function valueAt(block: unknown, path: string): unknown {
  let node: unknown = block;
  for (const segment of path.split('.')) {
    node =
      typeof node === 'object' && node !== null
        ? (node as Record<string, unknown>)[segment]
        : undefined;
  }
  return node;
}

/** Sets a value at a dotted path of an object, creating the objects on the way. */
export function setAt(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  let node = target;
  for (const segment of segments.slice(0, -1)) {
    node = (node[segment] ??= {}) as Record<string, unknown>;
  }
  node[segments[segments.length - 1]] = value;
}

const MINUTE = 60_000;

/**
 * The value of the form of a key, from what the API returned.
 *
 * @param definition The key.
 * @param raw The value in the block (anything where the API had a historical value).
 */
export function toFieldValue(definition: FieldDef, raw: unknown): FieldValue {
  switch (definition.type) {
    case 'flag':
      return raw === true;
    case 'number':
    case 'int':
      return typeof raw === 'number' ? String(raw) : '';
    case 'duration':
      return typeof raw === 'number' ? String(raw / MINUTE) : '';
    default:
      return typeof raw === 'string' ? raw : '';
  }
}

/**
 * The value of a key for the body of a request.
 *
 * @param definition The key.
 * @param value What the form holds.
 */
export function toBodyValue(definition: FieldDef, value: FieldValue): unknown {
  const text = value as string;
  switch (definition.type) {
    case 'flag':
      return value;
    case 'plain':
    case 'font':
    case 'color':
      return text;
    case 'number':
      return text === '' ? null : Number(text);
    case 'int':
      return text === '' ? (definition.def ?? null) : Number(text);
    case 'duration':
      return text === '' ? (definition.def ?? null) : Math.round(Number(text) * MINUTE);
    default:
      return text === '' ? null : text;
  }
}
