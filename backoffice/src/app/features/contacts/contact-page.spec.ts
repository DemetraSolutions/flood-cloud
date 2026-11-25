import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { I18nService } from '../../core/i18n/i18n.service';
import { backend, errorBody, settle } from '../../../testing/api';
import {
  BASE,
  CONTACT,
  EDIT,
  FULL,
  GROUP,
  ID,
  ITEM,
  L,
  LIST_ROUTE,
  NEW,
  NO_FEATURES,
  PRICE_LIST,
  CONTACT_GROUP,
  OFF_PRICE_LIST,
  READ_ONLY,
  renderContact,
} from '../../../testing/contacts-page';
import { CONTACT_SECTIONS } from './contact-page';

afterEach(() => {
  backend().verify({ ignoreCancelled: true });
  vi.restoreAllMocks();
  document.body.replaceChildren();
  sessionStorage.clear();
  localStorage.clear();
});

describe('ContactPage: loading', () => {
  it('shows the loading state until the contact is read', async () => {
    const view = await renderContact(EDIT, { reads: null });
    await settle();
    expect(view.el().querySelector('[role=status]')?.textContent).toContain('COMMON.LOADING');
    await view.answer();
    expect(view.heading()).toBe('Verdi srl');
    expect(view.el().querySelector('[role=status]')?.textContent ?? '').not.toContain(
      'COMMON.LOADING',
    );
  });

  it('shows the error of the read with the request id, a retry and the link back to the list', async () => {
    const view = await renderContact(EDIT, { reads: { item: 'fail', requestId: 'req-1' } });
    const state = view.el().querySelector('fc-error-state')!;
    expect(state.textContent).toContain('CONTACTS.LOAD_ERROR');
    expect(state.textContent).toContain('ERRORS.API.INTERNAL_ERROR');
    expect(state.textContent).toContain('"requestId":"req-1"');
    expect(view.el().querySelector('a[href]')?.getAttribute('href')).toBe(LIST_ROUTE);
    expect(view.el().querySelector('form')).toBeNull();

    [...state.querySelectorAll('button')]
      .find((b) => b.textContent?.includes('COMMON.RETRY'))!
      .click();
    await view.answer();
    expect(view.heading()).toBe('Verdi srl');
    expect(view.el().querySelector('fc-error-state')).toBeNull();
  });

  it('shows a not found as the message of its code', async () => {
    const view = await renderContact(EDIT, { reads: { item: 'fail', itemStatus: 404 } });
    expect(view.el().querySelector('fc-error-state')?.textContent).toContain(
      'ERRORS.API.NOT_FOUND',
    );
  });

  it('shows the contact with its name and the date of its last change', async () => {
    const view = await renderContact(EDIT);
    expect(view.el().querySelector('.meta')?.textContent).toContain('CONTACTS.FORM.UPDATED');
    expect(view.el().querySelector('.meta')?.textContent).not.toContain('Verdi srl');
    expect(view.heading()).toBe('Verdi srl');
    expect(view.control(L.code).value).toBe('K1');
    expect(view.control(L.firstName).value).toBe('Luca');
    expect(view.save()!.textContent).toContain('COMMON.SAVE');
    expect(view.save()!.disabled).toBe(true);
  });

  it('names a contact without a display name by its code', async () => {
    const view = await renderContact(EDIT, { reads: { item: { displayName: null } } });
    expect(view.heading()).toBe('K1');
  });

  it('names a contact without a display name and a code by a short id', async () => {
    const view = await renderContact(EDIT, { reads: { item: { displayName: null, code: '' } } });
    expect(view.heading()).toBe(`…${ID.slice(-6)}`);
  });

  it('formats the date of the last change in the language of the user', async () => {
    const view = await renderContact(EDIT, {
      prepare: () => {
        Object.defineProperty(TestBed.inject(I18nService), 'language', { value: signal('en') });
      },
    });
    expect(view.el().querySelector('.meta')?.textContent).toContain('Nov 10, 2026');
  });

  it('shows no date for a contact that has none', async () => {
    const view = await renderContact(EDIT, { reads: { item: { updatedAt: null } } });
    expect(view.el().querySelector('.meta')?.textContent).toContain('"date":""');
  });
});

