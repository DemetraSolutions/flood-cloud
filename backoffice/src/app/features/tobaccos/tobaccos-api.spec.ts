import { TestBed } from '@angular/core/testing';
import { API, backend, provideApiTesting } from '../../../testing/api';
import { TobaccosApi } from './tobaccos-api';

afterEach(() => backend().verify());

describe('TobaccosApi', () => {
  it('sends the file in the part "file" with the Idempotency-Key and gives back the counts', async () => {
    TestBed.configureTestingModule({ providers: [...provideApiTesting()] });
    const file = new File(['bytes'], 'listino.xlsx');
    const importing = TestBed.inject(TobaccosApi).import(file, 'key-1');
    const request = backend().expectOne(`${API}/v1/tobaccos/import`);
    expect(request.request.method).toBe('POST');
    expect(request.request.headers.get('Idempotency-Key')).toBe('key-1');
    const body = request.request.body as FormData;
    expect([...body.keys()]).toEqual(['file']);
    expect((body.get('file') as File).name).toBe('listino.xlsx');
    request.flush({ data: { inserted: 3, previous: 2, elapsedMs: 40 } });
    expect(await importing).toEqual({ inserted: 3, previous: 2, elapsedMs: 40 });
  });
});
