import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { API_PREFIXES, HEALTH_PREFIX } from '../../src/shared/http/surfaces.ts';

// The public exposure on GKE (backend/k8s/httproute.yaml) and the surfaces mounted by createApp
// must stay aligned: a prefix mounted but not routed is unreachable, a prefix routed but not
// mounted (or the health probes) is exposed by mistake.

const SRC = fileURLToPath(new URL('../../src', import.meta.url));
const APP = join(SRC, 'app.ts');
const HTTP_ROUTE = fileURLToPath(new URL('../../k8s/httproute.yaml', import.meta.url));
const FIX = 'align src/shared/http/surfaces.ts, src/app.ts and backend/k8s/httproute.yaml';

/** Every `.ts` file under a directory, recursively. */
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory() ? filesUnder(join(dir, entry.name)) : Promise.resolve(entry.name.endsWith('.ts') ? [join(dir, entry.name)] : []),
    ),
  );
  return nested.flat();
}

/**
 * The path matches of the HTTPRoute, as `{ type, value }`: the manifest is plain YAML written by
 * us, so the `path:` blocks are read line by line (a `type:` followed by a `value:`).
 */
function routeMatches(yaml: string): { type: string; value: string }[] {
  const lines = yaml.split('\n').map((line) => line.replace(/#.*$/, '').trim());
  const matches: { type: string; value: string }[] = [];
  lines.forEach((line, index) => {
    if (line !== '- path:' && line !== 'path:') {
      return;
    }
    const type = /^type:\s*(\S+)$/.exec(lines[index + 1] ?? '')?.[1];
    const value = /^value:\s*(\S+)$/.exec(lines[index + 2] ?? '')?.[1];
    assert.ok(type !== undefined && value !== undefined, `unexpected path block in httproute.yaml at line ${index + 1}`);
    matches.push({ type, value });
  });
  return matches;
}

describe('public exposure of the HTTP surfaces', () => {
  it('the HTTPRoute exposes exactly the API prefixes, and never the health probes', async () => {
    const matches = routeMatches(await readFile(HTTP_ROUTE, 'utf8'));
    assert.ok(matches.length > 0, 'no path match found in httproute.yaml');
    for (const match of matches) {
      assert.equal(match.type, 'PathPrefix', `httproute.yaml: only PathPrefix matches are expected (${match.value})`);
      assert.ok(match.value !== '/', `httproute.yaml must not expose "/": it would expose ${HEALTH_PREFIX} too`);
      assert.ok(!match.value.startsWith(HEALTH_PREFIX), `httproute.yaml must not expose ${HEALTH_PREFIX}`);
    }
    assert.deepEqual(
      matches.map((match) => match.value).sort(),
      Object.values(API_PREFIXES).sort(),
      `the prefixes of httproute.yaml differ from API_PREFIXES: ${FIX}`,
    );
  });

  it('createApp mounts only the declared prefixes, never a literal path', async () => {
    const text = await readFile(APP, 'utf8');
    const mounts = [...text.matchAll(/\bapp\.use\(\s*([^,()]+?)\s*[,)]/g)].map((match) => match[1]!);
    for (const first of mounts) {
      assert.doesNotMatch(first, /^['"`]/, `app.ts mounts the literal path ${first}: declare it in surfaces.ts (${FIX})`);
    }
    const declared = mounts.filter((first) => /^(API_PREFIXES\.\w+|HEALTH_PREFIX)$/.test(first));
    assert.deepEqual(
      declared.sort(),
      [...Object.keys(API_PREFIXES).map((key) => `API_PREFIXES.${key}`), 'HEALTH_PREFIX'].sort(),
      `every surface must be mounted exactly once: ${FIX}`,
    );
    assert.doesNotMatch(text, /\bapp\.(get|post|put|patch|delete|all|route|head|options)\(/, 'routes are mounted on surface routers, never on the app');
  });

  it('only app.ts creates the Express application', async () => {
    const creators: string[] = [];
    for (const file of await filesUnder(SRC)) {
      if (/\bexpress\(\)/.test(await readFile(file, 'utf8'))) {
        creators.push(relative(SRC, file).split('\\').join('/'));
      }
    }
    assert.deepEqual(creators, ['app.ts'], 'another Express application would bypass the declared surfaces');
  });
});
