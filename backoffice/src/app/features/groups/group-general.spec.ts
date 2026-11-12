import { TestBed } from '@angular/core/testing';
import { provideApiTesting } from '../../../testing/api';
import { I18nService } from '../../core/i18n/i18n.service';
import { GroupSettingsState } from './group-settings-state';
import { backend, errorBody } from '../../../testing/api';
import { fakeGroup } from '../../../testing/groups';
import { fakeSettingsState, renderGroupSection } from '../../../testing/group-settings';
import { Profile } from '../../core/session/session.types';
import { GroupGeneral } from './group-general';
import { Group, TimeSlot } from './group.types';

const GROUP = fakeGroup();
const NAME = 'GROUP_SETTINGS.GENERAL.NAME';
const DESCRIPTION = 'GROUP_SETTINGS.GENERAL.DESCRIPTION';
const OPENING = 'GROUP_SETTINGS.GENERAL.OPENING_TIME';
const COMPRESS = 'GROUP_SETTINGS.GENERAL.COMPRESS';
const DEMO = 'GROUP_SETTINGS.GENERAL.DEMO';
const FROM = (n: number) => `GROUP_SETTINGS.GENERAL.SLOT_FROM {"number":${n}}`;
const TO = (n: number) => `GROUP_SETTINGS.GENERAL.SLOT_TO {"number":${n}}`;

async function render(options: { profile?: Partial<Profile>; group?: Group } = {}) {
  const view = await renderGroupSection(GroupGeneral, options);
  await view.load();
  const patch = () => backend().expectOne(view.url);
  const languageBox = (code: string) =>
    [...view.root.querySelectorAll<HTMLLabelElement>('fc-language-picker label')]
      .find((l) => l.textContent?.trim().endsWith(`(${code})`))!
      .querySelector('input')!;
  const button = (text: string) =>
    [...view.root.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === text,
    );
  return { ...view, patch, languageBox, button };
}

