import { backend, errorBody, settle } from '../../../testing/api';
import { COMPANY_URL, ETAG, fakeCompany, renderCompany } from '../../../testing/companies';

const n = (key: string, number: number) => `COMPANIES.BANKS.${key} {"number":${number}}`;
const URL = `${COMPANY_URL}/bank-accounts`;
const SAVE = 'COMMON.SAVE';

afterEach(() => {
  sessionStorage.clear();
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('CompanyBanks', () => {
  it('shows the accounts', async () => {
    const { control, text } = await renderCompany({ path: 'bank-accounts' });
    expect(control(n('NAME', 1)).value).toBe('Banca');
    expect(control(n('IBAN', 1)).value).toBe('IT60X0542811101000000123456');
    expect(control(n('ABI', 1)).value).toBe('05428');
    expect((control(n('DEFAULT', 1)) as HTMLInputElement).checked).toBe(true);
    expect(text()).not.toContain('COMPANIES.BANKS.EMPTY');
    expect(text()).toContain('COMPANIES.BANKS.IBAN_HINT');
  });

  it('marks the fields as touched when the user leaves them', async () => {
    const { blurAll, submitForm } = await renderCompany({ path: 'bank-accounts' });
    await blurAll();
    expect(await submitForm()).toBe(true);
  });

  it('shows a hint when there are no accounts', async () => {
    const { text } = await renderCompany({
      path: 'bank-accounts',
      company: fakeCompany({ bankAccounts: [] }),
    });
    expect(text()).toContain('COMPANIES.BANKS.EMPTY');
  });

  it('normalises the IBAN as it is typed and warns when the checksum fails', async () => {
    const { type, control, text } = await renderCompany({ path: 'bank-accounts' });
    await type(n('IBAN', 1), 'it60 x054 2811 1010 0000 0123 456');
    expect(control(n('IBAN', 1)).value).toBe('IT60 X054 2811 1010 0000 0123 456');
    expect(text()).toContain('COMPANIES.BANKS.IBAN_HINT');
    expect(text()).not.toContain('COMPANIES.BANKS.IBAN_CHECKSUM');
    await type(n('IBAN', 1), 'it61x0542811101000000123456');
    expect(text()).toContain('COMPANIES.BANKS.IBAN_CHECKSUM');
    await type(n('IBAN', 1), '');
    expect(text()).not.toContain('COMPANIES.BANKS.IBAN_CHECKSUM');
  });

  it('keeps one default account at most', async () => {
    const { click, toggle, control } = await renderCompany({ path: 'bank-accounts' });
    await click('COMPANIES.BANKS.ADD');
    await toggle(n('DEFAULT', 2), true);
    expect((control(n('DEFAULT', 1)) as HTMLInputElement).checked).toBe(false);
    expect((control(n('DEFAULT', 2)) as HTMLInputElement).checked).toBe(true);
    await toggle(n('DEFAULT', 2), false);
    expect((control(n('DEFAULT', 2)) as HTMLInputElement).checked).toBe(false);
    await toggle(n('DEFAULT', 1), true);
    await toggle(n('DEFAULT', 1), false);
    expect((control(n('DEFAULT', 1)) as HTMLInputElement).checked).toBe(false);
  });

  it('adds and removes accounts and sends the whole list', async () => {
    const { click, type, buttons, toasts, view } = await renderCompany({ path: 'bank-accounts' });
    await click('COMPANIES.BANKS.ADD');
    await type(n('IBAN', 2), 'DE89 3704 0044 0532 0130 00');
    await type(n('BIC', 2), 'COBADEFF');
    await click(SAVE);
    const req = backend().expectOne(URL);
    expect(req.request.method).toBe('PUT');
    expect(req.request.headers.get('If-Match')).toBe(ETAG);
    expect(req.request.body).toEqual([
      {
        id: '6a1b00000000000000000001',
        name: 'Banca',
        iban: 'IT60X0542811101000000123456',
        abi: '05428',
        cab: '11101',
        bic: null,
        default: true,
      },
      {
        name: null,
        iban: 'DE89370400440532013000',
        abi: null,
        cab: null,
        bic: 'COBADEFF',
        default: false,
      },
    ]);
    req.flush({ data: fakeCompany() }, { headers: { ETag: '"v2"' } });
    await view();
    expect(toasts()).toEqual(['COMPANIES.SAVED']);
    expect(buttons().filter((b) => b.textContent?.trim() === 'COMPANIES.REMOVE')).toHaveLength(1);
    await click('COMPANIES.REMOVE');
    expect(buttons().filter((b) => b.textContent?.trim() === 'COMPANIES.REMOVE')).toHaveLength(0);
  });

  it('requires the IBAN of a new account', async () => {
    const { click, error } = await renderCompany({ path: 'bank-accounts' });
    await click('COMPANIES.BANKS.ADD');
    await click(SAVE);
    expect(error(n('IBAN', 2))).toBe('FORM.ISSUE.REQUIRED');
  });

  it('stops adding at twenty accounts', async () => {
    const base = fakeCompany().bankAccounts[0];
    const bankAccounts = Array.from({ length: 20 }, (_, i) => ({
      ...base,
      id: `6a1b0000000000000000${String(i).padStart(4, '0')}`,
      default: false,
    }));
    const { button } = await renderCompany({
      path: 'bank-accounts',
      company: fakeCompany({ bankAccounts }),
    });
    expect(button('COMPANIES.BANKS.ADD')?.disabled).toBe(true);
  });

  it('shows the server errors on the IBAN and on the list', async () => {
    const { type, click, error, text, view } = await renderCompany({ path: 'bank-accounts' });
    await type(n('NAME', 1), 'Altra');
    await click(SAVE);
    backend()
      .expectOne(URL)
      .flush(
        errorBody('VALIDATION_ERROR', [
          { field: 'bankAccounts.0.iban', issue: 'format' },
          { field: 'bankAccounts', issue: 'tooMany' },
        ]),
        { status: 422, statusText: 'x' },
      );
    await view();
    expect(error(n('IBAN', 1))).toBe('FORM.ISSUE.FORMAT');
    expect(text()).toContain('FORM.ISSUE.TOO_MANY');
  });

  it('is read-only without the permission to update', async () => {
    const { button, control } = await renderCompany({
      path: 'bank-accounts',
      permissions: ['companies:read', 'groups:read', 'profile:read'],
    });
    expect(button('COMPANIES.BANKS.ADD')).toBeUndefined();
    expect(button('COMPANIES.REMOVE')).toBeUndefined();
    expect(control(n('IBAN', 1)).disabled).toBe(true);
    expect(control(n('DEFAULT', 1)).disabled).toBe(true);
  });
});
