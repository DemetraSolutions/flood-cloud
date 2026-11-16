import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { E_INVOICING_KEYS } from './company-paths.ts';
import { WEEK_DAYS } from './place-paths.ts';
import { COMPANY_FIELD_KINDS, PLACE_FIELD_KINDS, checkFields, requireFields } from './fields.ts';
import type { NewCompanyFields, NewPlaceFields } from './fields.ts';
import { InvalidWriteInputError } from './errors.ts';

/** Name of the first storage of a new place when the caller gives none. */
export const DEFAULT_STORAGE_NAME = 'Deposito 1';

/** Time zone of a new place when the caller gives none (the legacy wizard's default, needed by the e-mails of the integration service). */
export const DEFAULT_TIMEZONE = 'Europe/Rome';

/**
 * The template of the blocks of a new company, as the intended form of the `insertOne` of the legacy and of its group wizard: every block complete (a
 * company with `settings: {}` makes the XML of the invoices and the POS crash), the e-invoicing keys as empty strings (`hub` is split by the sender of
 * the invoices), the regime `RF01`, the arrays empty, the numbering position `null`, the media with their four keys. The caller's values are put on top of it.
 *
 * @returns Fresh objects on every call (nothing is shared between documents).
 */
function companyBlocks(): Document {
  return {
    invoicesPS: null,
    invoicesPSValues: [],
    fattura_elettronica: Object.fromEntries(E_INVOICING_KEYS.map((key) => [key, key === 'regime_fiscale' ? 'RF01' : ''])),
    ticketsSuppliers: [],
    banks: [],
    settings: {
      global: { enableLoginSignup: false, showPrivacyPage: false, showTermsPage: false, discountLines: false, lastInvoiceNumber: null },
      api: { cerved: false },
      ecommerce: {
        status: false,
        listId: '',
        minAmount: {},
        showProductAvailability: false,
        showProductRemainingQuantity: 0,
        acceptOrderOutOfStock: false,
        catalogMode: false,
        notDisplayPrice: false,
        onlyDiscountedPrice: false,
        showDiscountPercentage: false,
        showAddToCartInList: false,
        showProductPreviewInList: false,
        showShippingStep: false,
        showPaymentStep: false,
        enableGuestCheckout: false,
        enableProductsImages: false,
        enableProductsCategoriesImages: false,
        enableProductsBrandsImages: false,
        enableWishList: false,
        enableCategoriesMenu: false,
        enableBrandsMenu: false,
        enableWidgetProductFeatured: false,
        enableWidgetProductWishlist: false,
        enableWidgetProductLastViewed: false,
        enableWidgetProductsAlreadyOrdered: false,
        enableWidgetProductsCategories: false,
        enableFidelity: false,
      },
    },
    medias: { images: { internalFileName: '', externalUrl: '', customersAppLogoLight: null, customersAppLogoDark: null } },
  };
}

/**
 * The default value of every key of a block (`fattura_elettronica`, `settings.global`, `settings.api`, `settings.ecommerce`, `medias.images`):
 * what a write puts in the keys it does not set when it finds the block missing or empty.
 *
 * @param container Dotted path of the block (a key of `COMPANY_CONTAINERS`).
 * @returns A fresh object.
 */
export function companyContainerDefaults(container: string): Document {
  let value: unknown = companyBlocks();
  for (const key of container.split('.')) {
    value = (value as Document)[key];
  }
  return value as Document;
}

/** Puts a value at a dotted path of a document built by this module (every step exists in the template of a company). */
function setPath(document: Document, path: string, value: unknown): void {
  const keys = path.split('.');
  const last = keys.pop() as string;
  let target = document;
  for (const key of keys) {
    target = target[key] as Document;
  }
  target[last] = value;
}

