/** Rules of a numeric text field. */
export interface NumberRule {
  readonly min: number;
  readonly max?: number;
  readonly integer?: boolean;
  /** Whether the field may be left empty. */
  readonly optional?: boolean;
}

/** Issue of a numeric text field, or `undefined` when it is valid (same names as the backend). */
export function numberIssue(
  text: string,
  rule: NumberRule,
): 'required' | 'type' | 'minimum' | 'maximum' | undefined {
  const value = text.trim();
  if (value === '') {
    return rule.optional ? undefined : 'required';
  }
  const number = Number(value);
  if (!Number.isFinite(number) || (rule.integer === true && !Number.isInteger(number))) {
    return 'type';
  }
  if (number < rule.min) {
    return 'minimum';
  }
  return rule.max !== undefined && number > rule.max ? 'maximum' : undefined;
}

/** The number in a text field, `null` when it is empty. */
export function numberOrNull(text: string): number | null {
  return text.trim() === '' ? null : Number(text);
}

/** Text of a number for a text field (`''` for `null`). */
export function numberText(value: number | null): string {
  return value === null ? '' : String(value);
}

/** Trimmed text, or `null` when blank. */
export function textOrNull(value: string): string | null {
  return value.trim() === '' ? null : value.trim();
}
