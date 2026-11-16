import { listQueryShape } from '../../shared/http/list.ts';
import { ECOMMERCE_FLAGS } from '../../shared/legacy-write/company-paths.ts';
import { MAX_INVOICE_NUMBER } from '../../shared/legacy-write/fields.ts';
import { array, boolean, email, enumOf, integer, isoDate, nullable, number, object, objectId, optional, record, refine, string, transform } from '../../shared/validation/schema.ts';
import type { Infer, Schema } from '../../shared/validation/schema.ts';
import { lookupIds } from '../group-lookup/lookup.schemas.ts';
import type { BankAccountInput, CompanyCreation, CompanyPatch, MealVoucherIssuerInput } from './company.types.ts';
import { COMPANIES_LIST } from './companies.list.ts';
import { ITALIAN_PROVINCES } from './italian-provinces.ts';
import {
  TAX_REGIMES,
  isValidBankCode,
  isValidBic,
  isValidCalendarDate,
  isValidDecimalText,
  isValidIban,
  isValidRecipientCode,
  normalizeIban,
} from './validators.ts';

/** Body limit of every write of a company: the whole document is some kilobytes (a hundred accounts and issuers at most). */
export const COMPANIES_BODY_LIMIT = '64kb';

/** Most bank accounts a company can have. */
export const MAX_BANK_ACCOUNTS = 20;

/** Most meal voucher issuers a company can have. */
export const MAX_MEAL_VOUCHER_ISSUERS = 50;

/** Most cuts one meal voucher issuer can have. */
export const MAX_CUTS = 50;

/** Most invoice series a company can have. */
export const MAX_INVOICE_SERIES = 50;

/** Most currencies a minimum order can name (a group has at most ten). */
export const MAX_MINIMUM_ORDER_CURRENCIES = 10;

/** Longest text of a free field of the e-invoicing data and of the general data. */
const MAX_FREE_TEXT = 100;

/** `''` is the same as `null`: the documents keep an empty text for none, and a client may send it back. */
export function emptyAsNull<T>(inner: Schema<T | null>): Schema<T | null> {
  return { optional: inner.optional, parse: (value, path, context, depth) => inner.parse(value === '' ? null : value, path, context, depth) };
}

/** A free text of the e-invoicing data: trimmed, at most `max` characters, `null` or `''` for none. */
const freeText = (max: number) => emptyAsNull(nullable(string({ max, trim: true })));

/** A text that must satisfy a check, or `null`/`''` for none; the value kept is the one `normalize` returns (`undefined` rejects it with `format`). */
const checkedText = (max: number, normalize: (text: string) => string | undefined) => emptyAsNull(nullable(transform(string({ max, trim: true }), normalize, 'format')));

export const alpha2 = () => string({ min: 2, max: 2, pattern: /^[A-Z]{2}$/ });
const province = () => emptyAsNull(nullable(enumOf(ITALIAN_PROVINCES)));
const upperIf = (valid: (text: string) => boolean) => (text: string): string | undefined => (valid(text.toUpperCase()) ? text.toUpperCase() : undefined);

/** `part` of the object is required (a whole block) or optional (a modification). */
export type Part = <T>(schema: Schema<T>) => Schema<T>;
export const required: Part = (schema) => schema;
export const partial: Part = (schema) => optional(schema);

/**
 * The e-invoicing block. As a modification every key (and every key of the sub-objects) is optional; as a whole block (PUT) every key is required, so
 * what a GET returns can be sent back. `hub` is a text here; which values it may have depends on the role and the dealers, and the service decides.
 */
