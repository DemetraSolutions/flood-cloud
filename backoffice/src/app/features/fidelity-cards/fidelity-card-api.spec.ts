import { TestBed } from '@angular/core/testing';
import { API, backend, provideApiTesting } from '../../../testing/api';
import { FidelityCardApi } from './fidelity-card-api';
import { FidelityCard } from './fidelity-card.types';

const GROUP = '665f1c2e9b1d4a0012ab34a1';
const ID = '665f1c2e9b1d4a0012ab34c1';
const URL = `${API}/v1/groups/${GROUP}/fidelity-cards`;
const CARD = { id: ID, code: 'FC-1' } as FidelityCard;

function api(): FidelityCardApi {
  TestBed.configureTestingModule({ providers: [...provideApiTesting()] });
  return TestBed.inject(FidelityCardApi);
}

afterEach(() => backend().verify());

describe('FidelityCardApi', () => {
  it('builds the URLs of the cards and of the history', () => {
    const service = api();
    expect(service.baseUrl('a/b')).toBe('/v1/groups/a%2Fb/fidelity-cards');
    expect(service.movementsUrl('g', 'c?')).toBe('/v1/groups/g/fidelity-cards/c%3F/movements');
  });

  it('reads a card with its version', async () => {
    const reading = api().read(GROUP, ID);
    const request = backend().expectOne(`${URL}/${ID}`);
    expect(request.request.method).toBe('GET');
    request.flush({ data: CARD }, { headers: { ETag: '"v1"' } });
    expect(await reading).toEqual({ item: CARD, etag: '"v1"' });
  });

  it('creates a card with an Idempotency-Key', async () => {
    const creating = api().create(GROUP, { code: 'FC-1' }, 'key-1');
    const request = backend().expectOne(URL);
    expect(request.request.method).toBe('POST');
    expect(request.request.headers.get('Idempotency-Key')).toBe('key-1');
    expect(request.request.body).toEqual({ code: 'FC-1' });
    request.flush({ data: CARD }, { status: 201, statusText: 'Created' });
    expect((await creating).item).toEqual(CARD);
  });

  it('updates with the version in If-Match', async () => {
    const updating = api().update(GROUP, ID, { enabled: false }, '"v1"');
    const request = backend().expectOne(`${URL}/${ID}`);
    expect(request.request.method).toBe('PATCH');
    expect(request.request.headers.get('If-Match')).toBe('"v1"');
    expect(request.request.body).toEqual({ enabled: false });
    request.flush({ data: CARD }, { headers: { ETag: '"v2"' } });
    expect((await updating).etag).toBe('"v2"');
  });

  it('deletes a card with the version, or without one', async () => {
    const service = api();
    const first = service.remove(GROUP, ID, '"v1"');
    const conditional = backend().expectOne(`${URL}/${ID}`);
    expect(conditional.request.method).toBe('DELETE');
    expect(conditional.request.headers.get('If-Match')).toBe('"v1"');
    conditional.flush(null, { status: 204, statusText: 'No Content' });
    await expect(first).resolves.toBeUndefined();
    const second = service.remove(GROUP, ID, null);
    const unconditional = backend().expectOne(`${URL}/${ID}`);
    expect(unconditional.request.headers.has('If-Match')).toBe(false);
    unconditional.flush(null, { status: 204, statusText: 'No Content' });
    await expect(second).resolves.toBeUndefined();
  });

  it('adjusts a card with an Idempotency-Key and returns the card', async () => {
    const adjusting = api().adjust(GROUP, ID, { balanceDelta: 5, reason: 'gift' }, 'key-2');
    const request = backend().expectOne(`${URL}/${ID}/adjustments`);
    expect(request.request.method).toBe('POST');
    expect(request.request.headers.get('Idempotency-Key')).toBe('key-2');
    expect(request.request.headers.has('If-Match')).toBe(false);
    expect(request.request.body).toEqual({ balanceDelta: 5, reason: 'gift' });
    request.flush({ data: CARD });
    expect(await adjusting).toEqual(CARD);
  });
});
