import type { Document, ObjectId } from 'mongodb';
import { trashedAtOf } from '../../shared/trash/trash.ts';
import { dateOf } from '../groups/catalogs/kit.ts';
import { idOf } from '../products/products.mapper.ts';
import type { AdvancedCard } from '../fidelity-cards/fidelity-cards.document.ts';
import { cardsOf, clearList, clearText, contactData, displayNameOf } from './contacts.document.ts';
import type { ContactData, FidelityCard } from './contacts.document.ts';

/** A contact as the detail shows it: the data, the loyalty cards with their balance, and what the server calculates. */
export interface ContactView extends Omit<ContactData, 'services'> {
  readonly id: string;
  /** The cards of the contact. A code that is also the code of an advanced card (`fidelity_cards`) has `advanced`: the card, with its type, state, credit and points; the points of the contact for such a code are not moved by the sales. */
  readonly fidelityCards: readonly (FidelityCard & { readonly advanced: AdvancedCard | null })[];
  /** The services with a custom duration; only in a group that has the `services` function. */
  readonly services?: ContactData['services'];
  /** The company name, else the first name and the surname; `null` when the contact has none. */
  readonly displayName: string | null;
  readonly trashed: boolean;
  readonly trashedAt: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

/** A row of the list: what is needed to find a contact and nothing personal beyond it (no address, tax code, note, account or points). */
export interface ContactRow {
  readonly id: string;
  readonly code: string;
  readonly customer: boolean;
  readonly supplier: boolean;
  readonly displayName: string | null;
  readonly person: { readonly firstName: string; readonly lastName: string };
  readonly company: { readonly name: string; readonly vatNumber: string };
  /** The first e-mail of the person, else of the company. */
  readonly email: string | null;
  /** The first phone of the person, else of the company. */
  readonly phone: string | null;
  readonly contactGroupId: string | null;
  readonly trashed: boolean;
  readonly trashedAt: string | null;
  readonly updatedAt: string | null;
}

/**
 * A stored contact as the detail shows it. The legacy keys the backend does not own (`account.password`, `tokens`, `cGroup`, `associatedCompany`…) are never read, so they never reach the answer; a personal text in
 * the legacy encrypted format is shown as empty.
 *
 * @param document The stored contact, read with every owned field.
 * @param features What the group has: the services are shown only with `services`.
 * @param advanced The advanced cards that have a code of the contact, by code.
 */
export function contactView(document: Document, features: { readonly services: boolean }, advanced: ReadonlyMap<string, AdvancedCard> = new Map()): ContactView {
  const { services, ...data } = contactData(document);
  return {
    id: (document['_id'] as ObjectId).toHexString(),
    ...data,
    fidelityCards: cardsOf(document['fidelities']).map((card) => ({ ...card, advanced: advanced.get(card.code) ?? null })),
    ...(features.services ? { services } : {}),
    displayName: displayNameOf(data.company.name, data.person.firstName, data.person.lastName),
    trashed: document['trash'] === true,
    trashedAt: trashedAtOf(document['trashDate']),
    createdAt: dateOf(document['insertDate']),
    updatedAt: dateOf(document['updateDate']),
  };
}

/**
 * A row of the list from a stored contact read with the projection of the list.
 *
 * @param document The stored contact.
 */
export function contactRow(document: Document): ContactRow {
  const firstName = clearText(document['name']);
  const lastName = clearText(document['surname']);
  const company = clearText(document['companyName']);
  const first = (own: unknown, other: unknown): string | null => clearList(own)[0] ?? clearList(other)[0] ?? null;
  return {
    id: (document['_id'] as ObjectId).toHexString(),
    code: clearText(document['contactCode']),
    customer: document['customer'] === true,
    supplier: document['supplier'] === true,
    displayName: displayNameOf(company, firstName, lastName),
    person: { firstName, lastName },
    company: { name: company, vatNumber: clearText(document['companyCode']) },
    email: first(document['email'], document['companyEmail']),
    phone: first(document['telephone'], document['companyTelephone']),
    contactGroupId: idOf(document['cGroupId']),
    trashed: document['trash'] === true,
    trashedAt: trashedAtOf(document['trashDate']),
    updatedAt: dateOf(document['updateDate']),
  };
}
