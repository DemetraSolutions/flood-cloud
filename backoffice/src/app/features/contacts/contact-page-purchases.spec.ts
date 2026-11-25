import { backend } from '../../../testing/api';
import { EDIT, FULL, GROUP, ID, NEW, renderContact } from '../../../testing/contacts-page';

const SALES = (suffix = '') => `/v1/groups/${GROUP}/sales${suffix}`;
const pending = (suffix = '') =>
  backend()
    .match((r) => r.url.endsWith(SALES(suffix)))
    .filter((r) => !r.cancelled);

afterEach(() => {
  backend().verify({ ignoreCancelled: true });
  vi.restoreAllMocks();
  document.body.replaceChildren();
  sessionStorage.clear();
});

describe('ContactPage: purchases', () => {
  it('has a purchases tab for whoever reads the contacts and the sales, read only, after the account', async () => {
    const view = await renderContact(EDIT, { profile: { permissions: [...FULL, 'sales:read'] } });
    expect(view.tabs().at(-1)).toBe('purchases');
    expect(view.tab('purchases')!.textContent).toContain('CONTACTS.SECTION.PURCHASES');
    // The tab is read only and outside the form of the contact.
    expect(view.el().querySelector('form #contact-panel-purchases')).toBeNull();
    expect(view.el().querySelector('#contact-panel-purchases')).not.toBeNull();
  });

  it('reads the sales of the contact only when the tab is opened, and shows them', async () => {
    const view = await renderContact(EDIT, { profile: { permissions: [...FULL, 'sales:read'] } });
    expect(pending()).toHaveLength(0);
    await view.openTab('purchases');
    expect(view.visible()).toEqual(['purchases']);
    const [list] = pending();
    expect(list.request.params.get('contactId')).toBe(ID);
    list.flush({ data: [], page: { limit: 25, next: null } });
    pending('/summary')[0].flush({ data: { total: 0, count: 0, average: 0, refunded: 0 } });
    await view.view();
    expect(view.el().querySelector('#contact-panel-purchases fc-contact-purchases')).not.toBeNull();
    // Leaving the tab takes the sales away; coming back reads them again.
    await view.openTab('general');
    expect(view.el().querySelector('fc-contact-purchases')).toBeNull();
  });

  it('shows the amounts in the currency of the group', async () => {
    const view = await renderContact(EDIT, {
      profile: { permissions: [...FULL, 'sales:read'] },
      reads: { currencies: [{ code: 'USD' }] },
    });
    await view.openTab('purchases');
    pending()[0].flush({ data: [], page: { limit: 25, next: null } });
    pending('/summary')[0].flush({ data: { total: 5, count: 1, average: 5, refunded: 0 } });
    await view.view();
    expect(view.el().querySelector('.tiles')?.textContent).toContain('USD');
  });

  it('has no purchases tab without the permission to read the sales', async () => {
    const view = await renderContact(EDIT);
    expect(view.tab('purchases')).toBeNull();
    expect(view.el().querySelector('#contact-panel-purchases')).toBeNull();
  });

  it('has no purchases tab without the permission to read the contacts', async () => {
    const view = await renderContact(EDIT, {
      profile: { permissions: ['contacts:write', 'sales:read', 'groups:read', 'profile:read'] },
    });
    expect(view.tab('purchases')).toBeNull();
  });

  it('has no purchases tab for a contact that is being created', async () => {
    const view = await renderContact(NEW, { profile: { permissions: [...FULL, 'sales:read'] } });
    expect(view.tab('purchases')).toBeNull();
  });
});
