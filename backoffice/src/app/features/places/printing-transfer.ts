import {
  FIELDS,
  FieldDef,
  Scalars,
  setAt,
  toBodyValue,
  toFieldValue,
  valueAt,
} from './place-fields';

/** Largest file the import reads, in bytes. */
export const MAX_IMPORT_BYTES = 256 * 1024;

/**
 * The printing configuration as a JSON text: `receipt`, `prebilling` and `ordering`, with the keys
 * and the values of the API (the same objects the old backoffice exports, so a file made by it
 * can be imported too).
 *
 * @param scalars The values of the printing tab.
 */
export function exportPrinting(scalars: Scalars): string {
  const body: Record<string, unknown> = {};
  for (const definition of FIELDS.printing) {
    setAt(body, definition.key, toBodyValue(definition, scalars[definition.key]));
  }
  return JSON.stringify(body, null, 2);
}

/** What an import found: the values to apply and how many keys of the file were used and ignored. */
export interface PrintingImport {
  readonly values: Scalars;
  readonly applied: number;
  readonly ignored: number;
}

const expectedType = (definition: FieldDef): 'boolean' | 'number' | 'string' => {
  if (definition.type === 'flag') {
    return 'boolean';
  }
  return ['int', 'number', 'duration'].includes(definition.type) ? 'number' : 'string';
};

/**
 * Reads a printing configuration. Only the keys of the printing tab are taken, and only when
 * their value has the type the key has: everything else in the file is ignored, so a file can
 * never put anything but a value in a field.
 *
 * @param text The content of the file.
 * @returns What to apply, or `null` when the text is not a JSON object.
 */
export function importPrinting(text: string): PrintingImport | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const values: Scalars = {};
  let ignored = 0;
  for (const definition of FIELDS.printing) {
    const raw = valueAt(parsed, definition.key);
    const type = expectedType(definition);
    if (raw === undefined) {
      continue;
    }
    if (typeof raw === type || (raw === null && type !== 'boolean')) {
      values[definition.key] = toFieldValue(definition, raw);
    } else {
      ignored++;
    }
  }
  return { values, applied: Object.keys(values).length, ignored };
}