export function eInvoicingSchema(part: Part): Schema<NonNullable<CompanyPatch['eInvoicing']>> {
  return object({
    hub: part(freeText(64)),
    transmitter: part(object({ country: part(emptyAsNull(nullable(alpha2()))), code: part(freeText(28)) })),
    eori: part(freeText(30)),
    pec: part(emptyAsNull(nullable(email()))),
    recipientCode: part(checkedText(7, upperIf(isValidRecipientCode))),
    professionalRegister: part(
      object({
        name: part(freeText(60)),
        number: part(freeText(30)),
        province: part(province()),
        date: part(checkedText(10, (text) => (isValidCalendarDate(text) ? text : undefined))),
      }),
    ),
    rea: part(
      object({
        office: part(province()),
        number: part(freeText(20)),
        shareCapital: part(checkedText(20, (text) => (isValidDecimalText(text) ? text : undefined))),
        shareholders: part(emptyAsNull(nullable(enumOf(['SU', 'SM'] as const)))),
        liquidation: part(emptyAsNull(nullable(enumOf(['LS', 'LN'] as const)))),
      }),
    ),
    taxRegime: part(emptyAsNull(nullable(enumOf(TAX_REGIMES)))),
  }) as unknown as Schema<NonNullable<CompanyPatch['eInvoicing']>>;
}

/** The paths of the elements of a list that repeat a value (the second and later ones), as `<index>.<field>`. */
function repeated<T>(items: readonly T[], field: string, keyOf: (item: T) => string): string[] {
  const seen = new Set<string>();
  return items.flatMap((item, index) => (seen.size === seen.add(keyOf(item)).size ? [`${String(index)}.${field}`] : []));
}

/** The numbering block: the position, the series (unique names, at most one for the cash sales), the last number and the two switches. */
export function invoiceNumberingSchema(part: Part): Schema<NonNullable<CompanyPatch['invoiceNumbering']>> {
  const series = refine(
    array(object({ name: string({ min: 1, max: 50, trim: true }), cash: boolean() }), { max: MAX_INVOICE_SERIES }),
    (items) => [...repeated(items, 'name', (item) => item.name), ...items.flatMap((item, index) => (item.cash && items.findIndex((other) => other.cash) !== index ? [`${String(index)}.cash`] : []))],
    'incorrect',
  );
  return object({
    position: part(nullable(enumOf(['prefix', 'suffix'] as const))),
    values: part(series),
    lastInvoiceNumber: part(nullable(integer({ min: 0, max: MAX_INVOICE_NUMBER }))),
    discountLines: part(boolean()),
    cervedLookup: part(boolean()),
  }) as unknown as Schema<NonNullable<CompanyPatch['invoiceNumbering']>>;
}

/** The id of a bank account or an issuer a request sends back: one the company has already (the service checks it). */
const elementId = () => string({ min: 1, max: 64, pattern: /^[A-Za-z0-9_-]+$/ });

const bankCode = () => emptyAsNull(nullable(transform(string({ max: 5, trim: true }), (text) => (isValidBankCode(text) ? text : undefined), 'format')));

/** The bank accounts: the IBAN (normalized, with its checksum) is required; at most {@link MAX_BANK_ACCOUNTS}, at most one default. */
export function bankAccountsSchema(): Schema<readonly BankAccountInput[]> {
  const account = transform(
    object({
      id: optional(elementId()),
      name: optional(string({ max: 100, trim: true })),
      iban: transform(string({ min: 1, max: 64, trim: true }), (text) => (isValidIban(normalizeIban(text)) ? normalizeIban(text) : undefined), 'format'),
      abi: optional(bankCode()),
      cab: optional(bankCode()),
      bic: optional(emptyAsNull(nullable(transform(string({ max: 11, trim: true }), upperIf(isValidBic), 'format')))),
      default: optional(boolean()),
    }),
    (bank): BankAccountInput => ({
      ...(bank.id === undefined ? {} : { id: bank.id }),
      name: bank.name ?? '',
      iban: bank.iban,
      abi: bank.abi ?? null,
      cab: bank.cab ?? null,
      bic: bank.bic ?? null,
      default: bank.default ?? false,
    }),
    'incorrect',
  );
  return refine(array(account, { max: MAX_BANK_ACCOUNTS }), (items) => items.flatMap((bank, index) => (bank.default && items.findIndex((other) => other.default) !== index ? [`${String(index)}.default`] : [])), 'incorrect');
}

