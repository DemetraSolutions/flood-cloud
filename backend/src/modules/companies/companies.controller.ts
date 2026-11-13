import type { RequestHandler, Response } from 'express';
import type { ObjectId } from 'mongodb';
import { clientContextOf } from '../../shared/http/client-context.ts';
import { sendData } from '../../shared/http/envelope.ts';
import { sendRevalidatedPage } from '../../shared/http/etag.ts';
import { entityTag } from '../../shared/http/if-match.ts';
import { inputOf } from '../../shared/validation/middleware.ts';
import type { CompaniesQuery } from './companies.schemas.ts';
import type { CompanyResult, CompaniesService } from './companies.service.ts';
import type { CompanyCreation, CompanyPatch } from './company.types.ts';

/** HTTP handlers of the company routes. */
export interface CompaniesController {
  list: RequestHandler;
  /** `GET …/companies/e-invoicing-hubs`. */
  hubs: RequestHandler;
  get: RequestHandler;
  create: RequestHandler;
  update: RequestHandler;
  /** `PUT …/e-invoicing`, `…/invoice-numbering`, `…/bank-accounts`, `…/meal-voucher-issuers`, `…/customer-app` and `…/media`: each replaces its block through the same write as the modification. */
  replace: Readonly<Record<'eInvoicing' | 'invoiceNumbering' | 'bankAccounts' | 'mealVoucherIssuers' | 'customerApp' | 'media', RequestHandler>>;
  trash: RequestHandler;
  restore: RequestHandler;
  remove: RequestHandler;
}

const companyIdOf = (res: Response): ObjectId => inputOf<{ companyId: ObjectId }>(res, 'params').companyId;

/** The company in the `{ data }` envelope with the `ETag` of its version. */
function sendCompany(res: Response, result: CompanyResult, status = 200): void {
  res.setHeader('ETag', entityTag(result.version));
  sendData(res, result.company, status);
}

/**
 * Translates HTTP into {@link CompaniesService} calls. Every response that carries a company has its `ETag`, which is the `If-Match` of the next write.
 *
 * @param service The service.
 */
export function createCompaniesController(service: CompaniesService): CompaniesController {
  const block =
    (name: keyof CompaniesController['replace']): RequestHandler =>
    async (req, res) => {
      const body = inputOf<unknown>(res, 'body');
      sendCompany(res, await service.update(res.locals.auth!, res.locals.groupAccess!, companyIdOf(res), res.locals.ifMatch!, { [name]: body } as CompanyPatch, clientContextOf(req, res)));
    };
  return {
    list: async (req, res) => {
      const { items, page } = await service.list(res.locals.auth!, res.locals.groupAccess!, inputOf<CompaniesQuery>(res, 'query'));
      sendRevalidatedPage(req, res, items, page);
    },
    hubs: async (_req, res) => {
      sendData(res, await service.hubs(res.locals.auth!));
    },
    get: async (_req, res) => {
      sendCompany(res, await service.get(res.locals.auth!, res.locals.groupAccess!, companyIdOf(res)));
    },
    create: async (req, res) => {
      const created = await service.create(res.locals.auth!, res.locals.groupAccess!, inputOf<CompanyCreation>(res, 'body'), clientContextOf(req, res));
      // The base path is the one the request came in on, so the link is always the right surface.
      res.setHeader('Location', `${req.baseUrl}${req.path.replace(/\/$/, '')}/${created.company.id}`);
      sendCompany(res, created, 201);
    },
    update: async (req, res) => {
      sendCompany(res, await service.update(res.locals.auth!, res.locals.groupAccess!, companyIdOf(res), res.locals.ifMatch!, inputOf<CompanyPatch>(res, 'body'), clientContextOf(req, res)));
    },
    replace: {
      eInvoicing: block('eInvoicing'),
      invoiceNumbering: block('invoiceNumbering'),
      bankAccounts: block('bankAccounts'),
      mealVoucherIssuers: block('mealVoucherIssuers'),
      customerApp: block('customerApp'),
      media: block('media'),
    },
    trash: async (req, res) => {
      sendCompany(res, await service.trash(res.locals.auth!, res.locals.groupAccess!, companyIdOf(res), res.locals.ifMatch!, clientContextOf(req, res)));
    },
    restore: async (req, res) => {
      sendCompany(res, await service.restore(res.locals.auth!, res.locals.groupAccess!, companyIdOf(res), res.locals.ifMatch!, clientContextOf(req, res)));
    },
    remove: async (req, res) => {
      await service.remove(res.locals.auth!, res.locals.groupAccess!, companyIdOf(res), res.locals.ifMatch!, clientContextOf(req, res));
      res.status(204).end();
    },
  };
}
