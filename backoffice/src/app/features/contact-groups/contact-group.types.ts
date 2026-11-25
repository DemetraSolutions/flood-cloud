/** Path segment of the groups of contacts under `/v1/groups/{groupId}`. */
export const CONTACT_GROUPS_SEGMENT = 'contact-groups';

/** Limits of the server (`doc/API.md`, "Gruppi di contatti"). */
export const CONTACT_GROUP_LIMITS = Object.freeze({ name: 100 });

/** A group of contacts as the server returns it. */
export interface ContactGroup {
  readonly id: string;
  readonly name: string;
  /** The price list the contacts of the group are sold with, `null` for none. */
  readonly priceListId: string | null;
  /** The discount of the contacts of the group, 0 to 100, `null` for none. */
  readonly discountPercent: number | null;
  /** How many contacts (not in the trash) the group has; only in the detail. */
  readonly contactsCount?: number;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

/**
 * Router commands of the list of the groups of contacts, of one group or of the page of a new one.
 *
 * @param groupId Group of the contacts.
 * @param contactGroupId The group of contacts; `null` for the page of a new one, omitted for the list.
 */
export function contactGroupRoute(groupId: string, contactGroupId?: string | null): string[] {
  const base = ['/groups', groupId, CONTACT_GROUPS_SEGMENT];
  return contactGroupId === undefined ? base : [...base, contactGroupId === null ? 'new' : contactGroupId];
}
