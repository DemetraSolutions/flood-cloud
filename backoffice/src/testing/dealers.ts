import { DealerRecord } from '../app/features/dealers/dealer.types';

/** A complete dealer for tests; override what the test cares about. */
export function fakeDealer(overrides: Partial<DealerRecord> = {}): DealerRecord {
  return {
    id: '665f1c2e9b1d4a0012ab34d1',
    businessName: 'Dealer Nord Srl',
    vatNumber: '01234567890',
    fiscalCode: '01234567890',
    address: {
      street: 'Via Roma 1',
      postcode: '20100',
      city: 'Milano',
      province: 'MI',
      countryCode: 'IT',
    },
    pec: 'nord@pec.example.com',
    sdiCode: 'ABC1234',
    email: 'info@nord.example.com',
    phone: '+39 02 1234567',
    source: 'manual',
    createdAt: '2026-11-04T09:00:00.000Z',
    updatedAt: '2026-11-05T09:00:00.000Z',
    user: { id: '665f1c2e9b1d4a0012ab34d1', username: 'dealer.nord', status: 'active' },
    ...overrides,
  };
}
