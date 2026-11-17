/** Document types of the error list (`documentType` filter and row value). */
export const ERROR_DOCUMENT_TYPES = ['invoice', 'creditNote'] as const;

/** A document type of {@link ERROR_DOCUMENT_TYPES}. */
export type ErrorDocumentType = (typeof ERROR_DOCUMENT_TYPES)[number];

/** Allowed shape of the `errorCode` filter (the same as the backend allowlist). */
export const ERROR_CODE_PATTERN = /^[A-Za-z0-9]{1,10}$/;

/** Whether a value is a known document type. */
export function isErrorDocumentType(value: unknown): value is ErrorDocumentType {
  return ERROR_DOCUMENT_TYPES.some((type) => type === value);
}

/** Dictionary key of the label of a document type. */
export function errorDocumentTypeKey(type: ErrorDocumentType): string {
  return type === 'invoice' ? 'ERROR_DOCUMENTS.TYPE.INVOICE' : 'ERROR_DOCUMENTS.TYPE.CREDIT_NOTE';
}

/** Error of a document refused by the hub: both parts come from the provider and are plain text. */
export interface DocumentError {
  readonly code: string | null;
  /** Plain text (never markup), at most 2000 characters. */
  readonly description: string | null;
}

/** One row of `GET /v1/error-documents`: an electronic document of the send queue in error. */
export interface ErrorDocumentRow {
  readonly id: string;
  /** `null` for a queue document whose group id is not valid (platform administrators only). */
  readonly groupId: string | null;
  readonly groupName: string | null;
  readonly companyName: string | null;
  /** Display number, already built by the server (prefix or suffix included). */
  readonly number: string | null;
  /** ISO date. */
  readonly date: string | null;
  readonly documentType: ErrorDocumentType | null;
  /** Electronic invoice type, e.g. `TD01`. */
  readonly eInvoiceType: string | null;
  readonly customer: string | null;
  /** Total in euros (a decimal amount, not cents). */
  readonly total: number | null;
  readonly sendStatus: string | null;
  readonly error: DocumentError | null;
}

/**
 * Formats a date as `dd-MM-yyyy` (the format of the legacy page).
 *
 * @param value ISO date.
 * @returns The formatted day, or `null` when the value is not a valid date.
 */
export function formatDay(value: string): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(date.getDate())}-${two(date.getMonth() + 1)}-${date.getFullYear()}`;
}
