import express from 'express';
import type { Request, Response } from 'express';
import { idempotent } from '../../shared/http/idempotency.ts';
import type { IdempotencyStore } from '../../shared/http/idempotency.ts';
import { defineRoute } from '../../shared/http/routes.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';
import type { RateLimitRule } from '../../shared/security/rate-limit/rate-limit.ts';
import { validateQuery } from '../../shared/validation/middleware.ts';
import { createGate } from '../media/gate.ts';
import type { Gate } from '../media/gate.ts';
import { acceptWorkbook, workbookUpload } from '../tobaccos/tobaccos.upload.ts';
import type { CatalogXlsxController } from './catalog-xlsx.controller.ts';
import { exportQuery, importQuery } from './catalog-xlsx.schemas.ts';

/** The segment of the export under `/groups/{groupId}`. */
export const EXPORT_SEGMENT = 'catalog-export';

/** The segment of the import under `/groups/{groupId}`. */
export const IMPORT_SEGMENT = 'catalog-import';

/**
 * Imports per user per hour. A real import holds write locks on the products it changes for as long as it runs (the transaction), so it is limited to 6; a verification (`dryRun=true`) runs the same
 * transaction and then aborts it, so it has its own bucket of 20. Exports per user per hour: each reads the whole catalog the caller reaches.
 */
export const IMPORTS_PER_USER_HOUR = 6;
export const DRY_RUNS_PER_USER_HOUR = 20;
export const EXPORTS_PER_USER_HOUR = 30;

const perUser = (_req: Request, res: Response): string | null => res.locals.auth?.userId.toHexString() ?? null;
const hourly = (bucket: string, limit: number, applies: (req: Request) => boolean = () => true): RateLimitRule => Object.freeze({ bucket, limit, windowSeconds: 3600, key: (req: Request, res: Response) => (applies(req) ? perUser(req, res) : null) });
const isDryRun = (req: Request): boolean => req.query['dryRun'] === 'true';

/** Imports that run at once in the process, over all the groups, and that may wait: a workbook is held in memory (10 MB) and read on the event loop. */
const PROCESS_RUNNING = 4;
const PROCESS_WAITING = 8;

/** Two gates in a row: the slot is the one of both, given back together. */
function inSequence(first: Gate, second: Gate): Gate {
  return {
    enter: async () => {
      const releaseFirst = await first.enter();
      try {
        const releaseSecond = await second.enter();
        return () => {
          releaseSecond();
          releaseFirst();
        };
      } catch (error) {
        releaseFirst();
        throw error;
      }
    },
  };
}

/**
 * The gate of the imports: one runs at a time **for a group** and two wait (a group does not hold up the others), and the process holds {@link PROCESS_RUNNING} at once at most. The guarantee is per instance of
 * the server; with more instances the transaction is what keeps the data correct.
 */
function perGroupGate(): (groupId: string) => Gate {
  const processGate = createGate(PROCESS_RUNNING, PROCESS_WAITING);
  const gates = new Map<string, Gate>();
  return (groupId) => {
    let gate = gates.get(groupId);
    if (gate === undefined) {
      gate = createGate(1, 2);
      gates.set(groupId, gate);
    }
    return inSequence(gate, processGate);
  };
}

/**
 * The routes of the workbook of the catalog (`doc/Tasks.md` step C6), on `/v1` and on every group: the model and the export need `products:read`, the import `products:update`. Not open to a store key (the
 * default). The import is a `multipart/form-data` upload of one XLSX file, idempotent (`Idempotency-Key`; the key covers the file and `dryRun`) and limited per hour for the user.
 *
 * @param controller Handlers.
 * @param idempotency The record of the idempotency keys.
 * @param gate A gate that replaces the per-group gates (tests); by default one gate for each group and one for the process.
 * @returns The route definitions to mount on `/v1`.
 */
export function createCatalogXlsxRoutes(controller: CatalogXlsxController, idempotency: IdempotencyStore, gate?: Gate): RouteDefinition[] {
  const read = { kind: 'user' as const, permission: 'products:read' as const, group: true as const };
  const write = { kind: 'user' as const, permission: 'products:update' as const, group: true as const };
  const upload = express.Router();
  const gateOf = perGroupGate();
  upload.use((req, res, next) => workbookUpload(gate ?? gateOf(res.locals.groupAccess!.groupId.toHexString()))(req, res, next));
  upload.use(acceptWorkbook(), (req, _res, next) => {
    // The idempotency key covers the file and the mode: a dry run and the real import are not the same request.
    req.body = { ...(req.body as object), dryRun: req.query['dryRun'] === 'true' };
    next();
  });
  return [
    defineRoute({ method: 'GET', path: `/groups/:groupId/${EXPORT_SEGMENT}/template`, auth: read, handler: controller.template }),
    defineRoute({ method: 'GET', path: `/groups/:groupId/${EXPORT_SEGMENT}`, auth: read, rateLimit: [hourly('catalog-export:user', EXPORTS_PER_USER_HOUR)], middleware: [validateQuery(exportQuery)], handler: controller.export }),
    defineRoute({
      method: 'POST',
      path: `/groups/:groupId/${IMPORT_SEGMENT}`,
      auth: write,
      rateLimit: [hourly('catalog-import:user', IMPORTS_PER_USER_HOUR, (req) => !isDryRun(req)), hourly('catalog-import-dry-run:user', DRY_RUNS_PER_USER_HOUR, isDryRun)],
      multipart: upload,
      middleware: [validateQuery(importQuery)],
      handler: idempotent(idempotency, controller.import),
    }),
  ];
}
