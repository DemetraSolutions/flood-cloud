import { defineRoute } from '../../shared/http/routes.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';
import { idempotent } from '../../shared/http/idempotency.ts';
import type { IdempotencyStore } from '../../shared/http/idempotency.ts';
import { requireIfMatch } from '../../shared/http/if-match.ts';
import { validateBody, validateParams, validateQuery } from '../../shared/validation/middleware.ts';
import {
  COMPANIES_BODY_LIMIT,
  allCompaniesQuery,
  companiesQuery,
  companyParams,
  createCompanyBody,
  patchCompanyBody,
  putBankAccountsBody,
  putCustomerAppBody,
  putEInvoicingBody,
  putInvoiceNumberingBody,
  putMealVoucherIssuersBody,
  putMediaBody,
} from './companies.schemas.ts';
import type { CompaniesController } from './companies.controller.ts';

/**
 * The company routes (`doc/Tasks.md` area 6), all on a group: the group is verified against the caller's perimeter before the permission, and the service applies the
 * perimeter of the company (a CA reaches only his own). The compact list is the one the backoffice's reference store reads. Every write of an existing company needs `If-Match`.
 * `GET /companies` is the list across groups of the PSA and the dealers (the scope is theirs, computed by the server). Deleting a company from the trash has its own permission, `companies:delete` (same roles and ceilings as `companies:trash`: PSA, D and SA, never CA or PA).
 *
 * The creation is idempotent: it needs the `Idempotency-Key` header (`shared/http/idempotency.ts`).
 *
 * @param controller Handlers.
 * @param idempotency The record of the idempotency keys.
 * @returns The route definitions to mount on `/v1`.
 */
export function createCompaniesRoutes(controller: CompaniesController, idempotency: IdempotencyStore): RouteDefinition[] {
  const group = (permission: 'companies:read' | 'companies:create' | 'companies:update' | 'companies:trash' | 'companies:delete') => ({ kind: 'user' as const, permission, group: true });
  const one = '/groups/:groupId/companies/:companyId';
  const put = (segment: string, handler: CompaniesController['replace'][keyof CompaniesController['replace']], body: Parameters<typeof validateBody>[0]): RouteDefinition =>
    defineRoute({
      method: 'PUT',
      path: `${one}/${segment}`,
      auth: group('companies:update'),
      bodyLimit: COMPANIES_BODY_LIMIT,
      middleware: [validateParams(companyParams), requireIfMatch, validateBody(body)],
      handler,
    });
  return [
    // Across groups: a platform route (no group in the path); the service lets only the PSA and the dealers through and applies their perimeter.
    defineRoute({ method: 'GET', path: '/companies', auth: { kind: 'user', permission: 'companies:read' }, middleware: [validateQuery(allCompaniesQuery)], handler: controller.listAll }),
    defineRoute({ method: 'GET', path: '/groups/:groupId/companies', auth: group('companies:read'), middleware: [validateQuery(companiesQuery)], handler: controller.list }),
    // Before the routes of one company: `e-invoicing-hubs` is not a company id.
    defineRoute({ method: 'GET', path: '/groups/:groupId/companies/e-invoicing-hubs', auth: group('companies:update'), handler: controller.hubs }),
    defineRoute({ method: 'POST', path: '/groups/:groupId/companies', auth: group('companies:create'), bodyLimit: COMPANIES_BODY_LIMIT, middleware: [validateBody(createCompanyBody)], handler: idempotent(idempotency, controller.create) }),
    defineRoute({ method: 'GET', path: one, auth: group('companies:read'), middleware: [validateParams(companyParams)], handler: controller.get }),
    defineRoute({
      method: 'PATCH',
      path: one,
      auth: group('companies:update'),
      bodyLimit: COMPANIES_BODY_LIMIT,
      middleware: [validateParams(companyParams), requireIfMatch, validateBody(patchCompanyBody)],
      handler: controller.update,
    }),
    put('e-invoicing', controller.replace.eInvoicing, putEInvoicingBody),
    put('invoice-numbering', controller.replace.invoiceNumbering, putInvoiceNumberingBody),
    put('bank-accounts', controller.replace.bankAccounts, putBankAccountsBody),
    put('meal-voucher-issuers', controller.replace.mealVoucherIssuers, putMealVoucherIssuersBody),
    put('customer-app', controller.replace.customerApp, putCustomerAppBody),
    put('media', controller.replace.media, putMediaBody),
    defineRoute({ method: 'POST', path: `${one}/trash`, auth: group('companies:trash'), middleware: [validateParams(companyParams), requireIfMatch], handler: controller.trash }),
    defineRoute({ method: 'POST', path: `${one}/restore`, auth: group('companies:trash'), middleware: [validateParams(companyParams), requireIfMatch], handler: controller.restore }),
    defineRoute({ method: 'DELETE', path: one, auth: group('companies:delete'), middleware: [validateParams(companyParams), requireIfMatch], handler: controller.remove }),
  ];
}
