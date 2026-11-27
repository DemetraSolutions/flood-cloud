/**
 * The reasons of a rejection, as Aruba reports them: from the status detail, from the SdI discard notification (`NS`) and
 * from the description of a processing error.
 *
 * The notification is an XML file Aruba sends base64-encoded. It is read by a strict, bounded extractor instead of an XML
 * parser (no dependency, nothing to expand): only the text between the known tags is taken, the size and the number of
 * errors are capped, entities are decoded in one pass and control characters are dropped.
 *
 * Limits, by design: only unprefixed `<Tag>` elements are read (the SdI notification writes them that way; a prefixed
 * `<ns:Errore>` is not seen) and CDATA sections are not unwrapped (their text would be read with the markers). A file written
 * differently yields no reasons, never a wrong one; the status is still reported.
 *
 * @module
 */
import type { SdiError } from '../types.ts';
import { cleanText, isRecord } from './text.ts';

/** Most reasons kept for one invoice. */
export const MAX_SDI_ERRORS = 20;

/** Largest notification file read once decoded, in bytes. */
const MAX_NOTIFICATION_BYTES = 1024 * 1024;

/** The same limit as a length of base64 text. */
const MAX_NOTIFICATION_BASE64 = Math.ceil((MAX_NOTIFICATION_BYTES * 4) / 3) + 4;

const MAX_CODE = 50;
const MAX_DESCRIPTION = 1000;

/**
 * The reasons listed in the `sdiErrors` of a status detail. Only well-formed items count: an object with a code.
 *
 * @param value The `sdiErrors` member of the detail (anything).
 * @returns The reasons (at most {@link MAX_SDI_ERRORS}), empty when there is none usable.
 */
export function errorsFromDetail(value: unknown): SdiError[] {
  const errors: SdiError[] = [];
  for (const item of Array.isArray(value) ? (value as unknown[]) : []) {
    if (!isRecord(item)) {
      continue;
    }
    const code = cleanText(item['code'] ?? item['errorCode'], MAX_CODE);
    if (code !== '') {
      errors.push({ code, description: cleanText(item['description'] ?? item['errorDescription'], MAX_DESCRIPTION) });
    }
  }
  return errors.slice(0, MAX_SDI_ERRORS);
}

/**
 * The reasons of a processing error: the `FATRSMxxx` code of Aruba's description and the SdI codes it quotes
 * (`00400 - ...`); when it has neither, the description itself under the code `ARUBA`.
 *
 * @param description `statusDescription` of the detail.
 * @returns The reasons, empty when there is no description.
 */
export function errorsFromDescription(description: unknown): SdiError[] {
  const text = cleanText(description, MAX_DESCRIPTION);
  if (text === '') {
    return [];
  }
  const errors: SdiError[] = [];
  const own = /FATRSM[0-9]{3}/.exec(text);
  if (own !== null) {
    errors.push({ code: own[0], description: text });
  }
  for (const quoted of text.matchAll(/\b([0-9]{5})\s*[-:]\s*([^;|]{1,300})/g)) {
    errors.push({ code: quoted[1] as string, description: cleanText(quoted[2], MAX_DESCRIPTION) });
  }
  return errors.length === 0 ? [{ code: 'ARUBA', description: text }] : errors.slice(0, MAX_SDI_ERRORS);
}

const ENTITIES: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** Decodes the five predefined entities and numeric references, in a single pass (a decoded `&` is never decoded again). */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|lt|gt|amp|quot|apos);/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const point = body[1] === 'x' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      // Beyond Unicode, or a lone surrogate (not a character): dropped.
      return point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff) ? '' : String.fromCodePoint(point);
    }
    return ENTITIES[body] as string;
  });
}

/** The text between `<tag>` and `</tag>` at or after `from`, and where the closing tag ends. */
function between(xml: string, tag: string, from: number): { readonly content: string; readonly end: number } | undefined {
  const open = `<${tag}>`;
  const start = xml.indexOf(open, from);
  if (start === -1) {
    return undefined;
  }
  const close = xml.indexOf(`</${tag}>`, start + open.length);
  return close === -1 ? undefined : { content: xml.slice(start + open.length, close), end: close + tag.length + 3 };
}

/**
 * The reasons in a discard notification (`NotificaScarto`): `ListaErrori/Errore/{Codice,Descrizione}`.
 *
 * @param base64 The notification file as Aruba sends it.
 * @returns The reasons (at most {@link MAX_SDI_ERRORS}), empty when the file lists none, or `undefined` when the file is too large.
 */
export function errorsFromNotification(base64: string): SdiError[] | undefined {
  if (base64.length > MAX_NOTIFICATION_BASE64) {
    return undefined;
  }
  const xml = Buffer.from(base64, 'base64').toString('utf8');
  const list = between(xml, 'ListaErrori', 0)?.content ?? '';
  const errors: SdiError[] = [];
  let from = 0;
  while (errors.length < MAX_SDI_ERRORS) {
    const item = between(list, 'Errore', from);
    if (item === undefined) {
      break;
    }
    from = item.end;
    const code = cleanText(decodeEntities(between(item.content, 'Codice', 0)?.content ?? ''), MAX_CODE);
    if (code !== '') {
      errors.push({ code, description: cleanText(decodeEntities(between(item.content, 'Descrizione', 0)?.content ?? ''), MAX_DESCRIPTION) });
    }
  }
  return errors;
}
