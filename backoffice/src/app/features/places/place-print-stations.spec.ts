import { backend } from '../../../testing/api';
import {
  CATEGORY_1,
  CENTER,
  fakePlace,
  PLACE_URL,
  renderPlace,
  STATION,
  STATION_ID,
} from '../../../testing/places';
import {
  cleanUp,
  clickIn,
  failSave,
  READ_ONLY,
  savePut,
  submitTab,
  typeWithin,
  within,
} from '../../../testing/places-tabs';

const L = (key: string) => `PLACES.STATIONS.${key}`;
const SECOND = { ...STATION, id: 'ps00002', name: 'Bar', host: '192.168.1.21' };
const STORED_STATION = { ...STATION, pulseNumberSecondary: null };
const STORED_CENTER = { ...CENTER };

afterEach(cleanUp);

type View = Awaited<ReturnType<typeof renderPlace>>;
const stations = (view: View) => [...view.root.querySelectorAll<HTMLElement>('article.station')];
const centers = (view: View) => [...view.root.querySelectorAll<HTMLElement>('article.center')];
const box = (row: HTMLElement, label: string) => within(row, label) as HTMLInputElement;
const tick = async (view: View, row: HTMLElement, label: string, checked: boolean) => {
  const box = within(row, label) as HTMLInputElement;
  box.checked = checked;
  box.dispatchEvent(new Event('change'));
  await view.view();
};
const twoStations = () =>
  fakePlace({
    printStations: {
      stations: [STATION, SECOND],
      productionCenters: [CENTER],
      stationsEditable: true,
      productionCentersEditable: true,
    },
  });

