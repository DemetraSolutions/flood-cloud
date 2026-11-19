/** Status of a company. */
export type CompanyStatus = 'active' | 'disabled';

/** A company as listed by `GET /v1/groups/{groupId}/companies`. */
export interface CompanyListItem {
  readonly id: string;
  readonly name: string;
  readonly vatNumber: string | null;
  readonly city: string | null;
  readonly province: string | null;
  readonly country: string | null;
  readonly status: CompanyStatus;
  readonly trashed: boolean;
  /** Group of the company: only in the cross-group list (`GET /v1/companies`). */
  readonly groupId?: string;
  /** ISO instant the company was trashed, `null` otherwise (cross-group list). */
  readonly trashedAt?: string | null;
  /** Name of that group: `''` without a text name, `null` when the group does not exist (cross-group list only). */
  readonly groupName?: string | null;
}

/** Postal address of a company. */
export interface CompanyAddress {
  readonly street: string | null;
  readonly postcode: string | null;
  readonly city: string | null;
  readonly province: string | null;
  readonly country: string | null;
}

/** Electronic invoicing data of a company. */
export interface EInvoicing {
  readonly hub: string | null;
  readonly transmitter: { readonly country: string | null; readonly code: string | null };
  readonly eori: string | null;
  readonly pec: string | null;
  readonly recipientCode: string | null;
  readonly professionalRegister: {
    readonly name: string | null;
    readonly number: string | null;
    readonly province: string | null;
    readonly date: string | null;
  };
  readonly rea: {
    readonly office: string | null;
    readonly number: string | null;
    readonly shareCapital: string | null;
    readonly shareholders: string | null;
    readonly liquidation: string | null;
  };
  readonly taxRegime: string | null;
}

/** Whether the invoice series is a prefix or a suffix of the number. */
export type NumberingPosition = 'prefix' | 'suffix';

/** Invoice numbering of a company. */
export interface InvoiceNumbering {
  readonly position: NumberingPosition | null;
  readonly values: readonly { readonly name: string; readonly cash: boolean }[];
  readonly lastInvoiceNumber: number | null;
  readonly discountLines: boolean;
  readonly cervedLookup: boolean;
}

/** A bank account of a company. */
export interface BankAccount {
  readonly id: string;
  readonly name: string | null;
  readonly iban: string;
  readonly abi: string | null;
  readonly cab: string | null;
  readonly bic: string | null;
  readonly default: boolean;
}

/** A meal voucher issuer of a company, with the cuts of its vouchers (`null`: free amount). */
export interface MealVoucherIssuer {
  readonly id: string;
  readonly name: string;
  readonly cuts: readonly (number | null)[];
}

/** The boolean switches of the e-commerce settings, in display order. */
export const ECOMMERCE_FLAGS = [
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
] as const;

/** Name of an e-commerce switch. */
export type EcommerceFlag = (typeof ECOMMERCE_FLAGS)[number];

/** The e-commerce settings of the customer app as the API returns them. */
export type Ecommerce = { readonly [K in EcommerceFlag]: boolean } & {
  readonly status: boolean;
  readonly priceListId: string | null;
  readonly minimumOrder: Readonly<Record<string, number>>;
  readonly showProductRemainingQuantity: number;
};

/** Customer app and e-commerce settings. */
export interface CustomerApp {
  readonly enableLoginSignup: boolean;
  readonly showPrivacyPage: boolean;
  readonly showTermsPage: boolean;
  readonly ecommerce: Ecommerce;
}

/** Descriptor of the file stored as a logo (sent back unchanged to keep it). */
export interface LogoDescriptor {
  readonly _id: string;
  readonly basename: string;
  readonly extension: string;
  readonly filename: string;
  readonly mimetype: string;
  readonly title: string | null;
  readonly alt: string | null;
  readonly dirname: string;
  readonly type: string;
  readonly filectime: number;
}

/** Media of a company. */
export interface CompanyMedia {
  readonly internalFileName: string;
  readonly externalUrl: string;
  readonly customersAppLogoLight: LogoDescriptor | null;
  readonly customersAppLogoDark: LogoDescriptor | null;
}

/** A company as returned by the detail and by every write. */
export interface CompanyRecord {
  readonly id: string;
  readonly groupId: string;
  readonly name: string;
  readonly vatNumber: string | null;
  readonly fiscalCode: string | null;
  readonly address: CompanyAddress;
  readonly currency: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly status: CompanyStatus;
  readonly trashed: boolean;
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

/** An image of the media library of a group. */
export interface MediaImage {
  readonly id: string;
  readonly name: string;
  readonly title: string | null;
  readonly alt: string | null;
  readonly companyId: string | null;
  readonly extension: string;
  readonly mimetype: string;
  readonly createdAt: string | null;
  /** URLs by size; `null` when the group has no valid files host. */
  readonly urls: Readonly<Record<'xs' | 's' | 'm' | 'l' | 'xl', string>> | null;
}

/** An option of the e-invoicing hub select. */
export interface HubOption {
  readonly value: string;
  readonly label: string;
}

/** The sections (tabs) of the company, named as the blocks of the API. */
export const COMPANY_SECTIONS = [
  { id: 'general', path: '', key: 'GENERAL', exact: true },
  { id: 'eInvoicing', path: 'e-invoicing', key: 'E_INVOICING', exact: false },
  { id: 'invoiceNumbering', path: 'invoice-numbering', key: 'INVOICE_NUMBERING', exact: false },
  { id: 'bankAccounts', path: 'bank-accounts', key: 'BANK_ACCOUNTS', exact: false },
  { id: 'mealVoucherIssuers', path: 'meal-vouchers', key: 'MEAL_VOUCHERS', exact: false },
  { id: 'customerApp', path: 'customer-app', key: 'CUSTOMER_APP', exact: false },
  { id: 'media', path: 'media', key: 'MEDIA', exact: false },
] as const;

/** Identifier of a section. */
export type CompanySection = (typeof COMPANY_SECTIONS)[number]['id'];

/** URL of the detail of a company. */
export function companyRoute(groupId: string, companyId: string): string[] {
  return ['/groups', groupId, 'companies', companyId];
}
