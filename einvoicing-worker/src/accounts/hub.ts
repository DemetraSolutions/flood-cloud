/**
 * Hub names. A hub is the account an invoice is sent through, named by `company.fattura_elettronica.hub`: the provider
 * alone for the platform's own account (`aruba`), or the provider and the id of the dealer that owns the account
 * (`aruba__<24 hexadecimal characters>`).
 *
 * @module
 */

/** The shape of a valid hub name. */
export const HUB_PATTERN = /^[a-z][a-z0-9]{0,31}(__[0-9a-f]{24})?$/;

/** A hub split into its parts. */
export interface ParsedHub {
  /** The provider (`aruba`): selects the adapter and the `integrations.<provider>` field. */
  readonly provider: string;
  /** The dealer id (24 lowercase hexadecimal characters), `undefined` for the platform account. */
  readonly dealerId: string | undefined;
}

/**
 * Splits a hub name.
 *
 * @param hub A name matching {@link HUB_PATTERN}.
 * @returns Provider and dealer id.
 * @example
 * parseHub('aruba__0123456789abcdef01234567'); // { provider: 'aruba', dealerId: '0123456789abcdef01234567' }
 */
export function parseHub(hub: string): ParsedHub {
  const [provider = '', dealerId] = hub.split('__');
  return { provider, dealerId };
}

/**
 * The hub of a dealer's account.
 *
 * @param provider The provider.
 * @param dealerId The dealer id as lowercase hexadecimal.
 * @returns `<provider>__<dealerId>`.
 */
export function dealerHub(provider: string, dealerId: string): string {
  return `${provider}__${dealerId}`;
}
