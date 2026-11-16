import { TestBed } from '@angular/core/testing';
import { backend } from '../../../testing/api';
import { PLACE_URL, fakePlace } from '../../../testing/places';
import {
  ETAG,
  drainSeries,
  expectPlace,
  fail,
  flushPlace,
  freshPlacePage,
  optionsOf,
  renderPlacePage,
} from '../../../testing/places-page';

const TIMEZONE = 'PLACES.HOURS.TIMEZONE';
const OPEN = 'PLACES.HOURS.OPEN';
const START = 'PLACES.HOURS.START';
const END = 'PLACES.HOURS.END';
const ADD_SLOT = 'PLACES.HOURS.ADD_SLOT';
const ADD_SPECIAL = 'PLACES.HOURS.ADD_SPECIAL';
const SAVE = 'COMMON.SAVE';

afterEach(() => {
  sessionStorage.clear();
  try {
    drainSeries();
    backend().verify();
  } finally {
    vi.restoreAllMocks();
    document.body.replaceChildren();
    TestBed.resetTestingModule();
  }
});

async function render(options: Parameters<typeof renderPlacePage>[0] = {}, again = false) {
  const view = await (again ? freshPlacePage : renderPlacePage)({
    path: 'opening-hours',
    ...options,
  });
  const schedule = (nth: number) => view.root.querySelectorAll('fc-hours-schedule')[nth];
  /** The fieldset of a day of the week (`1` Monday … `0` Sunday) of a schedule. */
  const day = (nth: number, number: string) =>
    [...schedule(nth).querySelectorAll('fieldset.row')].find(
      (set) => set.querySelector('legend')?.textContent?.trim() === `PLACES.DAY.${number}`,
    )!;
  /** The fieldset of the n-th special day of a schedule. */
  const special = (nth: number, index: number) =>
    [...schedule(nth).querySelectorAll('fieldset.row')].filter((set) =>
      set.querySelector('legend')?.textContent?.trim().startsWith('PLACES.HOURS.SPECIAL_DAY'),
    )[index];
  const buttonIn = (scope: Element, text: string, nth = 0) =>
    [...scope.querySelectorAll('button')].filter((b) => b.textContent?.trim() === text)[nth];
  const press = async (scope: Element, text: string, nth = 0) => {
    buttonIn(scope, text, nth).click();
    await view.view();
  };
  return { ...view, schedule, day, special, buttonIn, press };
}

/** The place with a Tuesday and a special day that has slots. */
function busyPlace() {
  const base = fakePlace();
  const week = { ...base.openingHours.week };
  week['2'] = {
    active: true,
    values: [
      { start: '08:00', end: '12:00' },
      { start: '14:00', end: '18:00' },
    ],
  };
  return fakePlace({
    openingHours: {
      ...base.openingHours,
      week,
      special: { '2026-12-24': { closed: false, values: [{ start: '09:00', end: '13:00' }] } },
    },
  });
}