describe('ContactPage: a new contact', () => {
  it('opens the empty form with its title, the creation button disabled and no meta line', async () => {
    const view = await renderContact(NEW);
    expect(view.heading()).toBe('CONTACTS.FORM.NEW_TITLE');
    expect(view.save()!.textContent).toContain('CONTACTS.FORM.CREATE');
    expect(view.save()!.disabled).toBe(true);
    expect(view.el().querySelector('.meta')).toBeNull();
    expect(view.button('CONTACTS.TRASH.ACTION')).toBeUndefined();
    expect(view.el().querySelector('a[href]')?.getAttribute('href')).toBe(LIST_ROUTE);
    expect(view.visible()).toEqual(['person']);
    expect(view.model().eInvoicing).toEqual(
      expect.objectContaining({ transmissionFormat: 'FPR12', channel: 'CD' }),
    );
  });

  it.each([
    ['customers', true, false],
    ['all', true, false],
    ['suppliers', false, true],
    ['others', false, false],
    ['unknown', true, false],
  ])(
    'starts a contact opened from the tab %s with customer %s and supplier %s',
    async (kind, customer, supplier) => {
      const view = await renderContact(`${NEW}?kind=${kind}`);
      expect(view.model().customer).toBe(customer);
      expect(view.model().supplier).toBe(supplier);
      expect((view.control(L.customer) as HTMLInputElement).checked).toBe(customer);
      expect((view.control(L.supplier) as HTMLInputElement).checked).toBe(supplier);
      expect(view.save()!.disabled).toBe(true);
    },
  );

  it.each([
    ['suppliers', 'company'],
    ['customers', 'person'],
    ['others', 'person'],
    ['all', 'person'],
    ['unknown', 'person'],
  ])('opens a contact from the tab %s on the tab %s', async (kind, tab) => {
    const view = await renderContact(`${NEW}?kind=${kind}`);
    expect(view.visible()).toEqual([tab]);
    expect(view.tab(tab)!.getAttribute('aria-selected')).toBe('true');
  });

  it('starts as a customer without a kind', async () => {
    const view = await renderContact(NEW);
    expect(view.model().customer).toBe(true);
    expect(view.model().supplier).toBe(false);
  });

  it('offers the groups of contacts and the enabled price lists', async () => {
    const view = await renderContact(NEW);
    const options = (label: string) =>
      [...(view.control(label) as HTMLSelectElement).options].map((o) => o.value);
    expect(options(L.group)).toEqual(['', CONTACT_GROUP]);
    expect(options(L.priceList)).toEqual(['', PRICE_LIST]);
  });

  it('keeps the price list a contact has even when it is disabled, and a group that is no longer listed', async () => {
    const view = await renderContact(EDIT, {
      reads: { item: { priceListId: OFF_PRICE_LIST, contactGroupId: '665f1c2e9b1d4a0012ab3bff' } },
    });
    const options = (label: string) =>
      [...(view.control(label) as HTMLSelectElement).options].map((o) => o.value);
    expect(options(L.priceList)).toEqual(['', PRICE_LIST, OFF_PRICE_LIST]);
    expect(options(L.group)).toEqual(['', CONTACT_GROUP, '665f1c2e9b1d4a0012ab3bff']);
    expect(
      [...(view.control(L.group) as HTMLSelectElement).options].map((o) => o.textContent?.trim()),
    ).toContain('…ab3bff');
  });

  it('works without the lists of groups and price lists when their reads fail', async () => {
    const view = await renderContact(NEW, { groupsFail: true });
    expect([...(view.control(L.group) as HTMLSelectElement).options].map((o) => o.value)).toEqual([
      '',
    ]);
  });
});

