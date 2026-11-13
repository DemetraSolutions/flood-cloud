import { compactIban } from './iban';
import {
  COMPANY_SECTIONS,
  CompanyRecord,
  CompanySection,
  ECOMMERCE_FLAGS,
  EcommerceFlag,
  LogoDescriptor,
  MediaImage,
  NumberingPosition,
} from './company.types';

/** A logo as the form holds it: the stored descriptor, or an image just picked from the library. */
export interface LogoModel {
  /** Descriptor stored in the company (sent back unchanged); `null` for a new choice. */
  readonly descriptor: LogoDescriptor | null;
  /** Id of the image just picked; `null` for the stored one. */
  readonly imageId: string | null;
  /** Name shown to the user. */
  readonly label: string;
  /** Preview URL of a new choice (the stored one is looked up by the slot). */
  readonly previewUrl: string | null;
}

/** Data of the general tab; texts are never `null` (an empty text stands for "none"). */
export interface GeneralModel {
  name: string;
  vatNumber: string;
  fiscalCode: string;
  address: { street: string; postcode: string; city: string; province: string; country: string };
  currency: string;
  email: string;
  phone: string;
  status: 'active' | 'disabled';
  /** `YYYY-MM-DD`, or empty for none. */
  expirationDate: string;
}

/** E-invoicing tab; empty texts stand for `null`. */
export interface EInvoicingModel {
  hub: string;
  transmitter: { country: string; code: string };
  eori: string;
  pec: string;
  recipientCode: string;
  professionalRegister: { name: string; number: string; province: string; date: string };
  rea: {
    office: string;
    number: string;
    shareCapital: string;
    shareholders: string;
    liquidation: string;
  };
  taxRegime: string;
}

/** One series of the invoice numbering. */
export interface NumberingValueModel {
  name: string;
  cash: boolean;
}

/** Invoice numbering tab. */
export interface NumberingModel {
  position: '' | NumberingPosition;
  values: NumberingValueModel[];
  lastInvoiceNumber: string;
  discountLines: boolean;
  cervedLookup: boolean;
}

/** A bank account row (`id` is empty for a row not saved yet). */
export interface BankModel {
  id: string;
  name: string;
  iban: string;
  abi: string;
  cab: string;
  bic: string;
  default: boolean;
}

/** A meal voucher issuer row (`id` is empty for a row not saved yet). */
export interface IssuerModel {
  id: string;
  name: string;
  cuts: string[];
}

/** Customer app tab. */
export type CustomerAppModel = {
  enableLoginSignup: boolean;
  showPrivacyPage: boolean;
  showTermsPage: boolean;
  ecommerce: { [K in EcommerceFlag]: boolean } & {
    status: boolean;
    priceListId: string;
    minimumOrder: Record<string, string>;
    showProductRemainingQuantity: string;
  };
};

/** Media tab. */
export interface MediaModel {
  internalFileName: string;
  externalUrl: string;
  customersAppLogoLight: LogoModel | null;
  customersAppLogoDark: LogoModel | null;
}

/** Everything the form edits, one property per section (tab). */
export interface CompanyModel {
  general: GeneralModel;
  eInvoicing: EInvoicingModel;
  invoiceNumbering: NumberingModel;
  bankAccounts: BankModel[];
  mealVoucherIssuers: IssuerModel[];
  customerApp: CustomerAppModel;
  media: MediaModel;
}

/** Fields of the general tab, as the API names them at the top of the company. */
const GENERAL_FIELDS = [
  'name',
  'vatNumber',
  'fiscalCode',
  'address',
  'currency',
  'email',
  'phone',
  'status',
  'expirationDate',
] as const;

const text = (value: string | null | undefined): string => value ?? '';
const orNull = (value: string): string | null => (value === '' ? null : value);
const numberOrNull = (value: string): number | null => (value === '' ? null : Number(value));

function logoOf(descriptor: LogoDescriptor | null): LogoModel | null {
  return descriptor === null
    ? null
    : {
        descriptor,
        imageId: null,
        label: descriptor.title ?? descriptor.filename,
        previewUrl: null,
      };
}

