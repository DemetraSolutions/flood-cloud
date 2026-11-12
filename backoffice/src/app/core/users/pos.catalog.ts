/**
 * Catalog of the point-of-sale (POS) data of a user as the backend exposes it
 * (`pos.grants` = permissions, `pos.options` = interface preferences). The names are the domain
 * names of the API; the labels live in the dictionary (`USERS.POS.*`).
 */

/** Groups of POS grants by area, in display order; every flag of the API appears exactly once. */
export const POS_GRANT_GROUPS = [
  {
    id: 'SALE',
    flags: [
      'discount',
      'discountReason',
      'priceChange',
      'onlyHigherPrice',
      'freeSale',
      'invoices',
      'contacts',
      'selectSaleUser',
      'manageService',
      'rider',
    ],
  },
  {
    id: 'RECEIPTS',
    flags: [
      'fiscalClosure',
      'receiptCancellation',
      'reworkSale',
      'printReceipt',
      'advancedReport',
      'advancedReportPin',
      'bypassAutomaticCash',
      'deleteUserShiftDetail',
    ],
  },
  {
    id: 'TABLES',
    flags: [
      'printPrebill',
      'tableCheckoutActiveDesk',
      'deleteTable',
      'deleteTableReason',
      'tablePrebillActions',
      'roomsTableQuickTotals',
      'roomsRoomsPrices',
      'roomsTablePrices',
      'roomsOnlyHigherSeatsQuantity',
      'tableEngage',
      'tableMerge',
      'tableSplit',
      'tableClose',
      'checkoutPartition',
      'checkoutSeparation',
      'unlockTable',
    ],
  },
  {
    id: 'PRODUCTS',
    flags: [
      'deleteTableProduct',
      'deleteTableProductReasonNotSent',
      'deleteTableProductReasonSent',
      'editSentWeightQuantity',
      'sentProducts',
      'notSentProducts',
      'lockProducts',
      'moveProducts',
      'resendProducts',
      'searchProducts',
    ],
  },
] as const;

/** A boolean POS grant. */
export type PosFlag = (typeof POS_GRANT_GROUPS)[number]['flags'][number];

/** Every boolean POS grant (44), in display order. */
export const POS_FLAGS: readonly PosFlag[] = POS_GRANT_GROUPS.flatMap((group) => group.flags);

/** Automatic cash devices and the flags of each (`pos.grants.automaticCash.<device>.<flag>`). */
export const AUTOMATIC_CASH = {
  glory: [
    'withdrawal',
    'deposit',
    'archive',
    'archiveAll',
    'unlockNote',
    'unlockCoin',
    'collectVerify',
  ],
  cashMatic: ['withdrawal', 'deposit', 'change', 'refill', 'archive', 'archiveAll'],
  vne: ['withdrawal', 'refill', 'archive', 'archiveAll', 'tools'],
  azkoyen: ['withdrawal', 'deposit', 'backoffice', 'status'],
  cashSystem: ['withdrawal'],
} as const;

/** An automatic cash device. */
export type AutomaticCashDevice = keyof typeof AUTOMATIC_CASH;

/** The devices, in display order. */
export const AUTOMATIC_CASH_DEVICES = Object.keys(AUTOMATIC_CASH) as AutomaticCashDevice[];

/** Groups of the boolean interface preferences, in display order (31 in total). */
export const POS_OPTION_GROUPS = [
  {
    id: 'COUNTER',
    flags: [
      'extendedCart',
      'noSeparator',
      'skipCheckoutButton',
      'showLastSaleValue',
      'quickPriceList',
      'advancedDiscount',
      'invertedCart',
      'deskPrintOrderDefault',
      'genericProductPriceFocus',
      'removeFiltersProductSelect',
      'removeFiltersOnSearch',
      'skipFiscalReceiptTypeRequest',
      'departmentsDialog',
      'darkMode',
    ],
  },
  {
    id: 'PRODUCTS',
    flags: [
      'productsPagination',
      'productsShortName',
      'reducedProducts',
      'reducedProductsTable',
      'enlargedCategories',
    ],
  },
  {
    id: 'TABLES',
    flags: [
      'reducedTables',
      'tableCartPriority',
      'sendOrderRemainButton',
      'viewTableStatus',
      'viewTableUser',
      'viewTableCustomer',
      'viewTableStartDate',
      'roomsGridActive',
      'roomsGridActionbarOpened',
    ],
  },
  {
    id: 'DELIVERY',
    flags: [
      'deliveryTakeawayCompletedDefault',
      'deliveryTakeawayShowOrderDetailOnSave',
      'deliveryTakeawayShowProduction',
    ],
  },
] as const;

/** A boolean interface preference. */
export type PosBooleanOption = (typeof POS_OPTION_GROUPS)[number]['flags'][number];

/** Every boolean preference (31), in display order. */
export const POS_BOOLEAN_OPTIONS: readonly PosBooleanOption[] = POS_OPTION_GROUPS.flatMap(
  (group) => group.flags,
);

/** Values of the choice preferences; `''` stands for "not set" where the API accepts `null`. */
export const POS_CHOICES = {
  side: ['dx', 'sx'],
  sideRooms: ['dx', 'sx'],
  virtualKeyboard: ['', 'pb', 'p', 'mb', 'm'],
  template: [
    '',
    'material-tealwhite-light',
    'material-tealwhite-dark',
    'material-whitepurple-light',
    'material-whitepurple-dark',
  ],
  productsFontSize: ['s', 'm', 'l'],
  productsShortNameFontSize: ['s', 'm', 'l'],
  roomsTablesColumns: ['', '4', '5', '6', '8'],
  roomsTablesColumnsHandheld: ['', '2', '3', '4'],
  roomsGridZoomHandheld: ['1', '1.5', '2', '2.5', '3'],
} as const;

/** A choice preference. */
export type PosChoice = keyof typeof POS_CHOICES;

/** The choice preferences, in display order. */
export const POS_CHOICE_NAMES = Object.keys(POS_CHOICES) as PosChoice[];

/** A price list a user can use on the POS. */
export interface PosPriceList {
  priceListId: string;
  enabled: boolean;
  isDefault: boolean;
}

/** Automatic cash grants: every flag of every device. */
export type AutomaticCashGrants = {
  [D in AutomaticCashDevice]: { [K in (typeof AUTOMATIC_CASH)[D][number]]: boolean };
};

/** The POS permissions of a user. */
export type PosGrants = Record<PosFlag, boolean> & {
  /** Highest discount, 0-100; `null` for no cap. */
  discountMaxPercentage: number | null;
  /** Default service percentage, 0-100; `null` for none. */
  servicePercentage: number | null;
  automaticCash: AutomaticCashGrants;
};

/** The POS interface preferences of a user. */
export type PosOptions = Record<PosBooleanOption, boolean> & {
  favoritesId: string | null;
  side: string;
  sideRooms: string;
  virtualKeyboard: string;
  template: string | null;
  productsFontSize: string;
  productsShortNameFontSize: string;
  roomsTablesColumns: number | null;
  roomsTablesColumnsHandheld: number | null;
  roomsGridZoomHandheld: number;
  quickDiscount: number | null;
  defaultPriceListId: string | null;
  priceLists: PosPriceList[];
};

/** The POS data of a user (`pos` of the API). */
export interface UserPos {
  enabled: boolean;
  grants: PosGrants;
  options: PosOptions;
}

/**
 * Dictionary segment of a catalog name: `discountMaxPercentage` is `DISCOUNT_MAX_PERCENTAGE`.
 *
 * @param name Camel-case name of a grant, preference, device or flag.
 */
export function posKey(name: string): string {
  return name.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
}
