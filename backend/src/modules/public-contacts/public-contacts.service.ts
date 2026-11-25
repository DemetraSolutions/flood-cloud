import type { ObjectId } from 'mongodb';
import type { ClientContext } from '../../shared/http/client-context.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { ApiKeyPrincipal } from '../../shared/security/scope/principal.ts';
import type { ContactGroupsService } from '../contact-groups/contact-groups.service.ts';
import type { ContactResult, ContactsService } from '../contacts/contacts.service.ts';
import { groupCallerOf } from '../public-catalog/public-catalog.caller.ts';
import type { PublicCatalogPage, PublicEntry } from '../public-catalog/public-catalog.service.ts';
import { toPublicContact, toPublicContactGroup } from './public-contacts.mapper.ts';
import type { PublicContact, PublicContactGroup } from './public-contacts.mapper.ts';
import { PUBLIC_CONTACTS_DEFAULT_PAGE } from './public-contacts.schemas.ts';
import type { PublicContactGroupsQuery, PublicContactsQuery, PublicCreateContactBody, PublicPatchContactBody } from './public-contacts.schemas.ts';

/**
 * The contacts of the public API (`doc/Public-API.md`): what an integration with a public key reads (`contacts:read`) and writes (`contacts:write`). Every operation goes through the same service of the backoffice, with all its rules,
 * as a caller built from the key alone: the group is the one of the key, never a value of the client, and the restrictions of the key to companies and places do not narrow it (the contacts have no perimeter of places). What the
 * key does not see (the price list, the notes, the e-invoicing data, the services, the account, the price lists of a supplier) is never in an answer and is kept as it is by a modification, which the service merges field by field. A
 * read without `updatedSince` lists the contacts that are not in the trash; with it, everything changed from that instant, the trashed ones included (a contact deleted for good cannot be told, and the API never deletes one).
 */
export interface PublicContactsService {
  listContacts(principal: ApiKeyPrincipal, access: GroupAccess, query: PublicContactsQuery): Promise<PublicCatalogPage<PublicContact>>;
  getContact(principal: ApiKeyPrincipal, access: GroupAccess, id: ObjectId): Promise<PublicEntry<PublicContact>>;
  createContact(principal: ApiKeyPrincipal, access: GroupAccess, body: PublicCreateContactBody, client: ClientContext): Promise<PublicEntry<PublicContact>>;
  updateContact(principal: ApiKeyPrincipal, access: GroupAccess, id: ObjectId, expected: string, body: PublicPatchContactBody, client: ClientContext): Promise<PublicEntry<PublicContact>>;
  trashContact(principal: ApiKeyPrincipal, access: GroupAccess, id: ObjectId, expected: string, client: ClientContext): Promise<PublicEntry<PublicContact>>;
  restoreContact(principal: ApiKeyPrincipal, access: GroupAccess, id: ObjectId, expected: string, client: ClientContext): Promise<PublicEntry<PublicContact>>;
  listContactGroups(principal: ApiKeyPrincipal, access: GroupAccess, query: PublicContactGroupsQuery): Promise<PublicCatalogPage<PublicContactGroup>>;
  getContactGroup(principal: ApiKeyPrincipal, access: GroupAccess, id: ObjectId): Promise<PublicEntry<PublicContactGroup>>;
}

/** Collaborators of {@link createPublicContactsService}: the services of the contacts and of their groups. */
export interface PublicContactsServiceDeps {
  readonly contacts: Pick<ContactsService, 'listChanges' | 'get' | 'create' | 'update' | 'trash' | 'restore'>;
  readonly contactGroups: Pick<ContactGroupsService, 'list' | 'get'>;
}

/**
 * Builds the contacts service of the public API.
 *
 * @param deps The services of the contacts and of their groups.
 */
export function createPublicContactsService(deps: PublicContactsServiceDeps): PublicContactsService {
  const { contacts, contactGroups } = deps;
  const contactResult = (result: ContactResult): PublicEntry<PublicContact> => ({ entity: toPublicContact(result.entity), version: result.version });
  return {
    listContacts: async (principal, access, query) => {
      const { items, page } = await contacts.listChanges(groupCallerOf(principal), access, { ...query, limit: query.limit ?? PUBLIC_CONTACTS_DEFAULT_PAGE });
      return { items: items.map(toPublicContact), page };
    },
    getContact: async (principal, access, id) => contactResult(await contacts.get(groupCallerOf(principal), access, id)),
    createContact: async (principal, access, body, client) => contactResult(await contacts.create(groupCallerOf(principal), access, body, client)),
    updateContact: async (principal, access, id, expected, body, client) => contactResult(await contacts.update(groupCallerOf(principal), access, id, expected, body, client)),
    trashContact: async (principal, access, id, expected, client) => contactResult(await contacts.trash(groupCallerOf(principal), access, id, expected, client)),
    restoreContact: async (principal, access, id, expected, client) => contactResult(await contacts.restore(groupCallerOf(principal), access, id, expected, client)),
    listContactGroups: async (principal, access, query) => {
      const { items, page } = await contactGroups.list(groupCallerOf(principal), access, query);
      return { items: items.map(toPublicContactGroup), page };
    },
    getContactGroup: async (principal, access, id) => {
      const found = await contactGroups.get(groupCallerOf(principal), access, id);
      return { entity: toPublicContactGroup(found.entity), version: found.version };
    },
  };
}