/**
 * The logo model of an image picked from the media library.
 *
 * @param image The image.
 */
export function pickedLogo(image: MediaImage): LogoModel {
  return {
    descriptor: null,
    imageId: image.id,
    label: image.name,
    previewUrl: image.urls?.s ?? null,
  };
}

/**
 * The form model of a company; with `null` the defaults of a company about to be created.
 *
 * @param record The company as the API returned it.
 */
export function toModel(record: CompanyRecord | null): CompanyModel {
  const e = record?.eInvoicing;
  const n = record?.invoiceNumbering;
  const ecommerce = record?.customerApp.ecommerce;
  const flags = Object.fromEntries(
    ECOMMERCE_FLAGS.map((flag) => [flag, ecommerce?.[flag] === true]),
  ) as { [K in EcommerceFlag]: boolean };
  return {
    general: {
      name: text(record?.name),
      vatNumber: text(record?.vatNumber),
      fiscalCode: text(record?.fiscalCode),
      address: {
        street: text(record?.address.street),
        postcode: text(record?.address.postcode),
        city: text(record?.address.city),
        province: text(record?.address.province),
        country: record === null ? 'IT' : text(record.address.country),
      },
      currency: record === null ? 'EUR' : text(record.currency),
      email: text(record?.email),
      phone: text(record?.phone),
      status: record?.status ?? 'active',
      expirationDate: text(record?.expirationDate?.slice(0, 10)),
    },
    eInvoicing: {
      hub: text(e?.hub),
      transmitter: { country: text(e?.transmitter.country), code: text(e?.transmitter.code) },
      eori: text(e?.eori),
      pec: text(e?.pec),
      recipientCode: text(e?.recipientCode),
      professionalRegister: {
        name: text(e?.professionalRegister.name),
        number: text(e?.professionalRegister.number),
        province: text(e?.professionalRegister.province),
        date: text(e?.professionalRegister.date),
      },
      rea: {
        office: text(e?.rea.office),
        number: text(e?.rea.number),
        shareCapital: text(e?.rea.shareCapital),
        shareholders: text(e?.rea.shareholders),
        liquidation: text(e?.rea.liquidation),
      },
      taxRegime: text(e?.taxRegime),
    },
    invoiceNumbering: {
      position: n?.position ?? '',
      values: (n?.values ?? []).map((value) => ({ name: value.name, cash: value.cash })),
      lastInvoiceNumber: n?.lastInvoiceNumber == null ? '' : String(n.lastInvoiceNumber),
      discountLines: n?.discountLines === true,
      cervedLookup: n?.cervedLookup === true,
    },
    bankAccounts: (record?.bankAccounts ?? []).map((bank) => ({
      id: bank.id,
      name: text(bank.name),
      iban: bank.iban,
      abi: text(bank.abi),
      cab: text(bank.cab),
      bic: text(bank.bic),
      default: bank.default,
    })),
    mealVoucherIssuers: (record?.mealVoucherIssuers ?? []).map((issuer) => ({
      id: issuer.id,
      name: issuer.name,
      cuts: issuer.cuts.map((cut) => (cut === null ? '' : String(cut))),
    })),
    customerApp: {
      enableLoginSignup: record?.customerApp.enableLoginSignup === true,
      showPrivacyPage: record?.customerApp.showPrivacyPage === true,
      showTermsPage: record?.customerApp.showTermsPage === true,
      ecommerce: {
        ...flags,
        status: ecommerce?.status === true,
        priceListId: text(ecommerce?.priceListId),
        minimumOrder: Object.fromEntries(
          Object.entries(ecommerce?.minimumOrder ?? {}).map(([code, value]) => [
            code,
            String(value),
          ]),
        ),
        showProductRemainingQuantity: String(ecommerce?.showProductRemainingQuantity ?? 0),
      },
    },
    media: {
      internalFileName: text(record?.media.internalFileName),
      externalUrl: text(record?.media.externalUrl),
      customersAppLogoLight: logoOf(record?.media.customersAppLogoLight ?? null),
      customersAppLogoDark: logoOf(record?.media.customersAppLogoDark ?? null),
    },
  };
}

