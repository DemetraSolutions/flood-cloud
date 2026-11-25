import { ContactRow } from '../app/features/contacts/contact.types';

export const CONTACT_ID_1 = '665f1c2e9b1d4a0012ab3c01';
export const CONTACT_ID_2 = '665f1c2e9b1d4a0012ab3c02';
export const CONTACT_ID_3 = '665f1c2e9b1d4a0012ab3c03';
export const CONTACT_ID_4 = '665f1c2e9b1d4a0012ab3c04';

/** A row of the list of contacts (every field set to something plausible); override what the test cares about. */
export function contactRow(id: string, over: Partial<ContactRow> = {}): ContactRow {
  return {
    id,
    code: 'K-001',
    customer: true,
    supplier: false,
    displayName: 'Anna Bianchi',
    person: { firstName: 'Anna', lastName: 'Bianchi' },
    company: { name: 'Bianchi Srl', vatNumber: '01234567890' },
    email: 'anna@example.com',
    phone: '+39 02 1234567',
    contactGroupId: null,
    trashed: false,
    trashedAt: null,
    updatedAt: '2026-05-01T10:30:00.000Z',
    ...over,
  };
}
