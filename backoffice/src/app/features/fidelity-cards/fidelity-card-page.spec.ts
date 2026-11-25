import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AppConfig } from '../../core/config/app-config';
import { I18nService } from '../../core/i18n/i18n.service';
import { backend, settle } from '../../../testing/api';
import {
  aCard,
  CONTACT_A,
  EDIT,
  GROUP,
  ID,
  ITEM,
  LIST_ROUTE,
  MOVEMENTS,
  NEW,
  NO_CONTACTS,
  READ_ONLY,
  renderCard,
} from '../../../testing/fidelity-card-page';
import { CONTACT_B } from '../../../testing/fidelity-card-page';
import { CARD_SECTIONS } from './fidelity-card-page';

afterEach(() => {
  backend().verify({ ignoreCancelled: true });
  vi.restoreAllMocks();
  document.body.replaceChildren();
  sessionStorage.clear();
  localStorage.clear();
});

describe('FidelityCardPage: loading', () => {
  it('shows the loading state until the card is read', async () => {
    const view = await renderCard(EDIT, { reads: null });
    await settle();
    expect(view.el().querySelector('[role=status]')?.textContent).toContain('COMMON.LOADING');
    await view.answer();
    expect(view.heading()).toBe('CARD-001');
    expect(view.text()).not.toContain('COMMON.LOADING');
  });

  it('shows the error of the read with the request id, a retry and the link back to the list', async () => {
    const view = await renderCard(EDIT, { reads: { card: 'fail', requestId: 'req-1' } });
    const state = view.el().querySelector('fc-error-state')!;
    expect(state.textContent).toContain('FIDELITY_CARDS.LOAD_ERROR');
    expect(state.textContent).toContain('ERRORS.API.INTERNAL_ERROR');
    expect(state.textContent).toContain('"requestId":"req-1"');
    expect(view.el().querySelector('a[href]')?.getAttribute('href')).toBe(LIST_ROUTE);
    expect(view.el().querySelector('form')).toBeNull();

    [...state.querySelectorAll('button')]
      .find((b) => b.textContent?.includes('COMMON.RETRY'))!
      .click();
    await view.answer();
    expect(view.heading()).toBe('CARD-001');
    expect(view.el().querySelector('fc-error-state')).toBeNull();
  });

  it('shows a not found as the message of its code', async () => {
    const view = await renderCard(EDIT, { reads: { card: 'fail', cardStatus: 404 } });
    expect(view.el().querySelector('fc-error-state')?.textContent).toContain(
      'ERRORS.API.NOT_FOUND',
    );
  });

  it('shows the generic message when the failure is not one of the backend', async () => {
    const view = await renderCard(EDIT, {
      reads: null,
      prepare: () => TestBed.overrideProvider(AppConfig, { useValue: { apiBaseUrl: () => null } }),
    });
    await view.view();
    const state = view.el().querySelector('fc-error-state')!;
    expect(state.textContent).toContain('ERRORS.GENERIC.MESSAGE');
    expect(state.textContent).not.toContain('requestId');
  });

  it('shows the card with its code as the title and the date of its last change', async () => {
    const view = await renderCard(EDIT);
    expect(view.heading()).toBe('CARD-001');
    expect(view.el().querySelector('.meta')?.textContent).toContain('FIDELITY_CARDS.FORM.UPDATED');
    expect(view.el().querySelector('.meta')?.textContent).toMatch(/2026/);
    expect(view.save()!.textContent).toContain('COMMON.SAVE');
    expect(view.save()!.disabled).toBe(true);
    expect(view.button('FIDELITY_CARDS.DELETE.ACTION')).toBeDefined();
    expect(view.el().querySelector('a[href]')?.getAttribute('href')).toBe(LIST_ROUTE);
    expect(view.el().querySelector('[role=note]')).toBeNull();
  });

  it('formats the date of the last change in the language of the user', async () => {
    const view = await renderCard(EDIT, {
      prepare: () => {
        Object.defineProperty(TestBed.inject(I18nService), 'language', { value: signal('en') });
      },
    });
    expect(view.el().querySelector('.meta')?.textContent).toContain('Nov 10, 2026');
  });

  it('shows no date for a card that has none', async () => {
    const view = await renderCard(EDIT, { reads: { card: { updatedAt: null } } });
    expect(view.el().querySelector('.meta')?.textContent).toContain('"date":""');
  });

  it('shows the code as text that cannot change, with its note, and the type and state of the card', async () => {
    const view = await renderCard(EDIT);
    expect(view.el().querySelector('.code')?.textContent).toBe('CARD-001');
    expect(view.el().querySelector('.hint')?.textContent).toBe(
      'FIDELITY_CARDS.FIELD.CODE_READ_ONLY',
    );
    expect(() => view.control('FIDELITY_CARDS.FIELD.CODE')).toThrow();
    expect((view.control('FIDELITY_CARDS.FIELD.TYPE') as HTMLSelectElement).value).toBe('ct1');
    expect((view.control('FIDELITY_CARDS.FIELD.ENABLED') as HTMLInputElement).checked).toBe(true);
  });

  it('offers a type that no longer exists as the current one', async () => {
    const view = await renderCard(EDIT, {
      reads: {
        card: { cardTypeId: 'ctX', cardType: null, balance: null, points: [] },
      },
    });
    const select = view.control('FIDELITY_CARDS.FIELD.TYPE') as HTMLSelectElement;
    expect(select.value).toBe('ctX');
    expect([...select.options].map((o) => o.textContent?.trim())).toContain(
      'FIDELITY_CARDS.TYPE_GONE',
    );
  });

  it('keeps the page usable when the catalogs cannot be read', async () => {
    const view = await renderCard(EDIT, {
      reads: { types: 'fail', collections: 'fail', currencies: 'fail' },
    });
    expect(view.heading()).toBe('CARD-001');
    expect(view.text()).toContain('FIDELITY_CARDS.TYPE_GONE');
    expect(view.text()).toContain('FIDELITY_CARDS.BALANCES.CREDIT');
    expect(view.text()).toMatch(/12,50\s€/);
    expect(view.button('FIDELITY_CARDS.BALANCES.ADJUST')).toBeDefined();
  });
});

