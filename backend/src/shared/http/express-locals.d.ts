import type { GroupAccess } from '../security/scope/group-access.ts';
import type { ValidatedInput } from '../validation/middleware.ts';
import type { ObjectId } from 'mongodb';
import type { ApiKeyPrincipal, AuthPrincipal, StorePrincipal } from '../security/scope/principal.ts';

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
      /** Verified store principal, set by the store key authentication of `/v1`; never set together with `auth`. */
      store?: StorePrincipal;
      /** Verified API key principal, set by the API key authentication of `/public/v1`; never set together with `auth` or `store`. */
      apiKey?: ApiKeyPrincipal;
      /** Id of the session whose access token authenticated the request, set by the Bearer middleware. */
      sessionId?: ObjectId;
      /** Set by the Bearer middleware when the user must change a provisional password before doing anything else. */
      passwordChangeRequired?: true;
      /** Set by the route builder for routes that return credentials: the response must not be compressed (BREACH). */
      noCompression?: true;
      /** Validated body, query and params, set by `validateBody`, `validateQuery` and `validateParams`. */
      input?: ValidatedInput;
      /** The version of the `If-Match` header (without quotes), set by `requireIfMatch`. */
      ifMatch?: string;
      /** Verified group of the path, set by `requireGroupAccess`. */
      groupAccess?: GroupAccess;
    }
  }
}

export {};
