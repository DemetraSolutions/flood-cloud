import { AppError } from '../../shared/http/errors.ts';
import type { FieldIssue } from '../../shared/validation/schema.ts';
import { minimalCompany } from './dealer.mapper.ts';
import type { Company, DealerAddress } from './dealer.types.ts';

/** The country assumed for a company without an address. */
export const DEFAULT_COUNTRY = 'IT';

/** An address as a request carries it: any part may be missing, `province` may be cleared with `null`. */
export interface AddressPatch {
  street?: string;
  postcode?: string;
  city?: string;
  province?: string | null;
  countryCode?: string;
}

/** The company fields of a request. Absent means "leave alone" (or "empty" on creation), `null` clears. */
export interface CompanyPatch {
  businessName?: string;
  vatNumber?: string | null;
  fiscalCode?: string | null;
  address?: AddressPatch | null;
  pec?: string | null;
  sdiCode?: string | null;
  email?: string | null;
  phone?: string | null;
}

const ITALIAN_VAT = /^\d{11}$/;
const FOREIGN_VAT = /^[A-Z0-9]{2,30}$/;
const ITALIAN_FISCAL_CODE = /^([A-Z0-9]{16}|\d{11})$/;
const ITALIAN_PROVINCE = /^[A-Z]{2}$/;
const SDI_CODE = /^[A-Z0-9]{7}$/;

const upper = (value: string | null): string | null => (value === null ? null : value.toUpperCase());

/** Merges a request address onto the stored one (JSON Merge Patch: a part left out keeps its value). */
function mergeAddress(current: DealerAddress | null, patch: AddressPatch, prefix: string, issues: FieldIssue[]): DealerAddress | null {
  const street = patch.street ?? current?.street;
  const postcode = patch.postcode ?? current?.postcode;
  const city = patch.city ?? current?.city;
  for (const [name, value] of [['street', street], ['postcode', postcode], ['city', city]] as const) {
    if (value === undefined) {
      issues.push({ field: `${prefix}address.${name}`, issue: 'required' });
    }
  }
  if (street === undefined || postcode === undefined || city === undefined) {
    return null;
  }
  return {
    street,
    postcode,
    city,
    province: upper(patch.province !== undefined ? patch.province : (current?.province ?? null)),
    countryCode: (patch.countryCode ?? current?.countryCode ?? DEFAULT_COUNTRY).toUpperCase(),
  };
}

/** The country-dependent rules, on the final company. */
function countryIssues(company: Company, prefix: string): FieldIssue[] {
  const issues: FieldIssue[] = [];
  const italian = (company.address?.countryCode ?? DEFAULT_COUNTRY) === DEFAULT_COUNTRY;
  if (company.vatNumber !== null && !(italian ? ITALIAN_VAT : FOREIGN_VAT).test(company.vatNumber)) {
    issues.push({ field: `${prefix}vatNumber`, issue: 'pattern' });
  }
  if (company.fiscalCode !== null && !(italian ? ITALIAN_FISCAL_CODE : FOREIGN_VAT).test(company.fiscalCode)) {
    issues.push({ field: `${prefix}fiscalCode`, issue: 'pattern' });
  }
  if (company.sdiCode !== null && !SDI_CODE.test(company.sdiCode)) {
    issues.push({ field: `${prefix}sdiCode`, issue: 'pattern' });
  }
  if (italian && company.address !== null) {
    if (company.address.province === null) {
      issues.push({ field: `${prefix}address.province`, issue: 'required' });
    } else if (!ITALIAN_PROVINCE.test(company.address.province)) {
      issues.push({ field: `${prefix}address.province`, issue: 'pattern' });
    }
  }
  return issues;
}

/**
 * Builds the final company from a request: the stored company (or an empty one on creation) with the
 * request applied as a JSON Merge Patch, codes in upper case, then the rules that depend on the country
 * (Italian VAT number of 11 digits, fiscal code of 16 characters or 11 digits, province of two letters,
 * recipient code of seven characters; elsewhere 2 to 30 letters and digits) checked on the whole result.
 *
 * @param current The stored company, or `null` for a new one.
 * @param patch The validated request fields.
 * @param prefix Prefix of the `field` of the issues (`company.` when the fields sit inside a `company` object).
 * @returns The company to store.
 * @throws {AppError} `VALIDATION_ERROR` with every issue found.
 */
export function mergeCompany(current: Company | null, patch: CompanyPatch, prefix = ''): Company {
  const base = current ?? minimalCompany('');
  const issues: FieldIssue[] = [];
  const address = patch.address === undefined ? base.address : patch.address === null ? null : mergeAddress(base.address, patch.address, prefix, issues);
  const company: Company = {
    businessName: patch.businessName ?? base.businessName,
    vatNumber: upper(patch.vatNumber === undefined ? base.vatNumber : patch.vatNumber),
    fiscalCode: upper(patch.fiscalCode === undefined ? base.fiscalCode : patch.fiscalCode),
    address,
    pec: patch.pec === undefined ? base.pec : patch.pec,
    sdiCode: upper(patch.sdiCode === undefined ? base.sdiCode : patch.sdiCode),
    email: patch.email === undefined ? base.email : patch.email,
    phone: patch.phone === undefined ? base.phone : patch.phone,
  };
  issues.push(...countryIssues(company, prefix));
  if (issues.length > 0) {
    throw new AppError('VALIDATION_ERROR', { details: issues });
  }
  return company;
}
