import { fakePlace, GROUP, renderPlace } from '../../../testing/places';
import {
  cleanUp,
  failSave,
  isChecked,
  READ_ONLY,
  savePatch,
  storedBlock,
  submitTab,
  withValue,
} from '../../../testing/places-tabs';

const f = (key: string) => `PLACES.F.INTEGRATIONS.${key}`;
const STRIPE_PRIVATE = f('FLOOD_PAY.STRIPE.PRIVATE_KEY');
const STRIPE_WEBHOOK = f('FLOOD_PAY.STRIPE.WEBHOOK_PRIVATE_KEY');
const DOJO = f('DOJO.API_KEY');
const SATISPAY_KEY = f('SATISPAY.KEY_ID');
const QODEUP = f('QODEUP.API_KEY');
const APP_TOKEN = f('EASYAPPEAR.APP_TOKEN');
const SWITCH = f('DOJO.STATUS');
const CHANGE = 'PLACES.CREDENTIAL.CHANGE';
const SET_NEW = 'PLACES.CREDENTIAL.SET_NEW';
const REMOVE = 'PLACES.CREDENTIAL.REMOVE';
const KEEP = 'PLACES.CREDENTIAL.KEEP';
const CANCEL = 'COMMON.CANCEL';
const LOCKED_ROLES = [
  { role: 'CA' as const, groupId: GROUP },
  { role: 'SA' as const, groupId: GROUP },
  { role: 'PA' as const, groupId: GROUP },
];

type View = Awaited<ReturnType<typeof renderPlace>>;

afterEach(cleanUp);

/** A place whose credentials are set: the Dojo and Stripe keys, the Satispay code and the app token. */
function withCredentials() {
  let block = storedBlock('integrations');
  for (const key of [
    'dojo.apiKeySet',
    'floodPay.stripe.privateKeySet',
    'floodPay.stripe.webhookPrivateKeySet',
    'satispay.keyIdSet',
    'easyappear.appTokenSet',
  ]) {
    block = withValue(block, key, true);
  }
  return fakePlace({ integrations: block });
}

/** The group of a credential, by its label. */
function credential(view: View, label: string): HTMLElement {
  return view.root.querySelector(`[role="group"][aria-label="${label}"]`) as HTMLElement;
}

const stateOf = (view: View, label: string) =>
  credential(view, label).querySelector('.credential-state')?.textContent?.trim();

const buttonsOf = (view: View, label: string) =>
  [...credential(view, label).querySelectorAll('button')].map((b) => b.textContent?.trim());

async function press(view: View, label: string, text: string) {
  const found = [...credential(view, label).querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === text,
  ) as HTMLButtonElement;
  found.click();
  await view.view();
}

async function typeSecret(view: View, label: string, value: string) {
  const input = credential(view, label).querySelector('input') as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event('input'));
  await view.view();
}

/** The block the page sends: the settings as stored (never the `…Set` flags), plus the credentials changed. */
function sentBlock(
  changes: Record<string, unknown> = {},
  settings: Record<string, unknown> = storedBlock('integrations'),
): { integrations: Record<string, unknown> } {
  const strip = (node: unknown): unknown =>
    typeof node === 'object' && node !== null
      ? Object.fromEntries(
          Object.entries(node)
            .filter(([key]) => !key.endsWith('Set') && key !== 'categories')
            .map(([key, value]) => [key, strip(value)]),
        )
      : node;
  const merge = (target: Record<string, unknown>, source: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(source)) {
      const current = target[key];
      target[key] =
        typeof value === 'object' && value !== null && typeof current === 'object'
          ? merge({ ...(current as Record<string, unknown>) }, value as Record<string, unknown>)
          : value;
    }
    return target;
  };
  return { integrations: merge(strip(settings) as Record<string, unknown>, changes) };
}

const open = (options: Parameters<typeof renderPlace>[0] = {}) =>
  renderPlace({ path: 'integrations', ...options });

