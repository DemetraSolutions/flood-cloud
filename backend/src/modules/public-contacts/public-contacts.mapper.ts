import type { AddressData } from '../contacts/contacts.document.ts';
import type { ContactView } from '../contacts/contacts.mapper.ts';
import type { ContactGroupView } from '../contact-groups/contact-groups.service.ts';

/** A postal address as the public API shows it. */
export interface PublicAddress {
  readonly street: string;
  readonly postcode: string;
  readonly city: string;
  /** ISO alpha-2 code of the country, `null` for none. */
  readonly countryCode: string | null;
  /** Code of the province, `null` for none. */
  readonly areaCode: string | null;
}

/**
 * A loyalty card of a contact as the public API shows it. A simple card has its points; an advanced one only says that it is (`advanced: true`) and, to a key that may read the advanced cards, adds its `card`: the identifier,
 * the type, the state, the credit and the points of the card.
 */
export type PublicContactCard =
  | { readonly code: string; readonly advanced: false; readonly points: number }
  | {
      readonly code: string;
      readonly advanced: true;
      readonly card?: {
        readonly cardId: string;
        readonly cardType: { readonly id: string; readonly name: string | null } | null;
        readonly enabled: boolean | null;
        readonly balance: number | null;
        readonly totalPoints: number | null;
      };
    };

/** A contact as the public API shows it: field by field, never the price list, the e-invoicing data, the notes, the supplier price lists, the services, the account of the customer or the warnings about other contacts. */
export interface PublicContact {
  readonly id: string;
  readonly code: string;
  readonly customer: boolean;
  readonly supplier: boolean;
  readonly displayName: string | null;
  readonly contactGroupId: string | null;
  readonly person: {
    readonly firstName: string;
    readonly lastName: string;
    readonly taxCode: string;
    /** `YYYY-MM-DD`. */
    readonly birthDate: string | null;
    readonly address: PublicAddress;
    readonly phones: readonly string[];
    readonly emails: readonly string[];
    readonly discountPercent: number | null;
    /** The company contact the person works for. */
    readonly associatedCompanyId: string | null;
  };
  readonly company: {
    readonly name: string;
    readonly vatNumber: string;
    readonly taxCode: string;
    readonly address: PublicAddress;
    readonly phones: readonly string[];
    readonly emails: readonly string[];
    readonly faxes: readonly string[];
    readonly discountPercent: number | null;
  };
  readonly fidelityCards: readonly PublicContactCard[];
  readonly trashed: boolean;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

/** A group of contacts as the public API shows it: the name and the discount (never the price list). */
export interface PublicContactGroup {
  readonly id: string;
  readonly name: string;
  readonly discountPercent: number | null;
}

const toPublicAddress = (address: AddressData): PublicAddress => ({ street: address.street, postcode: address.postcode, city: address.city, countryCode: address.countryCode, areaCode: address.areaCode });

const toPublicCard = (card: ContactView['fidelityCards'][number]): PublicContactCard => {
  const { advanced } = card;
  if (advanced === null) {
    return { code: card.code, advanced: false, points: card.points };
  }
  // A caller who may not read the cards is told only that the code is an advanced card: every field of the object is `null`.
  return advanced.cardId === null
    ? { code: card.code, advanced: true }
    : { code: card.code, advanced: true, card: { cardId: advanced.cardId, cardType: advanced.cardType === null ? null : { id: advanced.cardType.id, name: advanced.cardType.name }, enabled: advanced.enabled, balance: advanced.balance, totalPoints: advanced.totalPoints } };
};

/**
 * The public representation of a contact, built field by field from the one of the backoffice: what is not listed in {@link PublicContact} is never copied, so a field added to the contact later stays private until it is added here.
 *
 * @param view The contact as the backoffice shows it.
 */
export function toPublicContact(view: ContactView): PublicContact {
  return {
    id: view.id,
    code: view.code,
    customer: view.customer,
    supplier: view.supplier,
    displayName: view.displayName,
    contactGroupId: view.contactGroupId,
    person: {
      firstName: view.person.firstName,
      lastName: view.person.lastName,
      taxCode: view.person.taxCode,
      birthDate: view.person.birthDate,
      address: toPublicAddress(view.person.address),
      phones: [...view.person.phones],
      emails: [...view.person.emails],
      discountPercent: view.person.discountPercent,
      associatedCompanyId: view.person.associatedCompanyId,
    },
    company: {
      name: view.company.name,
      vatNumber: view.company.vatNumber,
      taxCode: view.company.taxCode,
      address: toPublicAddress(view.company.address),
      phones: [...view.company.phones],
      emails: [...view.company.emails],
      faxes: [...view.company.faxes],
      discountPercent: view.company.discountPercent,
    },
    fidelityCards: view.fidelityCards.map(toPublicCard),
    trashed: view.trashed,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
  };
}

/**
 * The public representation of a group of contacts.
 *
 * @param view The group as the backoffice shows it.
 */
export function toPublicContactGroup(view: ContactGroupView): PublicContactGroup {
  return { id: view.id, name: view.name, discountPercent: view.discountPercent };
}
