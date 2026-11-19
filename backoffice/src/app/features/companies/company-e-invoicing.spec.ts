import { backend, errorBody, settle } from '../../../testing/api';
import { COMPANY_URL, ETAG, GROUP, fakeCompany, renderCompany } from '../../../testing/companies';

const HUB = 'COMPANIES.E_INVOICING.HUB';
const PEC = 'COMPANIES.E_INVOICING.PEC';
const CAPITAL = 'COMPANIES.E_INVOICING.REA_SHARE_CAPITAL';
const OFFICE = 'COMPANIES.E_INVOICING.REA_OFFICE';
const COUNTRY = 'COMPANIES.E_INVOICING.TRANSMITTER_COUNTRY';
const URL = COMPANY_URL;
/** The block the page sent: the one save puts every changed section in one `PATCH`. */
const blockOf = (req: { request: { body: unknown } }) =>
  (req.request.body as Record<string, unknown>)['eInvoicing'];
const SAVE = 'COMMON.SAVE';

afterEach(() => {
  sessionStorage.clear();
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

const options = (select: HTMLSelectElement) =>
  [...select.options].map((o) => [o.value, o.textContent?.trim()]);

describe('CompanyEInvoicing', () => {
  it('shows the stored data and the hubs the user can choose', async () => {
    const { control } = await renderCompany({ path: 'e-invoicing' });
    expect(control(HUB).value).toBe('aruba');
    expect(options(control(HUB) as HTMLSelectElement)).toEqual([
      ['', 'COMPANIES.NONE'],
      ['aruba', 'COMPANIES.E_INVOICING.HUB_ARUBA'],
      ['aruba__665f1c2e9b1d4a0012ab34d1', 'Dealer Uno'],
    ]);
    expect(control(PEC).value).toBe('pec@esempio.it');
    expect(control(CAPITAL).value).toBe('10000.50');
    expect(options(control(OFFICE) as HTMLSelectElement).map((o) => o[0])).toEqual([
      '',
      'MI',
      'RM',
    ]);
    expect(control('COMPANIES.E_INVOICING.TAX_REGIME').value).toBe('RF01');
  });

  it('marks the fields as touched when the user leaves them', async () => {
    const { blurAll, submitForm } = await renderCompany({ path: 'e-invoicing' });
    await blurAll();
    expect(await submitForm()).toBe(true);
  });

  it('keeps the hub of another dealer visible, labelled as such', async () => {
    const base = fakeCompany();
    const company = fakeCompany({
      eInvoicing: { ...base.eInvoicing, hub: 'aruba__665f1c2e9b1d4a0012ab3499' },
    });
    const { control } = await renderCompany({
      path: 'e-invoicing',
      company,
      profile: { role: 'D' },
    });
    expect(control(HUB).value).toBe('aruba__665f1c2e9b1d4a0012ab3499');
    expect(options(control(HUB) as HTMLSelectElement).at(-1)).toEqual([
      'aruba__665f1c2e9b1d4a0012ab3499',
      'COMPANIES.E_INVOICING.HUB_OTHER',
    ]);
  });

  it('keeps provinces the list does not have', async () => {
    const base = fakeCompany();
    const company = fakeCompany({
      eInvoicing: {
        ...base.eInvoicing,
        professionalRegister: { ...base.eInvoicing.professionalRegister, province: 'ZZ' },
        rea: { ...base.eInvoicing.rea, office: 'YY' },
      },
    });
    const { control } = await renderCompany({ path: 'e-invoicing', company });
    expect(control('COMPANIES.E_INVOICING.REGISTER_PROVINCE').value).toBe('ZZ');
    expect(control(OFFICE).value).toBe('YY');
  });

  it('shows the reserved fields read-only to the others and does not read the hubs', async () => {
    const { control, text } = await renderCompany({
      path: 'e-invoicing',
      profile: { role: 'SA', groupId: GROUP },
    });
    expect(control(HUB).disabled).toBe(true);
    expect(control(HUB).value).toBe('aruba');
    expect(control(COUNTRY).disabled).toBe(true);
    expect(control(PEC).disabled).toBe(false);
    expect(text()).toContain('COMPANIES.RESERVED_NOTE');
  });

  it('replaces the whole block with If-Match', async () => {
    const { type, click, button, toasts, control } = await renderCompany({ path: 'e-invoicing' });
    expect(button(SAVE)?.disabled).toBe(true);
    await type(PEC, 'nuova@pec.it');
    await type(HUB, '');
    await type(OFFICE, 'RM');
    await click(SAVE);
    const req = backend().expectOne(URL);
    expect(req.request.method).toBe('PATCH');
    expect(req.request.headers.get('If-Match')).toBe(ETAG);
    expect(blockOf(req)).toEqual({
      hub: null,
      transmitter: { country: 'IT', code: '01879020517' },
      eori: null,
      pec: 'nuova@pec.it',
      recipientCode: 'ABC1234',
      professionalRegister: { name: null, number: null, province: null, date: null },
      rea: {
        office: 'RM',
        number: '123456',
        shareCapital: '10000.50',
        shareholders: 'SU',
        liquidation: 'LN',
      },
      taxRegime: 'RF01',
    });
    const saved = fakeCompany();
    req.flush(
      { data: { ...saved, eInvoicing: { ...saved.eInvoicing, hub: null, pec: 'nuova@pec.it' } } },
      { headers: { ETag: '"v2"' } },
    );
    await settle();
    expect(toasts()).toEqual(['COMPANIES.SAVED']);
    expect(control(PEC).value).toBe('nuova@pec.it');
    expect(button(SAVE)?.disabled).toBe(true);
  });

  it('checks the share capital before sending', async () => {
    const { type, click, error } = await renderCompany({ path: 'e-invoicing' });
    await type(CAPITAL, '10.555');
    await click(SAVE);
    expect(error(CAPITAL)).toBe('FORM.ISSUE.PATTERN');
  });

  it('puts the errors of the server on the fields', async () => {
    const { type, click, error, view } = await renderCompany({ path: 'e-invoicing' });
    await type(PEC, 'x@y.it');
    await click(SAVE);
    backend()
      .expectOne(URL)
      .flush(
        errorBody('VALIDATION_ERROR', [
          { field: 'eInvoicing.rea.office', issue: 'incorrect' },
          { field: 'eInvoicing.pec', issue: 'format' },
        ]),
        { status: 422, statusText: 'x' },
      );
    await view();
    expect(error(OFFICE)).toBe('FORM.ISSUE.INCORRECT');
    expect(error(PEC)).toBe('FORM.ISSUE.FORMAT');
  });
});
