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
  | 'place';

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
  /** The feature the group must have for the key to be shown. */
  readonly needs?: FeatureName;
  /** Platform administrators and dealers see the key even without the feature. */
  readonly orPrivileged?: boolean;
  /** Only platform administrators and dealers may change the key. */
  readonly reserved?: boolean;
}

type Extra = Partial<Omit<FieldDef, 'key' | 'type' | 'group'>>;

const flags = (group: string, keys: string, extra: Extra = {}): FieldDef[] =>
  keys.split(' ').map((key) => ({ key, type: 'flag', group, ...extra }));
const texts = (group: string, keys: string, extra: Extra = {}): FieldDef[] =>
  keys.split(' ').map((key) => ({ key, type: 'text', group, ...extra }));
const fonts = (group: string, keys: string, extra: Extra = {}): FieldDef[] =>
  keys.split(' ').map((key) => ({ key, type: 'font', group, ...extra }));
const field = (key: string, type: FieldType, group: string, extra: Extra = {}): FieldDef => ({
  key,
  type,
  group,
  ...extra,
});
const choice = (key: string, group: string, values: string, extra: Extra = {}): FieldDef => ({
  key,
  type: 'select',
  group,
  values: values.split(' '),
  ...extra,
});

const ROOMS: Extra = { needs: 'rooms' };
const ORDERING: Extra = { needs: 'ordering' };

/** The font sizes of a printout: rows by columns, each from 1 to 3. */
export const FONT_SIZES: readonly string[] = [1, 2, 3].flatMap((rows) =>
  [1, 2, 3].map((columns) => `${rows}-${columns}`),
);

const EMAIL = (name: string, withTo: boolean): FieldDef[] => {
  const group = name.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
  return [
    field(`${name}.status`, 'flag', group),
    ...(withTo ? [field(`${name}.to`, 'text', group)] : []),
    field(`${name}.templateId`, 'template', group),
    field(`${name}.subject`, 'text', group),
  ];
};

/**
 * The scalar keys of every settings block, in display order: what the old backoffice shows in
 * the tab, with the feature that gates it. The lists and maps (workshift names, payment types,
 * time blocks…) are not here: the tabs edit them with their own controls. The names are the keys
 * of the API, below the block.
 */
