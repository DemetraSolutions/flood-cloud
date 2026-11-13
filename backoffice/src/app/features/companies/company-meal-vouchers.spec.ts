import { backend, errorBody, settle } from '../../../testing/api';
import { COMPANY_URL, ETAG, fakeCompany, renderCompany } from '../../../testing/companies';

const name = (n: number) => `COMPANIES.VOUCHERS.NAME {"number":${n}}`;
const cut = (n: number, c: number) => `COMPANIES.VOUCHERS.CUT {"number":${n},"cut":${c}}`;
const URL = `${COMPANY_URL}/meal-voucher-issuers`;
const SAVE = 'COMMON.SAVE';

afterEach(() => {
  sessionStorage.clear();
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

const count = (buttons: HTMLButtonElement[], text: string) =>
  buttons.filter((b) => b.textContent?.trim() === text).length;

describe('CompanyMealVouchers', () => {
  it('shows the issuers and their cuts, an empty cut being a free amount', async () => {
    const { control, text } = await renderCompany({ path: 'meal-vouchers' });
    expect(control(name(1)).value).toBe('Buoni Pasto');
    expect(control(cut(1, 1)).value).toBe('5');
    expect(control(cut(1, 3)).value).toBe('');
    expect(text()).not.toContain('COMPANIES.VOUCHERS.EMPTY');
  });

  it('marks the fields as touched when the user leaves them', async () => {
    const { blurAll, submitForm } = await renderCompany({ path: 'meal-vouchers' });
    await blurAll();
    expect(await submitForm()).toBe(true);
  });

  it('shows a hint without issuers', async () => {
    const { text } = await renderCompany({
      path: 'meal-vouchers',
      company: fakeCompany({ mealVoucherIssuers: [] }),
    });
    expect(text()).toContain('COMPANIES.VOUCHERS.EMPTY');
  });

  it('adds and removes issuers and cuts, and sends the whole list', async () => {
    const { click, type, buttons, toasts } = await renderCompany({ path: 'meal-vouchers' });
    await click('COMPANIES.VOUCHERS.ADD');
    await type(name(2), 'Ticket');
    await click('COMPANIES.VOUCHERS.ADD_CUT');
    // The first "add cut" button is the one of the first issuer.
    expect(count(buttons(), 'COMPANIES.VOUCHERS.ADD_CUT')).toBe(2);
    buttons()
      .filter((b) => b.textContent?.trim() === 'COMPANIES.VOUCHERS.ADD_CUT')[1]
      .click();
    await settle();
    await type(cut(2, 1), '7.5');
    await click(SAVE);
    const req = backend().expectOne(URL);
    expect(req.request.method).toBe('PUT');
    expect(req.request.headers.get('If-Match')).toBe(ETAG);
    expect(req.request.body).toEqual([
      { id: '6a1c00000000000000000001', name: 'Buoni Pasto', cuts: [5, 10, null, null] },
      { name: 'Ticket', cuts: [7.5] },
    ]);
    req.flush({ data: fakeCompany() }, { headers: { ETag: '"v2"' } });
    await settle();
    expect(toasts()).toEqual(['COMPANIES.SAVED']);
  });

  it('removes a cut and an issuer', async () => {
    const { click, buttons, control, view } = await renderCompany({ path: 'meal-vouchers' });
    buttons()
      .find((b) => b.getAttribute('aria-label')?.startsWith('COMPANIES.VOUCHERS.REMOVE_CUT_LABEL'))!
      .click();
    await view();
    expect(control(cut(1, 1)).value).toBe('10');
    await click('COMPANIES.REMOVE');
    expect(
      buttons().some((b) =>
        b.getAttribute('aria-label')?.startsWith('COMPANIES.VOUCHERS.REMOVE_LABEL'),
      ),
    ).toBe(true);
    buttons()
      .find((b) => b.getAttribute('aria-label')?.startsWith('COMPANIES.VOUCHERS.REMOVE_LABEL'))!
      .click();
    await view();
    expect(count(buttons(), 'COMPANIES.VOUCHERS.ADD_CUT')).toBe(0);
  });

  it('removes a cut of one issuer and leaves the others as they are', async () => {
    const issuer = fakeCompany().mealVoucherIssuers[0];
    const company = fakeCompany({
      mealVoucherIssuers: [
        issuer,
        { ...issuer, id: '6a1c00000000000000000002', name: 'Altro', cuts: [1, 2] },
      ],
    });
    const { buttons, control, view } = await renderCompany({ path: 'meal-vouchers', company });
    buttons()
      .filter((b) =>
        b.getAttribute('aria-label')?.startsWith('COMPANIES.VOUCHERS.REMOVE_CUT_LABEL'),
      )[0]
      .click();
    await view();
    expect(control(cut(1, 1)).value).toBe('10');
    expect(control(cut(2, 1)).value).toBe('1');
    expect(control(cut(2, 2)).value).toBe('2');
  });

  it('asks for a name', async () => {
    const { click, type, error } = await renderCompany({ path: 'meal-vouchers' });
    await type(name(1), '');
    await click(SAVE);
    expect(error(name(1))).toBe('FORM.ISSUE.REQUIRED');
  });

  it('stops adding at the limits', async () => {
    const issuer = fakeCompany().mealVoucherIssuers[0];
    const many = Array.from({ length: 50 }, (_, i) => ({
      ...issuer,
      id: `6a1c0000000000000000${String(i).padStart(4, '0')}`,
      cuts: [] as number[],
    }));
    const { button } = await renderCompany({
      path: 'meal-vouchers',
      company: fakeCompany({ mealVoucherIssuers: many }),
    });
    expect(button('COMPANIES.VOUCHERS.ADD')?.disabled).toBe(true);
  });

  it('stops adding cuts at fifty', async () => {
    const issuer = fakeCompany().mealVoucherIssuers[0];
    const cuts = Array.from({ length: 50 }, (_, i) => i);
    const { button } = await renderCompany({
      path: 'meal-vouchers',
      company: fakeCompany({ mealVoucherIssuers: [{ ...issuer, cuts }] }),
    });
    expect(button('COMPANIES.VOUCHERS.ADD_CUT')?.disabled).toBe(true);
  });

  it('shows the server errors on the cut, on the cuts and on the list', async () => {
    const { type, click, error, text, view } = await renderCompany({ path: 'meal-vouchers' });
    await type(name(1), 'Altro');
    await click(SAVE);
    backend()
      .expectOne(URL)
      .flush(
        errorBody('VALIDATION_ERROR', [
          { field: 'mealVoucherIssuers.0.cuts.0', issue: 'minimum' },
          { field: 'mealVoucherIssuers.0.cuts', issue: 'tooMany' },
          { field: 'mealVoucherIssuers', issue: 'tooMany' },
        ]),
        { status: 422, statusText: 'x' },
      );
    await view();
    expect(error(cut(1, 1))).toBe('FORM.ISSUE.MINIMUM');
    expect(text()).toContain('FORM.ISSUE.TOO_MANY');
  });

  it('is read-only without the permission to update', async () => {
    const { buttons, control } = await renderCompany({
      path: 'meal-vouchers',
      permissions: ['companies:read', 'groups:read', 'profile:read'],
    });
    expect(
      buttons().filter((b) => b.textContent?.trim().startsWith('COMPANIES.VOUCHERS')),
    ).toHaveLength(0);
    expect(control(name(1)).disabled).toBe(true);
  });
});
