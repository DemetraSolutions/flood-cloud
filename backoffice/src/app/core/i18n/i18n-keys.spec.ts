import { readdirSync, readFileSync } from 'node:fs';
import { API_ERROR_CODES, CLIENT_ERROR_CODES } from '../api/api.types';
import { flattenDictionary } from './dictionary';
import { SUPPORTED_LANGUAGES } from './language';

const ROOT = `${process.cwd()}`;

function files(dir: string, extension: string): { path: string; content: string }[] {
  return readdirSync(`${ROOT}/${dir}`, { withFileTypes: true, recursive: true })
    .filter(
      (entry) =>
        entry.isFile() && entry.name.endsWith(extension) && !entry.name.endsWith('.spec.ts'),
    )
    .map((entry) => {
      const path = `${entry.parentPath}/${entry.name}`;
      return { path, content: readFileSync(path, 'utf8') };
    });
}

function dictionary(language: string): ReadonlyMap<string, string> {
  return flattenDictionary(
    JSON.parse(readFileSync(`${ROOT}/public/i18n/${language}.json`, 'utf8')),
  );
}

const sources = [...files('src/app', '.ts'), ...files('src/app', '.html')];

function usedKeys(): { path: string; key: string }[] {
  const patterns = [/'([A-Z][A-Z0-9_.]*)'\s*\|\s*t\b/g, /\bt\(\s*'([A-Z][A-Z0-9_.]*)'/g];
  return sources.flatMap(({ path, content }) =>
    patterns.flatMap((pattern) => [...content.matchAll(pattern)].map((m) => ({ path, key: m[1] }))),
  );
}

describe('dictionaries', () => {
  it('scans some sources (guards against a broken scan)', () => {
    expect(sources.length).toBeGreaterThan(5);
    expect(usedKeys().length).toBeGreaterThan(0);
  });

  it.each([...SUPPORTED_LANGUAGES])(
    '%s defines every key used in templates and code',
    (language) => {
      const keys = dictionary(language);
      const missing = usedKeys().filter(({ key }) => !keys.has(key));
      expect(missing).toEqual([]);
    },
  );

  it('all supported dictionaries have the same set of keys', () => {
    const [first, ...others] = SUPPORTED_LANGUAGES;
    const reference = [...dictionary(first).keys()].sort();
    for (const language of others) {
      expect([...dictionary(language).keys()].sort()).toEqual(reference);
    }
  });

  it('defines a user message for every API and client error code', () => {
    for (const language of SUPPORTED_LANGUAGES) {
      const keys = dictionary(language);
      for (const code of [...API_ERROR_CODES, ...CLIENT_ERROR_CODES]) {
        expect(keys.has(`ERRORS.API.${code}`)).toBe(true);
      }
    }
  });
});

/**
 * Visible text in templates must come from the dictionary. Text outside interpolations is only
 * allowed for the listed (path, text) exceptions, each with its justification.
 */
const HARD_WIRED_TEXT_EXCEPTIONS: { path: string; text: string; reason: string }[] = [];

describe('templates', () => {
  it('contain no hard-wired visible text outside interpolations', () => {
    const offenders: string[] = [];
    for (const { path, content } of sources.filter((s) => s.path.endsWith('.html'))) {
      const stripped = content
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\{\{[\s\S]*?\}\}/g, '')
        .replace(
          /@(if|else if|for|switch|case|default|empty|defer|placeholder|loading|error)\b[^{]*\{/g,
          '',
        )
        .replace(/@else\s*\{/g, '')
        .replace(/@let\s[^;]*;/g, '');
      for (const [, text] of stripped.matchAll(/>([^<>]+)</g)) {
        const trimmed = text.replace(/[{}]/g, '').trim();
        const allowed = HARD_WIRED_TEXT_EXCEPTIONS.some(
          (e) => path.endsWith(e.path) && e.text === trimmed,
        );
        if (trimmed !== '' && !allowed) {
          offenders.push(`${path}: ${trimmed}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