/**
 * Builds the document of a new company in the format of the legacy (`doc/Tasks.md` 5.6.3). The owned fields come from the caller, validated, each
 * at its place (the dotted ones inside their block, which exists with all its keys); the rest is the intended form of the legacy `insertOne`, complete.
 * `status` is explicit (the legacy forces it to `true`, and so turns `false` into `true`: here `false` is kept), `trash` is `false`, `expirationDate` is `null` unless given
 * (never the epoch the legacy writes) and both dates are `now`. The group is always the one of the verified access, never a value of the input.
 *
 * @param id Id of the new company.
 * @param groupId Group of the verified access.
 * @param input The owned fields of the company: `name` is required.
 * @param now Insert and update date.
 * @returns A new document.
 * @throws {InvalidWriteInputError} If a field is not allowed or invalid, or the name is missing.
 */
export function newCompanyDocument(id: ObjectId, groupId: ObjectId, input: NewCompanyFields, now: Date): Document {
  const fields = checkFields(COMPANY_FIELD_KINDS, input);
  requireFields(fields, ['name']);
  const blocks = companyBlocks();
  const document: Document = {
    _id: id,
    groupId,
    name: '',
    code: '',
    code2: '',
    address: '',
    postcode: '',
    city: '',
    countryAreaCode: '',
    countryCode: 'IT',
    currencyCode: 'EUR',
    invoicesPS: blocks['invoicesPS'],
    invoicesPSValues: blocks['invoicesPSValues'],
    email: null,
    telephone: null,
    fattura_elettronica: blocks['fattura_elettronica'],
    ticketsSuppliers: blocks['ticketsSuppliers'],
    banks: blocks['banks'],
    settings: blocks['settings'],
    medias: blocks['medias'],
    status: true,
    trash: false,
    expirationDate: null,
    insertDate: now,
    updateDate: now,
  };
  for (const [path, value] of Object.entries(fields)) {
    setPath(document, path, value);
  }
  return document;
}

/** A reservation e-mail setting of a new place. */
const reservationEmail = (): Document => ({ status: false, templateId: null, subject: null });

/** The hours of a week with every day closed: the seven keys `0` to `6`, each `{ active: false, values: [] }`. */
const closedWeek = (): Document => Object.fromEntries(WEEK_DAYS.map((day) => [day, { active: false, values: [] }]));

/** The hours of a place with nothing set: the week closed and no special day (the form of `openingTime` and of `delivery.time` that the backoffice saves). */
const closedHours = (): Document => ({ weekGeneric: closedWeek(), daySpecial: {} });

/**
 * The keys of `roomsSettings` the backoffice still writes although the legacy replaced them (`delivery`, `deliveryAutoOrderingTime`,
 * `deliverySendPrebillingOnSave`, `tableGroupName` and `tableGroups.mergeProductsPrint`): copies of the keys of `deliveryTakeAway`, `roomsSettings.tableGroups`
 * and `ordering` they replaced, computed from them exactly as the form does, so a reader of the old keys and a reader of the new ones agree.
 *
 * @param deliveryTakeAway The `deliveryTakeAway` block.
 * @param ordering The `ordering` block.
 * @param tableGroups The `{ status, name, autoCreateFirst }` of the table groups.
 */
function deprecatedRoomsSettings(deliveryTakeAway: Document, ordering: Document, tableGroups: Document): Document {
  return {
    delivery: deliveryTakeAway['status'],
    deliveryAutoOrderingTime: deliveryTakeAway['autoOrderingTime'],
    deliverySendPrebillingOnSave: deliveryTakeAway['sendPrebillingOnSave'],
    tableGroupName: tableGroups['name'],
    tableGroups: { ...tableGroups, mergeProductsPrint: ordering['mergeProductsPrint'] },
  };
}

