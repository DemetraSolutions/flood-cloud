import { TestBed } from '@angular/core/testing';
import { API, backend, provideApiTesting } from '../../../testing/api';
import { ActivationsApi } from './activations-api';

afterEach(() => backend().verify());

function api(): ActivationsApi {
  TestBed.configureTestingModule({ providers: provideApiTesting() });
  return TestBed.inject(ActivationsApi);
}

describe('ActivationsApi', () => {
  it('downloads the CSV of a dealer, month and section', async () => {
    const result = api().downloadStatement('665f1c2e9b1d4a0012ab34d1', '2026-06', 'renewals');
    const request = backend().expectOne(
      (r) => r.url === `${API}/v1/activations/statements/665f1c2e9b1d4a0012ab34d1.csv`,
    );
    expect(request.request.params.get('month')).toBe('2026-06');
    expect(request.request.params.get('section')).toBe('renewals');
    expect(request.request.responseType).toBe('blob');
    request.flush(new Blob(['a;b']));
    expect(await (await result).text()).toBe('a;b');
  });

  it('downloads the CSV of the groups without a dealer', async () => {
    const result = api().downloadStatement('none', '2026-06', 'activations');
    backend()
      .expectOne((r) => r.url === `${API}/v1/activations/statements/none.csv`)
      .flush(new Blob(['x']));
    await result;
  });

  it('downloads the CSV of the detail with the filters given', async () => {
    const result = api().downloadLines({ from: '2026-05', to: '2026-06', dealerId: 'none' });
    const request = backend().expectOne((r) => r.url === `${API}/v1/activations/lines.csv`);
    expect(request.request.params.keys().sort()).toEqual(['dealerId', 'from', 'to']);
    expect(request.request.responseType).toBe('blob');
    request.flush(new Blob(['x']));
    await result;
  });

  it('downloads the CSV of the detail without a start month', async () => {
    const result = api().downloadLines({ to: '2026-06' });
    const request = backend().expectOne((r) => r.url === `${API}/v1/activations/lines.csv`);
    expect(request.request.params.keys()).toEqual(['to']);
    request.flush(new Blob(['x']));
    await result;
  });

  it('freezes and unfreezes the renewal base of a year', async () => {
    const service = api();
    const freeze = service.freezeBase(2026);
    const put = backend().expectOne({
      method: 'PUT',
      url: `${API}/v1/activations/renewal-bases/2026`,
    });
    expect(put.request.body).toBeNull();
    put.flush({ data: {} });
    await freeze;
    const unfreeze = service.unfreezeBase(2026);
    backend()
      .expectOne({ method: 'DELETE', url: `${API}/v1/activations/renewal-bases/2026` })
      .flush(null, { status: 204, statusText: 'No Content' });
    await unfreeze;
  });

  it('closes and reopens a month', async () => {
    const service = api();
    const close = service.closeMonth('2026-06');
    backend()
      .expectOne({ method: 'PUT', url: `${API}/v1/activations/closures/2026-06` })
      .flush({ data: {} });
    await close;
    const reopen = service.reopenMonth('2026-06');
    backend()
      .expectOne({ method: 'DELETE', url: `${API}/v1/activations/closures/2026-06` })
      .flush(null, { status: 204, statusText: 'No Content' });
    await reopen;
  });
});