/** The meal voucher issuers: a name and up to {@link MAX_CUTS} cuts (numbers not below zero, `null` for a free amount). */
export function mealVoucherIssuersSchema(): Schema<readonly MealVoucherIssuerInput[]> {
  const issuer = transform(
    object({ id: optional(elementId()), name: string({ min: 1, max: 100, trim: true }), cuts: optional(array(nullable(number({ min: 0 })), { max: MAX_CUTS })) }),
    (value): MealVoucherIssuerInput => ({ ...(value.id === undefined ? {} : { id: value.id }), name: value.name, cuts: value.cuts ?? [] }),
    'incorrect',
  );
  return array(issuer, { max: MAX_MEAL_VOUCHER_ISSUERS });
}

/** The settings of the customer app: three switches and the e-commerce flags, the price list, the minimum orders and the quantity shown. */
export function customerAppSchema(part: Part): Schema<NonNullable<CompanyPatch['customerApp']>> {
  const flags = Object.fromEntries(ECOMMERCE_FLAGS.map((key) => [key, part(boolean())]));
  return object({
    enableLoginSignup: part(boolean()),
    showPrivacyPage: part(boolean()),
    showTermsPage: part(boolean()),
    ecommerce: part(
      object({
        ...flags,
        priceListId: part(emptyAsNull(nullable(string({ min: 1, max: 64, pattern: /^[A-Za-z0-9_-]+$/ })))),
        minimumOrder: part(record(number({ min: 0 }), { max: MAX_MINIMUM_ORDER_CURRENCIES, key: /^[A-Z]{3}$/ })),
        showProductRemainingQuantity: part(number({ min: 0 })),
      }),
    ),
  }) as unknown as Schema<NonNullable<CompanyPatch['customerApp']>>;
}

/** A logo descriptor as the API returns it: every key present, `null` for what the stored descriptor lacks. */
const logoDescriptor = () => {
  const textOrNull = () => nullable(string({ max: 512 }));
  return object({
    _id: textOrNull(),
    basename: textOrNull(),
    extension: textOrNull(),
    filename: textOrNull(),
    mimetype: textOrNull(),
    title: textOrNull(),
    alt: textOrNull(),
    dirname: textOrNull(),
    type: textOrNull(),
    filectime: nullable(number()),
  });
};

/** A logo that picks an image of the group: `{ imageId }` with the 24 hexadecimal characters of a `files` document. */
const imageReference = () => object({ imageId: string({ min: 24, max: 24, pattern: /^[0-9a-f]{24}$/ }) });

/** A logo in a request: an `{ imageId }` or the descriptor of the company (an object with `imageId` is judged as a reference, any other as a descriptor). */
export const logoValue = (): Schema<unknown> => {
  const reference = imageReference();
  const descriptor = logoDescriptor();
  return {
    optional: false,
    parse: (value, path, context, depth) =>
      (typeof value === 'object' && value !== null && Object.hasOwn(value, 'imageId') ? reference : descriptor).parse(value, path, context, depth),
  };
};

/** A text of the media block: a file name or an URL, without control characters. */
export const mediaText = (max: number) => string({ max, trim: true, pattern: /^[^\u0000-\u001F\u007F-\u009F]*$/ });

/** A simple file name of a media image (or empty). */
export const fileNameText = () => string({ max: 255, trim: true, pattern: /^(?!.*\.\.)(?:[A-Za-z0-9][A-Za-z0-9._-]*)?$/ });

/** An `http(s)` URL of a media image (or empty). */
export const urlText = () =>
  transform(
    mediaText(2048),
    (text) => {
      if (text === '') {
        return text;
      }
      try {
        return ['http:', 'https:'].includes(new URL(text).protocol) ? text : undefined;
      } catch {
        return undefined;
      }
    },
    'format',
  );

/**
 * The media block. The two logos accept `null` (removal), `{ imageId }` (an image of the group, from which the server builds the descriptor) or the descriptor the
 * company already has (a GET sent back); any other descriptor is refused by the service.
 */
export function mediaSchema(part: Part): Schema<NonNullable<CompanyPatch['media']>> {
  return object({
    internalFileName: part(fileNameText()),
    externalUrl: part(urlText()),
    customersAppLogoLight: part(nullable(logoValue())),
    customersAppLogoDark: part(nullable(logoValue())),
  }) as unknown as Schema<NonNullable<CompanyPatch['media']>>;
}

