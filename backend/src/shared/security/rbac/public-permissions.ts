/**
 * Catalog of the permissions of the public API (`/public/v1`), kept apart from the backoffice permissions: a public API key
 * holds some of these and nothing else. `GET /me` needs none. Every entry must be described in `doc/Public-API.md`.
 */
export const PUBLIC_PERMISSIONS = Object.freeze(['places:read', 'companies:read', 'catalog:read', 'catalog:write'] as const);

/** A permission a public API key may hold. */
export type PublicPermission = (typeof PUBLIC_PERMISSIONS)[number];

/**
 * Tells whether a value is a permission of the public catalog.
 *
 * @param value Any value.
 * @returns `true` only for a string present in {@link PUBLIC_PERMISSIONS}.
 */
export function isPublicPermission(value: unknown): value is PublicPermission {
  return typeof value === 'string' && (PUBLIC_PERMISSIONS as readonly string[]).includes(value);
}
