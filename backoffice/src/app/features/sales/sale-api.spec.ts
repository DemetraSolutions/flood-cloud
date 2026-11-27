import { TestBed } from '@angular/core/testing';
import { API, backend, provideApiTesting } from '../../../testing/api';
import { SaleApi } from './sale-api';

const BASE = `${API}/v1/groups/g%201/sales/s%2F1`;

function setup(): SaleApi {
  TestBed.configureTestingModule({ providers: provideApiTesting() });
  return TestBed.inject(SaleApi);
}

afterEach(() => backend().verify());

describe('SaleApi', () => {
  it('amends with a PATCH of the changes and the version in quotes in If-Match', async () => {
    const api = setup();
    const done = api.amend('g 1', 's/1', 'v7', false, { payments: { cash: 5 } });
    const request = backend().expectOne(BASE);
    expect(request.request.method).toBe('PATCH');
    expect(request.request.headers.get('If-Match')).toBe('"v7"');
    expect(request.request.params.keys()).toEqual([]);
    expect(request.request.body).toEqual({ payments: { cash: 5 } });
    request.flush({ data: {} });
    await done;
  });

  it('asks for the non fiscal sales of an amendment of a non fiscal sale', async () => {
    const api = setup();
    const done = api.amend('g 1', 's/1', 'v7', true, { lotteryCode: 'X' });
    const request = backend().expectOne((r) => r.url === BASE);
    expect(request.request.params.get('nonFiscal')).toBe('include');
    request.flush({ data: {} });
    await done;
  });

  it('registers a refund with a POST on refunds', async () => {
    const api = setup();
    const body = { timestampId: 'bo-1', date: '2026-11-27T10:00:00.000Z', products: [{ index: 0, quantity: 1 }] };
    const done = api.refund('g 1', 's/1', 'v2', true, body);
    const request = backend().expectOne((r) => r.url === `${BASE}/refunds`);
    expect(request.request.method).toBe('POST');
    expect(request.request.headers.get('If-Match')).toBe('"v2"');
    expect(request.request.params.get('nonFiscal')).toBe('include');
    expect(request.request.body).toEqual(body);
    request.flush({ data: {} });
    await done;
  });

  it('cancels with a POST on cancellation, without nonFiscal for a fiscal sale', async () => {
    const api = setup();
    const done = api.cancel('g 1', 's/1', 'v3', false, { date: '2026-11-27T10:00:00.000Z' });
    const request = backend().expectOne(`${BASE}/cancellation`);
    expect(request.request.method).toBe('POST');
    expect(request.request.headers.get('If-Match')).toBe('"v3"');
    expect(request.request.body).toEqual({ date: '2026-11-27T10:00:00.000Z' });
    request.flush({ data: {} });
    await done;
  });

  it('deletes a quote with a DELETE that always asks for the non fiscal sales', async () => {
    const api = setup();
    const done = api.remove('g 1', 's/1', 'v4');
    const request = backend().expectOne((r) => r.url === BASE);
    expect(request.request.method).toBe('DELETE');
    expect(request.request.headers.get('If-Match')).toBe('"v4"');
    expect(request.request.params.get('nonFiscal')).toBe('include');
    request.flush(null, { status: 204, statusText: 'No Content' });
    await done;
  });
});
