import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { E_INVOICING_KEYS } from './company-paths.ts';
import { COMPANY_FIELD_KINDS, PLACE_FIELD_KINDS, checkFields, requireFields } from './fields.ts';
import type { NewCompanyFields, NewPlaceFields } from './fields.ts';
import { InvalidWriteInputError } from './errors.ts';

/** Name of the first storage of a new place when the caller gives none. */
export const DEFAULT_STORAGE_NAME = 'Deposito 1';

/** Time zone of a new place when the caller gives none (the legacy wizard's default, needed by the e-mails of the integration service). */
export const DEFAULT_TIMEZONE = 'Europe/Rome';

/** Day of the week `0` (Sunday) to `6`: the keys of `openingTime.weekGeneric`, each `{ active, values }`. */
const WEEK_DAYS = ['0', '1', '2', '3', '4', '5', '6'] as const;

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

/**
 * Blocks of a new place the write service does not own, as the intended form of the legacy `insertOne` with an empty body: all the
 * blocks the POS and the legacy read without checks, with the defaults of the legacy (`false`, `null`, empty lists, fonts, texts).
 * The values the legacy copied from a wrong field are not reproduced (`doc/Tasks.md` 5.6.3): `platform` is `{ sentry: false }`
 * (the legacy wrote `{ ip: <sentry> }`), `roomsSettings.reservation.suspendedToday` and `untilHours` are their own defaults, the
 * web widget has its own `color` and `brightness`, and `floodPay.stripe` its own `null` keys. The optional blocks (`kiosk`, `fidelity`,
 * `tgm`, `payments`) are absent, as in the legacy when the client does not send them.
 *
 * @returns Fresh objects on every call.
 */
function placeBlocks(): Document {
  const week: Document = {};
  for (const day of WEEK_DAYS) {
    week[day] = { active: false, values: [] };
  }
  return {
    openingTime: { daySpecial: {}, weekGeneric: week },
    platform: { sentry: false },
    server: { ip: null },
    connectorAddress: null,
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
      receiptsCancellation: null,
      priceLists: [],
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
      invoiceQt: 0,
      noFiscalBottomText: null,
      noFiscalDefaultNoPrint: false,
      noFiscalHeader: false,
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
      sequentialNumberFontSize: '1-2',
      bottomTextFontSize: '1-1',
      customerDataFontSize: '1-1',
      bottomText: null,
    },
    ordering: {
      printStationFontSize: '1-1',
      deviceFontSize: '1-1',
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
      notesFontSize: '1-1',
      productsSorting: 'cart',
      categoriesGropus: false,
      mergeProductsPrint: false,
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
    },
    roomsSettings: {
      exits: false,
      proceedNoPrint: false,
      exitsNumber: null,
      urersLoginRequiredToTableDesk: false,
      urersLoginRequiredToTable: false,
      tableSeats: false,
      tableUserSelect: false,
      tableUserSelectPin: false,
      tableUserSelectEachOpening: false,
      exclusiveUserTable: false,
      waitingPaymentTableStatus: false,
      prebillingRequestTableStatus: false,
      delivery: false,
      deliveryAutoOrderingTime: null,
      deliverySendPrebillingOnSave: false,
      sendOrderPrebilling: false,
      halfPortionValue: null,
      halfPortionVariantsValue: null,
      tableGroups: { status: false, name: false, mergeProductsPrint: false, autoCreateFirst: false },
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
    deliveryTakeAway: {
      status: false,
      deliveryListId: null,
      takeAwayListId: null,
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
    },
    delivery: {
      time: { daySpecial: {}, weekGeneric: {} },
      step: null,
      maxContemporary: null,
      radius: null,
      margin: null,
      minAmount: {},
      lat: null,
      lng: null,
    },
    externalDisplay: { tips: false, receiptType: false, fidelity: false, backgroundColor: '#8936F7', textColor: '#F8F9FA' },
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
        geo: { latitude: null, longitude: null, address: { streetAddress: null, locality: null, postalCode: null, country: null } },
      },
      easyappear: { status: false, appToken: null },
      leggimenu: { status: false, apiKey: null },
      yellgo: { status: false, apiKey: null },
      plateform: { status: false, locationId: null, username: null, password: null },
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
 * Builds the document of a new place in the format of the legacy (`doc/Tasks.md` 5.6.3): the owned fields from the caller, validated, and the
 * complete template of the blocks the legacy reads without checks ({@link placeBlocks}). There is exactly one storage, `{ id, name, cash: true,
 * ecommerce: false }` (a place without a cash storage leaves the stock movements without a storage), with a new `ObjectId` as `id`;
 * `openingTime.weekGeneric` has the seven days `{ active: false, values: [] }`; `timezone` is `Europe/Rome` unless given. `status` is explicit,
 * `trash` is `false`, both dates are `now`. The group is always the one of the verified access.
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
  return {
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
    medias: {},
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
    advancedReport: blocks['advancedReport'],
    appointment: blocks['appointment'],
    deliveryTakeAway: blocks['deliveryTakeAway'],
    delivery: blocks['delivery'],
    externalDisplay: blocks['externalDisplay'],
    integrations: blocks['integrations'],
    status: true,
    expirationDate: null,
    trash: false,
    insertDate: now,
    updateDate: now,
    ...fields,
  };
}
