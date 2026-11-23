import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { I18nService } from '../../core/i18n/i18n.service';
import { settle } from '../../../testing/api';
import { StationsModel } from './category-model';
import { PlaceSetupReader, SetupState } from './category-place-setup';
import { CategoryStations } from './category-stations';

const PLACES = [
  { id: 'p1', name: 'Negozio 1' },
  { id: 'p2', name: 'Negozio 2' },
];
const READY: SetupState = {
  status: 'ready',
  setup: {
    stations: [
      { id: 's1', name: 'Cucina' },
      { id: 's2', name: 'Bar' },
    ],
    centers: [],
    storages: [],
  },
};

@Component({
  imports: [CategoryStations],
  template: `<fc-category-stations
    groupId="g1"
    [places]="places()"
    [(value)]="value"
    [error]="error()"
    [disabled]="disabled()"
  />`,
})
class Host {
  readonly places = signal(PLACES);
  readonly value = signal<StationsModel>({ rooms: { p1: ['s1'] }, counter: { out: ['x'] } });
  readonly error = signal<string | null>(null);
  readonly disabled = signal(false);
}

async function render(value?: StationsModel) {
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
  if (value) {
    fixture.componentInstance.value.set(value);
  }
  document.body.appendChild(fixture.nativeElement);
  await settle();
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  const view = async () => {
    await settle();
    await fixture.whenStable();
  };
  const details = () => [...root.querySelectorAll<HTMLDetailsElement>('details')];
  const boxes = (d: number) => [...details()[d].querySelectorAll<HTMLInputElement>('input[type=checkbox]')];
  const stations = fixture.debugElement.children[0].componentInstance as CategoryStations;
  const put = async (...entries: [string, SetupState][]) => {
    states.set(new Map(entries));
    await view();
  };
  return { fixture, host: fixture.componentInstance, root, view, details, boxes, states, load, put, stations };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('CategoryStations', () => {
  it('says there are no stores when none is listed', async () => {
    const { host, root, view, details } = await render();
    host.places.set([]);
    await view();
    expect(details()).toHaveLength(0);
    expect(root.querySelector('.note')?.textContent).toBe('PRODUCT_CATEGORIES.STATIONS.NO_PLACES');
  });

  it('opens at start the stores that have a choice, reads only those and counts the choices', async () => {
    const { details, load, root } = await render({ rooms: { p1: ['s1'] }, counter: { p1: ['s2'] } });
    expect(details().map((d) => d.open)).toEqual([true, false]);
    expect(load).toHaveBeenCalledWith('g1', 'p1');
    expect(load).not.toHaveBeenCalledWith('g1', 'p2');
    expect(root.querySelectorAll('.count')).toHaveLength(1);
    expect(root.querySelector('.count')?.textContent).toBe('PRODUCT_CATEGORIES.STATIONS.CHOSEN {"count":2}');
  });

  it('reads a store when its section is opened and forgets the opening when it is closed', async () => {
    const { details, load, view } = await render({ rooms: {}, counter: {} });
    expect(load).not.toHaveBeenCalled();
    details()[1].open = true;
    details()[1].dispatchEvent(new Event('toggle'));
    await view();
    expect(load).toHaveBeenCalledWith('g1', 'p2');
    details()[1].open = false;
    details()[1].dispatchEvent(new Event('toggle'));
    await view();
    expect(details()[1].open).toBe(false);
  });

  it('shows loading while the setup is not known or is being read', async () => {
    const { details, put } = await render();
    expect(details()[0].querySelector('[role=status]')?.textContent).toBe('COMMON.LOADING');
    await put(['p1', { status: 'loading' }]);
    expect(details()[0].querySelector('[role=status]')?.textContent).toBe('COMMON.LOADING');
  });

  it('shows the error with a retry that reads the store again', async () => {
    const { details, put, load } = await render();
    await put(['p1', { status: 'error' }]);
    expect(details()[0].querySelector('[role=alert]')?.textContent).toBe('PRODUCT_CATEGORIES.STATIONS.LOAD_ERROR');
    load.mockClear();
    details()[0].querySelector('button')!.click();
    expect(load).toHaveBeenCalledWith('g1', 'p1');
  });

  it('says a store has no stations', async () => {
    const { details, put } = await render();
    await put(['p1', { status: 'ready', setup: { stations: [], centers: [], storages: [] } }]);
    expect(details()[0].querySelector('.note')?.textContent).toBe('PRODUCT_CATEGORIES.STATIONS.NONE');
  });

  it('chooses and unchooses the stations for the rooms and for the counter, keeping the other stores', async () => {
    const { host, boxes, put, view } = await render();
    await put(['p1', READY], ['p2', READY]);
    expect(boxes(0).map((b) => b.checked)).toEqual([true, false, false, false]);
    expect(boxes(1).map((b) => b.checked)).toEqual([false, false, false, false]);
    boxes(0)[1].checked = true;
    boxes(0)[1].dispatchEvent(new Event('change'));
    await view();
    expect(host.value().rooms['p1']).toEqual(['s1', 's2']);
    boxes(0)[2].checked = true;
    boxes(0)[2].dispatchEvent(new Event('change'));
    await view();
    expect(host.value().counter).toEqual({ out: ['x'], p1: ['s1'] });
    boxes(1)[0].checked = true;
    boxes(1)[0].dispatchEvent(new Event('change'));
    await view();
    expect(host.value().rooms).toEqual({ p1: ['s1', 's2'], p2: ['s1'] });
    boxes(0)[0].checked = false;
    boxes(0)[0].dispatchEvent(new Event('change'));
    await view();
    expect(host.value().rooms['p1']).toEqual(['s2']);
    expect(host.value().counter['out']).toEqual(['x']);
  });

  it('disables the checkboxes', async () => {
    const { host, details, put, view } = await render();
    await put(['p1', READY]);
    const fieldsets = () => [...details()[0].querySelectorAll('fieldset')];
    expect(fieldsets().map((f) => f.disabled)).toEqual([false, false]);
    host.disabled.set(true);
    await view();
    expect(fieldsets().map((f) => f.disabled)).toEqual([true, true]);
  });

  it('shows the error as an alert linked to the stores', async () => {
    const { host, root, view } = await render();
    expect(root.querySelector('[role=alert]')).toBeNull();
    expect(root.querySelector('.stores')?.hasAttribute('aria-describedby')).toBe(false);
    host.error.set('Non valido');
    await view();
    const alert = root.querySelector('p.problem[role=alert]');
    expect(alert?.textContent).toBe('Non valido');
    expect(root.querySelector('.stores')?.getAttribute('aria-describedby')).toBe(alert?.id);
  });

  it('focuses the summary of the first store, and does nothing without stores', async () => {
    const { host, root, view, stations } = await render();
    stations.focus();
    expect(document.activeElement).toBe(root.querySelector('summary'));
    host.places.set([]);
    await view();
    expect(() => stations.focus()).not.toThrow();
  });
});
