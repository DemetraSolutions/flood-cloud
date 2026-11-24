import { TestBed } from '@angular/core/testing';
import { provideApiTesting, settle } from '../../../../testing/api';
import { fakeApiKey } from '../../../../testing/api-keys';
import { apiError, cleanUpEditor, renderEditor } from '../../../../testing/catalog-editor';
import { ApiPage } from '../../../core/api/api.types';
import { ReferenceApi, ReferenceItem, ReferenceQuery } from '../../../core/reference/reference-api';
import { ApiKeyEditor } from './api-key-editor';
import {
  ApiKeyCreateBody,
  ApiKeyPatch,
  PLATFORM_DEFAULTS,
  PublicApiSettings,
  utcDay,
} from './api-key.types';

const L = 'PUBLIC_API.KEY';
const NAME = `${L}.NAME`;
const PLACES_READ = 'PUBLIC_API.PERMISSION.PLACES_READ.LABEL';
const COMPANIES_READ = 'PUBLIC_API.PERMISSION.COMPANIES_READ.LABEL';
const CATALOG_READ = 'PUBLIC_API.PERMISSION.CATALOG_READ.LABEL';
const CATALOG_WRITE = 'PUBLIC_API.PERMISSION.CATALOG_WRITE.LABEL';
const WARNING = `${L}.WRITE_UNRESTRICTED_WARNING`;
const EXPIRES = `${L}.EXPIRES`;
const PER_MINUTE = `${L}.PER_MINUTE`;
const PER_DAY = `${L}.PER_DAY`;
const COMPANIES = `${L}.COMPANIES`;
const PLACES = `${L}.PLACES`;

const INHERITED: PublicApiSettings = {
  ...PLATFORM_DEFAULTS,
  defaultRateLimitPerMinute: 30,
  defaultDailyQuota: 500,
};
const ALL_COMPANIES: ReferenceItem[] = [
  { id: 'c1', name: 'Alfa Srl' },
  { id: 'c2', name: 'Beta Srl' },
];
const ALL_PLACES: ReferenceItem[] = [
  { id: 'p1', name: 'Centro' },
  { id: 'p2', name: 'Nord' },
];

function pageOf(items: ReferenceItem[], query: ReferenceQuery): ApiPage<ReferenceItem> {
  const data =
    query.ids === undefined ? items : items.filter((item) => query.ids?.includes(item.id));
  return { data, page: { limit: 25, next: null } };
}

async function render(inputs: Record<string, unknown> = {}) {
  TestBed.configureTestingModule({ providers: provideApiTesting() });
  const companies = vi
    .spyOn(ReferenceApi.prototype, 'companies')
    .mockImplementation(async (_group, query = {}) => pageOf(ALL_COMPANIES, query));
  const places = vi
    .spyOn(ReferenceApi.prototype, 'places')
    .mockImplementation(async (_group, query = {}) => pageOf(ALL_PLACES, query));
  const rendered = await renderEditor<ApiKeyCreateBody | ApiKeyPatch, ApiKeyEditor>(
    ApiKeyEditor,
    { groupId: 'g1', inherited: INHERITED, canSetLimits: true, ...inputs },
    async (fixture) => {
      await settle();
      fixture.detectChanges();
      await settle();
      fixture.detectChanges();
    },
  );
  const view = async () => {
    await settle();
    rendered.fixture.detectChanges();
    await settle();
    rendered.fixture.detectChanges();
  };
  const group = (legend: string) =>
    [...rendered.root.querySelectorAll('fieldset')].find(
      (f) => f.querySelector(':scope > legend')?.textContent?.trim() === legend,
    )!;
  const pick = async (legend: string, name: string, on = true) => {
    const box = [...group(legend).querySelectorAll('li label')]
      .find((l) => l.textContent?.trim() === name)!
      .querySelector('input')!;
    box.checked = on;
    box.dispatchEvent(new Event('change'));
    await view();
  };
  const chosen = (legend: string) =>
    [...group(legend).querySelectorAll('ul.chosen li > span:first-child')].map((e) =>
      e.textContent?.trim(),
    );
  const pickerError = (legend: string) =>
    [...group(legend).querySelectorAll('.error')].at(-1)?.textContent?.trim() ?? '';
  const permissionsError = () =>
    rendered.root.querySelector('#' + CSS.escape(permissionsId()))?.textContent?.trim() ?? '';
  const permissionsId = () =>
    rendered.root.querySelector('fieldset')?.getAttribute('aria-describedby') ??
    rendered.root.querySelector('.error[id^=fc-api-key-permissions-error]')!.id;
  return {
    ...rendered,
    view,
    group,
    pick,
    chosen,
    companies,
    places,
    permissionsError,
    pickerError,
  };
}

