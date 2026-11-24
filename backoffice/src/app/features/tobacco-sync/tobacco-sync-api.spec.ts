import { TestBed } from '@angular/core/testing';
import { API, backend, provideApiTesting } from '../../../testing/api';
import { TobaccoSyncApi } from './tobacco-sync-api';
import { SyncOutcome } from './tobacco-sync.types';

const OUTCOME: SyncOutcome = {
  dryRun: false,
  products: { inserted: 1, updated: 2, disabled: 3, reactivated: 4, unchanged: 5, skipped: 6 },
  categories: { inserted: 7, duplicateNames: 8 },
  duplicateCodes: 9,
};
const OPTIONS = { warehouse: true, noDiscount: false, placeIds: ['p1', 'p2'] };

describe('TobaccoSyncApi', () => {
  beforeEach(() => TestBed.configureTestingModule({ providers: provideApiTesting() }));

  it('applies a synchronization with the key and the options in the body', async () => {
    const result = TestBed.inject(TobaccoSyncApi).sync('g 1', OPTIONS, 'key-1', false);
    const request = backend().expectOne(`${API}/v1/groups/g%201/tobacco-sync`);
    expect(request.request.method).toBe('POST');
    expect(request.request.headers.get('Idempotency-Key')).toBe('key-1');
    expect(request.request.params.has('dryRun')).toBe(false);
    expect(request.request.body).toEqual(OPTIONS);
    request.flush({ data: OUTCOME });
    expect(await result).toEqual(OUTCOME);
  });

  it('sends the confirmation of a mass deactivation only when it was given', async () => {
    const api = TestBed.inject(TobaccoSyncApi);
    const result = api.sync('g1', { ...OPTIONS, confirmMassDisable: true }, 'key-3', false);
    const request = backend().expectOne(`${API}/v1/groups/g1/tobacco-sync`);
    expect(request.request.body).toEqual({ ...OPTIONS, confirmMassDisable: true });
    request.flush({ data: OUTCOME });
    await result;
  });

  it('asks only for the counts with dryRun', async () => {
    const result = TestBed.inject(TobaccoSyncApi).sync('g1', OPTIONS, 'key-2', true);
    const request = backend().expectOne(`${API}/v1/groups/g1/tobacco-sync?dryRun=true`);
    expect(request.request.headers.get('Idempotency-Key')).toBe('key-2');
    request.flush({ data: { ...OUTCOME, dryRun: true } });
    expect((await result).dryRun).toBe(true);
  });
});
