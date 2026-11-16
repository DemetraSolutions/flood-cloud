import { TestBed } from '@angular/core/testing';
import { API, backend, failRequest, provideApiTesting } from '../../../testing/api';
import { ApiError } from '../../core/api/api-error';
import { IDEMPOTENCY_HEADER, NewCustomerApi } from './new-customer-api';
import { NewCustomerBody } from './new-customer.types';

const BODY = { group: { name: 'G' } } as unknown as NewCustomerBody;
const IDS = { groupId: 'g', companyId: 'c', placeId: 'p', userId: 'u' };

describe('NewCustomerApi', () => {
  let api: NewCustomerApi;
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: provideApiTesting() });
    api = TestBed.inject(NewCustomerApi);
  });
  afterEach(() => backend().verify());

  it('posts the body with the idempotency key and returns the ids', async () => {
    const result = api.create(BODY, 'key-1');
    const request = backend().expectOne(`${API}/v1/groups`);
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toBe(BODY);
    expect(request.request.headers.get(IDEMPOTENCY_HEADER)).toBe('key-1');
    request.flush({ data: IDS }, { status: 201, statusText: 'Created' });
    expect(await result).toEqual(IDS);
  });

  it('rejects with the API error', async () => {
    const result = api.create(BODY, 'key-1');
    failRequest(backend(), '/v1/groups', 'FORBIDDEN');
    await expect(result).rejects.toBeInstanceOf(ApiError);
  });
});
