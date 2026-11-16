import { backend } from '../../../testing/api';
import { PLACE_PERMISSIONS, PLACE_URL, fakePlace, renderPlace } from '../../../testing/places';
import {
  cleanUp,
  failSave,
  isChecked,
  READ_ONLY,
  savePut,
  storedBlock,
  submitTab,
  withValue,
} from '../../../testing/places-tabs';

const f = (key: string) => `PLACES.F.DEALER_SETTINGS.${key}`;
const SENTRY = f('SENTRY');
const SERVER_IP = f('SERVER_IP');
const CONNECTOR = f('CONNECTOR_ADDRESS');
const STORE_KEY = `${PLACE_URL}/store-key`;
const NONE = { status: 'none', key: null, pendingActivation: null, lastRevoked: null };

afterEach(cleanUp);

describe('PlaceDealer', () => {
  it('shows the stored data in a card for each group of keys', async () => {
    const view = await renderPlace({ path: 'settings/dealer' });
    expect(isChecked(view, SENTRY)).toBe(false);
    expect(view.control(SERVER_IP).value).toBe('');
    expect(view.control(CONNECTOR).value).toBe('');
    const legends = [...view.root.querySelectorAll('legend')].map((l) => l.textContent?.trim());
    expect(legends).toEqual([
      'PLACES.G.DEALER_SETTINGS.TRACKING',
      'PLACES.G.DEALER_SETTINGS.SERVER',
      'PLACES.G.DEALER_SETTINGS.CONNECTOR',
    ]);
  });

  it('shows the stored values', async () => {
    const view = await renderPlace({
      path: 'settings/dealer',
      place: fakePlace({
        dealerSettings: { sentry: true, serverIp: '192.168.1.5', connectorAddress: 'http://c' },
      }),
    });
    expect(isChecked(view, SENTRY)).toBe(true);
    expect(view.control(SERVER_IP).value).toBe('192.168.1.5');
    expect(view.control(CONNECTOR).value).toBe('http://c');
  });

  it('saves the whole block with the exact PATCH', async () => {
    const view = await renderPlace({ path: 'settings/dealer' });
    await view.toggle(SENTRY, true);
    await view.type(SERVER_IP, '10.0.0.2');
    await view.type(CONNECTOR, 'https://connector.example');
    await savePut(
      view,
      'settings/dealer',
      withValue(
        withValue(withValue(storedBlock('dealerSettings'), 'sentry', true), 'serverIp', '10.0.0.2'),
        'connectorAddress',
        'https://connector.example',
      ),
    );
    expect(view.toasts()).toEqual(['PLACES.SAVED']);
  });

  it('lets a platform administrator change the Sentry switch', async () => {
    const view = await renderPlace({ path: 'settings/dealer' });
    expect(view.control(SENTRY).disabled).toBe(false);
  });

  it('shows the Sentry switch read-only to a dealer, who changes the addresses', async () => {
    const view = await renderPlace({ path: 'settings/dealer', profile: { role: 'D' } });
    expect(view.control(SENTRY).disabled).toBe(true);
    expect(view.control(SERVER_IP).disabled).toBe(false);
    expect(view.control(CONNECTOR).disabled).toBe(false);
  });

  it('puts the 422 on the control of the key', async () => {
    const view = await renderPlace({ path: 'settings/dealer' });
    await view.type(SERVER_IP, 'x');
    await failSave(view, [{ field: 'dealerSettings.serverIp', issue: 'incorrect' }]);
    expect(view.error(SERVER_IP)).toContain('FORM.ISSUE.INCORRECT');
  });

  it('ignores the submit of the form', async () => {
    const view = await renderPlace({ path: 'settings/dealer' });
    await submitTab(view);
    expect(view.root.querySelector('form')).not.toBeNull();
  });

  it('is read-only without the permission to update', async () => {
    const view = await renderPlace({ path: 'settings/dealer', permissions: READ_ONLY });
    expect(view.control(SERVER_IP).disabled).toBe(true);
    expect(view.control(CONNECTOR).disabled).toBe(true);
    expect(view.button('COMMON.SAVE')).toBeUndefined();
  });

  describe('store key panel', () => {
    it('is below the keys for who can read store keys', async () => {
      const view = await renderPlace({
        path: 'settings/dealer',
        permissions: [...PLACE_PERMISSIONS, 'storeKeys:read'],
      });
      backend().expectOne(STORE_KEY).flush({ data: NONE });
      await view.view();
      const panel = view.root.querySelector('fc-place-store-key') as HTMLElement;
      expect(panel.textContent).toContain('PLACES.STORE_KEY.TITLE');
      const form = view.root.querySelector('form') as HTMLElement;
      expect(form.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('is not offered without the permission to read store keys', async () => {
      const view = await renderPlace({ path: 'settings/dealer' });
      expect(view.root.querySelector('fc-place-store-key')).toBeNull();
      backend().expectNone(STORE_KEY);
    });
  });
});
