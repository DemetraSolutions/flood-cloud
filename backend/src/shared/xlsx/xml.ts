import { XlsxError } from './errors.ts';

/** What the tokenizer reports. Names are local names (the namespace prefix is dropped); a self-closing element is reported as an opening followed by its closing. */
export interface XmlHandler {
  /** An element opens, with its attributes (local names, decoded values). */
  open(name: string, attributes: ReadonlyMap<string, string>): void;
  /** An element closes. */
  close(name: string): void;
  /** Text inside an element (decoded; CDATA included), possibly in several pieces. Text between elements is reported too, whitespace included. */
  text(value: string): void;
}

const NAME = /[A-Za-z_][A-Za-z0-9_.:-]*/y;
const ATTRIBUTE = /\s+([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/y;
const TAG_END = /\s*(\/?)>/y;
/** The only references an XML text may hold: the five predefined entities and numeric character references. Nothing is ever defined, so nothing is ever expanded. */
const REFERENCE = /&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|lt|gt|amp|quot|apos);/g;
const PREDEFINED: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const EMPTY: ReadonlyMap<string, string> = new Map();

/** Characters XML 1.0 does not allow: control characters but tab, line feed and carriage return, and U+FFFE and U+FFFF. */
const FORBIDDEN_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/;

const localName = (name: string): string => name.slice(name.indexOf(':') + 1);

/** The text with its references replaced; a bare `&` or a reference that is not allowed, or a character XML does not allow, makes the document malformed. */
function decode(text: string): string {
  if (FORBIDDEN_CHARACTER.test(text)) {
    throw new XlsxError('malformed');
  }
  if (!text.includes('&')) {
    return text;
  }
  // Whatever is left of an `&` after the allowed references are removed is an entity this reader does not know, or an `&` on its own.
  if (text.replace(REFERENCE, '').includes('&')) {
    throw new XlsxError('malformed');
  }
  return text.replace(REFERENCE, (_whole, body: string) => {
    if (!body.startsWith('#')) {
      return PREDEFINED[body]!;
    }
    const code = body.startsWith('#x') ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
    if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) || (code < 0x20 && code !== 9 && code !== 10 && code !== 13) || code === 0xfffe || code === 0xffff) {
      throw new XlsxError('malformed');
    }
    return String.fromCodePoint(code);
  });
}

/**
 * A minimal XML tokenizer for the parts of an XLSX workbook. It understands elements, attributes with quoted values, text, CDATA, comments and the XML declaration, and nothing else.
 *
 * Refused as `unsafe`: every markup declaration (`<!DOCTYPE`, `<!ENTITY`, `<!ELEMENT`…), so no DTD is read and no entity can ever be defined or expanded. Refused as `malformed`: a tag that is not
 * closed or closed by another name, an attribute that is repeated or not quoted, a reference other than the predefined ones and the numeric ones, more than one root element, text outside the root, no root.
 * Refused as `limit`: nesting deeper than `maxDepth`.
 *
 * @param source The document.
 * @param handler Receives the tokens in document order.
 * @param maxDepth Deepest nesting of elements allowed.
 * @throws {XlsxError} `unsafe`, `malformed` or `limit`; whatever the handler throws goes through.
 */
export function parseXml(source: string, handler: XmlHandler, maxDepth: number): void {
  const stack: string[] = [];
  let roots = 0;
  let index = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (index < source.length) {
    const lt = source.indexOf('<', index);
    const stop = lt === -1 ? source.length : lt;
    if (stop > index) {
      const text = source.slice(index, stop);
      if (stack.length > 0) {
        handler.text(decode(text));
      } else if (text.trim() !== '') {
        throw new XlsxError('malformed');
      }
    }
    if (lt === -1) {
      break;
    }
    index = lt;
    if (source.startsWith('<!--', index)) {
      const close = source.indexOf('-->', index + 4);
      if (close === -1) {
        throw new XlsxError('malformed');
      }
      index = close + 3;
    } else if (source.startsWith('<![CDATA[', index)) {
      const close = source.indexOf(']]>', index + 9);
      if (close === -1 || stack.length === 0) {
        throw new XlsxError('malformed');
      }
      const raw = source.slice(index + 9, close);
      if (FORBIDDEN_CHARACTER.test(raw)) {
        throw new XlsxError('malformed');
      }
      handler.text(raw);
      index = close + 3;
    } else if (source.startsWith('<!', index)) {
      throw new XlsxError('unsafe');
    } else if (source.startsWith('<?', index)) {
      const close = source.indexOf('?>', index + 2);
      if (close === -1) {
        throw new XlsxError('malformed');
      }
      index = close + 2;
    } else if (source.startsWith('</', index)) {
      const close = source.indexOf('>', index);
      const name = close === -1 ? '' : source.slice(index + 2, close).trim();
      if (stack.pop() !== name) {
        throw new XlsxError('malformed');
      }
      handler.close(localName(name));
      index = close + 1;
    } else {
      NAME.lastIndex = index + 1;
      const named = NAME.exec(source);
      if (named === null || (stack.length === 0 && roots > 0)) {
        throw new XlsxError('malformed');
      }
      const name = named[0];
      let attributes: Map<string, string> | null = null;
      const seen = new Set<string>();
      let position = NAME.lastIndex;
      for (;;) {
        ATTRIBUTE.lastIndex = position;
        const attribute = ATTRIBUTE.exec(source);
        if (attribute === null) {
          break;
        }
        if (seen.has(attribute[1]!)) {
          throw new XlsxError('malformed');
        }
        seen.add(attribute[1]!);
        attributes ??= new Map();
        attributes.set(localName(attribute[1]!), decode(attribute[2] ?? attribute[3]!));
        position = ATTRIBUTE.lastIndex;
      }
      TAG_END.lastIndex = position;
      const end = TAG_END.exec(source);
      if (end === null) {
        throw new XlsxError('malformed');
      }
      if (stack.length === 0) {
        roots += 1;
      }
      if (stack.length >= maxDepth) {
        throw new XlsxError('limit');
      }
      handler.open(localName(name), attributes ?? EMPTY);
      if (end[1] === '/') {
        handler.close(localName(name));
      } else {
        stack.push(name);
      }
      index = TAG_END.lastIndex;
    }
  }
  if (stack.length > 0 || roots === 0) {
    throw new XlsxError('malformed');
  }
}
