import { listQueryShape } from '../../shared/http/list.ts';
import { integerString, object, objectId, optional, refine, string } from '../../shared/validation/schema.ts';
import type { Infer, Schema } from '../../shared/validation/schema.ts';
import { EMAIL_TEMPLATES_LIST, MAX_EMAIL_TEMPLATES_PAGE } from './email-templates.list.ts';

/** Longest name of a template, in characters. */
export const MAX_TEMPLATE_NAME = 150;

/** Largest plain-text version of a template: 64 KB (UTF-8 bytes). */
export const MAX_TEMPLATE_TEXT_BYTES = 64 * 1024;

/** Largest HTML of a template: 256 KB (UTF-8 bytes). The HTML is stored as sent (it is not sanitised by the server: it is only ever shown isolated, and it is the content of an e-mail). */
export const MAX_TEMPLATE_HTML_BYTES = 256 * 1024;

/**
 * Body limit of the writes: the text and the HTML are bounded in bytes by the schema, but a body is measured before it is parsed and a character takes up to three bytes and a control
 * character two when escaped in JSON, so the limit leaves room for the largest valid template.
 */
export const EMAIL_TEMPLATES_BODY_LIMIT = '2mb';

/** Characters a field may not hold: NUL and the other control characters, except tab, carriage return and line feed. */
const FORBIDDEN_IN_BODY = /^[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]*$/;

/** Control characters of any kind are refused in a name. */
const FORBIDDEN_IN_NAME = /^[^\u0000-\u001F\u007F]+$/;

/** A text of at most `bytes` UTF-8 bytes (and no more characters than bytes), kept exactly as sent. */
function bounded(bytes: number): Schema<string, false> {
  return refine(string({ max: bytes, normalize: false, pattern: FORBIDDEN_IN_BODY }), (value) => (Buffer.byteLength(value) > bytes ? [''] : []), 'maxLength');
}

const name = () => string({ min: 1, max: MAX_TEMPLATE_NAME, trim: true, pattern: FORBIDDEN_IN_NAME });

/**
 * Body of `POST /v1/groups/{groupId}/email-templates`: the name, and the text and the HTML (empty when left out). Nothing else is accepted.
 */
export const createTemplateBody = object({ name: name(), text: optional(bounded(MAX_TEMPLATE_TEXT_BYTES)), html: optional(bounded(MAX_TEMPLATE_HTML_BYTES)) });

/** Validated body of a creation. */
export type CreateTemplateBody = Infer<typeof createTemplateBody>;

/** Body of `PATCH /v1/groups/{groupId}/email-templates/{templateId}`: any of the three fields, at least one (`required` on the body otherwise). */
export const patchTemplateBody = refine(
  object({ name: optional(name()), text: optional(bounded(MAX_TEMPLATE_TEXT_BYTES)), html: optional(bounded(MAX_TEMPLATE_HTML_BYTES)) }),
  (value) => (Object.keys(value).length === 0 ? [''] : []),
  'required',
);

/** Validated body of a modification. */
export type PatchTemplateBody = Infer<typeof patchTemplateBody>;

/** Path parameters of the routes on one template; the group was already verified by the route. */
export const templateParams = object({ templateId: objectId() }, { allowUnknown: true });

/** Query of the list: the standard list parameters, with a page of at most {@link MAX_EMAIL_TEMPLATES_PAGE}. */
export const templatesQuery = object({ ...listQueryShape(EMAIL_TEMPLATES_LIST), limit: optional(integerString({ min: 1, max: MAX_EMAIL_TEMPLATES_PAGE })) });

/** Validated query of the list. */
export type TemplatesQuery = Infer<typeof templatesQuery>;