const slots = (count: number): TimeSlot[] =>
  Array.from({ length: count }, (_, i) => ({
    from: `${String(i % 24).padStart(2, '0')}:00`,
    to: `${String((i % 24) + 1).padStart(2, '0')}:00`,
  }));

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('GroupGeneral', () => {
  describe('display', () => {
    it('shows the stored values and keeps save disabled until something changes', async () => {
      const { control, box, save, root } = await render();
      expect(control(NAME).value).toBe(GROUP.name);
      expect(control(DESCRIPTION).value).toBe(GROUP.description);
      expect(control(OPENING).value).toBe('06:00');
      expect(box(COMPRESS).checked).toBe(false);
      expect(box(DEMO).checked).toBe(false);
      expect(control(FROM(1)).value).toBe('06:00');
      expect(control(TO(1)).value).toBe('12:00');
      expect(root.querySelector('fc-language-picker .count')?.textContent).toContain('"count":2');
      expect(save()?.disabled).toBe(true);
      expect(root.querySelector('.note[role=alert]')).toBeNull();
    });

    it('lets the platform administrator change everything', async () => {
      const { control, save, button, root } = await render();
      expect(control(NAME).disabled).toBe(false);
      expect(control(DEMO).disabled).toBe(false);
      expect(save()).not.toBeNull();
      expect(button('GROUP_SETTINGS.GENERAL.ADD_SLOT')).toBeDefined();
      expect(root.textContent).not.toContain('GROUP_SETTINGS.READ_ONLY');
    });

    it('leaves demo to the platform administrator only', async () => {
      const dealer = await render({ profile: { role: 'D' } });
      expect(dealer.control(NAME).disabled).toBe(false);
      expect(dealer.control(DEMO).disabled).toBe(true);
      document.body.replaceChildren();
      TestBed.resetTestingModule();
      const admin = await render({ profile: { role: 'SA', groupId: GROUP.id } });
      expect(admin.control(NAME).disabled).toBe(false);
      expect(admin.control(DEMO).disabled).toBe(true);
    });

    it('is read-only without groups:update', async () => {
      const { control, save, button, root } = await render({
        profile: { role: 'CA', groupId: GROUP.id, permissions: ['groups:read'] },
      });
      expect(root.querySelector('p.note')?.textContent).toContain('GROUP_SETTINGS.READ_ONLY');
      for (const label of [NAME, DESCRIPTION, OPENING, COMPRESS, DEMO, FROM(1), TO(1)]) {
        expect(control(label).disabled).toBe(true);
      }
      expect(root.querySelector<HTMLFieldSetElement>('fc-language-picker fieldset')?.disabled).toBe(
        true,
      );
      expect(save()).toBeNull();
      expect(button('GROUP_SETTINGS.GENERAL.ADD_SLOT')).toBeUndefined();
      expect(button('GROUP_SETTINGS.GENERAL.REMOVE')).toBeUndefined();
    });

    it('shows a group without description, opening time and slots', async () => {
      const { control, box, root } = await render({
        group: fakeGroup({
          description: null,
          statsSettings: { openingTime: null, compressProductsCategories: true, timeSlots: [] },
        }),
      });
      expect(control(DESCRIPTION).value).toBe('');
      expect(control(OPENING).value).toBe('');
      expect(box(COMPRESS).checked).toBe(true);
      expect(root.querySelectorAll('.slot')).toHaveLength(0);
    });
  });

  describe('touching the fields', () => {
    it('shows a client error once a field was left', async () => {
      const { type, control, view, error } = await render();
      await type(NAME, '');
      expect(error(NAME)).toBe('');
      control(NAME).dispatchEvent(new Event('blur'));
      await view();
      expect(error(NAME)).toBe('FORM.ISSUE.REQUIRED');
    });

    it('accepts the focus leaving every other field', async () => {
      const { control, languageBox, view, save } = await render();
      for (const label of [DESCRIPTION, OPENING, COMPRESS, DEMO, FROM(1), TO(1)]) {
        control(label).dispatchEvent(new Event('blur'));
      }
      languageBox('it').dispatchEvent(new Event('blur'));
      await view();
      expect(save()?.disabled).toBe(true);
    });
  });

  describe('saving', () => {
    it('sends only the changed field and applies the answer', async () => {
      const { type, save, submit, patch, view, toasts, control, refresh } = await render();
      await type(NAME, '  Nuovo nome ');
      expect(save()?.disabled).toBe(false);
      await submit();
      const request = patch();
      expect(request.request.method).toBe('PATCH');
      expect(request.request.body).toEqual({ name: 'Nuovo nome' });
      expect(save()?.disabled).toBe(true);
      expect(save()?.getAttribute('aria-busy')).toBe('true');
      request.flush({ data: fakeGroup({ name: 'Nuovo nome' }) });
      await view();
      expect(toasts()).toEqual(['GROUP_SETTINGS.SAVED']);
      expect(control(NAME).value).toBe('Nuovo nome');
      expect(save()?.disabled).toBe(true);
      expect(save()?.getAttribute('aria-busy')).toBeNull();
      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('sends every kind of change', async () => {
      const { type, toggle, submit, patch, view, control, languageBox, button, root } =
        await render({ group: fakeGroup({ demo: false }) });
      await type(NAME, 'Altro');
      await type(DESCRIPTION, '');
      await toggle(DEMO, true);
      await type(OPENING, '');
      await toggle(COMPRESS, true);
      languageBox('en').checked = false;
      languageBox('en').dispatchEvent(new Event('change'));
      languageBox('fr').checked = true;
      languageBox('fr').dispatchEvent(new Event('change'));
      await view();
      await type(TO(1), '13:00');
      button('GROUP_SETTINGS.GENERAL.ADD_SLOT')!.click();
      await view();
      expect(root.querySelectorAll('.slot')).toHaveLength(2);
      expect(control(FROM(2)).value).toBe('09:00');
      expect(control(TO(2)).value).toBe('10:00');
      await submit();
      const request = patch();
      expect(request.request.body).toEqual({
        name: 'Altro',
        description: null,
        languages: ['it', 'fr'],
        statsSettings: {
          openingTime: null,
          compressProductsCategories: true,
          timeSlots: [
            { from: '06:00', to: '13:00' },
            { from: '09:00', to: '10:00' },
          ],
        },
        demo: true,
      });
      request.flush({ data: fakeGroup() });
      await view();
    });

    it('removes a slot', async () => {
      const { submit, patch, view, root, button } = await render();
      button('GROUP_SETTINGS.GENERAL.REMOVE')!.click();
      await view();
      expect(root.querySelectorAll('.slot')).toHaveLength(0);
      await submit();
      const request = patch();
      expect(request.request.body).toEqual({ statsSettings: { timeSlots: [] } });
      request.flush({ data: fakeGroup() });
      await view();
    });

    it('does not send demo when the dealer cannot change it', async () => {
      const { type, submit, patch, view } = await render({ profile: { role: 'D' } });
      await type(NAME, 'Altro');
      await submit();
      const request = patch();
      expect(request.request.body).toEqual({ name: 'Altro' });
      request.flush({ data: fakeGroup({ name: 'Altro' }) });
      await view();
    });
  });

  describe('validation', () => {
    it('refuses an empty name without calling the API and moves the focus there', async () => {
      const { type, submit, error, control } = await render();
      await type(NAME, '');
      await submit();
      expect(error(NAME)).toBe('FORM.ISSUE.REQUIRED');
      expect(document.activeElement).toBe(control(NAME));
    });

    it('refuses a name or a description that is too long', async () => {
      const { type, submit, error } = await render();
      await type(NAME, 'a'.repeat(201));
      await type(DESCRIPTION, 'a'.repeat(1001));
      await submit();
      expect(error(NAME)).toBe('FORM.ISSUE.MAX_LENGTH');
      expect(error(DESCRIPTION)).toBe('FORM.ISSUE.MAX_LENGTH');
    });

    it('refuses a slot that ends before it starts', async () => {
      const { type, submit, error } = await render();
      await type(TO(1), '06:00');
      await submit();
      expect(error(TO(1))).toBe('FORM.ISSUE.INCORRECT');
    });

    it('refuses too many languages', async () => {
      const codes = ['it', 'en', 'fr', 'de', 'es', 'pt', 'nl', 'sv', 'da', 'fi', 'no'];
      const { submit, root, view } = await render({ group: fakeGroup({ languages: codes }) });
      await view();
      await submit();
      expect(root.querySelector('fc-language-picker fieldset > .error')?.textContent).toContain(
        'FORM.ISSUE.TOO_MANY',
      );
    });

    it('stops adding slots at the limit and refuses more', async () => {
      const { submit, root, button, view } = await render({
        group: fakeGroup({
          statsSettings: {
            openingTime: null,
            compressProductsCategories: false,
            timeSlots: slots(48),
          },
        }),
      });
      expect(button('GROUP_SETTINGS.GENERAL.ADD_SLOT')?.disabled).toBe(true);
      expect(root.querySelector('.note[role=alert]')).toBeNull();
      button('GROUP_SETTINGS.GENERAL.REMOVE')!.click();
      await view();
      expect(button('GROUP_SETTINGS.GENERAL.ADD_SLOT')?.disabled).toBe(false);
      await submit();
      backend()
        .expectOne((r) => r.method === 'PATCH')
        .flush({ data: fakeGroup() });
      await view();
    });

    it('refuses more slots than the limit', async () => {
      const { submit, root } = await render({
        group: fakeGroup({
          statsSettings: {
            openingTime: null,
            compressProductsCategories: false,
            timeSlots: slots(49),
          },
        }),
      });
      await submit();
      expect(root.querySelector('.note[role=alert]')?.textContent).toContain('FORM.ISSUE.TOO_MANY');
    });
  });

  describe('errors of the backend', () => {
    async function rejected(
      status: number,
      code: string,
      details?: { field: string; issue: string }[],
    ) {
      const view = await render();
      await view.type(NAME, 'Altro');
      await view.submit();
      view.patch().flush(errorBody(code, details), { status, statusText: 'x' });
      await view.view();
      return view;
    }

    it('puts each 422 detail under its field', async () => {
      const { error, formError, toasts, save } = await rejected(422, 'VALIDATION_ERROR', [
        { field: 'name', issue: 'taken' },
        { field: 'name', issue: 'required' },
        { field: 'statsSettings.openingTime', issue: 'pattern' },
        { field: 'statsSettings.timeSlots.0.to', issue: 'incorrect' },
        { field: 'description', issue: 'maxLength' },
      ]);
      expect(error(NAME)).toBe('FORM.ISSUE.TAKEN');
      expect(error('GROUP_SETTINGS.GENERAL.OPENING_TIME')).toBe('FORM.ISSUE.PATTERN');
      expect(error(DESCRIPTION)).toBe('FORM.ISSUE.MAX_LENGTH');
      expect(formError()).toBeNull();
      expect(toasts()).toEqual([]);
      expect(save()?.disabled).toBe(false);
    });

    it('shows languages and slots errors on their groups', async () => {
      const { root } = await rejected(422, 'VALIDATION_ERROR', [
        { field: 'languages.2', issue: 'enum' },
        { field: 'statsSettings.timeSlots.1.to', issue: 'incorrect' },
      ]);
      expect(root.querySelector('fc-language-picker fieldset > .error')?.textContent).toContain(
        'FORM.ISSUE.ENUM',
      );
      expect(root.querySelector('.note[role=alert]')?.textContent).toContain(
        'FORM.ISSUE.INCORRECT',
      );
    });

    it('puts a 422 detail on the compress and demo fields', async () => {
      const { error } = await rejected(422, 'VALIDATION_ERROR', [
        { field: 'statsSettings.compressProductsCategories', issue: 'type' },
        { field: 'demo', issue: 'type' },
      ]);
      expect(error(COMPRESS)).toBe('FORM.ISSUE.TYPE');
      expect(error(DEMO)).toBe('FORM.ISSUE.TYPE');
    });

    it('shows a form message for a detail that matches no field', async () => {
      const { formError, error } = await rejected(422, 'VALIDATION_ERROR', [
        { field: 'features.cash', issue: 'unknown' },
        { field: 'name', issue: 'taken' },
      ]);
      expect(formError()).toContain('ERRORS.API.VALIDATION_ERROR');
      expect(error(NAME)).toBe('FORM.ISSUE.TAKEN');
    });

    it('shows a form message for a 422 without details', async () => {
      const { formError, root } = await rejected(422, 'VALIDATION_ERROR');
      expect(formError()).toContain('ERRORS.API.VALIDATION_ERROR');
      expect(root.querySelector('.actions button[type=button]')).toBeNull();
    });

    it('puts a 403 notAllowed on the field', async () => {
      const { error, formError } = await rejected(403, 'FORBIDDEN', [
        { field: 'demo', issue: 'notAllowed' },
      ]);
      expect(error(DEMO)).toBe('FORM.ISSUE.NOT_ALLOWED');
      expect(formError()).toBeNull();
    });

    it('shows a plain 403 and a 404 as form messages', async () => {
      const forbidden = await rejected(403, 'FORBIDDEN');
      expect(forbidden.formError()).toContain('ERRORS.API.FORBIDDEN');
      document.body.replaceChildren();
      TestBed.resetTestingModule();
      const missing = await rejected(404, 'NOT_FOUND');
      expect(missing.formError()).toContain('ERRORS.API.NOT_FOUND');
    });

    it('invites to reload on a 409 and reloads the group', async () => {
      const { formError, button, view, url, root, control } = await rejected(409, 'CONFLICT');
      expect(formError()).toContain('GROUP_SETTINGS.ERROR.CONFLICT');
      button('GROUP_SETTINGS.RELOAD')!.click();
      await view();
      expect(formError()).toBeNull();
      backend()
        .expectOne(url)
        .flush({ data: fakeGroup({ name: 'Cambiato altrove' }) });
      await view();
      expect(control(NAME).value).toBe('Cambiato altrove');
      expect(root.querySelector('fc-form-error')).toBeNull();
    });

    it('maps a 409 with details on the fields', async () => {
      const { error, formError } = await rejected(409, 'CONFLICT', [
        { field: 'name', issue: 'taken' },
      ]);
      expect(error(NAME)).toBe('FORM.ISSUE.TAKEN');
      expect(formError()).toBeNull();
    });

    it('reports a network failure', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const view = await render();
      await view.type(NAME, 'Altro');
      await view.submit();
      view.patch().error(new ProgressEvent('error'));
      await view.view();
      expect(view.formError()).toContain('ERRORS.');
    });
  });

  describe('without a loaded group', () => {
    it('renders nothing and has nothing to send', async () => {
      const state = fakeSettingsState();
      TestBed.configureTestingModule({
        providers: [...provideApiTesting(), { provide: GroupSettingsState, useValue: state }],
      });
      vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key) => key);
      const fixture = TestBed.createComponent(GroupGeneral);
      await fixture.whenStable();
      expect((fixture.nativeElement as HTMLElement).querySelector('form')).toBeNull();
      expect((fixture.componentInstance as unknown as { patch(): unknown }).patch()).toEqual({});
      state.group.set(GROUP);
      await fixture.whenStable();
      expect((fixture.nativeElement as HTMLElement).querySelector('form')).not.toBeNull();
    });
  });
});