/**
 * The postal address of a company or a place: street, postcode, city and country (`part`: required for a whole address, optional for a modification) and the province, which may be left out
 * (`''`) and is checked against the areas of the country by the service.
 */
export function addressSchema(part: Part) {
  return object({
    street: part(string({ min: 1, max: 150, trim: true })),
    postcode: part(string({ min: 1, max: 20, trim: true })),
    city: part(string({ min: 1, max: 100, trim: true })),
    province: optional(string({ max: 10, trim: true })),
    country: part(alpha2()),
  });
}

/** The general fields and the blocks of a company, each as required (`part` is {@link required}) or optional ({@link partial}). */
function companyShape(part: Part, creation: boolean) {
  return {
    name: part(string({ min: 1, max: 150, trim: true })),
    vatNumber: part(string({ min: 1, max: 30, trim: true })),
    fiscalCode: optional(emptyAsNull(nullable(string({ max: 30, trim: true })))),
    address: creation ? addressSchema(part) : optional(addressSchema(part)),
    currency: optional(string({ min: 3, max: 3, pattern: /^[A-Z]{3}$/ })),
    email: optional(emptyAsNull(nullable(email()))),
    phone: optional(emptyAsNull(nullable(string({ max: 30, trim: true })))),
    status: optional(enumOf(['active', 'disabled'] as const)),
    expirationDate: optional(nullable(transform(isoDate(), (date) => date.toISOString(), 'format'))),
    eInvoicing: optional(eInvoicingSchema(partial)),
    invoiceNumbering: optional(invoiceNumberingSchema(partial)),
    bankAccounts: optional(bankAccountsSchema()),
    mealVoucherIssuers: optional(mealVoucherIssuersSchema()),
    customerApp: optional(customerAppSchema(partial)),
    media: optional(mediaSchema(partial)),
  };
}

/** Body of `POST /v1/groups/{groupId}/companies`: the general data and, optionally, any block (a block with only some of its keys keeps the defaults of the rest). */
export const createCompanyBody = object(companyShape(required, true)) as unknown as Schema<CompanyCreation>;

/** Body of `PATCH /v1/groups/{groupId}/companies/{companyId}`: any subset of the fields and of the blocks, each block any subset of its fields (arrays are replaced whole). */
export const patchCompanyBody = object(companyShape(partial, false)) as unknown as Schema<CompanyPatch>;

/** Body of `PUT …/e-invoicing`: the whole block. */
export const putEInvoicingBody = eInvoicingSchema(required);

/** Body of `PUT …/invoice-numbering`: the whole block. */
export const putInvoiceNumberingBody = invoiceNumberingSchema(required);

/** Body of `PUT …/bank-accounts`: the whole list. */
export const putBankAccountsBody = bankAccountsSchema();

/** Body of `PUT …/meal-voucher-issuers`: the whole list. */
export const putMealVoucherIssuersBody = mealVoucherIssuersSchema();

/** Body of `PUT …/customer-app`: the whole block. */
export const putCustomerAppBody = customerAppSchema(required);

/** Body of `PUT …/media`: the whole block. */
export const putMediaBody = mediaSchema(required);

const trashed = () => optional(enumOf(['true', 'false'] as const));

/**
 * Query of `GET /v1/groups/{groupId}/companies`: the standard list parameters (the search `q` looks in the name and the VAT number), the `trashed`
 * filter, `ids` (1-100 comma-separated ObjectIds), `status`, `country` (ISO alpha-2) and `province`.
 */
export const companiesQuery = object({
  ...listQueryShape(COMPANIES_LIST),
  trashed: trashed(),
  ids: lookupIds,
  status: optional(enumOf(['active', 'disabled'] as const)),
  country: optional(string({ min: 2, max: 2, pattern: /^[A-Z]{2}$/ })),
  province: optional(string({ min: 1, max: 10, trim: true })),
});

/** Validated query of the company list. */
export type CompaniesQuery = Infer<typeof companiesQuery>;

/** Path parameters of the routes on one company; the group was already verified by the route. */
export const companyParams = object({ companyId: objectId() }, { allowUnknown: true });
