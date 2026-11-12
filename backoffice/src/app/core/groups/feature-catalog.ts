/**
 * The feature catalog of a group (decision D-13): the modules a group may have turned on. The
 * names are the ones the backend sends in `features` / `groupFeatures`.
 */
export const FEATURE_NAMES = [
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
] as const;

/** Name of a feature of the catalog. */
export type FeatureName = (typeof FEATURE_NAMES)[number];

/** The state of every feature of a group (all the names are always present). */
export type FeatureFlags = Readonly<Record<FeatureName, boolean>>;

/**
 * Dictionary key of the label (`.LABEL`) or the description (`.DESCRIPTION`) of a feature.
 *
 * @param name Feature name.
 * @param part Which text.
 */
export function featureTextKey(name: FeatureName, part: 'LABEL' | 'DESCRIPTION'): string {
  return `FEATURE.${name.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}.${part}`;
}
