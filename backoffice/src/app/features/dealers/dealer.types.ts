import { ApiError } from '../../core/api/api-error';
import { UserStatus } from '../users/user.types';

/** Postal address of a dealer. */
export interface DealerAddress {
  readonly street: string;
  readonly postcode: string;
  readonly city: string;
  readonly province: string | null;
  readonly countryCode: string;
}

/** A dealer as returned by `/v1/dealers`: company data and the linked `D` user. */
export interface DealerRecord {
  readonly id: string;
  readonly businessName: string;
  readonly vatNumber: string | null;
  readonly fiscalCode: string | null;
  readonly address: DealerAddress | null;
  readonly pec: string | null;
  readonly sdiCode: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly source: 'manual' | 'migration' | 'user';
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly user: {
    readonly id: string;
    readonly username: string;
    readonly status: UserStatus;
  } | null;
}

/** Company part of the dealer form (text fields are `''` when empty). */
export interface CompanyModel {
  businessName: string;
  vatNumber: string;
  fiscalCode: string;
  street: string;
  postcode: string;
  city: string;
  province: string;
  countryCode: string;
  pec: string;
  sdiCode: string;
  email: string;
  phone: string;
}

/** Access user part of the dealer form. */
export interface DealerUserModel {
  username: string;
  password: string;
  userFirstName: string;
  userLastName: string;
  userEmail: string;
  userPhone: string;
  userLanguage: string;
}

/** Whole dealer form. */
export type DealerFormModel = CompanyModel & DealerUserModel;

/** Body of the company in the creation, or fields of the modification. */
export interface CompanyBody {
  businessName?: string;
  vatNumber?: string | null;
  fiscalCode?: string | null;
  address?: Partial<Record<keyof DealerAddress, string | null>> | null;
  pec?: string | null;
  sdiCode?: string | null;
  email?: string | null;
  phone?: string | null;
}

/** Default country of a dealer. */
export const DEFAULT_COUNTRY = 'IT';

const ITALIAN_VAT = /^\d{11}$/;
const FOREIGN_CODE = /^[A-Z0-9]{2,30}$/;
const ITALIAN_FISCAL_CODE = /^([A-Z0-9]{16}|\d{11})$/;
const SDI_CODE = /^[A-Z0-9]{7}$/;
const PROVINCE = /^[A-Z]{2}$/;

/** Trimmed text, or `null` when blank. */
export function textOrNull(value: string): string | null {
  return value.trim() === '' ? null : value.trim();
}

function codeOrNull(value: string): string | null {
  return textOrNull(value)?.toUpperCase() ?? null;
}

/** Whether the user filled any part of the address (then street, postcode and city are needed). */
export function hasAddress(model: CompanyModel): boolean {
  return [model.street, model.postcode, model.city, model.province].some((v) => v.trim() !== '');
}

/** Whether the company is Italian (no address, or country `IT`): stricter code rules apply. */
export function isItalian(model: CompanyModel): boolean {
  return (
    (textOrNull(model.countryCode)?.toUpperCase() ?? DEFAULT_COUNTRY) === DEFAULT_COUNTRY ||
    !hasAddress(model)
  );
}

/**
 * Issue of a company code (`vatNumber`, `fiscalCode`) for the country rules of the backend, or
 * `undefined` when valid or empty.
 */
export function codeIssue(
  kind: 'vatNumber' | 'fiscalCode',
  model: CompanyModel,
): 'pattern' | undefined {
  const value = codeOrNull(model[kind]);
  if (value === null) {
    return undefined;
  }
  const rule = isItalian(model)
    ? kind === 'vatNumber'
      ? ITALIAN_VAT
      : ITALIAN_FISCAL_CODE
    : FOREIGN_CODE;
  return rule.test(value) ? undefined : 'pattern';
}

/** Issue of the recipient code (7 alphanumeric characters), if any. */
export function sdiIssue(value: string): 'pattern' | undefined {
  const code = codeOrNull(value);
  return code === null || SDI_CODE.test(code) ? undefined : 'pattern';
}

/** Issue of the province: required in Italy once there is an address, two letters. */
export function provinceIssue(model: CompanyModel): 'required' | 'pattern' | undefined {
  if (!hasAddress(model) || !isItalian(model)) {
    return undefined;
  }
  const province = codeOrNull(model.province);
  if (province === null) {
    return 'required';
  }
  return PROVINCE.test(province) ? undefined : 'pattern';
}

