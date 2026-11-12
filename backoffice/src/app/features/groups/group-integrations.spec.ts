import { TestBed } from '@angular/core/testing';
import { backend, errorBody, provideApiTesting, settle } from '../../../testing/api';
import { emulateNativeDialog } from '../../../testing/dialog';
import { fakeSettingsState, renderGroupSection } from '../../../testing/group-settings';
import { fakeGroup, fakeIntegrations } from '../../../testing/groups';
import { I18nService } from '../../core/i18n/i18n.service';
import { Profile } from '../../core/session/session.types';
import { GroupIntegrations } from './group-integrations';
import { GroupSettingsState } from './group-settings-state';
import { GroupsApi } from './groups-api';
import { INTEGRATION_PROVIDERS } from './group.types';

const KEY = 'sk-test-0123456789abcdef'; // gitleaks:allow (fake test value)
const GROUP = fakeGroup({
  integrations: fakeIntegrations({
    yellgo: { enabled: true, apiKeySet: true },
    cooperto: { enabled: false, apiKeySet: true },
  }),
});
const YELLGO = 'INTEGRATION.YELLGO';
const SET_KEY = 'GROUP_SETTINGS.INTEGRATIONS.SET_KEY';
const REMOVE_KEY = 'GROUP_SETTINGS.INTEGRATIONS.REMOVE_KEY';
const KEY_FIELD = 'GROUP_SETTINGS.INTEGRATIONS.KEY';
const provider = (name: string) => ({ provider: `INTEGRATION.${name.toUpperCase()}` });
const label = (key: string, name: string) => `${key} ${JSON.stringify(provider(name))}`;

