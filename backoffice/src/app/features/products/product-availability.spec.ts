import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { settle } from '../../../testing/api';
import { I18nService } from '../../core/i18n/i18n.service';
import { PlaceSetupReader, SetupState } from '../product-categories/category-place-setup';
import { ProductPlaceRow } from './product-model';
import { ProductAvailability } from './product-availability';

const PLACES = [
  { id: 'p1', name: 'Negozio 1' },
  { id: 'p2', name: 'Negozio 2' },
];
const ready = (...centers: string[]): SetupState => ({
  status: 'ready',
  setup: { stations: [], centers: centers.map((id) => ({ id, name: `Centro ${id}` })), storages: [] },
});
const ROW: ProductPlaceRow = { placeId: 'p1', favorite: false, favoriteHandheld: false, position: '3', productionCenterId: 'old' };

@Component({
  imports: [ProductAvailability],
  template: `<fc-product-availability
    groupId="g1"
    [places]="places()"
    [(value)]="value"
    [rooms]="rooms()"
    [error]="error()"
    [disabled]="disabled()"
  />`,
})
class Host {
  readonly places = signal(PLACES);
  readonly value = signal<ProductPlaceRow[]>([ROW]);
  readonly rooms = signal(false);
  readonly error = signal<string | null>(null);
  readonly disabled = signal(false);
}

