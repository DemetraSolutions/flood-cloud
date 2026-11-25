/** What a provider gave back that the core refuses to store. */
export type ProviderDataKind = 'satispayKeyId' | 'tshCategories';

/**
 * Thrown by a port of the core when data that came from a provider is not in the form the place keeps (the key id of Satispay, the list of categories of TS Hospitality). It is the provider that is
 * wrong, not the caller: the integrations module maps it to `502 PROVIDER_ERROR` without details. Nothing was written, and the error carries no value of the data.
 */
export class InvalidProviderDataError extends Error {
  /** Which data was refused. */
  readonly kind: ProviderDataKind;

  /** @param kind Which data was refused. */
  constructor(kind: ProviderDataKind) {
    super(`The provider gave data that cannot be stored (${kind})`);
    this.name = 'InvalidProviderDataError';
    this.kind = kind;
  }
}
