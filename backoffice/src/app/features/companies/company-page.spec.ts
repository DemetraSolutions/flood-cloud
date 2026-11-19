import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { backend, errorBody, settle } from '../../../testing/api';
import {
  COMPANY,
  COMPANY_URL,
  ETAG,
  GROUP,
  answerLookups,
  fakeCompany,
  renderCompany,
} from '../../../testing/companies';
import { emulateNativeDialog } from '../../../testing/dialog';
import { AppConfig } from '../../core/config/app-config';
import { GroupContext } from '../../core/groups/group-context';

const NAME = 'COMPANIES.GENERAL.NAME';
const SAVE_ALL = 'COMPANIES.SAVE_ALL';
const IBAN = 'COMPANIES.BANKS.IBAN {"number":1}';
const PEC = 'COMPANIES.E_INVOICING.PEC';

afterEach(() => {
  sessionStorage.clear();
  try {
    backend().verify();
  } finally {
    vi.restoreAllMocks();
    document.body.replaceChildren();
    TestBed.resetTestingModule();
  }
});

async function render(options: Parameters<typeof renderCompany>[0] = {}) {
  emulateNativeDialog();
  const view = await renderCompany(options);
  const router = TestBed.inject(Router);
  const tabs = () => [...view.root.querySelectorAll<HTMLAnchorElement>('nav a')];
  const tabNames = () => tabs().map((a) => a.getAttribute('href')!.split('/').pop());
  const goTo = async (path: string) => {
    tabs()
      .find((a) => a.getAttribute('href')!.endsWith(path))!
      .click();
    await view.view();
    // A tab may ask for lookups of its own.
    await answerLookups();
    await view.view();
  };
  const leave = async () => {
    const navigation = router.navigateByUrl('/elsewhere');
    await view.view();
    return navigation;
  };
  const dialogButton = (text: string) =>
    [...view.root.querySelectorAll<HTMLButtonElement>('dialog[open] button')].find(
      (b) => b.textContent?.trim() === text,
    )!;
  return { ...view, router, tabs, tabNames, goTo, leave, dialogButton };
}

/** Renders again in a new test module, for tests that compare several users. */
async function fresh(options: Parameters<typeof renderCompany>[0] = {}) {
  backend().verify();
  document.body.replaceChildren();
  TestBed.resetTestingModule();
  return render(options);
}

