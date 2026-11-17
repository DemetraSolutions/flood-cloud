import { enumOf, integerString, object, objectId, optional, string } from '../../shared/validation/schema.ts';
import type { Infer } from '../../shared/validation/schema.ts';

/** Largest page of the error documents table. */
export const ERROR_DOCUMENTS_MAX_LIMIT = 100;

/** Default page of the error documents table. */
export const ERROR_DOCUMENTS_DEFAULT_LIMIT = 50;

/** The document types a request may filter by (the public spelling of the `type` the queue stores). */
export const DOCUMENT_TYPE_FILTERS = ['invoice', 'creditNote'] as const;

/** An error code as the hub writes it: letters and digits, at most ten. */
export const ERROR_CODE_FORMAT = /^[A-Za-z0-9]{1,10}$/;

/** The filters the table and its CSV share. */
const filters = {
  groupId: optional(objectId()),
  dealerId: optional(objectId()),
  documentType: optional(enumOf(DOCUMENT_TYPE_FILTERS)),
  errorCode: optional(string({ min: 1, max: 10, pattern: ERROR_CODE_FORMAT, normalize: false })),
};

/** Query of `GET /v1/error-documents`: the filters and the cursor pagination. Unknown parameters are refused. */
export const errorDocumentsQuery = object({
  limit: optional(integerString({ min: 1, max: ERROR_DOCUMENTS_MAX_LIMIT })),
  cursor: optional(string({ min: 1, max: 100, normalize: false })),
  ...filters,
});

/** Validated query of the error documents table. */
export type ErrorDocumentsQuery = Infer<typeof errorDocumentsQuery>;

/** Query of `GET /v1/error-documents.csv`: the same filters, with no pagination (the whole result is exported, up to the limit of the export). */
export const errorDocumentsCsvQuery = object({ ...filters });

/** Validated query of the CSV export. */
export type ErrorDocumentsCsvQuery = Infer<typeof errorDocumentsCsvQuery>;
