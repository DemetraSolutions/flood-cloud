import { FIXED_COLUMNS, SHEET_NAMES } from '../../src/modules/catalog-xlsx/catalog-xlsx.columns.ts';
import type { SheetKind } from '../../src/modules/catalog-xlsx/catalog-xlsx.columns.ts';
import { xlsxChunks } from '../../src/shared/xlsx/writer.ts';

/** The rows of a sheet of a test workbook: each row maps a column to its text. The column is the key of a fixed column (`name`, `list1`…) or, for any other one, the whole header (`DISPO | Bar`). */
export type TestSheet = ReadonlyArray<Readonly<Record<string, string>>>;

/**
 * Builds a workbook of the catalog for a test: each sheet has the columns its rows use (in the order of the fixed columns, then the others in order of appearance), so a column a test does not name is absent
 * from the file (and an absent column leaves the data alone). `headers` adds columns to a sheet even when no row uses them.
 *
 * @param sheets The rows of each sheet.
 * @param headers Columns that must exist.
 */
export async function catalogWorkbook(sheets: Partial<Record<SheetKind, TestSheet>>, headers: Partial<Record<SheetKind, readonly string[]>> = {}): Promise<Buffer> {
  const parts: Array<{ name: string; columns: string[]; rows: string[][] }> = [];
  for (const kind of ['products', 'variants', 'categories'] as const) {
    const rows = sheets[kind];
    if (rows === undefined) {
      continue;
    }
    const used = new Set([...headers[kind] ?? [], ...rows.flatMap((row) => Object.keys(row))]);
    const fixed = FIXED_COLUMNS[kind].filter((column) => used.has(column.key));
    const others = [...used].filter((key) => !FIXED_COLUMNS[kind].some((column) => column.key === key));
    const keys = [...fixed.map((column) => column.key), ...others];
    const header = (key: string): string => FIXED_COLUMNS[kind].find((column) => column.key === key)?.header ?? key;
    parts.push({ name: SHEET_NAMES[kind], columns: keys.map(header), rows: rows.map((row) => keys.map((key) => row[key] ?? '')) });
  }
  const chunks: Buffer[] = [];
  for await (const chunk of xlsxChunks(parts)) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** What the helpers need of a test world (`startPlacesWorld`). */
export interface CatalogWorld {
  readonly office: { readonly app: { readonly baseUrl: string } };
  readonly as: { tokenOf(actor: import('mongodb').ObjectId): Promise<string> };
}

/**
 * `GET /v1<path>` as `actor` (the bearer token is made by the world); the body is read as bytes.
 *
 * @param world The test world.
 * @param path The path under `/v1`.
 * @param actor The user.
 * @param headers More headers.
 */
export async function downloadWorkbook(world: CatalogWorld, path: string, actor: import('mongodb').ObjectId, headers: Record<string, string> = {}): Promise<{ status: number; headers: Headers; bytes: Buffer }> {
  const response = await fetch(`${world.office.app.baseUrl}/v1${path}`, { headers: { authorization: `Bearer ${await world.as.tokenOf(actor)}`, ...headers } });
  return { status: response.status, headers: response.headers, bytes: Buffer.from(await response.arrayBuffer()) };
}

/**
 * `POST /v1<path>` as `actor` with a multipart body of one file in the field `file` (or the parts given); a fresh `Idempotency-Key` unless `headers` has one. The answer is read as JSON.
 *
 * @param world The test world.
 * @param path The path under `/v1`, with the query.
 * @param bytes The file.
 * @param actor The user.
 * @param headers Replaces or adds headers (`'idempotency-key': undefined` is not supported: pass the whole header set).
 */
export async function uploadWorkbook(world: CatalogWorld, path: string, bytes: Buffer, actor: import('mongodb').ObjectId, headers?: Record<string, string>): Promise<{ status: number; headers: Headers; body: any }> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)]), 'catalogo.xlsx');
  const response = await fetch(`${world.office.app.baseUrl}/v1${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${await world.as.tokenOf(actor)}`, ...(headers ?? { 'idempotency-key': crypto.randomUUID() }) },
    body: form,
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text === '' ? undefined : JSON.parse(text) };
}
