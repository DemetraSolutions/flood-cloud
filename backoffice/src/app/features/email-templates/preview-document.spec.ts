import { readdirSync, readFileSync } from 'node:fs';
import { PREVIEW_MESSAGE, PREVIEW_URL } from './preview-message';

const ROOT = process.cwd();

function sources(dir: string): { path: string; content: string }[] {
  return readdirSync(`${ROOT}/${dir}`, { withFileTypes: true, recursive: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        (entry.name.endsWith('.ts') || entry.name.endsWith('.html')) &&
        !entry.name.endsWith('.spec.ts'),
    )
    .map((entry) => {
      const path = `${entry.parentPath}/${entry.name}`;
      return { path, content: readFileSync(path, 'utf8') };
    });
}

describe('the backoffice never puts HTML in the page', () => {
  const all = [...sources('src/app'), ...sources('src/testing')];

  it('scans the sources (guards against a broken scan)', () => {
    expect(all.length).toBeGreaterThan(50);
  });

  it('declares nothing trusted: no bypassSecurityTrust* anywhere', () => {
    expect(
      all.filter(({ content }) => /bypassSecurityTrust/.test(content)).map(({ path }) => path),
    ).toEqual([]);
  });

  it('never uses innerHTML, outerHTML, insertAdjacentHTML, document.write or srcdoc', () => {
    const found = all.filter(({ content }) =>
      /\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML|document\.write\(|srcdoc/.test(content),
    );
    expect(found.map(({ path }) => path.slice(ROOT.length))).toEqual([]);
  });

  it('opens the preview only as the sandboxed document of its own, without allow-same-origin', () => {
    const frames = all.flatMap(({ path, content }) =>
      [...content.matchAll(/<iframe[\s\S]*?>/g)].map((match) => ({ path, tag: match[0] })),
    );
    expect(frames).toHaveLength(1);
    const { tag } = frames[0]!;
    expect(tag).toContain('sandbox="allow-scripts"');
    expect(tag).not.toMatch(/allow-same-origin|allow-top-navigation|allow-popups|allow-forms/);
    expect(tag).toContain(`src="${PREVIEW_URL}"`);
    expect(tag).toContain('referrerpolicy="no-referrer"');
  });

  it('names the message and the document the preview file expects', () => {
    const script = readFileSync(`${ROOT}/public/email-preview.js`, 'utf8');
    const page = readFileSync(`${ROOT}/public/email-preview.html`, 'utf8');
    expect(script).toContain(`var TYPE = '${PREVIEW_MESSAGE}'`);
    expect(page).toContain('<script src="/email-preview.js" defer></script>');
    expect(PREVIEW_URL).toBe('/email-preview.html');
  });
});
