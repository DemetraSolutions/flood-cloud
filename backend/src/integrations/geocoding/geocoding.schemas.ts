import { object, string, transform } from '../../shared/validation/schema.ts';
import type { Infer } from '../../shared/validation/schema.ts';

/** Body limit of the geocoding: a postal address. */
export const GEOCODING_BODY_LIMIT = '4kb';

/**
 * Body of `POST …/places/{placeId}/geocoding`: the postal address of the form, in the fields the place keeps (`street`, `postcode`, `city`, `province`, `country`), every one required, with the lengths of the
 * place. The country is the two letters, in capitals. A missing field is a `422` on that field, so the backoffice can say which.
 */
export const geocodingBody = object({
  street: string({ min: 1, max: 150, trim: true }),
  postcode: string({ min: 1, max: 20, trim: true }),
  city: string({ min: 1, max: 100, trim: true }),
  province: string({ min: 1, max: 10, trim: true }),
  country: transform(string({ min: 2, max: 2, trim: true, pattern: /^[A-Za-z]{2}$/ }), (code) => code.toUpperCase(), 'format'),
});

/** Validated body of the geocoding. */
export type GeocodingBody = Infer<typeof geocodingBody>;
