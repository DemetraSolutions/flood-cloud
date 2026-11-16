import { randomBytes } from 'node:crypto';
import type { Document } from 'mongodb';

/** A valid Italian VAT number (the one the company tests use). */
export const ONBOARDING_VAT = '00743110157';

/** A password the policy accepts, different on every run. */
export const onboardingPassword = (): string => `Pw-${randomBytes(8).toString('hex')}-Provv`;

let counter = 0;

/** A user name nobody has taken yet. */
export const freshUsername = (): string => `sa.onboarding.${String(counter++)}.${randomBytes(3).toString('hex')}`;

/**
 * A valid body of the creation of a customer: Italian company with a recipient code, a place with the address of the company, the SA and two tax rates; every part can be replaced.
 *
 * @param overrides Parts of the body to replace (each top-level key is replaced as a whole).
 */
export function onboardingBody(overrides: Document = {}): Document {
  return {
    group: { name: 'Nuovo Cliente' },
    company: {
      name: 'Cliente Srl',
      vatNumber: ONBOARDING_VAT,
      address: { street: 'Via Roma 1', postcode: '20100', city: 'Milano', province: 'MI', country: 'IT' },
      eInvoicing: { recipientCode: 'abc1234' },
    },
    place: { name: 'Insegna Centro' },
    user: { username: freshUsername(), password: onboardingPassword() },
    taxes: [
      { rate: 10, department: 1 },
      { rate: 22, department: 2 },
    ],
    ...overrides,
  };
}
