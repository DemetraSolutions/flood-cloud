import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { MongoClient } from 'mongodb';
import { createDatabases } from '../../src/db/databases.ts';
import { isPublicPermission } from '../../src/shared/security/rbac/public-permissions.ts';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));

/** Whether a source text imports or re-exports a symbol of a module (by base name): a named import or export, a default or namespace import, `export *`, or a dynamic `import()` of the module. */
function reaches(text: string, base: string, symbol: string): boolean {
  const from = `from\\s*['"][^'"]*/${base}\\.ts['"]`;
  const statements = [...text.matchAll(new RegExp(`(?:import|export)\\s+(?:type\\s+)?([^;'"]*?)\\s*${from}`, 'g'))];
  const named = statements.some((match) => !/^\{[^}]*\}$/.test(match[1]!) || new RegExp(`\\b${symbol}\\b`).test(match[1]!));
  return named || new RegExp(`import\\(\\s*['"][^'"]*/${base}\\.ts['"]`).test(text);
}

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

const PLACES_READ = 'shared/security/scope/group-places.ts';
const MIRROR_FILE = 'shared/security/scope/group-mirror.ts';

describe('database access cannot be bypassed outside src/db', () => {
  const forbidden = ['.db(', 'new Db(', "['db']", '["db"]', '.admin(', '.client.', '$out', '$merge', 'renameCollection'];
  const mayCreateDatabases = (file: string): boolean => {
    const path = relative(SRC, file).split('\\').join('/');
    return path === 'server.ts' || /^tools\/[^/]+\/main\.ts$/.test(path);
  };

  it('uses no raw database selector, admin handle, client back-reference or pipeline output outside src/db', async () => {
    const files = (await filesUnder(SRC)).filter((file) => !relative(SRC, file).startsWith(`db${'/'}`));
    assert.ok(files.length > 10);
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      for (const word of forbidden) {
        assert.ok(!text.includes(word), `${relative(SRC, file)} contains "${word}"`);
      }
    }
  });

  it('calls createDatabases only from the server and from tool entry points', async () => {
    const callers: string[] = [];
    for (const file of await filesUnder(SRC)) {
      const path = relative(SRC, file);
      if (path.startsWith(`db${'/'}`)) {
        continue;
      }
      if ((await readFile(file, 'utf8')).includes('createDatabases(')) {
        callers.push(path);
        assert.ok(mayCreateDatabases(file), `${path} must not call createDatabases`);
      }
    }
    assert.deepEqual(callers.sort(), ['server.ts', 'tools/migrate-dealers/main.ts', 'tools/profile-legacy/main.ts', 'tools/purge-trashed-groups/main.ts', 'tools/sync-copies/main.ts']);
  });

  it('creates the cluster clients only from the server and from tool entry points', async () => {
    const callers: string[] = [];
    for (const file of await filesUnder(SRC)) {
      const path = relative(SRC, file).split('\\').join('/');
      if (path.startsWith('db/')) {
        continue;
      }
      const text = await readFile(file, 'utf8');
      if (text.includes('createClusterClients') || text.includes('createMongoClient') || text.includes('new MongoClient(')) {
        callers.push(path);
        assert.ok(mayCreateDatabases(file), `${path} must not create database clients`);
      }
    }
    assert.deepEqual(callers.sort(), ['server.ts', 'tools/migrate-dealers/main.ts', 'tools/profile-legacy/main.ts', 'tools/purge-trashed-groups/main.ts', 'tools/sync-copies/main.ts']);
  });

  it('keeps the analytics handles unused outside src/db until a report needs them', async () => {
    for (const file of await filesUnder(SRC)) {
      const path = relative(SRC, file).split('\\').join('/');
      if (!path.startsWith('db/')) {
        const text = await readFile(file, 'utf8');
        assert.ok(!text.includes('analyticsGroup(') && !text.includes('analyticsCommon('), `${path} must not use the analytics handles yet`);
      }
    }
  });

  it('issues group accesses only inside group-access.ts', async () => {
    for (const file of await filesUnder(SRC)) {
      const path = relative(SRC, file).split('\\').join('/');
      if (path !== 'shared/security/scope/group-access.ts') {
        const text = await readFile(file, 'utf8');
        assert.ok(!text.includes('resolveGroupAccess(') && !text.includes('issueGroupAccess('), `${path} must not issue group accesses`);
      }
    }
    const own = await readFile(join(SRC, 'shared/security/scope/group-access.ts'), 'utf8');
    assert.ok(own.includes('issueGroupAccess(') && !own.includes('export function issueGroupAccess') && !own.includes('export function resolveGroupAccess'));
  });

  it('imports groupAccessFor only in the port of the places integrations, and the check detects an import elsewhere', async () => {
    const importers: string[] = [];
    for (const file of await filesUnder(SRC)) {
      const path = relative(SRC, file).split('\\').join('/');
      if (path !== 'shared/security/scope/group-access.ts' && reaches(await readFile(file, 'utf8'), 'group-access', 'groupAccessFor')) {
        importers.push(path);
      }
    }
    assert.deepEqual(importers, ['modules/places/place-integrations.port.ts']);
    assert.ok(reaches("import { groupAccessFor } from '../../shared/security/scope/group-access.ts';", 'group-access', 'groupAccessFor'));
    assert.ok(reaches("export * from './group-access.ts';", 'group-access', 'groupAccessFor'));
    assert.ok(!reaches("import { requireGroupAccess } from './group-access.ts';", 'group-access', 'groupAccessFor'));
  });

  it('uses the bulk group access only on the routes of the trash', async () => {
    for (const file of await filesUnder(SRC)) {
      const path = relative(SRC, file).split('\\').join('/');
      if (path !== 'shared/security/scope/group-access.ts' && path !== 'modules/trash/trash.routes.ts') {
        assert.ok(!(await readFile(file, 'utf8')).includes('requireGroupAccesses'), `${path} must not use requireGroupAccesses`);
      }
    }
    assert.ok((await readFile(join(SRC, 'modules/trash/trash.routes.ts'), 'utf8')).includes('requireGroupAccesses('));
  });

  it('drops the collections of a group database only through the purger of src/db, which only the purge tool imports (the bare names are forbidden everywhere else, aliases included)', async () => {
    const importers: string[] = [];
    for (const file of await filesUnder(SRC)) {
      const path = relative(SRC, file).split('\\').join('/');
      const text = await readFile(file, 'utf8');
      if (!path.startsWith('db/') && !path.startsWith('tools/purge-trashed-groups/')) {
        assert.ok(!/dropCollection|\.drop\(|dropDatabase/.test(text), `${path} must not drop collections or databases`);
        assert.ok(!/GroupDatabasePurger|dropGroupDatabase|describeGroupDatabase|group-database-purger/.test(text), `${path} must not reach the group database purger`);
      }
      if (/createGroupDatabasePurger/.test(text) && !path.startsWith('db/')) {
        importers.push(path);
      }
    }
    assert.deepEqual(importers, ['tools/purge-trashed-groups/main.ts']);
    const databases = await readFile(join(SRC, 'db/databases.ts'), 'utf8');
    assert.ok(!/dropCollection|dropGroup|describeGroup|assertPurgeable|GroupDatabasePurger/.test(databases), 'the Databases interface of the server carries no destructive group operation');
  });

  it('opens a group database only from the verified group access and the tools (always with an explicit cluster)', async () => {
    const callers: string[] = [];
    for (const file of await filesUnder(SRC)) {
      const path = relative(SRC, file).split('\\').join('/');
      if (path.startsWith('db/')) {
        continue;
      }
      if (/\.group\(/.test(await readFile(file, 'utf8'))) {
        callers.push(path);
        assert.ok(path === 'shared/security/scope/group-access.ts' || path.startsWith('tools/'), `${path} must not open a group database`);
      }
    }
    assert.ok(callers.includes('shared/security/scope/group-access.ts'));
  });

  describe('companies and places', () => {
    const MIRROR = 'shared/security/scope/group-mirror.ts';
    // The write service of companies and places (doc/Tasks.md 5.6): the only other file that names the collections, the originals and their copies together.
    const WRITER = 'shared/legacy-write/companies-places.writer.ts';
    const posix = (file: string): string => relative(SRC, file).split('\\').join('/');

    it('reads the copies in common.companies and common.places only through group-mirror.ts', async () => {
      let seen = false;
      for (const file of await filesUnder(SRC)) {
        const path = posix(file);
        if (path.startsWith('db/') || path.startsWith('tools/') || path === WRITER || path === PLACES_READ) {
          // The tools read the originals in the group databases; only sync-copies may touch the copies (checked below); the writer is checked in its own test; the one read of the places of the rule of the group with one place is checked by its own test.
          continue;
        }
        const names = [...(await readFile(file, 'utf8')).matchAll(/\.collection(?:<[^>]*>)?\(\s*['"`](companies|places)['"`]/g)].map((match) => match[0]);
        if (path === MIRROR) {
          seen = names.length > 0;
        } else {
          assert.deepEqual(names, [], `${path} reads companies or places directly`);
        }
      }
      assert.ok(seen, 'group-mirror.ts is expected to be the single place');
    });

    it('has no file outside group-mirror.ts, src/db, tools/sync-copies and tools/purge-trashed-groups that names the common database and a copy collection', async () => {
      for (const file of await filesUnder(SRC)) {
        const path = posix(file);
        if (path === MIRROR || path === WRITER || path.startsWith('db/') || path.startsWith('tools/sync-copies/') || path.startsWith('tools/purge-trashed-groups/')) {
          continue;
        }
        const text = await readFile(file, 'utf8');
        const literal = /\.collection(?:<[^>]*>)?\(\s*['"`](companies|places)['"`]/.test(text);
        assert.ok(!(text.includes('common()') && literal), `${path} touches the copies through the common database`);
      }
    });

    it('imports the multi-group reads of the diagnostics only in the diagnostics repository', async () => {
      const importers: string[] = [];
      for (const file of await filesUnder(SRC)) {
        const path = posix(file);
        if (path !== MIRROR && /import\s*(?:type\s*)?\{[^}]*\b(readMirrorDevices|countMirrorDevices|trashedCompanyIds)\b[^}]*\}\s*from\s*'[^']*group-mirror\.ts'/.test(await readFile(file, 'utf8'))) {
          importers.push(path);
        }
      }
      assert.deepEqual(importers, ['modules/diagnostics/diagnostics.repository.ts']);
    });

    it('never reads companies or places from a group database outside the tools', async () => {
      for (const file of await filesUnder(SRC)) {
        const path = posix(file);
        if (path.startsWith('tools/') || path.startsWith('db/')) {
          continue;
        }
        const text = await readFile(file, 'utf8');
        assert.ok(!/groupDatabaseFor\([^;]*\)\s*\.collection(?:<[^>]*>)?\(\s*['"`](companies|places)['"`]/.test(text), `${path} reads companies or places from a group database`);
        assert.ok(!/\.group\([^;]*\)\s*\.collection(?:<[^>]*>)?\(\s*['"`](companies|places)['"`]/.test(text), `${path} reads companies or places from a group database`);
      }
    });

    it('opens the places of a group database in one place only: the read of the rule of the group with one place', async () => {
      const importers: string[] = [];
      const readers: string[] = [];
      for (const file of await filesUnder(SRC)) {
        const path = posix(file);
        const text = await readFile(file, 'utf8');
        if (path !== PLACES_READ && /import\s*(?:type\s*)?\{[^}]*\bactiveGroupPlaceIds\b[^}]*\}\s*from\s*'[^']*group-places\.ts'/.test(text)) {
          importers.push(path);
        }
        if (/groupDatabaseFor\([^;]*\);[^]*?\bdb\.collection\(\s*['"`]places['"`]\)/.test(text)) {
          readers.push(path);
        }
      }
      assert.deepEqual(importers, ['modules/product-catalog/availability.ts']);
      assert.deepEqual(readers, [PLACES_READ]);
    });

    it('imports the reads of the places that the categories refer to (print stations, production centers, uses of a category) only in the categories places module (step C2)', async () => {
      const importers: string[] = [];
      for (const file of await filesUnder(SRC)) {
        const path = posix(file);
        if (path !== MIRROR && /import\s*(?:type\s*)?\{[^}]*\b(readPlaceSetups|findPlacesUsingCategory)\b[^}]*\}\s*from\s*'[^']*group-mirror\.ts'/.test(await readFile(file, 'utf8'))) {
          importers.push(path);
        }
      }
      assert.deepEqual(importers, ['modules/product-categories/categories.places.ts']);
    });

    it('imports the read of the places that use a template only in the templates repository, and the copies are never read for appointment or roomsSettings anywhere else', async () => {
      const importers: string[] = [];
      for (const file of await filesUnder(SRC)) {
        const path = posix(file);
        const text = await readFile(file, 'utf8');
        if (path !== MIRROR && /import\s*(?:type\s*)?\{[^}]*\bfindPlacesUsingTemplate\b[^}]*\}\s*from\s*'[^']*group-mirror\.ts'/.test(text)) {
          importers.push(path);
        }
      }
      assert.deepEqual(importers, ['modules/email-templates/email-templates.repository.ts']);
      const mirror = await readFile(join(SRC, MIRROR), 'utf8');
      const fields = mirror.slice(mirror.indexOf('export const MIRROR_FIELDS'), mirror.indexOf('export const MIRROR_LEAVES'));
      assert.match(fields, /places: new Set\(\[[^\]]*\]\)/);
      assert.ok(!/places: new Set\(\[[^\]]*(?:appointment|roomsSettings)/.test(fields));
    });

    it('exposes from group-mirror.ts only the two per-group openers, the fixed count of the page groups, the cross-group list of the copies, the three fixed reads of the diagnostics and the fixed read of the places that use a template, the two fixed reads of the places the categories refer to (step C2) and the fixed read of the companies and places that use a country', async () => {
      const text = await readFile(join(SRC, MIRROR), 'utf8');
      const exported = [...text.matchAll(/^export (?:async )?function (\w+)/gm)].map((match) => match[1]);
      assert.deepEqual(exported, ['groupMirror', 'trustedGroupMirror', 'countMirrorByGroups', 'readMirrorList', 'readMirrorDevices', 'countMirrorDevices', 'trashedCompanyIds', 'readMirrorActivationPlaces', 'readMirrorActivationCompanies', 'findPlacesUsingTemplate', 'readPlaceSetups', 'readCatalogPlaces', 'findPlacesUsingCategory', 'readCountryUsage']);
      // The count builds its own pipeline from the fixed builder: no caller-supplied stage, and no other multi-group read.
      assert.equal([...text.matchAll(/countByGroupPipeline\(/g)].length, 1);
      // The diagnostics (T1) add two more, each running a pipeline made by `mirror-devices.ts` (the whole of what leaves the copies: an allowlist of the fields of a device).
      assert.equal([...text.matchAll(/deviceRowsPipeline\(|deviceCountPipeline\(/g)].length, 2);
      // The cross-group list of the companies and places adds a third one (`readMirrorList`), after the same checks as the per-group read.
      assert.equal([...text.matchAll(/\.aggregate\(/g)].length, 5);
    });

    /** The files (but the module itself) that import or re-export a symbol of a module. */
    const importersOf = async (symbol: string, module: string): Promise<string[]> => {
      const base = module.split('/').pop()!.replace(/\.ts$/, '');
      const found: string[] = [];
      for (const file of await filesUnder(SRC)) {
        if (posix(file) !== module && reaches(await readFile(file, 'utf8'), base, symbol)) {
          found.push(posix(file));
        }
      }
      return found;
    };

    it('lets only the services of the catalog workbook, of the advanced loyalty cards, of the workbooks of the contacts and of the cards and of the tobacco synchronization open a transaction on a group database and bind the repositories to its session', async () => {
      const SESSION = 'db/session-databases.ts';
      // The service of the advanced loyalty cards (step F1) is the third, by decision of the user of 2026-11-25: a card with its movements and its contacts, and an adjustment with its movements, are all-or-nothing.
      // The workbooks of the contacts and of the loyalty cards (step K3) are the fourth, by the same decision as the catalog's ("limiti e rapporto degli errori come l'import del catalogo", doc/Tasks.md §9-novies.2, 7): they share one engine, the one that opens the transaction.
      const allowed = ['modules/catalog-xlsx/catalog-xlsx.service.ts', 'modules/fidelity-cards/fidelity-cards.service.ts', 'modules/records-xlsx/records-xlsx.service.ts', 'modules/tobacco-sync/tobacco-sync.service.ts'];
      assert.deepEqual(await importersOf('sessionDatabases', SESSION), allowed);
      assert.deepEqual(await importersOf('inGroupTransaction', SESSION), allowed);
    });

    it('imports the cross-group list of the copies only in the scope layer, which builds the groups from the verified scope and never from the client', async () => {
      assert.deepEqual(await importersOf('readMirrorList', MIRROR), ['shared/security/scope/cross-group.ts']);
      const cross = await readFile(join(SRC, 'shared/security/scope/cross-group.ts'), 'utf8');
      // The groups come from the scope of the principal, and the check of the role comes first.
      assert.match(cross, /assertCrossGroupAccess\(principal, filters\);\n  const \{ scope \} = principal;/);
      assert.match(cross, /scope\.groupIds/);
    });

    it('lets only the two repositories read a cross-group page, each with its own constant projection, and nobody else resolve the groups', async () => {
      const CROSS = 'shared/security/scope/cross-group.ts';
      assert.deepEqual((await importersOf('readCrossGroupPage', CROSS)).sort(), ['modules/companies/companies.repository.ts', 'modules/places/places.repository.ts']);
      // The groups are resolved inside the scope layer by the reader itself: no module outside it imports `resolveCrossGroups`.
      assert.deepEqual(await importersOf('resolveCrossGroups', CROSS), []);
      const companies = await readFile(join(SRC, 'modules/companies/companies.repository.ts'), 'utf8');
      const places = await readFile(join(SRC, 'modules/places/places.repository.ts'), 'utf8');
      assert.match(companies, /readCrossGroupPage\(databases, principal, \{ name: 'companies', config: COMPANIES_LIST, projection: COMPANY_SUMMARY_PROJECTION \}, groups, filter, params\)/);
      assert.match(places, /readCrossGroupPage\(databases, principal, \{ name: 'places', config: PLACES_LIST, projection: PLACE_SUMMARY_PROJECTION \}, groups, filter, params\)/);
    });

    it('finds every way of reaching a symbol of a module: named, namespace, re-export, default and dynamic', () => {
      const reached = (text: string): boolean => reaches(text, 'cross-group', 'readCrossGroupPage');
      for (const text of [
        "import { readCrossGroupPage } from './cross-group.ts';",
        "import type { A, readCrossGroupPage as r } from '../scope/cross-group.ts';",
        "import * as cross from '../scope/cross-group.ts';",
        "export * from './cross-group.ts';",
        "export * as cross from './cross-group.ts';",
        "export { readCrossGroupPage } from './cross-group.ts';",
        "import cross from './cross-group.ts';",
        "const cross = await import('./cross-group.ts');",
      ]) {
        assert.ok(reached(text), text);
      }
      for (const text of ["import { other } from './cross-group.ts';", "import { readCrossGroupPage } from './elsewhere.ts';", 'const text = 1;']) {
        assert.ok(!reached(text), text);
      }
    });

    it('imports the read of the companies and places that use a country only in the countries repository, which passes it nothing but codes', async () => {
      const importers: string[] = [];
      for (const file of await filesUnder(SRC)) {
        const path = posix(file);
        if (path !== MIRROR && /import\s*(?:type\s*)?\{[^}]*\breadCountryUsage\b[^}]*\}\s*from\s*'[^']*group-mirror\.ts'/.test(await readFile(file, 'utf8'))) {
          importers.push(path);
        }
      }
      assert.deepEqual(importers, ['modules/countries/countries.repository.ts']);
      // The read takes the two codes only after checking that each is two uppercase letters, and returns ids and counts: no document leaves the copies.
      const mirror = await readFile(join(SRC, MIRROR), 'utf8');
      assert.match(mirror, /COUNTRY_CODE_FORMAT\.test\(countryCode\)/);
      assert.match(mirror, /projection: \{ _id: 1 \}/);
    });

    it('lets only the write service write companies and places, in a transaction, from a verified group access', async () => {
      const writers: string[] = [];
      for (const file of await filesUnder(SRC)) {
        const path = posix(file);
        if (path === WRITER) {
          const text = await readFile(file, 'utf8');
          writers.push(path);
          assert.ok(text.includes('groupDatabaseFor(principal, access, databases)'), 'the writer opens the group database from the verified access');
          assert.ok(text.includes('databases.transaction('), 'the writer runs in a transaction');
          assert.ok(!/\.group\(/.test(text) && !text.includes('analytics'), 'the writer neither opens a group database by itself nor uses the analytics connection');
        }
      }
      assert.deepEqual(writers, [WRITER]);
    });

    it('keeps the copies away from the analytics connection', async () => {
      const text = await readFile(join(SRC, MIRROR), 'utf8');
      assert.ok(!/analytics/i.test(text));
      assert.ok(text.includes('databases.common()'));
    });
  });

  describe('the creation of a customer (area 8)', () => {
    const posix = (file: string): string => relative(SRC, file).split('\\').join('/');

    it('issues the access to a new group only from the composition root, and opens the database of a new group only from the access file, the write service of companies and places and the onboarding repository', async () => {
      const issuers: string[] = [];
      const openers: string[] = [];
      const departments: string[] = [];
      for (const file of await filesUnder(SRC)) {
        const path = posix(file);
        const text = await readFile(file, 'utf8');
        if (text.includes('issueGroupCreationAccess(')) {
          issuers.push(path);
        }
        if (text.includes('groupCreationDatabase(')) {
          openers.push(path);
        }
        if (/\.collection(?:<[^>]*>)?\(\s*['"`]products_departments['"`]/.test(text)) {
          departments.push(path);
        }
      }
      assert.deepEqual(issuers.sort(), ['composition.ts', 'shared/security/scope/group-access.ts']);
      assert.deepEqual(openers.sort(), ['modules/groups/onboarding.repository.ts', 'shared/legacy-write/companies-places.writer.ts', 'shared/security/scope/group-access.ts']);
      // The onboarding inserts the departments of a new customer; the department routes (step C1) and the realignment of the tax copies are the other readers and writers.
      assert.deepEqual(departments.filter((path) => !path.startsWith('tools/')), ['modules/groups/onboarding.repository.ts', 'modules/product-departments/product-departments.repository.ts']);
    });

    it('opens the products of a group only in the product repository, the tax copies, the lookups, the services of the users and the reads of the catalog and the tobacco synchronization (step C3)', async () => {
      const openers: string[] = [];
      for (const file of await filesUnder(SRC)) {
        if (/\.collection(?:<[^>]*>)?\(\s*['"`]products['"`]/.test(await readFile(file, 'utf8')) && !posix(file).startsWith('tools/')) {
          openers.push(posix(file));
        }
      }
      assert.deepEqual(openers.sort(), ['modules/catalog-xlsx/catalog-xlsx.repository.ts', 'modules/contacts/contacts.repository.ts', 'modules/group-lookup/lookup.repository.ts', 'modules/group-services/services.repository.ts', 'modules/product-catalog/product-references.ts', 'modules/products/products.repository.ts', 'modules/products/products.tax.ts', 'modules/tobacco-sync/tobacco-sync.repository.ts']);
    });

    it('lets the contacts repository read the products (the services and the supplier price lists it checks) and never write them', async () => {
      const text = await readFile(join(SRC, 'modules/contacts/contacts.repository.ts'), 'utf8');
      assert.ok(/\.collection\(\s*'products'/.test(text));
      const methods = [...text.matchAll(/\.collection\(\s*'products'\s*\)\s*\.(\w+)\(/g)].map((match) => match[1]);
      assert.ok(methods.length > 0 && methods.every((method) => method === 'find'));
    });

    it('prepares the administrator of a new group only from the onboarding service', async () => {
      const callers: string[] = [];
      for (const file of await filesUnder(SRC)) {
        const path = posix(file);
        if (path !== 'modules/users/users.service.ts' && (await readFile(file, 'utf8')).includes('prepareGroupAdmin(')) {
          callers.push(path);
        }
      }
      assert.deepEqual(callers, ['modules/groups/onboarding.service.ts']);
    });

    it('generates and writes the api key of a group only in the creation of a customer', async () => {
      const named: string[] = [];
      for (const file of await filesUnder(SRC)) {
        const path = posix(file);
        if (/newGroupApiKey|\bapiKey:\s*input\.apiKey/.test(await readFile(file, 'utf8'))) {
          named.push(path);
        }
      }
      assert.deepEqual(named.sort(), ['modules/groups/onboarding.documents.ts', 'modules/groups/onboarding.service.ts']);
    });
  });

  describe('e-mail templates (step T2)', () => {
    const posix = (file: string): string => relative(SRC, file).split('\\').join('/');

    it('writes the e-mail templates of a group only from the templates repository, and reads them only from it, the places repository and the lookup repository', async () => {
      const readers: string[] = [];
      for (const file of await filesUnder(SRC)) {
        const path = posix(file);
        const text = await readFile(file, 'utf8');
        if (/\.collection(?:<[^>]*>)?\(\s*['"`]email_templates['"`]/.test(text) && !path.startsWith('tools/') && !path.startsWith('db/')) {
          readers.push(path);
          if (path !== 'modules/email-templates/email-templates.repository.ts') {
            assert.ok(!/\.(?:insertOne|insertMany|updateOne|updateMany|replaceOne|deleteOne|deleteMany|findOneAndUpdate|bulkWrite)\(/.test(text), `${path} writes e-mail templates`);
          }
        }
      }
      assert.deepEqual(readers.sort(), ['modules/email-templates/email-templates.repository.ts', 'modules/group-lookup/lookup.repository.ts', 'modules/places/places.repository.ts']);
    });
  });

  describe('media (step 6B)', () => {
    const REPOSITORY = 'modules/media/media.repository.ts';
    const posix = (file: string): string => relative(SRC, file).split('\\').join('/');

    it('reaches the files of a group only from the media repository, through the verified group access', async () => {
      const seen: string[] = [];
      for (const file of await filesUnder(SRC)) {
        const path = posix(file);
        const text = await readFile(file, 'utf8');
        if (/\.collection(?:<[^>]*>)?\(\s*['"`]files['"`]/.test(text)) {
          seen.push(path);
          if (path === REPOSITORY) {
            assert.ok(text.includes('groupDatabaseFor(principal, access, databases)'));
          }
        }
      }
      assert.deepEqual(seen.filter((path) => !path.startsWith('tools/') && !path.startsWith('db/')), [REPOSITORY]);
    });

    it('talks to the object storage only from the integration adapter, with the global fetch and no SDK', async () => {
      for (const file of await filesUnder(SRC)) {
        const path = posix(file);
        const text = await readFile(file, 'utf8');
        if (!path.startsWith('infrastructure/gcs/')) {
          assert.ok(!/storage\.googleapis\.com|oauth2\.googleapis\.com|metadata\.google\.internal/.test(text), `${path} names a storage endpoint`);
          assert.ok(!/@google-cloud|googleapis'/.test(text), `${path} imports a Google SDK`);
        }
        assert.ok(!/from 'sharp'/.test(text) || path === 'modules/media/image-processing.ts', `${path} imports sharp`);
        assert.ok(!/from 'multer'/.test(text) || path === 'modules/media/upload.ts' || path === 'modules/tobaccos/tobaccos.upload.ts', `${path} imports multer`);
      }
    });
  });

  describe('the public API keys (step 9A)', () => {
    const posix = (file: string): string => relative(SRC, file).split('\\').join('/');

    it('reads the header of the key only in the authentication of the keys, and generates a public key only when one is created', async () => {
      const readers: string[] = [];
      const generators: string[] = [];
      for (const file of await filesUnder(SRC)) {
        const text = await readFile(file, 'utf8');
        if (/\.get\(\s*['"]x-api-key['"]\s*\)/i.test(text) && !posix(file).startsWith('tools/')) {
          readers.push(posix(file));
        }
        if (/generateSecret\('fc_pk_'\)/.test(text)) {
          generators.push(posix(file));
        }
      }
      assert.deepEqual(readers, ['modules/api-keys/authenticate-api-key.ts']);
      assert.deepEqual(generators, ['modules/api-keys/api-keys.service.ts']);
    });

    it('reads the keys and their usage only from the repository of the keys, and never projects the hash anywhere but in the lookup of the authentication', async () => {
      const seen: string[] = [];
      for (const file of await filesUnder(SRC)) {
        const text = await readFile(file, 'utf8');
        if (/\.collection(?:<[^>]*>)?\(\s*['"`](apiKeys|apiUsage)['"`]/.test(text) && !posix(file).startsWith('db/')) {
          seen.push(posix(file));
        }
      }
      assert.deepEqual(seen, ['modules/api-keys/api-keys.repository.ts']);
      const repository = await readFile(join(SRC, 'modules/api-keys/api-keys.repository.ts'), 'utf8');
      // Every read but the lookup by hash names its fields without the hash.
      assert.equal([...repository.matchAll(/projection: API_KEY_PROJECTION/g)].length, 4);
      assert.equal([...repository.matchAll(/API_KEYS_LIST, API_KEY_PROJECTION/g)].length, 1);
      assert.equal([...repository.matchAll(/findOne\(\{ hash \}/g)].length, 1);
      const mapper = await readFile(join(SRC, 'modules/api-keys/api-keys.mapper.ts'), 'utf8');
      assert.ok(!/API_KEY_PROJECTION = Object\.freeze\(\{[^}]*\bhash\b/.test(mapper));
    });

    it('shows the public API only what the copies may give: the projections of the public places and companies are inside the central allowlist, which holds no credential, bank or setting', async () => {
      const mirror = await readFile(join(SRC, MIRROR_FILE), 'utf8');
      // The whole fields (the central allowlist); the leaves of the containers that hold credentials have their own test.
      const allowlist = mirror.slice(mirror.indexOf('export const MIRROR_FIELDS'), mirror.indexOf('export const MIRROR_LEAVES'));
      const sets = [...allowlist.matchAll(/(companies|places): new Set\(\[([^\]]*)\]\)/g)].map((match) => [match[1], [...match[2]!.matchAll(/'([^']+)'/g)].map((name) => name[1]!)] as const);
      assert.deepEqual(sets.map(([name]) => name), ['companies', 'places']);
      const forbidden = /integrations|banks|iban|settings|fattura|devices|rooms|printStations|productionCenter|platform|server|connector|contact|invoice|medias|general|delivery|apiKey|password|secret|key/i;
      for (const [name, fields] of sets) {
        assert.ok(fields.length > 0 && fields.every((field) => !forbidden.test(field)), `${name}: ${fields.join(',')}`);
      }
    });

    it('opens the public repository only through the per-group openers of group-mirror.ts, from the group of the principal', async () => {
      const repository = await readFile(join(SRC, 'modules/public-api/public.repository.ts'), 'utf8');
      assert.ok(!/\.collection\(/.test(repository));
      assert.equal([...repository.matchAll(/trustedGroupMirror\(principal\.groupId, databases, '(places|companies)'\)/g)].length, 2);
      assert.ok(!/req\.|res\.|\bquery\b/.test(repository));
    });
  });

  describe('the legacy send queue (step 9-ter/3)', () => {
    const REPOSITORY = 'modules/error-documents/error-documents.repository.ts';
    const posix = (file: string): string => relative(SRC, file).split('\\').join('/');

    it('opens the queue database only from the error documents repository, and builds its name only in src/db', async () => {
      const openers: string[] = [];
      for (const file of await filesUnder(SRC)) {
        const path = posix(file);
        const text = await readFile(file, 'utf8');
        if (!path.startsWith('db/') && /\.queue\(\)/.test(text)) {
          openers.push(path);
        }
        if (!path.startsWith('db/')) {
          assert.ok(!text.includes('queueDatabaseName') && !/_queue\b/.test(text), `${path} names the queue database`);
        }
      }
      assert.deepEqual(openers, [REPOSITORY]);
    });

    it('has no write, index or output operation anywhere in the repository that reads it', async () => {
      const text = await readFile(join(SRC, REPOSITORY), 'utf8');
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      assert.ok(!/\b(insert|update|replace|delete|bulkWrite|createIndex|createIndexes|dropIndex|drop|rename|findOneAnd|createCollection|\$out|\$merge)/i.test(code.replace(/\bupdateDate\b/g, '')), 'the repository of the queue must only read');
      assert.ok(!/\.(db|admin|client)\(/.test(code));
    });

    it('hands out a handle that has read methods only, and refuses an aggregation that writes', () => {
      const client = new MongoClient('mongodb://127.0.0.1:1/?directConnection=true');
      const databases = createDatabases({ clusters: new Map([['cluster0', { main: client, analytics: client }]]), commonCluster: 'cluster0', defaultGroupCluster: 'cluster0' }, { prefix: '', appEnv: 'development' });
      const documents = databases.queue().collection('documents');
      assert.deepEqual(Object.keys(documents).sort(), ['aggregate', 'countDocuments', 'distinct', 'estimatedDocumentCount', 'find', 'findOne']);
      assert.deepEqual(Object.keys(databases.queue()), ['collection']);
      assert.throws(() => documents.aggregate([{ $out: 'x' }]), /\$out or \$merge/);
      assert.throws(() => documents.aggregate([{ $merge: { into: 'x' } }]), /\$out or \$merge/);
    });

    it('registers the permission on /v1 only: it is not a public permission, and the public routes do not mention the documents', async () => {
      assert.equal(isPublicPermission('errorDocuments:read'), false);
      for (const file of await filesUnder(join(SRC, 'modules', 'public-api'))) {
        assert.ok(!/error-?documents/i.test(await readFile(file, 'utf8')), file);
      }
    });
  });

  it('recognizes the allowed entry points', () => {
    assert.equal(mayCreateDatabases(join(SRC, 'server.ts')), true);
    assert.equal(mayCreateDatabases(join(SRC, 'tools', 'x', 'main.ts')), true);
    assert.equal(mayCreateDatabases(join(SRC, 'tools', 'x', 'other.ts')), false);
    assert.equal(mayCreateDatabases(join(SRC, 'app.ts')), false);
  });
});

describe('the service of the cards joins a transaction only for the workbook of the cards', () => {
  it('sets nested: true only in the service of the workbook, which builds it over the session of its own transaction', async () => {
    const found: string[] = [];
    for (const file of await filesUnder(SRC)) {
      if (/\bnested:\s*true\b/.test(await readFile(file, 'utf8'))) {
        found.push(relative(SRC, file).split('\\').join('/'));
      }
    }
    assert.deepEqual(found, ['modules/fidelity-cards-xlsx/fidelity-cards-xlsx.service.ts']);
  });
});
