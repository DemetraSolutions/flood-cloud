import type { GroupAccess } from '../security/scope/group-access.ts';
import type { AuthPrincipal } from '../security/scope/principal.ts';

declare global {
  namespace Express {
    interface Locals {
      /** Correlation id of the current request (`X-Request-Id`). */
      requestId: string;
      /** Valid `X-Request-Id` sent by the client, logged but never echoed. */
      clientRequestId?: string;
      /** Pattern of the matched route, mount point included (`/v1/groups/:groupId`); never the concrete path. */
      routePattern?: string;
      /** Verified principal, set by the authentication middleware of the surface. */
      auth?: AuthPrincipal;
      /** Verified group of the path, set by `requireGroupAccess`. */
      groupAccess?: GroupAccess;
    }
  }
}

export {};