/**
 * The sections whose content differs from the baseline (the saved company).
 *
 * @param model What the form holds.
 * @param baseline The model of the saved company.
 */
export function dirtySections(model: CompanyModel, baseline: CompanyModel): Set<CompanySection> {
  const dirty = new Set<CompanySection>();
  for (const { id } of COMPANY_SECTIONS) {
    if (JSON.stringify(model[id]) !== JSON.stringify(baseline[id])) {
      dirty.add(id);
    }
  }
  return dirty;
}

/**
 * The model with some sections replaced by those of a saved company: what was saved is aligned
 * with the server while the drafts of the other sections stay.
 *
 * @param model Current model.
 * @param record The company the server returned.
 * @param sections Sections to replace.
 */
export function withSections(
  model: CompanyModel,
  record: CompanyRecord,
  sections: Iterable<CompanySection>,
): CompanyModel {
  const saved = toModel(record);
  const next: CompanyModel = { ...model };
  for (const id of sections) {
    (next as unknown as Record<string, unknown>)[id] = saved[id];
  }
  return next;
}

/** Only the fields of the general tab that differ from the baseline, as the API names them. */
function generalChanges(model: GeneralModel, baseline: GeneralModel): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  if (model.name !== baseline.name) {
    changes['name'] = model.name;
  }
  if (model.vatNumber !== baseline.vatNumber) {
    changes['vatNumber'] = model.vatNumber;
  }
  if (model.fiscalCode !== baseline.fiscalCode) {
    changes['fiscalCode'] = orNull(model.fiscalCode);
  }
  const address = Object.fromEntries(
    Object.entries(model.address).filter(
      ([key, value]) => value !== baseline.address[key as keyof GeneralModel['address']],
    ),
  );
  if (Object.keys(address).length > 0) {
    changes['address'] = address;
  }
  if (model.currency !== baseline.currency) {
    changes['currency'] = model.currency;
  }
  if (model.email !== baseline.email) {
    changes['email'] = orNull(model.email);
  }
  if (model.phone !== baseline.phone) {
    changes['phone'] = orNull(model.phone);
  }
  if (model.status !== baseline.status) {
    changes['status'] = model.status;
  }
  if (model.expirationDate !== baseline.expirationDate) {
    changes['expirationDate'] = orNull(model.expirationDate);
  }
  return changes;
}

function logoBody(logo: LogoModel | null): unknown {
  if (logo === null) {
    return null;
  }
  return logo.imageId === null ? logo.descriptor : { imageId: logo.imageId };
}

function withId<T extends object>(id: string, body: T): T | (T & { id: string }) {
  return id === '' ? body : { id, ...body };
}

/**
 * The body of the `PUT` of a block (every key, as the API requires), from the model of its tab.
 *
 * @param model The form model.
 * @param section A section other than the general one.
 */
