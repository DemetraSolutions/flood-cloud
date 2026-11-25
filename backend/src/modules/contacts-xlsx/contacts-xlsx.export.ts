import type { Document } from 'mongodb';
import type { ReferenceMode } from '../catalog-xlsx/catalog-xlsx.export.ts';
import type { Named } from '../catalog-xlsx/catalog-xlsx.rules.ts';
import { cardsOf, contactData } from '../contacts/contacts.document.ts';
import { CONTACT_COLUMNS } from './contacts-xlsx.columns.ts';

const flag = (value: boolean): string => (value ? 'X' : '');
const percent = (value: number | null): string => (value === null ? '' : String(value));

/** A date `YYYY-MM-DD` as the header of the column writes it, `AAAA/MM/GG`. */
const dateText = (value: string | null): string => (value === null ? '' : value.replaceAll('-', '/'));

/**
 * The cells of a contact in the order of {@link CONTACT_COLUMNS}: the data as the API reads them (a text the legacy stored encrypted is empty), one phone, one e-mail and one fax for each column (the first), the codes of
 * the cards without their points (the points of a card are never in the file), the price list as an id or as its name, and an empty deletion column.
 *
 * @param document The stored contact, read with every owned field.
 * @param priceLists The price lists of the group.
 * @param mode How the price list is written.
 */
export function contactRow(document: Document, priceLists: readonly Named[], mode: ReferenceMode): string[] {
  const data = contactData(document);
  const { person, company } = data;
  const priceList = data.priceListId === null ? '' : mode === 'ids' ? data.priceListId : (priceLists.find((list) => list.id === data.priceListId)?.name ?? data.priceListId);
  const values: Record<string, string> = {
    id: (document['_id'] as { toHexString(): string }).toHexString(),
    code: data.code,
    priceList,
    customer: flag(data.customer),
    supplier: flag(data.supplier),
    firstName: person.firstName,
    lastName: person.lastName,
    taxCode: person.taxCode,
    birthDate: dateText(person.birthDate),
    street: person.address.street,
    postcode: person.address.postcode,
    city: person.address.city,
    area: person.address.areaCode ?? '',
    country: person.address.countryCode ?? '',
    phone: person.phones[0] ?? '',
    email: person.emails[0] ?? '',
    discount: percent(person.discountPercent),
    companyName: company.name,
    vatNumber: company.vatNumber,
    companyTaxCode: company.taxCode,
    companyStreet: company.address.street,
    companyPostcode: company.address.postcode,
    companyCity: company.address.city,
    companyArea: company.address.areaCode ?? '',
    companyCountry: company.address.countryCode ?? '',
    companyPhone: company.phones[0] ?? '',
    companyEmail: company.emails[0] ?? '',
    fax: company.faxes[0] ?? '',
    companyDiscount: percent(company.discountPercent),
    fidelity: cardsOf(document['fidelities']).map((card) => card.code).join(' | '),
    transmission: data.eInvoicing.transmissionFormat,
    channel: data.eInvoicing.channel,
    recipientCode: data.eInvoicing.recipientCode ?? '',
    pec: data.eInvoicing.pec ?? '',
    delete: '',
  };
  return CONTACT_COLUMNS.map((column) => values[column.key]!);
}