/** The tabs of a user who cannot read the sales (the purchases tab is for whoever can). */
const FORM_SECTIONS = CONTACT_SECTIONS.filter((id) => id !== 'purchases');

describe('ContactPage: tabs', () => {
  it('shows the tabs in the order of the legacy form, with the services when the group has the feature', async () => {
    const view = await renderContact(EDIT);
    expect(view.tabs()).toEqual(FORM_SECTIONS);
    expect(view.tab('services')!.textContent).toContain('CONTACTS.SECTION.SERVICES');
    expect(view.el().querySelector('#contact-panel-services')).not.toBeNull();
  });

  it('hides the services tab and panel in a group without the feature', async () => {
    const view = await renderContact(EDIT, { features: NO_FEATURES });
    expect(view.tabs()).toEqual(['general', 'person', 'company', 'fidelity', 'account']);
    expect(view.el().querySelector('#contact-panel-services')).toBeNull();
  });

  it('changes the visible panel with the tab', async () => {
    const view = await renderContact(EDIT);
    expect(view.visible()).toEqual(['general']);
    for (const id of FORM_SECTIONS) {
      await view.openTab(id);
      expect(view.visible()).toEqual([id]);
      expect(view.tab(id)!.getAttribute('aria-selected')).toBe('true');
    }
  });

  it('has no error counts while the form is valid', async () => {
    const view = await renderContact(EDIT);
    for (const id of FORM_SECTIONS) {
      expect(view.count(id)).not.toContain('TAB_LIST.ERRORS');
    }
  });

  it('offers the services of the contact by name', async () => {
    const view = await renderContact(EDIT);
    await view.openTab('services');
    expect(view.el().querySelector('#contact-panel-services .name')?.textContent).toBe('Taglio');
  });
});

describe('ContactPage: read only', () => {
  it('disables every field and offers no action without contacts:write', async () => {
    const view = await renderContact(EDIT, { profile: { permissions: READ_ONLY } });
    expect(view.save()).toBeNull();
    expect(view.button('CONTACTS.TRASH.ACTION')).toBeUndefined();
    expect(view.button('CONTACTS.RESTORE.ACTION')).toBeUndefined();
    expect(view.button('CONTACTS.DELETE.ACTION')).toBeUndefined();
    expect(view.control(L.code).disabled).toBe(true);
    expect(view.control(L.firstName).disabled).toBe(true);
    expect(view.el().querySelector('.note[role=note]')?.textContent).toContain(
      'CONTACTS.READ_ONLY_NOTE',
    );
  });

  it('opens a contact of the trash read only, with Restore and Delete for good', async () => {
    const view = await renderContact(EDIT, {
      reads: { item: { trashed: true, trashedAt: '2026-11-12T10:00:00.000Z' } },
    });
    expect(view.control(L.code).disabled).toBe(true);
    expect(view.save()).toBeNull();
    expect(view.button('CONTACTS.TRASH.ACTION')).toBeUndefined();
    expect(view.button('CONTACTS.RESTORE.ACTION')).toBeDefined();
    expect(view.button('CONTACTS.DELETE.ACTION')).toBeDefined();
    expect(view.el().querySelector('.note[role=note]')?.textContent).toContain(
      'CONTACTS.TRASHED_NOTE',
    );
  });

  it('offers no Restore or Delete for good to a user who cannot write', async () => {
    const view = await renderContact(EDIT, {
      profile: { permissions: READ_ONLY },
      reads: { item: { trashed: true, trashedAt: '2026-11-12T10:00:00.000Z' } },
    });
    expect(view.button('CONTACTS.RESTORE.ACTION')).toBeUndefined();
    expect(view.button('CONTACTS.DELETE.ACTION')).toBeUndefined();
    expect(view.el().querySelector('.note[role=note]')?.textContent).toContain(
      'CONTACTS.TRASHED_NOTE',
    );
  });

  it('disables Trash while there are unsaved changes', async () => {
    const view = await renderContact(EDIT);
    expect(view.button('CONTACTS.TRASH.ACTION')!.disabled).toBe(false);
    expect(view.el().querySelector('#contact-trash-hint')).toBeNull();
    expect(view.button('CONTACTS.TRASH.ACTION')!.hasAttribute('aria-describedby')).toBe(false);
    await view.type(L.code, 'K2');
    expect(view.button('CONTACTS.TRASH.ACTION')!.disabled).toBe(true);
    expect(view.button('CONTACTS.TRASH.ACTION')!.getAttribute('aria-describedby')).toBe(
      'contact-trash-hint',
    );
    expect(view.el().querySelector('#contact-trash-hint')?.textContent).toContain(
      'CONTACTS.TRASH.UNSAVED_HINT',
    );
    expect(view.save()!.disabled).toBe(false);
  });

  it('shows no trash hint on a new contact or a contact that is read only', async () => {
    const view = await renderContact(NEW);
    await view.type(L.code, 'K2');
    expect(view.el().querySelector('#contact-trash-hint')).toBeNull();
  });

  it('orders the actions of the toolbar: back, save, trash', async () => {
    const view = await renderContact(EDIT);
    const actions = [...view.el().querySelectorAll('fc-page-header a, fc-page-header button')].map(
      (e) => e.textContent?.trim(),
    );
    expect(actions).toEqual(['CONTACTS.FORM.BACK', 'COMMON.SAVE', 'CONTACTS.TRASH.ACTION']);
  });

  it('orders the actions of the toolbar of a contact in the trash: back, restore, delete', async () => {
    const view = await renderContact(EDIT, { reads: { item: { trashed: true } } });
    const actions = [...view.el().querySelectorAll('fc-page-header a, fc-page-header button')].map(
      (e) => e.textContent?.trim(),
    );
    expect(actions).toEqual([
      'CONTACTS.FORM.BACK',
      'CONTACTS.RESTORE.ACTION',
      'CONTACTS.DELETE.ACTION',
    ]);
  });
});

