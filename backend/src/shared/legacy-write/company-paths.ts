/**
 * The keys of the legacy `companies` document the backend owns below its top-level blocks (`doc/Tasks.md` area 6 and the legacy analysis
 * of the company, §1). Every key is written one by one with `$set` on its dotted path, never as the whole block, so the keys the backend does not know
 * (the ones the legacy or a future release adds) survive every write.
 */

/** Keys of `fattura_elettronica`: all strings (`''` when empty), all of them read by the legacy without checks. */
export const E_INVOICING_KEYS = Object.freeze([
  'hub',
  'IdTrasmittente_paese',
  'IdTrasmittente_codice',
  'codice_eori',
  'email',
  'codice_destinatario',
  'albo_professionale',
  'ap_numero_iscrizione',
  'ap_provincia',
  'ap_data_iscrizione',
  'rea_ufficio',
  'rea_numero',
  'rea_capitale_sociale',
  'rea_soci',
  'rea_liquidazione',
  'regime_fiscale',
] as const);

/** Keys of `settings.global`: the three switches of the customer app, the invoice discount lines and the last invoice number. */
export const SETTINGS_GLOBAL_KEYS = Object.freeze(['enableLoginSignup', 'showPrivacyPage', 'showTermsPage', 'discountLines', 'lastInvoiceNumber'] as const);

/** Keys of `settings.api`: the interface switch of the Cerved lookup. */
export const SETTINGS_API_KEYS = Object.freeze(['cerved'] as const);

/** The flags (booleans) of `settings.ecommerce`, in the order of the legacy form. */
export const ECOMMERCE_FLAGS = Object.freeze([
  'status',
  'showProductAvailability',
  'acceptOrderOutOfStock',
  'catalogMode',
  'notDisplayPrice',
  'onlyDiscountedPrice',
  'showDiscountPercentage',
  'showAddToCartInList',
  'showProductPreviewInList',
  'showShippingStep',
  'showPaymentStep',
  'enableGuestCheckout',
  'enableProductsImages',
  'enableProductsCategoriesImages',
  'enableProductsBrandsImages',
  'enableWishList',
  'enableCategoriesMenu',
  'enableBrandsMenu',
  'enableWidgetProductFeatured',
  'enableWidgetProductWishlist',
  'enableWidgetProductLastViewed',
  'enableWidgetProductsAlreadyOrdered',
  'enableWidgetProductsCategories',
  'enableFidelity',
] as const);

/** Keys of `settings.ecommerce`: the 24 flags, the price list (`listId`), the minimum order by currency (`minAmount`) and the quantity shown (`showProductRemainingQuantity`). */
export const SETTINGS_ECOMMERCE_KEYS = Object.freeze([...ECOMMERCE_FLAGS, 'listId', 'minAmount', 'showProductRemainingQuantity'] as const);

/** Keys of `medias.images`: two free texts and the two logos of the customer app (a stored file descriptor or `null`). */
export const MEDIA_IMAGE_KEYS = Object.freeze(['internalFileName', 'externalUrl', 'customersAppLogoLight', 'customersAppLogoDark'] as const);

/** The owned top-level keys that are written as a whole value (arrays and the numbering position). */
export const COMPANY_WHOLE_KEYS = Object.freeze(['invoicesPS', 'invoicesPSValues', 'banks', 'ticketsSuppliers'] as const);

/** Every owned leaf path below a block, as dotted paths (`fattura_elettronica.hub`, `settings.ecommerce.listId`, `medias.images.externalUrl`…). */
export const COMPANY_BLOCK_PATHS: readonly string[] = Object.freeze([
  ...E_INVOICING_KEYS.map((key) => `fattura_elettronica.${key}`),
  ...SETTINGS_GLOBAL_KEYS.map((key) => `settings.global.${key}`),
  ...SETTINGS_API_KEYS.map((key) => `settings.api.${key}`),
  ...SETTINGS_ECOMMERCE_KEYS.map((key) => `settings.ecommerce.${key}`),
  ...MEDIA_IMAGE_KEYS.map((key) => `medias.images.${key}`),
]);

/**
 * The containers that hold owned leaves, with the keys of each: when one is missing or empty in a stored company, a write completes it with the
 * defaults of the keys it does not set, so it never stays half built (the legacy and the POS read these blocks without checks).
 */
export const COMPANY_CONTAINERS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  fattura_elettronica: E_INVOICING_KEYS,
  'settings.global': SETTINGS_GLOBAL_KEYS,
  'settings.api': SETTINGS_API_KEYS,
  'settings.ecommerce': SETTINGS_ECOMMERCE_KEYS,
  'medias.images': MEDIA_IMAGE_KEYS,
});
