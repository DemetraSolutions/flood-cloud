import type { CervedCompany } from '../../integrations/cerved/index.ts';

/** What the lookup answers: the data a new customer form can be filled with. No recipient code, no ATECO code, no legal form. */
export interface VatLookupResult {
  readonly vatNumber: string;
  readonly name: string | null;
  readonly fiscalCode: string | null;
  readonly address: {
    readonly street: string | null;
    readonly postcode: string | null;
    readonly city: string | null;
    /** The two-letter code, `null` when the provider gave anything else. */
    readonly province: string | null;
    /** Always `IT`: the lookup is for Italian VAT numbers. */
    readonly country: 'IT';
  };
  /** The certified e-mail address, `null` when there is none or it could not be read. */
  readonly pec: string | null;
}

/**
 * The response of the lookup, built field by field (nothing of the provider's answer passes through unchecked).
 *
 * @param company The company found.
 * @param pec Its PEC address, or `null`.
 */
export function toVatLookupResult(company: CervedCompany, pec: string | null): VatLookupResult {
  const province = company.province !== null && /^[A-Za-z]{2}$/.test(company.province) ? company.province.toUpperCase() : null;
  return {
    vatNumber: company.vatNumber,
    name: company.name,
    fiscalCode: company.fiscalCode,
    address: { street: company.street, postcode: company.postcode, city: company.city, province, country: 'IT' },
    pec,
  };
}
