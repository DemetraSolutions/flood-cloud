/** The postal address of a company. A value the stored document lacks or holds with a wrong type reads as `null`. */
export interface CompanyAddress {
  readonly street: string | null;
  readonly postcode: string | null;
  readonly city: string | null;
  /** The province or area code of the country (`MI`); `''` when the company has none. */
  readonly province: string | null;
  /** ISO 3166-1 alpha-2 country code. */
  readonly country: string | null;
}

/** The registration of the company in the professional register (`albo professionale`) of the e-invoice. */
export interface ProfessionalRegister {
  readonly name: string | null;
  readonly number: string | null;
  /** Italian province code. */
  readonly province: string | null;
  /** `YYYY-MM-DD`. */
  readonly date: string | null;
}

/** The registration of the company in the business register (REA) of the e-invoice. */
export interface Rea {
  /** Italian province code of the office. */
  readonly office: string | null;
  readonly number: string | null;
  /** The share capital as a decimal text. */
  readonly shareCapital: string | null;
  /** `SU` (single member) or `SM` (several members). */
  readonly shareholders: string | null;
  /** `LS` (in liquidation) or `LN` (not in liquidation). */
  readonly liquidation: string | null;
}

/** The e-invoicing data of a company (legacy `fattura_elettronica`): every value is a string in the document and reads as `null` when empty. */
export interface EInvoicing {
  /** `aruba`, `aruba__<id of a dealer>` or `null` for none. */
  readonly hub: string | null;
  readonly transmitter: { readonly country: string | null; readonly code: string | null };
  readonly eori: string | null;
  /** The certified e-mail address. */
  readonly pec: string | null;
  /** The recipient code (six or seven characters). */
  readonly recipientCode: string | null;
  readonly professionalRegister: ProfessionalRegister;
  readonly rea: Rea;
  /** `RF01`…`RF19`. */
  readonly taxRegime: string | null;
}

/** A series (prefix or suffix) of the invoice numbers. */
export interface InvoiceSeries {
  readonly name: string;
  /** Whether the series is the one of the cash sales (at most one). */
  readonly cash: boolean;
}

/** The numbering of the invoices and the invoice switches of the company. */
export interface InvoiceNumbering {
  /** Whether the series goes before or after the number, `null` when not set. */
  readonly position: 'prefix' | 'suffix' | null;
  readonly values: readonly InvoiceSeries[];
  /** The last invoice number used (an Int32), `null` when none. */
  readonly lastInvoiceNumber: number | null;
  readonly discountLines: boolean;
  /** The interface switch of the Cerved lookup of the POS. */
  readonly cervedLookup: boolean;
}

/** A bank account of the company, as the invoices print it. */
export interface BankAccount {
  readonly id: string;
  readonly name: string;
  readonly iban: string;
  readonly abi: string | null;
  readonly cab: string | null;
  readonly bic: string | null;
  readonly default: boolean;
}

/** A meal voucher issuer, with the cuts of its vouchers (`null` is a free amount). */
export interface MealVoucherIssuer {
  readonly id: string;
  readonly name: string;
  readonly cuts: readonly (number | null)[];
}

/** The flags and numbers of the e-commerce of the customer app (legacy `settings.ecommerce`). */
export interface Ecommerce {
  readonly status: boolean;
  /** Id of an active price list of the group, `null` for none. */
  readonly priceListId: string | null;
  /** The minimum order by currency code. */
  readonly minimumOrder: Readonly<Record<string, number>>;
  readonly showProductRemainingQuantity: number;
  readonly showProductAvailability: boolean;
  readonly acceptOrderOutOfStock: boolean;
  readonly catalogMode: boolean;
  readonly notDisplayPrice: boolean;
  readonly onlyDiscountedPrice: boolean;
  readonly showDiscountPercentage: boolean;
  readonly showAddToCartInList: boolean;
  readonly showProductPreviewInList: boolean;
  readonly showShippingStep: boolean;
  readonly showPaymentStep: boolean;
  readonly enableGuestCheckout: boolean;
  readonly enableProductsImages: boolean;
  readonly enableProductsCategoriesImages: boolean;
  readonly enableProductsBrandsImages: boolean;
  readonly enableWishList: boolean;
  readonly enableCategoriesMenu: boolean;
  readonly enableBrandsMenu: boolean;
  readonly enableWidgetProductFeatured: boolean;
  readonly enableWidgetProductWishlist: boolean;
  readonly enableWidgetProductLastViewed: boolean;
  readonly enableWidgetProductsAlreadyOrdered: boolean;
  readonly enableWidgetProductsCategories: boolean;
  readonly enableFidelity: boolean;
}

/** The settings of the customer app. */
export interface CustomerApp {
  readonly enableLoginSignup: boolean;
  readonly showPrivacyPage: boolean;
  readonly showTermsPage: boolean;
  readonly ecommerce: Ecommerce;
}

