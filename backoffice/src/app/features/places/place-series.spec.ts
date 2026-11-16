import { backend } from '../../../testing/api';
import { fakeCompany } from '../../../testing/companies';
import {
  COMPANY_2,
  GROUP,
  PLACE_PERMISSIONS,
  PLACE_URL,
  answerPlaceLookups,
  fakePlace,
  renderPlace,
} from '../../../testing/places';
import { flushPlace, optionsOf, renderPlacePage } from '../../../testing/places-page';

const COMPANY_LABEL = 'PLACES.GENERAL.COMPANY';
const SERIES = 'PLACES.GENERAL.INVOICE_SERIES';

afterEach(() => {
  sessionStorage.clear();
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('invoice series of the place', () => {
  it('reads the series of the place, not of the company', async () => {
    const { control } = await renderPlacePage();
    expect(optionsOf(control(SERIES) as HTMLSelectElement)).toEqual(['', 'FE', 'NC']);
  });

  it('uses the series of the new company once the company changes, and the place again after the save', async () => {
    const view = await renderPlacePage();
    await view.type(COMPANY_LABEL, COMPANY_2);
    const company = backend().expectOne(
      (r) => r.url.endsWith(`/companies/${COMPANY_2}`) && r.method === 'GET',
    );
    company.flush({
      data: fakeCompany({
        invoiceNumbering: {
          position: 'prefix',
          values: [{ name: 'XX', cash: false }],
          lastInvoiceNumber: null,
          discountLines: false,
          cervedLookup: false,
        },
      }),
    });
    await view.view();
    expect(optionsOf(view.control(SERIES) as HTMLSelectElement)).toEqual(['', 'XX', 'FE']);
    await view.click('COMMON.SAVE');
    const patch = backend().expectOne(PLACE_URL);
    expect(patch.request.body).toEqual({ companyId: COMPANY_2 });
    flushPlace(patch, fakePlace({ companyId: COMPANY_2 }));
    await view.view();
    backend()
      .expectOne(`${PLACE_URL}/invoice-series`)
      .flush({ data: [{ name: 'ZZ', cash: false }] });
    await view.view();
    backend()
      .match((r) => r.url.includes('/companies'))
      .forEach((r) => r.flush({ data: [], page: { limit: 100, next: null } }));
    expect(optionsOf(view.control(SERIES) as HTMLSelectElement)).toContain('ZZ');
  });

  it('explains that the series of a new company are unknown to a user who cannot read companies', async () => {
    const view = await renderPlace({
      path: 'new',
      permissions: ['places:read', 'places:create', 'profile:read'],
      lookups: false,
    });
    await answerPlaceLookups();
    await view.view();
    expect(view.text()).toContain('PLACES.GENERAL.SERIES_UNKNOWN');
  });

  it('does not explain it when the series are known', async () => {
    const view = await renderPlacePage();
    expect(view.text()).not.toContain('PLACES.GENERAL.SERIES_UNKNOWN');
    expect(GROUP).toBeDefined();
  });
});

describe('store key panel in the dealer settings', () => {
  it('is offered to who can read the store key', async () => {
    const view = await renderPlace({
      path: 'settings/dealer',
      permissions: [...PLACE_PERMISSIONS, 'storeKeys:read'],
      lookups: false,
    });
    backend()
      .expectOne(`${PLACE_URL}/store-key`)
      .flush({
        data: { status: 'none', key: null, pendingActivation: null, lastRevoked: null },
      });
    await view.view();
    expect(view.root.querySelector('fc-place-store-key')).not.toBeNull();
  });

  it('is not offered without the permission', async () => {
    const view = await renderPlace({ path: 'settings/dealer', lookups: false });
    expect(view.root.querySelector('fc-place-store-key')).toBeNull();
  });
});
