import express from 'express';
import type { Request, Response } from 'express';
import { idempotent } from '../../shared/http/idempotency.ts';
import type { IdempotencyStore } from '../../shared/http/idempotency.ts';
import { defineRoute } from '../../shared/http/routes.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';
import type { Permission } from '../../shared/security/rbac/permissions.ts';
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

/** The gate of the process, shared by the imports of every workbook (catalog, contacts, loyalty cards): they all hold a file in memory and read it on the event loop. */
const PROCESS_GATE = createGate(PROCESS_RUNNING, PROCESS_WAITING);

/**
 * The gate of the imports of **every** workbook (catalog, contacts, loyalty cards): one runs at a time **for a group** and two wait (a group does not hold up the others), and the process holds {@link PROCESS_RUNNING} at once at most. The guarantee is per instance of
 * the server; with more instances the transaction is what keeps the data correct.
 */
function perGroupGate(): (groupId: string) => Gate {
  const gates = new Map<string, Gate>();
  return (groupId) => {
    let gate = gates.get(groupId);
    if (gate === undefined) {
      gate = createGate(1, 2);
      gates.set(groupId, gate);
    }
    return inSequence(gate, PROCESS_GATE);
  };
}

/** The gates of the groups, one map for all the workbooks: a group holds at most one place of the process for every XLSX import, whatever the workbook (the locks of MongoDB stay one for each workbook). */
const GATE_OF = perGroupGate();

/** What makes the routes of one workbook different from another: the URL segments, the names of the rate-limit buckets and the permissions. */
export interface WorkbookRoutesOptions {
  /** The segment of the export (`catalog-export`) under `/groups/{groupId}`. */
  readonly exportSegment: string;
  /** The segment of the import (`catalog-import`). */
  readonly importSegment: string;
  /** The prefix of the buckets: `<prefix>-export:user`, `<prefix>-import:user`, `<prefix>-import-dry-run:user`. */
  readonly bucket: string;
  /** The permission of the model and of the export. */
  readonly read: Permission;
  /** The permission of the import. */
  readonly write: Permission;
  /** Exports per user per hour ({@link EXPORTS_PER_USER_HOUR} by default). */
  readonly exportsPerHour?: number;
}

/**
 * The routes of a workbook (the model and the export need the `read` permission, the import the `write` one), on `/v1` and on every group. Not open to a store key (the default). The import is a `multipart/form-data`
 * upload of one XLSX file, idempotent (`Idempotency-Key`; the key covers the file and `dryRun`) and limited per hour for the user.
 *
 * @param options The segments, the buckets and the permissions.
 * @param controller Handlers.
 * @param idempotency The record of the idempotency keys.
 * @param gate A gate that replaces the per-group gates (tests); by default one gate for each group and one for the process.
 * @returns The route definitions to mount on `/v1`.
 */
export function createWorkbookRoutes(options: WorkbookRoutesOptions, controller: CatalogXlsxController, idempotency: IdempotencyStore, gate?: Gate): RouteDefinition[] {
  const read = { kind: 'user' as const, permission: options.read, group: true as const };
  const write = { kind: 'user' as const, permission: options.write, group: true as const };
  const upload = express.Router();
  upload.use((req, res, next) => workbookUpload(gate ?? GATE_OF(res.locals.groupAccess!.groupId.toHexString()))(req, res, next));
  upload.use(acceptWorkbook(), (req, _res, next) => {
    // The idempotency key covers the file and the mode: a dry run and the real import are not the same request.
    req.body = { ...(req.body as object), dryRun: req.query['dryRun'] === 'true' };
    next();
  });
  return [
    defineRoute({ method: 'GET', path: `/groups/:groupId/${options.exportSegment}/template`, auth: read, handler: controller.template }),
    defineRoute({ method: 'GET', path: `/groups/:groupId/${options.exportSegment}`, auth: read, rateLimit: [hourly(`${options.bucket}-export:user`, options.exportsPerHour ?? EXPORTS_PER_USER_HOUR)], middleware: [validateQuery(exportQuery)], handler: controller.export }),
    defineRoute({
      method: 'POST',
      path: `/groups/:groupId/${options.importSegment}`,
      auth: write,
      rateLimit: [hourly(`${options.bucket}-import:user`, IMPORTS_PER_USER_HOUR, (req) => !isDryRun(req)), hourly(`${options.bucket}-import-dry-run:user`, DRY_RUNS_PER_USER_HOUR, isDryRun)],
      multipart: upload,
      middleware: [validateQuery(importQuery)],
      handler: idempotent(idempotency, controller.import),
    }),
  ];
}

/**
 * The routes of the workbook of the catalog (`doc/Tasks.md` step C6), on `/v1` and on every group: the model and the export need `products:read`, the import `products:update`. See {@link createWorkbookRoutes}.
 *
 * @param controller Handlers.
 * @param idempotency The record of the idempotency keys.
 * @param gate A gate that replaces the per-group gates (tests); by default one gate for each group and one for the process.
 * @returns The route definitions to mount on `/v1`.
 */
export function createCatalogXlsxRoutes(controller: CatalogXlsxController, idempotency: IdempotencyStore, gate?: Gate): RouteDefinition[] {
  return createWorkbookRoutes({ exportSegment: EXPORT_SEGMENT, importSegment: IMPORT_SEGMENT, bucket: 'catalog', read: 'products:read', write: 'products:update' }, controller, idempotency, gate);
}
