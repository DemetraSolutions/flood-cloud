import {
  FIELDS,
  FieldDef,
  Scalars,
  setAt,
  toBodyValue,
  toFieldValue,
  valueAt,
} from './place-fields';
import { PlaceModel, TipRow } from './place-model';

/** Largest file the import reads, in bytes. */
export const MAX_IMPORT_BYTES = 256 * 1024;

/** Most work-shift names and tip suggestions a file can carry (the limits of the API). */
const MAX_LIST = 20;

/** The keys of the cash settings that the file does not carry (the legacy `advancedReport.logs`). */
const NOT_GENERAL = new Set(['advancedReportLogs']);

/** The keys of the cash settings the file carries as `general`. */
const generalKeys = (): readonly FieldDef[] =>
  FIELDS.cashSettings.filter((definition) => !NOT_GENERAL.has(definition.key));

function nested(definitions: readonly FieldDef[], scalars: Scalars): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const definition of definitions) {
    setAt(body, definition.key, toBodyValue(definition, scalars[definition.key]));
  }
  return body;
}

/**
 * The settings of the file the old backoffice exports: `general`, `receipt`, `prebilling`,
 * `ordering` and `roomsSettings`, with the keys and the values of the API (the same objects the
 * old backoffice exports, so a file made by it can be imported too). The price lists and the
 * reservations are not part of it.
 *
 * @param model What the form holds.
 */
export function exportSettings(model: PlaceModel): string {
  const printing = nested(FIELDS.printing, model.printing.f);
  return JSON.stringify(
    {
      general: {
        ...nested(generalKeys(), model.cashSettings.f),
        workshiftNames: model.cashSettings.workshiftNames.map((row) => row.name),
      },
      receipt: printing['receipt'],
      prebilling: printing['prebilling'],
      ordering: printing['ordering'],
      roomsSettings: {
        ...nested(FIELDS.tables, model.tables.f),
        tipValues: model.tables.tipValues.map((row) => ({
          type: row.type,
          value: Number(row.value),
        })),
      },
    },
    null,
    2,
  );
}

/** What an import found: the values to apply and how many keys of the file were used and ignored. */
export interface SettingsImport {
  readonly cashSettings: Scalars;
  readonly workshiftNames: string[] | null;
  readonly printing: Scalars;
  readonly tables: Scalars;
  readonly tipValues: TipRow[] | null;
  readonly applied: number;
  readonly ignored: number;
}

const expectedType = (definition: FieldDef): 'boolean' | 'number' | 'string' => {
  if (definition.type === 'flag') {
    return 'boolean';
  }
  return ['int', 'number', 'duration'].includes(definition.type) ? 'number' : 'string';
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Reads the values a file has for the keys of a block, below `root`: only the keys of the block
 * are taken, and only when their value has the type the key has.
 */
function read(
  definitions: readonly FieldDef[],
  source: unknown,
  count: { applied: number; ignored: number },
): Scalars {
  const values: Scalars = {};
  for (const definition of definitions) {
    const raw = valueAt(source, definition.key);
    if (raw === undefined) {
      continue;
    }
    const type = expectedType(definition);
    if (typeof raw === type || (raw === null && type !== 'boolean')) {
      values[definition.key] = toFieldValue(definition, raw);
      count.applied++;
    } else {
      count.ignored++;
    }
  }
  return values;
}

/**
 * Reads a settings file. Only the known keys are taken, and only when their value has the type the
 * key has: everything else in the file is ignored, so a file can never put anything but a value
 * in a field. Nothing is saved: the page puts the values in the form.
 *
 * @param text The content of the file.
 * @returns What to apply, or `null` when the text is not a JSON object.
 */
export function importSettings(text: string): SettingsImport | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(parsed)) {
    return null;
  }
  const count = { applied: 0, ignored: 0 };
  const general = parsed['general'];
  const rooms = parsed['roomsSettings'];
  const names = isObject(general) ? general['workshiftNames'] : undefined;
  const tips = isObject(rooms) ? rooms['tipValues'] : undefined;
  const workshiftNames = namesOf(names, count);
  const tipValues = tipsOf(tips, count);
  return {
    cashSettings: read(generalKeys(), general, count),
    workshiftNames,
    printing: read(FIELDS.printing, parsed, count),
    tables: read(FIELDS.tables, rooms, count),
    tipValues,
    applied: count.applied + (workshiftNames === null ? 0 : 1) + (tipValues === null ? 0 : 1),
    ignored: count.ignored,
  };
}

function namesOf(raw: unknown, count: { ignored: number }): string[] | null {
  if (raw === undefined) {
    return null;
  }
  if (
    Array.isArray(raw) &&
    raw.length <= MAX_LIST &&
    raw.every((item): item is string => typeof item === 'string')
  ) {
    return raw;
  }
  count.ignored++;
  return null;
}

function tipsOf(raw: unknown, count: { ignored: number }): TipRow[] | null {
  if (raw === undefined) {
    return null;
  }
  if (
    Array.isArray(raw) &&
    raw.length <= MAX_LIST &&
    raw.every(
      (item) =>
        isObject(item) &&
        (item['type'] === 'v' || item['type'] === 'p') &&
        typeof item['value'] === 'number',
    )
  ) {
    return raw.map((item) => ({
      type: item['type'] as string,
      value: String(item['value']),
    }));
  }
  count.ignored++;
  return null;
}
