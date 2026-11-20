import type { Role } from '../../shared/security/rbac/permissions.ts';

/**
 * The point-of-sale (POS) data of a user: the legacy `permissions.apps.cash` object (`status`, `sub` and `options`).
 * This file is its catalog: the domain names, the legacy keys they stand for and the values each accepts.
 * It holds no logic beyond the defaults.
 */

/**
 * The boolean grants of the legacy `sub` object as `[domain name, legacy key]`. The domain names are clear English; the legacy keys are kept
 * exactly as stored, typos included (`preblling`, `roomsOnlyHigherSeatsQunatity`), because the POS and the legacy backoffice read them.
 */
export const POS_GRANT_KEYS = Object.freeze([
  ['fiscalClosure', 'posClosure'],
  ['discount', 'discount'],
  ['discountReason', 'discountReason'],
  ['priceChange', 'prices'],
  ['onlyHigherPrice', 'onlyHigherPrice'],
  ['invoices', 'invoices'],
  ['freeSale', 'freeSale'],
  ['contacts', 'contacts'],
  ['bypassAutomaticCash', 'bypassAutomaticCash'],
  ['deleteUserShiftDetail', 'deleteUserShiftDetail'],
  ['receiptCancellation', 'receiptCancellation'],
  ['selectSaleUser', 'selectUserSale'],
  ['manageService', 'manageService'],
  ['printPrebill', 'preblling'],
  ['printReceipt', 'receipt'],
  ['tableCheckoutActiveDesk', 'tableCheckoutActiveDesk'],
  ['deleteTable', 'deleteTable'],
  ['deleteTableReason', 'deleteTableReason'],
  ['deleteTableProduct', 'deleteTableProduct'],
  ['deleteTableProductReasonNotSent', 'deleteTableProductReasonNotSent'],
  ['deleteTableProductReasonSent', 'deleteTableProductReasonSent'],
  ['tablePrebillActions', 'tablePrebillingActions'],
  ['roomsTableQuickTotals', 'roomsTableViewQuickTotals'],
  ['roomsRoomsPrices', 'roomsRoomsViewPrices'],
  ['roomsTablePrices', 'roomsTableViewPrices'],
  ['roomsOnlyHigherSeatsQuantity', 'roomsOnlyHigherSeatsQunatity'],
  ['editSentWeightQuantity', 'editQuantitySentWeightProduct'],
  ['advancedReport', 'advancedReport'],
  ['advancedReportPin', 'advancedReportPin'],
  ['reworkSale', 'reworkSale'],
  ['sentProducts', 'sentProducts'],
  ['notSentProducts', 'notSentProducts'],
  ['lockProducts', 'lockProducts'],
  ['tableEngage', 'tableEngage'],
  ['tableMerge', 'tableMerge'],
  ['tableSplit', 'tableSepare'],
  ['tableClose', 'tableClose'],
  ['checkoutPartition', 'checkoutPartition'],
  ['checkoutSeparation', 'checkoutSeparation'],
  ['moveProducts', 'moveProducts'],
  ['unlockTable', 'unlockTable'],
  ['resendProducts', 'resendProducts'],
  ['searchProducts', 'searchProducts'],
  ['rider', 'rider'],
  ['cashEnabled', 'cashEnabled'],
  ['handheldEnabled', 'handheldEnabled'],
  ['handheldWallet', 'handheldWallet'],
] as const);

/**
 * The grants that are on when the document has no value for them (the legacy form reads them with `!== false`): the user may use the cash desk (`cashEnabled`) and the handheld
 * (`handheldEnabled`) unless the document says otherwise. Every other grant is off when missing.
 */
export const POS_GRANTS_ON_BY_DEFAULT = Object.freeze(['cashEnabled', 'handheldEnabled'] as const);

/** A boolean grant of the POS, by its domain name. */
export type PosFlag = (typeof POS_GRANT_KEYS)[number][0];

/** The domain names of the boolean grants. */
export const POS_FLAGS: readonly PosFlag[] = Object.freeze(POS_GRANT_KEYS.map(([flag]) => flag));

/** The legacy key of each boolean grant. */
export const POS_LEGACY_KEY: Readonly<Record<PosFlag, string>> = Object.freeze(Object.fromEntries(POS_GRANT_KEYS) as Record<PosFlag, string>);

/** Legacy key of the percentage cap of a discount (`sub.discountMaxPercentage`, 0 to 100, `null` for no cap). */
export const DISCOUNT_CAP_KEY = 'discountMaxPercentage';