/** The descriptor of a logo file as the legacy media manager stores it; a value the stored descriptor lacks reads as `null`. Any other key of the stored object is never returned. */
export interface MediaLogo {
  readonly _id: string | null;
  readonly basename: string | null;
  readonly extension: string | null;
  readonly filename: string | null;
  readonly mimetype: string | null;
  readonly title: string | null;
  readonly alt: string | null;
  readonly dirname: string | null;
  readonly type: string | null;
  readonly filectime: number | null;
}

/** The media of the company (legacy `medias.images`). */
export interface CompanyMedia {
  readonly internalFileName: string;
  readonly externalUrl: string;
  readonly customersAppLogoLight: MediaLogo | null;
  readonly customersAppLogoDark: MediaLogo | null;
}

/** A company as the API shows it: the whole legacy document, in the English names of the domain. Unknown keys of the document are never in it. */
export interface Company {
  readonly id: string;
  readonly groupId: string;
  readonly name: string | null;
  /** Legacy `code`. */
  readonly vatNumber: string | null;
  /** Legacy `code2`; `''` and `null` read as `null`. */
  readonly fiscalCode: string | null;
  readonly address: CompanyAddress;
  readonly currency: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly status: 'active' | 'disabled';
  readonly trashed: boolean;
  /** When the company went to the trash (ISO 8601); `null` when it is not there or the legacy trashed it (informational only). */
  readonly trashedAt: string | null;
  /** ISO 8601 instant, `null` for none. */
  readonly expirationDate: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly eInvoicing: EInvoicing;
  readonly invoiceNumbering: InvoiceNumbering;
  readonly bankAccounts: readonly BankAccount[];
  readonly mealVoucherIssuers: readonly MealVoucherIssuer[];
  readonly customerApp: CustomerApp;
  readonly media: CompanyMedia;
}

/** A company of the compact list. */
export interface CompanySummary {
  readonly id: string;
  readonly name: string;
  readonly vatNumber: string | null;
  readonly city: string | null;
  readonly province: string | null;
  readonly country: string | null;
  readonly status: 'active' | 'disabled';
  readonly trashed: boolean;
  /** When the company went to the trash (ISO 8601), `null` when unknown. */
  readonly trashedAt: string | null;
}

/** A company of the list across groups: the compact item plus the group it belongs to. */
export interface CrossGroupCompany extends CompanySummary {
  readonly groupId: string;
  /** Name of the group, `null` when the group is missing. */
  readonly groupName: string | null;
}

/** A bank account in a request: the id is the one the company already has, or absent for a new account; empty codes are `null`. */
export interface BankAccountInput {
  readonly id?: string;
  readonly name: string;
  readonly iban: string;
  readonly abi: string | null;
  readonly cab: string | null;
  readonly bic: string | null;
  readonly default: boolean;
}

/** A meal voucher issuer in a request. */
export interface MealVoucherIssuerInput {
  readonly id?: string;
  readonly name: string;
  readonly cuts: readonly (number | null)[];
}

/** Every key optional at every level; arrays are replaced whole, so they are kept as they are. */
export type DeepPartial<T> = T extends readonly unknown[] ? T : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

/** A logo in a request that picks an image of the group: `imageId` is the id of a `files` document of the same group that is not in the trash. The server builds the descriptor. */
export interface ImageReference {
  readonly imageId: string;
}

/** The media in a request: a logo is `null` (remove it), the descriptor the company already has (sent back as it is) or an {@link ImageReference}. */
export interface CompanyMediaInput {
  readonly internalFileName: string;
  readonly externalUrl: string;
  readonly customersAppLogoLight: MediaLogo | ImageReference | null;
  readonly customersAppLogoDark: MediaLogo | ImageReference | null;
}

/** What a request can write of a company: everything of {@link Company} but the read-only fields, with the lists and the media in their request form. */
export type CompanyWritable = Omit<Company, 'id' | 'groupId' | 'trashed' | 'trashedAt' | 'createdAt' | 'updatedAt' | 'bankAccounts' | 'mealVoucherIssuers' | 'media'> & {
  readonly bankAccounts: readonly BankAccountInput[];
  readonly mealVoucherIssuers: readonly MealVoucherIssuerInput[];
  readonly media: CompanyMediaInput;
};

/** The body of a modification: any subset of the fields and of the blocks, each block any subset of its fields. */
export type CompanyPatch = DeepPartial<CompanyWritable>;

/** The body of a creation: the general data (the address without a province is allowed) and, optionally, any other field. */
export type CompanyCreation = CompanyPatch & {
  readonly name: string;
  readonly vatNumber: string;
  readonly address: { readonly street: string; readonly postcode: string; readonly city: string; readonly country: string; readonly province?: string };
};
