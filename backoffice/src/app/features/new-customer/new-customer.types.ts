import { FEATURE_NAMES, FeatureFlags, FeatureName } from '../../core/groups/feature-catalog';
import { Role } from '../../core/session/session.types';

/** The types of customer of the quick tool: each one presets the form (the type is never sent). */
export const CUSTOMER_TYPES = ['risto', 'retail', 'beauty'] as const;

/** A type of customer. */
export type CustomerType = (typeof CUSTOMER_TYPES)[number];

/** A tax rate of the group with its department (`taxes[]` of the request). */
export interface TaxRate {
  readonly rate: number;
  readonly department: number;
}

/** Tax rates and departments each type presets, as the legacy form did. */
export const TAX_PRESETS: Readonly<Record<CustomerType, readonly TaxRate[]>> = {
  risto: [
    { rate: 10, department: 1 },
    { rate: 22, department: 2 },
  ],
  retail: [{ rate: 22, department: 2 }],
  beauty: [{ rate: 22, department: 2 }],
};

/** Type preselected when the page opens (the legacy default). */
export const DEFAULT_TYPE: CustomerType = 'risto';

/** Plan preselected when the page opens (the legacy default). */
export const DEFAULT_PLAN = 'advanced';

/** Features every new group has before the preset: the cash and the product variants. */
const BASE_FEATURES: FeatureFlags = Object.fromEntries(
  FEATURE_NAMES.map((name) => [name, name === 'cash' || name === 'productsVariants']),
) as FeatureFlags;

/** Whether the plan turns on the features the legacy tied to the paid plans. */
function isPaidPlan(plan: string): boolean {
  return plan === 'advanced' || plan === 'enterprice';
}

/**
 * The features that depend on the plan for a type: the scales and the ordering of a restaurant,
 * the appointments of a beauty salon (only with `advanced` or `enterprice`, as the legacy did).
 *
 * @param type Type of customer.
 * @param plan Plan of the place.
 */
export function planFeatures(
  type: CustomerType,
  plan: string,
): Partial<Record<FeatureName, boolean>> {
  if (type === 'risto') {
    return { scales: isPaidPlan(plan), ordering: isPaidPlan(plan) };
  }
  return type === 'beauty' ? { appointments: isPaidPlan(plan) } : {};
}

/**
 * The features a type presets, as the legacy did: the base ones, the ones of the type and the
 * ones that depend on the plan; the warehouse stays as the operator set it (it was an
 * independent switch).
 *
 * @param type Type of customer.
 * @param plan Plan of the place.
 * @param current Current features (only the warehouse is kept).
 */
export function presetFeatures(
  type: CustomerType,
  plan: string,
  current: FeatureFlags,
): FeatureFlags {
  const own: Partial<Record<FeatureName, boolean>> =
    type === 'risto' ? { rooms: true } : type === 'beauty' ? { services: true } : {};
  return {
    ...BASE_FEATURES,
    warehouse: current.warehouse,
    ...own,
    ...planFeatures(type, plan),
  };
}

const ROME = 'Europe/Rome';

/**
 * The default expiration date: 31 December of the current year (in Italy), as `YYYY-MM-DD`.
 *
 * @param now The current instant.
 */
export function defaultExpiration(now: Date): string {
  const year = new Intl.DateTimeFormat('en-US', { timeZone: ROME, year: 'numeric' }).format(now);
  return `${year}-12-31`;
}

/**
 * The instant the expiration date stands for: 23:59:59 of that day in `Europe/Rome`, in UTC
 * (the backend accepts UTC date-times).
 *
 * @param date A calendar date, `YYYY-MM-DD`.
 * @returns ISO 8601 date-time in UTC.
 */
export function expirationInstant(date: string): string {
  const offset = new Intl.DateTimeFormat('en-US', { timeZone: ROME, timeZoneName: 'longOffset' })
    .formatToParts(new Date(`${date}T12:00:00Z`))
    .find((part) => part.type === 'timeZoneName')!.value;
  return new Date(`${date}T23:59:59${offset.replace('GMT', '')}`).toISOString();
}

/**
 * The username proposed from the name, as the legacy did: `first.last` in lower case without
 * spaces; empty until both names are filled.
 *
 * @param firstName First name.
 * @param lastName Last name.
 */
export function suggestUsername(firstName: string, lastName: string): string {
  const first = firstName.trim();
  const last = lastName.trim();
  return first === '' || last === '' ? '' : `${first}.${last}`.toLowerCase().replace(/\s+/g, '');
}