/**
 * The blocks of a new place, in the form the old backoffice saves (`PD.prepareData` of `views/places/detail`) with the value every field has when the form is empty: all the
 * blocks the POS and the legacy read without checks, with the defaults of the form (`false`, `null`, empty lists, fonts, texts, `exitsNumber` 5, `invoiceQt` 1, `numberFontSize`
 * `2-1`, `kiosk.mode` `sale`…). Nothing is copied from a wrong field as the `insertOne` of the legacy does: `platform` is `{ sentry: false }`, the reservation block has its own
 * `suspendedToday`, `untilHours` and web widget. `integrations` has the empty shape of the form: every switch off and no credential. The settings of step 7B are in here, complete,
 * so a place created now is a complete place; the caller's values are put on top of the blocks the backend owns.
 *
 * @returns Fresh objects on every call (nothing is shared between documents).
 */
function placeBlocks(): Document {
  const deliveryTakeAway: Document = {
    status: false,
    deliveryListId: '',
    takeAwayListId: '',
    autoOrderingTime: null,
    sendPrebillingOnSave: false,
    printOrderNumber: false,
    step: 900000,
    delivery: false,
    autoDeliveryCost: false,
    alertMaxDeliveryInStep: null,
    alertMaxTakeAwayInStep: null,
    roomsProductionCenterValue: false,
    callerRequired: false,
    fastTakeAway: false,
    sendOrderOnSave: 'ask',
    sendOrderOnSaveFast: 'ask',
    createOrderNumberOnSave: false,
    autoOrderStatusComplete: false,
    shippingCosts: [],
  };
  const ordering: Document = {
    printStationFontSize: '1-1',
    deviceFontSize: '1-1',
    numberFontSize: '2-1',
    piecesFontSize: '1-1',
    seatsFontSize: '1-1',
    titleFontSize: '1-2',
    tableFontSize: '1-2',
    exitsFontSize: '1-2',
    customerNameFontSize: '1-1',
    callerFontSize: '1-1',
    involvedStationsFontSize: '1-1',
    titleReverse: false,
    categoriesGropusFontSize: '1-2',
    productsSorting: 'cart',
    categoriesGropus: false,
    productsFontSize: '1-1',
    variantsFontSize: '1-1',
    summaryProductsFontSize: '1-1',
    summaryVariantsFontSize: '1-1',
    startReturnNumber: 0,
    endReturnNumber: 0,
    tableText: null,
    deskText: null,
    takeAwayText: null,
    deliveryText: null,
    variantPlusText: null,
    variantMinusText: null,
    variantInfoText: null,
    exitText: null,
    proceedText: null,
    removalText: null,
    moveText: null,
    additionText: null,
    resendText: null,
    changeOrderText: null,
    cancellationOrderText: null,
    noteText: null,
    tableNoteText: null,
    orderNoteText: null,
    quiklyText: null,
    involvedStationsText: null,
    noRemoval: false,
    noRemovalOnDeleteTable: false,
    noRemovalOnDeleteOrder: false,
    device: false,
    printStation: false,
    priceListName: false,
    mergeProductsPrint: false,
    roomName: false,
    total: false,
    totalPc: false,
    allPrices: false,
    seatsNumber: false,
    productsProceed: false,
    firstExitOnExitsCut: false,
    sequentialNumberTop: false,
    sequentialNumberBottom: false,
    roomsSequentialNumberTop: false,
    roomsSequentialNumberBottom: false,
    shortName: false,
    shortDescription: false,
    note: false,
    tableNote: false,
    printStationsInvolved: false,
    tableBottom: false,
    additionInfo: false,
    productsSpace: false,
    summaryExits: false,
    move: false,
    partialMoveProducts: false,
    contactInfo: false,
    tableUser: false,
    productsBold: false,
    productsCode: false,
  };
  const tableGroups: Document = { status: false, name: false, autoCreateFirst: false };
  return {
    medias: {
      images: {
        internalFileNameLogo: '',
        externalUrlLogo: '',
        internalFileName: '',
        externalUrl: '',
        logoLight: null,
        coverLight: null,
        logoKiosk: null,
        coverKiosk: null,
        productPlaceholderKiosk: null,
      },
    },
    openingTime: closedHours(),
    platform: { sentry: false },
    server: { ip: null },
    connectorAddress: '',
    general: {
      fastLogin: false,
      urersLoginRequiredToReceipt: false,
      urersLoginRequiredToReceiptOnlyDesk: false,
      singleCartRow: false,
      totalPriceCartRow: false,
      combinesVariantsPrice: false,
      logs: false,
      workshift: false,
      workshiftNames: [],
      usersShifts: false,
      usersShiftsPrintReceipt: false,
      noTaxedProductsPrintReceipt: false,
      onlyNoTaxedProductsPrintReceipt: false,
      noTaxedProductsSummaryPrintReceipt: false,
      returnedGoods: false,
      checkoutContactNote: false,
      productVariantsQuantity: false,
      chargeDocument: false,
      chargeDocumentQt: 1,
      productsWeightKg: false,
      discountPercentageOnlyNoDiscount: false,
      resetPriceListOnSale: false,
      deskBackoffice: false,
      localWarehouse: false,
      localWarehouseOutOfStock: 'disabled',
      simpleWarehouse: false,
      totalRounding: null,
      operatingTime: null,
      customDiscount: null,
      priceLists: [],
      receiptsCancellation: null,
    },
    paymentTypes: [],
    receipt: {
      user: false,
      barcode: false,
      mergedVariants: false,
      seatsTop: false,
      serviceTop: false,
      subtotalServiceBottom: false,
      noPrintPrice0Products: false,
      price0ProductsBottom: false,
      printReceiptCopy: false,
      printDivisionNumber: false,
      printPriceLists: false,
      printUnpaidReceipt: false,
      unpaidReceiptCustomerRequired: false,
      subtotalFontSize: '1-1',
      note: false,
      invoice: false,
      invoiceQt: 1,
      noFiscalBottomText: null,
      noFiscalDefaultNoPrint: false,
      noFiscalHeader: false,
      noFiscalTaxes: false,
      noFiscalTaxesTotal: false,
      noFiscalRest: false,
      giftReceipt: false,
      serverPrint: false,
      verifyClousures: false,
    },
    prebilling: {
      header: false,
      printMergedVariants: false,
      noPrintPrice0Products: false,
      printCategoriesTotalizers: false,
      printTableUser: false,
      printUser: false,
      titleText: null,
      titleFontSize: '1-2',
      sequentialNumberFontSize: '1-1',
      bottomTextFontSize: '1-1',
      customerDataFontSize: '1-1',
      bottomText: null,
    },
    ordering,
    roomsSettings: {
      exits: false,
      proceedNoPrint: false,
      exitsNumber: 5,
      urersLoginRequiredToTableDesk: false,
      urersLoginRequiredToTable: false,
      tableSeats: false,
      tableUserSelect: false,
      tableUserSelectPin: false,
      tableUserSelectEachOpening: false,
      exclusiveUserTable: false,
      waitingPaymentTableStatus: false,
      prebillingRequestTableStatus: false,
      sendOrderPrebilling: false,
      halfPortionValue: null,
      halfPortionVariantsValue: null,
      ...deprecatedRoomsSettings(deliveryTakeAway, ordering, tableGroups),
      deskCheckoutPrintersPriority: false,
      checkoutTableValue0: false,
      waitingList: false,
      discountTicketsDifference: false,
      handheldReceiptRequestDelegate: false,
      roomsGridHandhelds: false,
      resetDeskNumber: null,
      resetRoomsNumber: null,
      resetDeliveryNumber: null,
      tipValues: [],
      reservation: {
        status: false,
        timeBlocks: [],
        step: 900000,
        duration: 1800000,
        suspendedToday: false,
        untilHours: null,
        webWidget: { status: false, color: '#000000', brightness: 'light' },
        emailNotification: { status: false, to: null, templateId: null, subject: null },
        email: reservationEmail(),
        emailConfirmedStatus: reservationEmail(),
        emailRefusedStatus: reservationEmail(),
        emailChangeStatus: reservationEmail(),
      },
    },
    selfOrdering: { status: false, fixedMessage: null, additionalInfoLabel: null, additionalInfo: null, priceListsConfig: {} },
    payments: { defaultType: 'cash', cheque: false, tickets: false, paymentDiscount: false },
    externalDisplay: { tips: false, receiptType: false, fidelity: false, backgroundColor: '#8936F7', textColor: '#F8F9FA' },
    advancedReport: { logs: false },
    appointment: {
      staffChoice: false,
      staffChoiceRequired: false,
      step: null,
      maxContemporary: null,
      maxDaily: null,
      type: 'single',
      webWidgetStatus: false,
      email: { templateId: null, from: null, subject: null },
    },
    deliveryTakeAway,
    kiosk: {
      listId: null,
      mode: 'sale',
      eatHere: false,
      takeAway: false,
      deskPay: false,
      posPay: false,
      catalogLayout: 'cols-4',
      hideCategories: false,
      hideNotAvailableProducts: false,
      hidePhotos: false,
      productVariants: false,
      quickAddToCart: false,
      upsellingCategoryId: null,
      productsCategories: [],
      unpaidNotPrint: false,
      prebillingDeskPay: false,
      prebillingPosPay: false,
      printOrderCheckoutDefault: false,
      autoOrderStatusComplete: false,
      paperReceipt: false,
      eReceiptEmail: false,
      eReceiptQr: false,
      paymentsCards: false,
      paymentsCash: false,
      paymentsSatispay: false,
      tablePlaceholder: 'none',
      tablePlaceholderType: 'table',
      takeawayPlaceholder: 'none',
      takeawayPlaceholderType: 'pager',
      manageFidelity: false,
      backgroundColor: '#8936F7',
      textColor: '#F8F9FA',
      categoriesIcons: false,
      titleText: { it: '' },
      subTitleText: { it: '' },
      startButtonText: { it: '' },
      eatHereText: { it: '' },
      takeAwayText: { it: '' },
      idleTimeAlert: null,
      closeSessionTime: null,
    },
    fidelity: { type: null, showPoints: false, showPointsCheckout: false, printDataOnFiscalReceipt: false, printDataOnReceipt: false },
    tgm: { status: false, companyId: null, placeId: null, printProductsOnReceipt: false, winningsManagement: false },
    delivery: { time: closedHours(), step: null, maxContemporary: null, radius: null, margin: null, minAmount: {}, lat: null, lng: null },
    integrations: {
      floodPay: {
        status: false,
        stripe: { publicKey: null, privateKey: null, webhookPrivateKey: null },
        qrCodePayment: { status: false, type: 'static', rating: false, eReceipt: false, tips: false, postPaymentText: null },
        tapToPay: { status: false, tips: false },
      },
      bizerba: { status: false, importPath: null, exportPath: null },
      googleMaps: { status: false },
      reserveWithGoogle: {
        status: false,
        category: 'restaurant',
        name: null,
        telephone: null,
        url: null,
        geo: { latitude: null, longitude: null, address: { streetAddress: null, locality: null, postalCode: null, country: 'IT' } },
      },
      easyappear: { status: false, appToken: null },
      yellgo: { status: false, apiKey: null },
      leggimenu: { status: false, apiKey: null },
      plateform: { status: false, username: null, password: null },
      cooperto: { status: false, apiKey: null },
      dojo: { status: false, apiKey: null },
      satispay: { status: false, activationCode: null, keyId: null, type: 'checkin' },
      qodeup: { status: false, apiKey: null },
      tomatoai: { status: false, apiKey: null },
      keenon: { status: false, storeId: null },
      tsh: { status: false, testMode: false, id: null, secret: null, propertyId: null, serviceName: null, categoriesMap: {}, tshCategories: [] },
      phlex: { status: false, username: null, password: null, structureId: null },
    },
  };
}

