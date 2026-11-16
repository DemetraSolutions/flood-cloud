import {
  COMPANY,
  COMPANY_2,
  PLACE,
  PLACE_2,
  fakePlace,
  renderPlace,
  TEMPLATE_1,
} from '../../../testing/places';
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

const A = (key: string) => `PLACES.F.APPOINTMENTS.${key}`;
const D = (key: string) => `PLACES.F.EXTERNAL_DISPLAY.${key}`;
const F = (key: string) => `PLACES.F.FIDELITY.${key}`;
const T = (key: string) => `PLACES.F.TOBACCO.${key}`;
const labels = (select: HTMLElement) =>
  [...select.querySelectorAll('option')].map((o) => o.textContent?.trim());

afterEach(cleanUp);

describe('PlaceScalarTab appointments', () => {
  it('shows the stored data', async () => {
    const view = await renderPlace({ path: 'settings/appointments' });
    expect(isChecked(view, A('STAFF_CHOICE'))).toBe(false);
    expect(view.control(A('TYPE')).value).toBe('single');
    expect(view.control(A('EMAIL.TEMPLATE_ID')).value).toBe('');
    expect(view.control(A('STEP')).type).toBe('number');
    expect(view.text()).toContain('PLACES.G.APPOINTMENTS.GENERAL');
  });

  it('saves the whole block with the exact PUT', async () => {
    const view = await renderPlace({ path: 'settings/appointments' });
    await view.toggle(A('STAFF_CHOICE'), true);
    await view.toggle(A('WEB_WIDGET_STATUS'), true);
    await view.type(A('STEP'), '30');
    await view.type(A('MAX_DAILY'), '12');
    await view.type(A('TYPE'), 'multiple');
    await view.type(A('EMAIL.TEMPLATE_ID'), TEMPLATE_1);
    await view.type(A('EMAIL.FROM'), 'noreply@esempio.it');
    let block = withValue(storedBlock('appointments'), 'staffChoice', true);
    block = withValue(block, 'webWidgetStatus', true);
    block = withValue(block, 'step', 1800000);
    block = withValue(block, 'maxDaily', 12);
    block = withValue(block, 'type', 'multiple');
    block = withValue(block, 'email.templateId', TEMPLATE_1);
    block = withValue(block, 'email.from', 'noreply@esempio.it');
    await savePut(view, 'settings/appointments', block);
    expect(view.toasts()).toEqual(['PLACES.SAVED']);
  });

  it.each(['PSA', 'D'] as const)('lets a %s change the reserved key', async (role) => {
    const view = await renderPlace({ path: 'settings/appointments', profile: { role } });
    expect(view.control(A('WEB_WIDGET_STATUS')).disabled).toBe(false);
    expect(view.text()).not.toContain('PLACES.RESERVED_NOTE');
  });

  it('shows the reserved key read-only, with the note, to a company administrator', async () => {
    const view = await renderPlace({
      path: 'settings/appointments',
      profile: { role: 'CA', groupId: '665f1c2e9b1d4a0012ab34a1' },
    });
    expect(view.control(A('WEB_WIDGET_STATUS')).disabled).toBe(true);
    expect(view.control(A('STEP')).disabled).toBe(false);
    expect(view.text()).toContain('PLACES.RESERVED_NOTE');
    await view.toggle(A('STAFF_CHOICE'), true);
    await savePut(
      view,
      'settings/appointments',
      withValue(storedBlock('appointments'), 'staffChoice', true),
    );
  });

  it('puts the 422 on the control', async () => {
    const view = await renderPlace({ path: 'settings/appointments' });
    await view.type(A('MAX_DAILY'), '3');
    await failPut(view, 'settings/appointments', [
      { field: 'appointments.maxDaily', issue: 'incorrect' },
      { field: 'appointments.email.subject', issue: 'incorrect' },
    ]);
    expect(view.error(A('MAX_DAILY'))).toContain('FORM.ISSUE.INCORRECT');
    expect(view.error(A('EMAIL.SUBJECT'))).toContain('FORM.ISSUE.INCORRECT');
  });

  it('ignores the submit of the form and marks the fields as touched', async () => {
    const view = await renderPlace({ path: 'settings/appointments' });
    await submitTab(view);
    await view.blurAll();
    expect(view.button('COMMON.SAVE')).toBeDefined();
  });

  it('is read-only without the permission to update', async () => {
    const view = await renderPlace({ path: 'settings/appointments', permissions: READ_ONLY });
    expect(view.control(A('STEP')).disabled).toBe(true);
    expect(view.button('COMMON.SAVE')).toBeUndefined();
  });
});

