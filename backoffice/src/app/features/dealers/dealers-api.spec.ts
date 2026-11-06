import { TestBed } from '@angular/core/testing';
import { API, backend, provideApiTesting } from '../../../testing/api';
import { fakeDealer } from '../../../testing/dealers';
import { DealersApi } from './dealers-api';

describe('DealersApi', () => {
  beforeEach(() => TestBed.configureTestingModule({ providers: provideApiTesting() }));
  afterEach(() => backend().verify());

  it('creates a dealer with its user', async () => {
    const body = {
      company: { businessName: 'Acme' },
      user: { username: 'acme', password: 'x'.repeat(12) },
    };
    const result = TestBed.inject(DealersApi).create(body);
    const request = backend().expectOne(`${API}/v1/dealers`);
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual(body);
    request.flush({ data: fakeDealer() }, { status: 201, statusText: 'Created' });
    expect((await result).businessName).toBe('Dealer Nord Srl');
  });

  it('updates a dealer with a patch', async () => {
    const result = TestBed.inject(DealersApi).update('d/1', { pec: null });
    const request = backend().expectOne(`${API}/v1/dealers/d%2F1`);
    expect(request.request.method).toBe('PATCH');
    expect(request.request.body).toEqual({ pec: null });
    request.flush({ data: fakeDealer() });
    await result;
  });
});
