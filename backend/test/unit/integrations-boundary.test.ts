import { readdir, readFile } from 'node:fs/promises';
import { join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const SRC = join(fileURLToPath(new URL('../../src', import.meta.url)));

/** Every `.ts` file under a directory, recursively, as an absolute path. */
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => (entry.isDirectory() ? filesUnder(join(dir, entry.name)) : Promise.resolve(entry.name.endsWith('.ts') ? [join(dir, entry.name)] : []))));
  return nested.flat();
}

/** Every `.ts` file of `src/` as a path relative to it, with forward slashes. */
async function sourcesUnder(dir: string): Promise<string[]> {
  return (await filesUnder(dir)).map((file) => relative(dir, file).split('\\').join('/'));
}

/** The text of a source without its comments (a `//` after a non-space, as in `https://`, is not one). */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

/** The module specifiers a source imports or re-exports, statically or with `import()`. */
export function specifiersOf(source: string): string[] {
  const text = withoutComments(source);
  const found: string[] = [];
  for (const pattern of [/(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?[^'";]*?from\s*['"]([^'"]+)['"]/g, /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g, /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g]) {
    for (const match of text.matchAll(pattern)) {
      found.push(match[1]!);
    }
  }
  return found;
}

/** What a specifier of the file `from` (relative to `src/`) points at: a path under `src/` for a relative one, the bare name for a package. */
export function resolveSpecifier(from: string, specifier: string): string {
  return specifier.startsWith('.') ? posix.normalize(posix.join(posix.dirname(from), specifier)) : specifier;
}

/**
 * The violations of the boundary of the integrations module in a set of sources (path relative to `src/` mapped to its text):
 * only the composition root and the module itself touch `integrations/`, and the module reaches into the core only through `shared/` (and the ports it is given).
 */
export function boundaryViolations(sources: ReadonlyMap<string, string>): string[] {
  const violations: string[] = [];
  for (const [path, source] of sources) {
    const inModule = path.startsWith('integrations/');
    for (const specifier of specifiersOf(source)) {
      const target = resolveSpecifier(path, specifier);
      if (!inModule && target.startsWith('integrations/') && !(path === 'composition.ts' && target === 'integrations/index.ts')) {
        violations.push(`${path} imports ${specifier}: only composition.ts, and only the entry point integrations/index.ts, may`);
      }
      if (inModule && (/^(?:modules|db|infrastructure|tools)\//.test(target) || ['app.ts', 'server.ts'].includes(target) || /^mongodb(?:\/|$)/.test(target))) {
        violations.push(`${path} imports ${specifier}: the integrations module may not reach there`);
      }
    }
    if (inModule && /\bprocess\.env\b/.test(withoutComments(source))) {
      violations.push(`${path} reads process.env: the configuration reaches the module from the core`);
    }
  }
  return violations;
}

describe('the boundary of the integrations module', () => {
  it('is respected by every source of the backend', async () => {
    const sources = new Map<string, string>();
    for (const path of await sourcesUnder(SRC)) {
      sources.set(path, await readFile(join(SRC, path), 'utf8'));
    }
    assert.ok(sources.size > 100);
    assert.ok([...sources.keys()].some((path) => path.startsWith('integrations/cerved/')) && sources.has('integrations/index.ts') && sources.has('integrations/http/http-client.ts'));
    assert.ok(specifiersOf(sources.get('composition.ts')!).includes('./integrations/index.ts'), 'the composition root is the one that plugs the module in');
    assert.deepEqual(boundaryViolations(sources), []);
  });

  it('puts the object storage outside of the module, as infrastructure of the core', async () => {
    const paths = await sourcesUnder(SRC);
    assert.ok(paths.some((path) => path.startsWith('infrastructure/gcs/')));
    assert.ok(!paths.some((path) => path.startsWith('integrations/gcs/')));
  });

  it('notices a violation: it is not green by being blind', () => {
    const cases: Array<[string, string, number]> = [
      ['modules/places/places.service.ts', "import { createCervedClient } from '../../integrations/cerved/index.ts';", 1],
      ['shared/http/routes.ts', "export { x } from '../../integrations/index.ts';", 1],
      ['db/collections.ts', "const module = await import('../integrations/http/index.ts');", 1],
      ['server.ts', "import './integrations/index.ts';", 1],
      ['composition.ts', "import { x } from './integrations/cerved/index.ts';", 1],
      ['composition.ts', "import { createIntegrations } from './integrations/index.ts';", 0],
      ['integrations/cerved/a.ts', "import type { Db } from 'mongodb';", 1],
      ['integrations/cerved/a.ts', "import { x } from '../../modules/places/places.service.ts';", 1],
      ['integrations/cerved/a.ts', "import { x } from '../../db/databases.ts';", 1],
      ['integrations/cerved/a.ts', "import {\n  x,\n} from '../../infrastructure/gcs/index.ts';", 1],
      ['integrations/cerved/a.ts', "import { x } from '../../server.ts';", 1],
      ['integrations/cerved/a.ts', 'const key = process.env.CERVED_API_KEY;', 1],
      ['integrations/cerved/a.ts', "import { x } from '../../shared/http/routes.ts';\nimport { y } from '../http/index.ts';\nimport { z } from 'node:crypto';", 0],
      ['modules/places/a.ts', "// import { x } from '../../integrations/index.ts';\n/* import { y } from '../../integrations/index.ts'; */", 0],
      ['integrations/a.ts', '// process.env is not read here', 0],
    ];
    for (const [path, source, expected] of cases) {
      assert.equal(boundaryViolations(new Map([[path, source]])).length, expected, `${path}: ${source}`);
    }
  });

  it('reads every form of import', () => {
    const source = "import a from './a.ts';\nimport type { B } from './b.ts';\nexport * from './c.ts';\nexport { d } from './d.ts';\nimport './e.ts';\nconst f = await import('./f.ts');\nconst url = 'https://x.example';";
    assert.deepEqual(specifiersOf(source).sort(), ['./a.ts', './b.ts', './c.ts', './d.ts', './e.ts', './f.ts']);
    assert.equal(resolveSpecifier('shared/http/a.ts', '../../integrations/x.ts'), 'integrations/x.ts');
    assert.equal(resolveSpecifier('a.ts', 'mongodb'), 'mongodb');
  });
});