export const FIELDS: Readonly<Record<SettingsBlockName, readonly FieldDef[]>> = {
  cashSettings: [
    ...flags('LOGIN', 'fastLogin urersLoginRequiredToReceipt urersLoginRequiredToReceiptOnlyDesk'),
    ...flags(
      'CART',
      'singleCartRow totalPriceCartRow combinesVariantsPrice discountPercentageOnlyNoDiscount resetPriceListOnSale checkoutContactNote returnedGoods productsWeightKg',
    ),
    ...flags('CART', 'productVariantsQuantity', { needs: 'productsVariants' }),
    ...flags('SHIFTS', 'logs workshift', ROOMS),
    ...flags('SHIFTS', 'usersShifts usersShiftsPrintReceipt'),
    field('operatingTime', 'time', 'SHIFTS'),
    ...flags(
      'RECEIPT',
      'noTaxedProductsPrintReceipt onlyNoTaxedProductsPrintReceipt noTaxedProductsSummaryPrintReceipt',
    ),
    ...flags('RECEIPT', 'chargeDocument', { needs: 'productsVariants' }),
    field('chargeDocumentQt', 'int', 'RECEIPT', { needs: 'productsVariants', def: 1 }),
    field('customDiscount', 'text', 'RECEIPT'),
    field('totalRounding', 'number', 'RECEIPT'),
    choice('receiptsCancellation', 'RECEIPT', 'sync notSync', { nullable: true }),
    ...flags('WAREHOUSE', 'deskBackoffice'),
    ...flags('WAREHOUSE', 'localWarehouse simpleWarehouse', {
      needs: 'warehouse',
      orPrivileged: true,
    }),
    choice('localWarehouseOutOfStock', 'WAREHOUSE', 'disabled enabled alert'),
    ...flags('REPORT', 'advancedReportLogs', ROOMS),
  ],
  printing: [
    ...flags(
      'RECEIPT_OPTIONS',
      'user barcode mergedVariants noPrintPrice0Products price0ProductsBottom printReceiptCopy printDivisionNumber printPriceLists printUnpaidReceipt unpaidReceiptCustomerRequired note invoice giftReceipt serverPrint verifyClousures'
        .split(' ')
        .map((key) => `receipt.${key}`)
        .join(' '),
    ),
    ...flags(
      'RECEIPT_OPTIONS',
      'receipt.seatsTop receipt.serviceTop receipt.subtotalServiceBottom',
      ROOMS,
    ),
    ...flags(
      'RECEIPT_NON_FISCAL',
      'noFiscalDefaultNoPrint noFiscalHeader noFiscalTaxes noFiscalTaxesTotal noFiscalRest'
        .split(' ')
        .map((key) => `receipt.${key}`)
        .join(' '),
    ),
    field('receipt.subtotalFontSize', 'font', 'RECEIPT_FORMAT'),
    field('receipt.invoiceQt', 'int', 'RECEIPT_FORMAT', { def: 1 }),
    field('receipt.noFiscalBottomText', 'text', 'RECEIPT_FORMAT'),
    ...flags(
      'PREBILLING_OPTIONS',
      'prebilling.header prebilling.printMergedVariants prebilling.noPrintPrice0Products prebilling.printCategoriesTotalizers prebilling.printTableUser prebilling.printUser',
      ORDERING,
    ),
    ...texts('PREBILLING_TEXTS', 'prebilling.titleText prebilling.bottomText', ORDERING),
    ...fonts(
      'PREBILLING_FONTS',
      'prebilling.titleFontSize prebilling.sequentialNumberFontSize prebilling.bottomTextFontSize prebilling.customerDataFontSize',
      ORDERING,
    ),
    choice('ordering.productsSorting', 'ORDERING_GENERAL', 'cart alphabetical position', ORDERING),
    field('ordering.startReturnNumber', 'int', 'ORDERING_GENERAL', { ...ORDERING, def: 0 }),
    field('ordering.endReturnNumber', 'int', 'ORDERING_GENERAL', { ...ORDERING, def: 0 }),
    ...fonts(
      'ORDERING_FONTS',
      'printStationFontSize deviceFontSize piecesFontSize seatsFontSize customerNameFontSize callerFontSize involvedStationsFontSize productsFontSize variantsFontSize summaryProductsFontSize summaryVariantsFontSize titleFontSize tableFontSize exitsFontSize categoriesGropusFontSize numberFontSize'
        .split(' ')
        .map((key) => `ordering.${key}`)
        .join(' '),
      ORDERING,
    ),
    ...texts(
      'ORDERING_TEXTS',
      'tableText deskText takeAwayText deliveryText variantPlusText variantMinusText variantInfoText exitText proceedText removalText moveText additionText resendText changeOrderText cancellationOrderText noteText tableNoteText orderNoteText quiklyText involvedStationsText'
        .split(' ')
        .map((key) => `ordering.${key}`)
        .join(' '),
      ORDERING,
    ),
    ...flags(
      'ORDERING_OPTIONS',
      'titleReverse categoriesGropus noRemoval noRemovalOnDeleteTable noRemovalOnDeleteOrder device printStation priceListName mergeProductsPrint roomName total totalPc allPrices seatsNumber productsProceed firstExitOnExitsCut sequentialNumberTop sequentialNumberBottom roomsSequentialNumberTop roomsSequentialNumberBottom shortName shortDescription note tableNote printStationsInvolved tableBottom additionInfo productsSpace summaryExits move partialMoveProducts contactInfo tableUser productsBold productsCode'
        .split(' ')
        .map((key) => `ordering.${key}`)
        .join(' '),
      ORDERING,
    ),
  ],
  payments: [
    choice('defaultType', 'DEFAULTS', 'cash electronic'),
    ...flags('DEFAULTS', 'cheque tickets paymentDiscount'),
  ],
  tables: [
    ...flags(
      'GENERAL',
      'exits proceedNoPrint sendOrderPrebilling deskCheckoutPrintersPriority checkoutTableValue0 discountTicketsDifference waitingList',
    ),
    field('exitsNumber', 'int', 'GENERAL', { def: 5 }),
    ...flags(
      'ACCESS',
      'urersLoginRequiredToTableDesk urersLoginRequiredToTable tableUserSelect tableUserSelectPin tableUserSelectEachOpening exclusiveUserTable',
    ),
    ...flags(
      'STATUS',
      'tableSeats waitingPaymentTableStatus prebillingRequestTableStatus handheldReceiptRequestDelegate roomsGridHandhelds',
    ),
    field('halfPortionValue', 'int', 'PORTIONS'),
    field('halfPortionVariantsValue', 'int', 'PORTIONS'),
    field('resetDeskNumber', 'int', 'RESETS'),
    field('resetRoomsNumber', 'int', 'RESETS'),
    field('resetDeliveryNumber', 'int', 'RESETS'),
    ...flags('TABLE_GROUPS', 'tableGroups.status tableGroups.name tableGroups.autoCreateFirst'),
  ],
  reservations: [
    ...flags('GENERAL', 'status suspendedToday'),
    field('step', 'duration', 'GENERAL', { def: 900000 }),
    field('duration', 'duration', 'GENERAL', { def: 1800000 }),
    field('untilHours', 'time', 'GENERAL'),
    field('webWidget.status', 'flag', 'WEB_WIDGET'),
    field('webWidget.color', 'color', 'WEB_WIDGET'),
    choice('webWidget.brightness', 'WEB_WIDGET', 'light dark auto'),
    ...EMAIL('emailNotification', true),
    ...EMAIL('email', false),
    ...EMAIL('emailConfirmedStatus', false),
    ...EMAIL('emailRefusedStatus', false),
    ...EMAIL('emailChangeStatus', false),
  ],
  delivery: [
    ...flags(
      'TAKE_AWAY',
      'takeAway.status takeAway.delivery takeAway.autoDeliveryCost takeAway.fastTakeAway takeAway.callerRequired takeAway.sendPrebillingOnSave takeAway.printOrderNumber takeAway.createOrderNumberOnSave takeAway.autoOrderStatusComplete takeAway.roomsProductionCenterValue',
    ),
    choice('takeAway.sendOrderOnSave', 'ORDERS', 'ask never always'),
    choice('takeAway.sendOrderOnSaveFast', 'ORDERS', 'ask never always'),
    field('takeAway.autoOrderingTime', 'int', 'ORDERS'),
    field('takeAway.alertMaxDeliveryInStep', 'int', 'ORDERS'),
    field('takeAway.alertMaxTakeAwayInStep', 'int', 'ORDERS'),
    field('takeAway.step', 'duration', 'ORDERS'),
    field('takeAway.deliveryListId', 'priceList', 'ORDERS'),
    field('takeAway.takeAwayListId', 'priceList', 'ORDERS'),
    field('step', 'number', 'AREA'),
    field('maxContemporary', 'number', 'AREA'),
    field('radius', 'number', 'AREA'),
    field('margin', 'number', 'AREA'),
    field('lat', 'number', 'AREA'),
    field('lng', 'number', 'AREA'),
  ],
  selfOrdering: [
    field('status', 'flag', 'GENERAL'),
    field('fixedMessage', 'long', 'GENERAL'),
    field('additionalInfoLabel', 'long', 'GENERAL'),
    field('additionalInfo', 'long', 'GENERAL'),
  ],
  kiosk: [
    field('listId', 'priceList', 'GENERAL'),
    choice('mode', 'GENERAL', 'sale catalog'),
    choice('catalogLayout', 'GENERAL', 'cols-4 cols-3 list'),
    choice('tablePlaceholder', 'GENERAL', 'none optional required'),
    choice('tablePlaceholderType', 'GENERAL', 'table stand pager'),
    choice('takeawayPlaceholder', 'GENERAL', 'none optional required'),
    choice('takeawayPlaceholderType', 'GENERAL', 'pager'),
    field('upsellingCategoryId', 'category', 'GENERAL'),
    ...flags(
      'SERVICES',
      'eatHere takeAway deskPay posPay prebillingDeskPay prebillingPosPay paymentsCards paymentsCash paymentsSatispay',
    ),
    ...flags(
      'DISPLAY',
      'hideCategories hideNotAvailableProducts hidePhotos productVariants quickAddToCart categoriesIcons',
    ),
    field('backgroundColor', 'color', 'DISPLAY'),
    field('textColor', 'color', 'DISPLAY'),
    ...flags(
      'ORDER',
      'unpaidNotPrint printOrderCheckoutDefault autoOrderStatusComplete paperReceipt eReceiptEmail eReceiptQr manageFidelity',
    ),
    field('idleTimeAlert', 'int', 'SESSION'),
    field('closeSessionTime', 'int', 'SESSION'),
  ],
  appointments: [
    ...flags('GENERAL', 'staffChoice staffChoiceRequired'),
    field('webWidgetStatus', 'flag', 'GENERAL', { reserved: true }),
    field('step', 'duration', 'GENERAL'),
    field('maxContemporary', 'int', 'GENERAL'),
    field('maxDaily', 'int', 'GENERAL'),
    choice('type', 'GENERAL', 'single multiple'),
    field('email.templateId', 'template', 'EMAIL'),
    field('email.from', 'text', 'EMAIL'),
    field('email.subject', 'text', 'EMAIL'),
  ],
  externalDisplay: [
    ...flags('GENERAL', 'tips receiptType fidelity'),
    field('backgroundColor', 'color', 'GENERAL'),
    field('textColor', 'color', 'GENERAL'),
  ],
  fidelity: [
    choice('type', 'GENERAL', 'advanced base', { nullable: true }),
    ...flags(
      'GENERAL',
      'showPoints showPointsCheckout printDataOnFiscalReceipt printDataOnReceipt',
    ),
  ],
  tobacco: [
    ...flags('GENERAL', 'status printProductsOnReceipt winningsManagement'),
    field('companyId', 'company', 'SECONDARY'),
    field('placeId', 'place', 'SECONDARY'),
  ],
  media: [
    field('internalFileNameLogo', 'plain', 'FILES'),
    field('externalUrlLogo', 'plain', 'FILES'),
    field('internalFileName', 'plain', 'FILES'),
    field('externalUrl', 'plain', 'FILES'),
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
 * Whether a key is shown: when the group has the feature it needs (platform administrators and
 * dealers also see the keys marked for them). A hidden key keeps its stored value.
 */
export function isVisible(definition: FieldDef, visibility: Visibility): boolean {
  if (definition.needs === undefined) {
    return true;
  }
  return (
    visibility.feature(definition.needs) ||
    (definition.orPrivileged === true && visibility.privileged)
  );
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