/** Company part of the form for a stored dealer, or the empty one for a new dealer. */
export function toCompanyModel(dealer: DealerRecord | null): CompanyModel {
  return {
    businessName: dealer?.businessName ?? '',
    vatNumber: dealer?.vatNumber ?? '',
    fiscalCode: dealer?.fiscalCode ?? '',
    street: dealer?.address?.street ?? '',
    postcode: dealer?.address?.postcode ?? '',
    city: dealer?.address?.city ?? '',
    province: dealer?.address?.province ?? '',
    countryCode: dealer?.address?.countryCode ?? DEFAULT_COUNTRY,
    pec: dealer?.pec ?? '',
    sdiCode: dealer?.sdiCode ?? '',
    email: dealer?.email ?? '',
    phone: dealer?.phone ?? '',
  };
}

/** Whole form for a stored dealer (no user part) or a new one. */
export function toDealerFormModel(dealer: DealerRecord | null): DealerFormModel {
  return {
    ...toCompanyModel(dealer),
    username: '',
    password: '',
    userFirstName: '',
    userLastName: '',
    userEmail: '',
    userPhone: '',
    userLanguage: 'it',
  };
}

/** Company of the creation body: only the filled fields, codes in upper case. */
export function buildCompanyBody(model: CompanyModel): CompanyBody & { businessName: string } {
  const body: CompanyBody & { businessName: string } = { businessName: model.businessName.trim() };
  const fields = {
    vatNumber: codeOrNull(model.vatNumber),
    fiscalCode: codeOrNull(model.fiscalCode),
    pec: textOrNull(model.pec),
    sdiCode: codeOrNull(model.sdiCode),
    email: textOrNull(model.email),
    phone: textOrNull(model.phone),
  };
  for (const [name, value] of Object.entries(fields)) {
    if (value !== null) {
      Object.assign(body, { [name]: value });
    }
  }
  if (hasAddress(model)) {
    body.address = {
      street: model.street.trim(),
      postcode: model.postcode.trim(),
      city: model.city.trim(),
      countryCode: (textOrNull(model.countryCode) ?? DEFAULT_COUNTRY).toUpperCase(),
      ...(codeOrNull(model.province) === null ? {} : { province: codeOrNull(model.province) }),
    };
  }
  return body;
}

/**
 * Modification body: only what differs from the stored dealer (an emptied field is `null`). The
 * address is a partial merge: only the changed parts, or `null` when it was removed altogether.
 */
export function buildCompanyPatch(model: CompanyModel, dealer: DealerRecord | null): CompanyBody {
  const patch: CompanyBody = {};
  if (dealer === null) {
    return patch;
  }
  if (model.businessName.trim() !== dealer.businessName) {
    patch.businessName = model.businessName.trim();
  }
  const fields = {
    vatNumber: codeOrNull(model.vatNumber),
    fiscalCode: codeOrNull(model.fiscalCode),
    pec: textOrNull(model.pec),
    sdiCode: codeOrNull(model.sdiCode),
    email: textOrNull(model.email),
    phone: textOrNull(model.phone),
  } as const;
  for (const [name, value] of Object.entries(fields) as [keyof typeof fields, string | null][]) {
    if (value !== dealer[name]) {
      patch[name] = value;
    }
  }
  const address = addressPatch(model, dealer.address);
  if (address !== undefined) {
    patch.address = address;
  }
  return patch;
}

function addressPatch(
  model: CompanyModel,
  current: DealerAddress | null,
): CompanyBody['address'] | undefined {
  if (!hasAddress(model)) {
    return current === null ? undefined : null;
  }
  const next = buildCompanyBody(model).address as Record<string, string | null>;
  const changed: Record<string, string | null> = {};
  for (const name of ['street', 'postcode', 'city', 'countryCode'] as const) {
    if (next[name] !== (current?.[name] ?? null)) {
      changed[name] = next[name];
    }
  }
  const province = next['province'] ?? null;
  if (province !== (current?.province ?? null)) {
    changed['province'] = province;
  }
  return Object.keys(changed).length === 0 ? undefined : changed;
}

const USER_FIELDS: Readonly<Record<string, string>> = {
  username: 'username',
  password: 'password',
  firstName: 'userFirstName',
  lastName: 'userLastName',
  email: 'userEmail',
  phone: 'userPhone',
  language: 'userLanguage',
};

/** Form field a backend `details[].field` belongs to (`company.address.city` -> `city`). */
export function formFieldOf(field: string): string {
  if (field.startsWith('user.')) {
    const name = field.slice('user.'.length);
    return Object.hasOwn(USER_FIELDS, name) ? USER_FIELDS[name] : field;
  }
  return field.replace(/^company\./, '').replace(/^address\./, '');
}

/** The same error with the details renamed to the fields of the form. */
export function toFormErrors(error: ApiError): ApiError {
  return new ApiError({
    status: error.status,
    code: error.code as ApiError['code'],
    message: error.message,
    requestId: error.requestId,
    details: error.details.map((detail) => ({
      field: formFieldOf(detail.field),
      issue: detail.issue,
    })),
  });
}
