import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { nonEmptyOrNull, stringOrNull } from '../companies/company.mapper.ts';
import type { Currency } from '../groups/catalogs/currencies.ts';
import type { MeasureUnit } from '../groups/catalogs/measure-units.ts';
import type { PriceList } from '../groups/catalogs/price-lists.ts';
import type { Tax } from '../groups/catalogs/taxes.ts';
import { toRestrictionsResponse } from '../api-keys/api-keys.mapper.ts';
import type { ApiKeyPrincipal } from '../../shared/security/scope/principal.ts';

/** The fields of a place the public API reads from the copies: an allowlist, the only ones ever loaded for it (no credential, dealer setting, network datum, key or device). */
export const PUBLIC_PLACE_PROJECTION = Object.freeze({
  name: 1,
  companyId: 1,
  address: 1,
  postcode: 1,
  city: 1,
  countryAreaCode: 1,
  countryCode: 1,
  email: 1,
  telephone: 1,
  status: 1,
  timezone: 1,
} as const);

/** The fields of a company the public API reads from the copies: an allowlist (no bank, IBAN or invoicing setting). */
export const PUBLIC_COMPANY_PROJECTION = Object.freeze({
  name: 1,
  code: 1,
  code2: 1,
  address: 1,
  postcode: 1,
  city: 1,
  countryAreaCode: 1,
  countryCode: 1,
  email: 1,
  telephone: 1,
} as const);

const idOf = (value: unknown): string | null => (value instanceof ObjectId ? value.toHexString() : null);

/** The postal address of a registry document, as the public API shows it. */
function addressOf(document: Document) {
  return {
    street: stringOrNull(document['address']),
    postcode: stringOrNull(document['postcode']),
    city: stringOrNull(document['city']),
    province: stringOrNull(document['countryAreaCode']),
    country: stringOrNull(document['countryCode']),
  };
}

/**
 * The public representation of a place, field by field: whatever else the copy holds is never in the result. A value that is missing or has the wrong type is `null` (the name `''`, the status `disabled`
 * unless it is exactly `true`).
 *
 * @param document A copy of a place read with {@link PUBLIC_PLACE_PROJECTION}.
 */
export function toPublicPlace(document: Document) {
  return {
    id: (document['_id'] as ObjectId).toHexString(),
    name: stringOrNull(document['name']) ?? '',
    companyId: idOf(document['companyId']),
    address: addressOf(document),
    phone: nonEmptyOrNull(document['telephone']),
    email: nonEmptyOrNull(document['email']),
    status: document['status'] === true ? ('active' as const) : ('disabled' as const),
    timezone: nonEmptyOrNull(document['timezone']),
  };
}

/**
 * The public representation of a company, field by field. A value that is missing or has the wrong type is `null` (the name `''`).
 *
 * @param document A copy of a company read with {@link PUBLIC_COMPANY_PROJECTION}.
 */
export function toPublicCompany(document: Document) {
  return {
    id: (document['_id'] as ObjectId).toHexString(),
    name: stringOrNull(document['name']) ?? '',
    vatNumber: nonEmptyOrNull(document['code']),
    fiscalCode: nonEmptyOrNull(document['code2']),
    address: addressOf(document),
    email: nonEmptyOrNull(document['email']),
    phone: nonEmptyOrNull(document['telephone']),
  };
}

/** A price list of the group, as the public API shows it. */
export function toPublicPriceList(priceList: PriceList) {
  return { id: priceList.id, name: priceList.name, enabled: priceList.enabled, isDefault: priceList.isDefault };
}

/** A tax rate of the group, as the public API shows it. */
export function toPublicTax(tax: Tax) {
  return { id: tax.id, rate: tax.rate, department: tax.department, description: tax.description, vatNature: tax.vatNature };
}

/** A currency of the group, as the public API shows it. */
export function toPublicCurrency(currency: Currency) {
  return { code: currency.code, symbol: currency.symbol };
}

/** A measure unit of the group, as the public API shows it: the id, the value and the name (which is the value). */
export function toPublicMeasureUnit(unit: MeasureUnit) {
  return { id: unit.id, value: unit.value, name: unit.value };
}

/**
 * The answer of `GET /public/v1/me`: the key, its group, its limits and what it used today.
 *
 * @param principal The authenticated key.
 * @param callsToday Requests counted today against the daily quota (this one included).
 */
export function toMe(principal: ApiKeyPrincipal, callsToday: number) {
  return {
    key: {
      id: principal.keyId.toHexString(),
      name: principal.name,
      prefix: principal.prefix,
      permissions: [...principal.permissions],
      restrictions: toRestrictionsResponse(principal.restrictions),
      expiresAt: principal.expiresAt === null ? null : principal.expiresAt.toISOString(),
    },
    group: { id: principal.groupId.toHexString(), name: principal.groupName },
    limits: {
      rateLimitPerMinute: principal.rateLimitPerMinute,
      dailyQuota: principal.dailyQuota,
      group: { rateLimitPerMinute: principal.groupRateLimitPerMinute, dailyQuota: principal.groupDailyQuota },
    },
    usageToday: { calls: callsToday },
  };
}
