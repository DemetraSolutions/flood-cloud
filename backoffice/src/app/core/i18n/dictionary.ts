/** Placeholder parameters for {@link interpolate}. */
export type TranslateParams = Readonly<Record<string, string | number>>;

/**
 * Flattens a nested JSON dictionary into dot-separated keys (`COMMON.RETRY`), validating that
 * every leaf is a string.
 *
 * @param raw Parsed JSON dictionary of unknown shape.
 * @returns Map from flat key to text.
 * @throws Error when the dictionary is not an object or a leaf is not a string.
 */
export function flattenDictionary(raw: unknown): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  const visit = (node: unknown, path: string): void => {
    if (typeof node === 'string') {
      result.set(path, node);
    } else if (typeof node === 'object' && node !== null && !Array.isArray(node)) {
      for (const [key, child] of Object.entries(node)) {
        visit(child, path === '' ? key : `${path}.${key}`);
      }
    } else {
      throw new Error(`Invalid dictionary: "${path}" is not a string or an object.`);
    }
  };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Invalid dictionary: the root must be an object.');
  }
  visit(raw, '');
  return result;
}

/**
 * Replaces `{name}` placeholders with parameter values. No escaping is needed because Angular
 * interpolates the result as text. Placeholders without a parameter are left as they are.
 *
 * @param text Text with placeholders.
 * @param params Values by placeholder name.
 */
export function interpolate(text: string, params: TranslateParams): string {
  return text.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : placeholder,
  );
}
