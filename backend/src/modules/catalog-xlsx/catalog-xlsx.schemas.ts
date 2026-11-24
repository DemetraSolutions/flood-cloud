import { enumOf, object, optional, transform } from '../../shared/validation/schema.ts';
import type { Infer } from '../../shared/validation/schema.ts';

/** Query of `GET /v1/groups/{groupId}/catalog-export`: how the references of the file are written, `ids` (the default) or `names` (a tax rate by its percentage). Unknown parameters are refused. */
export const exportQuery = object({ references: optional(enumOf(['ids', 'names'] as const)) });

/** Validated query of the export. */
export type ExportQuery = Infer<typeof exportQuery>;

/** Query of `POST /v1/groups/{groupId}/catalog-import`: `dryRun=true` verifies the file and counts what would be written, writing nothing. */
export const importQuery = object({ dryRun: optional(transform(enumOf(['true', 'false'] as const), (value) => value === 'true', 'enum')) });

/** Validated query of the import. */
export type ImportQuery = Infer<typeof importQuery>;
