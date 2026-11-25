import type { AuthPrincipal } from '../security/scope/principal.ts';

/**
 * The ports the core gives the integrations module (`doc/Tasks.md` section 9-octies.3). They are types only: the implementation lives in `modules/places` and is handed to
 * `createIntegrations` by the composition root, so the module never touches the database and never imports from the core beyond `shared/`.
 */

/** A category of charge of TS Hospitality, as the place keeps it: the shape of the `tshCategories` schema of the place settings. */
export interface TshCategory {
  readonly id: string;
  readonly name: string;
}

/** The place a call of the integrations is about, with the caller as authenticated by the core. The core checks all of it again: nothing here is trusted. */
export interface PlaceIntegrationTarget {
  /** The backoffice user who made the request (the route only opens to users: never a store key, never a public API key). */
  readonly principal: AuthPrincipal;
  /** The group of the path, as the client sent it: the port verifies it against the perimeter of the principal. */
  readonly groupId: string;
  /** The place of the path, as the client sent it. */
  readonly placeId: string;
}

/**
 * What the integrations module may ask of the places of the core. Every method first redoes, in this order and without ever calling a provider: the group (outside the perimeter of the
 * caller, missing, or suspended for a caller that is not a PSA: `NOT_FOUND`), the permission `places:update` (`FORBIDDEN`), the place (outside the perimeter or in the trash: `NOT_FOUND`)
 * and, where the method says so, the role (PSA or dealer only: `FORBIDDEN` with `notAllowed`), the switch of the provider (off: `VALIDATION_ERROR` on `integrations.<provider>.status`) and the
 * credentials (missing: `VALIDATION_ERROR` with `required` on the field). A method returns only the minimum value it is for, never the document of the place.
 */
export interface PlaceIntegrationsPort {
  /**
   * The key of Dojo of the place, for the list of the terminals.
   *
   * @throws {AppError} `NOT_FOUND`, `FORBIDDEN`, `VALIDATION_ERROR` (`integrations.dojo.status`, or `required` on `integrations.dojo.apiKey`).
   */
  dojoCredentials(target: PlaceIntegrationTarget): Promise<{ readonly apiKey: string }>;
  /**
   * The credentials of TS Hospitality of the place, for the download of the categories of charge. `propertyId` is as stored and already checked against `^[A-Za-z0-9_-]{1,64}$`.
   *
   * @throws {AppError} `NOT_FOUND`, `FORBIDDEN`, `VALIDATION_ERROR` (`integrations.tsh.status`, `required` on `integrations.tsh.id|secret|propertyId`, `pattern` on `integrations.tsh.propertyId`).
   */
  tshCredentials(target: PlaceIntegrationTarget): Promise<{ readonly id: string; readonly secret: string; readonly propertyId: string; readonly testMode: boolean }>;
  /**
   * Whether the activation of Satispay may start: everything {@link PlaceIntegrationsPort} checks, the role (a PSA or a dealer only, the rule of the payment keys) and the version of the place
   * against `ifMatch`, all before the provider is called.
   *
   * @param ifMatch The version the caller read (the value of `If-Match`, without quotes).
   * @throws {AppError} `NOT_FOUND`, `FORBIDDEN` (`notAllowed` on `integrations.satispay.keyId` for any role but PSA and dealer), `VALIDATION_ERROR` (`integrations.satispay.status`), `PRECONDITION_FAILED`.
   */
  checkSatispayActivation(target: PlaceIntegrationTarget, ifMatch: string): Promise<void>;
  /**
   * Saves the key the provider gave back: sets `integrations.satispay.keyId` and removes `integrations.satispay.activationCode`, on their own paths and in one write (copy in the common database and
   * `place.updated` of the activity log included). The provider has already accepted the code, so the write goes on whatever the version of the place is now (it is read again, and a concurrent change is retried).
   *
   * @param ifMatch The version the caller read.
   * @param keyId The key the provider gave back, checked against the form of the field before anything is written.
   * @returns The new version when the place was still at `ifMatch` just before the write, `null` when it had changed (the caller must not hand out a version it did not check).
   * @throws {InvalidProviderDataError} `keyId` is not in the form of the field (the caller answers `502`).
   * @throws {AppError} `NOT_FOUND`, `FORBIDDEN` (as {@link PlaceIntegrationsPort.checkSatispayActivation}), `CONFLICT` (a block of the stored place is not an object, or the place kept changing).
   */
  saveSatispayKeyId(target: PlaceIntegrationTarget, ifMatch: string, keyId: string): Promise<{ readonly etag: string | null }>;
  /**
   * Saves the copy of the categories of charge the provider listed (`integrations.tsh.tshCategories`), only if the place is still at `ifMatch`.
   *
   * @param ifMatch The version the caller read.
   * @param categories What the provider listed, checked against the schema of the copy before anything is written.
   * @returns The new version of the place.
   * @throws {InvalidProviderDataError} `categories` is not in the form of the copy (the caller answers `502`).
   * @throws {AppError} `NOT_FOUND`, `FORBIDDEN`, `VALIDATION_ERROR` (`integrations.tsh.status`), `PRECONDITION_FAILED`, `CONFLICT` (a block of the stored place is not an object).
   */
  saveTshCategories(target: PlaceIntegrationTarget, ifMatch: string, categories: readonly TshCategory[]): Promise<{ readonly etag: string }>;
  /**
   * Whether the geocoding may run for the place: everything {@link PlaceIntegrationsPort} checks and the switch `integrations.googleMaps.status`.
   *
   * @throws {AppError} `NOT_FOUND`, `FORBIDDEN`, `VALIDATION_ERROR` (`integrations.googleMaps.status`).
   */
  checkGeocoding(target: PlaceIntegrationTarget): Promise<void>;
}
