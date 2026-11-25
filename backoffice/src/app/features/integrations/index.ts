/**
 * The only entry of the integrations module (Dojo, Satispay, TS Hospitality, geocoding, VAT
 * lookup): the pages of the places and of the new customer import from here and from nowhere
 * else in the module. The module imports nothing from the other features, so unplugging it means
 * removing the components from those pages.
 */
export { CoordinatesLookup } from './coordinates-lookup';
export { DojoTerminals } from './dojo-terminals';
export { IntegrationsApi } from './integrations-api';
export { IntegrationsStatus } from './integrations-status';
export { SatispayActivation } from './satispay-activation';
export { TshSync } from './tsh-sync';
export { VatLookupField } from './vat-lookup-field';
export { ADDRESS_FIELDS } from './integrations.types';
export type {
  AddressField,
  Coordinates,
  DojoTerminal,
  GeocodingAddress,
  ProviderAvailability,
  ProviderName,
  SatispayResult,
  TshCategory,
  TshSyncResult,
  VatLookup,
} from './integrations.types';