export function blockBody(
  model: CompanyModel,
  section: Exclude<CompanySection, 'general'>,
): unknown {
  switch (section) {
    case 'eInvoicing': {
      const e = model.eInvoicing;
      return {
        hub: orNull(e.hub),
        transmitter: { country: orNull(e.transmitter.country), code: orNull(e.transmitter.code) },
        eori: orNull(e.eori),
        pec: orNull(e.pec),
        recipientCode: orNull(e.recipientCode),
        professionalRegister: {
          name: orNull(e.professionalRegister.name),
          number: orNull(e.professionalRegister.number),
          province: orNull(e.professionalRegister.province),
          date: orNull(e.professionalRegister.date),
        },
        rea: {
          office: orNull(e.rea.office),
          number: orNull(e.rea.number),
          shareCapital: orNull(e.rea.shareCapital),
          shareholders: orNull(e.rea.shareholders),
          liquidation: orNull(e.rea.liquidation),
        },
        taxRegime: orNull(e.taxRegime),
      };
    }
    case 'invoiceNumbering': {
      const n = model.invoiceNumbering;
      return {
        position: orNull(n.position),
        values: n.values.map((value) => ({ name: value.name, cash: value.cash })),
        lastInvoiceNumber: numberOrNull(n.lastInvoiceNumber),
        discountLines: n.discountLines,
        cervedLookup: n.cervedLookup,
      };
    }
    case 'bankAccounts':
      return model.bankAccounts.map((bank) =>
        withId(bank.id, {
          name: orNull(bank.name),
          iban: compactIban(bank.iban),
          abi: orNull(bank.abi),
          cab: orNull(bank.cab),
          bic: orNull(bank.bic),
          default: bank.default,
        }),
      );
    case 'mealVoucherIssuers':
      return model.mealVoucherIssuers.map((issuer) =>
        withId(issuer.id, { name: issuer.name, cuts: issuer.cuts.map(numberOrNull) }),
      );
    case 'customerApp': {
      const { ecommerce, ...app } = model.customerApp;
      return {
        ...app,
        ecommerce: {
          ...ecommerce,
          priceListId: orNull(ecommerce.priceListId),
          minimumOrder: Object.fromEntries(
            Object.entries(ecommerce.minimumOrder).map(([code, value]) => [code, Number(value)]),
          ),
          showProductRemainingQuantity: Number(ecommerce.showProductRemainingQuantity),
        },
      };
    }
    case 'media': {
      const m = model.media;
      return {
        internalFileName: m.internalFileName,
        externalUrl: m.externalUrl,
        customersAppLogoLight: logoBody(m.customersAppLogoLight),
        customersAppLogoDark: logoBody(m.customersAppLogoDark),
      };
    }
  }
}

/**
 * The body of the unique `PATCH`: what changed in the general tab and the whole blocks of the
 * other sections given.
 *
 * @param model The form model.
 * @param baseline The model of the saved company.
 * @param sections Sections to send.
 */
export function patchBody(
  model: CompanyModel,
  baseline: CompanyModel,
  sections: ReadonlySet<CompanySection>,
): Record<string, unknown> {
  const body: Record<string, unknown> = sections.has('general')
    ? generalChanges(model.general, baseline.general)
    : {};
  for (const { id } of COMPANY_SECTIONS) {
    if (id !== 'general' && sections.has(id)) {
      body[id] = blockBody(model, id);
    }
  }
  return body;
}

/**
 * The body of the creation: the required data and what the user filled in; the optional
 * fields left empty are not sent (the server applies its defaults).
 *
 * @param general The general tab.
 */
export function createBody(general: GeneralModel): Record<string, unknown> {
  const { address } = general;
  return {
    name: general.name,
    vatNumber: general.vatNumber,
    address: {
      street: address.street,
      postcode: address.postcode,
      city: address.city,
      country: address.country,
      ...(address.province === '' ? {} : { province: address.province }),
    },
    currency: general.currency,
    status: general.status,
    ...(general.fiscalCode === '' ? {} : { fiscalCode: general.fiscalCode }),
    ...(general.email === '' ? {} : { email: general.email }),
    ...(general.phone === '' ? {} : { phone: general.phone }),
    ...(general.expirationDate === '' ? {} : { expirationDate: general.expirationDate }),
  };
}

/** Section a backend field belongs to: the general fields sit at the top of the company. */
export function sectionOfField(field: string): CompanySection {
  const first = field.split('.')[0];
  const block = COMPANY_SECTIONS.find((section) => section.id === first);
  return block === undefined ? 'general' : block.id;
}

/**
 * Path of the form field that stands for a backend field: the general fields live under
 * `general` in the model, the blocks keep their names.
 *
 * @param field Field of an error detail (`address.street`, `bankAccounts.0.iban`).
 */
export function formPathOf(field: string): string {
  return (GENERAL_FIELDS as readonly string[]).includes(field.split('.')[0])
    ? `general.${field}`
    : field;
}