describe('CompanyPage', () => {
  describe('header', () => {
    it('shows the name with "Salva tutto" disabled until something changes', async () => {
      const { root, button, type } = await render();
      expect(root.querySelector('h1')?.textContent).toBe('Azienda Esempio Srl');
      expect(button(SAVE_ALL)?.disabled).toBe(true);
      await type(NAME, 'Altro');
      expect(button(SAVE_ALL)?.disabled).toBe(false);
    });

    it('tells a company in the trash or disabled', async () => {
      const trashed = await render({ company: fakeCompany({ trashed: true }) });
      expect(trashed.text()).toContain('COMPANIES.STATUS.TRASHED');
      const disabled = await fresh({ company: fakeCompany({ status: 'disabled' }) });
      expect(disabled.text()).toContain('COMPANIES.STATUS.DISABLED');
      expect(disabled.text()).not.toContain('COMPANIES.STATUS.TRASHED');
    });

    it('offers no saving to whoever cannot update', async () => {
      const { button, text } = await render({
        permissions: ['companies:read', 'groups:read', 'profile:read'],
      });
      expect(button(SAVE_ALL)).toBeUndefined();
      expect(text()).toContain('COMPANIES.READ_ONLY');
    });

    it('waits for the company before showing anything', async () => {
      const { root, text, view } = await render({ answer: false, lookups: false });
      expect(text()).toContain('COMMON.LOADING');
      expect(root.querySelector('h1')).toBeNull();
      backend().expectOne(COMPANY_URL).flush({ data: fakeCompany() });
      await view();
      await answerLookups();
    });

    it('asks for the features of the group and leaves the working group alone', async () => {
      const { ensure } = await render();
      expect(ensure).toHaveBeenCalledWith(GROUP);
      expect(TestBed.inject(GroupContext).groupId()).toBeNull();
    });

    it('names the group of the record when it is not the working group, and not when it is', async () => {
      const { root, view } = await render();
      expect(root.querySelector('.record-group')?.textContent).toContain('RECORD_GROUP.LABEL');
      expect(root.querySelector('.record-group a')?.getAttribute('href')).toBe(
        `/groups/${GROUP}/settings`,
      );
      TestBed.inject(GroupContext).choose({ id: GROUP, name: 'Gruppo Esempio' });
      await view();
      expect(root.querySelector('.record-group')).toBeNull();
      sessionStorage.clear();
    });
  });

  describe('load failures', () => {
    it('shows the error with a retry and a way back', async () => {
      const { root, view } = await render({ answer: false, lookups: false });
      backend()
        .expectOne(COMPANY_URL)
        .flush(errorBody('NOT_FOUND'), {
          status: 404,
          statusText: 'x',
          headers: { 'X-Request-Id': 'r-1' },
        });
      await view();
      const state = root.querySelector('fc-error-state')!;
      expect(state.textContent).toContain('COMPANIES.LOAD_ERROR');
      expect(state.textContent).toContain('ERRORS.API.NOT_FOUND');
      expect(state.textContent).toContain('r-1');
      // No working group: the way back is the cross-group list.
      expect(root.querySelector<HTMLAnchorElement>('p a')?.getAttribute('href')).toBe(
        '/companies',
      );
      state.querySelector('button')!.click();
      await view();
      backend()
        .expectOne(COMPANY_URL)
        .flush({ data: fakeCompany() }, { headers: { ETag: ETAG } });
      await view();
      await answerLookups();
      await view();
      expect(root.querySelector('fc-error-state')).toBeNull();
      expect(root.querySelector('h1')?.textContent).toBe('Azienda Esempio Srl');
      await settle();
    });

    it('reports an unexpected failure generically', async () => {
      const { root, view } = await render({
        answer: false,
        lookups: false,
        providers: [{ provide: AppConfig, useValue: { apiBaseUrl: signal(null) } }],
      });
      await view();
      expect(root.querySelector('fc-error-state')?.textContent).toContain('ERRORS.GENERIC.MESSAGE');
    });
  });

  describe('tabs', () => {
    it('shows every tab to a platform administrator whose group has the modules', async () => {
      const { tabNames } = await render();
      expect(tabNames()).toEqual([
        COMPANY,
        'e-invoicing',
        'invoice-numbering',
        'bank-accounts',
        'meal-vouchers',
        'customer-app',
        'media',
      ]);
    });

    it('shows the customer app and the meal vouchers to platform administrators and dealers whatever the modules, the media only with the module', async () => {
      for (const role of ['PSA', 'D'] as const) {
        const { tabNames } = await (role === 'PSA' ? render : fresh)({
          features: [],
          profile: { role },
        });
        expect(tabNames()).toEqual([
          COMPANY,
          'e-invoicing',
          'invoice-numbering',
          'bank-accounts',
          'meal-vouchers',
          'customer-app',
        ]);
      }
    });

    it('shows the others only the tabs the modules of the group enable', async () => {
      const none = await render({ features: [], profile: { role: 'SA', groupId: GROUP } });
      expect(none.tabNames()).toEqual([
        COMPANY,
        'e-invoicing',
        'invoice-numbering',
        'bank-accounts',
      ]);
      const app = await fresh({
        features: ['customersApp'],
        profile: { role: 'SA', groupId: GROUP },
      });
      expect(app.tabNames()).toContain('customer-app');
      expect(app.tabNames()).not.toContain('meal-vouchers');
      const rooms = await fresh({
        features: ['rooms', 'media'],
        profile: { role: 'CA', groupId: GROUP },
      });
      expect(rooms.tabNames()).toContain('meal-vouchers');
      expect(rooms.tabNames()).toContain('media');
      expect(rooms.tabNames()).not.toContain('customer-app');
    });

    it('marks the current tab', async () => {
      const { tabs, goTo } = await render();
      expect(tabs()[0].getAttribute('aria-current')).toBe('page');
      await goTo('bank-accounts');
      expect(tabs()[0].getAttribute('aria-current')).toBeNull();
      expect(tabs()[3].getAttribute('aria-current')).toBe('page');
    });

    it('keeps the drafts of the tabs while the user moves between them', async () => {
      const { type, goTo, control, text } = await render();
      await type(NAME, 'Bozza Srl');
      expect(text()).toContain('COMPANIES.UNSAVED');
      await goTo('e-invoicing');
      await type(PEC, 'bozza@pec.it');
      await goTo(COMPANY);
      expect(control(NAME).value).toBe('Bozza Srl');
      await goTo('e-invoicing');
      expect(control(PEC).value).toBe('bozza@pec.it');
    });
  });

  describe('save all', () => {
    it('sends the general changes and the whole blocks of the tabs that changed in one PATCH', async () => {
      const { type, goTo, click, tabs, toasts, view, text, control } = await render();
      await type(NAME, 'Nuova Srl');
      await goTo('bank-accounts');
      await type('COMPANIES.BANKS.NAME {"number":1}', 'Altra banca');
      await click(SAVE_ALL);
      const req = backend().expectOne(COMPANY_URL);
      expect(req.request.method).toBe('PATCH');
      expect(req.request.headers.get('If-Match')).toBe(ETAG);
      expect(req.request.body).toEqual({
        name: 'Nuova Srl',
        bankAccounts: [
          {
            id: '6a1b00000000000000000001',
            name: 'Altra banca',
            iban: 'IT60X0542811101000000123456',
            abi: '05428',
            cab: '11101',
            bic: null,
            default: true,
          },
        ],
      });
      const saved = fakeCompany({ name: 'Nuova Srl' });
      req.flush(
        { data: { ...saved, bankAccounts: [{ ...saved.bankAccounts[0], name: 'Altra banca' }] } },
        { headers: { ETag: '"v2"' } },
      );
      await view();
      expect(toasts()).toEqual(['COMPANIES.SAVED']);
      expect(text()).not.toContain('COMPANIES.UNSAVED');
      expect(control('COMPANIES.BANKS.NAME {"number":1}').value).toBe('Altra banca');
      expect(tabs()).toHaveLength(7);
      await goTo(COMPANY);
      expect(control(NAME).value).toBe('Nuova Srl');
    });

    it('saves a tab on its own and keeps the drafts of the others', async () => {
      const { type, goTo, click, text, view, control } = await render();
      await type(NAME, 'Bozza Srl');
      await goTo('e-invoicing');
      await type(PEC, 'nuova@pec.it');
      await click('COMMON.SAVE');
      const req = backend().expectOne(`${COMPANY_URL}/e-invoicing`);
      const saved = fakeCompany();
      req.flush(
        { data: { ...saved, eInvoicing: { ...saved.eInvoicing, pec: 'nuova@pec.it' } } },
        { headers: { ETag: '"v2"' } },
      );
      await view();
      expect(text()).toContain('COMPANIES.UNSAVED');
      await goTo(COMPANY);
      expect(control(NAME).value).toBe('Bozza Srl');
      // The next save uses the new version.
      await click(SAVE_ALL);
      const next = backend().expectOne(COMPANY_URL);
      expect(next.request.headers.get('If-Match')).toBe('"v2"');
      expect(next.request.body).toEqual({ name: 'Bozza Srl' });
      next.flush({ data: fakeCompany({ name: 'Bozza Srl' }) }, { headers: { ETag: '"v3"' } });
      await view();
    });

    it('opens the first tab with an error and focuses it', async () => {
      const { type, goTo, click, control, router, tabs, view } = await render();
      await type(NAME, 'Nuova Srl');
      await goTo('bank-accounts');
      await type(IBAN, '');
      await goTo(COMPANY);
      await click(SAVE_ALL);
      await view();
      await settle();
      await view();
      expect(router.url).toBe(`/groups/${GROUP}/companies/${COMPANY}/bank-accounts`);
      expect(document.activeElement).toBe(control(IBAN));
      expect(tabs()[3].textContent).toContain('COMPANIES.SECTION_ERRORS');
    });

    it('puts the errors of the server on the fields of every tab and marks the tabs', async () => {
      const { type, goTo, click, tabs, error, view } = await render();
      await type(NAME, 'Nuova Srl');
      await goTo('e-invoicing');
      await type(PEC, 'x@y.it');
      await click(SAVE_ALL);
      backend()
        .expectOne(COMPANY_URL)
        .flush(
          errorBody('VALIDATION_ERROR', [
            { field: 'name', issue: 'maxLength' },
            { field: 'eInvoicing.pec', issue: 'format' },
          ]),
          { status: 422, statusText: 'x' },
        );
      await view();
      expect(error(PEC)).toBe('FORM.ISSUE.FORMAT');
      expect(tabs()[0].textContent).toContain('COMPANIES.SECTION_ERRORS');
      expect(tabs()[1].textContent).toContain('COMPANIES.SECTION_ERRORS');
      await goTo(COMPANY);
      expect(error(NAME)).toBe('FORM.ISSUE.MAX_LENGTH');
    });

    it('offers to reload after a 412 and drops every draft', async () => {
      const { type, goTo, click, text, view, control } = await render();
      await type(NAME, 'Bozza Srl');
      await goTo('e-invoicing');
      await type(PEC, 'x@y.it');
      await click(SAVE_ALL);
      backend()
        .expectOne(COMPANY_URL)
        .flush(errorBody('PRECONDITION_FAILED'), { status: 412, statusText: 'x' });
      await view();
      expect(text()).toContain('COMPANIES.CONFLICT');
      await click('COMPANIES.RELOAD');
      backend()
        .expectOne(COMPANY_URL)
        .flush({ data: fakeCompany({ name: 'Cambiata' }) }, { headers: { ETag: '"v9"' } });
      await view();
      expect(control(PEC).value).toBe('pec@esempio.it');
      await goTo(COMPANY);
      expect(control(NAME).value).toBe('Cambiata');
      expect(text()).not.toContain('COMPANIES.UNSAVED');
    });
  });

  describe('leaving the page', () => {
    it('leaves at once when nothing is unsaved', async () => {
      const { leave, goTo } = await render();
      await goTo('e-invoicing');
      expect(await leave()).toBe(true);
    });

    it('asks for confirmation with unsaved changes and stays when the user cancels', async () => {
      const { type, leave, dialogButton, view, router, control } = await render();
      await type(NAME, 'Bozza Srl');
      const navigation = leave();
      await view();
      expect(dialogButton('COMPANIES.LEAVE.CONFIRM')).toBeDefined();
      dialogButton('COMMON.CANCEL').click();
      await view();
      expect(await navigation).toBe(false);
      expect(router.url).toBe(`/groups/${GROUP}/companies/${COMPANY}`);
      expect(control(NAME).value).toBe('Bozza Srl');
    });

    it('leaves when the user confirms', async () => {
      const { type, dialogButton, view, router } = await render();
      await type(NAME, 'Bozza Srl');
      const navigation = router.navigateByUrl('/elsewhere');
      await view();
      dialogButton('COMPANIES.LEAVE.CONFIRM').click();
      await view();
      expect(await navigation).toBe(true);
      expect(router.url).toBe('/elsewhere');
    });

    it('asks again the next time', async () => {
      const { type, dialogButton, view, router } = await render();
      await type(NAME, 'Bozza Srl');
      let navigation = router.navigateByUrl('/elsewhere');
      await view();
      dialogButton('COMMON.CANCEL').click();
      await view();
      expect(await navigation).toBe(false);
      navigation = router.navigateByUrl('/elsewhere');
      await view();
      dialogButton('COMPANIES.LEAVE.CONFIRM').click();
      await view();
      expect(await navigation).toBe(true);
    });

    it('leaves a new company without asking until the user typed something', async () => {
      const { leave } = await render({ path: 'new' });
      expect(await leave()).toBe(true);
    });

    it('asks before leaving a new company that was started', async () => {
      const { type, dialogButton, view, router } = await render({ path: 'new' });
      await type(NAME, 'Nuova');
      const navigation = router.navigateByUrl('/elsewhere');
      await view();
      dialogButton('COMPANIES.LEAVE.CONFIRM').click();
      await view();
      expect(await navigation).toBe(true);
    });
  });
});