/** Legacy key of the default service percentage of the user (`sub.service`, 0 to 100, `null` for none). */
export const SERVICE_PERCENTAGE_KEY = 'service';

/** The flags of each automatic cash device (`sub.automaticCash.<device>.<flag>`), with the legacy names. */
export const AUTOMATIC_CASH = Object.freeze({
  glory: ['withdrawal', 'deposit', 'archive', 'archiveAll', 'unlockNote', 'unlockCoin', 'collectVerify'],
  cashMatic: ['withdrawal', 'deposit', 'change', 'refill', 'archive', 'archiveAll'],
  vne: ['withdrawal', 'refill', 'archive', 'archiveAll', 'tools'],
  azkoyen: ['withdrawal', 'deposit', 'backoffice', 'status'],
  cashSystem: ['withdrawal'],
} as const);

/** An automatic cash device. */
export type AutomaticCashDevice = keyof typeof AUTOMATIC_CASH;

/** The devices, in the legacy order. */
export const AUTOMATIC_CASH_DEVICES = Object.freeze(Object.keys(AUTOMATIC_CASH) as AutomaticCashDevice[]);

/** The automatic cash grants of a user: every flag of every device. */
export type AutomaticCash = { readonly [D in AutomaticCashDevice]: { readonly [K in (typeof AUTOMATIC_CASH)[D][number]]: boolean } };

/** A partial automatic cash grant set, as a patch carries it. */
export type AutomaticCashPatch = { readonly [D in AutomaticCashDevice]?: { readonly [K in (typeof AUTOMATIC_CASH)[D][number]]?: boolean } };

/** What a user may do on the POS: the `sub` object of the legacy. */
export type PosGrants = { readonly [F in PosFlag]: boolean } & {
  /** Highest discount percentage the user may give (0 to 100); `null` means no cap. */
  readonly discountMaxPercentage: number | null;
  /** Default service percentage of the user (0 to 100); `null` means none. */
  readonly servicePercentage: number | null;
  readonly automaticCash: AutomaticCash;
};

/** The sides of the counter and of the rooms. */
export const POS_SIDES = ['dx', 'sx'] as const;
/** Kinds of virtual keyboard: none, popover with or without buffer, modal with or without buffer. */
export const POS_KEYBOARDS = ['', 'pb', 'p', 'mb', 'm'] as const;
/** The themes of the POS. */
export const POS_TEMPLATES = ['material-tealwhite-light', 'material-tealwhite-dark', 'material-whitepurple-light', 'material-whitepurple-dark'] as const;
/** Font sizes of the product buttons. */
export const POS_FONT_SIZES = ['s', 'm', 'l'] as const;
/** Columns of the table grid. */
export const POS_TABLE_COLUMNS = [4, 5, 6, 8] as const;
/** Columns of the table grid on a handheld. */
export const POS_HANDHELD_COLUMNS = [2, 3, 4] as const;
/** How the color of a product is shown: a colored line or a colored background. */
export const POS_COLOR_STYLES = ['line', 'fill'] as const;
/** Text zoom of the handheld in percent, in steps of 5. */
export const POS_TEXT_ZOOMS = [85, 90, 95, 100, 105, 110, 115, 120, 125] as const;
/** Layouts of the categories on the handheld: scrolling, slide-in or list. */
export const POS_CATEGORIES_LAYOUTS = ['scroll', 'slidein', 'list'] as const;
/** Rows of categories on the handheld. */
export const POS_CATEGORIES_ROWS = [1, 2] as const;
/** Columns of products on the handheld. */
export const POS_PRODUCTS_COLUMNS = [1, 2, 3, 4] as const;
/** Position of the order menu on the handheld. */
export const POS_MENU_POSITIONS = ['bottom', 'top'] as const;
/** Zoom levels of the room map on a handheld. */
export const POS_GRID_ZOOMS = [1, 1.5, 2, 2.5, 3] as const;

/** The boolean preferences of the POS (`options.<name>`); the domain name is the legacy one. */
export const POS_BOOLEAN_OPTIONS = Object.freeze([
  'extendedCart',
  'noSeparator',
  'skipCheckoutButton',
  'showLastSaleValue',
  'quickPriceList',
  'advancedDiscount',
  'productsPagination',
  'productsShortName',
  'invertedCart',
  'deskPrintOrderDefault',
  'deliveryTakeawayCompletedDefault',
  'deliveryTakeawayShowOrderDetailOnSave',
  'deliveryTakeawayShowProduction',
  'reducedProducts',
  'reducedProductsTable',
  'reducedTables',
  'enlargedCategories',
  'tableCartPriority',
  'sendOrderRemainButton',
  'viewTableStatus',
  'viewTableUser',
  'viewTableCustomer',
  'viewTableStartDate',
  'genericProductPriceFocus',
  'roomsGridActive',
  'roomsGridActionbarOpened',
  'removeFiltersProductSelect',
  'removeFiltersOnSearch',
  'darkMode',
  'departmentsDialog',
  'skipFiscalReceiptTypeRequest',
  'productsUppercase',
  'productsBold',
  'roomsLegend',
] as const);

