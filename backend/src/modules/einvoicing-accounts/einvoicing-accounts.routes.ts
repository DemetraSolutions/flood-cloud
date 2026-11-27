import { requireIfMatch } from '../../shared/http/if-match.ts';
import { defineRoute } from '../../shared/http/routes.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';
import type { RateLimitRules } from '../../shared/security/rate-limit/rules.ts';
import { validateBody, validateParams } from '../../shared/validation/middleware.ts';
import { dealerParams } from '../dealers/dealers.schemas.ts';
import type { EInvoicingAccountsController } from './einvoicing-accounts.controller.ts';
import { E_INVOICING_ACCOUNT_BODY_LIMIT, arubaAccountBody } from './einvoicing-accounts.schemas.ts';

/**
 * The routes of the Aruba accounts of the e-invoicing, on `/v1`: a dealer's (`/dealers/{dealerId}/integrations/aruba`) and the platform's (`/settings/integrations/aruba`). All of them need `eInvoicingAccounts:manage`, which only the PSA's ceiling has; they are
 * not open to a store key (the default) nor to the public API. The writes need `If-Match` with the version the client read, and the one that sets a password takes the rate limit of the routes that handle credentials.
 *
 * @param controller Handlers.
 * @param rules Rate limit rules.
 * @returns The route definitions to mount on `/v1`.
 */
export function createEInvoicingAccountsRoutes(controller: EInvoicingAccountsController, rules: Pick<RateLimitRules, 'userCredentialsPerUser'>): RouteDefinition[] {
  const auth = { kind: 'user' as const, permission: 'eInvoicingAccounts:manage' as const };
  const dealerPath = '/dealers/:dealerId/integrations/aruba';
  const platformPath = '/settings/integrations/aruba';
  return [
    defineRoute({ method: 'GET', path: dealerPath, auth, middleware: [validateParams(dealerParams)], handler: controller.dealer.get }),
    defineRoute({ method: 'PUT', path: dealerPath, auth, bodyLimit: E_INVOICING_ACCOUNT_BODY_LIMIT, rateLimit: [rules.userCredentialsPerUser], middleware: [validateParams(dealerParams), requireIfMatch, validateBody(arubaAccountBody)], handler: controller.dealer.put }),
    defineRoute({ method: 'DELETE', path: dealerPath, auth, middleware: [validateParams(dealerParams), requireIfMatch], handler: controller.dealer.delete }),
    defineRoute({ method: 'GET', path: platformPath, auth, handler: controller.platform.get }),
    defineRoute({ method: 'PUT', path: platformPath, auth, bodyLimit: E_INVOICING_ACCOUNT_BODY_LIMIT, rateLimit: [rules.userCredentialsPerUser], middleware: [requireIfMatch, validateBody(arubaAccountBody)], handler: controller.platform.put }),
    defineRoute({ method: 'DELETE', path: platformPath, auth, middleware: [requireIfMatch], handler: controller.platform.delete }),
  ];
}
