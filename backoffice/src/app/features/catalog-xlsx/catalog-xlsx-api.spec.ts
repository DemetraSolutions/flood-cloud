import { TestBed } from '@angular/core/testing';
import { API, backend, provideApiTesting } from '../../../testing/api';
import { CatalogXlsxApi } from './catalog-xlsx-api';
import { XLSX_TOOLS } from './xlsx-tools';

const BASE = `${API}/v1/groups/g%201`;
const OUTCOME = {
  dryRun: true,
  sheets: {
    products: { inserted: 1, updated: 0, removed: 0, unchanged: 0 },
    variants: { inserted: 0, updated: 0, removed: 0, unchanged: 0 },
    categories: { inserted: 0, updated: 0, removed: 0, unchanged: 0 },
  },
};

afterEach(() => backend().verify());

describe('CatalogXlsxApi', () => {
  beforeEach(() => TestBed.configureTestingModule({ providers: [...provideApiTesting()] }));

  it('downloads the model as a file', async () => {
    const download = TestBed.inject(CatalogXlsxApi).template('g 1');
    const request = backend().expectOne(`${BASE}/catalog-export/template`);
    expect(request.request.method).toBe('GET');
    expect(request.request.responseType).toBe('blob');
    request.flush(new Blob(['x']));
    expect((await download).size).toBe(1);
  });

  it.each(['ids', 'names'] as const)('downloads the export with references=%s', async (references) => {
    const download = TestBed.inject(CatalogXlsxApi).export('g 1', references);
    const request = backend().expectOne((r) => r.url === `${BASE}/catalog-export`);
    expect(request.request.params.get('references')).toBe(references);
    expect(request.request.responseType).toBe('blob');
    request.flush(new Blob(['xy']));
    expect((await download).size).toBe(2);
  });

  it('sends the file in the part "file" with the Idempotency-Key, with dryRun for a check', async () => {
    const file = new File(['bytes'], 'catalog.xlsx');
    const checking = TestBed.inject(CatalogXlsxApi).import('g 1', file, 'key-1', true);
    const request = backend().expectOne((r) => r.url === `${BASE}/catalog-import`);
    expect(request.request.method).toBe('POST');
    expect(request.request.params.get('dryRun')).toBe('true');
    expect(request.request.headers.get('Idempotency-Key')).toBe('key-1');
    const body = request.request.body as FormData;
    expect([...body.keys()]).toEqual(['file']);
    expect((body.get('file') as File).name).toBe('catalog.xlsx');
    request.flush({ data: OUTCOME });
    expect(await checking).toEqual(OUTCOME);
  });

  it.each([
    ['contacts', 'contacts-export', 'contacts-import'],
    ['cards', 'fidelity-cards-export', 'fidelity-cards-import'],
  ] as const)('reaches the routes of the %s workbook', async (tool, exportPath, importPath) => {
    const api = TestBed.inject(CatalogXlsxApi);
    const spec = XLSX_TOOLS[tool];
    const model = api.template('g 1', spec);
    backend().expectOne(`${BASE}/${exportPath}/template`).flush(new Blob(['x']));
    await model;
    const exported = api.export('g 1', 'names', spec);
    const exportRequest = backend().expectOne((r) => r.url === `${BASE}/${exportPath}`);
    expect(exportRequest.request.params.get('references')).toBe('names');
    exportRequest.flush(new Blob(['x']));
    await exported;
    const importing = api.import('g 1', new File(['b'], 'c.xlsx'), 'key-3', true, spec);
    backend().expectOne((r) => r.url === `${BASE}/${importPath}`).flush({ data: OUTCOME });
    expect((await importing).dryRun).toBe(true);
  });

  it('sends no dryRun to apply the file', async () => {
    const importing = TestBed.inject(CatalogXlsxApi).import('g 1', new File(['b'], 'c.xlsx'), 'key-2', false);
    const request = backend().expectOne((r) => r.url === `${BASE}/catalog-import`);
    expect(request.request.params.has('dryRun')).toBe(false);
    request.flush({ data: { ...OUTCOME, dryRun: false } });
    expect((await importing).dryRun).toBe(false);
  });
});