/** A boolean preference of the POS. */
export type PosBooleanOption = (typeof POS_BOOLEAN_OPTIONS)[number];

/** A price list of a user: whether he can sell with it and whether it is the one he starts with (legacy `{ status, selected }`). */
export interface PosPriceList {
  readonly priceListId: string;
  readonly enabled: boolean;
  readonly isDefault: boolean;
}

/** The interface preferences of a user on the POS: the `options` object of the legacy. They are not permissions. */
export type PosOptions = { readonly [O in PosBooleanOption]: boolean } & {
  /** A favorites list of the group (`productsFavorites[].id`), `null` for none. */
  readonly favoritesId: string | null;
  readonly side: (typeof POS_SIDES)[number];
  readonly sideRooms: (typeof POS_SIDES)[number];
  readonly virtualKeyboard: (typeof POS_KEYBOARDS)[number];
  readonly template: (typeof POS_TEMPLATES)[number] | null;
  readonly productsFontSize: (typeof POS_FONT_SIZES)[number];
  readonly productsShortNameFontSize: (typeof POS_FONT_SIZES)[number];
  readonly roomsTablesColumns: (typeof POS_TABLE_COLUMNS)[number] | null;
  readonly roomsTablesColumnsHandheld: (typeof POS_HANDHELD_COLUMNS)[number] | null;
  readonly roomsGridZoomHandheld: (typeof POS_GRID_ZOOMS)[number];
  readonly productsColorStyle: (typeof POS_COLOR_STYLES)[number];
  readonly handheldTextZoom: (typeof POS_TEXT_ZOOMS)[number];
  readonly handheldCategoriesLayout: (typeof POS_CATEGORIES_LAYOUTS)[number];
  readonly handheldCategoriesRows: (typeof POS_CATEGORIES_ROWS)[number];
  readonly handheldProductsColumns: (typeof POS_PRODUCTS_COLUMNS)[number];
  readonly handheldMenuPosition: (typeof POS_MENU_POSITIONS)[number];
  /** Quick discount button, 0 to 100; `null` for none. */
  readonly quickDiscount: number | null;
  /** The price list the POS last started with (the POS writes it); `null` for none. */
  readonly defaultPriceListId: string | null;
  /** The price lists of the group the user can use; the legacy keeps them in a map by price list id. */
  readonly priceLists: readonly PosPriceList[];
};

/** The POS data of a user: the app switch, the grants and the preferences. */
export interface Pos {
  /** Whether the POS app is enabled for the user (`status`). */
  readonly enabled: boolean;
  readonly grants: PosGrants;
  readonly options: PosOptions;
}

/** A partial set of grants, as a patch carries it. */
export type PosGrantsPatch = { readonly [F in PosFlag]?: boolean | undefined } & {
  readonly discountMaxPercentage?: number | null | undefined;
  readonly servicePercentage?: number | null | undefined;
  readonly automaticCash?: AutomaticCashPatch | undefined;
};

/** A partial set of preferences, as a patch carries it: `priceLists`, when present, is the whole list. */
export type PosOptionsPatch = { readonly [K in keyof PosOptions]?: PosOptions[K] | undefined };

/** The POS part of a creation or a modification. */
export interface PosPatch {
  readonly enabled?: boolean | undefined;
  readonly grants?: PosGrantsPatch | undefined;
  readonly options?: PosOptionsPatch | undefined;
}

/**
 * Whether `value` is one of the listed ones.
 *
 * @param list The allowed values.
 * @param value The value to test.
 * @returns `true` when the value is one of the listed ones.
 */
export function isOneOf<const T extends readonly unknown[]>(list: T, value: unknown): value is T[number] {
  return list.includes(value);
}

/** Grants that a user of each role starts with in the legacy form: the app and these four (`discount`, `priceChange`, `invoices`, `freeSale`) for everybody but PSA and D. */
const STARTING_GRANTS: readonly PosFlag[] = ['discount', 'priceChange', 'invoices', 'freeSale'];