/**
 * The default value of every key of a block a write completes (`platform`, `general`, `openingTime`, `delivery` and `delivery.time`, see `PLACE_CONTAINERS`): what a write puts in
 * the keys it does not set when it finds the block missing or empty.
 *
 * @param container Dotted path of the block.
 * @returns A fresh object.
 */
export function placeContainerDefaults(container: string): Document {
  let value: unknown = placeBlocks();
  for (const key of container.split('.')) {
    value = (value as Document)[key];
  }
  return value as Document;
}

/** The plan of a new place when the caller gives none, and the one a group administrator gets: the plan every group has (`basic`). */
export const DEFAULT_PLAN = 'basic';

/**
 * Builds the document of a new place in the format the old backoffice saves (`doc/Tasks.md` 5.6.3 and area 7, step 7A): the owned fields from the caller, validated, each at its
 * place (the dotted ones inside their block), and the complete template of the blocks ({@link placeBlocks}), so a place created now is complete and the POS, the legacy and the
 * integrations read it without checks. There is exactly one storage, `{ id, name, cash: true, ecommerce: false }` (a place without a cash storage leaves the stock movements without
 * a storage), with a new `ObjectId` as `id`; `openingTime.weekGeneric` and `delivery.time.weekGeneric` have the seven days `{ active: false, values: [] }`; `timezone` is `Europe/Rome`
 * and `plan` `basic` unless given. `status` is explicit (`false` is kept), `expirationDate` is `null` unless given (never the epoch), `trash` is `false`, both dates are `now`.
 * The group is always the one of the verified access.
 *
 * @param id Id of the new place.
 * @param groupId Group of the verified access.
 * @param input The owned fields: `name` and `companyId` are required (`storageName` names the first storage).
 * @param now Insert and update date.
 * @returns A new document.
 * @throws {InvalidWriteInputError} If a field is not allowed or invalid, a required one is missing, or the storage name is not a non-empty string.
 */
