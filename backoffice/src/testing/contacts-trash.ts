import { ContactRow } from '../app/features/contacts/contact.types';

export const CONTACT_ID_1 = '665f1c2e9b1d4a0012ab3c01';
export const CONTACT_ID_2 = '665f1c2e9b1d4a0012ab3c02';
export const CONTACT_ID_3 = '665f1c2e9b1d4a0012ab3c03';

/** A trashed contact of the trash tab. */
export function trashedContact(id: string, over: Partial<ContactRow> = {}): ContactRow {
  return {
    id,
    code: 'K-001',
    customer: true,
    supplier: false,
    displayName: 'Mario Bianchi',
    person: { firstName: 'Mario', lastName: 'Bianchi' },
    company: { name: 'Bianchi Srl', vatNumber: '01114601006' },
    email: 'mario@example.com',
    phone: '+390212345678',
    contactGroupId: null,
    trashed: true,
    trashedAt: '2026-11-10T10:00:00.000Z',
    updatedAt: null,
    ...over,
  };
}

export const TRASHED_CONTACT = trashedContact(CONTACT_ID_1);
export const TRASHED_BARE_CONTACT = trashedContact(CONTACT_ID_2, {
  code: 'K-002',
  displayName: null,
  company: { name: '', vatNumber: '' },
  email: null,
  phone: null,
  trashedAt: null,
});
