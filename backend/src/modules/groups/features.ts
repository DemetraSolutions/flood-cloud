/**
 * The feature catalog of a group (D-13): the modules a group may have turned on. Each feature is a boolean
 * flag stored in the legacy `settings.<feature>`; absent or not a boolean means off.
 */
export const FEATURES = Object.freeze([
  'cash',
  'rooms',
  'ordering',
  'warehouse',
  'tobaccosGamesMonopoly',
  'productsVariants',
  'services',
  'appointments',
  'customersApp',
  'media',
  'email',
  'scales',
  'delivery',
  'autoDepartments',
  'advancedProducts',
] as const);

/** A feature of a group. */
export type Feature = (typeof FEATURES)[number];

/** What each feature enables, in one line (the product meaning, for the documentation and the backoffice). */
export const FEATURE_CATALOG: Readonly<Record<Feature, string>> = Object.freeze({
  cash: 'Point-of-sale cash register: sales, receipts and fiscal printing.',
  rooms: 'Rooms and tables of a venue, with table service.',
  ordering: 'Ordering by customers and waiters (self-ordering, handheld terminals).',
  warehouse: 'Warehouse management: stock, movements, inventories and documents.',
  tobaccosGamesMonopoly: 'Specific handling of tobacco, games and monopoly goods.',
  productsVariants: 'Product variants (sizes, flavours and the like) under one product.',
  services: 'Services sold by time or by provider, next to goods.',
  appointments: 'Appointments and bookings with a calendar.',
  customersApp: 'The customers app: orders and loyalty from the customer smartphone.',
  media: 'Media files (images and videos) attached to products and displays.',
  email: 'Sending e-mail from the platform (receipts, notifications, reports).',
  scales: 'Connection of weighing scales to the cash register.',
  delivery: 'Delivery and take-away orders.',
  autoDepartments: 'Automatic assignment of departments to products.',
  advancedProducts: 'Advanced product data (composition, allergens, extended attributes).',
});

/** Stored fields read to know which features a group has: the access check reads them in the same query as the group state. */
export const FEATURE_PROJECTION: Readonly<Record<string, 1>> = Object.freeze(Object.fromEntries(FEATURES.map((feature) => [`settings.${feature}`, 1 as const])));

/** The features of a group, every feature present. */
export type FeatureFlags = Readonly<Record<Feature, boolean>>;

/**
 * Tells whether a value is a feature of the catalog.
 *
 * @param value Any value.
 */
export function isFeature(value: unknown): value is Feature {
  return typeof value === 'string' && (FEATURES as readonly string[]).includes(value);
}

/**
 * Reads the features out of the stored `settings` of a group: a feature is on only when its flag is
 * exactly `true` (absent, `false` and every other value are off). It never throws, whatever `settings` holds.
 *
 * @param settings The legacy `settings` value, of unknown shape.
 * @returns Every feature of the catalog with its state.
 */
export function featuresOf(settings: unknown): FeatureFlags {
  const stored = typeof settings === 'object' && settings !== null && !Array.isArray(settings) ? (settings as Readonly<Record<string, unknown>>) : {};
  return Object.freeze(Object.fromEntries(FEATURES.map((feature) => [feature, stored[feature] === true])) as Record<Feature, boolean>);
}