/** The whole form: every text is `''` when empty. */
export interface NewCustomerModel {
  groupName: string;
  dealerId: string;
  demo: boolean;
  companyName: string;
  vatNumber: string;
  fiscalCode: string;
  recipientCode: string;
  pec: string;
  street: string;
  postcode: string;
  city: string;
  country: string;
  province: string;
  companyPhone: string;
  companyEmail: string;
  placeName: string;
  otherAddress: boolean;
  placeStreet: string;
  placePostcode: string;
  placeCity: string;
  placeProvince: string;
  contactName: string;
  placePhone: string;
  placeEmail: string;
  /** A {@link CustomerType} (a plain string so that a select can be bound to it). */
  type: string;
  firstName: string;
  lastName: string;
  userPhone: string;
  userEmail: string;
  username: string;
  password: string;
  plan: string;
  expirationDate: string;
  features: FeatureFlags;
}

/**
 * The form as it opens: the default type and plan preset, the expiration at the end of the year.
 *
 * @param now The current instant.
 */
export function initialModel(now: Date): NewCustomerModel {
  return {
    groupName: '',
    dealerId: '',
    demo: false,
    companyName: '',
    vatNumber: '',
    fiscalCode: '',
    recipientCode: '',
    pec: '',
    street: '',
    postcode: '',
    city: '',
    country: 'IT',
    province: '',
    companyPhone: '',
    companyEmail: '',
    placeName: '',
    otherAddress: false,
    placeStreet: '',
    placePostcode: '',
    placeCity: '',
    placeProvince: '',
    contactName: '',
    placePhone: '',
    placeEmail: '',
    type: DEFAULT_TYPE,
    firstName: '',
    lastName: '',
    userPhone: '',
    userEmail: '',
    username: '',
    password: '',
    plan: DEFAULT_PLAN,
    expirationDate: defaultExpiration(now),
    features: presetFeatures(DEFAULT_TYPE, DEFAULT_PLAN, BASE_FEATURES),
  };
}

/** Body of `POST /v1/groups`. */
export interface NewCustomerBody {
  group: {
    name: string;
    features: FeatureFlags;
    demo?: boolean;
    dealerId?: string;
  };
  company: {
    name: string;
    vatNumber: string;
    address: { street: string; postcode: string; city: string; country: string; province?: string };
    fiscalCode?: string;
    email?: string;
    phone?: string;
    eInvoicing?: { recipientCode?: string; pec?: string };
  };
  place: {
    name: string;
    plan: string;
    expirationDate: string;
    address?: { street: string; postcode: string; city: string; province?: string };
    contactName?: string;
    email?: string;
    phone?: string;
  };
  user: {
    username: string;
    password: string;
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
  };
  taxes: readonly TaxRate[];
}

/** Ids of what the creation made (`201`). */
export interface NewCustomerResult {
  readonly groupId: string;
  readonly companyId: string;
  readonly placeId: string;
  readonly userId: string;
}

/** `{ key: value }` when the text is not empty, nothing otherwise (optional keys are left out). */
function optional<K extends string>(key: K, value: string, upper = false): { [P in K]?: string } {
  const text = value.trim();
  return (text === '' ? {} : { [key]: upper ? text.toUpperCase() : text }) as { [P in K]?: string };
}

/**
 * The request body for the form: only the fields the API accepts, texts trimmed, codes in
 * upper case, optional ones left out when empty. The platform administrator alone sends `demo`
 * and the dealer; the type is never sent (it only presets the form).
 *
 * @param model The form.
 * @param taxes The tax rates and departments of the group.
 * @param role Role of the user (a dealer sends neither `demo` nor `dealerId`).
 */
export function buildBody(
  model: NewCustomerModel,
  taxes: readonly TaxRate[],
  role: Role | undefined,
): NewCustomerBody {
  const platform = role === 'PSA';
  const eInvoicing = {
    ...optional('recipientCode', model.recipientCode, true),
    ...optional('pec', model.pec),
  };
  return {
    group: {
      name: model.groupName.trim(),
      features: model.features,
      ...(platform ? { demo: model.demo } : {}),
      ...(platform ? optional('dealerId', model.dealerId) : {}),
    },
    company: {
      name: model.companyName.trim(),
      vatNumber: model.vatNumber.trim().toUpperCase(),
      address: {
        street: model.street.trim(),
        postcode: model.postcode.trim(),
        city: model.city.trim(),
        country: model.country,
        ...optional('province', model.province),
      },
      ...optional('fiscalCode', model.fiscalCode, true),
      ...optional('email', model.companyEmail),
      ...optional('phone', model.companyPhone),
      ...(Object.keys(eInvoicing).length === 0 ? {} : { eInvoicing }),
    },
    place: {
      name: model.placeName.trim(),
      plan: model.plan,
      expirationDate: expirationInstant(model.expirationDate),
      ...(model.otherAddress
        ? {
            address: {
              street: model.placeStreet.trim(),
              postcode: model.placePostcode.trim(),
              city: model.placeCity.trim(),
              ...optional('province', model.placeProvince),
            },
          }
        : {}),
      ...optional('contactName', model.contactName),
      ...optional('email', model.placeEmail),
      ...optional('phone', model.placePhone),
    },
    user: {
      username: model.username.trim(),
      password: model.password,
      ...optional('firstName', model.firstName),
      ...optional('lastName', model.lastName),
      ...optional('email', model.userEmail),
      ...optional('phone', model.userPhone),
    },
    taxes,
  };
}

