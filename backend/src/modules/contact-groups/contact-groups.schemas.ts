import type { ListConfig } from '../../shared/http/list.ts';
import { listQueryShape } from '../../shared/http/list.ts';
import { integerString, nullable, object, objectId, optional, string } from '../../shared/validation/schema.ts';
import type { Infer } from '../../shared/validation/schema.ts';
import { LINE, percent } from '../contacts/contacts.schemas.ts';
import { SAFE_ID } from '../groups/catalogs/kit.ts';
import { atLeastOne } from '../product-catalog/entity.schemas.ts';

/** Largest page of a list of groups of contacts. */
export const MAX_CONTACT_GROUPS_PAGE = 100;

/** Largest body of a write of a group of contacts: a name, a price list and a percentage. */
export const CONTACT_GROUP_BODY_LIMIT = '4kb';

/** How the groups of contacts are sorted (by name, the default, or by the date of the last change) and searched (the name, literal and without regard to case). */
export const CONTACT_GROUPS_LIST: ListConfig = Object.freeze({
  sorts: Object.freeze({
    name: Object.freeze({ field: 'name', kind: 'string' as const }),
    updatedAt: Object.freeze({ field: 'updateDate', kind: 'date' as const }),
  }),
  defaultSort: 'name',
  searchFields: Object.freeze(['name']),
});

const nameSchema = () => string({ min: 1, max: 100, trim: true, pattern: LINE });
const priceListId = () => nullable(string({ min: 1, max: 64, pattern: SAFE_ID }));

/** Query of the list of the groups of contacts: the standard parameters, with a page of at most 100. */
export const contactGroupsQuery = object({ ...listQueryShape(CONTACT_GROUPS_LIST), limit: optional(integerString({ min: 1, max: MAX_CONTACT_GROUPS_PAGE })) });

/** The validated query of the list of groups of contacts. */
export type ContactGroupsQuery = Infer<typeof contactGroupsQuery>;

/** Path parameters of the routes on one group of contacts; the group was already verified by the route. */
export const contactGroupParams = object({ contactGroupId: objectId() }, { allowUnknown: true });

/** Body of `POST /v1/groups/{groupId}/contact-groups`: the name is required, the price list (an enabled one of the group) and the discount are optional. */
export const createContactGroupBody = object({ name: nameSchema(), priceListId: optional(priceListId()), discountPercent: optional(nullable(percent())) });

/** Validated body of a creation. */
export type CreateContactGroupBody = Infer<typeof createContactGroupBody>;

/** Body of `PATCH /v1/groups/{groupId}/contact-groups/{id}`: any of the fields, at least one. */
export const patchContactGroupBody = atLeastOne(object({ name: optional(nameSchema()), priceListId: optional(priceListId()), discountPercent: optional(nullable(percent())) }));

/** Validated body of a modification. */
export type PatchContactGroupBody = Infer<typeof patchContactGroupBody>;
