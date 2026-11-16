import { randomInt } from 'node:crypto';

const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * A new id for a payment type of a place, in the form of `dBJs.createId` of the old backoffice (seven characters of base 36, a 32-bit number in decimal, the time in milliseconds), made
 * with the CSPRNG instead of `Math.random`. The legacy treats the ids as opaque text: the vendite store them, so an id is never regenerated.
 *
 * @param now Clock in milliseconds (the system clock by default).
 */
export function newPaymentTypeId(now: () => number = Date.now): string {
  const prefix = Array.from({ length: 7 }, () => BASE36[randomInt(BASE36.length)]).join('');
  return `${prefix}${String(randomInt(2 ** 32))}${String(now())}`;
}
