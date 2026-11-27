/**
 * Minimal XML writer for the invoice documents.
 *
 * The XML is never built by string templates: the serializer composes a tree of {@link XmlNode}s and this writer
 * renders it, so every text goes through the same escaping and the output is deterministic (same tree, same bytes).
 * Rules: a node with no text and no (non-empty) child is not written at all, so an absent datum never produces an
 * empty element; attributes keep the order they were declared in; the document is indented with two spaces and
 * starts with the UTF-8 declaration.
 *
 * @module
 */

/** An element holding text. */
export interface XmlTextNode {
  readonly name: string;
  readonly attributes?: Readonly<Record<string, string>>;
  readonly text: string;
}

/** An element holding elements; `undefined` children are skipped (the "absent datum" of the serializer). */
export interface XmlParentNode {
  readonly name: string;
  readonly attributes?: Readonly<Record<string, string>>;
  readonly children: readonly (XmlNode | undefined)[];
}

/** A node of the tree to render. */
export type XmlNode = XmlTextNode | XmlParentNode;

/** Whether a code point is a `Char` of XML 1.0. */
function isXmlCharacter(codePoint: number): boolean {
  return (
    codePoint === 0x9 ||
    codePoint === 0xa ||
    codePoint === 0xd ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff)
  );
}

const ESCAPES: Readonly<Record<string, string>> = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
});

/**
 * Escapes a text for an element or an attribute: `&`, `<`, `>`, `"` and `'`.
 *
 * @param text The raw text.
 * @returns The escaped text.
 * @throws Error When the text has a character that XML 1.0 cannot represent (the model must be sanitized first).
 */
export function escapeXml(text: string): string {
  for (const character of text) {
    if (!isXmlCharacter(character.codePointAt(0) as number)) {
      throw new Error('Text has a character that is not allowed in XML');
    }
  }
  return text.replace(/[&<>"']/g, (character) => ESCAPES[character] as string);
}

function renderAttributes(attributes: Readonly<Record<string, string>> | undefined): string {
  return Object.entries(attributes ?? {})
    .map(([name, value]) => ` ${name}="${escapeXml(value)}"`)
    .join('');
}

function renderNode(node: XmlNode, depth: number): string {
  const indent = '  '.repeat(depth);
  const open = `${node.name}${renderAttributes(node.attributes)}`;
  if ('text' in node) {
    return node.text === '' ? '' : `${indent}<${open}>${escapeXml(node.text)}</${node.name}>\n`;
  }
  const inner = node.children.map((child) => (child === undefined ? '' : renderNode(child, depth + 1))).join('');
  return inner === '' ? '' : `${indent}<${open}>\n${inner}${indent}</${node.name}>\n`;
}

/**
 * Renders a tree as an XML document.
 *
 * @param root The root element.
 * @returns The document: UTF-8 declaration, then the indented tree, ending with a line feed.
 * @throws Error When the whole tree is empty, or a text has a character XML cannot represent.
 */
export function writeXml(root: XmlNode): string {
  const body = renderNode(root, 0);
  if (body === '') {
    throw new Error('The document is empty');
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n${body}`;
}

/**
 * Builds a text element, or nothing when the value is absent or empty.
 *
 * @param name Element name.
 * @param value Text, or `undefined`.
 * @returns The node, or `undefined`.
 */
export function textElement(name: string, value: string | undefined): XmlTextNode | undefined {
  return value === undefined || value === '' ? undefined : { name, text: value };
}

/**
 * Builds a parent element.
 *
 * @param name Element name.
 * @param children Children, in schema order; `undefined` entries are skipped.
 * @returns The node (it renders to nothing when no child renders).
 */
export function parentElement(name: string, ...children: readonly (XmlNode | undefined)[]): XmlParentNode {
  return { name, children };
}
