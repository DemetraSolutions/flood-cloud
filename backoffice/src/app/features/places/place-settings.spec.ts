import { GROUP, PLACE, answerPlaceLookups, renderPlace } from '../../../testing/places';
import { cleanUp, failSave } from '../../../testing/places-tabs';
import { SETTINGS_ENTRIES, SETTINGS_MENU_GROUPS } from './place-nav';

type View = Awaited<ReturnType<typeof renderPlace>>;

const NON_PRIVILEGED = { role: 'SA' as const, groupId: GROUP };
const ALL_FEATURES = ['rooms', 'appointments', 'tobaccosGamesMonopoly'];
const ids = (entries: readonly { id: string }[]) => entries.map((entry) => entry.id);

afterEach(cleanUp);

const menu = (view: View) =>
  view.root.querySelector('nav[aria-label="PLACES.MENU_LABEL"]') as HTMLElement;
const links = (view: View) => [...menu(view).querySelectorAll<HTMLAnchorElement>('a')];
const entryLink = (view: View, id: string) =>
  links(view).find((link) => link.getAttribute('href')?.endsWith(`/settings/${id}`));
const shown = (view: View) =>
  links(view).map((link) => link.getAttribute('href')?.split('/').pop() as string);

async function goTo(view: View, id: string) {
  (entryLink(view, id) as HTMLAnchorElement).click();
  await view.view();
  await answerPlaceLookups();
  await view.view();
}

const open = (options: Parameters<typeof renderPlace>[0] = {}) =>
  renderPlace({ path: 'settings', ...options });