describe('FidelityCardPage: balances', () => {
  it('shows the credit of a prepaid card and the points of each collection', async () => {
    const view = await renderCard(EDIT);
    const balances = view.el().querySelectorAll('fieldset')[0];
    expect(balances.querySelector('legend')?.textContent).toBe('FIDELITY_CARDS.BALANCES.TITLE');
    expect(balances.textContent).toContain('FIDELITY_CARDS.BALANCES.CREDIT {"amount":"12,50');
    const rows = [...balances.querySelectorAll('li')].map((li) => li.textContent?.trim());
    expect(rows[0]).toContain('FIDELITY_CARDS.BALANCES.POINTS {"name":"Spring","points":"120"}');
    expect(rows[1]).toContain('FIDELITY_CARDS.BALANCES.POINTS {"name":"Winter","points":"7"}');
  });

  it('marks only the collections that are not active', async () => {
    const view = await renderCard(EDIT);
    const rows = [...view.el().querySelectorAll('fieldset')[0].querySelectorAll('li')];
    expect(rows[0].textContent).not.toContain('FIDELITY_CARDS.BALANCES.INACTIVE');
    expect(rows[1].textContent).toContain('FIDELITY_CARDS.BALANCES.INACTIVE');
  });

  it('names a collection that no longer exists', async () => {
    const view = await renderCard(EDIT, {
      reads: {
        card: { points: [{ collectionId: 'pcX', name: null, points: 3, active: false }] },
      },
    });
    expect(view.el().querySelector('fieldset')?.textContent).toContain(
      'FIDELITY_CARDS.COLLECTION_GONE',
    );
  });

  it('shows no credit for a type that is not prepaid, and says there are no points', async () => {
    const view = await renderCard(EDIT, {
      reads: {
        card: {
          cardTypeId: 'ct3',
          cardType: {
            id: 'ct3',
            name: 'Points',
            enabled: true,
            prepaid: false,
            pointsCollect: true,
          },
          balance: null,
          points: [],
        },
      },
    });
    const balances = view.el().querySelector('fieldset')!;
    expect(balances.textContent).not.toContain('FIDELITY_CARDS.BALANCES.CREDIT');
    expect(balances.textContent).toContain('FIDELITY_CARDS.BALANCES.NO_POINTS');
  });

  it('shows a prepaid card with a credit that is not known as an empty amount', async () => {
    const view = await renderCard(EDIT, {
      reads: { card: { balance: null, points: [] } },
    });
    expect(view.el().querySelector('fieldset')?.textContent).toContain(
      'FIDELITY_CARDS.BALANCES.CREDIT {"amount":""}',
    );
  });

  it('says a type without credit and points has no balances', async () => {
    const view = await renderCard(EDIT, {
      reads: {
        card: {
          cardTypeId: 'ct2',
          cardType: {
            id: 'ct2',
            name: 'Plain',
            enabled: true,
            prepaid: false,
            pointsCollect: false,
          },
          balance: null,
          points: [],
        },
      },
    });
    expect(view.el().querySelector('fieldset')?.textContent).toContain(
      'FIDELITY_CARDS.BALANCES.NONE',
    );
    expect(view.button('FIDELITY_CARDS.BALANCES.ADJUST')).toBeUndefined();
  });

  it('shows the credit in the currency of the group', async () => {
    const view = await renderCard(EDIT, { reads: { currencies: [{ code: 'USD' }] } });
    expect(view.text()).toMatch(/12,50\sUSD/);
  });

  it('uses the euro when the group has no currency', async () => {
    const view = await renderCard(EDIT, { reads: { currencies: [] } });
    expect(view.text()).toMatch(/12,50\s€/);
  });

  it('offers the adjustment to who can update a card that has credit or points to move', async () => {
    const view = await renderCard(EDIT);
    expect(view.button('FIDELITY_CARDS.BALANCES.ADJUST')).toBeDefined();
  });

  it('offers the adjustment of a prepaid card even when its type collects no points', async () => {
    const view = await renderCard(EDIT, {
      reads: {
        card: {
          cardTypeId: 'ct4',
          cardType: {
            id: 'ct4',
            name: 'Wallet',
            enabled: true,
            prepaid: true,
            pointsCollect: false,
          },
          points: [],
        },
      },
    });
    expect(view.button('FIDELITY_CARDS.BALANCES.ADJUST')).toBeDefined();
  });

  it('offers the adjustment of a points card, but only on the collections that still exist', async () => {
    const view = await renderCard(EDIT, {
      reads: {
        card: {
          cardTypeId: 'ct3',
          cardType: {
            id: 'ct3',
            name: 'Points',
            enabled: true,
            prepaid: false,
            pointsCollect: true,
          },
          balance: null,
        },
      },
    });
    await view.button('FIDELITY_CARDS.BALANCES.ADJUST')!.click();
    await view.view();
    const dialog = view.el().querySelector('dialog[open]')!;
    expect(dialog.querySelectorAll('fieldset').length).toBe(1);
    expect(dialog.textContent).toContain('FIDELITY_CARDS.ADJUST.POINTS_OF {"name":"Spring"}');
  });

  it('does not offer the adjustment when no collection of the type exists any more', async () => {
    const view = await renderCard(EDIT, {
      reads: {
        collections: [],
        card: {
          cardTypeId: 'ct3',
          cardType: {
            id: 'ct3',
            name: 'Points',
            enabled: true,
            prepaid: false,
            pointsCollect: true,
          },
          balance: null,
        },
      },
    });
    expect(view.button('FIDELITY_CARDS.BALANCES.ADJUST')).toBeUndefined();
  });

  it('does not offer the adjustment when the type of the card cannot be read', async () => {
    const view = await renderCard(EDIT, {
      reads: {
        card: {
          cardTypeId: 'ctX',
          cardType: { id: 'ctX', name: null, enabled: false, prepaid: false, pointsCollect: true },
          balance: null,
        },
      },
    });
    expect(view.button('FIDELITY_CARDS.BALANCES.ADJUST')).toBeUndefined();
  });
});

