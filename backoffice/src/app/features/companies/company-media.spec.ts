import { API, backend, errorBody, settle } from '../../../testing/api';
import {
  COMPANY_URL,
  ETAG,
  GROUP,
  fakeCompany,
  fakeImage,
  renderCompany,
} from '../../../testing/companies';
import { emulateNativeDialog } from '../../../testing/dialog';
import { CompanyRecord } from './company.types';

const FILE = 'COMPANIES.MEDIA.INTERNAL_FILE_NAME';
const URL_LABEL = 'COMPANIES.MEDIA.EXTERNAL_URL';
const STORED_ID = '6734a1c2e9b1d4a0012ab3f1';
const STORED_URL = `${API}/v1/groups/${GROUP}/media/images/${STORED_ID}`;
const IMAGES = `${API}/v1/groups/${GROUP}/media/images`;
const URL = `${COMPANY_URL}/media`;
const SAVE = 'COMMON.SAVE';

afterEach(() => {
  sessionStorage.clear();
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

async function render(
  stored: 'image' | 'missing' | 'no-urls' | 'none',
  options: { company?: CompanyRecord; permissions?: string[] } = {},
) {
  emulateNativeDialog();
  const view = await renderCompany({ path: 'media', ...options });
  if (stored !== 'none') {
    const request = backend().expectOne(STORED_URL);
    if (stored === 'missing') {
      request.flush(errorBody('NOT_FOUND'), { status: 404, statusText: 'x' });
    } else {
      request.flush({
        data: fakeImage({ id: STORED_ID, ...(stored === 'no-urls' ? { urls: null } : {}) }),
      });
    }
    await view.view();
  }
  const preview = (index: number) =>
    view.root
      .querySelectorAll('fc-logo-slot')
      [index].querySelector<HTMLImageElement>('.preview img');
  const slotText = (index: number) =>
    view.root
      .querySelectorAll('fc-logo-slot')
      [index].querySelector('.preview')
      ?.textContent?.trim();
  const slotButtons = (index: number) =>
    [
      ...view.root
        .querySelectorAll('fc-logo-slot')
        [index].querySelectorAll<HTMLButtonElement>('.actions button'),
    ].map((b) => b.textContent?.trim());
  const press = async (index: number, text: string) => {
    [
      ...view.root
        .querySelectorAll('fc-logo-slot')
        [index].querySelectorAll<HTMLButtonElement>('.actions button'),
    ]
      .find((b) => b.textContent?.trim() === text)!
      .click();
    await view.view();
  };
  return { ...view, preview, slotText, slotButtons, press };
}

describe('CompanyMedia', () => {
  it('shows the files and the preview of the stored logo', async () => {
    const { control, preview, slotText, slotButtons } = await render('image');
    expect(control(FILE).value).toBe('');
    expect(control(URL_LABEL).value).toBe('');
    expect(preview(0)?.src).toBe('https://files.test/s/logo.png');
    expect(slotText(1)).toBe('COMPANIES.MEDIA.NO_LOGO');
    expect(slotButtons(0)).toEqual(['COMPANIES.MEDIA.CHOOSE', 'COMPANIES.MEDIA.REMOVE']);
    expect(slotButtons(1)).toEqual(['COMPANIES.MEDIA.CHOOSE']);
  });

  it('marks the fields as touched when the user leaves them', async () => {
    const { blurAll, submitForm } = await render('image');
    await blurAll();
    expect(await submitForm()).toBe(true);
  });

  it('shows the name of the file when the library has no such image', async () => {
    const { preview, slotText } = await render('missing');
    expect(preview(0)).toBeNull();
    expect(slotText(0)).toBe('logo');
  });

  it('shows the name of the file when the image has no URLs', async () => {
    const { preview, slotText } = await render('no-urls');
    expect(preview(0)).toBeNull();
    expect(slotText(0)).toBe('logo');
  });

  it('does not look up a logo whose id is not one of the library', async () => {
    const base = fakeCompany();
    const logo = {
      ...(base.media.customersAppLogoLight as object),
      _id: 'legacy-id',
      title: 'Titolo',
    } as never;
    const { slotText } = await render('none', {
      company: fakeCompany({ media: { ...base.media, customersAppLogoLight: logo } }),
    });
    expect(slotText(0)).toBe('Titolo');
  });

  it('removes a logo and replaces the block with null', async () => {
    const { press, slotText, control, type, click, toasts, view } = await render('image');
    await press(0, 'COMPANIES.MEDIA.REMOVE');
    expect(slotText(0)).toBe('COMPANIES.MEDIA.NO_LOGO');
    await type(FILE, 'logo-bar.png');
    await type(URL_LABEL, 'https://esempio.it/logo.png');
    await click(SAVE);
    const req = backend().expectOne(URL);
    expect(req.request.method).toBe('PUT');
    expect(req.request.headers.get('If-Match')).toBe(ETAG);
    expect(req.request.body).toEqual({
      internalFileName: 'logo-bar.png',
      externalUrl: 'https://esempio.it/logo.png',
      customersAppLogoLight: null,
      customersAppLogoDark: null,
    });
    req.flush({ data: fakeCompany() }, { headers: { ETag: '"v2"' } });
    await view();
    // The stored logo is back: its preview is read again.
    backend()
      .expectOne(STORED_URL)
      .flush({ data: fakeImage({ id: STORED_ID }) });
    await view();
    expect(toasts()).toEqual(['COMPANIES.SAVED']);
    expect(control(FILE).value).toBe('');
  });

  it('chooses a logo from the library and sends its id', async () => {
    const { press, root, view, preview, click } = await render('image');
    await press(1, 'COMPANIES.MEDIA.CHOOSE');
    const list = backend().expectOne(
      (r) => r.method === 'GET' && r.url === IMAGES && r.params.get('limit') === '12',
    );
    list.flush({ data: [fakeImage()], page: { limit: 12, next: null } });
    await view();
    root.querySelector<HTMLButtonElement>('dialog[open] .image')!.click();
    await view();
    expect(preview(1)?.src).toBe('https://files.test/s/logo.png');
    await click(SAVE);
    const req = backend().expectOne(URL);
    expect(req.request.body).toMatchObject({
      customersAppLogoLight: fakeCompany().media.customersAppLogoLight,
      customersAppLogoDark: { imageId: fakeImage().id },
    });
    req.flush({ data: fakeCompany() }, { headers: { ETag: '"v2"' } });
    await settle();
  });

  it('chooses a library image that has no preview', async () => {
    const { press, root, view, slotText } = await render('image');
    await press(1, 'COMPANIES.MEDIA.CHOOSE');
    backend()
      .expectOne((r) => r.method === 'GET' && r.url === IMAGES)
      .flush({ data: [fakeImage({ urls: null })], page: { limit: 12, next: null } });
    await view();
    root.querySelector<HTMLButtonElement>('dialog[open] .image')!.click();
    await view();
    expect(slotText(1)).toBe('Logo Bar');
  });

  it('shows the error of the server on a logo', async () => {
    const { click, type, root, view } = await render('image');
    await type(FILE, 'x.png');
    await click(SAVE);
    backend()
      .expectOne(URL)
      .flush(
        errorBody('VALIDATION_ERROR', [
          { field: 'media.customersAppLogoDark', issue: 'incorrect' },
        ]),
        {
          status: 422,
          statusText: 'x',
        },
      );
    await view();
    expect(
      root.querySelector('fc-company-media form > fieldset > .problem')?.textContent,
    ).toContain('FORM.ISSUE.INCORRECT');
  });

  it('is read-only without the permission to update', async () => {
    const { control, slotButtons } = await render('image', {
      permissions: ['companies:read', 'groups:read', 'profile:read'],
    });
    expect(control(FILE).disabled).toBe(true);
    expect(slotButtons(0)).toEqual([]);
    expect(slotButtons(1)).toEqual([]);
  });
});
