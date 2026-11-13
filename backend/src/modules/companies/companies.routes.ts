import { defineRoute } from '../../shared/http/routes.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';
import { requireIfMatch } from '../../shared/http/if-match.ts';
import { validateBody, validateParams, validateQuery } from '../../shared/validation/middleware.ts';
import {
  COMPANIES_BODY_LIMIT,
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
 * Deleting a company from the trash has its own permission, `companies:delete` (same roles and ceilings as `companies:trash`: PSA, D and SA, never CA or PA).
 *
 * @param controller Handlers.
 * @returns The route definitions to mount on `/v1`.
 */
export function createCompaniesRoutes(controller: CompaniesController): RouteDefinition[] {
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
    defineRoute({ method: 'GET', path: '/groups/:groupId/companies', auth: group('companies:read'), middleware: [validateQuery(companiesQuery)], handler: controller.list }),
    // Before the routes of one company: `e-invoicing-hubs` is not a company id.
    defineRoute({ method: 'GET', path: '/groups/:groupId/companies/e-invoicing-hubs', auth: group('companies:update'), handler: controller.hubs }),
    defineRoute({ method: 'POST', path: '/groups/:groupId/companies', auth: group('companies:create'), bodyLimit: COMPANIES_BODY_LIMIT, middleware: [validateBody(createCompanyBody)], handler: controller.create }),
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