/** Every grant off, the two that are on by default too: the baseline of a creation, from which everything a new user holds is judged. */
function offGrants(): PosGrants {
  const flags = Object.fromEntries(POS_FLAGS.map((flag) => [flag, false])) as { [F in PosFlag]: boolean };
  const automaticCash = Object.fromEntries(
    AUTOMATIC_CASH_DEVICES.map((device) => [device, Object.fromEntries(AUTOMATIC_CASH[device].map((key) => [key, false]))]),
  ) as AutomaticCash;
  return { ...flags, discountMaxPercentage: null, servicePercentage: null, automaticCash };
}

/** The preferences of a new user: the defaults of the legacy form. */
export function defaultOptions(): PosOptions {
  const flags = Object.fromEntries(POS_BOOLEAN_OPTIONS.map((option) => [option, false])) as { [O in PosBooleanOption]: boolean };
  return {
    ...flags,
    favoritesId: null,
    side: 'dx',
    sideRooms: 'dx',
    virtualKeyboard: '',
    template: 'material-whitepurple-light',
    productsFontSize: 's',
    productsShortNameFontSize: 's',
    roomsTablesColumns: null,
    roomsTablesColumnsHandheld: null,
    roomsGridZoomHandheld: 2,
    productsColorStyle: 'line',
    handheldTextZoom: 100,
    handheldCategoriesLayout: 'scroll',
    handheldCategoriesRows: 2,
    handheldProductsColumns: 2,
    handheldMenuPosition: 'bottom',
    quickDiscount: null,
    defaultPriceListId: null,
    priceLists: [],
  };
}

/** A POS with everything off, the grants that are on by default included, and the default preferences: the baseline against which what a new user holds is judged. */
export function offPos(): Pos {
  return { enabled: false, grants: offGrants(), options: defaultOptions() };
}

/** A POS with the app off, no permission but the ones that are on by default (`cashEnabled`, `handheldEnabled`) and the default preferences: what a user without any POS data has. */
export function emptyPos(): Pos {
  const base = offPos();
  return { ...base, grants: { ...base.grants, ...Object.fromEntries(POS_GRANTS_ON_BY_DEFAULT.map((flag) => [flag, true])) } };
}

/**
 * The POS data a new user of a role starts with, as the legacy form sets them when the role is chosen: PSA and D have the app off and no grant;
 * every other role has the app on and the grants `discount`, `priceChange`, `invoices` and `freeSale`. The preferences are the defaults,
 * without price lists (the group's are added by the caller).
 *
 * @param role Role of the new user.
 */
export function defaultPos(role: Role): Pos {
  const base = emptyPos();
  if (role === 'PSA' || role === 'D') {
    return base;
  }
  return { ...base, enabled: true, grants: { ...base.grants, ...Object.fromEntries(STARTING_GRANTS.map((flag) => [flag, true])) } };
}

/** Stored prefix of the POS data inside a user document. */
export const POS_ROOT = 'permissions.apps.cash';

/** Stored path of the price lists of a user: a map by price list id, written as a whole. */
export const POS_PRICE_LISTS_PATH = `${POS_ROOT}.options.priceLists`;

/** Every stored path the backend writes for the POS of a user (`$set` of single paths, never the whole `permissions` object). */
export const POS_OWNED_FIELDS: readonly string[] = Object.freeze([
  `${POS_ROOT}.status`,
  ...POS_GRANT_KEYS.map(([, key]) => `${POS_ROOT}.sub.${key}`),
  `${POS_ROOT}.sub.${DISCOUNT_CAP_KEY}`,
  `${POS_ROOT}.sub.${SERVICE_PERCENTAGE_KEY}`,
  ...AUTOMATIC_CASH_DEVICES.flatMap((device) => AUTOMATIC_CASH[device].map((key) => `${POS_ROOT}.sub.automaticCash.${device}.${key}`)),
  ...POS_BOOLEAN_OPTIONS.map((option) => `${POS_ROOT}.options.${option}`),
  ...['favoritesId', 'side', 'sideRooms', 'virtualKeyboard', 'template', 'productsFontSize', 'productsShortNameFontSize', 'roomsTablesColumns', 'roomsTablesColumnsHandheld', 'roomsGridZoomHandheld', 'productsColorStyle', 'handheldTextZoom', 'handheldCategoriesLayout', 'handheldCategoriesRows', 'handheldProductsColumns', 'handheldMenuPosition', 'quickDiscount', 'defaultPriceListId'].map(
    (option) => `${POS_ROOT}.options.${option}`,
  ),
  POS_PRICE_LISTS_PATH,
]);
