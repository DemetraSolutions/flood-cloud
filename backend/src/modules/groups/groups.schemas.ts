import { PUBLIC_API_MAX_DAILY_QUOTA, PUBLIC_API_MAX_RATE_LIMIT_PER_MINUTE, PUBLIC_API_MIN_LIMIT } from '../../shared/security/public-api-limits.ts';
import { array, boolean, enumOf, integer, nullable, object, optional, personName, string } from '../../shared/validation/schema.ts';
import type { Infer, Schema } from '../../shared/validation/schema.ts';
import { FEATURES } from './features.ts';
import type { Feature } from './features.ts';
import { API_KEY_PATTERN, SLOT_END, SLOT_START } from './group.mapper.ts';
import { PROVIDERS } from './group.types.ts';
import type { Provider } from './group.types.ts';
import { ISO_639_1 } from './languages.ts';

/** Most languages a group can have. */
export const MAX_LANGUAGES = 10;

/** Most time slots of the statistics: one per hour would be 24, a slot may span any hours and overlap. */
export const MAX_TIME_SLOTS = 48;

/** The time of day, `HH:mm`. */
const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;

export const featuresShape = Object.fromEntries(FEATURES.map((feature) => [feature, optional(boolean())])) as { readonly [K in Feature]: Schema<boolean, true> };

/** The state of one integration in a request: switched on or off, and its key set (`null` removes it). The key is never returned. */
const integrationState = object({ enabled: optional(boolean()), apiKey: optional(nullable(string({ min: 16, max: 256, pattern: API_KEY_PATTERN, normalize: false }))) });

const integrationsShape = Object.fromEntries(PROVIDERS.map((provider) => [provider, optional(integrationState)])) as {
  readonly [K in Provider]: Schema<Infer<typeof integrationState>, true>;
};

/**
 * Body of the modification (`PATCH /v1/groups/{groupId}`, JSON Merge Patch). `features` and `integrations` are partial objects: a
 * flag left out keeps its value. Which fields a role may send is decided by the service (D-13), after the validation.
 */
export const patchGroupBody = object({
  name: optional(personName(200)),
  description: optional(nullable(string({ min: 1, max: 1000, trim: true }))),
  languages: optional(array(enumOf([...ISO_639_1]), { max: MAX_LANGUAGES, unique: true })),
  statsSettings: optional(
    object({
      openingTime: optional(nullable(string({ max: 5, pattern: TIME_OF_DAY }))),
      compressProductsCategories: optional(boolean()),
      timeSlots: optional(array(object({ from: string({ max: 5, pattern: SLOT_START }), to: string({ max: 5, pattern: SLOT_END }) }), { max: MAX_TIME_SLOTS })),
    }),
  ),
  features: optional(object(featuresShape)),
  integrations: optional(object(integrationsShape)),
  demo: optional(boolean()),
  publicApi: optional(
    object({
      enabled: optional(boolean()),
      defaultRateLimitPerMinute: optional(integer({ min: PUBLIC_API_MIN_LIMIT, max: PUBLIC_API_MAX_RATE_LIMIT_PER_MINUTE })),
      defaultDailyQuota: optional(integer({ min: PUBLIC_API_MIN_LIMIT, max: PUBLIC_API_MAX_DAILY_QUOTA })),
      groupRateLimitPerMinute: optional(integer({ min: PUBLIC_API_MIN_LIMIT, max: PUBLIC_API_MAX_RATE_LIMIT_PER_MINUTE })),
      groupDailyQuota: optional(integer({ min: PUBLIC_API_MIN_LIMIT, max: PUBLIC_API_MAX_DAILY_QUOTA })),
    }),
  ),
});

/** Validated body of the modification of a group. */
export type PatchGroupBody = Infer<typeof patchGroupBody>;