describe('FidelityCardPage: customers of a card', () => {
  it('lists the customers with a link to their record', async () => {
    const view = await renderCard(EDIT);
    const customers = view.el().querySelectorAll('fieldset')[1];
    expect(customers.querySelector('legend')?.textContent).toBe('FIDELITY_CARDS.CUSTOMERS.TITLE');
    expect(customers.textContent).toContain('FIDELITY_CARDS.CUSTOMERS.EXPLANATION');
    const link = customers.querySelector('a')!;
    expect(link.textContent).toBe('Anna Bianchi');
    expect(link.getAttribute('href')).toBe(`/groups/${GROUP}/contacts/${CONTACT_A}`);
    expect(customers.textContent).not.toContain('FIDELITY_CARDS.CUSTOMERS.MORE');
  });

  it('shows the customers as text, without a link, to a user without contacts:read', async () => {
    const view = await renderCard(EDIT, { permissions: NO_CONTACTS });
    const customers = view.el().querySelectorAll('fieldset')[1];
    expect(customers.querySelector('a')).toBeNull();
    expect(customers.querySelector('li')?.textContent?.trim()).toBe('Anna Bianchi');
  });

  it('names a customer without a name', async () => {
    const view = await renderCard(EDIT, {
      reads: { card: { contacts: [{ id: CONTACT_B, displayName: null }] } },
    });
    expect(view.el().querySelectorAll('fieldset')[1].querySelector('a')?.textContent).toBe(
      'FIDELITY_CARDS.CUSTOMER_UNNAMED',
    );
  });

  it('says how many more customers have the card than the ones listed', async () => {
    const view = await renderCard(EDIT, { reads: { card: { contactsCount: 25 } } });
    expect(view.el().querySelectorAll('fieldset')[1].textContent).toContain(
      'FIDELITY_CARDS.CUSTOMERS.MORE {"count":24}',
    );
  });

  it('says that nobody has the card', async () => {
    const view = await renderCard(EDIT, { reads: { card: { contacts: [], contactsCount: 0 } } });
    const customers = view.el().querySelectorAll('fieldset')[1];
    expect(customers.querySelector('a')).toBeNull();
    expect(customers.textContent).toContain('FIDELITY_CARDS.CUSTOMERS.NONE');
    expect(customers.textContent).not.toContain('FIDELITY_CARDS.CUSTOMERS.MORE');
  });
});