describe('PlaceSettings', () => {
  describe('menu', () => {
    it('has the four groups of the old backoffice, in order, each with its title', async () => {
      const view = await open();
      expect(menu(view).getAttribute('aria-label')).toBe('PLACES.MENU_LABEL');
      const titles = [...menu(view).querySelectorAll('h2')].map((h) => h.textContent?.trim());
      expect(titles).toEqual(SETTINGS_MENU_GROUPS.map((group) => `PLACES.MENU_GROUP.${group}`));
      expect(menu(view).querySelectorAll('ul')).toHaveLength(4);
    });

    it('lists the entries of every group in the order of the old backoffice', async () => {
      const view = await open();
      const lists = [...menu(view).querySelectorAll('ul')].map((list) =>
        [...list.querySelectorAll('a')].map((link) => link.textContent?.trim()),
      );
      expect(lists).toEqual(
        SETTINGS_MENU_GROUPS.map((group) =>
          SETTINGS_ENTRIES.filter((entry) => entry.group === group).map(
            (entry) => `PLACES.MENU.${entry.key}`,
          ),
        ),
      );
    });

    it.each(['PSA', 'D'] as const)(
      'shows every entry to a %s whatever the features',
      async (role) => {
        const view = await open({ features: [], profile: { role } });
        expect(shown(view)).toEqual(ids(SETTINGS_ENTRIES));
      },
    );

    it('shows a user who is not a platform administrator or a dealer only the entries without a requirement', async () => {
      const view = await open({ features: [], profile: NON_PRIVILEGED });
      expect(shown(view)).toEqual(
        ids(
          SETTINGS_ENTRIES.filter(
            (entry) => entry.needs === undefined && entry.privileged !== true,
          ),
        ),
      );
      expect(shown(view)).toEqual([
        'general',
        'external-display',
        'kiosk',
        'fidelity',
        'print',
        'other',
        'payments',
      ]);
    });

    const needing = SETTINGS_ENTRIES.filter((entry) => entry.needs !== undefined);

    it.each(needing)(
      'hides the entry $id from a user who is not privileged when the group lacks $needs',
      async (entry) => {
        const view = await open({ features: [], profile: NON_PRIVILEGED });
        expect(shown(view)).not.toContain(entry.id);
      },
    );

    it.each(needing)(
      'shows the entry $id to a user who is not privileged when the group has $needs',
      async (entry) => {
        const view = await open({ features: [entry.needs as string], profile: NON_PRIVILEGED });
        expect(shown(view)).toContain(entry.id);
      },
    );

    it.each(SETTINGS_ENTRIES.filter((entry) => entry.privileged === true))(
      'never shows the entry $id to a user who is not privileged',
      async (entry) => {
        const view = await open({ features: ALL_FEATURES, profile: NON_PRIVILEGED });
        expect(shown(view)).not.toContain(entry.id);
      },
    );

    it('shows every entry with all the features to a user who is not privileged, except the reserved ones', async () => {
      const view = await open({ features: ALL_FEATURES, profile: NON_PRIVILEGED });
      expect(shown(view)).toEqual(ids(SETTINGS_ENTRIES.filter((entry) => !entry.privileged)));
    });

    it('links every entry to its route below the settings', async () => {
      const view = await open();
      for (const entry of SETTINGS_ENTRIES) {
        expect(entryLink(view, entry.id)?.getAttribute('href')).toBe(
          `/groups/${GROUP}/places/${PLACE}/settings/${entry.id}`,
        );
      }
    });
  });

  describe('navigation', () => {
    it('opens the general settings and marks them as the current page', async () => {
      const view = await open();
      expect(view.root.querySelector('fc-place-cash')).not.toBeNull();
      expect(entryLink(view, 'general')?.getAttribute('aria-current')).toBe('page');
      expect(entryLink(view, 'dealer')?.hasAttribute('aria-current')).toBe(false);
    });

    it('shows the entry of the link in the section next to the menu', async () => {
      const view = await open();
      await goTo(view, 'delivery');
      expect(view.root.querySelector('section.entry fc-place-delivery')).not.toBeNull();
      expect(view.root.querySelector('fc-place-cash')).toBeNull();
      expect(entryLink(view, 'delivery')?.getAttribute('aria-current')).toBe('page');
      expect(entryLink(view, 'delivery')?.classList.contains('active')).toBe(true);
      expect(entryLink(view, 'general')?.classList.contains('active')).toBe(false);
    });

    it('opens the entry of the url', async () => {
      const view = await open({ path: 'settings/payments' });
      expect(view.root.querySelector('fc-place-payments')).not.toBeNull();
      expect(entryLink(view, 'payments')?.getAttribute('aria-current')).toBe('page');
    });
  });

  describe('markers', () => {
    it('marks no entry on a place without changes', async () => {
      const view = await open();
      expect(menu(view).querySelectorAll('fc-status-badge')).toHaveLength(0);
    });

    it('marks the entry with unsaved changes and no other', async () => {
      const view = await open({ path: 'settings/delivery' });
      await view.type('PLACES.F.DELIVERY.RADIUS', '3');
      expect(entryLink(view, 'delivery')?.textContent).toContain('PLACES.UNSAVED');
      expect(menu(view).querySelectorAll('fc-status-badge')).toHaveLength(1);
      await goTo(view, 'payments');
      expect(entryLink(view, 'delivery')?.textContent).toContain('PLACES.UNSAVED');
      expect(entryLink(view, 'payments')?.textContent).not.toContain('PLACES.UNSAVED');
    });

    it('splits the cash settings between the general entry and the other settings', async () => {
      const view = await open({ path: 'settings/general' });
      await view.toggle('PLACES.F.CASH_SETTINGS.FAST_LOGIN', true);
      expect(entryLink(view, 'general')?.textContent).toContain('PLACES.UNSAVED');
      expect(entryLink(view, 'other')?.textContent).not.toContain('PLACES.UNSAVED');
      await goTo(view, 'other');
      await view.type('PLACES.F.CASH_SETTINGS.RECEIPTS_CANCELLATION', 'sync');
      expect(entryLink(view, 'general')?.textContent).toContain('PLACES.UNSAVED');
      expect(entryLink(view, 'other')?.textContent).toContain('PLACES.UNSAVED');
    });

    it('marks only the other settings when the receipts cancellation is the only change', async () => {
      const view = await open({ path: 'settings/other' });
      await view.type('PLACES.F.CASH_SETTINGS.RECEIPTS_CANCELLATION', 'sync');
      expect(entryLink(view, 'other')?.textContent).toContain('PLACES.UNSAVED');
      expect(entryLink(view, 'general')?.textContent).not.toContain('PLACES.UNSAVED');
    });

    it('marks the entry whose save failed with the number of errors', async () => {
      const view = await open({ path: 'settings/delivery' });
      await view.type('PLACES.F.DELIVERY.RADIUS', '3');
      await failSave(view, [
        { field: 'delivery.radius', issue: 'incorrect' },
        { field: 'delivery.lat', issue: 'incorrect' },
      ]);
      expect(entryLink(view, 'delivery')?.textContent).toContain(
        'PLACES.SECTION_ERRORS {"count":2}',
      );
      expect(entryLink(view, 'payments')?.textContent).not.toContain('PLACES.SECTION_ERRORS');
    });

    it('puts the error of the receipts cancellation on the other settings, not on the general entry', async () => {
      const view = await open({ path: 'settings/other' });
      await view.type('PLACES.F.CASH_SETTINGS.RECEIPTS_CANCELLATION', 'sync');
      await failSave(view, [{ field: 'cashSettings.receiptsCancellation', issue: 'incorrect' }]);
      expect(entryLink(view, 'other')?.textContent).toContain('PLACES.SECTION_ERRORS {"count":1}');
      expect(entryLink(view, 'general')?.textContent).not.toContain('PLACES.SECTION_ERRORS');
    });

    it('puts the other errors of the cash settings on the general entry', async () => {
      const view = await open({ path: 'settings/general' });
      await view.toggle('PLACES.F.CASH_SETTINGS.FAST_LOGIN', true);
      await failSave(view, [{ field: 'cashSettings.customDiscount', issue: 'incorrect' }]);
      expect(entryLink(view, 'general')?.textContent).toContain(
        'PLACES.SECTION_ERRORS {"count":1}',
      );
      expect(entryLink(view, 'other')?.textContent).not.toContain('PLACES.SECTION_ERRORS');
    });
  });
});