afterEach(cleanUpEditor);

describe('ApiKeyEditor: creation', () => {
  it('starts empty, with the inherited limits', async () => {
    const { control, check, save } = await render();
    expect((control(NAME) as HTMLInputElement).value).toBe('');
    for (const label of [PLACES_READ, COMPANIES_READ, CATALOG_READ, CATALOG_WRITE]) {
      expect((control(label) as HTMLInputElement).checked).toBe(false);
    }
    expect((control(EXPIRES) as HTMLInputElement).value).toBe('');
    expect((control(PER_MINUTE) as HTMLInputElement).value).toBe('30');
    expect((control(PER_DAY) as HTMLInputElement).value).toBe('500');
    expect(save().disabled).toBe(false);
    await check(PLACES_READ, false);
  });

  it('lists the permissions with their description', async () => {
    const { root } = await render();
    expect(root.textContent).toContain('PUBLIC_API.PERMISSION.PLACES_READ.HINT');
    expect(root.textContent).toContain('PUBLIC_API.PERMISSION.COMPANIES_READ.HINT');
    expect(root.textContent).toContain('PUBLIC_API.PERMISSION.CATALOG_READ.HINT');
    expect(root.textContent).toContain('PUBLIC_API.PERMISSION.CATALOG_WRITE.HINT');
  });

  it('warns only when the catalog write is ticked on a key without restrictions', async () => {
    const { root, check, pick, view } = await render();
    expect(root.textContent).not.toContain(WARNING);
    await check(CATALOG_WRITE, true);
    expect(root.querySelector('.warning')?.getAttribute('role')).toBe('status');
    expect(root.textContent).toContain(WARNING);
    await pick(PLACES, 'Centro');
    await view();
    expect(root.textContent).not.toContain(WARNING);
    await pick(PLACES, 'Centro', false);
    expect(root.textContent).toContain(WARNING);
    await pick(COMPANIES, 'Alfa Srl');
    expect(root.textContent).not.toContain(WARNING);
    await pick(COMPANIES, 'Alfa Srl', false);
    await check(CATALOG_WRITE, false);
    expect(root.textContent).not.toContain(WARNING);
    await check(CATALOG_READ, true);
    expect(root.textContent).not.toContain(WARNING);
  });

  it('sends the name and the permissions when nothing else is filled in', async () => {
    const { type, check, submit, saved } = await render();
    await type(NAME, ' Webshop ');
    await check(CATALOG_READ, true);
    await check(PLACES_READ, true);
    await submit();
    expect(saved).toEqual([{ name: 'Webshop', permissions: ['places:read', 'catalog:read'] }]);
  });

  it('sends restrictions, the expiry and the limits the platform administrator changed', async () => {
    const { type, check, submit, saved, pick, chosen, places, companies } = await render();
    await type(NAME, 'Webshop');
    await check(COMPANIES_READ, true);
    await pick(COMPANIES, 'Alfa Srl');
    await pick(PLACES, 'Nord');
    await pick(PLACES, 'Centro');
    await pick(PLACES, 'Centro', false);
    await type(EXPIRES, '2999-01-01');
    // Too far ahead: refused.
    await submit();
    expect(saved).toEqual([]);
    const near = utcDay(new Date(Date.now() + 86_400_000 * 10));
    await type(EXPIRES, near);
    await type(PER_MINUTE, '45');
    await type(PER_DAY, '900');
    await submit();
    expect(saved).toEqual([
      {
        name: 'Webshop',
        permissions: ['companies:read'],
        restrictions: { companyIds: ['c1'], placeIds: ['p2'] },
        expiresAt: `${near}T23:59:59.999Z`,
        rateLimitPerMinute: 45,
        dailyQuota: 900,
      },
    ]);
    expect(chosen(COMPANIES)).toEqual(['Alfa Srl']);
    expect(companies).toHaveBeenCalledWith('g1', expect.objectContaining({ q: '' }));
    expect(places).toHaveBeenCalled();
  });

  it('shows the inherited limits read-only to a dealer, and never sends them', async () => {
    const { control, type, check, submit, saved, root } = await render({ canSetLimits: false });
    expect((control(PER_MINUTE) as HTMLInputElement).disabled).toBe(true);
    expect((control(PER_MINUTE) as HTMLInputElement).value).toBe('30');
    expect((control(PER_DAY) as HTMLInputElement).disabled).toBe(true);
    expect(root.textContent).toContain('PUBLIC_API.KEY.LIMITS_READ_ONLY');
    expect(root.textContent).not.toContain('PUBLIC_API.KEY.LIMITS_HINT');
    await type(NAME, 'Webshop');
    await check(PLACES_READ, true);
    await submit();
    expect(saved).toEqual([{ name: 'Webshop', permissions: ['places:read'] }]);
  });

  describe('validation', () => {
    it('asks for a name and at least one permission, and says where', async () => {
      const { submit, saved, error, control, permissionsError, check, view } = await render();
      await submit();
      expect(saved).toEqual([]);
      expect(error(NAME)).toBe('FORM.ISSUE.REQUIRED');
      expect(control(NAME).getAttribute('aria-invalid')).toBe('true');
      expect(permissionsError()).toBe('FORM.ISSUE.REQUIRED');
      await check(PLACES_READ, true);
      await view();
      expect(permissionsError()).toBe('');
    });

    it('refuses a name over 100 characters', async () => {
      const { type, submit, error, check } = await render();
      await check(PLACES_READ, true);
      await type(NAME, 'x'.repeat(101));
      await submit();
      expect(error(NAME)).toBe('FORM.ISSUE.MAX_LENGTH');
    });

    it.each([
      ['2020-01-01', 'FORM.ISSUE.MINIMUM'],
      ['2999-01-01', 'FORM.ISSUE.MAXIMUM'],
    ])('refuses the expiry %s', async (day, message) => {
      const { type, submit, error, check } = await render();
      await check(PLACES_READ, true);
      await type(NAME, 'Webshop');
      await type(EXPIRES, day);
      await submit();
      expect(error(EXPIRES)).toBe(message);
    });

    it('accepts today and the latest day as expiry', async () => {
      const { type, submit, saved, check } = await render();
      await check(PLACES_READ, true);
      await type(NAME, 'Webshop');
      await type(EXPIRES, utcDay(new Date()));
      await submit();
      expect(saved).toHaveLength(1);
    });

    it.each([
      [PER_MINUTE, '0', 'FORM.ISSUE.MINIMUM'],
      [PER_MINUTE, '6001', 'FORM.ISSUE.MAXIMUM'],
      [PER_DAY, '10000001', 'FORM.ISSUE.MAXIMUM'],
      [PER_DAY, '', 'FORM.ISSUE.REQUIRED'],
    ])('refuses %s = "%s"', async (label, value, message) => {
      const { type, submit, error, check, saved } = await render();
      await check(PLACES_READ, true);
      await type(NAME, 'Webshop');
      await type(label, value);
      await submit();
      expect(error(label)).toBe(message);
      expect(saved).toEqual([]);
    });

    it('refuses more than 100 ids in a restriction', async () => {
      const { fixture, submit, saved, check, type, pickerError, view } = await render();
      await check(PLACES_READ, true);
      await type(NAME, 'Webshop');
      const many = Array.from({ length: 101 }, (_, i) => `id${i}`);
      (
        fixture.componentInstance as unknown as {
          model: { update(f: (m: object) => object): void };
        }
      ).model.update((model) => ({ ...model, companyIds: many, placeIds: many }));
      await view();
      await submit();
      expect(saved).toEqual([]);
      expect(pickerError(COMPANIES)).toBe('FORM.ISSUE.TOO_MANY');
      expect(pickerError(PLACES)).toBe('FORM.ISSUE.TOO_MANY');
    });

    it('marks the fields as touched when they lose the focus', async () => {
      const { control, error, view, type } = await render();
      await type(PER_MINUTE, '0');
      expect(error(PER_MINUTE)).toBe('');
      for (const label of [NAME, EXPIRES, PER_MINUTE, PER_DAY, PLACES_READ]) {
        control(label).dispatchEvent(new Event('blur'));
      }
      for (const box of document.querySelectorAll('fc-reference-picker input[type=checkbox]')) {
        box.dispatchEvent(new Event('blur'));
      }
      await view();
      expect(error(PER_MINUTE)).toBe('FORM.ISSUE.MINIMUM');
      expect(error(NAME)).toBe('FORM.ISSUE.REQUIRED');
    });
  });

  describe('errors of the backend', () => {
    it('puts the details on the fields', async () => {
      const { set, error, formError, pickerError } = await render();
      await set({
        error: apiError('VALIDATION_ERROR', [
          { field: 'name', issue: 'maxLength' },
          { field: 'expiresAt', issue: 'minimum' },
          { field: 'rateLimitPerMinute', issue: 'notAllowed' },
          { field: 'dailyQuota', issue: 'maximum' },
          { field: 'restrictions.companyIds.0', issue: 'incorrect' },
          { field: 'restrictions.placeIds.1', issue: 'incorrect' },
        ]),
      });
      expect(error(NAME)).toBe('FORM.ISSUE.MAX_LENGTH');
      expect(error(EXPIRES)).toBe('FORM.ISSUE.MINIMUM');
      expect(error(PER_MINUTE)).toBe('FORM.ISSUE.NOT_ALLOWED');
      expect(error(PER_DAY)).toBe('FORM.ISSUE.MAXIMUM');
      expect(pickerError(COMPANIES)).toBe('FORM.ISSUE.INCORRECT');
      expect(pickerError(PLACES)).toBe('FORM.ISSUE.INCORRECT');
      expect(formError()).toBeNull();
    });

    it('shows a permissions error of the backend under the permissions', async () => {
      const { set, permissionsError } = await render();
      await set({
        error: apiError('VALIDATION_ERROR', [{ field: 'permissions.0', issue: 'enum' }]),
      });
      expect(permissionsError()).toBe('FORM.ISSUE.ENUM');
    });

    it('explains that the group has too many active keys', async () => {
      const { set, formError } = await render();
      await set({ error: apiError('CONFLICT') });
      expect(formError()).toBe('PUBLIC_API.ERROR.TOO_MANY');
    });
  });

  it('is saving while busy and can be cancelled', async () => {
    const { set, save, cancel, cancelled } = await render();
    await set({ busy: true });
    expect(save().disabled).toBe(true);
    expect(cancel().disabled).toBe(true);
    await set({ busy: false });
    cancel().click();
    expect(cancelled()).toBe(1);
  });
});

