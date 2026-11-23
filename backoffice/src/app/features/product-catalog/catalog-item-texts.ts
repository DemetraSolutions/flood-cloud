import { CATALOG_LIMITS, hasDescriptionControl, hasNameControl } from './product-catalog.types';

/** A problem of one text of the form: the part, the language and the issue (the names of the backend). */
export interface TextIssue {
  readonly part: 'name' | 'description';
  readonly language: string;
  readonly issue: 'required' | 'maxLength' | 'pattern';
}

/**
 * The problems of the texts of a department or brand, as the server would find them: the name
 * must have a text, in the required language when the entry has to (a new one, or one that
 * already had it); no text is longer than its limit or holds a control character.
 *
 * @param name The names by language of the form.
 * @param description The descriptions by language of the form.
 * @param required The language the name must be given in.
 * @param mustHaveRequired Whether that language is required (it is not for an old entry that never had it).
 */
export function textIssues(
  name: Readonly<Record<string, string>>,
  description: Readonly<Record<string, string>>,
  required: string,
  mustHaveRequired: boolean,
): TextIssue[] {
  const issues: TextIssue[] = [];
  const texts = Object.entries(name).map(([language, text]) => [language, text.trim()] as const);
  const anyName = texts.some(([, text]) => text !== '');
  for (const [language, text] of texts) {
    if (text === '' && language === required && (mustHaveRequired || !anyName)) {
      issues.push({ part: 'name', language, issue: 'required' });
    } else if (text.length > CATALOG_LIMITS.name) {
      issues.push({ part: 'name', language, issue: 'maxLength' });
    } else if (hasNameControl(text)) {
      issues.push({ part: 'name', language, issue: 'pattern' });
    }
  }
  for (const [language, raw] of Object.entries(description)) {
    const text = raw.trim();
    if (text.length > CATALOG_LIMITS.description) {
      issues.push({ part: 'description', language, issue: 'maxLength' });
    } else if (hasDescriptionControl(text)) {
      issues.push({ part: 'description', language, issue: 'pattern' });
    }
  }
  return issues;
}