async function render(profile: Partial<Profile> = {}) {
  emulateNativeDialog();
  const view = await renderGroupSection(GroupIntegrations, { profile, group: GROUP });
  await view.load();
  const patch = () => backend().expectOne(view.url);
  const dialogs = () => [...view.root.querySelectorAll<HTMLDialogElement>('dialog')];
  const isOpen = (index: number) => dialogs()[index].hasAttribute('open');
  const byLabel = (text: string) =>
    view.root.querySelector<HTMLButtonElement>(`button[aria-label='${text}']`)!;
  const keyInput = () => view.root.querySelector<HTMLInputElement>('#integration-key-form input')!;
  const typeKey = async (value: string) => {
    const input = keyInput();
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await view.view();
  };
  const submitKey = async () => {
    view.root
      .querySelector<HTMLFormElement>('#integration-key-form')!
      .dispatchEvent(new Event('submit', { cancelable: true }));
    await view.view();
  };
  const keyError = () =>
    view.root.querySelector('#integration-key-form .error')?.textContent?.trim() ?? '';
  const keyDialogButtons = () => dialogs()[0].querySelectorAll<HTMLButtonElement>('footer button');
  const confirmButtons = () => dialogs()[1].querySelectorAll<HTMLButtonElement>('footer button');
  const badge = (name: string) =>
    view.root
      .querySelectorAll('fieldset li')
      [INTEGRATION_PROVIDERS.indexOf(name as never)].querySelector('fc-status-badge')!
      .textContent!.trim();
  const save = () => view.root.querySelector<HTMLButtonElement>('.actions button[type=submit]');
  return {
    ...view,
    save,
    patch,
    dialogs,
    isOpen,
    byLabel,
    keyInput,
    typeKey,
    submitKey,
    keyError,
    keyDialogButtons,
    confirmButtons,
    badge,
  };
}

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('GroupIntegrations', () => {
  describe('display', () => {
    it('lists the seven providers with their switch and the state of the key', async () => {
      const { root, box, badge } = await render();
      expect(root.querySelectorAll('fieldset li fc-checkbox')).toHaveLength(7);
      expect(box(YELLGO).checked).toBe(true);
      expect(box('INTEGRATION.EASYAPPEAR').checked).toBe(false);
      expect(badge('yellgo')).toBe('GROUP_SETTINGS.INTEGRATIONS.KEY_SET');
      expect(badge('easyappear')).toBe('GROUP_SETTINGS.INTEGRATIONS.KEY_NOT_SET');
      expect(badge('cooperto')).toBe('GROUP_SETTINGS.INTEGRATIONS.KEY_SET');
    });

    it('offers to set every key and to remove only the ones that exist', async () => {
      const { root, save, byLabel } = await render({ role: 'D' });
      const names = [...root.querySelectorAll('.key')].map((k) =>
        [...k.querySelectorAll('button')].map((b) => b.textContent?.trim()),
      );
      expect(names.filter((n) => n.length === 2)).toHaveLength(2);
      expect(names.filter((n) => n.length === 1)).toHaveLength(5);
      expect(byLabel(label('GROUP_SETTINGS.INTEGRATIONS.SET_KEY_LABEL', 'yellgo'))).not.toBeNull();
      expect(
        byLabel(label('GROUP_SETTINGS.INTEGRATIONS.REMOVE_KEY_LABEL', 'yellgo')),
      ).not.toBeNull();
      expect(
        byLabel(label('GROUP_SETTINGS.INTEGRATIONS.REMOVE_KEY_LABEL', 'plateform')),
      ).toBeNull();
      expect(save()?.disabled).toBe(true);
    });

    it('is read-only for the group administrator but still tells about the keys', async () => {
      const { root, box, save, badge } = await render({ role: 'SA', groupId: GROUP.id });
      expect(root.querySelector('p.note')?.textContent).toContain(
        'GROUP_SETTINGS.INTEGRATIONS.READ_ONLY',
      );
      expect(box(YELLGO).disabled).toBe(true);
      expect(root.querySelectorAll('.key button')).toHaveLength(0);
      expect(save()).toBeNull();
      expect(badge('yellgo')).toBe('GROUP_SETTINGS.INTEGRATIONS.KEY_SET');
    });

    it('is read-only for a platform administrator without groups:update', async () => {
      const { box, save, root } = await render({ permissions: ['groups:read'] });
      expect(box(YELLGO).disabled).toBe(true);
      expect(save()).toBeNull();
      expect(root.querySelectorAll('.key button')).toHaveLength(0);
    });
  });

  it('marks a switch as touched when it loses the focus', async () => {
    const { control, view, save } = await render();
    control(YELLGO).dispatchEvent(new Event('blur'));
    await view();
    expect(save()?.disabled).toBe(true);
  });

  describe('switches', () => {
    it('sends only the integrations whose switch changed', async () => {
      const { toggle, submit, patch, view, toasts, refresh, save } = await render();
      await toggle('INTEGRATION.PLATEFORM', true);
      await toggle(YELLGO, false);
      await toggle('INTEGRATION.COOPERTO', true);
      await toggle('INTEGRATION.COOPERTO', false);
      expect(save()?.disabled).toBe(false);
      await submit();
      const request = patch();
      expect(request.request.method).toBe('PATCH');
      expect(request.request.body).toEqual({
        integrations: { yellgo: { enabled: false }, plateform: { enabled: true } },
      });
      request.flush({
        data: fakeGroup({
          integrations: fakeIntegrations({
            plateform: { enabled: true, apiKeySet: false },
            cooperto: { enabled: false, apiKeySet: true },
          }),
        }),
      });
      await view();
      expect(toasts()).toEqual(['GROUP_SETTINGS.SAVED']);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(save()?.disabled).toBe(true);
    });

    describe('errors of the backend', () => {
      async function rejected(
        status: number,
        code: string,
        details?: { field: string; issue: string }[],
      ) {
        const view = await render();
        await view.toggle('INTEGRATION.PLATEFORM', true);
        await view.submit();
        view.patch().flush(errorBody(code, details), { status, statusText: 'x' });
        await view.view();
        return view;
      }

      it('puts a 422 detail under the provider', async () => {
        const { error, formError } = await rejected(422, 'VALIDATION_ERROR', [
          { field: 'integrations.plateform.enabled', issue: 'type' },
        ]);
        expect(error('INTEGRATION.PLATEFORM')).toBe('FORM.ISSUE.TYPE');
        expect(formError()).toBeNull();
      });

      it('puts a 403 notAllowed under the provider', async () => {
        const { error } = await rejected(403, 'FORBIDDEN', [
          { field: 'integrations.plateform', issue: 'notAllowed' },
        ]);
        expect(error('INTEGRATION.PLATEFORM')).toBe('FORM.ISSUE.NOT_ALLOWED');
      });

      it('shows a form message for a detail that matches no provider', async () => {
        const { formError } = await rejected(422, 'VALIDATION_ERROR', [
          { field: 'integrations.nothing.enabled', issue: 'unknown' },
        ]);
        expect(formError()).toContain('ERRORS.API.VALIDATION_ERROR');
      });

      it('shows a plain 403 as a form message', async () => {
        const { formError } = await rejected(403, 'FORBIDDEN');
        expect(formError()).toContain('ERRORS.API.FORBIDDEN');
      });

      it('invites to reload on a 409 and reloads the group', async () => {
        const { formError, root, view, url, box } = await rejected(409, 'CONFLICT');
        expect(formError()).toContain('GROUP_SETTINGS.ERROR.CONFLICT');
        [...root.querySelectorAll<HTMLButtonElement>('.actions button')]
          .find((b) => b.textContent?.trim() === 'GROUP_SETTINGS.RELOAD')!
          .click();
        await view();
        expect(formError()).toBeNull();
        backend()
          .expectOne(url)
          .flush({
            data: fakeGroup({
              integrations: fakeIntegrations({ plateform: { enabled: true, apiKeySet: false } }),
            }),
          });
        await view();
        expect(box('INTEGRATION.PLATEFORM').checked).toBe(true);
      });

      it('reports a network failure', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const view = await render();
        await view.toggle('INTEGRATION.PLATEFORM', true);
        await view.submit();
        view.patch().error(new ProgressEvent('error'));
        await view.view();
        expect(view.formError()).toContain('ERRORS.');
      });
    });
  });

  describe('setting a key', () => {
    const open = async (view: Awaited<ReturnType<typeof render>>, name = 'plateform') => {
      view.byLabel(label('GROUP_SETTINGS.INTEGRATIONS.SET_KEY_LABEL', name)).click();
      await view.view();
    };

    it('asks for the key in a password field that is empty each time', async () => {
      const view = await render();
      expect(view.isOpen(0)).toBe(false);
      expect(view.root.querySelector('#integration-key-form')).toBeNull();
      await open(view);
      expect(view.isOpen(0)).toBe(true);
      const input = view.keyInput();
      expect(input.type).toBe('password');
      expect(input.autocomplete).toBe('new-password');
      expect(input.value).toBe('');
      expect(view.control(KEY_FIELD)).toBe(input);
      await view.typeKey(KEY);
      view.keyDialogButtons()[0].click();
      await view.view();
      expect(view.isOpen(0)).toBe(false);
      expect(view.root.querySelector('#integration-key-form')).toBeNull();
      await open(view);
      expect(view.keyInput().value).toBe('');
    });

    it.each([
      ['empty', '', 'FORM.ISSUE.MIN_LENGTH'],
      ['short', 'a'.repeat(15), 'FORM.ISSUE.MIN_LENGTH'],
      ['long', 'a'.repeat(257), 'FORM.ISSUE.MAX_LENGTH'],
      ['with a space', 'abcdefgh ijklmnop', 'FORM.ISSUE.PATTERN'],
      ['with accents', 'àbcdefghijklmnopq', 'FORM.ISSUE.PATTERN'],
    ])('refuses a key that is %s without calling the API', async (_name, value, issue) => {
      const view = await render();
      await open(view);
      await view.typeKey(value);
      await view.submitKey();
      expect(view.keyError()).toBe(issue);
      expect(view.isOpen(0)).toBe(true);
      await view.typeKey('b'.repeat(16));
      expect(view.keyError()).toBe('');
    });

    it.each([16, 256])('accepts a key of %s characters', async (length) => {
      const view = await render();
      await open(view);
      await view.typeKey('k'.repeat(length));
      await view.submitKey();
      const request = view.patch();
      expect(request.request.body).toEqual({
        integrations: { plateform: { apiKey: 'k'.repeat(length) } },
      });
      request.flush({ data: GROUP });
      await view.view();
    });

    it('sets the key, closes the dialog, forgets the value and never writes it anywhere', async () => {
      const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
        vi.spyOn(console, m).mockImplementation(() => undefined),
      );
      const view = await render();
      await open(view);
      await view.typeKey(KEY);
      view.keyDialogButtons()[1].click();
      await settle();
      expect(view.keyDialogButtons()[1].getAttribute('aria-busy')).toBe('true');
      const request = view.patch();
      expect(request.request.method).toBe('PATCH');
      expect(request.request.body).toEqual({ integrations: { plateform: { apiKey: KEY } } });
      request.flush({
        data: fakeGroup({
          integrations: fakeIntegrations({ plateform: { enabled: false, apiKeySet: true } }),
        }),
      });
      await view.view();
      expect(view.isOpen(0)).toBe(false);
      expect(view.toasts()).toEqual([label('GROUP_SETTINGS.INTEGRATIONS.KEY_SAVED', 'plateform')]);
      expect(view.badge('plateform')).toBe('GROUP_SETTINGS.INTEGRATIONS.KEY_SET');
      expect(view.refresh).toHaveBeenCalledTimes(1);
      expect(view.root.innerHTML).not.toContain(KEY);
      expect(document.body.innerHTML).not.toContain(KEY);
      for (const spy of spies) {
        expect(spy).not.toHaveBeenCalled();
      }
      await open(view);
      expect(view.keyInput().value).toBe('');
    });

    it('shows the issue of the backend on the key field and keeps the dialog open', async () => {
      const view = await render();
      await open(view, 'yellgo');
      await view.typeKey(KEY);
      await view.submitKey();
      view
        .patch()
        .flush(
          errorBody('VALIDATION_ERROR', [
            { field: 'integrations.yellgo.apiKey', issue: 'pattern' },
          ]),
          { status: 422, statusText: 'x' },
        );
      await view.view();
      expect(view.isOpen(0)).toBe(true);
      expect(view.keyError()).toBe('FORM.ISSUE.PATTERN');
      expect(view.toasts()).toEqual([]);
      expect(view.keyDialogButtons()[1].disabled).toBe(false);
    });

    it.each([
      [422, 'VALIDATION_ERROR', 'ERRORS.API.VALIDATION_ERROR'],
      [403, 'FORBIDDEN', 'ERRORS.API.FORBIDDEN'],
      [404, 'NOT_FOUND', 'ERRORS.API.NOT_FOUND'],
      [409, 'CONFLICT', 'GROUP_SETTINGS.ERROR.CONFLICT'],
    ] as const)('closes the dialog and reports a %s in a toast', async (status, code, message) => {
      const view = await render();
      await open(view);
      await view.typeKey(KEY);
      await view.submitKey();
      view.patch().flush(errorBody(code), { status, statusText: 'x' });
      await view.view();
      expect(view.isOpen(0)).toBe(false);
      expect(view.toasts()).toEqual([message]);
      expect(view.root.innerHTML).not.toContain(KEY);
      await open(view);
      expect(view.keyInput().value).toBe('');
    });

    it('closes the dialog from its own close button, forgetting the value', async () => {
      const view = await render();
      await open(view);
      await view.typeKey(KEY);
      view.dialogs()[0].querySelector<HTMLButtonElement>('header button')!.click();
      await view.view();
      expect(view.isOpen(0)).toBe(false);
      expect(view.root.querySelector('#integration-key-form')).toBeNull();
      expect(view.root.innerHTML).not.toContain(KEY);
      await open(view);
      expect(view.keyInput().value).toBe('');
    });

    it('closes the dialog and reports a failure that is not from the API', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const view = await render();
      vi.spyOn(GroupsApi.prototype, 'update').mockRejectedValue(new Error('boom'));
      await open(view);
      await view.typeKey(KEY);
      await view.submitKey();
      expect(view.isOpen(0)).toBe(false);
      expect(view.toasts()).toEqual(['ERRORS.GENERIC.MESSAGE']);
    });

    it('closes the dialog and reports a network failure', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const view = await render();
      await open(view);
      await view.typeKey(KEY);
      await view.submitKey();
      view.patch().error(new ProgressEvent('error'));
      await view.view();
      expect(view.isOpen(0)).toBe(false);
      expect(view.toasts()).toHaveLength(1);
    });
  });

  describe('removing a key', () => {
    it('asks to confirm and removes the key', async () => {
      const view = await render();
      view.byLabel(label('GROUP_SETTINGS.INTEGRATIONS.REMOVE_KEY_LABEL', 'yellgo')).click();
      await view.view();
      expect(view.isOpen(1)).toBe(true);
      expect(view.dialogs()[1].textContent).toContain(
        label('GROUP_SETTINGS.INTEGRATIONS.REMOVE_CONFIRM', 'yellgo'),
      );
      view.confirmButtons()[1].click();
      await settle();
      const request = view.patch();
      expect(request.request.body).toEqual({ integrations: { yellgo: { apiKey: null } } });
      request.flush({
        data: fakeGroup({
          integrations: fakeIntegrations({ yellgo: { enabled: true, apiKeySet: false } }),
        }),
      });
      await view.view();
      expect(view.isOpen(1)).toBe(false);
      expect(view.toasts()).toEqual([label('GROUP_SETTINGS.INTEGRATIONS.KEY_REMOVED', 'yellgo')]);
      expect(view.badge('yellgo')).toBe('GROUP_SETTINGS.INTEGRATIONS.KEY_NOT_SET');
      expect(view.refresh).toHaveBeenCalledTimes(1);
    });

    it('does nothing when the confirmation is cancelled', async () => {
      const view = await render();
      view.byLabel(label('GROUP_SETTINGS.INTEGRATIONS.REMOVE_KEY_LABEL', 'cooperto')).click();
      await view.view();
      view.confirmButtons()[0].click();
      await view.view();
      expect(view.isOpen(1)).toBe(false);
      expect(view.toasts()).toEqual([]);
    });

    it('reports a failure in a toast and closes', async () => {
      const view = await render();
      view.byLabel(label('GROUP_SETTINGS.INTEGRATIONS.REMOVE_KEY_LABEL', 'yellgo')).click();
      await view.view();
      view.confirmButtons()[1].click();
      await settle();
      view.patch().flush(errorBody('FORBIDDEN'), { status: 403, statusText: 'x' });
      await view.view();
      expect(view.isOpen(1)).toBe(false);
      expect(view.toasts()).toEqual(['ERRORS.API.FORBIDDEN']);
      expect(view.badge('yellgo')).toBe('GROUP_SETTINGS.INTEGRATIONS.KEY_SET');
    });
  });

  describe('without a loaded group', () => {
    it('renders nothing and reports no key', async () => {
      emulateNativeDialog();
      const state = fakeSettingsState();
      TestBed.configureTestingModule({
        providers: [...provideApiTesting(), { provide: GroupSettingsState, useValue: state }],
      });
      vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key) => key);
      const fixture = TestBed.createComponent(GroupIntegrations);
      await fixture.whenStable();
      const instance = fixture.componentInstance as unknown as {
        patch(): unknown;
        keySet(provider: string): boolean;
      };
      expect((fixture.nativeElement as HTMLElement).querySelector('form')).toBeNull();
      // Never shown in this state (the form is not rendered); computing it must not throw.
      expect(() => instance.patch()).not.toThrow();
      expect(instance.keySet('yellgo')).toBe(false);
    });
  });
});
