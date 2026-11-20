/**
 * Reasons a field can be rejected, by the backend (`error.details[].issue`) or by the client
 * validators (which use the same names). Each has a message `FORM.ISSUE.<NAME>` in the
 * dictionaries; a test checks that none is missing.
 */
export const FIELD_ISSUES = [
  'required',
  'type',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'enum',
  'unknown',
  'forbiddenKey',
  'format',
  'tooDeep',
  'tooMany',
  'incorrect',
  'notAllowed',
  'immutable',
  'default',
  'last',
  'referenced',
  'inUse',
  'taken',
  'reused',
  'tooShort',
  'tooLong',
  'sameAsUsername',
  'invalidCharacters',
  'mismatch',
  'semicolon',
] as const;

/** Name of a known field issue. */
export type FieldIssue = (typeof FIELD_ISSUES)[number];

const KNOWN: ReadonlySet<string> = new Set(FIELD_ISSUES);

/** Client validators that map onto an issue with another name. */
const ALIASES: Readonly<Record<string, FieldIssue>> = { email: 'format' };

function toDictionaryName(issue: string): string {
  return issue.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
}

/**
 * Dictionary key of the user message for a field issue; unknown issues get the generic
 * "invalid value" message.
 *
 * @param issue Issue code from the backend or the name of a client validator error.
 */
export function issueMessageKey(issue: string): string {
  const name = Object.hasOwn(ALIASES, issue) ? ALIASES[issue] : issue;
  return `FORM.ISSUE.${KNOWN.has(name) ? toDictionaryName(name) : 'INVALID'}`;
}
