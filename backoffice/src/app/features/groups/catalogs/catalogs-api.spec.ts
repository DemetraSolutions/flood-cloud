import { TestBed } from '@angular/core/testing';
import { API, backend, provideApiTesting } from '../../../../testing/api';
import { ReferenceStore } from '../../../core/reference/reference-store';
import { CatalogsApi } from './catalogs-api';

describe('CatalogsApi', () => {
  function api(): CatalogsApi {
    TestBed.configureTestingModule({ providers: provideApiTesting() });
    return TestBed.inject(CatalogsApi);
  }

  afterEach(() => backend().verify());

  it('builds the URL of a catalog and of one of its elements, encoding the parts', () => {
    const service = api();
    expect(service.url('g1', 'taxes')).toBe('/v1/groups/g1/taxes');
    expect(service.url('g 1', 'currencies', 'E/R')).toBe('/v1/groups/g%201/currencies/E%2FR');
  });

  it('creates with POST and returns the data', async () => {
    const result = api().create('g1', 'taxes', { rate: 22 });
    const request = backend().expectOne(`${API}/v1/groups/g1/taxes`);
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ rate: 22 });
    request.flush({ data: { id: 't1' } });
    expect(await result).toEqual({ id: 't1' });
  });

  it('modifies with PATCH', async () => {
    const result = api().patch('g1', 'taxes', 't1', { rate: 10 });
    const request = backend().expectOne(`${API}/v1/groups/g1/taxes/t1`);
    expect(request.request.method).toBe('PATCH');
    expect(request.request.body).toEqual({ rate: 10 });
    request.flush({ data: { id: 't1' } });
    expect(await result).toEqual({ id: 't1' });
  });

  it('replaces with PUT', async () => {
    const result = api().put('g1', 'fidelity-card-rules', 'EUR', { pointValue: 1 });
    const request = backend().expectOne(`${API}/v1/groups/g1/fidelity-card-rules/EUR`);
    expect(request.request.method).toBe('PUT');
    request.flush({ data: { currency: 'EUR' } });
    expect(await result).toEqual({ currency: 'EUR' });
  });

  it('deletes with DELETE', async () => {
    const result = api().remove('g1', 'taxes', 't1');
    const request = backend().expectOne(`${API}/v1/groups/g1/taxes/t1`);
    expect(request.request.method).toBe('DELETE');
    request.flush(null, { status: 204, statusText: 'No Content' });
    await expect(result).resolves.toBeUndefined();
  });

  describe('reference store', () => {
    const NO_CONTENT = { status: 204, statusText: 'No Content' };

    it('invalidates the price lists after a create, a change, a replace or a delete', async () => {
      const service = api();
      const invalidate = vi.spyOn(TestBed.inject(ReferenceStore), 'invalidate');
      const writes = [
        service.create('g1', 'price-lists', {}),
        service.patch('g1', 'price-lists', 'p1', {}),
        service.put('g1', 'price-lists', 'p1', {}),
        service.remove('g1', 'price-lists', 'p1'),
      ];
      const requests = backend().match(() => true);
      expect(requests).toHaveLength(4);
      requests.forEach((request) =>
        request.request.method === 'DELETE'
          ? request.flush(null, NO_CONTENT)
          : request.flush({ data: {} }),
      );
      await Promise.all(writes);
      expect(invalidate.mock.calls).toEqual(Array(4).fill(['g1', 'price-lists']));
    });

    it('does not invalidate on the catalogs it does not keep, nor when the write fails', async () => {
      const service = api();
      const invalidate = vi.spyOn(TestBed.inject(ReferenceStore), 'invalidate');
      const done = service.create('g1', 'taxes', {});
      backend().expectOne(`${API}/v1/groups/g1/taxes`).flush({ data: {} });
      await done;
      const failed = service.remove('g1', 'price-lists', 'p1').catch(() => 'failed');
      backend()
        .expectOne(`${API}/v1/groups/g1/price-lists/p1`)
        .flush(null, { status: 409, statusText: 'Conflict' });
      expect(await failed).toBe('failed');
      expect(invalidate).not.toHaveBeenCalled();
    });
  });
});
