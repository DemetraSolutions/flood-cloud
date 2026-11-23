import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { I18nService } from '../../core/i18n/i18n.service';
import { settle } from '../../../testing/api';
import { PlaceRow } from './category-model';
import { PlaceSetupReader, SetupState } from './category-place-setup';
import { CategoryAvailability } from './category-availability';

const PLACES = [
  { id: 'p1', name: 'Negozio 1' },
  { id: 'p2', name: 'Negozio 2' },
];
const ready = (...centers: string[]): SetupState => ({
  status: 'ready',
  setup: { stations: [], centers: centers.map((id) => ({ id, name: `Centro ${id}` })), storages: [] },
});

@Component({
  imports: [CategoryAvailability],
  template: `<fc-category-availability
    groupId="g1"
    [places]="places()"
    [(value)]="value"
    [error]="error()"
    [disabled]="disabled()"
  />`,
})
class Host {
  readonly places = signal(PLACES);
  readonly value = signal<PlaceRow[]>([{ placeId: 'p1', position: '3', productionCenterId: 'old' }]);
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
  await settle();
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  const view = async () => {
    await settle();
    await fixture.whenStable();
  };
  const rows = () => [...root.querySelectorAll<HTMLElement>('li')];
  const check = (i: number) => rows()[i].querySelector<HTMLInputElement>('input[type=checkbox]')!;
  const text = (i: number) => rows()[i].querySelector<HTMLInputElement>('input:not([type=checkbox])')!;
  const select = (i: number) => rows()[i].querySelector<HTMLSelectElement>('select')!;
  const component = fixture.debugElement.children[0].componentInstance as CategoryAvailability;
  return { fixture, host: fixture.componentInstance, root, view, rows, check, text, select, states, load, component };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('CategoryAvailability', () => {
  it('says there are no stores when none is listed', async () => {
    const { host, root, view } = await render();
    host.places.set([]);
    await view();
    expect(root.querySelector('li.note')?.textContent).toBe('PRODUCT_CATEGORIES.AVAILABILITY.NO_PLACES');
  });

  it('shows a row for each store, with position and center only for the chosen ones', async () => {
    const { rows, check, text, select, load } = await render();
    expect(rows()).toHaveLength(2);
    expect(check(0).checked).toBe(true);
    expect(check(1).checked).toBe(false);
    expect(text(0).value).toBe('3');
    expect(rows()[1].querySelector('.details')).toBeNull();
    expect(select(0).value).toBe('old');
    expect(load).toHaveBeenCalledWith('g1', 'p1');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('chooses a store, reads its centers, and unchooses it', async () => {
    const { host, check, view, load } = await render();
    check(1).checked = true;
    check(1).dispatchEvent(new Event('change'));
    await view();
    expect(host.value()).toEqual([
      { placeId: 'p1', position: '3', productionCenterId: 'old' },
      { placeId: 'p2', position: '', productionCenterId: '' },
    ]);
    expect(load).toHaveBeenCalledWith('g1', 'p2');
    check(0).checked = false;
    check(0).dispatchEvent(new Event('change'));
    await view();
    expect(host.value().map((r) => r.placeId)).toEqual(['p2']);
  });

  it('keeps the chosen stores that are not listed', async () => {
    const { host, check, view } = await render();
    host.value.set([{ placeId: 'out', position: '', productionCenterId: '' }]);
    await view();
    check(1).checked = true;
    check(1).dispatchEvent(new Event('change'));
    await view();
    expect(host.value().map((r) => r.placeId)).toEqual(['out', 'p2']);
  });

  it('changes the position and the production center of a store only', async () => {
    const { host, text, select, states, view } = await render();
    states.set(new Map([['p1', ready('c1', 'c2')]]));
    await view();
    text(0).value = '7';
    text(0).dispatchEvent(new Event('input'));
    await view();
    expect(host.value()[0].position).toBe('7');
    select(0).value = 'c2';
    select(0).dispatchEvent(new Event('change'));
    await view();
    expect(host.value()[0]).toEqual({ placeId: 'p1', position: '7', productionCenterId: 'c2' });
  });

  it('leaves the other chosen stores alone when one changes', async () => {
    const { host, text, view } = await render();
    host.value.set([
      { placeId: 'p1', position: '3', productionCenterId: '' },
      { placeId: 'p2', position: '', productionCenterId: '' },
    ]);
    await view();
    text(1).value = '9';
    text(1).dispatchEvent(new Event('input'));
    await view();
    expect(host.value()).toEqual([
      { placeId: 'p1', position: '3', productionCenterId: '' },
      { placeId: 'p2', position: '9', productionCenterId: '' },
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
    const { host, root, text, view } = await render();
    const message = () => root.querySelector('.error span')?.textContent;
    expect(message()).toBeUndefined();
    for (const [value, expected] of [
      ['x', 'FORM.ISSUE.TYPE'],
      ['1.5', 'FORM.ISSUE.TYPE'],
      ['-1', 'FORM.ISSUE.MINIMUM'],
      ['1000001', 'FORM.ISSUE.MAXIMUM'],
    ]) {
      host.value.set([{ placeId: 'p1', position: value, productionCenterId: '' }]);
      await view();
      expect(message(), value).toBe(expected);
    }
    for (const value of ['', '0', '1000000']) {
      host.value.set([{ placeId: 'p1', position: value, productionCenterId: '' }]);
      await view();
      expect(message(), value).toBeUndefined();
    }
    expect(text(0)).toBeTruthy();
  });

  it('shows the failed read of the centers with a retry', async () => {
    const { root, states, view, load } = await render();
    expect(root.querySelector('.failed')).toBeNull();
    states.set(new Map<string, SetupState>([['p1', { status: 'error' }]]));
    await view();
    expect(root.querySelector('.failed [role=alert]')?.textContent).toBe(
      'PRODUCT_CATEGORIES.AVAILABILITY.CENTERS_ERROR',
    );
    load.mockClear();
    root.querySelector<HTMLButtonElement>('.failed button')!.click();
    expect(load).toHaveBeenCalledWith('g1', 'p1');
  });

  it('disables every control', async () => {
    const { host, check, text, select, view } = await render();
    host.disabled.set(true);
    await view();
    expect([check(0).disabled, check(1).disabled, text(0).disabled, select(0).disabled]).toEqual([
      true,
      true,
      true,
      true,
    ]);
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
    const { host, check, view, component } = await render();
    component.focus();
    expect(document.activeElement).toBe(check(0));
    host.places.set([]);
    await view();
    expect(() => component.focus()).not.toThrow();
  });
});