describe('PlaceScalarTab external display', () => {
  it('shows the stored data and saves the whole block', async () => {
    const view = await renderPlace({ path: 'settings/external-display' });
    expect(isChecked(view, D('TIPS'))).toBe(false);
    expect(view.control(D('BACKGROUND_COLOR')).type).toBe('color');
    expect(view.control(D('BACKGROUND_COLOR')).value).toBe('#8936f7');
    await view.toggle(D('TIPS'), true);
    await view.type(D('TEXT_COLOR'), '#ffffff');
    await savePut(
      view,
      'settings/external-display',
      withValue(withValue(storedBlock('externalDisplay'), 'tips', true), 'textColor', '#ffffff'),
    );
  });

  it('puts the 422 on the control', async () => {
    const view = await renderPlace({ path: 'settings/external-display' });
    await view.toggle(D('FIDELITY'), true);
    await failPut(view, 'settings/external-display', [
      { field: 'externalDisplay.textColor', issue: 'incorrect' },
    ]);
    expect(view.error(D('TEXT_COLOR'))).toContain('FORM.ISSUE.INCORRECT');
  });
});

describe('PlaceScalarTab fidelity', () => {
  it('offers the empty choice of the nullable type and saves null for it', async () => {
    const view = await renderPlace({ path: 'settings/fidelity' });
    expect(labels(view.control(F('TYPE')))).toEqual([
      'PLACES.NONE_OF.FIDELITY_TYPE',
      'PLACES.OPTION.TYPE.ADVANCED',
      'PLACES.OPTION.TYPE.BASE',
    ]);
    expect(view.control(F('TYPE')).value).toBe('');
    await view.toggle(F('SHOW_POINTS'), true);
    await savePut(
      view,
      'settings/fidelity',
      withValue(storedBlock('fidelity'), 'showPoints', true),
    );
  });

  it('saves the chosen type', async () => {
    const view = await renderPlace({ path: 'settings/fidelity' });
    await view.type(F('TYPE'), 'base');
    await savePut(view, 'settings/fidelity', withValue(storedBlock('fidelity'), 'type', 'base'));
  });
});

describe('PlaceScalarTab tobacco', () => {
  it('offers the companies and the places of the group', async () => {
    const view = await renderPlace({ path: 'settings/tobacco' });
    expect(labels(view.control(T('COMPANY_ID')))).toEqual([
      'PLACES.NONE',
      'Azienda Esempio Srl',
      'Altra Azienda',
    ]);
    expect(labels(view.control(T('PLACE_ID')))).toEqual(['PLACES.NONE', 'Bar Roma', 'Bar Milano']);
    expect(view.control(T('COMPANY_ID')).value).toBe('');
  });

  it('saves the chosen company and place', async () => {
    const view = await renderPlace({ path: 'settings/tobacco' });
    await view.toggle(T('STATUS'), true);
    await view.type(T('COMPANY_ID'), COMPANY_2);
    await view.type(T('PLACE_ID'), PLACE_2);
    let block = withValue(storedBlock('tobacco'), 'status', true);
    block = withValue(block, 'companyId', COMPANY_2);
    block = withValue(block, 'placeId', PLACE_2);
    await savePut(view, 'settings/tobacco', block);
  });

  it('keeps the stored company and place when the user cannot read the lists', async () => {
    const stored = fakePlace();
    const place = fakePlace({ tobacco: { ...stored.tobacco, companyId: COMPANY, placeId: PLACE } });
    const view = await renderPlace({
      path: 'settings/tobacco',
      place,
      permissions: ['places:update', 'profile:read'],
    });
    expect(view.control(T('COMPANY_ID')).value).toBe(COMPANY);
    expect(view.control(T('PLACE_ID')).value).toBe(PLACE);
    expect(labels(view.control(T('COMPANY_ID')))).toEqual(['PLACES.NONE', COMPANY]);
  });

  it('empties the company to null', async () => {
    const stored = fakePlace();
    const place = fakePlace({ tobacco: { ...stored.tobacco, companyId: COMPANY } });
    const view = await renderPlace({ path: 'settings/tobacco', place });
    await view.type(T('COMPANY_ID'), '');
    await savePut(view, 'settings/tobacco', storedBlock('tobacco'));
  });

  it('puts the 422 on the select', async () => {
    const view = await renderPlace({ path: 'settings/tobacco' });
    await view.type(T('COMPANY_ID'), COMPANY_2);
    await failPut(view, 'settings/tobacco', [{ field: 'tobacco.companyId', issue: 'incorrect' }]);
    expect(view.error(T('COMPANY_ID'))).toContain('FORM.ISSUE.INCORRECT');
  });
});
