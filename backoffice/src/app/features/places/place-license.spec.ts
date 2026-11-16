import { TestBed } from '@angular/core/testing';
import { backend } from '../../../testing/api';
import { GROUP, fakePlace } from '../../../testing/places';
import {
  ETAG,
  drainSeries,
  expectPlace,
  fail,
  flushPlace,
  optionsOf,
  renderPlacePage,
} from '../../../testing/places-page';

const PLAN = 'PLACES.LICENSE.PLAN';
const EXPIRATION = 'PLACES.LICENSE.EXPIRATION_DATE';
const STATUS = 'PLACES.LICENSE.STATUS';
const SENTRY = 'PLACES.LICENSE.SENTRY';
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

const license = (overrides: Record<string, unknown> = {}) => ({
  plan: 'advanced',
  expirationDate: '2030-01-01T10:30:00.000Z',
  status: 'active' as const,
  sentry: false,
  ...overrides,
});

const checked = (field: HTMLInputElement | HTMLSelectElement) =>
  (field as HTMLInputElement).checked;

describe('PlaceLicense', () => {
  describe('display', () => {
    it('shows the stored license with save disabled until something changes', async () => {
      const { control, button, text } = await renderPlacePage({ path: 'license' });
      expect(control(PLAN).value).toBe('advanced');
      expect(control(EXPIRATION).value).toBe('2030-01-01');
      expect(control(STATUS).value).toBe('active');
      expect(checked(control(SENTRY))).toBe(false);
      expect(button(SAVE)?.disabled).toBe(true);
      expect(text()).not.toContain('PLACES.RESERVED_NOTE');
      expect(text()).not.toContain('PLACES.LICENSE.PLAN_HINT');
    });

    it('shows a license without an expiration date as empty', async () => {
      const { control } = await renderPlacePage({
        path: 'license',
        place: fakePlace({
          license: { plan: 'basic', expirationDate: null, status: 'disabled', sentry: true },
        }),
      });
      expect(control(EXPIRATION).value).toBe('');
      expect(control(STATUS).value).toBe('disabled');
      expect(checked(control(SENTRY))).toBe(true);
    });

    it('offers the plans and the two statuses', async () => {
      const { control } = await renderPlacePage({ path: 'license' });
      expect(optionsOf(control(PLAN) as HTMLSelectElement)).toEqual([
        'basic',
        'advanced',
        'enterprice',
        'tgm-secondary',
        'desk-secondary',
      ]);
      expect(optionsOf(control(STATUS) as HTMLSelectElement)).toEqual(['active', 'disabled']);
      const labels = [...(control(STATUS) as HTMLSelectElement).options].map((o) =>
        o.textContent?.trim(),
      );
      expect(labels).toEqual(['PLACES.STATUS.ACTIVE', 'PLACES.STATUS.DISABLED']);
    });

    it('never submits the form natively', async () => {
      const { root } = await renderPlacePage({ path: 'license' });
      const submit = new Event('submit', { cancelable: true });
      root.querySelector('form')!.dispatchEvent(submit);
      expect(submit.defaultPrevented).toBe(true);
    });

    it('marks the fields as touched when the user leaves them', async () => {
      const { blurAll, control } = await renderPlacePage({ path: 'license' });
      await blurAll();
      expect(control(PLAN).getAttribute('aria-invalid')).toBeNull();
    });
  });

  describe('roles', () => {
    it('lets a platform administrator change every field', async () => {
      const { control, text } = await renderPlacePage({ path: 'license' });
      for (const label of [PLAN, EXPIRATION, STATUS, SENTRY]) {
        expect(control(label).disabled).toBe(false);
      }
      expect(text()).not.toContain('PLACES.LICENSE.PLAN_HINT');
    });

    it('lets a dealer change the expiration date and the status, and tells why not the rest', async () => {
      const { control, text } = await renderPlacePage({
        path: 'license',
        profile: { role: 'D', groupId: null },
      });
      expect(control(PLAN).disabled).toBe(true);
      expect(control(SENTRY).disabled).toBe(true);
      expect(control(EXPIRATION).disabled).toBe(false);
      expect(control(STATUS).disabled).toBe(false);
      expect(text()).toContain('PLACES.LICENSE.PLAN_HINT');
      expect(text()).not.toContain('PLACES.RESERVED_NOTE');
    });

    it.each(['SA', 'CA', 'PA'] as const)(
      'shows a %s the license read-only with a note',
      async (role) => {
        const { control, text, button } = await renderPlacePage({
          path: 'license',
          profile: { role, groupId: GROUP },
        });
        for (const label of [PLAN, EXPIRATION, STATUS, SENTRY]) {
          expect(control(label).disabled).toBe(true);
        }
        expect(text()).toContain('PLACES.RESERVED_NOTE');
        expect(button(SAVE)).toBeDefined();
      },
    );

    it('shows no save button without the permission to update', async () => {
      const { button, control } = await renderPlacePage({
        path: 'license',
        permissions: ['places:read', 'profile:read'],
      });
      expect(button(SAVE)).toBeUndefined();
      expect(control(STATUS).disabled).toBe(true);
    });
  });

  describe('saving', () => {
    it('sends the whole license with a PUT, keeping the stored instant of an unchanged date', async () => {
      const { type, click, toasts, view, button } = await renderPlacePage({ path: 'license' });
      await type(PLAN, 'enterprice');
      await type(STATUS, 'disabled');
      await click(SAVE);
      const req = expectPlace('/license');
      expect(req.request.method).toBe('PUT');
      expect(req.request.headers.get('If-Match')).toBe(ETAG);
      expect(req.request.body).toEqual({
        plan: 'enterprice',
        expirationDate: '2030-01-01T10:30:00.000Z',
        status: 'disabled',
        sentry: false,
      });
      flushPlace(req, fakePlace({ license: license({ plan: 'enterprice', status: 'disabled' }) }));
      await view();
      expect(toasts()).toEqual(['PLACES.SAVED']);
      expect(button(SAVE)?.disabled).toBe(true);
    });

    it('sends the new date and the Sentry switch', async () => {
      const { type, toggle, click, view } = await renderPlacePage({ path: 'license' });
      await type(EXPIRATION, '2032-05-06');
      await toggle(SENTRY, true);
      await click(SAVE);
      const req = expectPlace('/license');
      expect(req.request.body).toEqual({
        plan: 'advanced',
        expirationDate: '2032-05-06',
        status: 'active',
        sentry: true,
      });
      flushPlace(
        req,
        fakePlace({
          license: license({ expirationDate: '2032-05-06T00:00:00.000Z', sentry: true }),
        }),
      );
      await view();
    });

    it('sends a null date when the date is cleared', async () => {
      const { type, click, view } = await renderPlacePage({ path: 'license' });
      await type(EXPIRATION, '');
      await click(SAVE);
      const req = expectPlace('/license');
      expect(req.request.body).toMatchObject({ expirationDate: null });
      flushPlace(req, fakePlace({ license: license({ expirationDate: null }) }));
      await view();
    });

    it('shows the errors of the server on the fields and says the user is not allowed', async () => {
      const { type, click, view, error, text } = await renderPlacePage({
        path: 'license',
        profile: { role: 'D', groupId: null },
      });
      await type(STATUS, 'disabled');
      await click(SAVE);
      fail(expectPlace('/license'), 403, 'FORBIDDEN', [
        { field: 'license.status', issue: 'notAllowed' },
      ]);
      await view();
      expect(text()).toContain('PLACES.NOT_ALLOWED');
      expect(error(STATUS)).toBe('FORM.ISSUE.NOT_ALLOWED');
    });

    it('offers the reload after a 412', async () => {
      const { type, click, view, text } = await renderPlacePage({ path: 'license' });
      await type(STATUS, 'disabled');
      await click(SAVE);
      fail(expectPlace('/license'), 412, 'PRECONDITION_FAILED');
      await view();
      expect(text()).toContain('PLACES.CONFLICT');
      expect(text()).toContain('PLACES.RELOAD');
    });
  });
});