describe('FidelityCardPage: tabs', () => {
  it('shows General and Movements for a card that exists, General first', async () => {
    const view = await renderCard(EDIT);
    expect(view.tabs()).toEqual([...CARD_SECTIONS]);
    expect(view.visible()).toEqual(['general']);
    expect(view.tab('general')!.textContent).toContain('FIDELITY_CARDS.SECTION.GENERAL');
    expect(view.tab('movements')!.textContent).toContain('FIDELITY_CARDS.SECTION.MOVEMENTS');
  });

  it('opens the movements and reads them once', async () => {
    const view = await renderCard(EDIT);
    await view.openTab('movements');
    expect(view.visible()).toEqual(['movements']);
    expect(view.el().querySelector('fc-fidelity-card-movements')).not.toBeNull();
    await view.openTab('general');
    expect(view.visible()).toEqual(['general']);
    backend().expectNone(MOVEMENTS);
  });

  it('shows only General, and no history, for a new card', async () => {
    const view = await renderCard(NEW);
    expect(view.tabs()).toEqual(['general']);
    expect(view.el().querySelector('fc-fidelity-card-movements')).toBeNull();
    backend().expectNone(ITEM);
  });
});

describe('FidelityCardPage: read only', () => {
  it('shows the card without the actions and says it cannot be changed', async () => {
    const view = await renderCard(EDIT, { permissions: READ_ONLY });
    expect(view.el().querySelector('[role=note]')?.textContent).toBe(
      'FIDELITY_CARDS.READ_ONLY_NOTE',
    );
    expect(view.save()).toBeNull();
    expect(view.button('FIDELITY_CARDS.DELETE.ACTION')).toBeUndefined();
    expect(view.button('FIDELITY_CARDS.BALANCES.ADJUST')).toBeUndefined();
    expect((view.control('FIDELITY_CARDS.FIELD.TYPE') as HTMLSelectElement).disabled).toBe(true);
    expect((view.control('FIDELITY_CARDS.FIELD.ENABLED') as HTMLInputElement).disabled).toBe(true);
  });

  it('lets the user leave at once', async () => {
    const view = await renderCard(EDIT, { permissions: READ_ONLY });
    expect(view.component().confirmLeave()).toBe(true);
  });
});

describe('FidelityCardPage: route', () => {
  it('opens the card whose id is in the address', async () => {
    const view = await renderCard(EDIT);
    expect(view.component().cardId()).toBe(ID);
    expect(view.component().groupId()).toBe(GROUP);
  });
});
