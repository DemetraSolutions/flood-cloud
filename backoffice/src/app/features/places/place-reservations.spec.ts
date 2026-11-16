import { fakePlace, renderPlace, TEMPLATE_1, TEMPLATE_2 } from '../../../testing/places';
import {
  cleanUp,
  failPut,
  isChecked,
  READ_ONLY,
  savePut,
  storedBlock,
  submitTab,
  withValue,
} from '../../../testing/places-tabs';

const f = (key: string) => `PLACES.F.RESERVATIONS.${key}`;
const col = (key: string, row: number) => `PLACES.RESERVATIONS.${key} ${row}`;
const EMAILS = [
  'EMAIL_NOTIFICATION',
  'EMAIL',
  'EMAIL_CONFIRMED_STATUS',
  'EMAIL_REFUSED_STATUS',
  'EMAIL_CHANGE_STATUS',
];

afterEach(cleanUp);

/** The checkbox of a weekday in the nth time block. */
function dayBox(root: HTMLElement, row: number, day: number): HTMLInputElement {
  const block = root.querySelectorAll('fc-rows-editor .rows > .row')[row];
  const label = [...block.querySelectorAll('label')].find(
    (candidate) => candidate.textContent?.trim() === `PLACES.DAY.${day}`,
  ) as HTMLLabelElement;
  return block.querySelector(`#${label.htmlFor}`) as HTMLInputElement;
}