describe('PlaceIntegrations', () => {
  it('shows a card for each provider, in the order of the old backoffice', async () => {
    const view = await open();
    const legends = [...view.root.querySelectorAll('legend')].map((l) => l.textContent?.trim());
    expect(legends.slice(0, 7)).toEqual([
      'PLACES.G.INTEGRATIONS.FLOOD_PAY',
      'PLACES.G.INTEGRATIONS.QR_CODE_PAYMENT',
      'PLACES.G.INTEGRATIONS.TAP_TO_PAY',
      'PLACES.G.INTEGRATIONS.DOJO',
      'PLACES.G.INTEGRATIONS.SATISPAY',
      'PLACES.G.INTEGRATIONS.MULTISAFEPAY',
      'PLACES.G.INTEGRATIONS.QODEUP',
    ]);
    expect(view.root.querySelectorAll('form')).toHaveLength(1);
  });

  it('says whether a credential is set and never shows its value', async () => {
    const view = await open({ place: withCredentials() });
    expect(stateOf(view, DOJO)).toBe('PLACES.CREDENTIAL.SET');
    expect(stateOf(view, QODEUP)).toBe('PLACES.CREDENTIAL.NOT_SET');
    expect(view.root.querySelectorAll('input[type="password"]')).toHaveLength(0);
    expect(buttonsOf(view, DOJO)).toEqual([CHANGE, REMOVE]);
    expect(buttonsOf(view, QODEUP)).toEqual([SET_NEW]);
    expect(view.button('COMMON.SAVE')?.disabled).toBe(true);
  });

  it('sends the credential typed with the settings, and no other credential', async () => {
    const view = await open({ place: withCredentials() });
    await press(view, DOJO, CHANGE);
    const input = credential(view, DOJO).querySelector('input') as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.value).toBe('');
    expect(input.autocomplete).toBe('new-password');
    await typeSecret(view, DOJO, 'new-dojo-key');
    const sent = (await savePatch(view, sentBlock({ dojo: { apiKey: 'new-dojo-key' } }))) as {
      integrations: Record<string, unknown>;
    };
    expect(JSON.stringify(sent)).not.toContain('Set');
    expect(view.toasts()).toEqual(['PLACES.SAVED']);
  });

  it('sets a credential that was not set', async () => {
    const view = await open();
    await press(view, QODEUP, SET_NEW);
    await typeSecret(view, QODEUP, 'qodeup-key');
    await savePatch(view, sentBlock({ qodeup: { apiKey: 'qodeup-key' } }));
  });

  it('sends null to remove a credential, and nothing when the removal is undone', async () => {
    const view = await open({ place: withCredentials() });
    await press(view, DOJO, REMOVE);
    expect(stateOf(view, DOJO)).toBe('PLACES.CREDENTIAL.REMOVING');
    expect(buttonsOf(view, DOJO)).toEqual([KEEP]);
    await press(view, DOJO, KEEP);
    expect(stateOf(view, DOJO)).toBe('PLACES.CREDENTIAL.SET');
    expect(view.button('COMMON.SAVE')?.disabled).toBe(true);
    await press(view, DOJO, REMOVE);
    await savePatch(view, sentBlock({ dojo: { apiKey: null } }));
  });

  it('drops what was typed when the change is cancelled', async () => {
    const view = await open({ place: withCredentials() });
    await press(view, DOJO, CHANGE);
    await typeSecret(view, DOJO, 'typed-and-dropped');
    expect(buttonsOf(view, DOJO)).toEqual([CANCEL]);
    await press(view, DOJO, CANCEL);
    expect(credential(view, DOJO).querySelector('input')).toBeNull();
    expect(stateOf(view, DOJO)).toBe('PLACES.CREDENTIAL.SET');
    expect(view.button('COMMON.SAVE')?.disabled).toBe(true);
  });

  it('removing a credential after typing a new one sends only the removal', async () => {
    const view = await open({ place: withCredentials() });
    await press(view, DOJO, CHANGE);
    await typeSecret(view, DOJO, 'typed');
    await press(view, DOJO, CANCEL);
    await press(view, DOJO, REMOVE);
    await savePatch(view, sentBlock({ dojo: { apiKey: null } }));
  });

  it('sends the changed settings along with the credentials', async () => {
    const view = await open();
    await view.type(f('FLOOD_PAY.STRIPE.PUBLIC_KEY'), 'pk_live_x');
    await press(view, QODEUP, SET_NEW);
    await typeSecret(view, QODEUP, 'k');
    const sent = (await savePatch(
      view,
      sentBlock(
        { qodeup: { apiKey: 'k' } },
        withValue(storedBlock('integrations'), 'floodPay.stripe.publicKey', 'pk_live_x'),
      ),
    )) as Record<string, unknown>;
    expect(sent['integrations']).toBeDefined();
  });

  it.each([
    ['platform administrator', 'PSA'],
    ['dealer', 'D'],
  ] as const)('lets a %s set and remove the payment credentials', async (_name, role) => {
    const view = await open({ place: withCredentials(), profile: { role } });
    for (const label of [STRIPE_PRIVATE, STRIPE_WEBHOOK, DOJO, SATISPAY_KEY]) {
      expect(buttonsOf(view, label)).toEqual([CHANGE, REMOVE]);
    }
    expect(buttonsOf(view, QODEUP)).toEqual([SET_NEW]);
  });

  it.each(LOCKED_ROLES)(
    'shows only the state of the payment credentials to a $role',
    async (profile) => {
      const view = await open({ place: withCredentials(), profile });
      for (const label of [STRIPE_PRIVATE, STRIPE_WEBHOOK, DOJO, SATISPAY_KEY, QODEUP]) {
        expect(buttonsOf(view, label)).toEqual([]);
      }
      expect(stateOf(view, DOJO)).toBe('PLACES.CREDENTIAL.SET');
      expect(stateOf(view, QODEUP)).toBe('PLACES.CREDENTIAL.NOT_SET');
      expect(credential(view, DOJO).querySelector('input')).toBeNull();
    },
  );

  it('lets a company administrator change a credential that is not a payment one', async () => {
    const view = await open({
      place: withCredentials(),
      profile: { role: 'CA', groupId: GROUP },
    });
    expect(buttonsOf(view, APP_TOKEN)).toEqual([CHANGE, REMOVE]);
    await press(view, APP_TOKEN, CHANGE);
    await typeSecret(view, APP_TOKEN, 'token');
    await savePatch(view, sentBlock({ easyappear: { appToken: 'token' } }));
  });

  it.each(['PSA', 'D'] as const)('lets a %s switch the integrations on', async (role) => {
    const view = await open({ profile: { role } });
    expect(view.control(SWITCH).disabled).toBe(false);
    expect(view.text()).not.toContain('PLACES.RESERVED_NOTE');
    await view.toggle(SWITCH, true);
    await savePatch(
      view,
      sentBlock({}, withValue(storedBlock('integrations'), 'dojo.status', true)),
    );
  });

  it.each(LOCKED_ROLES)(
    'shows the switches read-only, with the note, to a $role',
    async (profile) => {
      const view = await open({ profile });
      expect(view.control(SWITCH).disabled).toBe(true);
      expect(isChecked(view, SWITCH)).toBe(false);
      expect(view.control(f('FLOOD_PAY.STATUS')).disabled).toBe(true);
      expect(view.text()).toContain('PLACES.RESERVED_NOTE');
      expect(view.control(f('KEENON.STORE_ID')).disabled).toBe(false);
    },
  );

  it('puts the 422 on the control of the setting', async () => {
    const view = await open();
    await view.type(f('BIZERBA.IMPORT_PATH'), '/data/in');
    await failSave(view, [{ field: 'integrations.bizerba.importPath', issue: 'incorrect' }]);
    expect(view.error(f('BIZERBA.IMPORT_PATH'))).toContain('FORM.ISSUE.INCORRECT');
  });

  it('ignores the submit of the form', async () => {
    const view = await open();
    await submitTab(view);
    expect(view.root.querySelector('form')).not.toBeNull();
  });

  it('is read-only without the permission to update', async () => {
    const view = await open({ place: withCredentials(), permissions: READ_ONLY });
    expect(view.control(SWITCH).disabled).toBe(true);
    expect(view.button('COMMON.SAVE')).toBeUndefined();
    expect(buttonsOf(view, DOJO)).toEqual([]);
    expect(buttonsOf(view, APP_TOKEN)).toEqual([]);
    expect(stateOf(view, DOJO)).toBe('PLACES.CREDENTIAL.SET');
  });

  describe('MultiSafepay', () => {
    const GROUP_ID = f('MULTISAFEPAY.TERMINAL_GROUP_ID');
    const TERMINAL_KEY = f('MULTISAFEPAY.TERMINAL_GROUP_API_KEY');
    const WEBSITE_KEY = f('MULTISAFEPAY.WEBSITE_API_KEY');
    const QR_STATUS = f('MULTISAFEPAY.QR_STATUS');
    const QR_SECONDS = f('MULTISAFEPAY.QR_SECONDS_ACTIVE');
    const STATUS = f('MULTISAFEPAY.STATUS');
    const withKeys = () =>
      fakePlace({
        integrations: withValue(
          withValue(storedBlock('integrations'), 'multisafepay.terminalGroupApiKeySet', true),
          'multisafepay.websiteApiKeySet',
          true,
        ),
      });

    it('is a card after Satispay with the status, the group id, the two keys, the QR switch and its validity', async () => {
      const view = await open();
      const card = [...view.root.querySelectorAll('fieldset')].find(
        (fieldset) =>
          fieldset.querySelector(':scope > legend')?.textContent?.trim() ===
          'PLACES.G.INTEGRATIONS.MULTISAFEPAY',
      ) as HTMLElement;
      const text = card.textContent as string;
      const order = [STATUS, GROUP_ID, TERMINAL_KEY, WEBSITE_KEY, QR_STATUS, QR_SECONDS].map(
        (label) => text.indexOf(label),
      );
      expect(order.every((position) => position >= 0)).toBe(true);
      expect(order).toEqual([...order].sort((a, b) => a - b));
      expect(view.control(QR_SECONDS).value).toBe('600');
    });

    it('sets and removes the two keys, never showing them', async () => {
      const view = await open({ place: withKeys() });
      expect(stateOf(view, TERMINAL_KEY)).toBe('PLACES.CREDENTIAL.SET');
      expect(stateOf(view, WEBSITE_KEY)).toBe('PLACES.CREDENTIAL.SET');
      expect(credential(view, TERMINAL_KEY).querySelector('input')).toBeNull();
      await press(view, TERMINAL_KEY, CHANGE);
      await typeSecret(view, TERMINAL_KEY, 'terminal-secret');
      await press(view, WEBSITE_KEY, REMOVE);
      await savePatch(
        view,
        sentBlock({
          multisafepay: { terminalGroupApiKey: 'terminal-secret', websiteApiKey: null },
        }),
      );
    });

    it('keeps a key that was not touched, and sets one that was not set', async () => {
      const view = await open();
      expect(buttonsOf(view, TERMINAL_KEY)).toEqual([SET_NEW]);
      await press(view, WEBSITE_KEY, SET_NEW);
      await typeSecret(view, WEBSITE_KEY, 'site');
      await savePatch(view, sentBlock({ multisafepay: { websiteApiKey: 'site' } }));
    });

    it('sends the configuration: the group id, the QR validity as a number and the switches', async () => {
      const view = await open();
      await view.toggle(STATUS, true);
      await view.toggle(QR_STATUS, true);
      await view.type(GROUP_ID, 'GRP_1-a');
      await view.type(QR_SECONDS, '900');
      let settings = withValue(storedBlock('integrations'), 'multisafepay.status', true);
      settings = withValue(settings, 'multisafepay.qrStatus', true);
      settings = withValue(settings, 'multisafepay.terminalGroupId', 'GRP_1-a');
      settings = withValue(settings, 'multisafepay.qrSecondsActive', 900);
      await savePatch(view, sentBlock({}, settings));
    });

    it('sends null for an empty group id and the default validity for an empty one', async () => {
      const view = await open({
        place: fakePlace({
          integrations: withValue(
            storedBlock('integrations'),
            'multisafepay.terminalGroupId',
            'OLD',
          ),
        }),
      });
      await view.type(GROUP_ID, '');
      await view.type(QR_SECONDS, '');
      await savePatch(
        view,
        sentBlock({ multisafepay: { terminalGroupId: null, qrSecondsActive: 600 } }),
      );
    });

    it('rejects a group id with characters the provider does not use, and a validity out of range', async () => {
      const view = await open();
      for (const [label, value, issue] of [
        [GROUP_ID, 'a b', 'FORM.ISSUE.PATTERN'],
        [GROUP_ID, 'x'.repeat(65), 'FORM.ISSUE.PATTERN'],
        [QR_SECONDS, '59', 'FORM.ISSUE.MINIMUM'],
        [QR_SECONDS, '31536001', 'FORM.ISSUE.MAXIMUM'],
      ] as const) {
        await view.type(label, value);
        view.control(label).dispatchEvent(new Event('blur'));
        await view.view();
        expect(view.error(label)).toBe(issue);
      }
      await view.type(QR_SECONDS, '60');
      view.control(QR_SECONDS).dispatchEvent(new Event('blur'));
      await view.view();
      expect(view.error(QR_SECONDS)).toBe('');
    });

    it('puts the 422 of the group id and of a key on their controls', async () => {
      const view = await open();
      await view.type(GROUP_ID, 'OK');
      await press(view, TERMINAL_KEY, SET_NEW);
      await typeSecret(view, TERMINAL_KEY, 'k');
      await failSave(view, [
        { field: 'integrations.multisafepay.terminalGroupId', issue: 'pattern' },
        { field: 'integrations.multisafepay.terminalGroupApiKey', issue: 'notAllowed' },
      ]);
      expect(view.error(GROUP_ID)).toContain('FORM.ISSUE.PATTERN');
      expect(credential(view, TERMINAL_KEY).textContent).toContain('FORM.ISSUE.NOT_ALLOWED');
    });

    it.each(LOCKED_ROLES)(
      'lets a $role change the configuration but not the switches nor the keys',
      async (profile) => {
        const view = await open({ place: withKeys(), profile });
        expect(view.control(STATUS).disabled).toBe(true);
        expect(view.control(QR_STATUS).disabled).toBe(true);
        expect(view.control(GROUP_ID).disabled).toBe(false);
        expect(view.control(QR_SECONDS).disabled).toBe(false);
        expect(buttonsOf(view, TERMINAL_KEY)).toEqual([]);
        expect(buttonsOf(view, WEBSITE_KEY)).toEqual([]);
        expect(stateOf(view, WEBSITE_KEY)).toBe('PLACES.CREDENTIAL.SET');
      },
    );

    it.each(['PSA', 'D'] as const)('lets a %s switch it on, with the QR code', async (role) => {
      const view = await open({ profile: { role } });
      expect(view.control(STATUS).disabled).toBe(false);
      expect(view.control(QR_STATUS).disabled).toBe(false);
    });
  });
});
