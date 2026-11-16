import express from 'express';
import { defineRoute } from '../../shared/http/routes.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';
import { idempotent } from '../../shared/http/idempotency.ts';
import type { IdempotencyStore } from '../../shared/http/idempotency.ts';
import type { RateLimitRules } from '../../shared/security/rate-limit/rules.ts';
import { validateQuery } from '../../shared/validation/middleware.ts';
import type { Gate } from '../media/gate.ts';
import type { TobaccosController } from './tobaccos.controller.ts';
import { tobaccosQuery } from './tobaccos.schemas.ts';
import { acceptWorkbook, workbookUpload } from './tobaccos.upload.ts';

/**
 * The routes of the national tobacco price list (`doc/Tasks.md` 9-bis, step T3), on `/v1` and for the PSA alone (`tobaccos:read` and `tobaccos:import` are only in his ceiling). Not open to a store key
 * (the default). The import is a `multipart/form-data` upload of one XLSX file, idempotent (`Idempotency-Key`) and limited per hour for the user.
 *
 * @param controller Handlers.
 * @param rules Rate limit rules.
 * @param idempotency The record of the idempotency keys.
 * @param gate The gate that bounds the imports in progress; the one of the process by default.
 * @returns The route definitions to mount on `/v1`.
 */
export function createTobaccosRoutes(controller: TobaccosController, rules: Pick<RateLimitRules, 'tobaccosImportPerUser'>, idempotency: IdempotencyStore, gate?: Gate): RouteDefinition[] {
  const upload = express.Router();
  upload.use(workbookUpload(gate), acceptWorkbook());
  return [
    defineRoute({ method: 'GET', path: '/tobaccos', auth: { kind: 'user', permission: 'tobaccos:read' }, middleware: [validateQuery(tobaccosQuery)], handler: controller.list }),
    defineRoute({
      method: 'POST',
      path: '/tobaccos/import',
      auth: { kind: 'user', permission: 'tobaccos:import' },
      rateLimit: [rules.tobaccosImportPerUser],
      multipart: upload,
      handler: idempotent(idempotency, controller.importList),
    }),
  ];
}