describe('ContactPage: warnings of duplicates', () => {
  it('shows each duplicate as a note with links to the contacts and the count of the others', async () => {
    const view = await renderContact(EDIT, {
      reads: {
        item: {
          warnings: [
            {
              field: 'code',
              issue: 'duplicate',
              contactIds: [CONTACT.id.replace('a01', 'a77'), 'x'.repeat(10) + 'abcdef'],
              others: 0,
            },
            {
              field: 'person.taxCode',
              issue: 'duplicate',
              contactIds: ['665f1c2e9b1d4a0012ab3a55'],
              others: 3,
            },
            {
              field: 'company.vatNumber',
              issue: 'duplicate',
              contactIds: ['665f1c2e9b1d4a0012ab3a56'],
              others: 0,
            },
            {
              field: 'company.taxCode',
              issue: 'duplicate',
              contactIds: ['665f1c2e9b1d4a0012ab3a57'],
              others: 0,
            },
          ],
        },
      },
    });
    const notes = () => [...view.el().querySelectorAll('fc-contact-warning-note p[role=status]')];
    expect(notes()).toHaveLength(4);
    const code = notes()[0];
    expect(code.textContent).toContain('CONTACTS.WARNING.DUPLICATE');
    expect([...code.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([
      `/groups/${GROUP}/contacts/${CONTACT.id.replace('a01', 'a77')}`,
      `/groups/${GROUP}/contacts/${'x'.repeat(10) + 'abcdef'}`,
    ]);
    expect(code.textContent).not.toContain('CONTACTS.WARNING.OTHERS');
    expect(notes()[1].textContent).toContain('CONTACTS.WARNING.OTHERS {"count":3}');
    expect(notes()[1].querySelector('a')?.textContent).toBe(
      'CONTACTS.WARNING.CONTACT_N {"number":1}',
    );
  });

  it('names the contacts with the search by the value, and numbers the ones it does not return', async () => {
    const view = await renderContact(EDIT, {
      reads: {
        item: {
          warnings: [
            {
              field: 'code',
              issue: 'duplicate',
              contactIds: ['665f1c2e9b1d4a0012ab3a55', '665f1c2e9b1d4a0012ab3a56'],
              others: 0,
            },
          ],
        },
        rows: [
          { id: '665f1c2e9b1d4a0012ab3a55', displayName: 'Anna Neri' },
          { id: '665f1c2e9b1d4a0012ab3a99', displayName: 'Altro' },
          { id: '665f1c2e9b1d4a0012ab3a56', displayName: null },
        ],
      },
    });
    const links = [...view.el().querySelectorAll('fc-contact-warning-note a')].map((a) =>
      a.textContent?.trim(),
    );
    expect(links).toEqual(['Anna Neri', 'CONTACTS.WARNING.CONTACT_N {"number":2}']);
  });

  it('shows no note without warnings', async () => {
    const view = await renderContact(EDIT);
    expect(view.el().querySelector('fc-contact-warning-note p')).toBeNull();
  });
});

describe('ContactPage: leaving with unsaved changes', () => {
  it('leaves at once when nothing changed', async () => {
    const view = await renderContact(EDIT);
    expect(view.component().confirmLeave()).toBe(true);
    await view.harness.navigateByUrl(LIST_ROUTE);
    expect(view.router.url).toBe(LIST_ROUTE);
  });

  it('leaves at once a page that is read only, even with a changed model', async () => {
    const view = await renderContact(EDIT, { profile: { permissions: READ_ONLY } });
    await view.setModel((model) => ({ ...model, code: 'KX' }));
    expect(view.component().confirmLeave()).toBe(true);
  });

  it('leaves at once a new contact that is still empty', async () => {
    const view = await renderContact(NEW);
    expect(view.component().confirmLeave()).toBe(true);
  });

  it('asks to confirm, and leaves when the user confirms', async () => {
    const view = await renderContact(EDIT);
    await view.type(L.code, 'K2');
    const navigation = view.harness.navigateByUrl(LIST_ROUTE);
    await view.view();
    expect(view.el().querySelector('dialog[open]')?.textContent).toContain('CONTACTS.LEAVE.TITLE');
    view.dialogButton('CONTACTS.LEAVE.CONFIRM').click();
    await navigation;
    await view.view();
    expect(view.router.url).toBe(LIST_ROUTE);
  });

  it('stays on the page when the user cancels', async () => {
    const view = await renderContact(NEW);
    await view.type(L.code, 'K2');
    const navigation = view.harness.navigateByUrl(LIST_ROUTE);
    await view.view();
    view.dialogButton('COMMON.CANCEL').click();
    await navigation;
    await view.view();
    expect(view.router.url).toBe(NEW);
    expect(view.el().querySelector('dialog[open]')).toBeNull();
    expect(view.control(L.code).value).toBe('K2');
  });

  it('settles a pending question when the dialog is closed after it was answered', async () => {
    const view = await renderContact(EDIT);
    await view.type(L.code, 'K2');
    const answer = view.component().confirmLeave() as Promise<boolean>;
    await view.view();
    view.dialogButton('COMMON.CANCEL').click();
    expect(await answer).toBe(false);
  });
});

describe('ContactPage: advanced cards', () => {
  const ADVANCED = {
    code: 'GOLD1',
    points: 0,
    advanced: {
      cardId: '665f1c2e9b1d4a0012ab3d01',
      cardType: { id: '665f1c2e9b1d4a0012ab3d02', name: 'Gold' },
      enabled: true,
      balance: 12.5,
      totalPoints: 340,
    },
  };

  it('shows an advanced card with its type and does not offer to adjust it', async () => {
    const view = await renderContact(EDIT, {
      reads: {
        item: { fidelityCards: [{ code: 'CARD1', points: 120, advanced: null }, ADVANCED] },
      },
    });
    await view.openTab('fidelity');
    const panel = view.el().querySelector('#contact-panel-fidelity')!;
    expect(panel.textContent).toContain('GOLD1');
    expect(panel.textContent).toContain('Gold');
    expect(panel.textContent).toContain('CONTACTS.FIDELITY.TOTAL_POINTS');
    const adjust = [...panel.querySelectorAll('button')].filter((b) =>
      b.textContent?.includes('CONTACTS.FIDELITY.ADJUST'),
    );
    expect(adjust).toHaveLength(1);
    expect(adjust[0].getAttribute('aria-label')).toContain('CARD1');
    expect(panel.textContent).toContain('"points":"120"');
  });

  it('links to the detail of the card only for a user who can read the cards', async () => {
    const withLink = await renderContact(EDIT, {
      profile: { permissions: [...FULL, 'fidelity:read'] },
      reads: { item: { fidelityCards: [ADVANCED] } },
    });
    expect(withLink.el().querySelector('#contact-panel-fidelity a')).not.toBeNull();
  });

  it('shows no link to the card without fidelity:read', async () => {
    const view = await renderContact(EDIT, { reads: { item: { fidelityCards: [ADVANCED] } } });
    expect(view.el().querySelector('#contact-panel-fidelity a')).toBeNull();
  });

  it('shows the credit in the first currency of the group', async () => {
    const view = await renderContact(EDIT, {
      reads: { item: { fidelityCards: [ADVANCED] }, currencies: [{ code: 'USD' }] },
    });
    expect(view.el().querySelector('#contact-panel-fidelity')?.textContent).toMatch(/12,50|12\.50/);
    expect(view.el().querySelector('#contact-panel-fidelity')?.textContent).toContain('USD');
  });

  it('shows the credit in euro when the group lists no currency', async () => {
    const view = await renderContact(EDIT, {
      reads: { item: { fidelityCards: [ADVANCED] }, currencies: [] },
    });
    expect(view.el().querySelector('#contact-panel-fidelity')?.textContent).toContain('€');
  });
});

describe('ContactPage: points adjustments', () => {
  it('shows the new balance after an adjustment without losing the changes not saved', async () => {
    const view = await renderContact(EDIT);
    await view.type(L.code, 'K2');
    await view.openTab('fidelity');
    expect(view.el().querySelector('#contact-panel-fidelity .points')?.textContent).toContain(
      '"points":"120"',
    );
    const adjust = [
      ...view.el().querySelectorAll<HTMLButtonElement>('#contact-panel-fidelity button'),
    ].find((b) => b.textContent?.includes('CONTACTS.FIDELITY.ADJUST'))!;
    adjust.click();
    await view.view();
    const dialog = view.el().querySelector('fc-contact-points-dialog')!;
    const label = [...dialog.querySelectorAll('label')].find(
      (l) => l.textContent?.trim() === 'CONTACTS.POINTS.AMOUNT',
    )!;
    const input = dialog.querySelector<HTMLInputElement>(`#${label.htmlFor}`)!;
    input.value = '30';
    input.dispatchEvent(new Event('input'));
    await view.view();
    dialog
      .querySelector('#contact-points-form')!
      .dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    const request = backend().expectOne(`${ITEM}/fidelity-cards/CARD1/points-adjustments`);
    expect(request.request.body).toEqual({ delta: 30 });
    request.flush({ data: { code: 'CARD1', points: 150 } });
    await view.view();
    expect(view.el().querySelector('#contact-panel-fidelity .points')?.textContent).toContain(
      '"points":"150"',
    );
    expect(view.control(L.code).value).toBe('K2');
    expect(view.save()!.disabled).toBe(false);
  });

  it('moves only the balance of the card that was adjusted', async () => {
    const view = await renderContact(EDIT, {
      reads: {
        item: {
          fidelityCards: [
            { code: 'CARD1', points: 120, advanced: null },
            { code: 'CARD2', points: 7, advanced: null },
          ],
        },
      },
    });
    await view.openTab('fidelity');
    [...view.el().querySelectorAll<HTMLButtonElement>('#contact-panel-fidelity button')]
      .find((b) => b.textContent?.includes('CONTACTS.FIDELITY.ADJUST'))!
      .click();
    await view.view();
    const dialog = view.el().querySelector('fc-contact-points-dialog')!;
    const label = [...dialog.querySelectorAll('label')].find(
      (l) => l.textContent?.trim() === 'CONTACTS.POINTS.AMOUNT',
    )!;
    const input = dialog.querySelector<HTMLInputElement>(`#${label.htmlFor}`)!;
    input.value = '5';
    input.dispatchEvent(new Event('input'));
    await view.view();
    dialog
      .querySelector('#contact-points-form')!
      .dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    backend()
      .expectOne(`${ITEM}/fidelity-cards/CARD1/points-adjustments`)
      .flush({ data: { code: 'CARD1', points: 125 } });
    await view.view();
    const points = [...view.el().querySelectorAll('#contact-panel-fidelity .points')].map(
      (p) => p.textContent,
    );
    expect(points[0]).toContain('"points":"125"');
    expect(points[1]).toContain('"points":"7"');
  });

  /** Types a change, opens the adjustment of the first card and loses the answer of the server. */
  async function adjustWithoutAnswer(view: Awaited<ReturnType<typeof renderContact>>) {
    await view.type(L.code, 'K2');
    await view.openTab('fidelity');
    [...view.el().querySelectorAll<HTMLButtonElement>('#contact-panel-fidelity button')]
      .find((b) => b.textContent?.includes('CONTACTS.FIDELITY.ADJUST'))!
      .click();
    await view.view();
    const dialog = view.el().querySelector('fc-contact-points-dialog')!;
    const label = [...dialog.querySelectorAll('label')].find(
      (l) => l.textContent?.trim() === 'CONTACTS.POINTS.AMOUNT',
    )!;
    const input = dialog.querySelector<HTMLInputElement>(`#${label.htmlFor}`)!;
    input.value = '30';
    input.dispatchEvent(new Event('input'));
    await view.view();
    dialog
      .querySelector('#contact-points-form')!
      .dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    backend()
      .expectOne(`${ITEM}/fidelity-cards/CARD1/points-adjustments`)
      .error(new ProgressEvent('error'));
    await view.view();
    view.dialogButton('COMMON.CANCEL').click();
    await view.view();
  }

  it('reads the cards again when the outcome of an adjustment is not known, keeping the form', async () => {
    const view = await renderContact(EDIT);
    await adjustWithoutAnswer(view);
    const gold = {
      code: 'CARD1',
      points: 0,
      advanced: {
        cardId: '665f1c2e9b1d4a0012ab3d01',
        cardType: { id: '665f1c2e9b1d4a0012ab3d02', name: 'Gold' },
        enabled: false,
        balance: null,
        totalPoints: 340,
      },
    };
    backend()
      .expectOne(ITEM)
      .flush({
        data: {
          ...CONTACT,
          code: 'OTHER',
          fidelityCards: [gold],
        },
      });
    await view.view();
    const panel = view.el().querySelector('#contact-panel-fidelity')!;
    expect(panel.textContent).toContain('Gold');
    expect(panel.textContent).toContain('CONTACTS.FIDELITY.TOTAL_POINTS');
    expect(panel.textContent).toContain('FIDELITY_CARDS.STATE.DISABLED');
    expect(view.control(L.code).value).toBe('K2');
    expect(view.save()!.disabled).toBe(false);
    expect(view.toasts()).toEqual([]);
  });

  it('shows an error when the cards cannot be read again, and keeps the ones it has', async () => {
    const view = await renderContact(EDIT);
    await adjustWithoutAnswer(view);
    backend().expectOne(ITEM).flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' });
    await view.view();
    expect(view.toasts()).toEqual(['error: ERRORS.API.INTERNAL_ERROR']);
    expect(view.el().querySelector('#contact-panel-fidelity')?.textContent).toContain(
      '"points":"120"',
    );
    expect(view.control(L.code).value).toBe('K2');
  });
});
