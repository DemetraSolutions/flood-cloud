import { email, enumOf, nullable, object, objectId, optional, personName, phone, string } from '../../shared/validation/schema.ts';
import type { Infer } from '../../shared/validation/schema.ts';
import { USER_THEMES } from '../users/user.mapper.ts';
import { avatarSchema, personalPosSchema, pinSchema } from '../users/user-fields.schemas.ts';

/** Interface languages the platform supports; only Italian for now (`doc/Tasks.md` 3.1). */
export const SUPPORTED_LANGUAGES = ['it'] as const;

const name = () => nullable(personName(100));

/**
 * Body of `PATCH /v1/me` (JSON Merge Patch): an absent field is left alone, `null` clears the personal fields and the picture. Besides the
 * personal data the user can change his picture and his POS preferences (`pos.options`, without the price lists). The PIN has its own route.
 * `role`, `groupId`, `permissions`, `status` and anything else are rejected as unknown.
 */
export const patchMeBody = object({
  firstName: optional(name()),
  lastName: optional(name()),
  email: optional(nullable(email())),
  phone: optional(nullable(phone())),
  language: optional(enumOf(SUPPORTED_LANGUAGES)),
  theme: optional(enumOf(USER_THEMES)),
  avatar: optional(nullable(avatarSchema())),
  pos: optional(personalPosSchema()),
});

/** Validated body of `PATCH /v1/me`. */
export type PatchMeBody = Infer<typeof patchMeBody>;

/** Longest password accepted in a request, in UTF-16 units (the policy then checks 12 to 128 code points). */
const MAX_PASSWORD_LENGTH = 1024;

/** Body of `PUT /v1/me/password`: passwords are kept exactly as sent (no trim, no normalization). */
export const changePasswordBody = object({
  currentPassword: string({ min: 1, max: MAX_PASSWORD_LENGTH, normalize: false }),
  newPassword: string({ max: MAX_PASSWORD_LENGTH, normalize: false }),
});

/** Validated body of `PUT /v1/me/password`. */
export type ChangePasswordBody = Infer<typeof changePasswordBody>;

/** Body of `PUT /v1/me/pin`: the current password confirms who asks, the PIN is 3 to 6 digits or `null` to remove it. */
export const changePinBody = object({
  currentPassword: string({ min: 1, max: MAX_PASSWORD_LENGTH, normalize: false }),
  pin: nullable(pinSchema()),
});

/** Validated body of `PUT /v1/me/pin`. */
export type ChangePinBody = Infer<typeof changePinBody>;

/** Path parameters of `DELETE /v1/me/sessions/{sessionId}`. */
export const sessionParams = object({ sessionId: objectId() });
