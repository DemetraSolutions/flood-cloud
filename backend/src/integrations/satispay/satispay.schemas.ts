import { object, string, transform } from '../../shared/validation/schema.ts';
import type { Infer } from '../../shared/validation/schema.ts';

/** Body limit of the activation: one short code. */
export const SATISPAY_BODY_LIMIT = '2kb';

/**
 * Body of `POST …/integrations/satispay/activation`: the activation code, nothing else. Letters and digits, one to 32, trimmed and normalized to upper case (the code is shown in capitals in the
 * Satispay app). A problem is reported on the field with its reason, never with the value.
 */
export const activationBody = object({
  activationCode: transform(string({ min: 1, max: 32, trim: true, pattern: /^[A-Za-z0-9]+$/ }), (code) => code.toUpperCase(), 'format'),
});

/** Validated body of the activation. */
export type ActivationBody = Infer<typeof activationBody>;
