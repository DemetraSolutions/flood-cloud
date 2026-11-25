import { listQueryShape } from '../../shared/http/list.ts';
import { enumOf, integerString, object, objectId, optional, string } from '../../shared/validation/schema.ts';
import type { Infer } from '../../shared/validation/schema.ts';
import { CONTACTS_LIST, CONTACT_KINDS, companyShape, contactShape, flag } from '../contacts/contacts.schemas.ts';
import { CONTACT_GROUPS_LIST } from '../contact-groups/contact-groups.schemas.ts';
import { isoInstant } from '../groups/catalogs/kit.ts';
import { atLeastOne } from '../product-catalog/entity.schemas.ts';
import { hexId } from '../products/products.schemas.ts';

/** Page of the contacts a public key reads when it asks for none, and the largest it may ask for: every contact comes whole. */
export const PUBLIC_CONTACTS_DEFAULT_PAGE = 25;
export const PUBLIC_CONTACTS_MAX_PAGE = 50;

/** Page of the groups of contacts a public key reads when it asks for none, and the largest it may ask for. */
export const PUBLIC_CONTACT_GROUPS_DEFAULT_PAGE = 50;
export const PUBLIC_CONTACT_GROUPS_MAX_PAGE = 100;

/**
 * Query of `GET /public/v1/contacts`: the page, the order (`displayName`, `lastName`, `companyName`, `updatedAt`, each also with a leading `-`), the search text, the kind (`customers`, `suppliers`, `others`, `all`), the group of
 * contacts, `trashed` and `updatedSince` (an ISO 8601 instant). Nothing else.
 */
export const publicContactsQuery = object({
  ...listQueryShape(CONTACTS_LIST),
  limit: optional(integerString({ min: 1, max: PUBLIC_CONTACTS_MAX_PAGE })),
  q: optional(string({ min: 1, max: 100, trim: true })),
  kind: optional(enumOf(CONTACT_KINDS)),
  contactGroupId: optional(hexId()),
  trashed: optional(flag()),
  updatedSince: optional(isoInstant()),
});

/** The validated query of the public list of contacts. */
export type PublicContactsQuery = Infer<typeof publicContactsQuery>;

/** Query of `GET /public/v1/contact-groups`: the page, the order (`name`, `updatedAt`) and the search text on the name. Nothing else. */
export const publicContactGroupsQuery = object({
  ...listQueryShape(CONTACT_GROUPS_LIST),
  limit: optional(integerString({ min: 1, max: PUBLIC_CONTACT_GROUPS_MAX_PAGE })),
});

/** The validated query of the public list of groups of contacts. */
export type PublicContactGroupsQuery = Infer<typeof publicContactGroupsQuery>;

/** Path parameter of the routes on one contact. */
export const publicContactParams = object({ contactId: objectId() });

/** Path parameter of the routes on one group of contacts. */
export const publicContactGroupParams = object({ contactGroupId: objectId() });

/**
 * The fields of a contact a public body never has: the price list, the notes, the e-invoicing data, the services, the account of the customer and the price lists of a supplier. They are not in the public representation either,
 * and a write of the key never changes them. Anything not listed here is the same as the backoffice.
 */
function publicContactShape() {
  const { priceListId: _priceList, notes: _notes, eInvoicing: _eInvoicing, account: _account, services: _services, company: _company, ...rest } = contactShape();
  const { supplierPriceLists: _supplierPriceLists, ...company } = companyShape();
  return { ...rest, company: optional(object(company)) };
}

/** Body of `POST /public/v1/contacts`: every field optional (a contact needs a first name or a company name), nothing else accepted. */
export const publicCreateContactBody = object(publicContactShape());

/** Validated body of a public creation of a contact. */
export type PublicCreateContactBody = Infer<typeof publicCreateContactBody>;

/** Body of `PATCH /public/v1/contacts/{contactId}`: any of the fields, at least one; the objects `person` and `company` and the addresses are merged field by field. */
export const publicPatchContactBody = atLeastOne(object(publicContactShape()));

/** Validated body of a public modification of a contact. */
export type PublicPatchContactBody = Infer<typeof publicPatchContactBody>;
