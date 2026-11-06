import type { Request, RequestHandler, Response } from 'express';
import { clientContextOf } from '../../../shared/http/client-context.ts';
import { sendData } from '../../../shared/http/envelope.ts';
import { defineRoute } from '../../../shared/http/routes.ts';
import type { RouteDefinition } from '../../../shared/http/routes.ts';
import { inputOf, validateBody, validateParams } from '../../../shared/validation/middleware.ts';
import { object, string } from '../../../shared/validation/schema.ts';
import type { Catalog } from './catalog.ts';
import type { CatalogsService } from './catalogs.service.ts';

/** Path parameters of the routes on one element; the group is already verified, so it is accepted and ignored here. The id is checked against the stored ones. */
const itemParams = object({ itemId: string({ min: 1, max: 64 }) }, { allowUnknown: true });

/**
 * The routes of the catalogs kept in the document of a group, `GET` list, `POST`, `PATCH` (`PUT` for the loyalty rules) and `DELETE` for each, under
 * `/groups/{groupId}/<segment>`. They are group routes: the group is verified against the caller's perimeter (D-13: a suspended or trashed group is for the PSA
 * alone) before the permission, which each catalog declares (`groups:*` for the group form, `fidelity:*`, `products:*`).
 *
 * @param service The catalogs service.
 * @param catalogs The catalogs to expose.
 * @returns The route definitions to mount on `/v1`.
 */
export function createCatalogRoutes(service: CatalogsService, catalogs: readonly Catalog[]): RouteDefinition[] {
  const context = (req: Request, res: Response) => ({ principal: res.locals.auth!, access: res.locals.groupAccess!, client: clientContextOf(req, res) });
  return catalogs.flatMap((catalog) => {
    const base = `/groups/:groupId/${catalog.segment}`;
    const read = { kind: 'user' as const, permission: catalog.readPermission, group: true };
    const write = { kind: 'user' as const, permission: catalog.updatePermission, group: true };
    const bodyLimit = catalog.bodyLimit === undefined ? {} : { bodyLimit: catalog.bodyLimit };
    const itemId = (res: Response): string => inputOf<{ itemId: string }>(res, 'params').itemId;
    const routes: RouteDefinition[] = [
      defineRoute({
        method: 'GET',
        path: base,
        auth: read,
        handler: async (_req, res) => {
          sendData(res, await service.list(catalog, res.locals.groupAccess!));
        },
      }),
    ];
    if (catalog.operations.create === true) {
      routes.push(
        defineRoute({
          method: 'POST',
          path: base,
          auth: write,
          ...bodyLimit,
          middleware: [validateBody(catalog.createSchema!)],
          handler: async (req, res) => {
            const { principal, access, client } = context(req, res);
            const created = await service.create(principal, access, catalog, inputOf(res, 'body'), client);
            res.setHeader('Location', `${req.baseUrl}${req.path.replace(/\/$/, '')}/${catalog.idOf(created)}`);
            sendData(res, created, 201);
          },
        }),
      );
    }
    if (catalog.operations.patch !== undefined) {
      const handler: RequestHandler = async (req, res) => {
        const { principal, access, client } = context(req, res);
        sendData(res, await service.patch(principal, access, catalog, itemId(res), inputOf(res, 'body'), client));
      };
      routes.push(
        defineRoute({ method: catalog.operations.patch, path: `${base}/:itemId`, auth: write, ...bodyLimit, middleware: [validateParams(itemParams), validateBody(catalog.patchSchema!)], handler }),
      );
    }
    if (catalog.operations.remove === true) {
      routes.push(
        defineRoute({
          method: 'DELETE',
          path: `${base}/:itemId`,
          auth: write,
          middleware: [validateParams(itemParams)],
          handler: async (req, res) => {
            const { principal, access, client } = context(req, res);
            await service.remove(principal, access, catalog, itemId(res), client);
            res.status(204).end();
          },
        }),
      );
    }
    return routes;
  });
}