describe('PlacePrintStations', () => {
  it('shows the stored stations and centers', async () => {
    const view = await renderPlace({ path: 'print-stations' });
    const [row] = stations(view);
    expect(within(row, L('NAME')).value).toBe('Cucina');
    expect(within(row, L('DRIVER')).value).toBe('EPSON-EPOS-PRINT');
    expect([...within(row, L('DRIVER')).querySelectorAll('option')].map((o) => o.value)).toEqual([
      '',
      'EPSON-EPOS-PRINT',
      'ESCPOS',
    ]);
    expect(within(row, L('HOST')).value).toBe('192.168.1.20');
    expect(within(row, L('PULSE_NUMBER')).value).toBe('1');
    expect(within(row, L('PULSE_NUMBER_SECONDARY')).value).toBe('');
    expect(box(row, L('UPSIDE_DOWN')).checked).toBe(false);
    expect(box(row, L('EXITS_CUT')).checked).toBe(false);
    expect(box(row, 'Bevande').checked).toBe(false);
    expect(row.textContent).toContain(L('SUMMARY_NO_STATIONS'));
    const [center] = centers(view);
    expect(within(center, L('CENTER_NAME')).value).toBe('Forno');
    expect(within(center, L('CAPACITY')).value).toBe('10');
  });

  it('keeps a driver the form does not know', async () => {
    const place = fakePlace({
      printStations: {
        stations: [{ ...STATION, driver: 'OLD-DRIVER' }],
        productionCenters: [],
        stationsEditable: true,
        productionCentersEditable: true,
      },
    });
    const view = await renderPlace({ path: 'print-stations', place });
    expect(within(stations(view)[0], L('DRIVER')).value).toBe('OLD-DRIVER');
    expect(view.text()).toContain(L('CENTERS_EMPTY'));
  });

  it('says so when the place has no stations', async () => {
    const place = fakePlace({
      printStations: {
        stations: [],
        productionCenters: [],
        stationsEditable: true,
        productionCentersEditable: true,
      },
    });
    const view = await renderPlace({ path: 'print-stations', place });
    expect(stations(view)).toHaveLength(0);
    expect(view.text()).toContain(L('STATIONS_EMPTY'));
  });

  it('saves a changed station and center with the exact block', async () => {
    const view = await renderPlace({ path: 'print-stations' });
    const [row] = stations(view);
    await typeWithin(view, row, L('NAME'), 'Pizzeria');
    await typeWithin(view, row, L('DRIVER'), 'ESCPOS');
    await typeWithin(view, row, L('PULSE_NUMBER_SECONDARY'), '2');
    await tick(view, row, L('UPSIDE_DOWN'), true);
    await tick(view, row, L('EXITS_CUT'), true);
    await tick(view, row, 'Bevande', true);
    const [center] = centers(view);
    await typeWithin(view, center, L('CENTER_NAME'), 'Forno 2');
    await typeWithin(view, center, L('CAPACITY'), '12');
    await savePut(view, 'print-stations', {
      stations: [
        {
          ...STORED_STATION,
          name: 'Pizzeria',
          driver: 'ESCPOS',
          pulseNumberSecondary: 2,
          upsideDown: true,
          exitsCut: true,
          summaryCategoriesIds: [CATEGORY_1],
        },
      ],
      productionCenters: [{ ...STORED_CENTER, name: 'Forno 2', capacity: 12 }],
    });
    expect(view.toasts()).toEqual(['PLACES.SAVED']);
  });

  it('toggles the summary of the categories and of the other stations on and off', async () => {
    const view = await renderPlace({ path: 'print-stations', place: twoStations() });
    const [first] = stations(view);
    expect(within(first, 'Bar')).toBeDefined();
    await tick(view, first, 'Bar', true);
    await tick(view, first, 'Bevande', true);
    await tick(view, first, 'Dolci', true);
    await tick(view, first, 'Dolci', false);
    await tick(view, first, 'Bar', false);
    await tick(view, first, 'Bar', true);
    await savePut(view, 'print-stations', {
      stations: [
        {
          ...STORED_STATION,
          summaryPrintStationsIds: ['ps00002'],
          summaryCategoriesIds: [CATEGORY_1],
        },
        { ...SECOND, pulseNumberSecondary: null },
      ],
      productionCenters: [STORED_CENTER],
    });
  });

  it('sends a new station and a new center without id; an empty capacity is zero', async () => {
    const view = await renderPlace({ path: 'print-stations' });
    await view.click(L('ADD_STATION'));
    await view.click(L('ADD_CENTER'));
    const row = stations(view)[1];
    expect(within(row, L('DRIVER')).value).toBe('EPSON-EPOS-PRINT');
    expect(row.querySelector('strong')?.textContent).toBe(L('NEW_STATION'));
    await typeWithin(view, row, L('NAME'), 'Bar');
    await typeWithin(view, row, L('HOST'), '10.0.0.5');
    await typeWithin(view, row, L('PULSE_NUMBER'), '3');
    await typeWithin(view, centers(view)[1], L('CENTER_NAME'), 'Bancone');
    const body = (await savePut(view, 'print-stations', {
      stations: [
        STORED_STATION,
        {
          name: 'Bar',
          driver: 'EPSON-EPOS-PRINT',
          host: '10.0.0.5',
          pulseNumber: 3,
          pulseNumberSecondary: null,
          upsideDown: false,
          exitsCut: false,
          summaryCategoriesIds: [],
          summaryPrintStationsIds: [],
        },
      ],
      productionCenters: [STORED_CENTER, { name: 'Bancone', capacity: 0 }],
    })) as { stations: object[]; productionCenters: object[] };
    expect(body.stations[1]).not.toHaveProperty('id');
    expect(body.productionCenters[1]).not.toHaveProperty('id');
  });

  it('a new station without id cannot be chosen in a summary', async () => {
    const view = await renderPlace({ path: 'print-stations' });
    await view.click(L('ADD_STATION'));
    await typeWithin(view, stations(view)[1], L('NAME'), 'Nuova');
    expect(stations(view)[0].textContent).not.toContain('Nuova');
  });

  it('removes a center', async () => {
    const view = await renderPlace({ path: 'print-stations' });
    await clickIn(view, centers(view)[0], 'PLACES.REMOVE');
    expect(centers(view)).toHaveLength(0);
    await savePut(view, 'print-stations', { stations: [STORED_STATION], productionCenters: [] });
  });

  it('removes a station and the references to it in the other stations, devices and rooms', async () => {
    const view = await renderPlace({ path: 'print-stations', place: twoStations() });
    await tick(view, stations(view)[1], 'Cucina', true);
    await clickIn(view, stations(view)[0], 'PLACES.REMOVE');
    expect(stations(view)).toHaveLength(1);
    await view.click('COMMON.SAVE');
    const request = backend().expectOne(PLACE_URL);
    const body = request.request.body as Record<string, Record<string, unknown>>;
    expect(Object.keys(body).sort()).toEqual(['devices', 'printStations', 'rooms']);
    expect(body['printStations']['stations']).toEqual([
      { ...SECOND, pulseNumberSecondary: null, summaryPrintStationsIds: [] },
    ]);
    expect(
      (body['devices']['items'] as { printStations: string[] }[]).map((d) => d.printStations),
    ).toEqual([[], []]);
    expect((body['rooms']['items'] as { printStations: string[] }[])[0].printStations).toEqual([]);
    request.flush({ data: fakePlace() }, { headers: { ETag: '"v2"' } });
    await view.view();
  });

  it('removing a station not saved yet leaves the references alone', async () => {
    const view = await renderPlace({ path: 'print-stations' });
    await view.click(L('ADD_STATION'));
    await clickIn(view, stations(view)[1], 'PLACES.REMOVE');
    expect(stations(view)).toHaveLength(1);
    expect(view.root.querySelector('button[aria-label*="Cucina"]')).not.toBeNull();
    expect(STATION_ID).toBeDefined();
  });

  it('does not save a station without name or host', async () => {
    const view = await renderPlace({ path: 'print-stations' });
    await view.click(L('ADD_STATION'));
    await view.click(L('ADD_CENTER'));
    await view.click('COMMON.SAVE');
    expect(view.root.querySelectorAll('.error span').length).toBeGreaterThanOrEqual(3);
    expect(view.root.textContent).toContain('FORM.ISSUE.REQUIRED');
  });

  it('puts the 422 of rows and lists on their controls', async () => {
    const view = await renderPlace({ path: 'print-stations', place: twoStations() });
    await typeWithin(view, stations(view)[0], L('NAME'), 'Altro');
    await failSave(view, [
      { field: 'printStations.stations', issue: 'incorrect' },
      { field: 'printStations.stations.0.host', issue: 'incorrect' },
      { field: 'printStations.stations.0.summaryPrintStationsIds', issue: 'incorrect' },
      { field: 'printStations.stations.0.summaryCategoriesIds', issue: 'incorrect' },
      { field: 'printStations.productionCenters', issue: 'tooMany' },
      { field: 'printStations.productionCenters.0.capacity', issue: 'minimum' },
    ]);
    expect(view.root.querySelectorAll('[role=alert]').length).toBe(4);
    expect(within(stations(view)[0], L('HOST')).getAttribute('aria-invalid')).toBe('true');
    expect(within(centers(view)[0], L('CAPACITY')).getAttribute('aria-invalid')).toBe('true');
  });

  it('shows the stations read-only when the stored list cannot be changed, the centers stay editable', async () => {
    const place = fakePlace({
      printStations: {
        stations: [STATION],
        productionCenters: [CENTER],
        stationsEditable: false,
        productionCentersEditable: true,
      },
    });
    const view = await renderPlace({ path: 'print-stations', place });
    expect(view.text()).toContain(L('STATIONS_NOT_EDITABLE'));
    expect(view.text()).not.toContain(L('CENTERS_NOT_EDITABLE'));
    expect(view.button(L('ADD_STATION'))).toBeUndefined();
    expect(box(stations(view)[0], L('NAME')).disabled).toBe(true);
    expect(box(stations(view)[0], 'Bevande').disabled).toBe(true);
    expect(stations(view)[0].querySelector('button')).toBeNull();
    expect(view.button(L('ADD_CENTER'))).toBeDefined();
    expect(box(centers(view)[0], L('CENTER_NAME')).disabled).toBe(false);
  });

  it('shows the centers read-only when their stored list cannot be changed', async () => {
    const place = fakePlace({
      printStations: {
        stations: [STATION],
        productionCenters: [CENTER],
        stationsEditable: true,
        productionCentersEditable: false,
      },
    });
    const view = await renderPlace({ path: 'print-stations', place });
    expect(view.text()).toContain(L('CENTERS_NOT_EDITABLE'));
    expect(view.button(L('ADD_CENTER'))).toBeUndefined();
    expect(box(centers(view)[0], L('CENTER_NAME')).disabled).toBe(true);
    expect(centers(view)[0].querySelector('button')).toBeNull();
    expect(view.button(L('ADD_STATION'))).toBeDefined();
  });

  it('is read-only without the permission to update', async () => {
    const view = await renderPlace({ path: 'print-stations', permissions: READ_ONLY });
    expect(box(stations(view)[0], L('NAME')).disabled).toBe(true);
    expect(view.button(L('ADD_STATION'))).toBeUndefined();
    expect(view.button(L('ADD_CENTER'))).toBeUndefined();
    expect(view.button('COMMON.SAVE')).toBeUndefined();
  });

  it('ignores the submit of the form', async () => {
    const view = await renderPlace({ path: 'print-stations' });
    await submitTab(view);
    await view.blurAll();
  });
});
