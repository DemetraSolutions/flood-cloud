import { TestBed } from '@angular/core/testing';
import { ApiError } from '../../core/api/api-error';
import { PlacesApi } from '../places/places-api';
import { PlaceSetupReader } from './category-place-setup';

const record = (
  stations: { id: string; name: string }[],
  centers: { id: string; name: string }[],
  storages: { id: string; name: string }[] = [],
) => ({
  place: { printStations: { stations, productionCenters: centers }, storages: { items: storages } },
});

function setup(read: ReturnType<typeof vi.fn>) {
  TestBed.configureTestingModule({ providers: [{ provide: PlacesApi, useValue: { read } }] });
  return TestBed.inject(PlaceSetupReader);
}

afterEach(() => vi.restoreAllMocks());

describe('PlaceSetupReader', () => {
  it('goes from loading to ready, dropping the entries without an id', async () => {
    const read = vi.fn().mockResolvedValue(
      record(
        [
          { id: 's1', name: 'Bar' },
          { id: '', name: 'Senza id' },
        ],
        [
          { id: '', name: 'Senza id' },
          { id: 'c1', name: 'Cucina' },
        ],
        [
          { id: '', name: 'Senza id' },
          { id: 'd1', name: 'Magazzino' },
        ],
      ),
    );
    const reader = setup(read);
    reader.load('g', 'p');
    expect(reader.states().get('p')).toEqual({ status: 'loading' });
    await vi.waitFor(() => expect(reader.states().get('p')?.status).toBe('ready'));
    expect(reader.states().get('p')).toEqual({
      status: 'ready',
      setup: {
        stations: [{ id: 's1', name: 'Bar' }],
        centers: [{ id: 'c1', name: 'Cucina' }],
        storages: [{ id: 'd1', name: 'Magazzino' }],
      },
    });
    expect(read).toHaveBeenCalledWith('g', 'p');
  });

  it('does not read again a store being read or read', async () => {
    const read = vi.fn().mockResolvedValue(record([], []));
    const reader = setup(read);
    reader.load('g', 'p');
    reader.load('g', 'p');
    await vi.waitFor(() => expect(reader.states().get('p')?.status).toBe('ready'));
    reader.load('g', 'p');
    expect(read).toHaveBeenCalledOnce();
  });

  it.each([
    ['an ApiError', new ApiError({ status: 403, code: 'FORBIDDEN', message: 'x' }), 'FORBIDDEN'],
    ['another error', new Error('boom'), 'unexpected'],
  ])('ends in error for %s and logs only the code', async (_name, failure, logged) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const reader = setup(vi.fn().mockRejectedValue(failure));
    reader.load('g', 'p');
    await vi.waitFor(() => expect(reader.states().get('p')).toEqual({ status: 'error' }));
    expect(warn).toHaveBeenCalledWith('Cannot read the print stations of the store', logged);
  });

  it('reads again after a failure', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(record([], []));
    const reader = setup(read);
    reader.load('g', 'p');
    await vi.waitFor(() => expect(reader.states().get('p')?.status).toBe('error'));
    reader.load('g', 'p');
    await vi.waitFor(() => expect(reader.states().get('p')?.status).toBe('ready'));
    expect(read).toHaveBeenCalledTimes(2);
  });
});
