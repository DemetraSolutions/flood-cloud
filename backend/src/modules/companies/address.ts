import type { Country } from './companies.repository.ts';

/**
 * Checks the country and the province of an address against the countries of the platform (`common.countries`), the rule of the companies and of the places: a country that is not
 * there is `incorrect` (when it is being set), and a province that is not one of the areas of a country that lists areas is `incorrect` (a country without areas takes any, and `''` is none).
 *
 * @param findCountry Reads a country by its code.
 * @param country The country code the address will have, `null` when it has none.
 * @param province The province code the address will have, `''` for none.
 * @param countrySet Whether the country is being set or changed (a creation, or a request that changes it): only then a country that does not exist is refused, so an address with a
 * historical country can still be changed in what the rule does not touch.
 * @returns The field of the first problem (`address.country` or `address.province`), `null` when the address is fine.
 */
export async function addressProblem(findCountry: (code: string) => Promise<Country | null>, country: string | null, province: string, countrySet: boolean): Promise<'address.country' | 'address.province' | null> {
  const found = country === null ? null : await findCountry(country);
  if (found === null && countrySet) {
    return 'address.country';
  }
  return found?.areas != null && province !== '' && !found.areas.has(province) ? 'address.province' : null;
}
