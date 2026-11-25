/** The providers of the integrations module; each one is on or off by the configuration of the platform. */
export const PROVIDERS = ['cerved', 'dojo', 'satispay', 'tsh', 'geocoding'] as const;

/** Name of a provider. */
export type ProviderName = (typeof PROVIDERS)[number];

/** What `GET /v1/integrations` answers: whether each provider is configured on the platform. */
export type ProviderAvailability = Readonly<Record<ProviderName, boolean>>;

/** A terminal Dojo lists for the account of the place. */
export interface DojoTerminal {
  readonly id: string;
  readonly tid: string;
  readonly status: string;
}

/** A category of charge of TS Hospitality. */
export interface TshCategory {
  readonly id: string;
  readonly name: string;
}

/** The address of a place as the geocoding takes it. */
export interface GeocodingAddress {
  readonly street: string;
  readonly postcode: string;
  readonly city: string;
  readonly province: string;
  readonly country: string;
}

/** Name of a field of {@link GeocodingAddress}. */
export type AddressField = keyof GeocodingAddress;

/** The five fields of the address, in the order the form shows them. */
export const ADDRESS_FIELDS: readonly AddressField[] = [
  'street',
  'postcode',
  'city',
  'province',
  'country',
];

/** Coordinates the geocoding found. */
export interface Coordinates {
  readonly lat: number;
  readonly lng: number;
}

/** What the activation of Satispay answers: the new version of the place, when it did not change meanwhile. */
export interface SatispayResult {
  readonly etag: string | null;
}

/** What the synchronization of TS Hospitality answers: the copy of the categories and the new version of the place. */
export interface TshSyncResult {
  readonly categories: readonly TshCategory[];
  readonly etag: string | null;
}

/** The company a VAT number belongs to, as the registry of companies knows it. */
export interface VatLookup {
  readonly vatNumber: string;
  readonly name: string | null;
  readonly fiscalCode: string | null;
  readonly address: {
    readonly street: string | null;
    readonly postcode: string | null;
    readonly city: string | null;
    /** Two-letter province code. */
    readonly province: string | null;
    readonly country: 'IT';
  };
  readonly pec: string | null;
}
