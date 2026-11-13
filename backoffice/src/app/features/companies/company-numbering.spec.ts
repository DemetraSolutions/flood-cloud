import { backend, errorBody, settle } from '../../../testing/api';
import { COMPANY_URL, ETAG, GROUP, fakeCompany, renderCompany } from '../../../testing/companies';

const POSITION = 'COMPANIES.NUMBERING.POSITION';
const LAST = 'COMPANIES.NUMBERING.LAST_NUMBER';
const CERVED = 'COMPANIES.NUMBERING.CERVED';
const DISCOUNT = 'COMPANIES.NUMBERING.DISCOUNT_LINES';
const name = (n: number) => `COMPANIES.NUMBERING.SERIES_NAME {"number":${n}}`;
const cash = (n: number) => `COMPANIES.NUMBERING.CASH {"number":${n}}`;
const URL = `${COMPANY_URL}/invoice-numbering`;
const SAVE = 'COMMON.SAVE';

afterEach(() => {
  sessionStorage.clear();
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('CompanyNumbering', () => {
  it('shows the series and the options', async () => {
    const { control } = await renderCompany({ path: 'invoice-numbering' });
    expect(control(POSITION).value).toBe('prefix');
    expect(control(LAST).value).toBe('120');
    expect(control(name(1)).value).toBe('FE');
    expect((control(cash(1)) as HTMLInputElement).checked).toBe(true);
    expect((control(cash(2)) as HTMLInputElement).checked).toBe(false);
    expect((control(DISCOUNT) as HTMLInputElement).checked).toBe(true);
    expect((control(CERVED) as HTMLInputElement).checked).toBe(false);
    expect(control(CERVED).disabled).toBe(false);
  });

  it('marks the fields as touched when the user leaves them', async () => {
    const { blurAll, submitForm } = await renderCompany({ path: 'invoice-numbering' });
    await blurAll();
    expect(await submitForm()).toBe(true);
  });

  it('keeps one cash series at most', async () => {
    const { toggle, control } = await renderCompany({ path: 'invoice-numbering' });
    await toggle(cash(2), true);
    expect((control(cash(1)) as HTMLInputElement).checked).toBe(false);
    expect((control(cash(2)) as HTMLInputElement).checked).toBe(true);
    await toggle(cash(2), false);
    await toggle(cash(1), true);
    await toggle(cash(1), false);
    expect((control(cash(1)) as HTMLInputElement).checked).toBe(false);
    expect((control(cash(2)) as HTMLInputElement).checked).toBe(false);
  });

  it('adds and removes series', async () => {
    const { click, button, control, buttons } = await renderCompany({ path: 'invoice-numbering' });
    await click('COMPANIES.NUMBERING.ADD');
    expect(control(name(3)).value).toBe('');
    await click('COMPANIES.REMOVE');
    expect(buttons().filter((b) => b.textContent?.trim() === 'COMPANIES.REMOVE')).toHaveLength(2);
    expect(button('COMPANIES.NUMBERING.ADD')?.disabled).toBe(false);
  });

  it('does not offer more than fifty series', async () => {
    const base = fakeCompany();
    const values = Array.from({ length: 50 }, (_, i) => ({ name: `S${i}`, cash: false }));
    const company = fakeCompany({ invoiceNumbering: { ...base.invoiceNumbering, values } });
    const { button } = await renderCompany({ path: 'invoice-numbering', company });
    expect(button('COMPANIES.NUMBERING.ADD')?.disabled).toBe(true);
  });

  it('replaces the block with numbers as numbers', async () => {
    const { type, toggle, click, toasts } = await renderCompany({ path: 'invoice-numbering' });
    await type(POSITION, 'suffix');
    await type(LAST, '121');
    await type(name(2), 'NCR');
    await toggle(DISCOUNT, false);
    await toggle(CERVED, true);
    await click(SAVE);
    const req = backend().expectOne(URL);
    expect(req.request.method).toBe('PUT');
    expect(req.request.headers.get('If-Match')).toBe(ETAG);
    expect(req.request.body).toEqual({
      position: 'suffix',
      values: [
        { name: 'FE', cash: true },
        { name: 'NCR', cash: false },
      ],
      lastInvoiceNumber: 121,
      discountLines: false,
      cervedLookup: true,
    });
    req.flush({ data: fakeCompany() }, { headers: { ETag: '"v2"' } });
    await settle();
    expect(toasts()).toEqual(['COMPANIES.SAVED']);
  });

  it('asks for a name for every series and a whole number', async () => {
    const { type, click, error } = await renderCompany({ path: 'invoice-numbering' });
    await type(name(1), '');
    await type(LAST, '12.5');
    await click(SAVE);
    expect(error(name(1))).toBe('FORM.ISSUE.REQUIRED');
    expect(error(LAST)).toBe('FORM.ISSUE.PATTERN');
  });

  it('shows a 422 on the series and a 403 on the reserved option', async () => {
    const { type, click, error, text, view } = await renderCompany({ path: 'invoice-numbering' });
    await type(name(2), 'FE');
    await click(SAVE);
    backend()
      .expectOne(URL)
      .flush(
        errorBody('VALIDATION_ERROR', [
          { field: 'invoiceNumbering.values.1.name', issue: 'incorrect' },
          { field: 'invoiceNumbering.values', issue: 'tooMany' },
        ]),
        { status: 422, statusText: 'x' },
      );
    await view();
    expect(error(name(2))).toBe('FORM.ISSUE.INCORRECT');
    expect(text()).toContain('FORM.ISSUE.TOO_MANY');
  });

  it('locks the Cerved option for the roles that cannot change it', async () => {
    const { control, text } = await renderCompany({
      path: 'invoice-numbering',
      profile: { role: 'CA', groupId: GROUP },
    });
    expect(control(CERVED).disabled).toBe(true);
    expect(text()).toContain('COMPANIES.RESERVED_NOTE');
  });

  it('hides the editing buttons without the permission to update', async () => {
    const { button, buttons, control } = await renderCompany({
      path: 'invoice-numbering',
      permissions: ['companies:read', 'groups:read', 'profile:read'],
    });
    expect(button('COMPANIES.NUMBERING.ADD')).toBeUndefined();
    expect(buttons().some((b) => b.textContent?.trim() === 'COMPANIES.REMOVE')).toBe(false);
    expect(control(POSITION).disabled).toBe(true);
    expect(control(cash(1)).disabled).toBe(true);
  });
});