describe('ApiKeyEditor: modification', () => {
  const KEY = fakeApiKey({
    permissions: ['places:read'],
    restrictions: { companyIds: ['c1'], placeIds: ['p1', 'p2'] },
    expiresAt: '2999-01-01T23:59:59.999Z',
    rateLimitPerMinute: 5,
    dailyQuota: 50,
  });

  it('starts from the key, resolves the names of the restrictions and has nothing to save', async () => {
    const { control, save, chosen, companies, places } = await render({ item: KEY });
    expect((control(NAME) as HTMLInputElement).value).toBe('Webshop');
    expect((control(PLACES_READ) as HTMLInputElement).checked).toBe(true);
    expect((control(COMPANIES_READ) as HTMLInputElement).checked).toBe(false);
    expect((control(PER_MINUTE) as HTMLInputElement).value).toBe('5');
    expect((control(PER_DAY) as HTMLInputElement).value).toBe('50');
    expect(chosen(COMPANIES)).toEqual(['Alfa Srl']);
    expect(chosen(PLACES)).toEqual(['Centro', 'Nord']);
    expect(companies).toHaveBeenCalledWith('g1', { ids: ['c1'], limit: 100 });
    expect(places).toHaveBeenCalledWith('g1', { ids: ['p1', 'p2'], limit: 100 });
    expect(save().disabled).toBe(true);
  });

  it('sends only what changed', async () => {
    const { type, check, submit, saved, pick, save } = await render({ item: KEY });
    await type(NAME, 'Altro');
    await check(CATALOG_READ, true);
    await pick(COMPANIES, 'Beta Srl');
    await pick(PLACES, 'Nord', false);
    await type(EXPIRES, '');
    await type(PER_MINUTE, '6');
    expect(save().disabled).toBe(false);
    await submit();
    expect(saved).toEqual([
      {
        name: 'Altro',
        permissions: ['places:read', 'catalog:read'],
        restrictions: { companyIds: ['c1', 'c2'], placeIds: ['p1'] },
        expiresAt: null,
        rateLimitPerMinute: 6,
      },
    ]);
  });

  it('does not check an expiry that was kept, even if it is close to its end', async () => {
    const { type, submit, saved } = await render({
      item: fakeApiKey({ expiresAt: '2020-01-01T23:59:59.999Z' }),
    });
    await type(NAME, 'Altro');
    await submit();
    expect(saved).toEqual([{ name: 'Altro' }]);
  });

  it('shows the limits of the key read-only to a dealer, and never sends them', async () => {
    const { control, type, submit, saved } = await render({ item: KEY, canSetLimits: false });
    expect((control(PER_MINUTE) as HTMLInputElement).disabled).toBe(true);
    expect((control(PER_MINUTE) as HTMLInputElement).value).toBe('5');
    await type(NAME, 'Altro');
    await submit();
    expect(saved).toEqual([{ name: 'Altro' }]);
  });

  it('explains that a revoked or expired key cannot be changed', async () => {
    const { set, formError } = await render({ item: KEY });
    await set({ error: apiError('CONFLICT') });
    expect(formError()).toBe('PUBLIC_API.ERROR.NOT_EDITABLE');
  });

  it('copes with a key without restrictions', async () => {
    const { chosen, save } = await render({ item: fakeApiKey() });
    expect(chosen(COMPANIES)).toEqual([]);
    expect(save().disabled).toBe(true);
  });
});