export function newPlaceDocument(id: ObjectId, groupId: ObjectId, input: NewPlaceFields, now: Date): Document {
  const { storageName = DEFAULT_STORAGE_NAME, ...rest } = input;
  if (typeof storageName !== 'string' || storageName.trim() === '') {
    throw new InvalidWriteInputError('Invalid value for a field', 'storageName');
  }
  const fields = checkFields(PLACE_FIELD_KINDS, rest);
  requireFields(fields, ['name', 'companyId']);
  const blocks = placeBlocks();
  const document: Document = {
    _id: id,
    groupId,
    companyId: fields['companyId'],
    listId: null,
    ecommerceListId: null,
    name: '',
    address: '',
    postcode: '',
    city: '',
    countryAreaCode: '',
    countryCode: 'IT',
    contact: '',
    email: '',
    telephone: '',
    invoicePS: null,
    medias: blocks['medias'],
    devices: [],
    rooms: [],
    storages: [{ id: new ObjectId(), name: storageName, cash: true, ecommerce: false }],
    printStations: [],
    productionCenter: [],
    openingTime: blocks['openingTime'],
    timezone: DEFAULT_TIMEZONE,
    platform: blocks['platform'],
    server: blocks['server'],
    connectorAddress: blocks['connectorAddress'],
    general: blocks['general'],
    paymentTypes: blocks['paymentTypes'],
    receipt: blocks['receipt'],
    prebilling: blocks['prebilling'],
    ordering: blocks['ordering'],
    roomsSettings: blocks['roomsSettings'],
    selfOrdering: blocks['selfOrdering'],
    payments: blocks['payments'],
    externalDisplay: blocks['externalDisplay'],
    advancedReport: blocks['advancedReport'],
    appointment: blocks['appointment'],
    deliveryTakeAway: blocks['deliveryTakeAway'],
    kiosk: blocks['kiosk'],
    fidelity: blocks['fidelity'],
    tgm: blocks['tgm'],
    delivery: blocks['delivery'],
    integrations: blocks['integrations'],
    status: true,
    plan: DEFAULT_PLAN,
    expirationDate: null,
    trash: false,
    insertDate: now,
    updateDate: now,
  };
  for (const [path, value] of Object.entries(fields)) {
    setPath(document, path, value);
  }
  return document;
}