/** Issue of the VAT number: 11 digits for Italy, 2 to 30 printable characters elsewhere. */
export function vatIssue(country: string, value: string): string | undefined {
  const text = value.trim();
  if (text === '') {
    return undefined;
  }
  const valid = country === 'IT' ? /^\d{11}$/.test(text) : /^[\x20-\x7E]{2,30}$/.test(text);
  return valid ? undefined : 'pattern';
}

/** Issue of the fiscal code: 16 alphanumeric characters or 11 digits for Italy, up to 30 elsewhere. */
export function fiscalCodeIssue(country: string, value: string): string | undefined {
  const text = value.trim();
  if (text === '') {
    return undefined;
  }
  const valid =
    country === 'IT' ? /^([A-Za-z0-9]{16}|\d{11})$/.test(text) : /^[\x20-\x7E]{1,30}$/.test(text);
  return valid ? undefined : 'pattern';
}

/** Issue of the recipient code: 6 or 7 letters and digits. */
export function recipientCodeIssue(value: string): string | undefined {
  const text = value.trim();
  return text === '' || /^[A-Za-z0-9]{6,7}$/.test(text) ? undefined : 'pattern';
}

/** Issue of the postcode: five digits for Italy, up to 16 characters elsewhere. */
export function postcodeIssue(country: string, value: string): string | undefined {
  const text = value.trim();
  if (text === '') {
    return 'required';
  }
  return (country === 'IT' ? /^\d{5}$/.test(text) : text.length <= 16) ? undefined : 'pattern';
}

/**
 * An Italian company needs at least one of the recipient code and the PEC for the electronic
 * invoices: the issue is on the recipient code, as the server reports it.
 */
export function eInvoicingIssue(model: NewCustomerModel): string | undefined {
  return model.country === 'IT' && model.recipientCode.trim() === '' && model.pec.trim() === ''
    ? 'required'
    : undefined;
}

/** The subject the VAT lookup (`GET /v1/vat-lookups/{vatNumber}`) found; a missing text is `null`. */
export interface VatLookup {
  readonly vatNumber: string;
  readonly name: string | null;
  readonly fiscalCode: string | null;
  readonly address: {
    readonly street: string | null;
    readonly postcode: string | null;
    readonly city: string | null;
    /** Two-letter province code. */
    readonly province: string | null;
    readonly country: 'IT';
  };
  readonly pec: string | null;
}

/** Company fields the VAT lookup can fill. The recipient code is never one of them. */
export type VatFillField =
  'companyName' | 'fiscalCode' | 'street' | 'postcode' | 'city' | 'province' | 'pec';

/** Which fields the lookup fills and which already hold a different value. */
export interface VatFillPlan {
  /** Fields that are empty and get a value. */
  readonly empty: Readonly<Partial<Record<VatFillField, string>>>;
  /** Fields that hold a different value: they change only when the user confirms. */
  readonly overwrite: Readonly<Partial<Record<VatFillField, string>>>;
}

/**
 * Compares the form with the lookup. A value the lookup does not give is left alone; a value
 * equal to the current one (ignoring case) is not a change; a province the select does not offer
 * is left empty.
 *
 * @param model The form.
 * @param found What the lookup returned.
 * @param provinces The province codes the select offers for Italy.
 * @returns The fields to fill and the fields that would be overwritten.
 */
export function planVatFill(
  model: NewCustomerModel,
  found: VatLookup,
  provinces: readonly string[],
): VatFillPlan {
  const candidates: Record<VatFillField, string | null> = {
    companyName: found.name,
    fiscalCode: found.fiscalCode,
    street: found.address.street,
    postcode: found.address.postcode,
    city: found.address.city,
    province:
      found.address.province !== null && provinces.includes(found.address.province.toUpperCase())
        ? found.address.province.toUpperCase()
        : null,
    pec: found.pec,
  };
  const empty: Partial<Record<VatFillField, string>> = {};
  const overwrite: Partial<Record<VatFillField, string>> = {};
  for (const field of Object.keys(candidates) as VatFillField[]) {
    const value = candidates[field]?.trim();
    if (value === undefined || value === '') {
      continue;
    }
    const current = model[field].trim();
    if (current === '') {
      empty[field] = value;
    } else if (current.toLowerCase() !== value.toLowerCase()) {
      overwrite[field] = value;
    }
  }
  return { empty, overwrite };
}
