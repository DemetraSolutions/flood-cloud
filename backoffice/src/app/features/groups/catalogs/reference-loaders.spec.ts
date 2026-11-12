import { ApiError } from '../../../core/api/api-error';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ReferenceApi } from '../../../core/reference/reference-api';
import { lookupLoader, placesLoader, selectionNames, staticLoader } from './reference-loaders';

const PAGE = { data: [{ id: 'a', name: 'Alfa' }], page: { limit: 25, next: null } };

describe('reference loaders', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads a lookup of the group with the query of the picker', async () => {
    const lookup = vi.spyOn(ReferenceApi.prototype, 'lookup').mockResolvedValue(PAGE);
    const query = { q: 'a', cursor: 'c1' };
    expect(await lookupLoader(TestBed.inject(ReferenceApi), 'g1', 'customers')(query)).toBe(PAGE);
    expect(lookup).toHaveBeenCalledWith('g1', 'customers', query);
  });

  it('reads the stores of the group with the query of the picker', async () => {
    const places = vi.spyOn(ReferenceApi.prototype, 'places').mockResolvedValue(PAGE);
    const query = { q: '', cursor: null };
    expect(await placesLoader(TestBed.inject(ReferenceApi), 'g1')(query)).toBe(PAGE);
    expect(places).toHaveBeenCalledWith('g1', query);
  });

  it('filters a list in memory by name, without distinguishing case, in one page', async () => {
    const items = [
      { id: 'a', name: 'Gold' },
      { id: 'b', name: 'Silver' },
    ];
    const load = staticLoader(items);
    expect((await load({ q: ' GOL ', cursor: null })).data).toEqual([items[0]]);
    expect(await load({ q: '', cursor: null })).toEqual({
      data: items,
      page: { limit: 2, next: null },
    });
    expect(await load({ q: 'zzz', cursor: null })).toEqual({
      data: [],
      page: { limit: 1, next: null },
    });
  });
});

@Component({ template: '' })
class Host {
  readonly ids = signal<string[]>([]);
  readonly names = selectionNames(this.ids, (ids) => this.resolve(ids));
  resolve: (ids: readonly string[]) => Promise<Record<string, string>> = () => Promise.resolve({});
}

describe('selectionNames', () => {
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve));
  afterEach(() => vi.restoreAllMocks());

  it('resolves nothing without ids', async () => {
    const fixture = TestBed.createComponent(Host);
    const resolve = vi.spyOn(fixture.componentInstance, 'resolve');
    await fixture.whenStable();
    expect(resolve).not.toHaveBeenCalled();
    expect(fixture.componentInstance.names()).toEqual({});
  });

  it('resolves the names of the ids and keeps the ones found before', async () => {
    const fixture = TestBed.createComponent(Host);
    const host = fixture.componentInstance;
    host.resolve = (ids) => Promise.resolve(Object.fromEntries(ids.map((id) => [id, `N ${id}`])));
    host.ids.set(['a']);
    await fixture.whenStable();
    await settle();
    host.ids.set(['b']);
    await fixture.whenStable();
    await settle();
    expect(host.names()).toEqual({ a: 'N a', b: 'N b' });
  });

  it('only warns when the names cannot be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fixture = TestBed.createComponent(Host);
    const host = fixture.componentInstance;
    host.resolve = () => Promise.reject(new Error('offline /lookup/customers?ids=a'));
    host.ids.set(['a']);
    await fixture.whenStable();
    await settle();
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      'Cannot read the names of the selection',
      'unexpected',
    );
    expect(host.names()).toEqual({});
  });

  it('logs only the code of an error of the server, never its URL', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fixture = TestBed.createComponent(Host);
    const host = fixture.componentInstance;
    host.resolve = () =>
      Promise.reject(new ApiError({ status: 500, code: 'INTERNAL_ERROR', message: 'Failure' }));
    host.ids.set(['a']);
    await fixture.whenStable();
    await settle();
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      'Cannot read the names of the selection',
      'INTERNAL_ERROR',
    );
  });

  it('ignores names that arrive after the component was destroyed', async () => {
    const fixture = TestBed.createComponent(Host);
    const host = fixture.componentInstance;
    let finish: (names: Record<string, string>) => void = () => undefined;
    host.resolve = () => new Promise((resolve) => (finish = resolve));
    host.ids.set(['a']);
    await fixture.whenStable();
    fixture.destroy();
    finish({ a: 'Late' });
    await settle();
    expect(host.names()).toEqual({});
  });
});
