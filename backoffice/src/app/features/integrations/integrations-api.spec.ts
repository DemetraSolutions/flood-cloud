import { TestBed } from '@angular/core/testing';
import { API, backend, failRequest, provideApiTesting } from '../../../testing/api';
import { ApiError } from '../../core/api/api-error';
import { IDEMPOTENCY_HEADER, IntegrationsApi } from './integrations-api';

const ADDRESS = {
  street: 'Via Roma 1',
  postcode: '20100',
  city: 'Milano',
  province: 'MI',
  country: 'IT',
};
const PLACE = `${API}/v1/groups/g%2F1/places/p1`;

describe('IntegrationsApi', () => {
  let api: IntegrationsApi;
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: provideApiTesting() });
    api = TestBed.inject(IntegrationsApi);
  });
  afterEach(() => backend().verify());

  it('builds the URL of a place with the ids encoded', () => {
    expect(api.placeUrl('g/1', 'p1')).toBe('/v1/groups/g%2F1/places/p1');
  });

  describe('activateSatispay', () => {
    it('posts the code with the idempotency key and the version, and returns the new version', async () => {
      const result = api.activateSatispay('g/1', 'p1', 'ABC123', 'key-1', '"v1"');
      const request = backend().expectOne(`${PLACE}/integrations/satispay/activation`);
      expect(request.request.method).toBe('POST');
      expect(request.request.body).toEqual({ activationCode: 'ABC123' });
      expect(request.request.headers.get(IDEMPOTENCY_HEADER)).toBe('key-1');
      expect(request.request.headers.get('If-Match')).toBe('"v1"');
      request.flush({ data: { keyIdSet: true } }, { headers: { ETag: '"v2"' } });
      expect(await result).toEqual({ etag: '"v2"' });
    });

    it('says there is no new version when the answer has no ETag', async () => {
      const result = api.activateSatispay('g/1', 'p1', 'ABC123', 'key-1', null);
      const request = backend().expectOne(`${PLACE}/integrations/satispay/activation`);
      expect(request.request.headers.has('If-Match')).toBe(false);
      request.flush({ data: { keyIdSet: true } });
      expect(await result).toEqual({ etag: null });
    });

    it('rejects with the API error', async () => {
      const result = api.activateSatispay('g/1', 'p1', 'ABC123', 'key-1', '"v1"');
      failRequest(backend(), '/v1/groups/g%2F1/places/p1/integrations/satispay/activation', 'PROVIDER_ERROR');
      await expect(result).rejects.toBeInstanceOf(ApiError);
    });
  });

  describe('syncTshCategories', () => {
    it('posts with the version and returns the categories and the new version', async () => {
      const categories = [{ id: 'T1', name: 'Bar' }];
      const result = api.syncTshCategories('g/1', 'p1', '"v1"');
      const request = backend().expectOne(`${PLACE}/integrations/tsh/charge-categories/sync`);
      expect(request.request.method).toBe('POST');
      expect(request.request.body).toBeNull();
      expect(request.request.headers.get('If-Match')).toBe('"v1"');
      request.flush({ data: categories }, { headers: { ETag: '"v2"' } });
      expect(await result).toEqual({ categories, etag: '"v2"' });
    });

    it('sends no version when the page has none, and returns none when the answer has none', async () => {
      const result = api.syncTshCategories('g/1', 'p1', null);
      const request = backend().expectOne(`${PLACE}/integrations/tsh/charge-categories/sync`);
      expect(request.request.headers.has('If-Match')).toBe(false);
      request.flush({ data: [] });
      expect(await result).toEqual({ categories: [], etag: null });
    });

    it('rejects with the API error', async () => {
      const result = api.syncTshCategories('g/1', 'p1', '"v1"');
      failRequest(
        backend(),
        '/v1/groups/g%2F1/places/p1/integrations/tsh/charge-categories/sync',
        'PRECONDITION_FAILED',
      );
      await expect(result).rejects.toBeInstanceOf(ApiError);
    });
  });

  describe('geocode', () => {
    it('posts the five fields of the address and returns the coordinates', async () => {
      const result = api.geocode('g/1', 'p1', ADDRESS);
      const request = backend().expectOne(`${PLACE}/geocoding`);
      expect(request.request.method).toBe('POST');
      expect(request.request.body).toEqual(ADDRESS);
      request.flush({ data: { lat: 45.46, lng: 9.19 } });
      expect(await result).toEqual({ lat: 45.46, lng: 9.19 });
    });

    it('rejects with the API error', async () => {
      const result = api.geocode('g/1', 'p1', ADDRESS);
      failRequest(backend(), '/v1/groups/g%2F1/places/p1/geocoding', 'VALIDATION_ERROR', {
        details: [{ field: 'street', issue: 'incorrect' }],
      });
      await expect(result).rejects.toBeInstanceOf(ApiError);
    });
  });

  describe('lookupVat', () => {
    it('reads the lookup of a VAT number', async () => {
      const found = { vatNumber: '00743110157', name: 'X' };
      const result = api.lookupVat('00743110157');
      const request = backend().expectOne(`${API}/v1/vat-lookups/00743110157`);
      expect(request.request.method).toBe('GET');
      request.flush({ data: found });
      expect(await result).toEqual(found);
    });

    it('encodes the VAT number in the path and rejects with the API error', async () => {
      const result = api.lookupVat('1/2&3');
      failRequest(backend(), '/v1/vat-lookups/1%2F2%263', 'NOT_FOUND');
      await expect(result).rejects.toBeInstanceOf(ApiError);
    });
  });
});
