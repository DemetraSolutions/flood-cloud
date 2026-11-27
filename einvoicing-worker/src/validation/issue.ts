/**
 * Result type of the pre-send validator (step EI4).
 *
 * A {@link ValidationIssue} names the rule that failed (`code`), where (`path`, in the XSD element names with indexes)
 * and how serious it is. The `message` is a short Italian sentence for the backoffice and **never contains the
 * offending value** (invoices hold personal data), the same rule the mapper follows for its own issues.
 *
 * Codes: the SdI code when the rule has one (`00400`...), otherwise `XSD` (a rule of the official schema), `SIZE`
 * (file too big), `FISCAL_ID` (checksum of an Italian fiscal identifier), `TOTAL` (document total that does not match
 * the summaries) and `TEXT` (a text the mapper had to alter, passed through).
 *
 * @module
 */

/** An `error` blocks the sending, a `warning` is shown but does not. */
export type Severity = 'error' | 'warning';

/** One problem found by the validator. */
export interface ValidationIssue {
  /** SdI code (`00400`...) or one of `XSD`, `SIZE`, `FISCAL_ID`, `TOTAL`, `TEXT`. */
  readonly code: string;
  /** XSD-style path with indexes, e.g. `FatturaElettronicaBody[0].DatiBeniServizi.DettaglioLinee[2].Natura`. */
  readonly path: string;
  readonly severity: Severity;
  /** Short Italian sentence, never the field value. */
  readonly message: string;
}

/** Outcome of the validation of a whole invoice. */
export interface ValidationResult {
  /** Problems that block the sending. */
  readonly errors: readonly ValidationIssue[];
  /** Problems that are reported but do not block. */
  readonly warnings: readonly ValidationIssue[];
}

/**
 * Builds an issue.
 *
 * @param code Rule code.
 * @param path XSD-style path.
 * @param severity `error` or `warning`.
 * @param message Italian sentence without values.
 * @returns The issue.
 */
export function issue(code: string, path: string, severity: Severity, message: string): ValidationIssue {
  return { code, path, severity, message };
}

/**
 * Builds an `error` issue.
 *
 * @param code Rule code.
 * @param path XSD-style path.
 * @param message Italian sentence without values.
 * @returns The issue.
 */
export function error(code: string, path: string, message: string): ValidationIssue {
  return issue(code, path, 'error', message);
}

/**
 * Builds a `warning` issue.
 *
 * @param code Rule code.
 * @param path XSD-style path.
 * @param message Italian sentence without values.
 * @returns The issue.
 */
export function warning(code: string, path: string, message: string): ValidationIssue {
  return issue(code, path, 'warning', message);
}

/**
 * Joins a parent path and a child name.
 *
 * @param parent Parent path (may be empty).
 * @param name Child element name, possibly with an index.
 * @returns `parent.name`, or `name` when the parent is empty.
 */
export function child(parent: string, name: string): string {
  return parent === '' ? name : `${parent}.${name}`;
}

/**
 * Orders issues deterministically: by path, then by code, then by message.
 *
 * @param issues The issues (not modified).
 * @returns A new sorted array.
 */
export function sortIssues(issues: readonly ValidationIssue[]): ValidationIssue[] {
  return [...issues].sort((a, b) => compareText(a.path, b.path) || compareText(a.code, b.code) || compareText(a.message, b.message));
}

function compareText(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}