describe('PlaceHours', () => {
  describe('display', () => {
    it('shows the time zone, the week and the special days with save disabled', async () => {
      const { control, button, day, schedule, special, within } = await render();
      expect(control(TIMEZONE).value).toBe('Europe/Rome');
      expect((within(day(0, '1'), OPEN) as HTMLInputElement).checked).toBe(true);
      expect((within(day(0, '2'), OPEN) as HTMLInputElement).checked).toBe(false);
      expect(within(day(0, '1'), `${START} 1`).value).toBe('09:00');
      expect(within(day(0, '1'), `${END} 1`).value).toBe('18:00');
      expect(within(special(0, 0), 'PLACES.HOURS.DATE').value).toBe('2026-12-25');
      expect((within(special(0, 0), 'PLACES.HOURS.CLOSED') as HTMLInputElement).checked).toBe(true);
      expect(special(0, 0).querySelector('fc-rows-editor')).toBeNull();
      expect(schedule(0).textContent).toContain('PLACES.DAY.0');
      expect(button(SAVE)?.disabled).toBe(true);
    });

    it('offers the time zones of the browser and UTC, and keeps a stored zone that is not among them', async () => {
      const { control } = await render();
      const zones = optionsOf(control(TIMEZONE) as HTMLSelectElement);
      expect(zones).toContain('Europe/Rome');
      expect(zones).toContain('UTC');
      expect(zones).not.toContain('Mars/Olympus');
      const odd = await render(
        {
          place: fakePlace({
            openingHours: { ...fakePlace().openingHours, timezone: 'Mars/Olympus' },
          }),
        },
        true,
      );
      expect(odd.control(TIMEZONE).value).toBe('Mars/Olympus');
      expect(optionsOf(odd.control(TIMEZONE) as HTMLSelectElement)).toContain('Mars/Olympus');
    });

    it('shows the delivery hours only to a group with the restaurant module', async () => {
      const rooms = await render();
      expect(rooms.root.querySelectorAll('fc-hours-schedule')).toHaveLength(2);
      expect(rooms.text()).toContain('PLACES.HOURS.DELIVERY');
      const none = await render({ features: [] }, true);
      expect(none.root.querySelectorAll('fc-hours-schedule')).toHaveLength(1);
      expect(none.text()).not.toContain('PLACES.HOURS.DELIVERY');
    });

    it('never submits the form natively and marks the fields as touched when left', async () => {
      const { root, blurAll, special, within } = await render();
      const submit = new Event('submit', { cancelable: true });
      root.querySelector('form')!.dispatchEvent(submit);
      expect(submit.defaultPrevented).toBe(true);
      await blurAll();
      expect(within(special(0, 0), 'PLACES.HOURS.DATE').getAttribute('aria-invalid')).toBeNull();
    });

    it('is read-only without the permission to update', async () => {
      const { buttons, control, button, day, within } = await render({
        permissions: ['places:read', 'groups:read', 'profile:read'],
      });
      expect(control(TIMEZONE).disabled).toBe(true);
      expect(within(day(0, '1'), OPEN).disabled).toBe(true);
      expect(button(SAVE)).toBeUndefined();
      expect(buttons().filter((b) => b.textContent?.trim() === ADD_SPECIAL)).toHaveLength(0);
      expect(buttons().filter((b) => b.textContent?.trim() === ADD_SLOT)).toHaveLength(0);
      expect(
        buttons().filter((b) => b.textContent?.trim().startsWith('PLACES.HOURS.REMOVE_SPECIAL')),
      ).toHaveLength(0);
    });
  });

  describe('week', () => {
    it('shows the slots of a day only while it is open', async () => {
      const { day, toggleIn, within } = await render();
      expect(day(0, '2').querySelector('fc-rows-editor')).toBeNull();
      await toggleIn(day(0, '2'), OPEN, true);
      expect(day(0, '2').querySelector('fc-rows-editor')).not.toBeNull();
      await toggleIn(day(0, '2'), OPEN, false);
      expect(day(0, '2').querySelector('fc-rows-editor')).toBeNull();
      expect(within(day(0, '1'), `${START} 1`).value).toBe('09:00');
    });

    it('adds and removes the slots of a day', async () => {
      const { day, press, typeIn, within, buttonIn } = await render({ place: busyPlace() });
      expect(within(day(0, '2'), `${START} 2`).value).toBe('14:00');
      await press(day(0, '2'), ADD_SLOT);
      expect(within(day(0, '2'), `${START} 3`).value).toBe('');
      await typeIn(day(0, '2'), `${START} 3`, '19:00');
      await typeIn(day(0, '2'), `${END} 3`, '22:00');
      expect(within(day(0, '2'), `${START} 3`).value).toBe('19:00');
      await press(day(0, '2'), 'PLACES.REMOVE', 0);
      expect(within(day(0, '2'), `${START} 1`).value).toBe('14:00');
      expect(within(day(0, '2'), `${START} 2`).value).toBe('19:00');
      expect(buttonIn(day(0, '2'), 'PLACES.REMOVE')?.getAttribute('aria-label')).toContain(
        'PLACES.REMOVE_ROW',
      );
    });

    it('disables the add button at the most slots of a day', async () => {
      const { day, press, buttonIn } = await render();
      for (let i = 0; i < 7; i++) {
        await press(day(0, '1'), ADD_SLOT);
      }
      expect(buttonIn(day(0, '1'), ADD_SLOT).disabled).toBe(true);
    });
  });

  describe('special days', () => {
    it('adds a special day that starts closed, and removes it', async () => {
      const { schedule, special, press, typeIn, within } = await render();
      await press(schedule(0), ADD_SPECIAL);
      expect(special(0, 1)).toBeDefined();
      expect(within(special(0, 1), 'PLACES.HOURS.DATE').value).toBe('');
      expect((within(special(0, 1), 'PLACES.HOURS.CLOSED') as HTMLInputElement).checked).toBe(true);
      await typeIn(special(0, 1), 'PLACES.HOURS.DATE', '2026-12-31');
      await press(special(0, 1), 'PLACES.HOURS.REMOVE_SPECIAL {"number":2}');
      expect(special(0, 1)).toBeUndefined();
      expect(special(0, 0)).toBeDefined();
    });

    it('shows the slots of a special day that is not closed and edits them', async () => {
      const { special, schedule, press, toggleIn, within } = await render({ place: busyPlace() });
      // A second special day must stay as it is while the first one changes.
      await press(schedule(0), ADD_SPECIAL);
      expect(within(special(0, 0), `${START} 1`).value).toBe('09:00');
      await press(special(0, 0), ADD_SLOT);
      expect(within(special(0, 0), `${START} 2`).value).toBe('');
      await press(special(0, 0), 'PLACES.REMOVE', 0);
      expect(within(special(0, 0), `${START} 1`).value).toBe('');
      await toggleIn(special(0, 0), 'PLACES.HOURS.CLOSED', true);
      expect(special(0, 0).querySelector('fc-rows-editor')).toBeNull();
    });

    it('edits the delivery hours apart from the opening hours', async () => {
      const { day, special, schedule, press, toggleIn, within } = await render();
      expect((within(day(1, '1'), OPEN) as HTMLInputElement).checked).toBe(true);
      await toggleIn(day(1, '2'), OPEN, true);
      expect(day(0, '2').querySelector('fc-rows-editor')).toBeNull();
      expect(day(1, '2').querySelector('fc-rows-editor')).not.toBeNull();
      await press(day(1, '2'), ADD_SLOT);
      await press(schedule(1), ADD_SPECIAL);
      expect(special(1, 0)).toBeDefined();
      await press(special(1, 0), 'PLACES.HOURS.REMOVE_SPECIAL {"number":1}');
      expect(special(1, 0)).toBeUndefined();
      expect(special(0, 0)).toBeDefined();
      await toggleIn(day(1, '2'), OPEN, false);
    });

    it('disables the add button at the most special days', async () => {
      const { schedule, press, buttonIn } = await render();
      for (let i = 0; i < 399; i++) {
        buttonIn(schedule(0), ADD_SPECIAL).click();
        await Promise.resolve();
      }
      await press(schedule(0), ADD_SPECIAL);
      expect(buttonIn(schedule(0), ADD_SPECIAL).disabled).toBe(true);
    });
  });

  describe('saving', () => {
    it('sends the whole block with a PUT', async () => {
      const { type, day, special, schedule, toggleIn, typeIn, press, click, toasts, view, button } =
        await render({ place: busyPlace() });
      await type(TIMEZONE, 'UTC');
      await toggleIn(day(0, '1'), OPEN, false);
      await typeIn(day(0, '2'), `${END} 2`, '19:30');
      await press(schedule(0), ADD_SPECIAL);
      await typeIn(special(0, 1), 'PLACES.HOURS.DATE', '2026-12-31');
      await toggleIn(day(1, '3'), OPEN, true);
      await press(day(1, '3'), ADD_SLOT);
      await typeIn(day(1, '3'), `${START} 1`, '11:00');
      await typeIn(day(1, '3'), `${END} 1`, '15:00');
      await click(SAVE);
      const req = expectPlace('/opening-hours');
      expect(req.request.method).toBe('PUT');
      expect(req.request.headers.get('If-Match')).toBe(ETAG);
      const closed = { active: false, values: [] };
      const deliveryWeek = Object.fromEntries(
        ['0', '1', '2', '3', '4', '5', '6'].map((n) => [
          n,
          n === '1'
            ? { active: true, values: [{ start: '09:00', end: '18:00' }] }
            : n === '3'
              ? { active: true, values: [{ start: '11:00', end: '15:00' }] }
              : closed,
        ]),
      );
      expect(req.request.body).toEqual({
        timezone: 'UTC',
        week: {
          '0': closed,
          '1': { active: false, values: [{ start: '09:00', end: '18:00' }] },
          '2': {
            active: true,
            values: [
              { start: '08:00', end: '12:00' },
              { start: '14:00', end: '19:30' },
            ],
          },
          '3': closed,
          '4': closed,
          '5': closed,
          '6': closed,
        },
        special: {
          '2026-12-24': { closed: false, values: [{ start: '09:00', end: '13:00' }] },
          '2026-12-31': { closed: true, values: [] },
        },
        deliveryTime: { week: deliveryWeek, special: {} },
      });
      flushPlace(
        req,
        fakePlace({ openingHours: { ...busyPlace().openingHours, timezone: 'UTC' } }),
      );
      await view();
      expect(toasts()).toEqual(['PLACES.SAVED']);
      expect(button(SAVE)?.disabled).toBe(true);
    });

    it('does not send anything while a slot time or a special date is empty', async () => {
      const { day, schedule, press, click, view, within, error, special } = await render();
      await press(day(0, '1'), ADD_SLOT);
      await press(schedule(0), ADD_SPECIAL);
      await click(SAVE);
      await view();
      expect(backend().match(PLACE_URL)).toHaveLength(0);
      expect(within(day(0, '1'), `${START} 2`).getAttribute('aria-invalid')).toBe('true');
      expect(within(day(0, '1'), `${END} 2`).getAttribute('aria-invalid')).toBe('true');
      expect(within(special(0, 1), 'PLACES.HOURS.DATE').getAttribute('aria-invalid')).toBe('true');
      expect(error(TIMEZONE)).toBe('');
    });

    it('requires the times of the slots of a special day and of the delivery hours', async () => {
      const { day, special, press, click, view, within } = await render({ place: busyPlace() });
      await press(special(0, 0), ADD_SLOT);
      await press(day(1, '1'), ADD_SLOT);
      await click(SAVE);
      await view();
      expect(backend().match(PLACE_URL)).toHaveLength(0);
      expect(within(special(0, 0), `${START} 2`).getAttribute('aria-invalid')).toBe('true');
      expect(within(day(1, '1'), `${END} 2`).getAttribute('aria-invalid')).toBe('true');
    });

    it('puts the errors of the server on the rows', async () => {
      const { day, typeIn, click, view, within, special } = await render();
      await typeIn(day(0, '1'), `${END} 1`, '19:00');
      await click(SAVE);
      fail(expectPlace('/opening-hours'), 422, 'VALIDATION_ERROR', [
        { field: 'openingHours.week.1.values.0.end', issue: 'invalid' },
        { field: 'openingHours.special.2026-12-25.closed', issue: 'invalid' },
      ]);
      await view();
      expect(within(day(0, '1'), `${END} 1`).getAttribute('aria-invalid')).toBe('true');
      expect(special(0, 0)).toBeDefined();
    });
  });
});