async function render() {
  const states = signal<ReadonlyMap<string, SetupState>>(new Map());
  const load = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: PlaceSetupReader, useValue: { states, load } },
    ],
  });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  const fixture = TestBed.createComponent(Host);
  document.body.appendChild(fixture.nativeElement);
  const view = async () => {
    await settle();
    await fixture.whenStable();
  };
  await view();
  const root = fixture.nativeElement as HTMLElement;
  const rows = () => [...root.querySelectorAll<HTMLElement>('ul > li')];
  const checks = (i: number) => [...rows()[i].querySelectorAll<HTMLInputElement>('input[type=checkbox]')];
  const text = (i: number) => rows()[i].querySelector<HTMLInputElement>('input:not([type=checkbox])')!;
  const select = (i: number) => rows()[i].querySelector<HTMLSelectElement>('select')!;
  const toggle = async (box: HTMLInputElement, on: boolean) => {
    box.checked = on;
    box.dispatchEvent(new Event('change'));
    await view();
  };
  const component = fixture.debugElement.children[0].componentInstance as ProductAvailability;
  return { host: fixture.componentInstance, root, view, rows, checks, text, select, toggle, states, load, component };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('ProductAvailability', () => {
  it('says there are no stores when none is listed', async () => {
    const { host, root, view } = await render();
    host.places.set([]);
    await view();
    expect(root.querySelector('li.note')?.textContent).toBe('PRODUCT_CATEGORIES.AVAILABILITY.NO_PLACES');
  });

  it('shows details only for the chosen stores and reads their centers once', async () => {
    const { rows, checks, text, select, load } = await render();
    expect(rows()).toHaveLength(2);
    expect(checks(0)[0].checked).toBe(true);
    expect(checks(1)).toHaveLength(1);
    expect(checks(1)[0].checked).toBe(false);
    expect(text(0).value).toBe('3');
    expect(select(0).value).toBe('old');
    expect(load).toHaveBeenCalledWith('g1', 'p1');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('chooses a store, reads its centers, and unchooses it', async () => {
    const { host, checks, toggle, load } = await render();
    await toggle(checks(1)[0], true);
    expect(host.value()).toEqual([ROW, { placeId: 'p2', favorite: false, favoriteHandheld: false, position: '', productionCenterId: '' }]);
    expect(load).toHaveBeenCalledWith('g1', 'p2');
    await toggle(checks(0)[0], false);
    expect(host.value().map((row) => row.placeId)).toEqual(['p2']);
  });

  it('keeps the chosen stores that are not listed', async () => {
    const { host, checks, toggle, view } = await render();
    host.value.set([{ ...ROW, placeId: 'out' }]);
    await view();
    await toggle(checks(1)[0], true);
    expect(host.value().map((row) => row.placeId)).toEqual(['out', 'p2']);
  });

  it('sets the favorite, and the favorite of the handhelds only with rooms', async () => {
    const { host, checks, toggle, view } = await render();
    expect(checks(0)).toHaveLength(2);
    await toggle(checks(0)[1], true);
    expect(host.value()[0].favorite).toBe(true);
    host.rooms.set(true);
    await view();
    expect(checks(0)).toHaveLength(3);
    await toggle(checks(0)[2], true);
    expect(host.value()[0]).toEqual({ ...ROW, favorite: true, favoriteHandheld: true });
  });

  it('changes the position and the production center of that store only', async () => {
    const { host, text, select, states, view } = await render();
    host.value.set([ROW, { ...ROW, placeId: 'p2', productionCenterId: '' }]);
    states.set(new Map([['p1', ready('c1', 'c2')]]));
    await view();
    text(1).value = '9';
    text(1).dispatchEvent(new Event('input'));
    await view();
    select(0).value = 'c2';
    select(0).dispatchEvent(new Event('change'));
    await view();
    expect(host.value()).toEqual([
      { ...ROW, productionCenterId: 'c2' },
      { ...ROW, placeId: 'p2', position: '9', productionCenterId: '' },
    ]);
  });

  it('offers the centers of the store and keeps the current one even when it is not offered', async () => {
    const { select, states, view } = await render();
    const options = () => [...select(0).options].map((o) => o.value);
    expect(options()).toEqual(['', 'old']);
    states.set(new Map([['p1', ready('c1')]]));
    await view();
    expect(options()).toEqual(['', 'c1', 'old']);
    states.set(new Map([['p1', ready('old', 'c1')]]));
    await view();
    expect(options()).toEqual(['', 'old', 'c1']);
  });

  it('flags a position that is not a whole number from 0 to 1,000,000', async () => {
    const { host, root, view } = await render();
    const message = () => root.querySelector('.error span')?.textContent;
    expect(message()).toBeUndefined();
    for (const [value, expected] of [
      ['x', 'FORM.ISSUE.TYPE'],
      ['1.5', 'FORM.ISSUE.TYPE'],
      ['-1', 'FORM.ISSUE.MINIMUM'],
      ['1000001', 'FORM.ISSUE.MAXIMUM'],
    ]) {
      host.value.set([{ ...ROW, position: value }]);
      await view();
      expect(message(), value).toBe(expected);
    }
    host.value.set([{ ...ROW, position: '' }]);
    await view();
    expect(message()).toBeUndefined();
  });

  it('shows the failed read of the centers with a retry', async () => {
    const { root, states, view, load } = await render();
    expect(root.querySelector('[role=alert]')).toBeNull();
    states.set(new Map<string, SetupState>([['p1', { status: 'error' }]]));
    await view();
    expect(root.querySelector('p.problem[role=alert]')?.textContent).toBe('PRODUCTS.AVAILABILITY.CENTERS_ERROR');
    load.mockClear();
    root.querySelector<HTMLButtonElement>('.actions button')!.click();
    expect(load).toHaveBeenCalledWith('g1', 'p1');
  });

  it('disables every control', async () => {
    const { host, checks, text, select, view } = await render();
    host.rooms.set(true);
    host.disabled.set(true);
    await view();
    expect([...checks(0), ...checks(1), text(0), select(0)].every((control) => control.disabled)).toBe(true);
  });

  it('shows the error as an alert linked to the list', async () => {
    const { host, root, view } = await render();
    expect(root.querySelector('ul')?.hasAttribute('aria-describedby')).toBe(false);
    host.error.set('Non valido');
    await view();
    const alert = root.querySelector('p.problem[role=alert]');
    expect(alert?.textContent).toBe('Non valido');
    expect(root.querySelector('ul')?.getAttribute('aria-describedby')).toBe(alert?.id);
  });

  it('focuses the first checkbox, and does nothing without stores', async () => {
    const { host, checks, view, component } = await render();
    component.focus();
    expect(document.activeElement).toBe(checks(0)[0]);
    host.places.set([]);
    await view();
    expect(() => component.focus()).not.toThrow();
  });
});
