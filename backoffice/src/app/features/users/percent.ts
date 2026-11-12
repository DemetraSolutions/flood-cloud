/** A percentage typed in a form: `null` when empty, otherwise the number. */
export function percentOrNull(value: string): number | null {
  return value.trim() === '' ? null : Number(value);
}

/**
 * Validation issue of a percentage typed as text: `''` is valid (no value), anything else must be
 * a number from 0 to 100. The `kind` is an issue name of the backend.
 */
export function percentIssue(value: string): { kind: string } | undefined {
  if (value.trim() === '') {
    return undefined;
  }
  const number = Number(value);
  if (Number.isNaN(number)) {
    return { kind: 'type' };
  }
  if (number < 0) {
    return { kind: 'minimum' };
  }
  return number > 100 ? { kind: 'maximum' } : undefined;
}