describe('PlaceReservations', () => {
  it('shows the stored data', async () => {
    const view = await renderPlace({ path: 'reservations' });
    expect(isChecked(view, f('STATUS'))).toBe(false);
    expect(view.control(f('STEP')).value).toBe('15');
    expect(view.control(f('STEP')).type).toBe('number');
    expect(view.control(f('DURATION')).value).toBe('30');
    expect(view.text()).toContain('PLACES.MINUTES_HINT');
    expect(view.control(f('WEB_WIDGET.COLOR')).type).toBe('color');
    expect(view.control(f('WEB_WIDGET.BRIGHTNESS')).value).toBe('light');
    expect(view.control(col('START', 1)).value).toBe('12:00');
    expect(view.control(col('END', 1)).value).toBe('14:00');
    expect(dayBox(view.root, 0, 1).checked).toBe(true);
    expect(dayBox(view.root, 0, 2).checked).toBe(true);
    expect(dayBox(view.root, 0, 3).checked).toBe(false);
  });

  it('shows the five email groups with a select of the email templates', async () => {
    const view = await renderPlace({ path: 'reservations' });
    for (const name of EMAILS) {
      expect(view.text()).toContain(`PLACES.G.RESERVATIONS.${name}`);
      const template = view.control(f(`${name}.TEMPLATE_ID`));
      expect(template.type).toBe('select-one');
      expect(template.value).toBe('');
      expect([...(template as HTMLSelectElement).options].map((o) => o.value)).toEqual([
        '',
        TEMPLATE_1,
        TEMPLATE_2,
      ]);
    }
    expect(view.control(f('EMAIL_NOTIFICATION.TO')).type).toBe('text');
  });

  it('saves the whole block with the exact PUT', async () => {
    const view = await renderPlace({ path: 'reservations' });
    await view.toggle(f('STATUS'), true);
    await view.type(f('STEP'), '30');
    await view.type(f('UNTIL_HOURS'), '22:30');
    await view.type(f('WEB_WIDGET.BRIGHTNESS'), 'dark');
    await view.type(f('EMAIL_NOTIFICATION.TO'), 'staff@esempio.it');
    await view.type(f('EMAIL_REFUSED_STATUS.TEMPLATE_ID'), TEMPLATE_2);
    await view.toggle(f('EMAIL_CHANGE_STATUS.STATUS'), true);
    await view.type(f('EMAIL.SUBJECT'), 'Prenotazione');
    let block = withValue(storedBlock('reservations'), 'status', true);
    block = withValue(block, 'step', 1800000);
    block = withValue(block, 'untilHours', '22:30');
    block = withValue(block, 'webWidget.brightness', 'dark');
    block = withValue(block, 'emailNotification.to', 'staff@esempio.it');
    block = withValue(block, 'emailRefusedStatus.templateId', TEMPLATE_2);
    block = withValue(block, 'emailChangeStatus.status', true);
    block = withValue(block, 'email.subject', 'Prenotazione');
    await savePut(view, 'settings/reservations', block);
  });

  it('toggles the days of a time block and keeps them sorted', async () => {
    const view = await renderPlace({ path: 'reservations' });
    dayBox(view.root, 0, 3).checked = true;
    dayBox(view.root, 0, 3).dispatchEvent(new Event('change'));
    await view.view();
    dayBox(view.root, 0, 0).checked = true;
    dayBox(view.root, 0, 0).dispatchEvent(new Event('change'));
    await view.view();
    dayBox(view.root, 0, 1).checked = false;
    dayBox(view.root, 0, 1).dispatchEvent(new Event('change'));
    await view.view();
    expect(dayBox(view.root, 0, 1).checked).toBe(false);
    expect(dayBox(view.root, 0, 3).checked).toBe(true);
    await savePut(view, 'settings/reservations', {
      ...storedBlock('reservations'),
      timeBlocks: [{ weekDays: [0, 2, 3], start: '12:00', end: '14:00' }],
    });
  });

  it('adds and removes time blocks', async () => {
    const view = await renderPlace({ path: 'reservations' });
    await view.click('PLACES.RESERVATIONS.ADD_BLOCK');
    expect(view.root.querySelectorAll('fc-rows-editor .rows > .row')).toHaveLength(2);
    expect(dayBox(view.root, 1, 2).checked).toBe(false);
    await view.type(col('START', 2), '19:00');
    await view.type(col('END', 2), '23:00');
    dayBox(view.root, 1, 5).checked = true;
    dayBox(view.root, 1, 5).dispatchEvent(new Event('change'));
    await view.view();
    await savePut(view, 'settings/reservations', {
      ...storedBlock('reservations'),
      timeBlocks: [
        { weekDays: [1, 2], start: '12:00', end: '14:00' },
        { weekDays: [5], start: '19:00', end: '23:00' },
      ],
    });
    (
      view.root.querySelector('button[aria-label*="PLACES.REMOVE_ROW"]') as HTMLButtonElement
    ).click();
    await view.view();
    expect(view.root.querySelectorAll('fc-rows-editor .rows > .row')).toHaveLength(0);
    await savePut(
      view,
      'settings/reservations',
      { ...storedBlock('reservations'), timeBlocks: [] },
      '"v2"',
    );
  });

  it('does not save a time block without start and end', async () => {
    const view = await renderPlace({ path: 'reservations' });
    await view.click('PLACES.RESERVATIONS.ADD_BLOCK');
    await view.click('COMMON.SAVE');
    expect(view.error(col('START', 2))).toBe('FORM.ISSUE.REQUIRED');
    expect(view.error(col('END', 2))).toBe('FORM.ISSUE.REQUIRED');
  });

  it('puts the 422 on the time block and on the email fields', async () => {
    const view = await renderPlace({ path: 'reservations' });
    await view.type(f('STEP'), '45');
    await failPut(view, 'settings/reservations', [
      { field: 'reservations.timeBlocks.0.end', issue: 'incorrect' },
      { field: 'reservations.emailNotification.templateId', issue: 'incorrect' },
      { field: 'reservations.step', issue: 'incorrect' },
    ]);
    expect(view.error(col('END', 1))).toContain('FORM.ISSUE.INCORRECT');
    expect(view.error(f('EMAIL_NOTIFICATION.TEMPLATE_ID'))).toContain('FORM.ISSUE.INCORRECT');
    expect(view.error(f('STEP'))).toContain('FORM.ISSUE.INCORRECT');
  });

  it('ignores the submit of the form', async () => {
    const view = await renderPlace({ path: 'reservations' });
    await submitTab(view);
    await view.blurAll();
  });

  it('is read-only without the permission to update', async () => {
    const place = fakePlace();
    const view = await renderPlace({ path: 'reservations', permissions: READ_ONLY, place });
    expect(view.control(f('STEP')).disabled).toBe(true);
    expect(dayBox(view.root, 0, 1).disabled).toBe(true);
    expect(view.button('COMMON.SAVE')).toBeUndefined();
    expect(view.button('PLACES.RESERVATIONS.ADD_BLOCK')).toBeUndefined();
    expect(view.button('PLACES.REMOVE')).toBeUndefined();
  });
});
