/** An e-mail template as the list shows it: the content is never part of the list. */
export interface EmailTemplateSummary {
  readonly id: string;
  readonly name: string;
  /** Last change, ISO 8601, or `null` when the document has no valid date. */
  readonly updatedAt: string | null;
}

/** An e-mail template with its content. */
export interface EmailTemplateRecord extends EmailTemplateSummary {
  /** The plain-text version. */
  readonly text: string;
  /** The HTML as saved: it is shown only isolated in the preview, never inserted in the page. */
  readonly html: string;
  readonly createdAt: string | null;
}

/** Body of a creation or of a modification. */
export interface EmailTemplateBody {
  name?: string;
  text?: string;
  html?: string;
}

/** A template with the version (`ETag`) the next write must present in `If-Match`. */
export interface VersionedTemplate {
  readonly template: EmailTemplateRecord;
  readonly etag: string | null;
}

/** Limits of the server (`doc/API.md`): the name in characters, the text and the HTML in UTF-8 bytes. */
export const TEMPLATE_LIMITS = Object.freeze({
  name: 150,
  textBytes: 64 * 1024,
  htmlBytes: 256 * 1024,
});

/** NUL and the control characters the server refuses (tab, carriage return and line feed are accepted). */
const BODY_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** Every control character, refused in a name. */
const NAME_CONTROL = /[\u0000-\u001F\u007F]/;

/** Size of a text in UTF-8 bytes. */
export function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** Whether a text holds a character the server refuses in the text and in the HTML. */
export function hasBodyControl(value: string): boolean {
  return BODY_CONTROL.test(value);
}

/** Whether a name holds a control character. */
export function hasNameControl(value: string): boolean {
  return NAME_CONTROL.test(value);
}

/**
 * Router link of the list of the templates of a group, or of one template (`null` for a new one).
 *
 * @param groupId Group of the templates.
 * @param templateId The template, `null` for the page of a new one.
 */
export function templateRoute(groupId: string, templateId?: string | null): string[] {
  const base = ['/groups', groupId, 'email-templates'];
  return templateId === undefined ? base : [...base, templateId === null ? 'new' : templateId];
}
